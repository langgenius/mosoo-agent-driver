import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import { OPENAI_DEFAULT_MODEL_ID } from "../src/models";
import type { DriverEventInput } from "../src/protocol/events";
import type { DriverStartInput } from "../src/protocol/start";
import { AGENT_DRIVER_PROVIDER_REGISTRY } from "../src/runtimes/provider-registry";
import { DRIVER_TEST_IDS, bootPayload } from "./driver-runtime-boundary-fixtures";
import {
  textDeltaFrom,
  waitForTerminalTurnEvent,
  withLiveTimeout,
} from "./live-driver-events";

const LIVE_ENABLED_ENV = "AGENT_DRIVER_LIVE_OPENAI";
const LIVE_API_KEY_ENV = "AGENT_DRIVER_LIVE_OPENAI_API_KEY";
const PROVIDER_API_KEY_ENV = "OPENAI_API_KEY";
const LIVE_MODEL_ENV = "AGENT_DRIVER_LIVE_OPENAI_MODEL";
const LIVE_OPERATION_TIMEOUT_MS = 15_000;
const LIVE_TURN_TIMEOUT_MS = 120_000;

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

async function sendPing(
  kernel: AgentDriverKernelCore,
  events: AsyncIterable<DriverEventInput>,
  suffix: string,
  runId = DRIVER_TEST_IDS.runId,
): Promise<void> {
  const requestId = `live-openai-request-${suffix}`;
  const dispatch = kernel.dispatch({
    commandId: `live-openai-input-${suffix}`,
    input: { text: "ping" },
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
  const outputText = turnEvents.map(textDeltaFrom).join("").trim().toLowerCase();

  await expect(dispatch).resolves.toEqual({ requestId });
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
          (event) => event.kind === "item.started",
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
          (event) => event.kind === "item.started",
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
