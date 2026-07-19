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
 *   - ok             whether the turn completed with the expected output
 *
 * The permission host port is toggled per scenario to measure the value of
 * full-access ("yolo") vs the current supervised/reject default on a
 * tool-requiring task, without needing the eventual code changes in place.
 *
 * Run (from apps/driver):
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... vp run bench
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
import type { PermissionDecision } from "../src/core/driver-permission-broker";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverHostIntegrationSnapshotFromBootExecution } from "../src/protocol/host-integration";
import type { DriverStartInput } from "../src/protocol/start";
import { AGENT_DRIVER_PROVIDER_REGISTRY } from "../src/runtimes/provider-registry";
import { driverBootPayload } from "../tests/driver-boot-payload-fixture";
import { DRIVER_TEST_IDS, bootPayload } from "../tests/driver-runtime-boundary-fixtures";
import { textDeltaFrom } from "../tests/live-driver-events";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(HERE, "outputs");
const TURN_TIMEOUT_MS = 120_000;
const BOOT_TIMEOUT_MS = Number(process.env["TTFT_BOOT_TIMEOUT_MS"] ?? "100000");

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
type ScenarioId = "no_tool" | "long_output" | "tool_write_allow" | "tool_write_reject";

interface Scenario {
  readonly id: ScenarioId;
  readonly prompt: string;
  readonly systemPrompt: string;
  /** permission decision the host port returns for this scenario */
  readonly permission: PermissionDecision;
  /** substring the final output must contain for ok=true */
  readonly expect: string;
  /** when set, ok additionally requires cwd/<marker> to contain the value */
  readonly marker?: { file: string; content: string };
}

interface TrialMetrics {
  readonly bootMs: number;
  readonly ttftMs: number | null;
  readonly firstTextMs: number | null;
  readonly totalMs: number | null;
  readonly deltaCount: number;
  readonly outputChars: number;
  readonly interChunkP50: number | null;
  readonly interChunkP95: number | null;
  readonly interChunkMax: number | null;
  readonly fileCreated: boolean | null;
  readonly ok: boolean;
  readonly error: string | null;
}

interface CellResult {
  readonly runtime: RuntimeId;
  readonly scenario: ScenarioId;
  readonly model: string;
  readonly trials: TrialMetrics[];
  readonly agg: ReturnType<typeof aggregate>;
}

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function percentile(values: number[], p: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).toSorted((a, b) => a - b);
  if (clean.length === 0) {
    return null;
  }
  const idx = Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1));
  return clean[idx] ?? null;
}

function aggregate(trials: TrialMetrics[]) {
  const okTrials = trials.filter((t) => t.ok);
  const pick = (key: keyof TrialMetrics): number[] =>
    okTrials.map((t) => t[key]).filter((v): v is number => typeof v === "number");
  const fileTrials = trials.filter((t) => t.fileCreated !== null);
  return {
    okRate: trials.length === 0 ? null : okTrials.length / trials.length,
    fileCreatedRate:
      fileTrials.length === 0
        ? null
        : fileTrials.filter((t) => t.fileCreated === true).length / fileTrials.length,
    bootP50: percentile(pick("bootMs"), 50),
    bootP95: percentile(pick("bootMs"), 95),
    ttftP50: percentile(pick("ttftMs"), 50),
    ttftP95: percentile(pick("ttftMs"), 95),
    firstTextP50: percentile(pick("firstTextMs"), 50),
    firstTextP95: percentile(pick("firstTextMs"), 95),
    totalP50: percentile(pick("totalMs"), 50),
    totalP95: percentile(pick("totalMs"), 95),
    interChunkP50: percentile(pick("interChunkP50"), 50),
    interChunkP95: percentile(pick("interChunkP95"), 95),
    deltaCountP50: percentile(pick("deltaCount"), 50),
  };
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
    ...driverBootPayload.execution,
    profilePrompt: "",
    session: {
      ...driverBootPayload.execution.session,
      additionalDirectories: [],
      context: {
        ...driverBootPayload.execution.session.context,
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
  scenario: Scenario;
  startInput: (paths: StartInputArgs) => DriverStartInput;
  apiKey: string;
  model: string;
  isOpenCode: boolean;
}): Promise<TrialMetrics> {
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
  const kernel = new AgentDriverKernelCore({
    backendFactory: (i) => AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(i),
    hostPorts: {
      permission: { request: async () => input.scenario.permission },
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
  let ok = false;
  let error: string | null = null;
  const deltaTimestamps: number[] = [];
  let outputText = "";

  try {
    const bootStart = Date.now();
    await withTimeout("boot", BOOT_TIMEOUT_MS, kernel.start(input.startInput(args)));
    bootMs = Date.now() - bootStart;

    const dispatchStart = Date.now();
    const dispatch = kernel.dispatch({
      commandId: `ttft-${input.runtime}-cmd`,
      input: { text: input.scenario.prompt },
      kind: "input.start",
      requestId: `ttft-${input.runtime}-req`,
      runId: DRIVER_TEST_IDS.runId,
    });

    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), TURN_TIMEOUT_MS),
    );
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
    await dispatch.catch(() => {});
    if (input.scenario.marker) {
      try {
        const content = await readFile(join(paths.cwd, input.scenario.marker.file), "utf8");
        fileCreated = content
          .trim()
          .toLowerCase()
          .includes(input.scenario.marker.content.toLowerCase());
      } catch {
        fileCreated = false;
      }
    }
    const textOk =
      totalMs !== null &&
      outputText.trim().toLowerCase().includes(input.scenario.expect.toLowerCase());
    ok = input.scenario.marker ? textOk && fileCreated === true : textOk;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await kernel.stop("bench.stop").catch(() => {});
    await paths.cleanup().catch(() => {});
  }

  const gaps: number[] = [];
  for (let i = 1; i < deltaTimestamps.length; i += 1) {
    gaps.push(deltaTimestamps[i]! - deltaTimestamps[i - 1]!);
  }

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
    ok,
    error,
  };
}

const TOOL_PROMPT =
  "Create a file named marker.txt in the current directory containing exactly the word ready, then reply with exactly: done.";
const TOOL_SYSTEM = "You are a coding agent. Use tools to complete the task, then reply concisely.";
const TOOL_MARKER = { file: "marker.txt", content: "ready" } as const;

const SCENARIOS: Scenario[] = [
  {
    id: "no_tool",
    prompt: "Reply with exactly one lowercase word: pong. Do not call tools.",
    systemPrompt: "Reply with exactly one lowercase word: pong. Do not call tools.",
    permission: "allow_once",
    expect: "pong",
  },
  {
    // Long output to measure streaming cadence (inter-chunk gaps) with many deltas.
    id: "long_output",
    prompt:
      "Without calling any tools, write a single paragraph of about 200 words describing how a compiler works. Plain prose only.",
    systemPrompt: "You are a helpful assistant. Do not call tools.",
    permission: "allow_once",
    expect: "compiler",
  },
  {
    // yolo target: tool auto-allowed.
    id: "tool_write_allow",
    prompt: TOOL_PROMPT,
    systemPrompt: TOOL_SYSTEM,
    permission: "allow_once",
    expect: "done",
    marker: TOOL_MARKER,
  },
  {
    // current supervised default effect: tool rejected (== non-interactive / 5-min timeout).
    id: "tool_write_reject",
    prompt: TOOL_PROMPT,
    systemPrompt: TOOL_SYSTEM,
    permission: "reject_once",
    expect: "done",
    marker: TOOL_MARKER,
  },
];

async function main(): Promise<void> {
  const trials = Number(readEnv("TTFT_TRIALS") ?? "5");
  const requested = (readEnv("TTFT_RUNTIMES") ?? "claude,openai,opencode")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as RuntimeId[];
  const anthropicKey =
    readEnv("ANTHROPIC_API_KEY") ?? readEnv("AGENT_DRIVER_LIVE_ANTHROPIC_API_KEY");
  const openaiKey = readEnv("OPENAI_API_KEY") ?? readEnv("AGENT_DRIVER_LIVE_OPENAI_API_KEY");
  const claudeModel = readEnv("AGENT_DRIVER_LIVE_ANTHROPIC_MODEL") ?? "claude-sonnet-4-5";
  const openaiModel = readEnv("AGENT_DRIVER_LIVE_OPENAI_MODEL") ?? "gpt-5.4";
  const opencodeProvider = (readEnv("TTFT_OPENCODE_PROVIDER") ?? "openai") as
    | "openai"
    | "anthropic";
  const scenarioFilter = new Set<ScenarioId>(
    (readEnv("TTFT_SCENARIOS") ?? "no_tool,long_output,tool_write_allow,tool_write_reject")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as ScenarioId[],
  );

  const cells: CellResult[] = [];

  const runCell = async (
    runtime: RuntimeId,
    scenario: Scenario,
    model: string,
    build: (paths: StartInputArgs) => DriverStartInput,
    apiKey: string,
    isOpenCode: boolean,
  ): Promise<void> => {
    process.stdout.write(`\n[${runtime}/${scenario.id}] model=${model} warmup...`);
    await runTrial({ runtime, scenario, startInput: build, apiKey, model, isOpenCode }).catch(
      () => undefined,
    );
    const results: TrialMetrics[] = [];
    for (let i = 0; i < trials; i += 1) {
      const m = await runTrial({ runtime, scenario, startInput: build, apiKey, model, isOpenCode });
      results.push(m);
      process.stdout.write(
        ` t${i + 1}=${m.ok ? "ok" : "FAIL"}(ttft=${m.ttftMs ?? "-"},total=${m.totalMs ?? "-"})`,
      );
    }
    cells.push({ runtime, scenario: scenario.id, model, trials: results, agg: aggregate(results) });
  };

  for (const scenario of SCENARIOS.filter((s) => scenarioFilter.has(s.id))) {
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

  await mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = readEnv("TTFT_STAMP") ?? "latest";
  const results = { generatedStamp: stamp, trials, cells };
  await writeFile(join(OUTPUT_DIR, `results-${stamp}.json`), JSON.stringify(results, null, 2));

  const lines: string[] = [
    `# Driver TTFT / streaming benchmark (${stamp})`,
    "",
    `trials per cell: ${trials} (+1 warmup discarded)`,
    "",
    "| runtime | scenario | model | ok% | file% | boot p50 | ttft p50 | ttft p95 | firstText p50 | total p50 | interChunk p50/p95 | deltas |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const fmt = (v: number | null): string => (v === null ? "-" : `${Math.round(v)}`);
  const pct = (v: number | null): string => (v === null ? "-" : `${Math.round(v * 100)}%`);
  for (const c of cells) {
    lines.push(
      `| ${c.runtime} | ${c.scenario} | ${c.model} | ${pct(c.agg.okRate)} | ${pct(c.agg.fileCreatedRate)} | ${fmt(c.agg.bootP50)} | ${fmt(c.agg.ttftP50)} | ${fmt(c.agg.ttftP95)} | ${fmt(c.agg.firstTextP50)} | ${fmt(c.agg.totalP50)} | ${fmt(c.agg.interChunkP50)}/${fmt(c.agg.interChunkP95)} | ${fmt(c.agg.deltaCountP50)} |`,
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
