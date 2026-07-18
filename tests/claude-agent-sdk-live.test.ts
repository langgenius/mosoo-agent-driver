import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import type { DriverEventInput } from "../src/protocol/events";
import type { DriverStartInput } from "../src/protocol/start";
import { AGENT_DRIVER_PROVIDER_REGISTRY } from "../src/runtimes/provider-registry";
import { DRIVER_TEST_IDS, bootPayload } from "./driver-runtime-boundary-fixtures";
import { textDeltaFrom, waitForTerminalTurnEvent } from "./live-driver-events";

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

function hasPayloadValue(event: DriverEventInput, key: string, value: string): boolean {
  return (
    typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload) &&
    (event.payload as Record<string, unknown>)[key] === value
  );
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
    "reads and writes workspace files through SDK tools",
    async () => {
      const paths = await createLiveDriverPaths();
      const kernel = createLiveKernel();
      const inputName = "source file-λ.txt";
      const outputName = "claude-output.txt";
      const contents = "claude-live-token-6241";
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
          "workspace-tools",
          `Use Read to read ${JSON.stringify(inputName)}. Use Write to create ${JSON.stringify(outputName)} with exactly the text you read. Do not use Bash. Reply with exactly files-done.`,
        );

        expect(events.some((event) => hasPayloadValue(event, "title", "Read"))).toBe(true);
        expect(events.some((event) => hasPayloadValue(event, "title", "Write"))).toBe(true);
        expect(events.map(textDeltaFrom).join("")).toContain("files-done");
        expect(await readFile(join(paths.cwd, inputName), "utf8")).toBe(`${contents}\n`);
        expect(await readFile(join(paths.cwd, outputName), "utf8")).toBe(`${contents}\n`);
      } finally {
        await kernel.stop("test.stop").catch(() => {});
      }
    },
    LIVE_TURN_TIMEOUT_MS + 5_000,
  );
});
