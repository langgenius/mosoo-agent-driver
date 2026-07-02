# Driver TTFT / streaming benchmark

`ttft-bench.ts` drives the **real driver kernel + provider registry** (the same
code path as the `*-live.test.ts` suites) against live provider APIs and
measures, per provider runtime and per scenario:

| metric | meaning |
|---|---|
| `bootMs` | `kernel.start()` cost (runtime/CLI/SDK init) |
| `ttftMs` | dispatch → first `message.delta` event (time to first token) |
| `firstTextMs` | dispatch → first non-empty text delta |
| `totalMs` | dispatch → `run.completed` |
| `interChunkP50/P95` | gap distribution between consecutive text deltas (streaming cadence) |
| `fileCreated` | for tool scenarios: did the agent actually write the marker file |
| `ok` | scenario success (expected output, plus file for tool scenarios) |

The permission host port is toggled per scenario, so `tool_write_allow` vs
`tool_write_reject` isolates the **value of the full-access ("yolo") default**
against the current supervised/reject behavior — the file-creation rate is the
honest success signal.

## Scenarios

- `no_tool` — one-word reply; pure TTFT.
- `long_output` — ~200-word prose; streaming cadence (many deltas).
- `tool_write_allow` — create a file (permission auto-allowed = yolo target).
- `tool_write_reject` — same task, permission rejected (supervised default effect).

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
- `TTFT_UPDATE_BASELINE=1` writes `outputs/baseline.json` (committed as the regression baseline).
- `TTFT_STAMP=<name>` labels the run's output files.

Outputs land in `outputs/` (`results-<stamp>.json` + `summary-<stamp>.md`, gitignored);
`outputs/baseline.json` is committed as the reference for before/after comparisons.

## Notes

- `boot` is ~1 ms for the Claude runtime because `@anthropic-ai/claude-agent-sdk`
  defers spawning its CLI until the first `query()`, so the spawn cost lands
  inside `ttftMs` instead — the reason `startup()`/`WarmQuery` prewarm is a
  first-order TTFT lever.
- Local numbers are relative-only: a laptop container's cold start ≠ CF
  Containers, and there is no CF Queue / DO hop here. This harness isolates the
  **runtime-boundary** costs (permission round-trips, provider TTFT, streaming
  cadence, CLI/app-server boot); the control-plane hops (queue batch, viewer
  buffer) are measured separately via `runtime.timing.recorded` events.
