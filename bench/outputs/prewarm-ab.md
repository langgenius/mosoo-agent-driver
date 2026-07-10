# Prewarm A/B — Claude runtime TTFT

Experiment: `AGENT_DRIVER_CLAUDE_PREWARM` off vs on, `claude-sonnet-4-5`,
`no_tool` scenario (pure time-to-first-token), 5 trials each (+1 warmup),
same machine/session, live Anthropic API.

Reproduce (from `apps/driver`):

```sh
AGENT_DRIVER_CLAUDE_PREWARM=0 TTFT_TRIALS=5 TTFT_RUNTIMES=claude TTFT_SCENARIOS=no_tool bun bench/ttft-bench.ts
AGENT_DRIVER_CLAUDE_PREWARM=1 TTFT_TRIALS=5 TTFT_RUNTIMES=claude TTFT_SCENARIOS=no_tool bun bench/ttft-bench.ts
```

These numbers were captured when prewarm ran synchronously inside
`backend.start()`, so the historical `boot p50` includes the prewarm cost. The
current implementation is opt-in, default-off, and launches prewarm
asynchronously without gating the Driver `ready` handshake. Re-run the commands
above for current behavior; do not use the table as a current readiness-latency
claim.

| config          | TTFT p50 | TTFT p95 | boot p50 | per-trial TTFT (ms)          |
| --------------- | -------- | -------- | -------- | ---------------------------- |
| prewarm **off** | 6992     | 8366     | ~0       | 8366, 7008, 6992, 6396, 6629 |
| prewarm **on**  | **4870** | **4896** | 2225     | 4870, 4882, 4896, 4634, 4411 |

Result: **−2122 ms (−30%) at p50, −3470 ms (−41%) at p95.**

## Why

Without prewarm, `@anthropic-ai/claude-agent-sdk` spawns its native CLI lazily
on the first `query()` iteration, so the whole spawn + initialize handshake
lands inside the first turn's time-to-first-token. `startup()` moves that into
an earlier prewarm race, so the first turn can write to a ready process when
prewarm finishes first. In the current implementation this work is non-blocking:
the Driver can become ready before prewarm completes, and an early first turn
falls back to a cold spawn.

In that historical synchronous-prewarm sample, variance was narrower (on =
4411–4896 ms vs off = 6396–8366 ms). In the current asynchronous implementation,
the CLI-spawn cost leaves the first turn's critical path only when prewarm wins
the race; this table does not establish current variance or predictability.

Note: absolute numbers are environment-relative (laptop, shared key); occasional
API-side throttling produces outliers in individual runs (a single 47 s and a
single 19 s TTFT were observed in a separate noisier 3-trial run and are not in
this table). Treat the five-trial p50/p95 above as descriptive historical data,
not a stability or production-performance claim.
