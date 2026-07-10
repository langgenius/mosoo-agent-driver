/**
 * Driver-level TTFT + streaming-cadence benchmark.
 *
 * Drives the REAL driver kernel + provider registry (same code path as the
 * live tests) against live provider APIs and measures, per provider runtime:
 *   - bootMs         kernel.start() cost (runtime/CLI/SDK init)
 *   - ttftMs         dispatch -> first message.delta event (time to first token)
 *   - firstTextMs    dispatch -> first NON-EMPTY text delta
 *   - totalMs        dispatch -> run.completed
 *   - interChunkGap  distribution (p50/p95/max) between consecutive message.delta
 *   - deltaCount / outputChars
 *   - taskCompleted  whether the requested output and marker were produced
 *   - policyEnforced whether a supervised rejection was observed and obeyed
 *
 * Both the execution permission policy and permission host port are explicit
 * per scenario. This lets the tool scenarios compare full access with a
 * supervised rejection without silently bypassing the host decision.
 *
 * Run (from apps/driver):
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... bun bench/ttft-bench.ts
 * Flags (env):
 *   TTFT_TRIALS=5            trials per cell (default 5) + 1 discarded warmup
 *   TTFT_RUNTIMES=claude,openai,opencode   subset to run
 *   TTFT_UPDATE_BASELINE=1   write baseline.json from this run
 *   TTFT_OPENCODE_PROVIDER=openai|anthropic   backing provider for opencode
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import { parseDriverBootPayload } from "../src/protocol/boot";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverHostIntegrationSnapshotFromBootExecution } from "../src/protocol/host-integration";
import type { DriverStartInput } from "../src/protocol/start";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { AGENT_DRIVER_PROVIDER_REGISTRY } from "../src/runtimes/provider-registry";
import { aggregateBenchmarkTrials } from "./benchmark-metrics";
import type { BenchmarkTrialAggregate, BenchmarkTrialMetrics } from "./benchmark-metrics";
import { applyBenchmarkPermissionPolicy } from "./benchmark-permission-policy";
import { BENCHMARK_SCENARIOS, evaluateBenchmarkOutcome } from "./benchmark-scenarios";
import type { BenchmarkScenario, BenchmarkScenarioId } from "./benchmark-scenarios";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, "outputs");
const TURN_TIMEOUT_MS = 120_000;
const TURN_CANCEL_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
const BOOT_TIMEOUT_MS = readPositiveIntegerEnv("TTFT_BOOT_TIMEOUT_MS", 100_000);

async function withTimeout<T>(label: string, ms: number, task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

type RuntimeId = "claude" | "openai" | "opencode";

interface CellResult {
  readonly runtime: RuntimeId;
  readonly scenario: BenchmarkScenarioId;
  readonly model: string;
  readonly trials: BenchmarkTrialMetrics[];
  readonly agg: BenchmarkTrialAggregate;
}

const benchmarkDriverBootPayload = parseDriverBootPayload({
  bootToken: "benchmark-token",
  controlUrl: "http://host.docker.internal:8787/api/driver/socket",
  driverControlPort: 20_000,
  driverGeneration: 0,
  driverInstanceId: "01J0000000000000000000000F",
  execution: {
    builtInTools: [
      { enabled: true, name: "bash" },
      { enabled: true, name: "read" },
      { enabled: true, name: "write" },
      { enabled: true, name: "edit" },
      { enabled: true, name: "glob" },
      { enabled: true, name: "grep" },
      { enabled: true, name: "web_fetch" },
      { enabled: true, name: "web_search" },
    ],
    configRevision: {
      agentId: "01J00000000000000000000009",
      deploymentVersionId: null,
      deploymentVersionNumber: null,
      environmentId: "01J00000000000000000000010",
      environmentRevisionId: "01J00000000000000000000011",
      runId: "01J00000000000000000000012",
      sessionId: "01J00000000000000000000008",
    },
    environment: { variables: {} },
    model: "benchmark-model",
    permissionPolicy: "full_access",
    profilePrompt: "",
    provider: "benchmark-provider",
    providerOptions: {},
    session: {
      additionalDirectories: [],
      context: {
        homePath: "/tmp/home",
        origin: {
          callerUserId: "01J00000000000000000000001",
          entrypoint: "api",
          executionOwnerUserId: "01J00000000000000000000001",
          type: "agent",
        },
        sandboxId: "01J0000000000000000000000D",
        sandboxKind: "cattle",
        sandboxSessionId: "01J0000000000000000000000E",
        sandboxSubjectId: "01J00000000000000000000008",
        sandboxSubjectKind: "session",
        sessionOrganizationPath: "/tmp/organization",
      },
      cwd: "/tmp/organization",
      mcpServers: [],
      nativeResumeRef: null,
    },
    skillCatalog: [],
    skills: [],
  },
  heartbeatIntervalMs: 1_000,
  protocolVersion: 1,
  runtime: "openai-runtime",
  runtimeTransport: "openai-app-server",
  sandboxId: "01J0000000000000000000000D",
  traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
});
const bootPayload = createDriverStartInputFromBootPayload(benchmarkDriverBootPayload);
const benchmarkRunId = (() => {
  const runId = bootPayload.execution.run.runId;
  if (runId === null) {
    throw new Error("Benchmark fixture requires a run ID.");
  }
  return runId;
})();

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(readEnv(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function appendTrialError(current: string | null, label: string, caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  const next = `${label}:${message}`;
  return current === null ? next : `${current};${next}`;
}

function percentile(values: number[], p: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).toSorted((a, b) => a - b);
  if (clean.length === 0) {
    return null;
  }
  const idx = Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1));
  return clean[idx] ?? null;
}

function textDeltaFrom(event: DriverEventInput): string {
  if (event.kind !== "message.delta") {
    return "";
  }

  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "";
  }

  const contentDelta = (payload as Record<string, unknown>)["contentDelta"];
  return typeof contentDelta === "string" ? contentDelta : "";
}

async function makePaths(prefix: string): Promise<{
  cwd: string;
  homePath: string;
  sharedRootPath: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const homePath = join(root, "home");
  const sharedRootPath = join(root, "workspace");
  await Promise.all([
    mkdir(homePath, { recursive: true }),
    mkdir(sharedRootPath, { recursive: true }),
  ]);
  return {
    cwd: sharedRootPath,
    homePath,
    sharedRootPath,
    cleanup: () => rm(root, { force: true, recursive: true }),
  };
}

interface StartInputArgs {
  apiKey: string;
  cwd: string;
  homePath: string;
  sharedRootPath: string;
  model: string;
  systemPrompt: string;
}

function claudeStartInput(a: StartInputArgs): DriverStartInput {
  return {
    ...bootPayload,
    execution: {
      ...bootPayload.execution,
      environment: {
        variables: { ...bootPayload.execution.environment.variables, ANTHROPIC_API_KEY: a.apiKey },
      },
      model: a.model,
      provider: "anthropic",
      session: {
        ...bootPayload.execution.session,
        additionalDirectories: [],
        cwd: a.cwd,
        homePath: a.homePath,
        mcpServers: [],
        nativeResumeRef: null,
        sharedRootPath: a.sharedRootPath,
      },
      skillCatalog: [],
      skills: [],
      systemPrompt: a.systemPrompt,
    },
    runtime: "claude-agent-sdk",
    runtimeTransport: "claude-agent-sdk",
  };
}

function openaiStartInput(a: StartInputArgs): DriverStartInput {
  return {
    ...bootPayload,
    execution: {
      ...bootPayload.execution,
      environment: {
        variables: { ...bootPayload.execution.environment.variables, OPENAI_API_KEY: a.apiKey },
      },
      model: a.model,
      provider: "openai",
      session: {
        ...bootPayload.execution.session,
        additionalDirectories: [],
        cwd: a.cwd,
        homePath: a.homePath,
        mcpServers: [],
        nativeResumeRef: null,
        sharedRootPath: a.sharedRootPath,
      },
      skillCatalog: [],
      skills: [],
      systemPrompt: a.systemPrompt,
    },
    runtime: "openai-runtime",
    runtimeTransport: "openai-app-server",
  };
}

function opencodeConfig(providerId: string, apiKeyEnv: string, model: string): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [providerId],
    model: `${providerId}/${model}`,
    provider: { [providerId]: { options: { apiKey: `{env:${apiKeyEnv}}` } } },
    small_model: `${providerId}/${model}`,
  });
}

function opencodeStartInput(
  a: StartInputArgs,
  providerId: string,
  apiKeyEnv: string,
): DriverStartInput {
  return {
    ...bootPayload,
    execution: {
      ...bootPayload.execution,
      environment: {
        variables: {
          ...bootPayload.execution.environment.variables,
          OPENCODE_CONFIG_CONTENT: opencodeConfig(providerId, apiKeyEnv, a.model),
          [apiKeyEnv]: a.apiKey,
        },
      },
      model: a.model,
      provider: providerId,
      session: {
        ...bootPayload.execution.session,
        additionalDirectories: [],
        cwd: a.cwd,
        homePath: a.homePath,
        mcpServers: [],
        nativeResumeRef: null,
        sharedRootPath: a.sharedRootPath,
      },
      skillCatalog: [],
      skills: [],
      systemPrompt: a.systemPrompt,
    },
    runtime: "acp-fallback",
    runtimeTransport: "acp-fallback",
  };
}

function opencodeHostSnapshot(paths: { cwd: string; homePath: string; sharedRootPath: string }) {
  return createDriverHostIntegrationSnapshotFromBootExecution({
    ...benchmarkDriverBootPayload.execution,
    profilePrompt: "",
    session: {
      ...benchmarkDriverBootPayload.execution.session,
      additionalDirectories: [],
      context: {
        ...benchmarkDriverBootPayload.execution.session.context,
        homePath: paths.homePath,
        sessionOrganizationPath: paths.sharedRootPath,
      },
      cwd: paths.cwd,
      mcpServers: [],
      nativeResumeRef: null,
    },
    skillCatalog: [],
    skills: [],
  });
}

async function runTrial(input: {
  runtime: RuntimeId;
  scenario: BenchmarkScenario;
  startInput: (paths: StartInputArgs) => DriverStartInput;
  apiKey: string;
  model: string;
  isOpenCode: boolean;
}): Promise<BenchmarkTrialMetrics> {
  const paths = await makePaths(`ttft-${input.runtime}-`);
  const args: StartInputArgs = {
    apiKey: input.apiKey,
    cwd: paths.cwd,
    homePath: paths.homePath,
    sharedRootPath: paths.sharedRootPath,
    model: input.model,
    systemPrompt: input.scenario.systemPrompt,
  };
  const hostSnapshot = input.isOpenCode ? opencodeHostSnapshot(paths) : null;
  let permissionRequestCount = 0;
  const kernel = new AgentDriverKernelCore({
    backendFactory: (i) => AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(i),
    hostPorts: {
      permission: {
        request: async () => {
          permissionRequestCount += 1;
          return input.scenario.permission;
        },
      },
      skill: { materialize: async () => [] },
      ...(hostSnapshot === null ? {} : { hostIntegration: { snapshot: async () => hostSnapshot } }),
    },
  });
  const events = kernel.events();

  let bootMs = 0;
  let ttftMs: number | null = null;
  let firstTextMs: number | null = null;
  let totalMs: number | null = null;
  let deltaCount = 0;
  let outputChars = 0;
  let fileCreated: boolean | null = input.scenario.marker ? false : null;
  let markerPresent: boolean | null = input.scenario.marker ? false : null;
  let error: string | null = null;
  const deltaTimestamps: number[] = [];
  let outputText = "";

  try {
    const bootStart = Date.now();
    const startInput = applyBenchmarkPermissionPolicy(
      input.startInput(args),
      input.scenario.permissionPolicy,
    );
    await withTimeout("boot", BOOT_TIMEOUT_MS, kernel.start(startInput));
    bootMs = Date.now() - bootStart;

    const dispatchStart = Date.now();
    const dispatch = kernel.dispatch({
      commandId: `ttft-${input.runtime}-cmd`,
      input: { text: input.scenario.prompt },
      kind: "input.start",
      requestId: `ttft-${input.runtime}-req`,
      runId: benchmarkRunId,
    });

    let turnTimeout: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      turnTimeout = setTimeout(() => resolve("timeout"), TURN_TIMEOUT_MS);
    });
    try {
      const iterator = events[Symbol.asyncIterator]();
      let done = false;
      while (!done) {
        const next = await Promise.race([iterator.next(), timeout]);
        if (next === "timeout") {
          error = "turn_timeout";
          break;
        }
        if (next.done) {
          error = error ?? "stream_closed_early";
          break;
        }
        const event: DriverEventInput = next.value;
        const now = Date.now();
        if (event.kind === "message.delta") {
          if (ttftMs === null) {
            ttftMs = now - dispatchStart;
          }
          deltaTimestamps.push(now);
          const text = textDeltaFrom(event);
          if (text.length > 0) {
            if (firstTextMs === null) {
              firstTextMs = now - dispatchStart;
            }
            outputChars += text.length;
            outputText += text;
            deltaCount += 1;
          }
        } else if (event.kind === "run.failed") {
          error = "run_failed";
          done = true;
        } else if (event.kind === "run.completed") {
          totalMs = now - dispatchStart;
          done = true;
        }
      }
    } finally {
      if (turnTimeout !== null) {
        clearTimeout(turnTimeout);
      }
    }
    if (error === "turn_timeout") {
      try {
        await withTimeout(
          "turn_cancel",
          TURN_CANCEL_TIMEOUT_MS,
          kernel.cancel("bench.turn_timeout"),
        );
      } catch (caught) {
        error = appendTrialError(error, "turn_cancel_failed", caught);
      }

      try {
        await withTimeout("dispatch_settle", TURN_CANCEL_TIMEOUT_MS, dispatch);
      } catch (caught) {
        error = appendTrialError(error, "dispatch_settle_failed", caught);
      }
    } else {
      try {
        await withTimeout("dispatch_settle", TURN_CANCEL_TIMEOUT_MS, dispatch);
      } catch (caught) {
        error = appendTrialError(error, "dispatch_failed", caught);
      }
    }
    if (input.scenario.marker) {
      try {
        const content = await readFile(join(paths.cwd, input.scenario.marker.file), "utf8");
        markerPresent = true;
        fileCreated = content
          .trim()
          .toLowerCase()
          .includes(input.scenario.marker.content.toLowerCase());
      } catch (caught) {
        if (
          typeof caught === "object" &&
          caught !== null &&
          "code" in caught &&
          caught.code === "ENOENT"
        ) {
          markerPresent = false;
          fileCreated = false;
        } else {
          markerPresent = null;
          throw caught;
        }
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    try {
      await withTimeout("stop", STOP_TIMEOUT_MS, kernel.stop("bench.stop"));
    } catch (caught) {
      error = appendTrialError(error, "stop_failed", caught);
    }

    try {
      await paths.cleanup();
    } catch (caught) {
      error = appendTrialError(error, "cleanup_failed", caught);
    }
  }

  const gaps: number[] = [];
  for (let i = 1; i < deltaTimestamps.length; i += 1) {
    const current = deltaTimestamps[i];
    const previous = deltaTimestamps[i - 1];
    if (current !== undefined && previous !== undefined) {
      gaps.push(current - previous);
    }
  }

  const textCompleted =
    totalMs !== null &&
    outputText.trim().toLowerCase().includes(input.scenario.expect.toLowerCase());
  const outcome = evaluateBenchmarkOutcome({
    fileCreated,
    markerPresent,
    permissionRequestCount,
    scenario: input.scenario,
    textCompleted,
  });

  return {
    bootMs,
    ttftMs,
    firstTextMs,
    totalMs,
    deltaCount,
    outputChars,
    interChunkP50: percentile(gaps, 50),
    interChunkP95: percentile(gaps, 95),
    interChunkMax: gaps.length > 0 ? Math.max(...gaps) : null,
    fileCreated,
    markerPresent,
    permissionRequestCount,
    ...outcome,
    error,
  };
}

async function main(): Promise<void> {
  const trials = readPositiveIntegerEnv("TTFT_TRIALS", 5);
  const requested = (readEnv("TTFT_RUNTIMES") ?? "claude,openai,opencode")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as RuntimeId[];
  const anthropicKey =
    readEnv("ANTHROPIC_API_KEY") ?? readEnv("AGENT_DRIVER_LIVE_ANTHROPIC_API_KEY");
  const openaiKey = readEnv("OPENAI_API_KEY") ?? readEnv("AGENT_DRIVER_LIVE_OPENAI_API_KEY");
  const claudeModel = readEnv("AGENT_DRIVER_LIVE_ANTHROPIC_MODEL") ?? "claude-sonnet-5";
  const openaiModel = readEnv("AGENT_DRIVER_LIVE_OPENAI_MODEL") ?? "gpt-5.5";
  const opencodeProvider = (readEnv("TTFT_OPENCODE_PROVIDER") ?? "openai") as
    | "openai"
    | "anthropic";
  const scenarioFilter = new Set<BenchmarkScenarioId>(
    (readEnv("TTFT_SCENARIOS") ?? "no_tool,long_output,tool_write_allow,tool_write_reject")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as BenchmarkScenarioId[],
  );

  const cells: CellResult[] = [];

  const runCell = async (
    runtime: RuntimeId,
    scenario: BenchmarkScenario,
    model: string,
    build: (paths: StartInputArgs) => DriverStartInput,
    apiKey: string,
    isOpenCode: boolean,
  ): Promise<void> => {
    process.stdout.write(`\n[${runtime}/${scenario.id}] model=${model} warmup...`);
    const warmup = await runTrial({
      runtime,
      scenario,
      startInput: build,
      apiKey,
      model,
      isOpenCode,
    });
    if (warmup.error !== null) {
      throw new Error(`[${runtime}/${scenario.id}] warmup failed: ${warmup.error}`);
    }
    const results: BenchmarkTrialMetrics[] = [];
    for (let i = 0; i < trials; i += 1) {
      const m = await runTrial({ runtime, scenario, startInput: build, apiKey, model, isOpenCode });
      results.push(m);
      process.stdout.write(
        ` t${i + 1}=task:${m.taskCompleted ? "done" : "not_done"},policy:${m.policyEnforced === null ? "n/a" : m.policyEnforced ? "enforced" : "BYPASSED"}(ttft=${m.ttftMs ?? "-"},total=${m.totalMs ?? "-"})`,
      );
    }
    cells.push({
      runtime,
      scenario: scenario.id,
      model,
      trials: results,
      agg: aggregateBenchmarkTrials(results),
    });
  };

  for (const scenario of BENCHMARK_SCENARIOS.filter((s) => scenarioFilter.has(s.id))) {
    if (requested.includes("claude") && anthropicKey) {
      await runCell(
        "claude",
        scenario,
        claudeModel,
        (p) => claudeStartInput(p),
        anthropicKey,
        false,
      );
    }
    if (requested.includes("openai") && openaiKey) {
      await runCell("openai", scenario, openaiModel, (p) => openaiStartInput(p), openaiKey, false);
    }
    if (requested.includes("opencode")) {
      const key = opencodeProvider === "anthropic" ? anthropicKey : openaiKey;
      const model = opencodeProvider === "anthropic" ? claudeModel : openaiModel;
      const apiKeyEnv = opencodeProvider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      if (key) {
        process.env["MOSOO_ACP_FALLBACK_COMMAND"] =
          readEnv("MOSOO_ACP_FALLBACK_COMMAND") ?? "opencode";
        process.env["MOSOO_ACP_FALLBACK_ARGS"] =
          readEnv("MOSOO_ACP_FALLBACK_ARGS") ?? JSON.stringify(["acp", "--pure"]);
        await runCell(
          "opencode",
          scenario,
          model,
          (p) => opencodeStartInput(p, opencodeProvider, apiKeyEnv),
          key,
          true,
        );
      }
    }
  }

  if (cells.length === 0) {
    throw new Error(
      "No benchmark cells ran. Check TTFT_RUNTIMES, TTFT_SCENARIOS, and provider credentials.",
    );
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = readEnv("TTFT_STAMP") ?? "latest";
  const results = { generatedStamp: stamp, trials, cells };
  await writeFile(join(OUTPUT_DIR, `results-${stamp}.json`), JSON.stringify(results, null, 2));

  const lines: string[] = [
    `# Driver TTFT / streaming benchmark (${stamp})`,
    "",
    `trials per cell: ${trials} (+1 warmup discarded)`,
    "",
    "| runtime | scenario | model | turn% | task% | policy% | file% | boot p50 | ttft p50 | ttft p95 | firstText p50 | total p50 | interChunk p50/p95 | deltas |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const fmt = (v: number | null): string => (v === null ? "-" : `${Math.round(v)}`);
  const pct = (v: number | null): string => (v === null ? "-" : `${Math.round(v * 100)}%`);
  for (const c of cells) {
    lines.push(
      `| ${c.runtime} | ${c.scenario} | ${c.model} | ${pct(c.agg.turnCompletedRate)} | ${pct(c.agg.taskCompletedRate)} | ${pct(c.agg.policyEnforcedRate)} | ${pct(c.agg.fileCreatedRate)} | ${fmt(c.agg.bootP50)} | ${fmt(c.agg.ttftP50)} | ${fmt(c.agg.ttftP95)} | ${fmt(c.agg.firstTextP50)} | ${fmt(c.agg.totalP50)} | ${fmt(c.agg.interChunkP50)}/${fmt(c.agg.interChunkP95)} | ${fmt(c.agg.deltaCountP50)} |`,
    );
  }
  const summary = lines.join("\n");
  await writeFile(join(OUTPUT_DIR, `summary-${stamp}.md`), `${summary}\n`);
  if (readEnv("TTFT_UPDATE_BASELINE") === "1") {
    await writeFile(join(OUTPUT_DIR, "baseline.json"), JSON.stringify(results, null, 2));
  }
  process.stdout.write(
    `\n\n${summary}\n\nWrote outputs/results-${stamp}.json + summary-${stamp}.md\n`,
  );
}

await main();
