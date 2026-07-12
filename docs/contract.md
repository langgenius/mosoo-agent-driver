# Driver Contract v2

Status: **canonical spec** for the `agent-driver/contract` module. Contract v2 is a clean,
deliberately incompatible replacement for the `2026-05-26` runtime-event/command generation
(`src/runtime-events`, `src/runtime-command`), which stays in place only until the kernel,
backends, and host migrate.

Design inputs: OpenAI Codex app-server protocol (thread/turn/item, July 2026), Agent Client
Protocol v2 (`protocolVersion: 2`), Claude Agent SDK, AG-UI, Vercel AI SDK UIMessage streams,
A2A. The contract must carry **at least** Codex + ACP v2 granularity, because adapters on both
edges translate it to and from those protocols.

## 1. Shape of the problem

A driver runs exactly one agent session inside a sandbox and speaks to one host over a network
transport. Everything the contract says fits in one sentence per direction:

- **Events** (driver → host): "here is what happened in the session, in order."
- **Commands** (host → driver): "do this to the session."

Contract v2 is four planes and nothing else:

| plane       | vocabulary                               | frequency         | loss tolerance                       |
| ----------- | ---------------------------------------- | ----------------- | ------------------------------------ |
| session     | `session.*`, `usage.updated`             | low               | lossless                             |
| turn        | `turn.started`, `turn.completed`         | low               | lossless                             |
| item        | `item.started/updated/delta/completed`   | **high** (deltas) | deltas droppable, snapshots lossless |
| interaction | `permission.*`, `input.*`                | low               | lossless                             |
| ops         | `diagnostic.reported`, `timing.recorded` | low               | lossless                             |

Everything the old contract declared beyond this (86 of 107 kinds were never emitted:
`realtime.*`, `terminal.*`, `account.*`, `hook.*`, `oauth.*`, …) is deleted. Real future needs
use the extension rule (§7).

## 2. Envelope

```ts
interface SessionEvent<K extends SessionEventKind = SessionEventKind> {
  id: string; // ULID, unique per event — dedup/ack token
  seq: number; // per-session monotonic counter assigned by the emitter
  sessionId: string; // ULID
  turnId?: string; // ULID — present on every turn-scoped event
  at: string; // ISO-8601 occurrence time
  kind: K;
  payload: SessionEventPayloadMap[K];
  native?: NativeRef; // provenance: provider + native ids (threadId, itemId, eventName, …)
  traceId?: string; // W3C trace id
  meta?: Record<string, unknown>; // reserved extension bag, never interpreted by the contract
}
```

Deliberate deletions vs the old 18-field envelope:

- `actor`, `origin`, `visibility`, `delivery` — static functions of `kind`, so they are exposed
  as classification helpers (`deliveryOf(kind)`, `visibilityOf(kind)`) instead of being paid
  for on every wire event. Message role lives on the message item where it belongs.
- `schemaVersion` per event — the contract version is negotiated per connection and stamped on
  batches by transports that need it (`CONTRACT_VERSION = 2`). Persistence layers wrap events
  with their own storage version if they need one.
- `correlationId`, `sourceEventId`, `receivedAt`, `runtimeId`, `driverInstanceId` — transport
  and host bookkeeping, not session semantics. `id` is the only identity an event needs.

Addition: **`seq`**. The old contract had no ordering token on the event itself (receipts
carried a server-assigned seq). Emitter-assigned `seq` gives receivers ordering, gap detection,
and an ack high-water mark, and gives the coalescer (§8) a well-defined merge rule.

## 3. Items

An item is one unit of the session transcript. Same lifecycle for every item kind — this is the
single most load-bearing decision, taken from Codex v2 and confirmed by every peer protocol:

```
item.started { item }                 // full initial snapshot
item.delta   { itemId, stream, index?, delta }   // append-only text, droppable
item.updated { itemId, kind, patch }  // field patch, replace-per-field (LWW)
item.completed { item }               // full FINAL snapshot — authoritative
```

`item.completed` is authoritative and may not equal the concatenation of deltas (Codex states
this explicitly for plan items). That property is what makes deltas safely droppable and
coalescible: any consumer that misses deltas is healed by the completed snapshot.

Six typed item kinds plus one open kind:

| kind              | covers                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `message`         | ACP user/agent_message, Codex userMessage/agentMessage, Claude assistant turns                  |
| `reasoning`       | Codex reasoning (summary[] + content[] with indices), ACP agent_thought, Claude thinking        |
| `plan`            | ACP plan entries, Codex turn/plan + todo lists                                                  |
| `command`         | Codex commandExecution (command, cwd, parsed actions, output, exitCode), ACP execute tool calls |
| `file_change`     | Codex fileChange (per-file diff + status), ACP v2 structured Diff                               |
| `tool_call`       | MCP tool calls, Codex dynamicToolCall, ACP generic tool_call (kind/status/locations/rawIO)      |
| `x_*` (extension) | Codex webSearch, imageGeneration, collab/subagent, review mode, context compaction, …           |

Item ids (`itemId`) and interaction ids (`requestId`) are opaque non-empty strings so adapters
can pass vendor ids through without a mapping table. Host-owned ids (`sessionId`, `turnId`,
event `id`) are ULIDs.

Streams for `item.delta`: `text`, `reasoning`, `reasoning_summary`, `output` (+ open). `index`
carries Codex's `summaryIndex`/`contentIndex` so parallel reasoning parts survive round-trips.

## 4. Content blocks

`ContentBlock` is the MCP/ACP v2 shape: `text`, `image`, `audio`, `resource_link`, `resource`,
plus the open rule. Message content, tool output, and turn input all use it. This ends the old
contract's worst granularity loss (images/resources flattened to `"[image: …]"` strings).

## 5. Interaction plane

Permission requests merge ACP v2's option model (host renders options, unknown outcome ≠
approval) with Codex's typed subjects (command/file_change/tool_call detail so UIs can render
rich prompts):

```
permission.requested { requestId, itemId?, title, description?, options[], detail?, expiresAt? }
permission.resolved  { requestId, outcome: selected(optionId) | cancelled | timeout }
```

Decision semantics ride on `PermissionOption.kind` (`allow_once`, `allow_always`,
`reject_once`, `reject_always`, + open) — Codex's `acceptForSession`/amendment decisions map to
options with vendor payloads in `option.meta`.

`input.requested` / `input.resolved` carry Codex `request_user_input` and MCP elicitation:
questions with options, free-form and secret flags, answered by question id.

Both are resolved by the dual commands `permission.resolve` / `input.resolve`. A driver that
receives an outcome it does not understand must treat it as a rejection, never an approval.

## 6. Commands

Flat discriminated union — commands are few, small, and host-issued:

| kind                 | payload                                                   | replaces                                             |
| -------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `turn.start`         | `turnId`, `input: ContentBlock[]`                         | `input.start` (text-only)                            |
| `turn.steer`         | `turnId`, `input: ContentBlock[]`                         | — (new; Codex turn/steer, Claude streaming input)    |
| `turn.cancel`        | `turnId?`, `reason?`                                      | `turn.cancel`                                        |
| `session.stop`       | `reason`                                                  | `session.stop`                                       |
| `session.config.set` | `configId`, `value`                                       | — (new; ACP set_config_option, model/mode switching) |
| `permission.resolve` | `requestId`, `outcome`                                    | binary `allow_once`/`reject_once` decision           |
| `input.resolve`      | `requestId`, `outcome`                                    | — (new)                                              |
| `mcp.execute`        | `requestId`, `serverId`, `toolName`, `arguments` (object) | JSON-string `argumentsJson`                          |

Command fate is reported with `CommandUpdate { commandId, status: accepted → completed | failed
| cancelled, error?, result? }`. Queueing states (`queued`, `delivered`, `expired`) were host
bookkeeping and are gone from the contract.

## 7. Extension & compatibility rules (normative)

Taken from ACP v2, which has the best-articulated version of what every peer does:

1. Every string enum and discriminated union in this contract is **open**. Parsers preserve
   unknown values they can represent and never hard-fail on them.
2. Kinds, item kinds, streams, and detail types beginning with `x_` are implementation
   extensions. Unknown values **without** the prefix are reserved for future contract versions.
3. Unknown event kinds pass envelope validation and flow through pipelines untouched
   (store/forward), but are never projected by default.
4. `meta` fields are opaque. The contract never assigns meaning to their keys.
5. `CONTRACT_VERSION` is a single integer, bumped only for breaking changes. Additions ride on
   capabilities: absence of a capability key means unsupported.

## 8. Transport performance: coalescing and batching

The contract, not the transport, defines merge semantics — so any boundary (oRPC batch, DO →
WebSocket fan-out, SSE replay) can buffer safely:

- **Coalescible kinds**: `item.delta` (same `itemId` + `stream` + `index`: concatenate),
  `item.updated` (same `itemId`: patches merge, later fields win), `usage.updated` (same
  `turnId`: keep last). Everything else is a barrier.
- **Adjacency rule**: only adjacent events merge. Coalescing never reorders events across
  different keys.
- **Identity rule**: a merged event keeps the **last** member's `id`/`seq`/`at` (the ack
  high-water mark stays correct); only the payload is combined.
- `createSessionEventBuffer({ maxCount, maxDelayMs, flush })` implements the reference
  buffer: coalescible events accumulate up to a deadline; barrier kinds flush the whole buffer
  in order immediately.

Losing an individual delta is tolerable by design (§3); losing snapshots is not. `deliveryOf`
encodes exactly that split.

## 9. What the old generation got wrong (and v2's answer)

| debt                                                         | v2 answer                                                |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| 107 declared kinds, ~20 emitted                              | 17 typed kinds + open `x_*`                              |
| payloads mostly unvalidated pass-through                     | zod schemas for every kind, inferred types               |
| two parallel lifecycles (`message.*` family vs `item.*`)     | one item lifecycle for everything                        |
| `tool.call.updated` mega-event (lifecycle by field-sniffing) | typed `tool_call` item + started/updated/delta/completed |
| content flattened to strings                                 | `ContentBlock` end to end                                |
| binary permission decision                                   | option model + typed detail                              |
| no ordering token on events                                  | emitter `seq`                                            |
| no coalescing anywhere                                       | contract-level coalescer + buffer                        |
| hand-rolled validators duplicated driver/host                | one zod source of truth, JSON-Schema exportable          |

## 10. Migration boundary

`agent-driver/contract` is self-contained: it does not import from `runtime-events`,
`runtime-command`, or `protocol/*` except the ULID helpers. The kernel, the three backends, the
oRPC wire, the CMA projections, and the host's `pkgs/runtime-events` copy migrate in follow-up
changes; until then both generations coexist and the old modules are the ones actually wired.
Boot payload (`protocol/boot`, `DRIVER_PROTOCOL_VERSION = 1`) is process bootstrap, not session
semantics — it is unchanged by this contract.
