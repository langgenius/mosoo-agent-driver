import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  DriverArtifactTestController,
  type DriverArtifactBootPayload,
  type DriverArtifactTestEvent,
} from "./driver-artifact-test-controller";

const LIVE_START_TIMEOUT_MS = 120_000;
const LIVE_TURN_TIMEOUT_MS = 180_000;
const LIVE_STOP_TIMEOUT_MS = 15_000;
const LIVE_TEST_TIMEOUT_MS =
  4 * LIVE_START_TIMEOUT_MS + 3 * LIVE_TURN_TIMEOUT_MS + 3 * LIVE_STOP_TIMEOUT_MS;
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
const DEFAULT_OPENAI_MODEL = "openai/gpt-5.6-luna";
const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-sonnet-5";
const DEFAULT_OPENCODE_MODELS = [
  "openrouter/moonshotai/kimi-k3",
  "openrouter/deepseek/deepseek-v4-flash",
  "openrouter/z-ai/glm-5.2",
  "openrouter/qwen/qwen3.7-plus",
] as const;
const BUILT_IN_TOOLS = [
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
  "web_fetch",
  "web_search",
  "write",
] as const;
const TEST_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type LiveSuite = "all" | "anthropic" | "openai" | "opencode";
type RuntimeSuite = Exclude<LiveSuite, "all">;

interface LiveConfig {
  readonly anthropicBaseUrl: string;
  readonly anthropicModel: string;
  readonly artifactPath: string;
  readonly key: string;
  readonly openAiModel: string;
  readonly openAiReasoningEffort: string;
  readonly openCodeCommand: string;
  readonly openCodeModels: readonly string[];
  readonly openRouterBaseUrl: string;
  readonly suite: LiveSuite;
}

interface LiveRuntimeCase {
  readonly model: string;
  readonly nativeResumeKind: "acp_session_id" | "claude_session_id" | "openai_thread_id";
  readonly provider: string;
  readonly runtime: "acp-fallback" | "claude-agent-sdk" | "openai-runtime";
  readonly suite: RuntimeSuite;
  readonly transport: "acp-fallback" | "claude-agent-sdk" | "openai-app-server";
}

interface LivePaths {
  readonly homePath: string;
  readonly rootPath: string;
  readonly workspacePath: string;
}

interface NativeResumeRef {
  readonly kind: LiveRuntimeCase["nativeResumeKind"];
  readonly runtimeId: LiveRuntimeCase["runtime"];
  readonly value: string;
}

interface RecoveryMessage {
  readonly content: string;
  readonly role: "assistant" | "user";
}

let nextTestId = 0;

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function readSuite(): LiveSuite {
  const suite = readEnv("AGENT_DRIVER_LIVE_SUITE") ?? "all";

  if (suite === "all" || suite === "anthropic" || suite === "openai" || suite === "opencode") {
    return suite;
  }

  throw new Error(`AGENT_DRIVER_LIVE_SUITE is unsupported: ${suite}.`);
}

function readUrl(name: string, fallback: string): string {
  const value = readEnv(name) ?? fallback;
  const url = new URL(value);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }

  return value.replace(/\/$/, "");
}

function readOpenCodeModels(): string[] {
  const raw = readEnv("AGENT_DRIVER_LIVE_OPENCODE_MODELS");
  const value: unknown = raw === null ? [...DEFAULT_OPENCODE_MODELS] : JSON.parse(raw);

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (model) =>
        typeof model !== "string" ||
        !model.startsWith("openrouter/") ||
        model.length === "openrouter/".length,
    )
  ) {
    throw new Error(
      "AGENT_DRIVER_LIVE_OPENCODE_MODELS must be a non-empty JSON array of openrouter/* model IDs.",
    );
  }

  if (new Set(value).size !== value.length) {
    throw new Error("AGENT_DRIVER_LIVE_OPENCODE_MODELS must not contain duplicates.");
  }

  return value;
}

function readLiveConfig(): LiveConfig {
  const key = readEnv("OPENROUTER_API_KEY");

  if (key === null) {
    throw new Error("OPENROUTER_API_KEY is required for artifact live tests.");
  }

  const suite = readSuite();
  const artifactValue = readEnv("AGENT_DRIVER_LIVE_ARTIFACT") ?? "dist/driver.mjs";
  const artifactPath = isAbsolute(artifactValue)
    ? artifactValue
    : resolve(process.cwd(), artifactValue);

  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    throw new Error(`AGENT_DRIVER_LIVE_ARTIFACT is not a file: ${artifactPath}.`);
  }

  const openCodeCommand = readEnv("AGENT_DRIVER_LIVE_OPENCODE_COMMAND") ?? "opencode";

  if (
    (suite === "all" || suite === "opencode") &&
    spawnSync(openCodeCommand, ["acp", "--help"], { stdio: "ignore" }).status !== 0
  ) {
    throw new Error(`OpenCode ACP command is unavailable: ${openCodeCommand}.`);
  }

  return {
    anthropicBaseUrl: readUrl(
      "AGENT_DRIVER_LIVE_OPENROUTER_ANTHROPIC_BASE_URL",
      DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL,
    ),
    anthropicModel: readEnv("AGENT_DRIVER_LIVE_ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL,
    artifactPath,
    key,
    openAiModel: readEnv("AGENT_DRIVER_LIVE_OPENAI_MODEL") ?? DEFAULT_OPENAI_MODEL,
    openAiReasoningEffort: readEnv("AGENT_DRIVER_LIVE_OPENAI_REASONING_EFFORT") ?? "medium",
    openCodeCommand,
    openCodeModels: readOpenCodeModels(),
    openRouterBaseUrl: readUrl(
      "AGENT_DRIVER_LIVE_OPENROUTER_BASE_URL",
      DEFAULT_OPENROUTER_BASE_URL,
    ),
    suite,
  };
}

const liveEnabled = readEnv("AGENT_DRIVER_LIVE") === "1";
const config: LiveConfig = liveEnabled
  ? readLiveConfig()
  : {
      anthropicBaseUrl: DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL,
      anthropicModel: DEFAULT_ANTHROPIC_MODEL,
      artifactPath: resolve(process.cwd(), "dist/driver.mjs"),
      key: "",
      openAiModel: DEFAULT_OPENAI_MODEL,
      openAiReasoningEffort: "medium",
      openCodeCommand: "opencode",
      openCodeModels: DEFAULT_OPENCODE_MODELS,
      openRouterBaseUrl: DEFAULT_OPENROUTER_BASE_URL,
      suite: "all",
    };
const liveTest = liveEnabled ? test : test.skip;

const runtimeCases: LiveRuntimeCase[] = [
  {
    model: config.openAiModel,
    nativeResumeKind: "openai_thread_id",
    provider: "openai-compatible",
    runtime: "openai-runtime",
    suite: "openai",
    transport: "openai-app-server",
  } satisfies LiveRuntimeCase,
  {
    model: config.anthropicModel,
    nativeResumeKind: "claude_session_id",
    provider: "anthropic",
    runtime: "claude-agent-sdk",
    suite: "anthropic",
    transport: "claude-agent-sdk",
  } satisfies LiveRuntimeCase,
  ...config.openCodeModels.map(
    (model): LiveRuntimeCase => ({
      model,
      nativeResumeKind: "acp_session_id",
      provider: "openrouter",
      runtime: "acp-fallback",
      suite: "opencode",
      transport: "acp-fallback",
    }),
  ),
].filter((runtimeCase) => config.suite === "all" || config.suite === runtimeCase.suite);
const representativeOpenCodeModel =
  config.openCodeModels.find((model) => model.includes("/deepseek/")) ?? config.openCodeModels[0]!;
const lifecycleCases = runtimeCases.filter(
  (runtimeCase) =>
    runtimeCase.suite !== "opencode" || runtimeCase.model === representativeOpenCodeModel,
);
const controlCase =
  lifecycleCases.find((runtimeCase) => runtimeCase.suite === "opencode") ?? lifecycleCases[0]!;

function createTestId(): string {
  let value = ++nextTestId;
  let suffix = "";

  for (let index = 0; index < 16; index += 1) {
    suffix = TEST_ID_ALPHABET[value % TEST_ID_ALPHABET.length]! + suffix;
    value = Math.floor(value / TEST_ID_ALPHABET.length);
  }

  return `01J0000000${suffix}`;
}

function payloadRecord(event: DriverArtifactTestEvent): Record<string, unknown> {
  return typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function eventText(events: readonly DriverArtifactTestEvent[]): string {
  return events
    .flatMap((event) => {
      const payload = payloadRecord(event);

      if (event.kind === "message.delta" && typeof payload["contentDelta"] === "string") {
        return [payload["contentDelta"]];
      }
      if (event.kind === "run.completed" && typeof payload["finalMessageText"] === "string") {
        return [payload["finalMessageText"]];
      }

      return [];
    })
    .join("");
}

function hasToolStatus(event: DriverArtifactTestEvent, status: string): boolean {
  return event.kind === "tool.call.updated" && payloadRecord(event)["status"] === status;
}

function hasFileChange(events: readonly DriverArtifactTestEvent[]): boolean {
  return events.some(
    (event) => event.kind === "file.change.updated" || event.kind === "file.changed",
  );
}

function expectSingleRunLifecycle(
  events: readonly DriverArtifactTestEvent[],
  runId: string,
  terminalKind: "run.cancelled" | "run.completed" | "run.failed",
): void {
  const runEvents = events.filter((event) => event.runId === runId);
  const terminalEvents = runEvents.filter(
    (event) =>
      event.kind === "run.cancelled" ||
      event.kind === "run.completed" ||
      event.kind === "run.failed",
  );

  expect(runEvents.filter((event) => event.kind === "run.started")).toHaveLength(1);
  expect(terminalEvents).toHaveLength(1);
  expect(terminalEvents[0]?.kind).toBe(terminalKind);
}

function readResumePointer(events: readonly DriverArtifactTestEvent[]): string | null {
  const event = events.find((candidate) => candidate.kind === "runtime.resume.updated");
  const pointer = event === undefined ? undefined : payloadRecord(event)["resumePointer"];
  return typeof pointer === "string" && pointer.length > 0 ? pointer : null;
}

function createOpenCodeConfig(model: string): string {
  const slug = model.slice("openrouter/".length);
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["openrouter"],
    model,
    provider: {
      openrouter: {
        models: {
          [`~${slug}`]: {},
        },
      },
    },
    small_model: model,
  });
}

function runtimeEnvironment(runtimeCase: LiveRuntimeCase): Record<string, string> {
  switch (runtimeCase.suite) {
    case "openai":
      return {
        OPENAI_API_KEY: "",
        OPENAI_COMPATIBLE_API_KEY: config.key,
        OPENAI_COMPATIBLE_BASE_URL: config.openRouterBaseUrl,
      };
    case "anthropic":
      return {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: config.key,
        ANTHROPIC_BASE_URL: config.anthropicBaseUrl,
      };
    case "opencode":
      return {
        OPENCODE_CONFIG_CONTENT: createOpenCodeConfig(runtimeCase.model),
      };
  }
}

function createBootPayload(input: {
  readonly driverInstanceId: string;
  readonly nativeResumeRef: NativeResumeRef | null;
  readonly paths: LivePaths;
  readonly permissionPolicy?: "full_access" | "supervised" | undefined;
  readonly recoveryMessages?: readonly RecoveryMessage[] | undefined;
  readonly runtimeCase: LiveRuntimeCase;
  readonly sessionId: string;
}): DriverArtifactBootPayload {
  const runtimeCase = input.runtimeCase;

  return {
    bootToken: `artifact-test-${input.driverInstanceId}`,
    controlUrl: "http://127.0.0.1/unused",
    driverControlPort: 20_000,
    driverGeneration: 0,
    driverInstanceId: input.driverInstanceId,
    execution: {
      builtInTools: BUILT_IN_TOOLS.map((name) => ({ enabled: true, name })),
      configRevision: {
        agentId: createTestId(),
        deploymentVersionId: null,
        deploymentVersionNumber: null,
        environmentId: createTestId(),
        environmentRevisionId: createTestId(),
        runId: null,
        sessionId: input.sessionId,
      },
      environment: {
        variables: runtimeEnvironment(runtimeCase),
      },
      model: runtimeCase.model,
      permissionPolicy: input.permissionPolicy ?? "full_access",
      profilePrompt:
        "Use available tools when requested, complete every requested step, and end with exactly the requested reply.",
      provider: runtimeCase.provider,
      providerOptions:
        runtimeCase.suite === "openai"
          ? {
              model_reasoning_effort: config.openAiReasoningEffort,
              plan_mode_reasoning_effort: config.openAiReasoningEffort,
            }
          : {},
      session: {
        additionalDirectories: [],
        context: {
          homePath: input.paths.homePath,
          origin: {
            callerUserId: createTestId(),
            entrypoint: "api",
            executionOwnerUserId: createTestId(),
            type: "agent",
          },
          sandboxId: createTestId(),
          sandboxKind: "cattle",
          sandboxSessionId: createTestId(),
          sandboxSubjectId: input.sessionId,
          sandboxSubjectKind: "session",
          sessionOrganizationPath: input.paths.workspacePath,
        },
        cwd: input.paths.workspacePath,
        mcpServers: [],
        nativeResumeRef: input.nativeResumeRef,
        recoveryMessages: input.recoveryMessages ?? [],
      },
      skillCatalog: [],
      skills: [],
    },
    heartbeatIntervalMs: 60_000,
    protocolVersion: 1,
    runtime: runtimeCase.runtime,
    runtimeTransport: runtimeCase.transport,
    sandboxId: createTestId(),
    traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
  };
}

async function createLivePaths(): Promise<LivePaths> {
  const rootPath = await mkdtemp(join(tmpdir(), "mosoo-driver-artifact-live-"));
  const homePath = join(rootPath, "home");
  const workspacePath = join(rootPath, "workspace");
  await Promise.all([
    mkdir(homePath, { recursive: true }),
    mkdir(workspacePath, { recursive: true }),
  ]);
  return { homePath, rootPath, workspacePath };
}

async function writeOpenCodeAuth(paths: LivePaths): Promise<void> {
  const authDirectory = join(paths.homePath, ".local", "share", "opencode");
  await mkdir(authDirectory, { recursive: true });
  await writeFile(
    join(authDirectory, "auth.json"),
    `${JSON.stringify({ openrouter: { key: config.key, type: "api" } }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function startController(input: {
  readonly heartbeatIntervalMs?: number | undefined;
  readonly nativeResumeRef?: NativeResumeRef | null;
  readonly paths: LivePaths;
  readonly permissionPolicy?: "full_access" | "supervised" | undefined;
  readonly recoveryMessages?: readonly RecoveryMessage[] | undefined;
  readonly runtimeCase: LiveRuntimeCase;
  readonly sessionId: string;
}): Promise<DriverArtifactTestController> {
  if (input.runtimeCase.suite === "opencode") {
    await writeOpenCodeAuth(input.paths);
  }

  const driverInstanceId = createTestId();
  const controller = await DriverArtifactTestController.start({
    artifactPath: config.artifactPath,
    bootPayload: createBootPayload({
      driverInstanceId,
      nativeResumeRef: input.nativeResumeRef ?? null,
      paths: input.paths,
      permissionPolicy: input.permissionPolicy,
      recoveryMessages: input.recoveryMessages,
      runtimeCase: input.runtimeCase,
      sessionId: input.sessionId,
    }),
    env:
      input.runtimeCase.suite === "opencode"
        ? {
            MOSOO_ACP_FALLBACK_ARGS: JSON.stringify(["acp", "--pure"]),
            MOSOO_ACP_FALLBACK_COMMAND: config.openCodeCommand,
            OPENROUTER_API_KEY: "",
          }
        : { OPENAI_API_KEY: "", OPENROUTER_API_KEY: "" },
    organizationPath: input.paths.workspacePath,
    rootPath: input.paths.rootPath,
    secret: config.key,
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    startTimeoutMs: LIVE_START_TIMEOUT_MS,
  });
  await assertConfiguredModel(controller, input.runtimeCase);
  return controller;
}

async function assertConfiguredModel(
  controller: DriverArtifactTestController,
  runtimeCase: LiveRuntimeCase,
): Promise<void> {
  if (runtimeCase.suite !== "opencode") {
    return;
  }

  const configEvent = await controller.waitForEvent(
    (event) => event.kind === "session.config.updated",
    0,
    LIVE_START_TIMEOUT_MS,
    "OpenCode session model config",
  );
  const options = payloadRecord(configEvent)["options"];
  const modelOption = Array.isArray(options)
    ? options.find(
        (option) =>
          typeof option === "object" &&
          option !== null &&
          !Array.isArray(option) &&
          (option as Record<string, unknown>)["id"] === "model",
      )
    : undefined;

  expect(modelOption).toBeDefined();
  expect((modelOption as Record<string, unknown>)["currentValue"]).toBe(runtimeCase.model);
}

async function runTurn(
  controller: DriverArtifactTestController,
  text: string,
): Promise<DriverArtifactTestEvent[]> {
  const commandId = `input-${createTestId()}`;
  const runId = createTestId();
  const updateIndex = controller.commandUpdates.length;
  const events = await controller.runTurn({
    commandId,
    requestId: `request-${createTestId()}`,
    runId,
    text,
    timeoutMs: LIVE_TURN_TIMEOUT_MS,
  });
  const runEvents = events.filter((event) => event.runId === runId);
  const updates = controller.commandUpdates
    .slice(updateIndex)
    .filter((update) => update.commandId === commandId);

  expectSingleRunLifecycle(runEvents, runId, "run.completed");
  expect(updates.filter((update) => update.status === "accepted")).toHaveLength(1);
  expect(
    updates.filter(
      (update) =>
        update.status === "cancelled" ||
        update.status === "completed" ||
        update.status === "failed",
    ),
  ).toEqual([expect.objectContaining({ status: "completed" })]);

  return events;
}

function startedRunId(events: readonly DriverArtifactTestEvent[]): string {
  const runId = events.find((event) => event.kind === "run.started")?.runId;
  expect(runId).toBeDefined();
  return runId!;
}

function enqueueTurn(
  controller: DriverArtifactTestController,
  text: string,
): { commandId: string; eventIndex: number; runId: string } {
  const commandId = `input-${createTestId()}`;
  const runId = createTestId();
  const eventIndex = controller.events.length;
  controller.enqueue({
    commandId,
    input: { text },
    kind: "input.start",
    requestId: `request-${createTestId()}`,
    runId,
  });
  return { commandId, eventIndex, runId };
}

async function stopController(controller: DriverArtifactTestController): Promise<void> {
  await controller.stopDriver(`stop-${createTestId()}`, LIVE_STOP_TIMEOUT_MS);
}

async function withLivePaths(task: (paths: LivePaths) => Promise<void>): Promise<void> {
  const paths = await createLivePaths();

  try {
    await task(paths);
  } finally {
    await rm(paths.rootPath, { force: true, recursive: true });
  }
}

async function withController(
  runtimeCase: LiveRuntimeCase,
  paths: LivePaths,
  task: (controller: DriverArtifactTestController) => Promise<void>,
): Promise<void> {
  const controller = await startController({
    paths,
    runtimeCase,
    sessionId: createTestId(),
  });

  try {
    await task(controller);
    await stopController(controller);
  } finally {
    await controller.dispose();
  }
}

async function testStartup(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    await withController(runtimeCase, paths, async (controller) => {
      const firstEvents = await runTurn(
        controller,
        "Reply with exactly one lowercase word: pong. Do not call tools.",
      );
      const secondEvents = await runTurn(
        controller,
        "Reply with exactly one lowercase word: encore. Do not call tools.",
      );

      expect(eventText(firstEvents).toLowerCase()).toContain("pong");
      expect(eventText(secondEvents).toLowerCase()).toContain("encore");
      expect(startedRunId(firstEvents)).not.toBe(startedRunId(secondEvents));
    });
  });
}

async function testWorkspace(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const sourceName = "source file-λ.txt";
    const outputName = "created result-空格.txt";
    const editName = "edit target-中.txt";
    const deleteName = "delete target-😀.txt";
    const token = `workspace-token-${createTestId()}`;
    await Promise.all([
      writeFile(join(paths.workspacePath, sourceName), `${token}\n`, "utf8"),
      writeFile(join(paths.workspacePath, editName), "before\n", "utf8"),
      writeFile(join(paths.workspacePath, deleteName), "remove me\n", "utf8"),
    ]);

    await withController(runtimeCase, paths, async (controller) => {
      const events = await runTurn(
        controller,
        `Use available file and shell tools to perform every step in order: read ${JSON.stringify(sourceName)}; create ${JSON.stringify(outputName)} containing exactly the token you read; replace before with after in ${JSON.stringify(editName)}; delete ${JSON.stringify(deleteName)}. Reply with exactly workspace-done.`,
      );

      expect((await readFile(join(paths.workspacePath, outputName), "utf8")).trim()).toBe(token);
      expect(await readFile(join(paths.workspacePath, editName), "utf8")).toBe("after\n");
      await expect(stat(join(paths.workspacePath, deleteName))).rejects.toThrow();
      expect(events.some((event) => hasToolStatus(event, "completed"))).toBe(true);
      expect(hasFileChange(events)).toBe(true);
      expect(eventText(events).toLowerCase()).toContain("workspace-done");
    });
  });
}

async function testCommandRecovery(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    await withController(runtimeCase, paths, async (controller) => {
      const events = await runTurn(
        controller,
        "Run `sh -c 'printf live-stdout; printf live-stderr >&2; exit 7'`. After it fails, run `printf live-recovered`. Then reply with exactly recovered.",
      );
      const serialized = JSON.stringify(events);

      expect(events.some((event) => hasToolStatus(event, "failed"))).toBe(true);
      expect(events.some((event) => hasToolStatus(event, "completed"))).toBe(true);
      expect(serialized).toContain("live-stdout");
      expect(serialized).toContain("live-stderr");
      expect(serialized).toContain("live-recovered");
      expect(eventText(events).toLowerCase()).toContain("recovered");
    });
  });
}

async function testResume(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const sessionId = createTestId();
    const token = `resume-${createTestId()}`;
    const first = await startController({ paths, runtimeCase, sessionId });
    let resumePointer: string;

    try {
      await runTurn(
        first,
        `Remember this exact token for the next process: ${token}. Reply with exactly stored.`,
      );
      const pointer = readResumePointer(first.events);
      expect(pointer).not.toBeNull();
      resumePointer = pointer!;
      await stopController(first);
    } finally {
      await first.dispose();
    }

    const resumed = await startController({
      nativeResumeRef: {
        kind: runtimeCase.nativeResumeKind,
        runtimeId: runtimeCase.runtime,
        value: resumePointer,
      },
      paths,
      runtimeCase,
      sessionId,
    });

    try {
      if (runtimeCase.suite === "opencode") {
        const resumedEvent = await resumed.waitForEvent(
          (event) => event.kind === "session.resumed",
          0,
          LIVE_START_TIMEOUT_MS,
          "OpenCode session resumed event",
        );
        expect(payloadRecord(resumedEvent)["reason"]).toBe("resumed");
      }

      const events = await runTurn(
        resumed,
        "Reply with exactly the token I asked you to remember in the previous process.",
      );
      expect(eventText(events)).toContain(token);
      await stopController(resumed);
    } finally {
      await resumed.dispose();
    }
  });
}

async function testCrashResume(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const sessionId = createTestId();
    const token = `crash-resume-${createTestId()}`;
    const first = await startController({ paths, runtimeCase, sessionId });
    let resumePointer: string;

    try {
      await runTurn(
        first,
        `Remember this exact token across a process crash: ${token}. Reply with exactly stored.`,
      );
      const pointer = readResumePointer(first.events);
      expect(pointer).not.toBeNull();
      resumePointer = pointer!;
      first.crashDriver();
      expect(await first.waitForExit(LIVE_STOP_TIMEOUT_MS)).toMatchObject({
        code: null,
        signal: "SIGKILL",
      });
    } finally {
      await first.dispose();
    }

    const resumed = await startController({
      nativeResumeRef: {
        kind: runtimeCase.nativeResumeKind,
        runtimeId: runtimeCase.runtime,
        value: resumePointer,
      },
      paths,
      runtimeCase,
      sessionId,
    });

    try {
      const events = await runTurn(
        resumed,
        "Reply with exactly the token I asked you to remember before the process crashed.",
      );
      expect(eventText(events)).toContain(token);
      await stopController(resumed);
    } finally {
      await resumed.dispose();
    }
  });
}

function expectExplicitFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  expect(message.length).toBeGreaterThan(0);
  expect(message.toLowerCase()).not.toContain("timed out");
}

async function testStaleResume(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const token = `semantic-recovery-${createTestId()}`;
    const input = {
      nativeResumeRef: {
        kind: runtimeCase.nativeResumeKind,
        runtimeId: runtimeCase.runtime,
        value: "00000000-0000-4000-8000-000000000000",
      },
      paths,
      recoveryMessages: [
        {
          content: `Remember this exact recovery token: ${token}.`,
          role: "user" as const,
        },
        {
          content: `I will remember the exact recovery token ${token}.`,
          role: "assistant" as const,
        },
      ],
      runtimeCase,
      sessionId: createTestId(),
    };

    if (runtimeCase.suite === "openai") {
      const recovered = await startController(input);

      try {
        const events = await runTurn(
          recovered,
          "Reply with exactly the recovery token from the restored conversation.",
        );
        expect(eventText(events)).toContain(token);
        await stopController(recovered);
      } finally {
        await recovered.dispose();
      }
      return;
    }

    let controller: DriverArtifactTestController | null = null;

    try {
      try {
        controller = await startController(input);
      } catch (error) {
        expectExplicitFailure(error);
        return;
      }

      let turnFailure: unknown;

      try {
        await runTurn(controller, "Reply with exactly stale-resume-should-fail.");
      } catch (error) {
        turnFailure = error;
      }

      expect(turnFailure).toBeDefined();
      expectExplicitFailure(turnFailure);
      expect((await controller.waitForExit(LIVE_STOP_TIMEOUT_MS)).code).not.toBe(0);
    } finally {
      await controller?.dispose();
    }
  });
}

function isRunningTool(event: DriverArtifactTestEvent, runId: string): boolean {
  if (event.runId !== runId) {
    return false;
  }

  if (hasToolStatus(event, "running")) {
    return true;
  }

  const title = payloadRecord(event)["title"];
  return (
    event.kind === "item.started" &&
    typeof title === "string" &&
    /(bash|command|shell|terminal)/i.test(title)
  );
}

async function beginLongTurn(
  controller: DriverArtifactTestController,
): Promise<{ commandId: string; eventIndex: number; runId: string }> {
  const turn = enqueueTurn(
    controller,
    "Run `sh -c 'sleep 30; printf should-not-finish'` now. Do not use background execution. Reply only after it exits.",
  );
  await controller.waitForEvent(
    (event) => isRunningTool(event, turn.runId),
    turn.eventIndex,
    LIVE_TURN_TIMEOUT_MS,
    "running tool",
  );
  return turn;
}

async function testCancellation(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    await withController(runtimeCase, paths, async (controller) => {
      const active = await beginLongTurn(controller);
      const cancelId = `cancel-${createTestId()}`;
      controller.enqueue({ commandId: cancelId, kind: "turn.cancel", reason: "live.cancel" });
      const [inputUpdate, cancelUpdate, cancelledEvent] = await Promise.all([
        controller.waitForCommandTerminal(active.commandId, LIVE_TURN_TIMEOUT_MS),
        controller.waitForCommandTerminal(cancelId, LIVE_TURN_TIMEOUT_MS),
        controller.waitForEvent(
          (event) => event.runId === active.runId && event.kind === "run.cancelled",
          active.eventIndex,
          LIVE_TURN_TIMEOUT_MS,
          "cancelled run event",
        ),
      ]);

      expect(inputUpdate.status).toBe("cancelled");
      expect(cancelUpdate.status).toBe("completed");
      expect(cancelledEvent.kind).toBe("run.cancelled");
      expectSingleRunLifecycle(
        controller.eventsSince(active.eventIndex),
        active.runId,
        "run.cancelled",
      );
      const replayIndex = controller.commandUpdates.length;
      controller.enqueue({ commandId: cancelId, kind: "turn.cancel", reason: "live.cancel" });
      await controller.waitForCommandUpdate(
        (update) => update.commandId === cancelId && update.status === "accepted",
        replayIndex,
        LIVE_STOP_TIMEOUT_MS,
        "replayed cancel acceptance",
      );
      expect(
        controller.commandUpdates.filter(
          (update) =>
            update.commandId === cancelId &&
            (update.status === "cancelled" ||
              update.status === "completed" ||
              update.status === "failed"),
        ),
      ).toHaveLength(1);

      const idleCancelId = `cancel-${createTestId()}`;
      controller.enqueue({
        commandId: idleCancelId,
        kind: "turn.cancel",
        reason: "live.idle.cancel",
      });
      expect(
        (await controller.waitForCommandTerminal(idleCancelId, LIVE_STOP_TIMEOUT_MS)).status,
      ).toBe("completed");

      const events = await runTurn(
        controller,
        "Reply with exactly one lowercase word: pong. Do not call tools.",
      );
      expect(eventText(events).toLowerCase()).toContain("pong");
    });
  });
}

async function waitForPermissionRequest(
  controller: DriverArtifactTestController,
  eventIndex: number,
  label: string,
): Promise<string> {
  const event = await controller.waitForEvent(
    (candidate) => candidate.kind === "permission.requested",
    eventIndex,
    LIVE_TURN_TIMEOUT_MS,
    label,
  );
  const requestId = payloadRecord(event)["requestId"];
  expect(typeof requestId).toBe("string");
  expect((requestId as string).length).toBeGreaterThan(0);
  return requestId as string;
}

async function testSupervisedPermission(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const controller = await startController({
      paths,
      permissionPolicy: "supervised",
      runtimeCase,
      sessionId: createTestId(),
    });

    try {
      const cancelled = enqueueTurn(
        controller,
        "Use only the shell tool to run `sh -c 'sleep 30; printf should-not-finish'`. Explicitly request approval before executing it. Reply only after it exits.",
      );
      const cancelledRequestId = await waitForPermissionRequest(
        controller,
        cancelled.eventIndex,
        "permission request before cancellation",
      );
      const cancelId = `cancel-${createTestId()}`;
      controller.enqueue({
        commandId: cancelId,
        kind: "turn.cancel",
        reason: "live.permission.cancel",
      });
      const [inputUpdate, cancelUpdate, cancelledEvent, cancelledResolution] = await Promise.all([
        controller.waitForCommandTerminal(cancelled.commandId, LIVE_TURN_TIMEOUT_MS),
        controller.waitForCommandTerminal(cancelId, LIVE_TURN_TIMEOUT_MS),
        controller.waitForEvent(
          (event) => event.runId === cancelled.runId && event.kind === "run.cancelled",
          cancelled.eventIndex,
          LIVE_TURN_TIMEOUT_MS,
          "permission-pending run cancellation",
        ),
        controller.waitForEvent(
          (event) =>
            event.kind === "permission.resolved" &&
            payloadRecord(event)["requestId"] === cancelledRequestId,
          cancelled.eventIndex,
          LIVE_TURN_TIMEOUT_MS,
          "cancelled permission resolution",
        ),
      ]);
      expect(inputUpdate.status).toBe("cancelled");
      expect(cancelUpdate.status).toBe("completed");
      expect(cancelledEvent.kind).toBe("run.cancelled");
      expect(cancelledResolution.kind).toBe("permission.resolved");
      expectSingleRunLifecycle(
        controller.eventsSince(cancelled.eventIndex),
        cancelled.runId,
        "run.cancelled",
      );

      const allowed = enqueueTurn(
        controller,
        "Use only the shell tool to run `printf permission-ok > permission-result.txt`. Explicitly request approval before executing it. After it succeeds, reply with exactly permission-done.",
      );
      const allowedRequestId = await waitForPermissionRequest(
        controller,
        allowed.eventIndex,
        "permission request before approval",
      );
      const resolveId = `permission-${createTestId()}`;
      controller.enqueue({
        commandId: resolveId,
        decision: "allow_once",
        kind: "permission.resolve",
        requestId: allowedRequestId,
      });
      const [resolveUpdate, allowedUpdate, allowedResolution, completedEvent] = await Promise.all([
        controller.waitForCommandTerminal(resolveId, LIVE_TURN_TIMEOUT_MS),
        controller.waitForCommandTerminal(allowed.commandId, LIVE_TURN_TIMEOUT_MS),
        controller.waitForEvent(
          (event) =>
            event.kind === "permission.resolved" &&
            payloadRecord(event)["requestId"] === allowedRequestId,
          allowed.eventIndex,
          LIVE_TURN_TIMEOUT_MS,
          "approved permission resolution",
        ),
        controller.waitForEvent(
          (event) => event.runId === allowed.runId && event.kind === "run.completed",
          allowed.eventIndex,
          LIVE_TURN_TIMEOUT_MS,
          "approved run completion",
        ),
      ]);
      expect(resolveUpdate.status).toBe("completed");
      expect(allowedUpdate.status).toBe("completed");
      expect(allowedResolution.kind).toBe("permission.resolved");
      expect(completedEvent.kind).toBe("run.completed");
      expectSingleRunLifecycle(
        controller.eventsSince(allowed.eventIndex),
        allowed.runId,
        "run.completed",
      );
      expect(await readFile(join(paths.workspacePath, "permission-result.txt"), "utf8")).toBe(
        "permission-ok",
      );
      expect(eventText(controller.eventsSince(allowed.eventIndex)).toLowerCase()).toContain(
        "permission-done",
      );
      await stopController(controller);
    } finally {
      await controller.dispose();
    }
  });
}

async function testActiveStop(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const first = await startController({
      paths,
      runtimeCase,
      sessionId: createTestId(),
    });

    try {
      const active = await beginLongTurn(first);
      const inputTerminal = first.waitForCommandTerminal(active.commandId, LIVE_TURN_TIMEOUT_MS);
      const cancelledEvent = first.waitForEvent(
        (event) => event.runId === active.runId && event.kind === "run.cancelled",
        active.eventIndex,
        LIVE_TURN_TIMEOUT_MS,
        "stopped run cancellation",
      );
      await stopController(first);
      expect((await inputTerminal).status).toBe("cancelled");
      expect((await cancelledEvent).kind).toBe("run.cancelled");
      expectSingleRunLifecycle(first.eventsSince(active.eventIndex), active.runId, "run.cancelled");
    } finally {
      await first.dispose();
    }

    const restarted = await startController({
      paths,
      runtimeCase,
      sessionId: createTestId(),
    });

    try {
      const events = await runTurn(
        restarted,
        "Reply with exactly one lowercase word: pong. Do not call tools.",
      );
      expect(eventText(events).toLowerCase()).toContain("pong");
      await stopController(restarted);
    } finally {
      await restarted.dispose();
    }
  });
}

async function testSigterm(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const first = await startController({
      paths,
      runtimeCase,
      sessionId: createTestId(),
    });

    try {
      const active = await beginLongTurn(first);
      const inputTerminal = first.waitForCommandTerminal(active.commandId, LIVE_TURN_TIMEOUT_MS);
      const cancelledEvent = first.waitForEvent(
        (event) => event.runId === active.runId && event.kind === "run.cancelled",
        active.eventIndex,
        LIVE_TURN_TIMEOUT_MS,
        "SIGTERM run cancellation",
      );
      first.signalDriver("SIGTERM");
      expect((await inputTerminal).status).toBe("cancelled");
      expect((await cancelledEvent).kind).toBe("run.cancelled");
      expectSingleRunLifecycle(first.eventsSince(active.eventIndex), active.runId, "run.cancelled");
      expect(await first.waitForExit(LIVE_STOP_TIMEOUT_MS)).toMatchObject({
        code: 0,
        signal: null,
      });
    } finally {
      await first.dispose();
    }

    const restarted = await startController({
      paths,
      runtimeCase,
      sessionId: createTestId(),
    });

    try {
      const events = await runTurn(
        restarted,
        "Reply with exactly one lowercase word: pong. Do not call tools.",
      );
      expect(eventText(events).toLowerCase()).toContain("pong");
      await stopController(restarted);
    } finally {
      await restarted.dispose();
    }
  });
}

async function testChangedCommandReplay(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const controller = await startController({
      paths,
      runtimeCase,
      sessionId: createTestId(),
    });

    try {
      const commandId = `cancel-${createTestId()}`;
      controller.enqueue({ commandId, kind: "turn.cancel", reason: "first reason" });
      expect(
        (await controller.waitForCommandTerminal(commandId, LIVE_STOP_TIMEOUT_MS)).status,
      ).toBe("completed");
      controller.enqueue({ commandId, kind: "turn.cancel", reason: "changed reason" });
      const terminal = await controller.waitForRunTerminal(LIVE_STOP_TIMEOUT_MS);
      expect(terminal.status).toBe("failed");
      expect(JSON.stringify(terminal.error)).toContain("replayed with changed identity or content");
      expect((await controller.waitForExit(LIVE_STOP_TIMEOUT_MS)).code).toBe(1);
    } finally {
      await controller.dispose();
    }
  });
}

async function testHeartbeatFailure(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const controller = await startController({
      heartbeatIntervalMs: 250,
      paths,
      runtimeCase,
      sessionId: createTestId(),
    });

    try {
      controller.failHeartbeats();
      expect((await controller.waitForRunTerminal(LIVE_STOP_TIMEOUT_MS)).status).toBe("failed");
      expect((await controller.waitForExit(LIVE_STOP_TIMEOUT_MS)).code).toBe(1);
    } finally {
      await controller.dispose();
    }
  });
}

async function testControlDisconnect(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const controller = await startController({
      paths,
      runtimeCase,
      sessionId: createTestId(),
    });

    try {
      await beginLongTurn(controller);
      controller.disconnectDriver();
      expect(await controller.waitForExit(LIVE_STOP_TIMEOUT_MS)).toMatchObject({
        code: 0,
        signal: null,
      });
    } finally {
      await controller.dispose();
    }
  });
}

const compatibilityScenarios = [
  ["sequential turns", testStartup],
  ["workspace boundary operations", testWorkspace],
  ["failed command recovery", testCommandRecovery],
] as const;
const lifecycleScenarios = [
  ["native process resume", testResume],
  ["process crash and native resume", testCrashResume],
  ["stale native resume", testStaleResume],
  ["active, replayed, and idle cancellation", testCancellation],
  ["supervised permission cancellation and approval", testSupervisedPermission],
  ["active stop and restart", testActiveStop],
  ["SIGTERM and restart", testSigterm],
] as const;
const controlScenarios = [
  ["changed command replay fails closed", testChangedCommandReplay],
  ["heartbeat failure", testHeartbeatFailure],
  ["active control disconnect", testControlDisconnect],
] as const;

describe("packed driver live matrix", () => {
  for (const runtimeCase of runtimeCases) {
    for (const [scenario, run] of compatibilityScenarios) {
      liveTest(
        `compatibility ${runtimeCase.suite} ${runtimeCase.model} × ${scenario}`,
        () => run(runtimeCase),
        LIVE_TEST_TIMEOUT_MS,
      );
    }
  }

  for (const runtimeCase of lifecycleCases) {
    for (const [scenario, run] of lifecycleScenarios) {
      liveTest(
        `lifecycle ${runtimeCase.suite} ${runtimeCase.model} × ${scenario}`,
        () => run(runtimeCase),
        LIVE_TEST_TIMEOUT_MS,
      );
    }
  }

  for (const [scenario, run] of controlScenarios) {
    liveTest(
      `control ${controlCase.suite} ${controlCase.model} × ${scenario}`,
      () => run(controlCase),
      LIVE_TEST_TIMEOUT_MS,
    );
  }
});
