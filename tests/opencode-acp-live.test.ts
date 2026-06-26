import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import { createBufferedSinkLogger } from "../src/observability";
import { createDriverHostIntegrationSnapshotFromBootExecution } from "../src/protocol/host-integration";
import type { DriverStartInput } from "../src/protocol/start";
import { AGENT_DRIVER_PROVIDER_REGISTRY } from "../src/runtimes/provider-registry";
import { driverBootPayload } from "./driver-boot-payload-fixture";
import { DRIVER_TEST_IDS, bootPayload } from "./driver-runtime-boundary-fixtures";
import { textDeltaFrom, waitForTerminalTurnEvent, withLiveTimeout } from "./live-driver-events";

const LIVE_ENABLED_ENV = "AGENT_DRIVER_LIVE_OPENCODE";
const LIVE_API_KEY_ENV = "AGENT_DRIVER_LIVE_OPENCODE_API_KEY";
const LIVE_COMMAND_ENV = "AGENT_DRIVER_LIVE_OPENCODE_COMMAND";
const LIVE_MODEL_ENV = "AGENT_DRIVER_LIVE_OPENCODE_MODEL";
const LIVE_PROVIDER_ENV = "AGENT_DRIVER_LIVE_OPENCODE_PROVIDER";
const LIVE_SMALL_MODEL_ENV = "AGENT_DRIVER_LIVE_OPENCODE_SMALL_MODEL";
const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const LIVE_START_TIMEOUT_MS = 120_000;
const LIVE_TURN_TIMEOUT_MS = 120_000;
const OPENCODE_ACP_ARGS = ["acp", "--pure", "--print-logs", "--log-level", "DEBUG"] as const;

type OpenCodeLiveProvider = "anthropic" | "openai";

interface OpenCodeLiveProviderConfig {
  readonly defaultModel: string;
  readonly defaultSmallModel: string;
  readonly id: OpenCodeLiveProvider;
  readonly providerApiKeyEnv: string;
}

const PROVIDER_CONFIGS = {
  anthropic: {
    defaultModel: "claude-sonnet-4-5",
    defaultSmallModel: "claude-haiku-4-5",
    id: "anthropic",
    providerApiKeyEnv: ANTHROPIC_API_KEY_ENV,
  },
  openai: {
    defaultModel: "gpt-5.4",
    defaultSmallModel: "gpt-5-nano",
    id: "openai",
    providerApiKeyEnv: OPENAI_API_KEY_ENV,
  },
} as const satisfies Record<OpenCodeLiveProvider, OpenCodeLiveProviderConfig>;

const tempRoots: string[] = [];

function logLiveStatus(
  message: string,
  details: Record<string, string | number | boolean> = {},
): void {
  const suffix =
    Object.keys(details).length === 0
      ? ""
      : ` ${JSON.stringify(Object.fromEntries(Object.entries(details).toSorted((a, b) => a[0].localeCompare(b[0]))))}`;
  console.info(`[live-opencode] ${message}${suffix}`);
}

function createLiveLogger() {
  return createBufferedSinkLogger({
    flushIntervalMs: 1,
    level: "debug",
    maxBatchSize: 1,
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[live-opencode:driver] failed to flush log entries: ${message}`);
    },
    service: "opencode-acp-live-test",
    sink: async (entries) => {
      for (const entry of entries) {
        console.info(`[live-opencode:driver] ${JSON.stringify(entry)}`);
      }
    },
  });
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

function isLiveEnabled(): boolean {
  return readEnvString(LIVE_ENABLED_ENV) === "1";
}

function readLiveProvider(): OpenCodeLiveProvider {
  const provider = readEnvString(LIVE_PROVIDER_ENV) ?? "openai";

  if (provider === "anthropic" || provider === "openai") {
    return provider;
  }

  throw new Error(`Unsupported OpenCode live provider: ${provider}.`);
}

function readLiveProviderConfig(): OpenCodeLiveProviderConfig | null {
  if (!isLiveEnabled()) {
    return null;
  }

  return PROVIDER_CONFIGS[readLiveProvider()];
}

const liveProviderConfig = readLiveProviderConfig();

function readLiveApiKey(): string | null {
  if (liveProviderConfig === null) {
    return null;
  }

  return readEnvString(LIVE_API_KEY_ENV) ?? readEnvString(liveProviderConfig.providerApiKeyEnv);
}

function readLiveApiKeySource(): string | null {
  if (liveProviderConfig === null) {
    return null;
  }

  if (readEnvString(LIVE_API_KEY_ENV) !== null) {
    return LIVE_API_KEY_ENV;
  }

  if (readEnvString(liveProviderConfig.providerApiKeyEnv) !== null) {
    return liveProviderConfig.providerApiKeyEnv;
  }

  return null;
}

function readLiveCommand(): string {
  return readEnvString(LIVE_COMMAND_ENV) ?? "opencode";
}

function readLiveModel(): string {
  return (
    readEnvString(LIVE_MODEL_ENV) ?? (liveProviderConfig ?? PROVIDER_CONFIGS.openai).defaultModel
  );
}

function readLiveSmallModel(): string {
  return (
    readEnvString(LIVE_SMALL_MODEL_ENV) ??
    (liveProviderConfig ?? PROVIDER_CONFIGS.openai).defaultSmallModel
  );
}

function hasOpenCodeAcpCommand(command: string): boolean {
  const result = spawnSync(command, ["acp", "--help"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function readOpenCodeVersion(command: string): string {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return "unknown";
  }

  return result.stdout.trim() || "unknown";
}

function toOpenCodeModelId(model: string): string {
  const providerConfig = liveProviderConfig ?? PROVIDER_CONFIGS.openai;

  return model.includes("/") ? model : `${providerConfig.id}/${model}`;
}

function createOpenCodeConfig(): string {
  if (liveProviderConfig === null) {
    throw new Error("OpenCode live provider config is unavailable when live testing is disabled.");
  }

  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [liveProviderConfig.id],
    model: toOpenCodeModelId(readLiveModel()),
    provider: {
      [liveProviderConfig.id]: {
        options: {
          apiKey: `{env:${liveProviderConfig.providerApiKeyEnv}}`,
        },
      },
    },
    small_model: toOpenCodeModelId(readLiveSmallModel()),
  });
}

async function createLiveDriverPaths(): Promise<{
  cwd: string;
  homePath: string;
  sharedRootPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-driver-opencode-live-"));
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

function createLiveHostIntegrationSnapshot(input: {
  cwd: string;
  homePath: string;
  sharedRootPath: string;
}) {
  return createDriverHostIntegrationSnapshotFromBootExecution({
    ...driverBootPayload.execution,
    profilePrompt: "",
    session: {
      ...driverBootPayload.execution.session,
      additionalDirectories: [],
      context: {
        ...driverBootPayload.execution.session.context,
        appAccessSnapshot: { entries: [] },
        homePath: input.homePath,
        sessionOrganizationPath: input.sharedRootPath,
        spaceAliases: [],
      },
      cwd: input.cwd,
      mcpServers: [],
      nativeResumeRef: null,
    },
    skillCatalog: [],
    skills: [],
  });
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
          OPENCODE_CONFIG_CONTENT: createOpenCodeConfig(),
          [liveProviderConfig.providerApiKeyEnv]: input.apiKey,
        },
      },
      model: readLiveModel(),
      provider: liveProviderConfig.id,
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
      systemPrompt: "",
    },
    runtime: "acp-fallback",
    runtimeTransport: "acp-fallback",
  };
}

async function withOpenCodeFallbackEnv<T>(task: () => Promise<T>): Promise<T> {
  const previousCommand = process.env["MOSOO_ACP_FALLBACK_COMMAND"];
  const previousArgs = process.env["MOSOO_ACP_FALLBACK_ARGS"];

  process.env["MOSOO_ACP_FALLBACK_COMMAND"] = readLiveCommand();
  process.env["MOSOO_ACP_FALLBACK_ARGS"] = JSON.stringify(OPENCODE_ACP_ARGS);

  try {
    return await task();
  } finally {
    if (previousCommand === undefined) {
      delete process.env["MOSOO_ACP_FALLBACK_COMMAND"];
    } else {
      process.env["MOSOO_ACP_FALLBACK_COMMAND"] = previousCommand;
    }

    if (previousArgs === undefined) {
      delete process.env["MOSOO_ACP_FALLBACK_ARGS"];
    } else {
      process.env["MOSOO_ACP_FALLBACK_ARGS"] = previousArgs;
    }
  }
}

const liveApiKey = readLiveApiKey();
const liveApiKeySource = readLiveApiKeySource();
const liveCommand = readLiveCommand();
const liveTest =
  isLiveEnabled() && liveProviderConfig && liveApiKey && hasOpenCodeAcpCommand(liveCommand)
    ? test
    : test.skip;

describe("OpenCode ACP live provider", () => {
  liveTest(
    "sends ping through the ACP fallback driver and receives pong from OpenCode",
    async () => {
      expect(liveApiKey).toBeString();
      const paths = await createLiveDriverPaths();
      const runtimeDetails = {
        command: liveCommand,
        fallbackArgs: OPENCODE_ACP_ARGS.join(" "),
        keySource: liveApiKeySource ?? "none",
        model: readLiveModel(),
        openCodeVersion: readOpenCodeVersion(liveCommand),
        provider: liveProviderConfig.id,
        smallModel: readLiveSmallModel(),
      };
      logLiveStatus("starting live smoke", runtimeDetails);
      logLiveStatus("workspace prepared", {
        cwd: paths.cwd,
        homePath: paths.homePath,
        sharedRootPath: paths.sharedRootPath,
      });
      logLiveStatus("OpenCode config prepared", {
        apiKeyEnv: liveProviderConfig.providerApiKeyEnv,
        configModel: toOpenCodeModelId(readLiveModel()),
        configSmallModel: toOpenCodeModelId(readLiveSmallModel()),
        enabledProvider: liveProviderConfig.id,
      });
      const startInput = createLiveStartInput({
        apiKey: liveApiKey,
        cwd: paths.cwd,
        homePath: paths.homePath,
        sharedRootPath: paths.sharedRootPath,
      });
      const hostSnapshot = createLiveHostIntegrationSnapshot(paths);
      const logger = createLiveLogger();
      let kernelStarted = false;
      const kernel = new AgentDriverKernelCore({
        backendFactory: (input) => {
          logLiveStatus("creating backend", {
            runtime: input.runtime,
            runtimeTransport: input.runtimeTransport,
          });
          const backend = AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(input);
          logLiveStatus("backend created", { runtime: backend.runtime });
          return backend;
        },
        logger,
        hostPorts: {
          file: {
            reportChanged: async () => {
              logLiveStatus("host file change reported");
            },
          },
          hostIntegration: {
            snapshot: async () => {
              logLiveStatus("host integration snapshot requested");
              logLiveStatus("host integration snapshot prepared", {
                accessEntries: hostSnapshot.sessionContext.appAccessSnapshot.entries.length,
              });
              return hostSnapshot;
            },
          },
          permission: {
            request: async () => {
              logLiveStatus("permission requested");
              return "reject_once";
            },
          },
          skill: {
            materialize: async () => {
              logLiveStatus("skill materialization requested");
              return [];
            },
          },
        },
      });
      const events = kernel.events();

      try {
        await withOpenCodeFallbackEnv(async () => {
          logLiveStatus("starting driver kernel", runtimeDetails);
          await withLiveTimeout({
            details: runtimeDetails,
            label: "OpenCode ACP driver kernel start",
            logStatus: logLiveStatus,
            task: () => kernel.start(startInput),
            timeoutMs: LIVE_START_TIMEOUT_MS,
          });
          kernelStarted = true;
          logLiveStatus("driver kernel started");

          logLiveStatus("dispatching user input");
          const dispatch = kernel.dispatch({
            commandId: "live-opencode-input-1",
            input: {
              text: "Reply with exactly one lowercase word: pong. Do not call tools.",
            },
            kind: "input.start",
            requestId: "live-opencode-request-1",
            runId: DRIVER_TEST_IDS.runId,
          });
          const turnEvents = await waitForTerminalTurnEvent({
            events,
            logStatus: logLiveStatus,
            timeoutMs: LIVE_TURN_TIMEOUT_MS,
          });
          const outputText = turnEvents.map(textDeltaFrom).join("").trim().toLowerCase();
          logLiveStatus("received output", {
            outputChars: outputText.length,
            outputPreview: outputText.slice(0, 120),
          });

          await expect(dispatch).resolves.toEqual({
            requestId: "live-opencode-request-1",
          });
          expect(outputText).toContain("pong");
        });
      } finally {
        logLiveStatus("stopping driver kernel", { kernelStarted });
        await withLiveTimeout({
          details: { kernelStarted },
          label: "OpenCode ACP driver kernel stop",
          logStatus: logLiveStatus,
          task: () => kernel.stop("test.stop"),
          timeoutMs: 5_000,
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logLiveStatus("driver kernel stop failed", { message });
        });
        await logger.destroy();
      }
    },
    LIVE_START_TIMEOUT_MS + LIVE_TURN_TIMEOUT_MS + 10_000,
  );
});
