import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { applyCommittedMutation, validateSessionSnapshot } from "../src/contract";
import type {
  AuthorityOperation,
  CommittedMutation,
  Run,
  SessionSnapshot,
} from "../src/contract";
import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { DriverStartInput } from "../src/protocol/start";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { ClaudeContractAdapter } from "../src/runtimes/claude/contract-adapter";
import { createClaudeQueryOptions } from "../src/runtimes/claude/agent-sdk-query-options";
import type { ContractAuthorityUpdate } from "../src/runtimes/contract-projection";
import { AGENT_DRIVER_PROVIDER_REGISTRY } from "../src/runtimes/provider-registry";
import {
  DRIVER_TEST_IDS,
  FakeDriverRuntimeIo,
  bootPayload,
} from "./driver-runtime-boundary-fixtures";
import {
  textDeltaFrom,
  waitForTerminalTurnEvent,
  withLiveTimeout,
} from "./live-driver-events";

const LIVE_API_KEY_ENV = "AGENT_DRIVER_LIVE_ANTHROPIC_API_KEY";
const PROVIDER_API_KEY_ENV = "ANTHROPIC_API_KEY";
const LIVE_MODEL_ENV = "AGENT_DRIVER_LIVE_ANTHROPIC_MODEL";
const DEFAULT_LIVE_MODEL = "claude-sonnet-5";
const LIVE_TURN_TIMEOUT_MS = 120_000;

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

function readEnvString(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function readLiveApiKey(): string | null {
  return readEnvString(LIVE_API_KEY_ENV) ?? readEnvString(PROVIDER_API_KEY_ENV);
}

function readLiveModel(): string {
  return readEnvString(LIVE_MODEL_ENV) ?? DEFAULT_LIVE_MODEL;
}

async function createLiveDriverPaths(): Promise<{
  cwd: string;
  homePath: string;
  sharedRootPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-driver-live-"));
  const homePath = join(root, "home");
  const sharedRootPath = join(root, "workspace");
  await Promise.all([
    mkdir(homePath, { recursive: true }),
    mkdir(sharedRootPath, { recursive: true }),
  ]);
  tempRoots.push(root);

  return {
    cwd: sharedRootPath,
    homePath,
    sharedRootPath,
  };
}

function createLiveStartInput(input: {
  apiKey: string;
  cwd: string;
  homePath: string;
  sharedRootPath: string;
  systemPrompt?: string;
}): DriverStartInput {
  return {
    ...bootPayload,
    execution: {
      ...bootPayload.execution,
      environment: {
        variables: {
          ...bootPayload.execution.environment.variables,
          [PROVIDER_API_KEY_ENV]: input.apiKey,
        },
      },
      model: readLiveModel(),
      provider: "anthropic",
      session: {
        ...bootPayload.execution.session,
        additionalDirectories: [],
        cwd: input.cwd,
        homePath: input.homePath,
        mcpServers: [],
        nativeResumeRef: null,
        sharedRootPath: input.sharedRootPath,
      },
      skillCatalog: [],
      skills: [],
      systemPrompt:
        input.systemPrompt ??
        "Reply to the user with exactly one lowercase word: pong. Do not call tools.",
    },
    runtime: "claude-agent-sdk",
    runtimeTransport: "claude-agent-sdk",
  };
}

const liveApiKey = readLiveApiKey();
const liveTest = liveApiKey ? test : test.skip;

function createLiveKernel(): AgentDriverKernelCore {
  return new AgentDriverKernelCore({
    backendFactory: (input) => AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(input),
    hostPorts: {
      skill: {
        materialize: async () => [],
      },
    },
  });
}

function createLiveContractSnapshot(run: Run): SessionSnapshot {
  return validateSessionSnapshot({
    capturedAt: run.startedAt,
    interactions: [],
    items: [],
    protocolVersion: 2,
    revision: 0,
    runs: [run],
    session: {
      capabilities: {
        "interaction.permission": {},
        "item.artifact": {},
        "item.change": {},
        "item.plan": {},
        "item.reasoning": {},
        "item.terminal": {},
      },
      config: [],
      createdAt: run.startedAt,
      id: DRIVER_TEST_IDS.sessionId,
      status: "open",
      updatedAt: run.startedAt,
    },
  });
}

function createLiveContractAdapter(run: Run) {
  let nextId = 9_200;
  let snapshot = createLiveContractSnapshot(run);
  const authority: ContractAuthorityUpdate[] = [];
  const committedMutationIds = new Set<string>();
  const adapter = new ClaudeContractAdapter({
    authority: async (update) => {
      authority.push(update);

      if (committedMutationIds.has(update.mutationId)) {
        return;
      }

      const mutation: CommittedMutation = {
        baseRevision: snapshot.revision,
        cause: update.cause,
        committedAt: new Date().toISOString(),
        mutationId: update.mutationId,
        operations: [...update.operations] as AuthorityOperation[],
        revision: snapshot.revision + 1,
        sessionId: DRIVER_TEST_IDS.sessionId,
      };
      snapshot = applyCommittedMutation(snapshot, mutation);
      committedMutationIds.add(update.mutationId);
    },
    createId: () => String(nextId++).padStart(26, "0"),
    now: () => new Date(),
    preview: () => {},
    sessionId: DRIVER_TEST_IDS.sessionId,
  });
  adapter.attachRun(run);

  return {
    adapter,
    authority,
    snapshot: () => snapshot,
  };
}

function hasPayloadValue(event: DriverEventInput, key: string, value: string): boolean {
  return (
    typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload) &&
    (event.payload as Record<string, unknown>)[key] === value
  );
}

function hasPayloadText(event: DriverEventInput, key: string, text: string): boolean {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    return false;
  }

  const value = (event.payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.includes(text);
}

function payloadString(event: DriverEventInput, key: string): string | null {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    return null;
  }

  const value = (event.payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

async function sendTurn(
  kernel: AgentDriverKernelCore,
  suffix: string,
  text: string,
  runId = DRIVER_TEST_IDS.runId,
): Promise<DriverEventInput[]> {
  const requestId = `live-claude-request-${suffix}`;
  const dispatch = kernel.dispatch({
    commandId: `live-claude-input-${suffix}`,
    input: { text },
    kind: "input.start",
    requestId,
    runId,
  });
  const events = await waitForTerminalTurnEvent({
    events: kernel.events(),
    timeoutMs: LIVE_TURN_TIMEOUT_MS,
  });

  await expect(dispatch).resolves.toEqual({ requestId });
  return events;
}

describe("Claude Agent SDK live provider", () => {
  liveTest(
    "sends ping through the driver and receives pong from Anthropic",
    async () => {
      expect(liveApiKey).toBeString();
      const paths = await createLiveDriverPaths();
      const kernel = createLiveKernel();

      try {
        await kernel.start(
          createLiveStartInput({
            apiKey: liveApiKey,
            cwd: paths.cwd,
            homePath: paths.homePath,
            sharedRootPath: paths.sharedRootPath,
          }),
        );

        const turnEvents = await sendTurn(kernel, "smoke", "ping");
        const outputText = turnEvents.map(textDeltaFrom).join("").trim().toLowerCase();

        expect(outputText).toContain("pong");
      } finally {
        await kernel.stop("test.stop").catch(() => {});
      }
    },
    LIVE_TURN_TIMEOUT_MS + 5_000,
  );

  liveTest(
    "reads a workspace file through the Read tool",
    async () => {
      const paths = await createLiveDriverPaths();
      const kernel = createLiveKernel();
      const inputName = "source file-λ.txt";
      const contents = "claude-read-token-6241";
      await writeFile(join(paths.cwd, inputName), `${contents}\n`, "utf8");

      try {
        await kernel.start(
          createLiveStartInput({
            apiKey: liveApiKey,
            cwd: paths.cwd,
            homePath: paths.homePath,
            sharedRootPath: paths.sharedRootPath,
            systemPrompt:
              "Perform requested workspace operations with the named tools, then answer exactly as requested.",
          }),
        );
        const events = await sendTurn(
          kernel,
          "read-file",
          `Use Read to read ${JSON.stringify(inputName)}. Do not use Bash. Reply with exactly its contents and nothing else.`,
        );

        const readToolId = payloadString(
          events.find(
            (event) =>
              event.kind === "item.started" && hasPayloadValue(event, "title", "Read"),
          )!,
          "itemId",
        );

        expect(readToolId).not.toBeNull();
        expect(
          events.some(
            (event) =>
              event.kind === "tool.call.updated" &&
              payloadString(event, "toolCallId") === readToolId &&
              hasPayloadValue(event, "status", "completed") &&
              hasPayloadText(event, "content", contents),
          ),
        ).toBe(true);
        expect(events.map(textDeltaFrom).join("")).toContain(contents);
        expect(await readFile(join(paths.cwd, inputName), "utf8")).toBe(`${contents}\n`);
      } finally {
        await kernel.stop("test.stop").catch(() => {});
      }
    },
    LIVE_TURN_TIMEOUT_MS + 5_000,
  );

  liveTest(
    "creates a workspace file through the Write tool",
    async () => {
      const paths = await createLiveDriverPaths();
      const kernel = createLiveKernel();
      const outputName = "claude-output.txt";
      const contents = "claude-write-token-7352";

      try {
        await kernel.start(
          createLiveStartInput({
            apiKey: liveApiKey,
            cwd: paths.cwd,
            homePath: paths.homePath,
            sharedRootPath: paths.sharedRootPath,
            systemPrompt:
              "Perform requested workspace operations with the named tools, then answer exactly as requested.",
          }),
        );
        const events = await sendTurn(
          kernel,
          "write-file",
          `Use Write to create ${JSON.stringify(outputName)} with exactly one line: ${contents}. Do not use Bash. Reply with exactly written.`,
        );
        const writeToolId = payloadString(
          events.find(
            (event) =>
              event.kind === "item.started" && hasPayloadValue(event, "title", "Write"),
          )!,
          "itemId",
        );

        expect(writeToolId).not.toBeNull();
        expect(
          events.some(
            (event) =>
              event.kind === "tool.call.updated" &&
              payloadString(event, "toolCallId") === writeToolId &&
              hasPayloadValue(event, "status", "completed"),
          ),
        ).toBe(true);
        expect(events.map(textDeltaFrom).join("").trim().toLowerCase()).toContain("written");
        expect(await readFile(join(paths.cwd, outputName), "utf8")).toBe(`${contents}\n`);
      } finally {
        await kernel.stop("test.stop").catch(() => {});
      }
    },
    LIVE_TURN_TIMEOUT_MS + 5_000,
  );

  liveTest(
    "recovers after a failed Bash command",
    async () => {
      const paths = await createLiveDriverPaths();
      const kernel = createLiveKernel();

      try {
        await kernel.start(
          createLiveStartInput({
            apiKey: liveApiKey,
            cwd: paths.cwd,
            homePath: paths.homePath,
            sharedRootPath: paths.sharedRootPath,
            systemPrompt:
              "Run every requested Bash command in order even when one fails, then answer exactly as requested.",
          }),
        );
        const events = await sendTurn(
          kernel,
          "failed-command",
          "Run `sh -c 'printf claude-stdout; printf claude-stderr >&2; exit 7'`. After it fails, run `printf claude-recovered`. Then reply with exactly recovered.",
        );
        const bashStarts = events.filter(
          (event) => event.kind === "item.started" && hasPayloadValue(event, "title", "Bash"),
        );

        expect(bashStarts.length).toBeGreaterThanOrEqual(2);
        expect(
          events.some(
            (event) =>
              event.kind === "tool.call.updated" && hasPayloadValue(event, "status", "failed"),
          ),
        ).toBe(true);
        expect(
          events.some(
            (event) =>
              event.kind === "tool.call.updated" &&
              hasPayloadValue(event, "status", "completed") &&
              hasPayloadText(event, "content", "claude-recovered"),
          ),
        ).toBe(true);
        expect(events.map(textDeltaFrom).join("").trim().toLowerCase()).toContain("recovered");
      } finally {
        await kernel.stop("test.stop").catch(() => {});
      }
    },
    LIVE_TURN_TIMEOUT_MS + 5_000,
  );

  liveTest(
    "resumes the native session in a fresh process",
    async () => {
      const paths = await createLiveDriverPaths();
      const firstKernel = createLiveKernel();
      const memoryToken = "claude-resume-memory-5183";
      let firstStopped = false;

      try {
        await firstKernel.start(
          createLiveStartInput({
            apiKey: liveApiKey,
            cwd: paths.cwd,
            homePath: paths.homePath,
            sharedRootPath: paths.sharedRootPath,
            systemPrompt: "Remember user-provided tokens and answer exactly as requested.",
          }),
        );
        const firstEvents = await sendTurn(
          firstKernel,
          "resume-store",
          `Remember the token ${memoryToken}. Reply with exactly stored.`,
        );
        const resumePointer = payloadString(
          firstEvents.find((event) => event.kind === "runtime.resume.updated")!,
          "resumePointer",
        );
        expect(resumePointer).not.toBeNull();
        await firstKernel.stop("live.resume-restart");
        firstStopped = true;

        const baseInput = createLiveStartInput({
          apiKey: liveApiKey,
          cwd: paths.cwd,
          homePath: paths.homePath,
          sharedRootPath: paths.sharedRootPath,
          systemPrompt: "Remember user-provided tokens and answer exactly as requested.",
        });
        const resumedKernel = createLiveKernel();

        try {
          await resumedKernel.start({
            ...baseInput,
            execution: {
              ...baseInput.execution,
              session: {
                ...baseInput.execution.session,
                nativeResumeRef: {
                  kind: "claude_session_id",
                  runtimeId: "claude-agent-sdk",
                  value: resumePointer!,
                },
              },
            },
          });
          const events = await sendTurn(
            resumedKernel,
            "resume-recall",
            "Reply with exactly the token I asked you to remember in the previous turn.",
            DRIVER_TEST_IDS.secondRunId,
          );

          expect(events.map(textDeltaFrom).join("")).toContain(memoryToken);
        } finally {
          await resumedKernel.stop("test.stop").catch(() => {});
        }
      } finally {
        if (!firstStopped) {
          await firstKernel.stop("test.stop").catch(() => {});
        }
      }
    },
    LIVE_TURN_TIMEOUT_MS * 2 + 10_000,
  );
});

describe("Claude Contract adapter live provider", () => {
  liveTest(
    "projects real SDK file tools into Contract Authority",
    async () => {
      const paths = await createLiveDriverPaths();
      const inputName = "contract-input.txt";
      const outputName = "contract-output.txt";
      const contents = "claude-contract-token-7326";
      const prompt = `Use Read to read ${inputName}. Use Write to create ${outputName} with exactly the text you read. Do not use Bash. Reply with exactly contract-done.`;
      const run = {
        id: DRIVER_TEST_IDS.runId,
        input: [{ text: prompt, type: "text" }],
        origin: "user",
        startedAt: new Date().toISOString(),
        status: "active",
      } satisfies Run;
      const contract = createLiveContractAdapter(run);
      const payload = createLiveStartInput({
        apiKey: liveApiKey,
        cwd: paths.cwd,
        homePath: paths.homePath,
        sharedRootPath: paths.sharedRootPath,
        systemPrompt:
          "Perform requested workspace operations with the named tools, then answer exactly as requested.",
      });
      const logger = createBufferedSinkLogger({
        level: "debug",
        service: "claude-contract-live-test",
        sink: async () => {},
      });
      const context = createAgentDriverContext({
        eventSink: new FakeDriverRuntimeIo([]),
        logger,
        payload,
        permission: { request: async () => "allow_once" },
      });
      const abortController = new AbortController();
      let sdkQuery: ReturnType<typeof query> | null = null;
      await writeFile(join(paths.cwd, inputName), `${contents}\n`, "utf8");

      try {
        const options = await createClaudeQueryOptions({
          abortController,
          context,
          nativeSessionId: null,
          payload,
        });
        sdkQuery = query({ options, prompt });
        await withLiveTimeout({
          details: {},
          label: "Claude Contract terminal Authority mutation",
          logStatus: () => {},
          task: async () => {
            for await (const message of sdkQuery!) {
              if (await contract.adapter.handleMessage(message, run.id)) {
                return;
              }
            }

            throw new Error("Claude SDK query ended before its Contract Run became terminal.");
          },
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        });

        const snapshot = contract.snapshot();
        const completedRun = snapshot.runs.find((entry) => entry.id === run.id);
        const readTool = snapshot.items.find(
          (item) => item.kind === "tool" && item.name === "Read",
        );
        const writeTool = snapshot.items.find(
          (item) => item.kind === "tool" && item.name === "Write",
        );
        const message = snapshot.items.find(
          (item) => item.kind === "message" && JSON.stringify(item).includes("contract-done"),
        );

        expect(completedRun?.status).toBe("completed");
        expect(completedRun?.usage?.total).toBeGreaterThan(0);
        expect(readTool).toMatchObject({ category: "read", status: "completed" });
        expect(writeTool).toMatchObject({ category: "edit", status: "completed" });
        expect(message).toMatchObject({ status: "completed" });
        expect(contract.authority.length).toBeGreaterThan(0);
        expect(snapshot.interactions).toHaveLength(0);
        expect(await readFile(join(paths.cwd, outputName), "utf8")).toBe(`${contents}\n`);
      } finally {
        abortController.abort("test.stop");
        sdkQuery?.close();
        contract.adapter.dispose();
        await logger.destroy();
      }
    },
    LIVE_TURN_TIMEOUT_MS + 10_000,
  );
});
