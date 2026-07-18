import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { applyCommittedMutation, validateSessionSnapshot } from "../src/contract";
import type {
  AuthorityOperation,
  CommittedMutation,
  Run,
  SessionSnapshot,
} from "../src/contract";
import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import { OPENAI_DEFAULT_MODEL_ID } from "../src/models";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { DriverStartInput } from "../src/protocol/start";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { OpenAiAppServerClient } from "../src/runtimes/openai/app-server-client";
import { createTurnParams } from "../src/runtimes/openai/app-server-driver-backend";
import { MOSOO_OPENAI_RUNTIME_SANDBOX_MODE } from "../src/runtimes/openai/app-server-env";
import {
  OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION,
  OpenAiContractAdapter,
  type OpenAiAuthorityUpdate,
} from "../src/runtimes/openai/contract-adapter";
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

const LIVE_ENABLED_ENV = "AGENT_DRIVER_LIVE_OPENAI";
const LIVE_API_KEY_ENV = "AGENT_DRIVER_LIVE_OPENAI_API_KEY";
const PROVIDER_API_KEY_ENV = "OPENAI_API_KEY";
const LIVE_MODEL_ENV = "AGENT_DRIVER_LIVE_OPENAI_MODEL";
const OPENAI_RUNTIME_HOME_ENV = "CODEX_HOME";
const OPENAI_RUNTIME_HOME_DIR = ".codex";
const LIVE_OPERATION_TIMEOUT_MS = 15_000;
const LIVE_TURN_TIMEOUT_MS = 120_000;
const CONTRACT_COMMAND_ID = "00000000000000000000009001";

const tempRoots: string[] = [];

function logLiveStatus(
  message: string,
  details: Record<string, string | number | boolean> = {},
): void {
  const suffix =
    Object.keys(details).length === 0
      ? ""
      : ` ${JSON.stringify(Object.fromEntries(Object.entries(details).toSorted((a, b) => a[0].localeCompare(b[0]))))}`;
  console.info(`[live-openai] ${message}${suffix}`);
}

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
  return readEnvString(LIVE_MODEL_ENV) ?? OPENAI_DEFAULT_MODEL_ID;
}

async function copyLocalAuth(homePath: string): Promise<void> {
  if (readLiveApiKey() !== null) {
    return;
  }

  const sourceHome = readEnvString(OPENAI_RUNTIME_HOME_ENV) ??
    join(homedir(), OPENAI_RUNTIME_HOME_DIR);
  const target = join(homePath, "auth.json");

  await copyFile(join(sourceHome, "auth.json"), target);
  await chmod(target, 0o600);
}

async function createLiveDriverPaths(): Promise<{
  cwd: string;
  homePath: string;
  sharedRootPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-driver-openai-live-"));
  const homePath = join(root, "home");
  const sharedRootPath = join(root, "workspace");
  await Promise.all([
    mkdir(homePath, { recursive: true }),
    mkdir(sharedRootPath, { recursive: true }),
  ]);
  await copyLocalAuth(homePath);
  tempRoots.push(root);

  return {
    cwd: sharedRootPath,
    homePath,
    sharedRootPath,
  };
}

function createLiveStartInput(input: {
  apiKey: string | null;
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
          ...(input.apiKey === null ? {} : { [PROVIDER_API_KEY_ENV]: input.apiKey }),
        },
      },
      model: readLiveModel(),
      provider: "openai",
      providerOptions: {
        model_reasoning_effort: "medium",
        plan_mode_reasoning_effort: "medium",
      },
      session: {
        ...bootPayload.execution.session,
        additionalDirectories: [],
        cwd: input.cwd,
        homePath: input.homePath,
        mcpServers: [],
        mountAliases: [],
        nativeResumeRef: null,
        sharedRootPath: input.sharedRootPath,
      },
      skillCatalog: [],
      skills: [],
      systemPrompt:
        input.systemPrompt ??
        "Reply to the user with exactly one lowercase word: pong. Do not call tools.",
    },
    runtime: "openai-runtime",
    runtimeTransport: "openai-app-server",
  };
}

const liveApiKey = readLiveApiKey();
const liveTest = readEnvString(LIVE_ENABLED_ENV) === "1" || liveApiKey !== null ? test : test.skip;

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

function createLiveContractSnapshot(run: Run, capturedAt: string): SessionSnapshot {
  return validateSessionSnapshot({
    capturedAt,
    interactions: [],
    items: [],
    protocolVersion: 2,
    revision: 0,
    runs: [run],
    session: {
      capabilities: {
        [OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION]: {},
        "interaction.input": {},
        "interaction.permission": {},
        "interaction.tool": {},
        "item.change": {},
        "item.plan": {},
        "item.reasoning": {},
        "item.terminal": {},
        "openai.app-server/thread-item": {},
      },
      config: [],
      createdAt: capturedAt,
      id: DRIVER_TEST_IDS.sessionId,
      status: "open",
      updatedAt: capturedAt,
    },
  });
}

function createLiveContractAdapter(run: Run) {
  let nextId = 9_100;
  let snapshot = createLiveContractSnapshot(run, run.startedAt);
  const authority: OpenAiAuthorityUpdate[] = [];
  const committedMutationIds = new Set<string>();
  const terminal = Promise.withResolvers<void>();
  const adapter = new OpenAiContractAdapter({
    authority: async (update) => {
      authority.push(update);

      if (!committedMutationIds.has(update.mutationId)) {
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
      }

      if (snapshot.runs.find((entry) => entry.id === run.id)?.status !== "active") {
        terminal.resolve();
      }
    },
    createId: () => String(nextId++).padStart(26, "0"),
    now: () => new Date(),
    preview: () => {},
    sessionId: DRIVER_TEST_IDS.sessionId,
  });

  return {
    adapter,
    authority,
    snapshot: () => snapshot,
    terminal: terminal.promise,
  };
}

async function stopLiveKernel(kernel: AgentDriverKernelCore, reason: string): Promise<void> {
  await withLiveTimeout({
    details: { reason },
    label: "live kernel shutdown",
    logStatus: logLiveStatus,
    task: () => kernel.stop(reason),
    timeoutMs: LIVE_OPERATION_TIMEOUT_MS,
  });
}

function fromIterator(iterator: AsyncIterator<DriverEventInput>): AsyncIterable<DriverEventInput> {
  return { [Symbol.asyncIterator]: () => iterator };
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

function hasFileChange(event: DriverEventInput, path: string): boolean {
  if (event.kind !== "file.change.updated" || typeof event.payload !== "object") {
    return false;
  }

  const changes =
    event.payload === null || Array.isArray(event.payload)
      ? null
      : (event.payload as Record<string, unknown>)["changes"];
  return (
    Array.isArray(changes) &&
    changes.some(
      (change) =>
        typeof change === "object" &&
        change !== null &&
        !Array.isArray(change) &&
        typeof (change as Record<string, unknown>)["path"] === "string" &&
        ((change as Record<string, unknown>)["path"] as string).endsWith(path),
    )
  );
}

async function waitForLiveEvent(
  iterator: AsyncIterator<DriverEventInput>,
  predicate: (event: DriverEventInput) => boolean,
  label: string,
): Promise<DriverEventInput> {
  return withLiveTimeout({
    details: { label },
    label,
    logStatus: logLiveStatus,
    task: async () => {
      while (true) {
        const next = await iterator.next();

        if (next.done) {
          throw new Error(`Driver event stream closed before ${label}.`);
        }

        if (predicate(next.value)) {
          return next.value;
        }
      }
    },
    timeoutMs: LIVE_TURN_TIMEOUT_MS,
  });
}

async function sendTurn(
  kernel: AgentDriverKernelCore,
  events: AsyncIterable<DriverEventInput>,
  suffix: string,
  text: string,
  runId = DRIVER_TEST_IDS.runId,
): Promise<DriverEventInput[]> {
  const requestId = `live-openai-request-${suffix}`;
  const dispatch = kernel.dispatch({
    commandId: `live-openai-input-${suffix}`,
    input: { text },
    kind: "input.start",
    requestId,
    runId,
  });
  const turnEvents = await waitForTerminalTurnEvent({
    events,
    logStatus: logLiveStatus,
    progressMessage: "still waiting for terminal event",
    timeoutMs: LIVE_TURN_TIMEOUT_MS,
  });

  await expect(dispatch).resolves.toEqual({ requestId });
  return turnEvents;
}

async function sendPing(
  kernel: AgentDriverKernelCore,
  events: AsyncIterable<DriverEventInput>,
  suffix: string,
  runId = DRIVER_TEST_IDS.runId,
): Promise<void> {
  const turnEvents = await sendTurn(kernel, events, suffix, "ping", runId);
  const outputText = turnEvents.map(textDeltaFrom).join("").trim().toLowerCase();

  expect(outputText).toContain("pong");
  expect(turnEvents.find((event) => event.kind === "run.completed")?.payload).toMatchObject({
    finalMessageId: expect.any(String),
    finalMessageText: expect.stringContaining("pong"),
  });
}

describe("OpenAI app-server live provider", () => {
  liveTest(
    "sends ping through the driver and receives pong from OpenAI",
    async () => {
      logLiveStatus("starting live smoke", {
        executableOverride: Boolean(readEnvString("MOSOO_OPENAI_RUNTIME_EXECUTABLE")),
        model: readLiveModel(),
      });
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
        await sendPing(kernel, kernel.events(), "smoke");
      } finally {
        await stopLiveKernel(kernel, "test.stop");
      }
    },
    LIVE_TURN_TIMEOUT_MS + 5_000,
  );

  liveTest(
    "reads a workspace file through a shell tool",
    async () => {
      const paths = await createLiveDriverPaths();
      const kernel = createLiveKernel();
      const fileName = "source file-λ.txt";
      const contents = "live-read-token-7319";
      await writeFile(join(paths.cwd, fileName), `${contents}\n`, "utf8");

      try {
        await kernel.start(
          createLiveStartInput({
            apiKey: liveApiKey,
            cwd: paths.cwd,
            homePath: paths.homePath,
            sharedRootPath: paths.sharedRootPath,
            systemPrompt:
              "Perform requested workspace operations with tools, then answer exactly as requested.",
          }),
        );
        const events = await sendTurn(
          kernel,
          kernel.events(),
          "read-file",
          `Use a shell command to read ${JSON.stringify(fileName)} from the current directory. Reply with exactly its contents and nothing else.`,
        );

        expect(events.some((event) => hasPayloadValue(event, "title", "Shell"))).toBe(true);
        expect(
          events.some(
            (event) =>
              event.kind === "tool.call.updated" &&
              hasPayloadValue(event, "status", "completed") &&
              hasPayloadText(event, "content", contents),
          ),
        ).toBe(true);
        expect(events.map(textDeltaFrom).join("")).toContain(contents);
        expect(await readFile(join(paths.cwd, fileName), "utf8")).toBe(`${contents}\n`);
      } finally {
        await stopLiveKernel(kernel, "test.stop");
      }
    },
    LIVE_TURN_TIMEOUT_MS + 5_000,
  );

  liveTest(
    "creates a workspace file through the file-change tool",
    async () => {
      const paths = await createLiveDriverPaths();
      const kernel = createLiveKernel();
      const fileName = "written-by-agent.txt";
      const contents = "live-write-token-8426";

      try {
        await kernel.start(
          createLiveStartInput({
            apiKey: liveApiKey,
            cwd: paths.cwd,
            homePath: paths.homePath,
            sharedRootPath: paths.sharedRootPath,
            systemPrompt:
              "Use the file patch tool for requested file changes, then answer exactly as requested.",
          }),
        );
        const events = await sendTurn(
          kernel,
          kernel.events(),
          "write-file",
          `Use the file patch tool to create ${JSON.stringify(fileName)} with exactly one line: ${contents}. Then reply with exactly written.`,
        );

        expect(events.some((event) => hasPayloadValue(event, "title", "File change"))).toBe(true);
        expect(events.some((event) => hasFileChange(event, fileName))).toBe(true);
        expect(events.map(textDeltaFrom).join("").trim().toLowerCase()).toContain("written");
        expect(await readFile(join(paths.cwd, fileName), "utf8")).toBe(`${contents}\n`);
      } finally {
        await stopLiveKernel(kernel, "test.stop");
      }
    },
    LIVE_TURN_TIMEOUT_MS + 5_000,
  );

  liveTest(
    "recovers after a failed shell command",
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
              "Run every requested shell command in order even when one fails, then answer exactly as requested.",
          }),
        );
        const events = await sendTurn(
          kernel,
          kernel.events(),
          "failed-command",
          "Run `sh -c 'printf live-stdout; printf live-stderr >&2; exit 7'`. After it fails, run `printf live-recovered`. Then reply with exactly recovered.",
        );
        const shellStarts = events.filter(
          (event) => event.kind === "item.started" && hasPayloadValue(event, "title", "Shell"),
        );

        expect(shellStarts.length).toBeGreaterThanOrEqual(2);
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
              hasPayloadText(event, "content", "live-recovered"),
          ),
        ).toBe(true);
        expect(events.map(textDeltaFrom).join("").trim().toLowerCase()).toContain("recovered");
      } finally {
        await stopLiveKernel(kernel, "test.stop");
      }
    },
    LIVE_TURN_TIMEOUT_MS + 5_000,
  );

  liveTest(
    "cancels a running tool and accepts the next turn",
    async () => {
      const paths = await createLiveDriverPaths();
      const kernel = createLiveKernel();
      const iterator = kernel.events()[Symbol.asyncIterator]();

      try {
        await kernel.start(
          createLiveStartInput({
            apiKey: liveApiKey,
            cwd: paths.cwd,
            homePath: paths.homePath,
            sharedRootPath: paths.sharedRootPath,
            systemPrompt:
              "When asked to wait, run the requested shell command. For every other request, reply with exactly pong.",
          }),
        );
        const runningInput = kernel.dispatch({
          commandId: "live-openai-input-cancelled",
          input: { text: "Run the shell command `sleep 30`, then reply pong." },
          kind: "input.start",
          requestId: "live-openai-request-cancelled",
          runId: DRIVER_TEST_IDS.runId,
        });
        await waitForLiveEvent(
          iterator,
          (event) =>
            event.kind === "item.started" && hasPayloadValue(event, "title", "Shell"),
          "running tool event",
        );
        await withLiveTimeout({
          details: {},
          label: "active turn cancellation",
          logStatus: logLiveStatus,
          task: () => kernel.cancel("live.cancel"),
          timeoutMs: LIVE_OPERATION_TIMEOUT_MS,
        });

        await expect(runningInput).resolves.toBeUndefined();
        await waitForLiveEvent(
          iterator,
          (event) =>
            event.kind === "tool.call.updated" && hasPayloadValue(event, "status", "failed"),
          "cancelled tool terminal event",
        );
        await waitForLiveEvent(
          iterator,
          (event) => event.kind === "run.cancelled",
          "cancelled run terminal event",
        );
        await sendPing(
          kernel,
          fromIterator(iterator),
          "after-cancel",
          DRIVER_TEST_IDS.secondRunId,
        );
      } finally {
        await stopLiveKernel(kernel, "test.stop");
      }
    },
    LIVE_TURN_TIMEOUT_MS * 2 + 10_000,
  );

  liveTest(
    "stops during a running tool and starts a fresh process",
    async () => {
      const paths = await createLiveDriverPaths();
      const firstKernel = createLiveKernel();
      const firstEvents = firstKernel.events()[Symbol.asyncIterator]();
      let firstStopped = false;

      try {
        await firstKernel.start(
          createLiveStartInput({
            apiKey: liveApiKey,
            cwd: paths.cwd,
            homePath: paths.homePath,
            sharedRootPath: paths.sharedRootPath,
            systemPrompt:
              "When asked to wait, run the requested shell command. For every other request, reply with exactly pong.",
          }),
        );
        const runningInput = firstKernel.dispatch({
          commandId: "live-openai-input-stop",
          input: { text: "Run the shell command `sleep 30`, then reply pong." },
          kind: "input.start",
          requestId: "live-openai-request-stop",
          runId: DRIVER_TEST_IDS.runId,
        });
        await waitForLiveEvent(
          firstEvents,
          (event) =>
            event.kind === "item.started" && hasPayloadValue(event, "title", "Shell"),
          "running tool before shutdown",
        );
        await stopLiveKernel(firstKernel, "live.active-stop");
        firstStopped = true;

        await expect(runningInput).resolves.toBeUndefined();
        const shutdownEvents = await withLiveTimeout({
          details: {},
          label: "shutdown event stream closure",
          logStatus: logLiveStatus,
          task: () => Array.fromAsync(fromIterator(firstEvents)),
          timeoutMs: LIVE_OPERATION_TIMEOUT_MS,
        });
        expect(
          shutdownEvents.some(
            (event) =>
              event.kind === "tool.call.updated" && hasPayloadValue(event, "status", "failed"),
          ),
        ).toBe(true);
        expect(shutdownEvents.some((event) => event.kind === "run.cancelled")).toBe(true);
      } finally {
        if (!firstStopped) {
          await stopLiveKernel(firstKernel, "test.stop");
        }
      }

      const restartedKernel = createLiveKernel();

      try {
        await restartedKernel.start(
          createLiveStartInput({
            apiKey: liveApiKey,
            cwd: paths.cwd,
            homePath: paths.homePath,
            sharedRootPath: paths.sharedRootPath,
          }),
        );
        await sendPing(
          restartedKernel,
          restartedKernel.events(),
          "after-restart",
          DRIVER_TEST_IDS.secondRunId,
        );
      } finally {
        await stopLiveKernel(restartedKernel, "test.stop");
      }
    },
    LIVE_TURN_TIMEOUT_MS * 2 + 10_000,
  );
});

describe("OpenAI Contract adapter live provider", () => {
  liveTest(
    "projects real file tools into Contract Authority",
    async () => {
      const paths = await createLiveDriverPaths();
      const inputName = "contract-input.txt";
      const outputName = "contract-output.txt";
      const contents = "live-contract-token-9537";
      const prompt = `Use a shell command to read ${inputName}. Then use the file patch tool to create ${outputName} with exactly the text you read. Reply with exactly contract-done.`;
      const startedAt = new Date().toISOString();
      const run = {
        id: DRIVER_TEST_IDS.runId,
        input: [{ text: prompt, type: "text" }],
        origin: "user",
        startedAt,
        status: "active",
      } satisfies Run;
      const contract = createLiveContractAdapter(run);
      const payload = createLiveStartInput({
        apiKey: liveApiKey,
        cwd: paths.cwd,
        homePath: paths.homePath,
        sharedRootPath: paths.sharedRootPath,
        systemPrompt:
          "Perform requested workspace operations with tools, then answer exactly as requested.",
      });
      const logger = createBufferedSinkLogger({
        level: "debug",
        service: "openai-contract-live-test",
        sink: async () => {},
      });
      const protocolFailure = Promise.withResolvers<void>();
      let protocolError: Error | null = null;
      const context = createAgentDriverContext({
        eventSink: new FakeDriverRuntimeIo([]),
        logger,
        payload,
        permission: { request: async () => "reject_once" },
      });
      const client = new OpenAiAppServerClient(payload, {
        ...context,
        handleNotification: async (method, params) => {
          await contract.adapter.handleNotification(method, params);
        },
        handleProtocolError: async (error) => {
          protocolError = error;
          protocolFailure.resolve();
        },
      });
      await writeFile(join(paths.cwd, inputName), `${contents}\n`, "utf8");

      try {
        await client.start();
        const threadResult = await client.request("thread/start", {
          approvalPolicy: "never",
          cwd: paths.cwd,
          developerInstructions: payload.execution.systemPrompt,
          model: readLiveModel(),
          modelProvider: "openai",
          sandbox: MOSOO_OPENAI_RUNTIME_SANDBOX_MODE,
          sessionStartSource: "startup",
        });
        const turnResult = await client.request(
          "turn/start",
          createTurnParams({
            approvalPolicy: "never",
            cwd: paths.cwd,
            model: readLiveModel(),
            text: prompt,
            threadId: threadResult.thread.id,
          }),
        );
        await contract.adapter.attachTurn({
          cause: { commandId: CONTRACT_COMMAND_ID, type: "command" },
          run,
          threadId: threadResult.thread.id,
          turnId: turnResult.turn.id,
        });

        if (
          turnResult.turn.status === "completed" ||
          turnResult.turn.status === "failed" ||
          turnResult.turn.status === "interrupted"
        ) {
          await contract.adapter.handleNotification("turn/completed", {
            threadId: threadResult.thread.id,
            turn: turnResult.turn,
          });
        }

        await withLiveTimeout({
          details: { turnId: turnResult.turn.id },
          label: "Contract terminal Authority mutation",
          logStatus: logLiveStatus,
          task: async () => {
            await Promise.race([contract.terminal, protocolFailure.promise]);

            if (protocolError !== null) {
              throw protocolError;
            }
          },
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        });
        await client.drainServerMessages();

        const snapshot = contract.snapshot();
        const completedRun = snapshot.runs.find((entry) => entry.id === run.id);
        const terminalItem = snapshot.items.find(
          (item) => item.kind === "terminal" && JSON.stringify(item).includes(contents),
        );
        const changeItem = snapshot.items.find(
          (item) =>
            item.kind === "change" &&
            item.changes.some((change) => change.path.endsWith(outputName)),
        );
        const messageItem = snapshot.items.find(
          (item) => item.kind === "message" && JSON.stringify(item).includes("contract-done"),
        );

        expect(completedRun?.status).toBe("completed");
        expect(completedRun?.usage?.total).toBeGreaterThan(0);
        expect(terminalItem).toMatchObject({ status: "completed" });
        expect(changeItem).toMatchObject({ status: "completed" });
        expect(messageItem).toMatchObject({ status: "completed" });
        expect(contract.authority.every((update) => update.turnId === turnResult.turn.id)).toBe(
          true,
        );
        expect(snapshot.interactions.every((interaction) => interaction.status !== "open")).toBe(
          true,
        );
        expect(await readFile(join(paths.cwd, outputName), "utf8")).toBe(`${contents}\n`);
      } finally {
        contract.adapter.dispose();
        await client.stop();
        await logger.destroy();
      }
    },
    LIVE_TURN_TIMEOUT_MS + 10_000,
  );
});
