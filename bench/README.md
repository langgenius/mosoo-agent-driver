# Driver TTFT / streaming benchmark

`ttft-bench.ts` drives the **real driver kernel + provider registry** (the same
code path as the `*-live.test.ts` suites) against live provider APIs and
measures, per provider runtime and per scenario:

| metric              | meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `bootMs`            | `kernel.start()` cost (runtime/CLI/SDK init)                         |
| `ttftMs`            | dispatch → first `message.delta` event (time to first token)         |
| `firstTextMs`       | dispatch → first non-empty text delta                                |
| `totalMs`           | dispatch → `run.completed`                                           |
| `interChunkP50/P95` | gap distribution between consecutive text deltas (streaming cadence) |
| `markerPresent`     | for tool scenarios: did any marker file exist                        |
| `fileCreated`       | for tool scenarios: did the agent actually write the marker file     |
| `taskCompleted`     | did the requested output and marker get produced                     |
| `policyEnforced`    | for the reject scenario: was a request observed and the write denied |

The execution permission policy and permission host port are both explicit per
scenario. `tool_write_allow` uses `full_access`; `tool_write_reject` uses
`supervised` and a rejecting host handler. The file-creation rate is the honest
task-completion signal, while `policyEnforced` is the security signal. A write
that bypasses the rejecting host is task completion but failed policy
enforcement; it is never reported as a generic success.

Latency percentiles use trials that reached `run.completed` without a harness or
cleanup error. They do not depend on task completion, so a correctly rejected
turn still contributes timing data. `task%`, `policy%`, and `turn%` remain
separate in the summary.

## Scenarios

- `no_tool` — one-word reply; pure TTFT.
- `long_output` — ~200-word prose; streaming cadence (many deltas).
- `tool_write_allow` — create a file (permission auto-allowed = yolo target).
- `tool_write_reject` — same task, explicitly supervised and rejected by the
  host; policy enforcement requires an observed permission request and an absent
  marker file.

## Run

```sh
# from apps/driver
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... bun bench/ttft-bench.ts
```

Env knobs:

- `TTFT_TRIALS=5` trials per cell (+1 discarded warmup).
- `TTFT_RUNTIMES=claude,openai,opencode` subset to run.
- `TTFT_SCENARIOS=no_tool,long_output,tool_write_allow,tool_write_reject`.
- `TTFT_OPENCODE_PROVIDER=openai|anthropic` backing provider for the opencode/ACP runtime.
- `AGENT_DRIVER_LIVE_ANTHROPIC_MODEL` / `AGENT_DRIVER_LIVE_OPENAI_MODEL` model overrides.
- `TTFT_BOOT_TIMEOUT_MS=100000` guard against a hung runtime spawn.
- `TTFT_UPDATE_BASELINE=1` writes a local `outputs/baseline.json` candidate.
- `TTFT_STAMP=<name>` labels the run's output files.
- `AGENT_DRIVER_CLAUDE_PREWARM=1` opts into best-effort Claude CLI prewarm. It is
  off by default because it can briefly require a second CLI process and exhaust
  memory-constrained containers. Prewarm starts asynchronously and never gates
  the Driver `ready` handshake; if the first turn wins the race, that turn uses
  the normal cold path.

The harness fails instead of writing an empty result when no requested cell has
usable credentials, and `TTFT_TRIALS` / `TTFT_BOOT_TIMEOUT_MS` must be positive
integers.

Outputs land in `outputs/` (`results-<stamp>.json` + `summary-<stamp>.md`,
gitignored). There is no committed current baseline. Compare only runs using the
same model, permission policy, runtime versions, and environment; commit a new
baseline only after the run and metadata have been independently verified.

## Notes

- With prewarm disabled, `boot` is ~1 ms for the Claude runtime because
  `@anthropic-ai/claude-agent-sdk` defers spawning its CLI until the first
  `query()`, so the spawn cost lands inside `ttftMs`. Opt-in prewarm moves that
  work earlier when it wins the race without delaying readiness.
- Local numbers are relative-only: a laptop container's cold start ≠ CF
  Containers, and there is no CF Queue / DO hop here. This harness isolates the
  **runtime-boundary** costs (permission round-trips, provider TTFT, streaming
  cadence, CLI/app-server boot); the control-plane hops (queue batch, viewer
  buffer) are measured separately via `runtime.timing.recorded` events.
