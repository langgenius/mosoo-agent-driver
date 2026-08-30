import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { DRIVER_PROTOCOL_VERSION } from "../src/protocol/boot";
import {
  DriverArtifactTestController,
  expectedDriverCapabilities,
  type DriverArtifactBootPayload,
  type DriverArtifactTestEvent,
} from "./driver-artifact-test-controller";

const LIVE_START_TIMEOUT_MS = 120_000;
const LIVE_TURN_TIMEOUT_MS = 180_000;
const LIVE_STOP_TIMEOUT_MS = 15_000;
const LIVE_EVENT_QUIET_MS = 250;
const LIVE_CRASH_CLEANUP_TIMEOUT_MS = 3_000;
const LIVE_BOUNDARY_ENV = "MOSOO_LIVE_BOUNDARY_ID";
const LIVE_TEST_TIMEOUT_MS =
  4 * LIVE_START_TIMEOUT_MS + 3 * LIVE_TURN_TIMEOUT_MS + 3 * LIVE_STOP_TIMEOUT_MS;
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
const DEFAULT_OPENAI_MODEL = "openai/gpt-5.6-luna";
const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-sonnet-5";
const STALE_RESUME_POINTER = "00000000-0000-4000-8000-000000000000";
const DEFAULT_OPENCODE_MODELS = [
  "openrouter/moonshotai/kimi-k3",
  "openrouter/deepseek/deepseek-v4-flash",
  "openrouter/z-ai/glm-5.2",
  "openrouter/qwen/qwen3.6-35b-a3b",
] as const;
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
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
  readonly openAiCommand: string;
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

interface LiveMcpServer {
  readonly authType: "bearer";
  readonly authorizationState: "active";
  readonly credentialId: string;
  readonly credentialScope: "session";
  readonly credentialStatus: "active";
  readonly name: string;
  readonly proxyGrantId: string;
  readonly proxyUrl: string;
  readonly serverId: string;
}

interface ActiveLongTurn {
  readonly commandId: string;
  readonly eventIndex: number;
  readonly finishedPath: string;
  readonly runId: string;
  readonly shellPidPath: string;
  readonly startedPath: string;
  readonly workerPidPath: string;
}

interface RunLifecycleExpectations {
  readonly requireFinalMessage?: boolean;
  readonly requireUsage?: LiveRuntimeCase["runtime"];
}

interface ProcessBoundaryObservation {
  readonly read: () => readonly number[] | null;
  readonly stop: () => void;
}

interface RunningLinuxProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
}

type ProcessIdSource = readonly number[] | (() => readonly number[]);

interface StartBoundaryObservation {
  readonly live: readonly number[];
  readonly shellFileExists: boolean;
  readonly shellPid: number | null;
  readonly started: boolean;
  readonly workerFileExists: boolean;
  readonly workerPid: number | null;
}

const EXPECTED_USAGE_METADATA = {
  "acp-fallback": {
    sources: ["prompt_response", "session_update"],
    usageContract: "anthropic_bucketed",
  },
  "claude-agent-sdk": {
    sources: ["session_update"],
    usageContract: "anthropic_bucketed",
  },
  "openai-runtime": {
    sources: ["session_update"],
    usageContract: "openai_runtime_total_with_cached_breakdown",
  },
} as const satisfies Record<
  LiveRuntimeCase["runtime"],
  { readonly sources: readonly string[]; readonly usageContract: string }
>;

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

function assertCommandVersion(
  command: string,
  args: readonly string[],
  packagePath: string,
  label: string,
): void {
  const packageVersion = (
    JSON.parse(readFileSync(packagePath, "utf8")) as { readonly version?: unknown }
  ).version;

  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error(`${label} package has no version: ${packagePath}.`);
  }

  const result = spawnSync(command, args, { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(`${label} command is unavailable: ${command}.`);
  }

  const reportedVersions = `${result.stdout}\n${result.stderr}`.split(/\s+/);

  if (!reportedVersions.includes(packageVersion)) {
    throw new Error(
      `${label} command version does not match package ${packageVersion}: ${command}.`,
    );
  }
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

  const openAiCommand =
    readEnv("MOSOO_OPENAI_RUNTIME_EXECUTABLE") ??
    resolve(process.cwd(), "node_modules", ".bin", "codex");
  const openCodeCommand =
    readEnv("AGENT_DRIVER_LIVE_OPENCODE_COMMAND") ??
    resolve(process.cwd(), "node_modules", ".bin", "opencode");

  if (suite === "all" || suite === "opencode") {
    assertCommandVersion(
      openCodeCommand,
      ["--version"],
      resolve(process.cwd(), "node_modules", "opencode-ai", "package.json"),
      "OpenCode",
    );
    if (spawnSync(openCodeCommand, ["acp", "--help"], { stdio: "ignore" }).status !== 0) {
      throw new Error(`OpenCode ACP command is unavailable: ${openCodeCommand}.`);
    }
  }

  if (suite === "all" || suite === "openai") {
    assertCommandVersion(
      openAiCommand,
      ["--version"],
      resolve(process.cwd(), "node_modules", "@openai", "codex", "package.json"),
      "OpenAI app-server",
    );
  }

  return {
    anthropicBaseUrl: readUrl(
      "AGENT_DRIVER_LIVE_OPENROUTER_ANTHROPIC_BASE_URL",
      DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL,
    ),
    anthropicModel: readEnv("AGENT_DRIVER_LIVE_ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL,
    artifactPath,
    key,
    openAiCommand,
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
      openAiCommand: resolve(process.cwd(), "node_modules", ".bin", "codex"),
      openAiModel: DEFAULT_OPENAI_MODEL,
      openAiReasoningEffort: "medium",
      openCodeCommand: resolve(process.cwd(), "node_modules", ".bin", "opencode"),
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
  ...config.openCodeModels.map((model): LiveRuntimeCase => ({
    model,
    nativeResumeKind: "acp_session_id",
    provider: "openrouter",
    runtime: "acp-fallback",
    suite: "opencode",
    transport: "acp-fallback",
  })),
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

function messageText(events: readonly DriverArtifactTestEvent[], messageId: string): string {
  let text = "";

  for (const event of events) {
    const payload = payloadRecord(event);
    if (payload["messageId"] !== messageId) {
      continue;
    }

    if (event.kind === "message.delta" && typeof payload["contentDelta"] === "string") {
      text += payload["contentDelta"];
      continue;
    }

    if (event.kind !== "message.added") {
      continue;
    }

    const content = payload["content"];
    text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((block) => {
                const value =
                  typeof block === "object" && block !== null && !Array.isArray(block)
                    ? (block as Record<string, unknown>)["text"]
                    : null;
                return typeof value === "string" ? [value] : [];
              })
              .join("")
          : text;
  }

  return text;
}

function eventText(events: readonly DriverArtifactTestEvent[]): string {
  const finalMessageId = events
    .filter((event) => event.kind === "run.completed")
    .map((event) => payloadRecord(event)["finalMessageId"])
    .findLast((value): value is string => typeof value === "string" && value.length > 0);

  if (finalMessageId !== undefined) {
    return messageText(events, finalMessageId);
  }

  const messageIds = new Set(
    events.flatMap((event) => {
      if (event.kind !== "message.added" && event.kind !== "message.delta") {
        return [];
      }
      const messageId = payloadRecord(event)["messageId"];
      return typeof messageId === "string" ? [messageId] : [];
    }),
  );
  return [...messageIds].map((messageId) => messageText(events, messageId)).join("");
}

function eventOutputText(events: readonly DriverArtifactTestEvent[]): string {
  return events
    .flatMap((event) => {
      const payload = payloadRecord(event);

      if (event.kind === "terminal.output.delta" && typeof payload["data"] === "string") {
        return [payload["data"]];
      }

      if (event.kind === "tool.call.updated") {
        return [payload["content"], payload["rawOutput"]].filter(
          (value): value is string => typeof value === "string",
        );
      }

      return [];
    })
    .join("\n");
}

function hasToolStatus(event: DriverArtifactTestEvent, status: string): boolean {
  return event.kind === "tool.call.updated" && payloadRecord(event)["status"] === status;
}

function hasFailedCommandProjection(event: DriverArtifactTestEvent): boolean {
  const payload = payloadRecord(event);

  if (
    (event.kind === "tool.call.updated" || event.kind === "item.completed") &&
    payload["status"] === "failed"
  ) {
    return true;
  }

  return (
    event.kind === "terminal.exited" &&
    typeof payload["exitCode"] === "number" &&
    payload["exitCode"] !== 0
  );
}

function payloadString(event: DriverArtifactTestEvent, field: string): string | null {
  const value = payloadRecord(event)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRunProjection(event: DriverArtifactTestEvent): boolean {
  return (
    event.kind === "diagnostic.reported" ||
    event.kind === "plan.updated" ||
    event.kind === "usage.updated" ||
    /^(file\.|item\.|message\.|permission\.|terminal\.|thought\.|tool\.call\.)/.test(event.kind)
  );
}

function requiresRunCorrelation(event: DriverArtifactTestEvent): boolean {
  return event.kind !== "diagnostic.reported" && isRunProjection(event);
}

function isPromptInputProjection(event: DriverArtifactTestEvent): boolean {
  return (
    event.kind === "message.added" &&
    event.actor === "user" &&
    event.origin === "viewer" &&
    payloadRecord(event)["role"] === "user"
  );
}

function expectPairedLifecycle(
  events: readonly DriverArtifactTestEvent[],
  startedKind: "item.started" | "message.started" | "thought.started",
  completedKind: "item.completed" | "message.completed" | "thought.completed",
  idField: "itemId" | "messageId" | "thoughtId",
  runTerminalIndex: number,
): void {
  for (const event of events.filter(
    (candidate) => candidate.kind === startedKind || candidate.kind === completedKind,
  )) {
    expect(payloadString(event, idField)).not.toBeNull();
  }

  const ids = new Set(
    events
      .filter((event) => event.kind === startedKind || event.kind === completedKind)
      .map((event) => payloadString(event, idField))
      .filter((id): id is string => id !== null),
  );

  for (const id of ids) {
    const started = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.kind === startedKind && payloadString(event, idField) === id);
    const completed = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.kind === completedKind && payloadString(event, idField) === id);

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(started[0]!.index).toBeLessThan(completed[0]!.index);
    expect(completed[0]!.index).toBeLessThan(runTerminalIndex);
  }
}

function expectSingleRunLifecycle(
  events: readonly DriverArtifactTestEvent[],
  runId: string,
  terminalKind: "run.cancelled" | "run.completed" | "run.failed",
  expectations: RunLifecycleExpectations = {},
): void {
  expect(
    events
      .filter((event) => requiresRunCorrelation(event) && event.runId !== runId)
      .map((event) => ({ kind: event.kind, runId: event.runId ?? null })),
  ).toEqual([]);
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
  const startedIndex = runEvents.findIndex((event) => event.kind === "run.started");
  const terminalIndex = runEvents.indexOf(terminalEvents[0]!);
  expect(startedIndex).toBeLessThan(terminalIndex);

  for (const [index, event] of runEvents.entries()) {
    if (isRunProjection(event)) {
      if (!isPromptInputProjection(event)) {
        expect(startedIndex).toBeLessThan(index);
      }
      expect(index).toBeLessThan(terminalIndex);
    }
  }

  expectPairedLifecycle(
    runEvents,
    "message.started",
    "message.completed",
    "messageId",
    terminalIndex,
  );
  expectPairedLifecycle(runEvents, "item.started", "item.completed", "itemId", terminalIndex);
  expectPairedLifecycle(
    runEvents,
    "thought.started",
    "thought.completed",
    "thoughtId",
    terminalIndex,
  );

  for (const [index, event] of runEvents.entries()) {
    if (event.kind !== "message.delta" && event.kind !== "message.added") {
      continue;
    }
    if (event.kind === "message.added" && payloadRecord(event)["role"] !== "agent") {
      continue;
    }

    const messageId = payloadString(event, "messageId");
    expect(messageId).not.toBeNull();
    if (messageId === null) {
      continue;
    }

    const messageStartedIndex = runEvents.findIndex(
      (candidate) =>
        candidate.kind === "message.started" && payloadString(candidate, "messageId") === messageId,
    );
    const messageCompletedIndex = runEvents.findIndex(
      (candidate) =>
        candidate.kind === "message.completed" &&
        payloadString(candidate, "messageId") === messageId,
    );
    expect(messageStartedIndex).toBeGreaterThanOrEqual(0);
    expect(messageCompletedIndex).toBeGreaterThanOrEqual(0);
    expect(messageStartedIndex).toBeLessThan(index);
    expect(index).toBeLessThan(messageCompletedIndex);
  }

  for (const [index, event] of runEvents.entries()) {
    if (event.kind !== "thought.delta") {
      continue;
    }

    const thoughtId = payloadString(event, "thoughtId");
    expect(thoughtId).not.toBeNull();
    if (thoughtId === null) {
      continue;
    }
    const thoughtStartedIndex = runEvents.findIndex(
      (candidate) =>
        candidate.kind === "thought.started" && payloadString(candidate, "thoughtId") === thoughtId,
    );
    const thoughtCompletedIndex = runEvents.findIndex(
      (candidate) =>
        candidate.kind === "thought.completed" &&
        payloadString(candidate, "thoughtId") === thoughtId,
    );
    expect(thoughtStartedIndex).toBeGreaterThanOrEqual(0);
    expect(thoughtCompletedIndex).toBeGreaterThanOrEqual(0);
    expect(thoughtStartedIndex).toBeLessThan(index);
    expect(index).toBeLessThan(thoughtCompletedIndex);
  }

  const toolEvents = runEvents.filter((event) => event.kind === "tool.call.updated");
  for (const event of toolEvents) {
    expect(payloadString(event, "toolCallId")).not.toBeNull();
    expect(["completed", "failed", "running"]).toContain(String(payloadRecord(event)["status"]));
  }

  for (const toolCallId of new Set(
    toolEvents
      .map((event) => payloadString(event, "toolCallId"))
      .filter((id): id is string => id !== null),
  )) {
    const updates = runEvents
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.kind === "tool.call.updated" && payloadString(event, "toolCallId") === toolCallId,
      );
    const terminalUpdates = updates.filter(
      ({ event }) => payloadRecord(event)["status"] !== "running",
    );

    expect(updates.some(({ event }) => payloadRecord(event)["status"] === "running")).toBe(true);
    expect(terminalUpdates).toHaveLength(1);
    expect(
      updates.every(
        ({ event, index }) =>
          payloadRecord(event)["status"] !== "running" || index < terminalUpdates[0]!.index,
      ),
    ).toBe(true);
  }

  const usageEvents = runEvents.filter((candidate) => candidate.kind === "usage.updated");
  if (expectations.requireUsage) {
    expect(usageEvents.length).toBeGreaterThan(0);
  }

  const numericUsageValues: number[] = [];
  for (const event of usageEvents) {
    const usage = payloadRecord(event);
    const source = payloadString(event, "source");
    const usageContract = payloadString(event, "usageContract");
    expect(source).not.toBeNull();
    expect(usageContract).not.toBeNull();

    if (expectations.requireUsage) {
      const expected = EXPECTED_USAGE_METADATA[expectations.requireUsage];
      expect(expected.sources.some((candidate) => candidate === source)).toBe(true);
      expect(usageContract).toBe(expected.usageContract);
    }

    for (const field of [
      "cachedReadTokens",
      "cachedWriteTokens",
      "costAmount",
      "inputTokens",
      "outputTokens",
      "size",
      "thoughtTokens",
      "totalTokens",
      "used",
    ]) {
      const value = usage[field];

      if (value !== null && value !== undefined) {
        expect(typeof value).toBe("number");
        expect(Number.isFinite(value as number)).toBe(true);
        expect(value as number).toBeGreaterThanOrEqual(0);
        numericUsageValues.push(value as number);
      }
    }
  }
  if (expectations.requireUsage) {
    expect(numericUsageValues.length).toBeGreaterThan(0);
    expect(numericUsageValues.some((value) => value > 0)).toBe(true);
  }

  if (expectations.requireFinalMessage) {
    const terminal = terminalEvents[0]!;
    const finalMessageId = payloadString(terminal, "finalMessageId");
    expect(finalMessageId).not.toBeNull();
    expect(payloadRecord(terminal)).not.toHaveProperty("finalMessageText");
    expect(
      runEvents.some(
        (event) =>
          event.kind === "message.completed" &&
          payloadString(event, "messageId") === finalMessageId,
      ),
    ).toBe(true);
    const reconstructedFinalMessageText = messageText(runEvents, finalMessageId!);
    expect(reconstructedFinalMessageText.length).toBeGreaterThan(0);
  }
}

async function expectQuiescentRunLifecycle(
  controller: DriverArtifactTestController,
  eventIndex: number,
  runId: string,
  terminalKind: "run.cancelled" | "run.completed" | "run.failed",
  expectations: RunLifecycleExpectations = {},
): Promise<void> {
  await Bun.sleep(LIVE_EVENT_QUIET_MS);
  expectSingleRunLifecycle(controller.eventsSince(eventIndex), runId, terminalKind, expectations);
}

function readResumePointer(events: readonly DriverArtifactTestEvent[]): string | null {
  const resumeIndex = events.findIndex((candidate) => candidate.kind === "runtime.resume.updated");
  if (resumeIndex < 0) {
    return null;
  }
  const firstCompletedIndex = events.findIndex((candidate) => candidate.kind === "run.completed");
  expect(firstCompletedIndex).toBeGreaterThanOrEqual(0);
  expect(resumeIndex).toBeLessThan(firstCompletedIndex);
  const event = events[resumeIndex]!;
  const pointer = event === undefined ? undefined : payloadRecord(event)["resumePointer"];
  return typeof pointer === "string" && pointer.length > 0 ? pointer : null;
}

function expectNoHistoricalRunProjections(
  controller: DriverArtifactTestController,
  runId: string,
): void {
  const runStartedIndex = controller.events.findIndex(
    (event) => event.kind === "run.started" && event.runId === runId,
  );
  expect(runStartedIndex).toBeGreaterThanOrEqual(0);
  expect(
    controller.events
      .slice(0, runStartedIndex)
      .filter((event) => isRunProjection(event) && !isPromptInputProjection(event)),
  ).toEqual([]);
}

function createOpenCodeConfig(model: string): string {
  const slug = model.slice("openrouter/".length);
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["openrouter"],
    model,
    permission: {
      "*": "ask",
    },
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
  readonly mcpServers?: readonly LiveMcpServer[] | undefined;
  readonly nativeResumeRef: NativeResumeRef | null;
  readonly paths: LivePaths;
  readonly permissionPolicy?: "full_access" | "supervised" | undefined;
  readonly recoveryMessages?: readonly RecoveryMessage[] | undefined;
  readonly runtimeCase: LiveRuntimeCase;
  readonly sessionId: string;
}): DriverArtifactBootPayload {
  const runtimeCase = input.runtimeCase;
  const sandboxId = createTestId();

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
          sandboxId,
          sandboxKind: "cattle",
          sandboxSessionId: createTestId(),
          sandboxSubjectId: input.sessionId,
          sandboxSubjectKind: "session",
          sessionOrganizationPath: input.paths.workspacePath,
        },
        cwd: input.paths.workspacePath,
        mcpServers: input.mcpServers ?? [],
        nativeResumeRef: input.nativeResumeRef,
        recoveryMessages: input.recoveryMessages ?? [],
      },
      skillCatalog: [],
      skills: [],
    },
    heartbeatIntervalMs: 60_000,
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    runtime: runtimeCase.runtime,
    runtimeTransport: runtimeCase.transport,
    sandboxId,
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
  readonly mcpServers?: readonly LiveMcpServer[] | undefined;
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
      mcpServers: input.mcpServers,
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
        : {
            ...(input.runtimeCase.suite === "openai"
              ? { MOSOO_OPENAI_RUNTIME_EXECUTABLE: config.openAiCommand }
              : {}),
            OPENAI_API_KEY: "",
            OPENROUTER_API_KEY: "",
          },
    expectedCapabilities: expectedDriverCapabilities(input.runtimeCase.runtime),
    organizationPath: input.paths.workspacePath,
    rootPath: input.paths.rootPath,
    forbiddenSecrets: [
      config.key,
      ...(input.mcpServers ?? []).map((server) => server.proxyGrantId),
    ],
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    startTimeoutMs: LIVE_START_TIMEOUT_MS,
  });
  try {
    await assertConfiguredModel(controller, input.runtimeCase);
    return controller;
  } catch (error) {
    await controller.dispose();
    throw error;
  }
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
  expectations: RunLifecycleExpectations = {},
): Promise<DriverArtifactTestEvent[]> {
  const commandId = `input-${createTestId()}`;
  const runId = createTestId();
  const eventIndex = controller.events.length;
  const updateIndex = controller.commandUpdates.length;
  await controller.runTurn({
    commandId,
    requestId: `request-${createTestId()}`,
    runId,
    text,
    timeoutMs: LIVE_TURN_TIMEOUT_MS,
  });
  await Bun.sleep(LIVE_EVENT_QUIET_MS);
  const events = controller.eventsSince(eventIndex);
  const updates = controller.commandUpdates
    .slice(updateIndex)
    .filter((update) => update.commandId === commandId);

  expectSingleRunLifecycle(events, runId, "run.completed", {
    requireFinalMessage: true,
    ...expectations,
  });
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
      const contextValue = "violet origami crane";
      const firstEvents = await runTurn(
        controller,
        `The fictional café in this conversation is named "${contextValue}". Reply with exactly context-stored. Do not call tools.`,
        { requireUsage: runtimeCase.runtime },
      );
      const secondEvents = await runTurn(
        controller,
        "What was the fictional café name in my previous message? Reply with only that name. Do not call tools.",
      );
      const compatibilityEvents = [...firstEvents, ...secondEvents];

      expect(eventText(firstEvents).toLowerCase()).toContain("context-stored");
      expect(eventText(secondEvents).toLowerCase()).toContain(contextValue);
      expect(startedRunId(firstEvents)).not.toBe(startedRunId(secondEvents));
      expect(
        compatibilityEvents.some(
          (event) =>
            event.kind === "message.delta" &&
            typeof payloadRecord(event)["contentDelta"] === "string" &&
            String(payloadRecord(event)["contentDelta"]).length > 0,
        ),
      ).toBe(true);
      expect(compatibilityEvents.some((event) => event.kind === "usage.updated")).toBe(true);
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
      expect(events.some((event) => event.kind === "permission.requested")).toBe(false);
      expect(eventText(events).toLowerCase()).toContain("workspace-done");
    });
  });
}

async function testCommandRecovery(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const failureScriptName = `command-failure-${createTestId()}.sh`;
    await writeFile(
      join(paths.workspacePath, failureScriptName),
      "printf live-stdout\nprintf live-stderr >&2\nexit 7\n",
      "utf8",
    );

    await withController(runtimeCase, paths, async (controller) => {
      const recoveryPath = join(paths.workspacePath, "command-recovered.txt");
      const events = await runTurn(
        controller,
        `Make exactly two separate shell tool calls in order. First run exactly \`exec sh ${failureScriptName}\` and wait for its exit-7 failure result. Then run exactly \`printf live-recovered > command-recovered.txt\` in a new shell tool call. Never combine the commands. Reply with exactly recovered.`,
      );
      const output = eventOutputText(events);

      expect(events.some(hasFailedCommandProjection)).toBe(true);
      expect(events.some((event) => hasToolStatus(event, "completed"))).toBe(true);
      expect(output).toContain("live-stdout");
      expect(output).toContain("live-stderr");
      expect(await readFile(recoveryPath, "utf8")).toBe("live-recovered");
      expect(eventText(events).toLowerCase()).toContain("recovered");
    });
  });
}

async function testNativeMcp(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const grant = `native-mcp-grant-${createTestId()}`;
    const marker = `mcp-${randomUUID().slice(0, 8)}`;
    const proof = `native-mcp-proof-${randomUUID()}`;
    const authorizationHeaders: (string | null)[] = [];
    const methods: string[] = [];
    const protocolVersions: string[] = [];
    const toolCalls: { readonly arguments: unknown; readonly name: unknown }[] = [];
    let protocolViolations = 0;
    let sideEffects = 0;
    let unauthorizedRequests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname !== "/mcp") {
          protocolViolations += 1;
          return new Response("Not Found", { status: 404 });
        }
        const authorization = request.headers.get("authorization");
        authorizationHeaders.push(authorization);

        if (authorization !== `Bearer ${grant}`) {
          unauthorizedRequests += 1;
          return new Response("Unauthorized", { status: 401 });
        }
        if (request.method === "GET" || request.method === "DELETE") {
          return new Response(null, { status: 405 });
        }
        if (request.method !== "POST") {
          return new Response(null, { status: 405 });
        }

        const message = (await request.json()) as {
          readonly id?: unknown;
          readonly jsonrpc?: unknown;
          readonly method?: unknown;
          readonly params?: {
            readonly arguments?: Record<string, unknown>;
            readonly name?: string;
            readonly protocolVersion?: string;
          };
        };
        if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
          protocolViolations += 1;
          return Response.json(
            {
              error: { code: -32600, message: "Invalid JSON-RPC request." },
              id: message.id ?? null,
              jsonrpc: "2.0",
            },
            { status: 400 },
          );
        }
        methods.push(message.method);

        if (message.id === undefined) {
          return new Response(null, { status: 202 });
        }
        if (message.method === "initialize") {
          const protocolVersion = message.params?.protocolVersion;
          if (
            typeof protocolVersion !== "string" ||
            !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(protocolVersion)
          ) {
            protocolViolations += 1;
            return Response.json(
              {
                error: { code: -32602, message: "Unsupported MCP protocol version." },
                id: message.id,
                jsonrpc: "2.0",
              },
              { status: 400 },
            );
          }
          protocolVersions.push(protocolVersion);
          return Response.json({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion,
              serverInfo: { name: "driver-live-mcp", version: "1" },
            },
          });
        }
        if (message.method === "ping") {
          return Response.json({ id: message.id, jsonrpc: "2.0", result: {} });
        }
        if (message.method === "tools/list") {
          return Response.json({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              tools: [
                {
                  description:
                    "Record the exact marker supplied by the user and return a server-generated proof.",
                  inputSchema: {
                    additionalProperties: false,
                    properties: { marker: { type: "string" } },
                    required: ["marker"],
                    type: "object",
                  },
                  name: "record_marker",
                },
              ],
            },
          });
        }
        if (message.method === "tools/call") {
          const argumentsValue = message.params?.arguments;
          toolCalls.push({
            arguments: argumentsValue,
            name: message.params?.name,
          });
          const exactCall =
            message.params?.name === "record_marker" &&
            argumentsValue?.["marker"] === marker &&
            Object.keys(argumentsValue).length === 1;

          if (exactCall) {
            sideEffects += 1;
          }

          return Response.json({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              content: [
                {
                  text: exactCall ? proof : "invalid marker call",
                  type: "text",
                },
              ],
              isError: !exactCall,
            },
          });
        }

        return Response.json({
          error: { code: -32601, message: `Unknown method: ${message.method}` },
          id: message.id,
          jsonrpc: "2.0",
        });
      },
    });
    let controller: DriverArtifactTestController | null = null;

    try {
      controller = await startController({
        mcpServers: [
          {
            authType: "bearer",
            authorizationState: "active",
            credentialId: createTestId(),
            credentialScope: "session",
            credentialStatus: "active",
            name: "live_marker",
            proxyGrantId: grant,
            proxyUrl: `http://${server.hostname}:${server.port}/mcp`,
            serverId: createTestId(),
          },
        ],
        paths,
        runtimeCase,
        sessionId: createTestId(),
      });
      const events = await runTurn(
        controller,
        `Call the record_marker tool from the live_marker MCP server exactly once with exactly ${JSON.stringify({ marker })}. Do not use any other tool. Reply with only the text returned by that tool.`,
      );
      await stopController(controller);

      let previousMethodIndex = -1;
      for (const method of [
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
      ]) {
        const methodIndex = methods.indexOf(method, previousMethodIndex + 1);
        expect(methodIndex).toBeGreaterThan(previousMethodIndex);
        previousMethodIndex = methodIndex;
      }

      expect(unauthorizedRequests).toBe(0);
      expect(protocolViolations).toBe(0);
      expect(protocolVersions.length).toBeGreaterThan(0);
      expect(
        protocolVersions.every((version) => SUPPORTED_MCP_PROTOCOL_VERSIONS.has(version)),
      ).toBe(true);
      expect(authorizationHeaders.length).toBeGreaterThan(0);
      expect(authorizationHeaders.every((value) => value === `Bearer ${grant}`)).toBe(true);
      expect(toolCalls).toEqual([
        {
          arguments: { marker },
          name: "record_marker",
        },
      ]);
      expect(sideEffects).toBe(1);
      expect(
        events.filter((event) => {
          const payload = payloadRecord(event);
          return (
            event.kind === "tool.call.updated" &&
            payload["status"] === "completed" &&
            [payload["content"], payload["rawOutput"]].some(
              (value) => typeof value === "string" && value.includes(proof),
            )
          );
        }),
      ).toHaveLength(1);
      expect(eventText(events)).toContain(proof);
    } finally {
      await controller?.dispose();
      await server.stop(true);
    }
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
      const resumedRunId = startedRunId(events);
      expectNoHistoricalRunProjections(resumed, resumedRunId);

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
    let active!: ActiveLongTurn;
    let resumePointer: string;

    try {
      await runTurn(
        first,
        `Remember this exact token across a process crash: ${token}. Reply with exactly stored.`,
      );
      const pointer = readResumePointer(first.events);
      expect(pointer).not.toBeNull();
      resumePointer = pointer!;
      active = await beginLongTurn(first, paths);
      const childProcessIds = first.directChildProcessIds();
      const providerOwnerIds = first.providerOwnerIds();
      expect(childProcessIds.length).toBeGreaterThan(0);
      expect(providerOwnerIds.length).toBeGreaterThan(0);
      first.crashDriver();
      expect(await first.waitForExit(LIVE_STOP_TIMEOUT_MS)).toMatchObject({
        code: null,
        signal: "SIGKILL",
      });
      await Promise.all([
        expectInterruptedToolAfterCrash(active),
        ...childProcessIds.map((pid) =>
          expectProcessExited(
            pid,
            `Crashed driver child process ${pid}`,
            LIVE_CRASH_CLEANUP_TIMEOUT_MS,
          ),
        ),
        expectProviderTreesExited(
          first,
          providerOwnerIds,
          "Crashed provider process tree",
          LIVE_CRASH_CLEANUP_TIMEOUT_MS,
        ),
      ]);
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
      expectNoHistoricalRunProjections(resumed, startedRunId(events));
      expect(eventText(events)).toContain(token);
      await stopController(resumed);
      expectToolStartedOnce(active);
    } finally {
      await resumed.dispose();
    }
  });
}

async function testProviderCrashResume(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const sessionId = createTestId();
    const token = `provider-crash-resume-${createTestId()}`;
    const first = await startController({ paths, runtimeCase, sessionId });
    let active!: ActiveLongTurn;
    let resumePointer: string;

    try {
      await runTurn(
        first,
        `Remember this exact token across a provider crash: ${token}. Reply with exactly stored. Do not call tools.`,
      );
      const pointer = readResumePointer(first.events);
      expect(pointer).not.toBeNull();
      resumePointer = pointer!;

      const idleOwnerIds = first.providerOwnerIds();
      const idleRoots = ownedDirectProcessIdentities(first, idleOwnerIds);
      active = await beginLongTurn(first, paths);
      const ownerIds = [...new Set([...idleOwnerIds, ...first.providerOwnerIds()])];
      expect(ownerIds.length).toBeGreaterThan(0);
      const toolProcessIds = await readInterruptedToolPids(active);
      const activeRoots = ownedDirectProcessIdentities(first, ownerIds);
      const persistentRoots = activeRoots.filter((activeRoot) =>
        idleRoots.some((idleRoot) => sameProcessIdentity(activeRoot, idleRoot)),
      );
      const crashTargets = persistentRoots.length > 0 ? persistentRoots : activeRoots;
      expect(crashTargets).toHaveLength(1);

      const toolBoundary = observeEventProcessBoundary(
        first,
        toolProcessIds,
        (event) =>
          event.runId === active.runId &&
          (event.kind === "run.cancelled" ||
            event.kind === "run.completed" ||
            event.kind === "run.failed"),
      );
      const providerRunBoundary = observeEventProcessBoundary(
        first,
        () => first.providerProcessIdsForOwners(ownerIds),
        (event) =>
          event.runId === active.runId &&
          (event.kind === "run.cancelled" ||
            event.kind === "run.completed" ||
            event.kind === "run.failed"),
      );
      const providerControlBoundary = observeRunTerminalProcessBoundary(first, () =>
        first.providerProcessIdsForOwners(ownerIds),
      );
      const eventIndex = first.events.length;

      killProcessIdentity(crashTargets[0]!);
      const [inputTerminal, runTerminal, controlTerminal, exit] = await Promise.all([
        first.waitForCommandTerminal(active.commandId, LIVE_TURN_TIMEOUT_MS),
        first.waitForEvent(
          (event) =>
            event.runId === active.runId &&
            (event.kind === "run.cancelled" ||
              event.kind === "run.completed" ||
              event.kind === "run.failed"),
          eventIndex,
          LIVE_TURN_TIMEOUT_MS,
          "provider crash run terminal",
        ),
        first.waitForRunTerminal(LIVE_TURN_TIMEOUT_MS),
        first.waitForExit(LIVE_TURN_TIMEOUT_MS),
      ]);
      toolBoundary.stop();
      providerRunBoundary.stop();
      providerControlBoundary.stop();

      expect(inputTerminal.status).toBe("failed");
      expect(runTerminal.kind).toBe("run.failed");
      expect(controlTerminal).toMatchObject({
        error: {
          retryable: false,
        },
        status: "failed",
      });
      expect(exit).toMatchObject({ code: 1, signal: null });
      expectNoLiveProcesses(toolBoundary.read(), "provider crash run terminal");
      expectNoLiveProcesses(providerRunBoundary.read(), "provider crash run terminal");
      expectNoLiveProcesses(providerControlBoundary.read(), "provider crash control terminal");
      await expectInterruptedToolStopped(active);
      await expectProviderTreesExited(first, ownerIds, "Provider crash process tree");
      await expectQuiescentRunLifecycle(first, active.eventIndex, active.runId, "run.failed");
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
        "Reply with exactly the token I asked you to remember before the provider crashed. Do not call tools.",
      );
      expectNoHistoricalRunProjections(resumed, startedRunId(events));
      expect(eventText(events)).toContain(token);
      await stopController(resumed);
      expectToolStartedOnce(active);
    } finally {
      await resumed.dispose();
    }
  });
}

function expectStaleResumeMessage(message: string): void {
  const lower = message.toLowerCase();
  expect(lower).toContain(STALE_RESUME_POINTER);
  expect(lower).toMatch(
    /no conversation found|(?:invalid|unknown) (?:conversation|session)|(?:conversation|session)(?: id)?[^\n]{0,240}(?:failed|invalid|not found|unknown|does not exist)/,
  );
  expect(lower).not.toMatch(
    /api.?key|authenticat|credential|enoent|model.*(?:invalid|not found)|quota|rate.?limit|spawn/,
  );
  expect(lower).not.toMatch(
    /\b(?:econn\w*|enotfound|fetch (?:error|failed)|network (?:error|failed)|connection (?:error|failed|refused|reset)|http(?: error| status)?\s*5\d\d|status(?: code|:)?\s*5\d\d|service unavailable|bad gateway|gateway timeout)\b/,
  );
  expect(lower).not.toContain("timed out");
}

function expectStaleResumeFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = Array.from(
    message.matchAll(/"stderr":\s*("(?:\\.|[^"\\])*")/g),
    (match) => JSON.parse(match[1]!) as string,
  ).join("\n");
  expect(stderr.length).toBeGreaterThan(0);
  expectStaleResumeMessage(stderr);
}

function expectStaleResumeRunFailure(
  event: DriverArtifactTestEvent,
  runtimeCase: LiveRuntimeCase,
): void {
  const error = payloadRecord(event)["error"];
  expect(error).toEqual(
    expect.objectContaining({
      code: runtimeCase.suite === "anthropic" ? "claude.error_during_execution" : "acp.turn_failed",
      message: expect.any(String),
      retryable: false,
    }),
  );
  expectStaleResumeMessage(String((error as Record<string, unknown>)["message"]));
}

async function testStaleResume(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const token = `semantic-recovery-${createTestId()}`;
    const input = {
      nativeResumeRef: {
        kind: runtimeCase.nativeResumeKind,
        runtimeId: runtimeCase.runtime,
        value: STALE_RESUME_POINTER,
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
        expectStaleResumeFailure(error);
        return;
      }

      const turn = enqueueTurn(controller, "Reply with exactly stale-resume-should-fail.");
      const [turnUpdate, failedEvent] = await Promise.all([
        controller.waitForCommandTerminal(turn.commandId, LIVE_TURN_TIMEOUT_MS),
        controller.waitForEvent(
          (event) => event.runId === turn.runId && event.kind === "run.failed",
          turn.eventIndex,
          LIVE_TURN_TIMEOUT_MS,
          "stale resume run failure",
        ),
      ]);
      const failedEvents = controller
        .eventsSince(turn.eventIndex)
        .filter((event) => event.runId === turn.runId && event.kind === "run.failed");
      expect(failedEvents).toHaveLength(1);
      await expectQuiescentRunLifecycle(controller, turn.eventIndex, turn.runId, "run.failed");
      expectStaleResumeRunFailure(failedEvent, runtimeCase);

      if (runtimeCase.suite === "anthropic") {
        expect(turnUpdate.status).toBe("completed");
        await stopController(controller);
      } else {
        expect(turnUpdate.status).toBe("failed");
        expect(await controller.waitForExit(LIVE_STOP_TIMEOUT_MS)).toMatchObject({
          code: 1,
          signal: null,
        });
      }
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

async function writeLongToolScript(paths: LivePaths, marker: string): Promise<string> {
  const scriptName = `${marker}.sh`;
  const scriptPath = join(paths.workspacePath, scriptName);
  await writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      `printf '%s' "$$" > ${marker}.shell.pid`,
      `printf 'started\\n' >> ${marker}.started`,
      "sleep 30 &",
      "worker_pid=$!",
      `printf '%s' "$worker_pid" > ${marker}.worker.pid`,
      `if wait "$worker_pid"; then printf finished > ${marker}.finished; fi`,
      "",
    ].join("\n"),
    "utf8",
  );
  return scriptName;
}

async function beginLongTurn(
  controller: DriverArtifactTestController,
  paths: LivePaths,
): Promise<ActiveLongTurn> {
  const marker = `lifecycle-${createTestId()}`;
  const startedName = `${marker}.started`;
  const finishedName = `${marker}.finished`;
  const shellPidName = `${marker}.shell.pid`;
  const workerPidName = `${marker}.worker.pid`;
  const scriptName = await writeLongToolScript(paths, marker);
  const turn = enqueueTurn(
    controller,
    `Run exactly \`sh ./${scriptName}\` now in one actual shell tool call. This trusted test fixture is already prepared in the current workspace. Wait for it to exit before replying.`,
  );
  const startedPath = join(paths.workspacePath, startedName);
  const shellPidPath = join(paths.workspacePath, shellPidName);
  const workerPidPath = join(paths.workspacePath, workerPidName);
  try {
    const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;

    while (true) {
      controller.assertHealthy("long tool startup");
      const events = controller
        .eventsSince(turn.eventIndex)
        .filter((event) => event.runId === turn.runId);
      const terminal = events.find(
        (event) =>
          event.kind === "run.completed" ||
          event.kind === "run.failed" ||
          event.kind === "run.cancelled",
      );
      if (terminal !== undefined) {
        throw new Error(
          `Run ended as ${terminal.kind} before the long tool started: ${JSON.stringify(eventText(events))}.`,
        );
      }
      const shellPid = readRecordedPid(shellPidPath);
      const workerPid = readRecordedPid(workerPidPath);
      if (
        events.some((event) => isRunningTool(event, turn.runId)) &&
        existsSync(startedPath) &&
        shellPid !== null &&
        workerPid !== null &&
        processIsRunning(shellPid) &&
        processIsRunning(workerPid)
      ) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the long tool to start.");
      }
      await Bun.sleep(50);
    }
  } catch (error) {
    throw new Error(`Long tool did not start.\n${controller.diagnostics()}`, { cause: error });
  }
  return {
    ...turn,
    finishedPath: join(paths.workspacePath, finishedName),
    shellPidPath,
    startedPath,
    workerPidPath,
  };
}

function readRecordedPid(path: string): number | null {
  if (!existsSync(path)) {
    return null;
  }

  const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processIsRunning(pid: number): boolean {
  if (process.platform === "linux") {
    return readRunningLinuxProcessIdentity(pid) !== null;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

function readRunningLinuxProcessIdentity(pid: number): RunningLinuxProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    const startTime = fields[19];

    if (state === undefined || state.length !== 1 || startTime === undefined) {
      throw new Error(`Malformed /proc/${pid}/stat.`);
    }

    return state === "X" || state === "Z" ? null : { pid, startTime };
  } catch {
    if (!existsSync(`/proc/${pid}`)) {
      return null;
    }
    throw new Error(`Could not inspect live process ${pid}.`);
  }
}

function processIdentityIsRunning(identity: RunningLinuxProcessIdentity): boolean {
  return readRunningLinuxProcessIdentity(identity.pid)?.startTime === identity.startTime;
}

function ownedDirectProcessIdentities(
  controller: DriverArtifactTestController,
  ownerIds: readonly string[],
): RunningLinuxProcessIdentity[] {
  const owned = new Set(controller.providerProcessIdsForOwners(ownerIds));
  return controller
    .directChildProcessIds()
    .filter((pid) => owned.has(pid))
    .map(readRunningLinuxProcessIdentity)
    .filter((identity): identity is RunningLinuxProcessIdentity => identity !== null);
}

function sameProcessIdentity(
  left: RunningLinuxProcessIdentity,
  right: RunningLinuxProcessIdentity,
): boolean {
  return left.pid === right.pid && left.startTime === right.startTime;
}

function killProcessIdentity(identity: RunningLinuxProcessIdentity): void {
  if (!processIdentityIsRunning(identity)) {
    throw new Error(`Process ${identity.pid} exited before it could be crashed.`);
  }
  process.kill(identity.pid, "SIGKILL");
}

async function expectProcessExited(
  pid: number,
  label: string,
  timeoutMs = LIVE_STOP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (processIsRunning(pid) && Date.now() < deadline) {
    await Bun.sleep(50);
  }

  if (processIsRunning(pid)) {
    const processStat =
      process.platform === "linux" ? readFileSync(`/proc/${pid}/stat`, "utf8").trim() : "unknown";
    throw new Error(`${label} remained live after ${timeoutMs}ms; process=${processStat}.`);
  }
}

async function expectProviderTreesExited(
  controller: DriverArtifactTestController,
  ownerIds: readonly string[],
  label: string,
  timeoutMs = LIVE_STOP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let emptySnapshots = 0;
  let processIds: number[] = [];

  while (Date.now() < deadline) {
    processIds = controller.providerProcessIdsForOwners(ownerIds);
    emptySnapshots = processIds.length === 0 ? emptySnapshots + 1 : 0;
    if (emptySnapshots >= 2) {
      return;
    }
    await Bun.sleep(50);
  }

  throw new Error(`${label} remained live after ${timeoutMs}ms: ${processIds}.`);
}

async function readInterruptedToolPids(
  active: ActiveLongTurn,
): Promise<readonly [shellPid: number, workerPid: number]> {
  expectToolStartedOnce(active);
  const shellPid = readRecordedPid(active.shellPidPath);
  const workerPid = readRecordedPid(active.workerPidPath);
  expect(shellPid).not.toBeNull();
  expect(workerPid).not.toBeNull();
  return [shellPid!, workerPid!];
}

function expectToolStartedOnce(active: ActiveLongTurn): void {
  expect(
    readFileSync(active.startedPath, "utf8")
      .split("\n")
      .filter((line) => line === "started"),
  ).toHaveLength(1);
}

async function expectInterruptedToolStopped(active: ActiveLongTurn): Promise<void> {
  const [shellPid, workerPid] = await readInterruptedToolPids(active);
  expect(processIsRunning(shellPid)).toBe(false);
  expect(processIsRunning(workerPid)).toBe(false);
  expect(existsSync(active.finishedPath)).toBe(false);
}

function liveProcessIds(processIds: readonly number[]): number[] {
  return processIds.filter(processIsRunning);
}

function expectNoLiveProcesses(processIds: readonly number[] | null, boundary: string): void {
  if (processIds === null) {
    throw new Error(`${boundary} did not capture process liveness.`);
  }
  if (processIds.length > 0) {
    throw new Error(`${boundary} was observed while process IDs were still live: ${processIds}.`);
  }
}

function observeEventProcessBoundary(
  controller: DriverArtifactTestController,
  processIds: ProcessIdSource,
  predicate: (event: DriverArtifactTestEvent) => boolean,
): ProcessBoundaryObservation {
  let live: readonly number[] | null = null;
  const stop = controller.observeEventIngress((event) => {
    if (live === null && predicate(event)) {
      live = liveProcessIds(typeof processIds === "function" ? processIds() : processIds);
    }
  });
  return { read: () => live, stop };
}

function observeRunTerminalProcessBoundary(
  controller: DriverArtifactTestController,
  processIds: ProcessIdSource,
): ProcessBoundaryObservation {
  let live: readonly number[] | null = null;
  const stop = controller.observeRunTerminalIngress(() => {
    if (live === null) {
      live = liveProcessIds(typeof processIds === "function" ? processIds() : processIds);
    }
  });
  return { read: () => live, stop };
}

async function expectInterruptedToolAfterCrash(active: ActiveLongTurn): Promise<void> {
  const [shellPid, workerPid] = await readInterruptedToolPids(active);
  await Promise.all([
    expectProcessExited(
      shellPid,
      `Crashed tool shell for ${active.startedPath}`,
      LIVE_CRASH_CLEANUP_TIMEOUT_MS,
    ),
    expectProcessExited(
      workerPid,
      `Crashed tool worker for ${active.startedPath}`,
      LIVE_CRASH_CLEANUP_TIMEOUT_MS,
    ),
  ]);
  expect(existsSync(active.finishedPath)).toBe(false);
}

async function testCancellation(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const controller = await startController({
      paths,
      runtimeCase,
      sessionId: createTestId(),
    });

    try {
      const continuityToken = `cancel-continuity-${randomUUID()}`;
      const seedEvents = await runTurn(
        controller,
        `Remember this exact token for after a cancellation: ${continuityToken}. Reply with exactly stored. Do not call tools.`,
      );
      expect(eventText(seedEvents).toLowerCase()).toContain("stored");

      const startBoundaryMarker = `cancel-start-${createTestId()}`;
      const startBoundaryScriptPath = await writeLongToolScript(paths, startBoundaryMarker);
      const startBoundaryStartedPath = join(paths.workspacePath, `${startBoundaryMarker}.started`);
      const startBoundaryShellPidPath = join(
        paths.workspacePath,
        `${startBoundaryMarker}.shell.pid`,
      );
      const startBoundaryWorkerPidPath = join(
        paths.workspacePath,
        `${startBoundaryMarker}.worker.pid`,
      );
      const startBoundaryFinishedPath = join(
        paths.workspacePath,
        `${startBoundaryMarker}.finished`,
      );
      const startBoundary = {
        commandId: `input-${createTestId()}`,
        eventIndex: controller.events.length,
        runId: createTestId(),
      };
      const startBoundaryGate = controller.gateEventIngress(
        (event) => event.runId === startBoundary.runId && event.kind === "run.started",
      );
      let startBoundaryAtTerminal: StartBoundaryObservation | null = null;
      const stopStartBoundaryObserver = controller.observeEventIngress((event) => {
        if (
          startBoundaryAtTerminal !== null ||
          event.runId !== startBoundary.runId ||
          event.kind !== "run.cancelled"
        ) {
          return;
        }
        const shellPid = readRecordedPid(startBoundaryShellPidPath);
        const workerPid = readRecordedPid(startBoundaryWorkerPidPath);
        const markedProcessIds = controller.markedProcessIds(
          LIVE_BOUNDARY_ENV,
          startBoundaryMarker,
        );
        startBoundaryAtTerminal = {
          live: liveProcessIds([
            ...markedProcessIds,
            ...[shellPid, workerPid].filter((pid): pid is number => pid !== null),
          ]),
          shellFileExists: existsSync(startBoundaryShellPidPath),
          shellPid,
          started: existsSync(startBoundaryStartedPath),
          workerFileExists: existsSync(startBoundaryWorkerPidPath),
          workerPid,
        };
      });
      const startBoundaryCancelId = `cancel-${createTestId()}`;
      const startBoundaryCancelUpdateIndex = controller.commandUpdates.length;
      controller.enqueue({
        commandId: startBoundary.commandId,
        input: {
          text: `This is an automated shell-tool contract test. Make exactly one shell tool call now with exactly \`${LIVE_BOUNDARY_ENV}=${startBoundaryMarker} sh ${JSON.stringify(startBoundaryScriptPath)}\`. Do not read or alter the script, do not use another tool, and reply only after the command exits.`,
        },
        kind: "input.start",
        requestId: `request-${createTestId()}`,
        runId: startBoundary.runId,
      });
      try {
        await controller.waitForEvent(
          (event) => event.runId === startBoundary.runId && event.kind === "run.started",
          startBoundary.eventIndex,
          LIVE_START_TIMEOUT_MS,
          "start-boundary started run event",
        );
        await startBoundaryGate.entered;
        controller.enqueue({
          commandId: startBoundaryCancelId,
          kind: "turn.cancel",
          reason: "live.cancel.start_boundary",
          runId: startBoundary.runId,
        });
        await controller.waitForCommandUpdate(
          (update) => update.commandId === startBoundaryCancelId && update.status === "accepted",
          startBoundaryCancelUpdateIndex,
          LIVE_STOP_TIMEOUT_MS,
          "start-boundary cancel accepted update",
        );
      } finally {
        startBoundaryGate.release();
      }
      const [startBoundaryInput, startBoundaryCancel, startBoundaryEvent] = await Promise.all([
        controller.waitForCommandTerminal(startBoundary.commandId, LIVE_TURN_TIMEOUT_MS),
        controller.waitForCommandTerminal(startBoundaryCancelId, LIVE_TURN_TIMEOUT_MS),
        controller.waitForEvent(
          (event) => event.runId === startBoundary.runId && event.kind === "run.cancelled",
          startBoundary.eventIndex,
          LIVE_TURN_TIMEOUT_MS,
          "start-boundary cancelled run event",
        ),
      ]);
      stopStartBoundaryObserver();
      expect(startBoundaryInput.status).toBe("cancelled");
      expect(startBoundaryCancel).toMatchObject({ status: "completed" });
      expect(startBoundaryEvent.kind).toBe("run.cancelled");
      await expectQuiescentRunLifecycle(
        controller,
        startBoundary.eventIndex,
        startBoundary.runId,
        "run.cancelled",
      );
      const startBoundaryObservation = startBoundaryAtTerminal as StartBoundaryObservation | null;
      if (startBoundaryObservation === null) {
        throw new Error("start-boundary run.cancelled did not capture process liveness.");
      }
      expectNoLiveProcesses(startBoundaryObservation.live, "start-boundary run.cancelled");
      if (startBoundaryObservation.shellFileExists) {
        expect(startBoundaryObservation.shellPid).not.toBeNull();
      }
      if (startBoundaryObservation.workerFileExists) {
        expect(startBoundaryObservation.workerPid).not.toBeNull();
      }
      expect(existsSync(startBoundaryShellPidPath)).toBe(startBoundaryObservation.shellFileExists);
      expect(existsSync(startBoundaryWorkerPidPath)).toBe(
        startBoundaryObservation.workerFileExists,
      );
      expect(existsSync(startBoundaryStartedPath)).toBe(startBoundaryObservation.started);
      expectNoLiveProcesses(
        liveProcessIds(controller.markedProcessIds(LIVE_BOUNDARY_ENV, startBoundaryMarker)),
        "start-boundary post-terminal quiescence",
      );
      expect(existsSync(startBoundaryFinishedPath)).toBe(false);

      const active = await beginLongTurn(controller, paths);
      const activeProcessIds = await readInterruptedToolPids(active);
      const providerOwnerIds = controller.providerOwnerIds();
      expect(providerOwnerIds.length).toBeGreaterThan(0);
      const oldProviderIdentities = controller
        .providerProcessIdsForOwners(providerOwnerIds)
        .map(readRunningLinuxProcessIdentity)
        .filter((identity): identity is RunningLinuxProcessIdentity => identity !== null);
      expect(oldProviderIdentities.length).toBeGreaterThan(0);
      const activeBoundary = observeEventProcessBoundary(
        controller,
        activeProcessIds,
        (event) => event.runId === active.runId && event.kind === "run.cancelled",
      );
      let liveOldProviderIdentitiesAtCancellation: readonly RunningLinuxProcessIdentity[] | null =
        null;
      const stopProviderBoundaryObserver = controller.observeEventIngress((event) => {
        if (
          liveOldProviderIdentitiesAtCancellation === null &&
          event.runId === active.runId &&
          event.kind === "run.cancelled"
        ) {
          liveOldProviderIdentitiesAtCancellation =
            oldProviderIdentities.filter(processIdentityIsRunning);
        }
      });
      const cancelId = `cancel-${createTestId()}`;
      controller.enqueue({
        commandId: cancelId,
        kind: "turn.cancel",
        reason: "live.cancel",
        runId: active.runId,
      });
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
      activeBoundary.stop();
      stopProviderBoundaryObserver();

      expect(inputUpdate.status).toBe("cancelled");
      expect(cancelUpdate.status).toBe("completed");
      expect(cancelledEvent.kind).toBe("run.cancelled");
      expectNoLiveProcesses(activeBoundary.read(), "active run.cancelled");
      const liveOldProviderIdentities = liveOldProviderIdentitiesAtCancellation as
        | readonly RunningLinuxProcessIdentity[]
        | null;
      expectNoLiveProcesses(
        liveOldProviderIdentities?.map((identity) => identity.pid) ?? null,
        "active run.cancelled old provider identities",
      );
      await expectInterruptedToolStopped(active);
      await expectQuiescentRunLifecycle(
        controller,
        active.eventIndex,
        active.runId,
        "run.cancelled",
      );
      const replayIndex = controller.commandUpdates.length;
      controller.enqueue({
        commandId: cancelId,
        kind: "turn.cancel",
        reason: "live.cancel",
        runId: active.runId,
      });
      expect(
        (await controller.waitForCommandTerminal(cancelId, LIVE_STOP_TIMEOUT_MS, replayIndex))
          .status,
      ).toBe("completed");
      expect(
        controller.commandUpdates.filter(
          (update) =>
            update.commandId === cancelId &&
            (update.status === "cancelled" ||
              update.status === "completed" ||
              update.status === "failed"),
        ),
      ).toHaveLength(2);

      const idleCancelId = `cancel-${createTestId()}`;
      controller.enqueue({
        commandId: idleCancelId,
        kind: "turn.cancel",
        reason: "live.idle.cancel",
        runId: active.runId,
      });
      expect(
        (await controller.waitForCommandTerminal(idleCancelId, LIVE_STOP_TIMEOUT_MS)).status,
      ).toBe("failed");

      const events = await runTurn(
        controller,
        "Reply with exactly the token I asked you to remember before the cancellation. Do not call tools.",
      );
      expect(eventText(events)).toContain(continuityToken);
      await stopController(controller);
      expectNoLiveProcesses(
        liveProcessIds(controller.markedProcessIds(LIVE_BOUNDARY_ENV, startBoundaryMarker)),
        "start-boundary scenario completion",
      );
      expect(existsSync(startBoundaryFinishedPath)).toBe(false);
      expect(existsSync(active.finishedPath)).toBe(false);
      expectToolStartedOnce(active);
    } finally {
      await controller.dispose();
    }
  });
}

async function waitForPermissionRequest(
  controller: DriverArtifactTestController,
  turn: { readonly eventIndex: number; readonly runId: string },
  expectedFragment: string,
  label: string,
): Promise<string> {
  const event = await controller.waitForEvent(
    (candidate) =>
      candidate.runId === turn.runId &&
      (candidate.kind === "permission.requested" ||
        candidate.kind === "run.cancelled" ||
        candidate.kind === "run.completed" ||
        candidate.kind === "run.failed"),
    turn.eventIndex,
    LIVE_TURN_TIMEOUT_MS,
    label,
  );
  if (event.kind !== "permission.requested") {
    throw new Error(`${label}: ${event.kind} arrived before permission.requested.
${controller.diagnostics()}`);
  }
  const requestId = payloadRecord(event)["requestId"];
  expect(typeof requestId).toBe("string");
  expect((requestId as string).length).toBeGreaterThan(0);
  expect(payloadRecord(event)["details"]).toEqual(expect.stringContaining(expectedFragment));
  return requestId as string;
}

function expectPermissionLifecycle(
  events: readonly DriverArtifactTestEvent[],
  runId: string,
  requestId: string,
): void {
  const requested = events.filter(
    (event) =>
      event.kind === "permission.requested" && payloadRecord(event)["requestId"] === requestId,
  );
  const resolved = events.filter(
    (event) =>
      event.kind === "permission.resolved" && payloadRecord(event)["requestId"] === requestId,
  );
  expect(requested).toHaveLength(1);
  expect(resolved).toHaveLength(1);
  const requestedIndex = events.indexOf(requested[0]!);
  const resolvedIndex = events.indexOf(resolved[0]!);
  const terminalIndex = events.findIndex(
    (event) =>
      event.runId === runId &&
      (event.kind === "run.cancelled" ||
        event.kind === "run.completed" ||
        event.kind === "run.failed"),
  );

  expect(requestedIndex).toBeGreaterThanOrEqual(0);
  expect(resolvedIndex).toBeGreaterThan(requestedIndex);
  expect(terminalIndex).toBeGreaterThan(resolvedIndex);
  expect(events[requestedIndex]?.runId).toBe(runId);
  expect(events[resolvedIndex]?.runId).toBe(runId);
}

async function testSupervisedPermission(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const rejectedScriptPath = join(paths.workspacePath, `shell-fixture-${createTestId()}.sh`);
    const allowedScriptPath = join(paths.workspacePath, `shell-fixture-${createTestId()}.sh`);
    const shellPrompt = (command: string): string =>
      `This is an automated shell-tool contract test. Make exactly one actual shell tool call now with exactly \`${command}\`. Do not inspect, explain, or simulate the command, do not use another tool, and finish only after the actual tool result.`;
    await Promise.all([
      writeFile(rejectedScriptPath, "printf unexpected > tool-result-b.txt\n", "utf8"),
      writeFile(allowedScriptPath, "printf permission-ok > tool-result-c.txt\n", "utf8"),
    ]);
    const controller = await startController({
      paths,
      permissionPolicy: "supervised",
      runtimeCase,
      sessionId: createTestId(),
    });

    try {
      const cancelled = enqueueTurn(
        controller,
        shellPrompt("printf unexpected > tool-result-a.txt"),
      );
      const cancelledRequestId = await waitForPermissionRequest(
        controller,
        cancelled,
        "tool-result-a.txt",
        "permission request before cancellation",
      );
      const cancelId = `cancel-${createTestId()}`;
      controller.enqueue({
        commandId: cancelId,
        kind: "turn.cancel",
        reason: "live.permission.cancel",
        runId: cancelled.runId,
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
      expect(payloadRecord(cancelledResolution)).toMatchObject({
        outcome: "reject_once",
        reason: "cancelled",
        requestId: cancelledRequestId,
      });
      expect(existsSync(join(paths.workspacePath, "tool-result-a.txt"))).toBe(false);
      expectPermissionLifecycle(
        controller.eventsSince(cancelled.eventIndex),
        cancelled.runId,
        cancelledRequestId,
      );
      await expectQuiescentRunLifecycle(
        controller,
        cancelled.eventIndex,
        cancelled.runId,
        "run.cancelled",
      );

      const cancelledResolutionCount = controller.events.filter(
        (event) =>
          event.kind === "permission.resolved" &&
          payloadRecord(event)["requestId"] === cancelledRequestId,
      ).length;
      const lateResolveId = `permission-${createTestId()}`;
      controller.enqueue({
        commandId: lateResolveId,
        decision: "allow_once",
        kind: "permission.resolve",
        requestId: cancelledRequestId,
        runId: cancelled.runId,
      });
      expect(
        (await controller.waitForCommandTerminal(lateResolveId, LIVE_STOP_TIMEOUT_MS)).status,
      ).toBe("failed");
      expect(
        controller.events.filter(
          (event) =>
            event.kind === "permission.resolved" &&
            payloadRecord(event)["requestId"] === cancelledRequestId,
        ),
      ).toHaveLength(cancelledResolutionCount);
      expect(existsSync(join(paths.workspacePath, "tool-result-a.txt"))).toBe(false);

      const rejected = enqueueTurn(
        controller,
        shellPrompt(`sh ${JSON.stringify(rejectedScriptPath)}`),
      );
      const rejectedRequestId = await waitForPermissionRequest(
        controller,
        rejected,
        rejectedScriptPath,
        "permission request before rejection",
      );
      const rejectId = `permission-${createTestId()}`;
      controller.enqueue({
        commandId: rejectId,
        decision: "reject_once",
        kind: "permission.resolve",
        requestId: rejectedRequestId,
        runId: rejected.runId,
      });
      const [rejectUpdate, rejectedUpdate, rejectedResolution, rejectedEvent] = await Promise.all([
        controller.waitForCommandTerminal(rejectId, LIVE_TURN_TIMEOUT_MS),
        controller.waitForCommandTerminal(rejected.commandId, LIVE_TURN_TIMEOUT_MS),
        controller.waitForEvent(
          (event) =>
            event.kind === "permission.resolved" &&
            payloadRecord(event)["requestId"] === rejectedRequestId,
          rejected.eventIndex,
          LIVE_TURN_TIMEOUT_MS,
          "rejected permission resolution",
        ),
        controller.waitForEvent(
          (event) => event.runId === rejected.runId && event.kind === "run.completed",
          rejected.eventIndex,
          LIVE_TURN_TIMEOUT_MS,
          "rejected run completion",
        ),
      ]);
      expect(rejectUpdate.status).toBe("completed");
      expect(rejectedUpdate.status).toBe("completed");
      expect(payloadRecord(rejectedResolution)).toMatchObject({
        outcome: "reject_once",
        reason: "rejected",
        requestId: rejectedRequestId,
      });
      expect(rejectedEvent.kind).toBe("run.completed");
      expectPermissionLifecycle(
        controller.eventsSince(rejected.eventIndex),
        rejected.runId,
        rejectedRequestId,
      );
      await expectQuiescentRunLifecycle(
        controller,
        rejected.eventIndex,
        rejected.runId,
        "run.completed",
      );
      expect(existsSync(join(paths.workspacePath, "tool-result-b.txt"))).toBe(false);

      const allowed = enqueueTurn(
        controller,
        shellPrompt(`sh ${JSON.stringify(allowedScriptPath)}`),
      );
      const allowedRequestId = await waitForPermissionRequest(
        controller,
        allowed,
        allowedScriptPath,
        "permission request before approval",
      );
      const resolveId = `permission-${createTestId()}`;
      controller.enqueue({
        commandId: resolveId,
        decision: "allow_once",
        kind: "permission.resolve",
        requestId: allowedRequestId,
        runId: allowed.runId,
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
      expect(payloadRecord(allowedResolution)).toMatchObject({
        outcome: "allow_once",
        reason: "approved",
        requestId: allowedRequestId,
      });
      expect(completedEvent.kind).toBe("run.completed");
      expectPermissionLifecycle(
        controller.eventsSince(allowed.eventIndex),
        allowed.runId,
        allowedRequestId,
      );
      await expectQuiescentRunLifecycle(
        controller,
        allowed.eventIndex,
        allowed.runId,
        "run.completed",
      );
      expect(await readFile(join(paths.workspacePath, "tool-result-c.txt"), "utf8")).toBe(
        "permission-ok",
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
      const active = await beginLongTurn(first, paths);
      const toolProcessIds = await readInterruptedToolPids(active);
      const childProcessIds = first.directChildProcessIds();
      const providerOwnerIds = first.providerOwnerIds();
      expect(providerOwnerIds.length).toBeGreaterThan(0);
      const toolBoundary = observeEventProcessBoundary(
        first,
        toolProcessIds,
        (event) => event.runId === active.runId && event.kind === "run.cancelled",
      );
      const providerBoundary = observeRunTerminalProcessBoundary(first, () =>
        first.providerProcessIdsForOwners(providerOwnerIds),
      );
      const inputTerminal = first.waitForCommandTerminal(active.commandId, LIVE_TURN_TIMEOUT_MS);
      const cancelledEvent = first.waitForEvent(
        (event) => event.runId === active.runId && event.kind === "run.cancelled",
        active.eventIndex,
        LIVE_TURN_TIMEOUT_MS,
        "stopped run cancellation",
      );
      const stop = stopController(first);
      expect((await inputTerminal).status).toBe("cancelled");
      expect((await cancelledEvent).kind).toBe("run.cancelled");
      toolBoundary.stop();
      expectNoLiveProcesses(toolBoundary.read(), "session.stop run.cancelled");
      await stop;
      providerBoundary.stop();
      expectNoLiveProcesses(providerBoundary.read(), "session.stop control terminal");
      await Promise.all(
        childProcessIds.map((pid) => expectProcessExited(pid, `session.stop child process ${pid}`)),
      );
      await expectProviderTreesExited(
        first,
        providerOwnerIds,
        "session.stop provider process tree",
      );
      await expectInterruptedToolStopped(active);
      await expectQuiescentRunLifecycle(first, active.eventIndex, active.runId, "run.cancelled");
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
      const active = await beginLongTurn(first, paths);
      const toolProcessIds = await readInterruptedToolPids(active);
      const childProcessIds = first.directChildProcessIds();
      const providerOwnerIds = first.providerOwnerIds();
      expect(providerOwnerIds.length).toBeGreaterThan(0);
      const toolBoundary = observeEventProcessBoundary(
        first,
        toolProcessIds,
        (event) => event.runId === active.runId && event.kind === "run.cancelled",
      );
      const providerBoundary = observeRunTerminalProcessBoundary(first, () =>
        first.providerProcessIdsForOwners(providerOwnerIds),
      );
      first.signalDriver("SIGTERM");
      const [inputTerminal, cancelledEvent, runTerminal, exit] = await Promise.all([
        first.waitForCommandTerminal(active.commandId, LIVE_TURN_TIMEOUT_MS),
        first.waitForEvent(
          (event) => event.runId === active.runId && event.kind === "run.cancelled",
          active.eventIndex,
          LIVE_TURN_TIMEOUT_MS,
          "SIGTERM run cancellation",
        ),
        first.waitForRunTerminal(LIVE_STOP_TIMEOUT_MS),
        first.waitForExit(LIVE_STOP_TIMEOUT_MS),
      ]);
      toolBoundary.stop();
      providerBoundary.stop();
      expect(inputTerminal.status).toBe("cancelled");
      expect(cancelledEvent.kind).toBe("run.cancelled");
      expect(runTerminal.status).toBe("completed");
      expectNoLiveProcesses(toolBoundary.read(), "SIGTERM run.cancelled");
      expectNoLiveProcesses(providerBoundary.read(), "SIGTERM control terminal");
      await Promise.all(
        childProcessIds.map((pid) => expectProcessExited(pid, `SIGTERM child process ${pid}`)),
      );
      await expectProviderTreesExited(first, providerOwnerIds, "SIGTERM provider process tree");
      await expectInterruptedToolStopped(active);
      await expectQuiescentRunLifecycle(first, active.eventIndex, active.runId, "run.cancelled");
      expect(exit).toMatchObject({
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

async function testHeartbeatFailure(runtimeCase: LiveRuntimeCase): Promise<void> {
  await withLivePaths(async (paths) => {
    const controller = await startController({
      heartbeatIntervalMs: 250,
      paths,
      runtimeCase,
      sessionId: createTestId(),
    });

    try {
      const active = await beginLongTurn(controller, paths);
      const toolProcessIds = await readInterruptedToolPids(active);
      const childProcessIds = controller.directChildProcessIds();
      const providerOwnerIds = controller.providerOwnerIds();
      expect(providerOwnerIds.length).toBeGreaterThan(0);
      const toolBoundary = observeEventProcessBoundary(
        controller,
        toolProcessIds,
        (event) => event.runId === active.runId && event.kind === "run.cancelled",
      );
      const providerBoundary = observeRunTerminalProcessBoundary(controller, () =>
        controller.providerProcessIdsForOwners(providerOwnerIds),
      );
      controller.failHeartbeats();
      const [inputTerminal, cancelledEvent, runTerminal, exit] = await Promise.all([
        controller.waitForCommandTerminal(active.commandId, LIVE_TURN_TIMEOUT_MS),
        controller.waitForEvent(
          (event) => event.runId === active.runId && event.kind === "run.cancelled",
          active.eventIndex,
          LIVE_TURN_TIMEOUT_MS,
          "heartbeat failure run cancellation",
        ),
        controller.waitForRunTerminal(LIVE_STOP_TIMEOUT_MS),
        controller.waitForExit(LIVE_STOP_TIMEOUT_MS),
      ]);
      toolBoundary.stop();
      providerBoundary.stop();
      expect(inputTerminal.status).toBe("cancelled");
      expect(cancelledEvent.kind).toBe("run.cancelled");
      expect(runTerminal.status).toBe("failed");
      expectNoLiveProcesses(toolBoundary.read(), "heartbeat failure run.cancelled");
      expectNoLiveProcesses(providerBoundary.read(), "heartbeat failure control terminal");
      expect(exit.code).toBe(1);
      await Promise.all(
        childProcessIds.map((pid) =>
          expectProcessExited(pid, `heartbeat failure child process ${pid}`),
        ),
      );
      await expectProviderTreesExited(
        controller,
        providerOwnerIds,
        "heartbeat failure provider process tree",
      );
      await expectInterruptedToolStopped(active);
      await expectQuiescentRunLifecycle(
        controller,
        active.eventIndex,
        active.runId,
        "run.cancelled",
      );
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
      const active = await beginLongTurn(controller, paths);
      const toolProcessIds = await readInterruptedToolPids(active);
      const childProcessIds = controller.directChildProcessIds();
      const providerOwnerIds = controller.providerOwnerIds();
      expect(providerOwnerIds.length).toBeGreaterThan(0);
      controller.disconnectDriver();
      const exit = await controller.waitForExit(LIVE_STOP_TIMEOUT_MS);
      if (exit.code !== 1 || exit.signal !== null) {
        throw new Error(
          `Packed driver did not fail after unexpected control disconnect: ${JSON.stringify(exit)}.\n${controller.diagnostics()}`,
        );
      }
      await Promise.all(
        [...toolProcessIds, ...childProcessIds].map((pid) =>
          expectProcessExited(pid, `control disconnect child process ${pid}`),
        ),
      );
      await expectProviderTreesExited(
        controller,
        providerOwnerIds,
        "control disconnect provider process tree",
      );
      await expectInterruptedToolStopped(active);
    } finally {
      await controller.dispose();
    }
  });
}

const compatibilityScenarios = [["sequential turns", testStartup]] as const;
const lifecycleScenarios = [
  ["workspace Unicode CRUD", testWorkspace],
  ["nonzero command recovery", testCommandRecovery],
  ["native MCP configuration and tool call", testNativeMcp],
  ["native process resume", testResume],
  ["provider crash and native resume", testProviderCrashResume],
  ["stale native resume", testStaleResume],
  ["run.started ACK-boundary, active, replayed, and idle cancellation", testCancellation],
  ["supervised permission cancellation, rejection, and approval", testSupervisedPermission],
  ["active stop and restart", testActiveStop],
] as const;
const controlScenarios = [
  ["process crash and native resume", testCrashResume],
  ["SIGTERM and restart", testSigterm],
  ["active control disconnect", testControlDisconnect],
  ["active heartbeat failure", testHeartbeatFailure],
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
