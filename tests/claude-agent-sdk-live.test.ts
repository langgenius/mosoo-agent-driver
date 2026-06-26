import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import type { DriverStartInput } from "../src/protocol/start";
import { AGENT_DRIVER_PROVIDER_REGISTRY } from "../src/runtimes/provider-registry";
import { DRIVER_TEST_IDS, bootPayload } from "./driver-runtime-boundary-fixtures";
import { textDeltaFrom, waitForTerminalTurnEvent } from "./live-driver-events";

const LIVE_API_KEY_ENV = "AGENT_DRIVER_LIVE_ANTHROPIC_API_KEY";
const PROVIDER_API_KEY_ENV = "ANTHROPIC_API_KEY";
const LIVE_MODEL_ENV = "AGENT_DRIVER_LIVE_ANTHROPIC_MODEL";
const DEFAULT_LIVE_MODEL = "claude-sonnet-4-5";
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
      systemPrompt: "Reply to the user with exactly one lowercase word: pong. Do not call tools.",
    },
    runtime: "claude-agent-sdk",
    runtimeTransport: "claude-agent-sdk",
  };
}

const liveApiKey = readLiveApiKey();
const liveTest = liveApiKey ? test : test.skip;

describe("Claude Agent SDK live provider", () => {
  liveTest(
    "sends ping through the driver and receives pong from Anthropic",
    async () => {
      expect(liveApiKey).toBeString();
      const paths = await createLiveDriverPaths();
      const kernel = new AgentDriverKernelCore({
        backendFactory: (input) => AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(input),
        hostPorts: {
          skill: {
            materialize: async () => [],
          },
        },
      });
      const events = kernel.events();

      try {
        await kernel.start(
          createLiveStartInput({
            apiKey: liveApiKey,
            cwd: paths.cwd,
            homePath: paths.homePath,
            sharedRootPath: paths.sharedRootPath,
          }),
        );

        const dispatch = kernel.dispatch({
          commandId: "live-input-1",
          input: {
            text: "ping",
          },
          kind: "input.start",
          requestId: "live-request-1",
          runId: DRIVER_TEST_IDS.runId,
        });
        const turnEvents = await waitForTerminalTurnEvent({
          events,
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        });
        const outputText = turnEvents.map(textDeltaFrom).join("").trim().toLowerCase();

        await expect(dispatch).resolves.toEqual({
          requestId: "live-request-1",
        });
        expect(outputText).toContain("pong");
      } finally {
        await kernel.stop("test.stop").catch(() => {});
      }
    },
    LIVE_TURN_TIMEOUT_MS + 5_000,
  );
});
