/**
 * Real Driver benchmark: cold Run, same-Session Run, then a new Driver restored
 * into an empty native home. tool_cancel replaces the second Run with cancellation.
 *
 * TTFT_TRIALS=5, TTFT_RUNTIMES=claude,openai,opencode,pi,
 * TTFT_SCENARIOS=no_tool,long_output,tool_write_allow,tool_write_reject,tool_cancel.
 * Each trial uses three Runs; one warmup trial per cell is discarded.
 * TTFT_TURN_TIMEOUT_MS / TTFT_BOOT_TIMEOUT_MS / TTFT_CLEANUP_TIMEOUT_MS bound waits.
 * Provider base URLs are forwarded, so loopback fixtures need no paid API calls.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentDriverKernelCore, type AgentDriverKernel } from "../src/core/agent-driver-kernel";
import type { PermissionDecision } from "../src/core/driver-permission-broker";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverId, parseRunId, type RunId, type SessionId } from "../src/protocol/id";
import { parseNativeCheckpoint, type NativeCheckpoint } from "../src/protocol/native-checkpoint";
import type { DriverStartInput } from "../src/protocol/start";
import { readNativeCheckpoint } from "../src/runtimes/native-checkpoint";
import { AGENT_DRIVER_PROVIDER_REGISTRY } from "../src/runtimes/provider-registry";
import { bootPayload } from "../tests/driver-runtime-boundary-fixtures";

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "outputs");
const CANCEL_MARKER = ".bench-cancel-started";
const CANCEL_PROMPT = `Run a shell command that writes started to ${CANCEL_MARKER} in the current directory, then sleeps for 30 seconds. Wait for the command before replying.`;
type RuntimeId = "claude" | "openai" | "opencode" | "pi";
type Phase = "cold" | "reuse" | "cancel" | "restore";

export interface Scenario {
  readonly id: string;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly permission: PermissionDecision;
  readonly expect: string;
  readonly marker?: {
    readonly file: string;
    readonly content: string;
    readonly expected?: boolean;
  };
  readonly cancel?: boolean;
}

export interface RunMetrics {
  readonly runId: RunId;
  readonly commandId: string;
  readonly requestId: string;
  readonly phase: Phase;
  readonly bootMs: number;
  readonly ttftMs: number | null;
  readonly firstTextMs: number | null;
  readonly terminalMs: number | null;
  readonly settledMs: number | null;
  /** Descriptor arrival; export duration is reported separately when the runtime emits it. */
  readonly checkpointReadyMs: number | null;
  readonly checkpointExportMs: number | null;
  readonly checkpointVerifyMs: number | null;
  readonly checkpointBytes: number | null;
  readonly checkpoint: NativeCheckpoint | null;
  readonly deltaCount: number;
  readonly outputChars: number;
  readonly interChunkP50: number | null;
  readonly interChunkP95: number | null;
  readonly nativeSpawnsObserved: number | null;
  readonly nativeRssPeakKiB: number | null;
  readonly nativeRssIdleKiB: number | null;
  readonly fileCreated: boolean | null;
  readonly terminal: "completed" | "cancelled" | "failed" | null;
  readonly ok: boolean;
  readonly error: string | null;
}

interface TrialMetrics {
  readonly runs: RunMetrics[];
  readonly ok: boolean;
  readonly error: string | null;
  readonly stopMs: number[];
  readonly retainedPath: string | null;
}

function readEnv(name: string): string | null {
  return process.env[name]?.trim() || null;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function positiveEnv(name: string, fallback: number): number {
  const value = Number(readEnv(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}
function percentile(values: number[], percent: number): number | null {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)] ?? null;
}
function payload(event: DriverEventInput): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

export async function withTimeout<T>(label: string, ms: number, task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A failed stop retains the home: a deadline does not establish process death. */
export async function stopAndCleanup(
  kernel: Pick<AgentDriverKernel, "stop">,
  cleanup: () => Promise<void>,
  timeoutMs: number,
): Promise<string | null> {
  try {
    await withTimeout("stop", timeoutMs, kernel.stop("bench.stop"));
    await withTimeout("cleanup", timeoutMs, cleanup());
    return null;
  } catch (error) {
    return errorText(error);
  }
}

// Samples only native processes descended from this benchmark. Counts are observed
// PIDs, and RSS is sampled; very short processes between samples may be missed.
class NativeProcesses {
  readonly #seen = new Set<number>();
  readonly #runtime: RuntimeId;
  #available = process.platform === "linux";
  #lastSample = 0;
  #rss = 0;
  #peak = 0;

  constructor(runtime: RuntimeId) {
    this.#runtime = runtime;
  }
  get starts(): number | null {
    return this.#available ? this.#seen.size : null;
  }
  get peak(): number | null {
    return this.#available ? this.#peak : null;
  }
  begin(): void {
    this.#peak = 0;
  }
  sample(force = false): number | null {
    if (!this.#available) return null;
    if (!force && Date.now() - this.#lastSample < 100) return this.#rss;
    this.#lastSample = Date.now();
    const result = spawnSync("ps", ["-eo", "pid=,ppid=,rss=,args="], {
      encoding: "utf8",
      timeout: 500,
    });
    if (result.status !== 0) {
      this.#available = false;
      return null;
    }
    const rows = result.stdout
      .trim()
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
        return match
          ? [
              {
                pid: Number(match[1]),
                parent: Number(match[2]),
                rss: Number(match[3]),
                args: match[4]!,
              },
            ]
          : [];
      });
    const descendants = new Set([process.pid]);
    for (let added = true; added;) {
      added = false;
      for (const row of rows)
        if (descendants.has(row.parent) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          added = true;
        }
    }
    const pattern = {
      claude: /(?:^|[/\s])claude(?:\s|$)|claude-agent-sdk/u,
      openai: /(?:^|[/\s])codex(?:\s|$)/u,
      opencode: /(?:^|[/\s])opencode(?:\s|$)/u,
      pi: /pi-coding-agent|(?:^|[/\s])pi(?:\s|$)/u,
    }[this.#runtime];
    const native = rows.filter(
      (row) =>
        row.pid !== process.pid &&
        (descendants.has(row.pid) || this.#seen.has(row.pid)) &&
        pattern.test(row.args),
    );
    for (const row of native) this.#seen.add(row.pid);
    this.#rss = native.reduce((sum, row) => sum + row.rss, 0);
    this.#peak = Math.max(this.#peak, this.#rss);
    return this.#rss;
  }
}

export async function measureRun(input: {
  kernel: AgentDriverKernel;
  events: AsyncIterator<DriverEventInput>;
  phase: Phase;
  bootMs: number;
  cwd: string;
  scenario: Scenario;
  prompt?: string;
  memoryToken?: string;
  timeoutMs: number;
  cleanupTimeoutMs: number;
  processes?: NativeProcesses;
}): Promise<RunMetrics> {
  const runId = parseRunId(createDriverId());
  const commandId = createDriverId();
  const requestId = createDriverId();
  let ttftMs: number | null = null,
    firstTextMs: number | null = null,
    terminalMs: number | null = null;
  let settledMs: number | null = null,
    checkpointReadyMs: number | null = null,
    checkpointExportMs: number | null = null;
  let checkpointVerifyMs: number | null = null,
    checkpointBytes: number | null = null;
  let checkpoint: NativeCheckpoint | null = null;
  let terminal: RunMetrics["terminal"] = null;
  let error: string | null = null,
    dispatchError: string | null = null,
    output = "";
  let deltaCount = 0,
    fileCreated: boolean | null = input.scenario.marker ? false : null;
  let finished = false;
  const deltas: number[] = [];
  const spawnsBefore = input.processes?.starts ?? null;
  input.processes?.begin();
  const started = Date.now();
  const dispatch = input.kernel.dispatch({
    commandId,
    requestId,
    runId,
    kind: "input.start",
    input: {
      text: input.phase === "cancel" ? CANCEL_PROMPT : (input.prompt ?? input.scenario.prompt),
    },
  });
  const settled = dispatch.then(
    () => {
      settledMs = Date.now() - started;
    },
    (caught: unknown) => {
      settledMs = Date.now() - started;
      dispatchError = errorText(caught);
    },
  );
  let cancelTask: Promise<void> | null = null;
  const cancel = () =>
    (cancelTask ??= withTimeout(
      "cancel",
      input.cleanupTimeoutMs,
      input.kernel.cancel("bench.cancel"),
    ));
  const cancellation =
    input.phase === "cancel"
      ? (async () => {
          while (!finished) {
            if (await Bun.file(join(input.cwd, CANCEL_MARKER)).exists()) {
              await cancel();
              return;
            }
            await Bun.sleep(20);
          }
        })()
      : Promise.resolve();
  const sampleTimer =
    input.processes === undefined ? null : setInterval(() => input.processes?.sample(), 100);
  try {
    const consume = async () => {
      for (;;) {
        const next = await input.events.next();
        if (next.done) throw new Error("event_stream_closed_before_terminal");
        const event = next.value;
        if (event.runId !== runId) continue;
        const elapsed = Date.now() - started;
        const data = payload(event);
        if (event.kind === "message.delta") {
          ttftMs ??= elapsed;
          deltas.push(elapsed);
          const text = typeof data["contentDelta"] === "string" ? data["contentDelta"] : "";
          if (text.length > 0) {
            firstTextMs ??= elapsed;
            deltaCount++;
            output += text;
          }
          input.processes?.sample();
        } else if (event.kind === "runtime.timing.recorded" && Array.isArray(data["phases"])) {
          for (const phase of data["phases"] as { name?: unknown; durationMs?: unknown }[]) {
            if (phase.name === "native.checkpoint" && typeof phase.durationMs === "number")
              checkpointExportMs = phase.durationMs;
          }
        } else if (
          event.kind === "run.completed" ||
          event.kind === "run.cancelled" ||
          event.kind === "run.failed"
        ) {
          terminal =
            event.kind === "run.completed"
              ? "completed"
              : event.kind === "run.cancelled"
                ? "cancelled"
                : "failed";
          terminalMs = elapsed;
          if (terminal === "failed") error = `run_failed: ${JSON.stringify(data)}`;
          if (terminal === "completed") {
            checkpoint = parseNativeCheckpoint(data["checkpoint"]);
            checkpointReadyMs = elapsed;
          }
          return;
        }
      }
    };
    await withTimeout("turn", input.timeoutMs, Promise.all([consume(), settled, cancellation]));
    if (terminal !== (input.phase === "cancel" ? "cancelled" : "completed"))
      error ??= `unexpected_terminal_${terminal}`;
    if (dispatchError !== null && input.phase !== "cancel") error ??= dispatchError;
    if (checkpoint !== null) {
      const verifyStarted = Date.now();
      const saved = await withTimeout(
        "checkpoint",
        input.cleanupTimeoutMs,
        readNativeCheckpoint({
          cwd: input.cwd,
          checkpoint,
          signal: AbortSignal.timeout(input.cleanupTimeoutMs),
        }),
      );
      checkpointVerifyMs = Date.now() - verifyStarted;
      checkpointBytes = saved.manifest.files.reduce((sum, file) => sum + file.size, 0);
    }
    if (input.scenario.marker && input.phase !== "cancel") {
      fileCreated =
        (
          await readFile(join(input.cwd, input.scenario.marker.file), "utf8").catch(() => "")
        ).trim() === input.scenario.marker.content;
      if (fileCreated !== (input.scenario.marker.expected ?? true))
        error ??= "unexpected_marker_state";
    }
    if (
      input.phase !== "cancel" &&
      !output.toLowerCase().includes(input.scenario.expect.toLowerCase())
    )
      error ??= "unexpected_output";
    if (input.memoryToken !== undefined && !output.includes(input.memoryToken))
      error ??= "session_memory_missing";
  } catch (caught) {
    finished = true;
    error = errorText(caught);
    try {
      await cancel();
    } catch (cancelError) {
      error += `; ${errorText(cancelError)}`;
    }
    try {
      await withTimeout("settle", input.cleanupTimeoutMs, settled);
    } catch (settleError) {
      error += `; ${errorText(settleError)}`;
    }
  } finally {
    finished = true;
    if (sampleTimer !== null) clearInterval(sampleTimer);
  }
  const idleRss = input.processes?.sample(true) ?? null;
  const spawnsAfter = input.processes?.starts ?? null;
  const gaps = deltas.slice(1).map((value, index) => value - deltas[index]!);
  return {
    runId,
    commandId,
    requestId,
    phase: input.phase,
    bootMs: input.bootMs,
    ttftMs,
    firstTextMs,
    terminalMs,
    settledMs,
    checkpointReadyMs,
    checkpointExportMs,
    checkpointVerifyMs,
    checkpointBytes,
    checkpoint,
    deltaCount,
    outputChars: output.length,
    interChunkP50: percentile(gaps, 50),
    interChunkP95: percentile(gaps, 95),
    nativeSpawnsObserved:
      spawnsBefore === null || spawnsAfter === null ? null : spawnsAfter - spawnsBefore,
    nativeRssPeakKiB: input.processes?.peak ?? null,
    nativeRssIdleKiB: idleRss,
    fileCreated,
    terminal,
    ok: error === null,
    error,
  };
}

interface RuntimeConfig {
  readonly runtime: RuntimeId;
  readonly provider: string;
  readonly model: string;
  readonly variables: Record<string, string>;
}

function startInput(
  config: RuntimeConfig,
  scenario: Scenario,
  paths: { cwd: string; home: string },
  sessionId: SessionId,
  checkpoint: NativeCheckpoint | null,
): DriverStartInput {
  const runtime = {
    claude: "claude-agent-sdk",
    openai: "openai-runtime",
    opencode: "acp-fallback",
    pi: "pi",
  }[config.runtime] as DriverStartInput["runtime"];
  const runtimeTransport = {
    claude: "claude-agent-sdk",
    openai: "openai-app-server",
    opencode: "acp-fallback",
    pi: "pi-rpc",
  }[config.runtime] as DriverStartInput["runtimeTransport"];
  return {
    ...bootPayload,
    driverInstanceId: createDriverId() as DriverStartInput["driverInstanceId"],
    runtime,
    runtimeTransport,
    execution: {
      ...bootPayload.execution,
      provider: config.provider,
      model: config.model,
      run: { runId: null, sessionId },
      environment: { variables: config.variables },
      session: {
        ...bootPayload.execution.session,
        additionalDirectories: [],
        cwd: paths.cwd,
        homePath: paths.home,
        sharedRootPath: paths.cwd,
        mcpServers: [],
        recoveryMessages: [],
        nativeCheckpoint: checkpoint,
        nativeResumeRef: checkpoint?.nativeRef ?? null,
        context: {
          ...bootPayload.execution.session.context,
          homePath: paths.home,
          sessionOrganizationPath: paths.cwd,
        },
      },
      skillCatalog: [],
      skills: [],
      systemPrompt: scenario.systemPrompt,
    },
  };
}

export async function runTrial(config: RuntimeConfig, scenario: Scenario): Promise<TrialMetrics> {
  const root = await mkdtemp(join(tmpdir(), `ttft-${config.runtime}-`));
  const cwd = join(root, "workspace");
  const sessionId = createDriverId() as SessionId;
  const memoryToken = `remember-${createDriverId()}`;
  const runs: RunMetrics[] = [],
    stopMs: number[] = [];
  const timeoutMs = positiveEnv("TTFT_TURN_TIMEOUT_MS", 120_000);
  const cleanupTimeoutMs = positiveEnv("TTFT_CLEANUP_TIMEOUT_MS", 10_000);
  const processes = new NativeProcesses(config.runtime);
  let kernel: AgentDriverKernelCore | null = null;
  let iterator: AsyncIterator<DriverEventInput> | null = null;
  let checkpoint: NativeCheckpoint | null = null;
  let error: string | null = null,
    retainedPath: string | null = null;
  let allStopped = true;
  const boot = async (home: string) => {
    await mkdir(home, { recursive: true });
    kernel = new AgentDriverKernelCore({
      backendFactory: (input) => AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(input),
      hostPorts: {
        permission: { request: async () => scenario.permission },
        skill: { materialize: async () => [] },
      },
    });
    allStopped = false;
    iterator = kernel.events()[Symbol.asyncIterator]();
    const began = Date.now();
    await withTimeout(
      "boot",
      positiveEnv("TTFT_BOOT_TIMEOUT_MS", 100_000),
      kernel.start(startInput(config, scenario, { cwd, home }, sessionId, checkpoint)),
    );
    return Date.now() - began;
  };
  const stop = async () => {
    if (kernel === null) return;
    const began = Date.now();
    const failure = await stopAndCleanup(kernel, async () => {}, cleanupTimeoutMs);
    stopMs.push(Date.now() - began);
    if (failure !== null) throw new Error(failure);
    if ((processes.sample(true) ?? 0) > 0) throw new Error("native_process_alive_after_stop");
    allStopped = true;
    kernel = null;
  };
  try {
    await mkdir(cwd, { recursive: true });
    let bootMs = await boot(join(root, "home"));
    for (const phase of ["cold", scenario.cancel ? "cancel" : "reuse", "restore"] as const) {
      if (phase === "restore") {
        await stop();
        bootMs = await boot(join(root, "restored-home"));
      }
      if (scenario.marker) await rm(join(cwd, scenario.marker.file), { force: true });
      await rm(join(cwd, CANCEL_MARKER), { force: true });
      const prompt =
        phase === "cold"
          ? `Remember the session marker ${memoryToken} for later. ${scenario.prompt}`
          : `${scenario.prompt} Also include the session marker remembered from earlier user messages.`;
      const result = await measureRun({
        kernel: kernel!,
        events: iterator!,
        phase,
        prompt,
        ...(phase === "cold" || phase === "cancel" ? {} : { memoryToken }),
        bootMs,
        cwd,
        scenario,
        timeoutMs,
        cleanupTimeoutMs,
        processes,
      });
      runs.push(result);
      if (!result.ok) throw new Error(`${phase}: ${result.error}`);
      if (result.checkpoint !== null) checkpoint = result.checkpoint;
      bootMs = 0;
    }
  } catch (caught) {
    error = errorText(caught);
  } finally {
    try {
      await stop();
    } catch (caught) {
      error = [error, errorText(caught)].filter(Boolean).join("; ");
    }
    if (allStopped) {
      try {
        await withTimeout("cleanup", cleanupTimeoutMs, rm(root, { recursive: true, force: true }));
      } catch (caught) {
        error = [error, errorText(caught)].filter(Boolean).join("; ");
        retainedPath = root;
      }
    } else retainedPath = root;
  }
  return { runs, ok: error === null && runs.length === 3, error, stopMs, retainedPath };
}

const SCENARIOS: Scenario[] = [
  {
    id: "no_tool",
    prompt: "Reply pong. Do not call tools.",
    systemPrompt: "Follow the requested output exactly.",
    permission: "allow_once",
    expect: "pong",
  },
  {
    id: "long_output",
    prompt: "Without tools, write about 200 words explaining how a compiler works.",
    systemPrompt: "Write clear prose without tools.",
    permission: "allow_once",
    expect: "compiler",
  },
  ...(["allow_once", "reject_once"] as const).map((permission): Scenario => ({
    id: permission === "allow_once" ? "tool_write_allow" : "tool_write_reject",
    prompt:
      "Create marker.txt containing exactly ready, then reply done. If permission is rejected, reply rejected and do not try another tool.",
    systemPrompt: "Use tools to complete the task; respect permission rejection.",
    permission,
    expect: permission === "allow_once" ? "done" : "rejected",
    marker: { file: "marker.txt", content: "ready", expected: permission === "allow_once" },
  })),
  {
    id: "tool_cancel",
    prompt: "Reply with exactly pong. Do not call tools.",
    systemPrompt: "Follow the requested task exactly.",
    permission: "allow_once",
    expect: "pong",
    cancel: true,
  },
];

function runtimeConfigs(): RuntimeConfig[] {
  const requested = (readEnv("TTFT_RUNTIMES") ?? "claude,openai,opencode,pi")
    .split(",")
    .map((id) => id.trim());
  if (requested.some((id) => !["claude", "openai", "opencode", "pi"].includes(id)))
    throw new Error("Unknown TTFT_RUNTIMES entry.");
  const configs: RuntimeConfig[] = [];
  const forwarded = (names: string[]) =>
    Object.fromEntries(
      names.flatMap((name) => {
        const value = readEnv(name);
        return value === null ? [] : [[name, value]];
      }),
    );
  for (const runtime of requested as RuntimeId[]) {
    const provider =
      runtime === "claude"
        ? "anthropic"
        : runtime === "opencode"
          ? (readEnv("TTFT_OPENCODE_PROVIDER") ?? "openai")
          : runtime === "pi"
            ? (readEnv("TTFT_PI_PROVIDER") ?? "openai")
            : "openai";
    const apiEnv = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const model =
      readEnv(`TTFT_${runtime.toUpperCase()}_MODEL`) ??
      (provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5.4");
    const variables = forwarded([
      apiEnv,
      "ANTHROPIC_BASE_URL",
      "OPENAI_BASE_URL",
      "MOSOO_PI_CONFIG_CONTENT",
      "MOSOO_PI_PROXY_GRANT",
    ]);
    if (
      runtime === "pi"
        ? !variables["MOSOO_PI_CONFIG_CONTENT"] || !variables["MOSOO_PI_PROXY_GRANT"]
        : !variables[apiEnv]
    ) {
      process.stdout.write(`Skipping ${runtime}: provider credentials/configuration missing.\n`);
      continue;
    }
    if (runtime === "claude")
      Object.assign(variables, {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_ERROR_REPORTING: "1",
        DISABLE_TELEMETRY: "1",
      });
    if (runtime === "opencode") {
      process.env["MOSOO_ACP_FALLBACK_COMMAND"] ??= "opencode";
      process.env["MOSOO_ACP_FALLBACK_ARGS"] ??= JSON.stringify(["acp", "--pure"]);
      const baseURL =
        variables[provider === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"];
      variables["OPENCODE_CONFIG_CONTENT"] = JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        enabled_providers: [provider],
        model: `${provider}/${model}`,
        small_model: `${provider}/${model}`,
        provider: {
          [provider]: {
            options: { apiKey: `{env:${apiEnv}}`, ...(baseURL === undefined ? {} : { baseURL }) },
          },
        },
      });
    }
    configs.push({ runtime, provider, model, variables });
  }
  return configs;
}

async function main(): Promise<void> {
  const trials = positiveEnv("TTFT_TRIALS", 5);
  const selected = new Set(
    (readEnv("TTFT_SCENARIOS") ?? SCENARIOS.map((scenario) => scenario.id).join(",")).split(","),
  );
  if ([...selected].some((id) => !SCENARIOS.some((scenario) => scenario.id === id)))
    throw new Error("Unknown TTFT_SCENARIOS entry.");
  const cells: { runtime: RuntimeId; model: string; scenario: string; trials: TrialMetrics[] }[] =
    [];
  const retainedWarmups: { runtime: RuntimeId; scenario: string; result: TrialMetrics }[] = [];
  cellsLoop: for (const config of runtimeConfigs())
    for (const scenario of SCENARIOS.filter((item) => selected.has(item.id))) {
      process.stdout.write(`\n[${config.runtime}/${scenario.id}] warmup`);
      const warmup = await runTrial(config, scenario);
      if (warmup.retainedPath !== null) {
        retainedWarmups.push({ runtime: config.runtime, scenario: scenario.id, result: warmup });
        process.stdout.write(` FAILED cleanup; retained ${warmup.retainedPath}\n`);
        break cellsLoop;
      }
      const results: TrialMetrics[] = [];
      for (let index = 0; index < trials; index++) {
        const result = await runTrial(config, scenario);
        results.push(result);
        process.stdout.write(` t${index + 1}=${result.ok ? "ok" : result.error}`);
        if (result.retainedPath !== null) break;
      }
      cells.push({
        runtime: config.runtime,
        model: config.model,
        scenario: scenario.id,
        trials: results,
      });
      if (results.some((result) => result.retainedPath !== null)) break cellsLoop;
    }
  const stamp = readEnv("TTFT_STAMP") ?? "latest";
  if (!/^[a-zA-Z0-9_-]+$/u.test(stamp)) throw new Error("TTFT_STAMP must be a filename label.");
  const results = { generatedStamp: stamp, trials, cells, retainedWarmups };
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(
    join(OUTPUT_DIR, `results-${stamp}.json`),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  const lines = [
    "# Driver Session benchmark",
    "",
    `${trials} trials per cell, each with cold/reuse/restore Runs; tool_cancel measures cold/cancel/restore.`,
    "All durations are milliseconds; RSS is KiB; native starts and peak RSS are sampled observations.",
    "",
    "| runtime | scenario | phase | ok% | boot p50 | first text p50/p95 | terminal p50 | settled p50/p95 | checkpoint ready/export p50 | checkpoint bytes p50 | native starts p50 | peak/idle RSS p50 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const fmt = (value: number | null) => (value === null ? "-" : Math.round(value).toString());
  for (const cell of cells)
    for (const phase of [
      "cold",
      cell.scenario === "tool_cancel" ? "cancel" : "reuse",
      "restore",
    ] as const) {
      const runs = cell.trials.flatMap((trial) => trial.runs.filter((run) => run.phase === phase));
      const good = runs.filter((run) => run.ok);
      const p = (key: keyof RunMetrics, percent = 50) =>
        percentile(
          good.flatMap((run) => (typeof run[key] === "number" ? [run[key] as number] : [])),
          percent,
        );
      lines.push(
        `| ${cell.runtime} | ${cell.scenario} | ${phase} | ${Math.round((100 * good.length) / cell.trials.length)}% | ${fmt(p("bootMs"))} | ${fmt(p("firstTextMs"))}/${fmt(p("firstTextMs", 95))} | ${fmt(p("terminalMs"))} | ${fmt(p("settledMs"))}/${fmt(p("settledMs", 95))} | ${fmt(p("checkpointReadyMs"))}/${fmt(p("checkpointExportMs"))} | ${fmt(p("checkpointBytes"))} | ${fmt(p("nativeSpawnsObserved"))} | ${fmt(p("nativeRssPeakKiB"))}/${fmt(p("nativeRssIdleKiB"))} |`,
      );
    }
  const summary = `${lines.join("\n")}\n`;
  await writeFile(join(OUTPUT_DIR, `summary-${stamp}.md`), summary);
  if (readEnv("TTFT_UPDATE_BASELINE") === "1")
    await writeFile(join(OUTPUT_DIR, "baseline.json"), `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(
    `\n\n${summary}\nWrote bench/outputs/results-${stamp}.json and summary-${stamp}.md\n`,
  );
  // A failed stop may retain active handles. Exit after saving the failure and path;
  // the directory remains available for process cleanup and diagnosis.
  if (
    retainedWarmups.length > 0 ||
    cells.some((cell) => cell.trials.some((trial) => trial.retainedPath !== null))
  )
    process.exit(1);
  if (cells.length === 0 || cells.some((cell) => cell.trials.some((trial) => !trial.ok)))
    process.exitCode = 1;
}

if (import.meta.main) await main();
