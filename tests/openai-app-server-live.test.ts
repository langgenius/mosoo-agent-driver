import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import { OPENAI_DEFAULT_MODEL_ID } from "../src/models";
import type { DriverStartInput } from "../src/protocol/start";
import { AGENT_DRIVER_PROVIDER_REGISTRY } from "../src/runtimes/provider-registry";
import { DRIVER_TEST_IDS, bootPayload } from "./driver-runtime-boundary-fixtures";
import { textDeltaFrom, waitForTerminalTurnEvent } from "./live-driver-events";

const LIVE_API_KEY_ENV = "AGENT_DRIVER_LIVE_OPENAI_API_KEY";
const PROVIDER_API_KEY_ENV = "OPENAI_API_KEY";
const LIVE_MODEL_ENV = "AGENT_DRIVER_LIVE_OPENAI_MODEL";
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
  apiKey: string;
  cwd: string;
  homePath: string;
  sharedRootPath: string;
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
      provider: "openai",
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
      systemPrompt: "Reply to the user with exactly one lowercase word: pong. Do not call tools.",
    },
    runtime: "openai-runtime",
    runtimeTransport: "openai-app-server",
  };
}

const liveApiKey = readLiveApiKey();
const liveTest = liveApiKey ? test : test.skip;

describe("OpenAI app-server live provider", () => {
  liveTest(
    "sends ping through the driver and receives pong from OpenAI",
    async () => {
      expect(liveApiKey).toBeString();
      logLiveStatus("starting live smoke", {
        executableOverride: Boolean(readEnvString("MOSOO_OPENAI_RUNTIME_EXECUTABLE")),
        model: readLiveModel(),
      });
      const paths = await createLiveDriverPaths();
      logLiveStatus("workspace prepared");
      const kernel = new AgentDriverKernelCore({
        backendFactory: (input) => AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(input),
        hostPorts: {
          skill: {
            materialize: async () => [],
          },
        },
      });
      const events = kernel.events();
      let kernelStarted = false;

      try {
        logLiveStatus("starting driver kernel");
        await kernel.start(
          createLiveStartInput({
            apiKey: liveApiKey,
            cwd: paths.cwd,
            homePath: paths.homePath,
            sharedRootPath: paths.sharedRootPath,
          }),
        );
        kernelStarted = true;
        logLiveStatus("driver kernel started");

        const inputText = "ping";
        logLiveStatus("sending input", {
          text: inputText,
        });
        const dispatch = kernel.dispatch({
          commandId: "live-openai-input-1",
          input: {
            text: inputText,
          },
          kind: "input.start",
          requestId: "live-openai-request-1",
          runId: DRIVER_TEST_IDS.runId,
        });
        logLiveStatus("waiting for terminal event");
        const turnEvents = await waitForTerminalTurnEvent({
          events,
          logStatus: logLiveStatus,
          progressMessage: "still waiting for terminal event",
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        });
        const outputText = turnEvents.map(textDeltaFrom).join("").trim().toLowerCase();
        logLiveStatus("received output", {
          text: outputText,
        });

        await expect(dispatch).resolves.toEqual({
          requestId: "live-openai-request-1",
        });
        logLiveStatus("dispatch completed", {
          outputChars: outputText.length,
        });
        expect(outputText).toContain("pong");
      } finally {
        if (kernelStarted) {
          logLiveStatus("stopping driver kernel");
          await kernel.stop("test.stop").catch(() => {});
          logLiveStatus("driver kernel stopped");
        } else {
          logLiveStatus("driver kernel was not started; skipping stop");
        }
      }
    },
    LIVE_TURN_TIMEOUT_MS + 5_000,
  );
});
