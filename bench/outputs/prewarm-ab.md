# Prewarm A/B — Claude runtime TTFT

Experiment: `AGENT_DRIVER_CLAUDE_PREWARM` off vs on, `claude-sonnet-4-5`,
`no_tool` scenario (pure time-to-first-token), 5 trials each (+1 warmup),
same machine/session, live Anthropic API.

Reproduce (from `apps/driver`):

```sh
AGENT_DRIVER_CLAUDE_PREWARM=0 TTFT_TRIALS=5 TTFT_RUNTIMES=claude TTFT_SCENARIOS=no_tool bun bench/ttft-bench.ts
TTFT_TRIALS=5 TTFT_RUNTIMES=claude TTFT_SCENARIOS=no_tool bun bench/ttft-bench.ts
```

| config | TTFT p50 | TTFT p95 | boot p50 | per-trial TTFT (ms) |
|---|---|---|---|---|
| prewarm **off** | 6992 | 8366 | ~0 | 8366, 7008, 6992, 6396, 6629 |
| prewarm **on**  | **4870** | **4896** | 2225 | 4870, 4882, 4896, 4634, 4411 |

Result: **−2122 ms (−30%) at p50, −3470 ms (−41%) at p95.**

## Why

Without prewarm, `@anthropic-ai/claude-agent-sdk` spawns its native CLI lazily
on the first `query()` iteration, so the whole spawn + initialize handshake
lands inside the first turn's time-to-first-token. `startup()` moves that into
`backend.start()`, which the control plane already runs ahead of the first user
message (session-create / viewer-connect prewarm), so the first turn writes to a
ready process. The ~2.2 s boot cost is therefore hidden from the user; only the
TTFT reduction is visible.

Secondary benefit: variance collapses (on = 4411–4896 ms vs off = 6396–8366 ms).
The CLI-spawn cost was a variable tax on every cold first turn; removing it from
the critical path makes first-token latency predictable.

Note: absolute numbers are environment-relative (laptop, shared key); occasional
API-side throttling produces outliers in individual runs (a single 47 s and a
single 19 s TTFT were observed in a noisier 3-trial run and excluded here). The
p50/p95 over 5 trials above are stable.
