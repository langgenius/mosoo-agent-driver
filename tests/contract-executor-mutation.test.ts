import { describe, expect, test } from "bun:test";

import {
  applyCommittedMutation,
  applyPreviewUpdate,
  applySyncPayload,
  coalescePreviewUpdates,
  committedMutationSchema,
  createPreviewBuffer,
  initializeParamsSchema,
  initializeResultSchema,
  jsonByteLength,
  previewUpdateSchema,
  validatePreviewBatch,
  validateSessionSnapshot,
} from "../src/contract";
import type {
  AuthorityOperation,
  CommittedMutation,
  Interaction,
  Item,
  PreviewUpdate,
  Run,
  Session,
  SessionSnapshot,
} from "../src/contract";
import { createDriverId } from "../src/protocol/id";
import type { DriverId } from "../src/protocol/id";

const time = "2026-07-16T08:00:00.000Z";

function session(id = createDriverId()): Session {
  return {
    id,
    status: "open",
    createdAt: time,
    updatedAt: time,
    capabilities: {
      "interaction.input": {},
      "interaction.permission": {},
      "run.child": {},
    },
    config: [],
  };
}

function snapshot(sessionValue = session()): SessionSnapshot {
  return validateSessionSnapshot({
    protocolVersion: 2,
    revision: 0,
    capturedAt: time,
    session: sessionValue,
    runs: [],
    items: [],
    interactions: [],
  });
}

function activeRun(id = createDriverId()): Run {
  return {
    id,
    status: "active",
    origin: "user",
    input: [{ type: "text", text: "work" }],
    startedAt: time,
  };
}

function activeTool(runId: string, id = "tool-1"): Extract<Item, { kind: "tool" }> {
  return {
    id,
    runId,
    kind: "tool",
    status: "active",
    createdAt: time,
    updatedAt: time,
    audience: "participants",
    name: "shell",
    category: "execute",
    origin: "provider",
  };
}

function permission(
  runId: string,
  itemId: string,
  id = createDriverId(),
): Extract<Interaction, { kind: "permission" }> {
  return {
    id,
    runId,
    itemId,
    kind: "permission",
    status: "open",
    blocking: true,
    createdAt: time,
    expiresAt: "2026-07-16T08:05:00.000Z",
    audience: "participants",
    request: {
      title: "Run command",
      subject: { type: "item", itemId },
      options: [
        { id: "allow", label: "Allow", effect: "allow", scope: "once" },
        { id: "deny", label: "Deny", effect: "deny", scope: "once" },
      ],
    },
  };
}

function mutation(
  state: SessionSnapshot,
  operations: readonly AuthorityOperation[],
  committedAt = time,
): CommittedMutation {
  return committedMutationSchema.parse({
    mutationId: createDriverId(),
    sessionId: state.session.id,
    baseRevision: state.revision,
    revision: state.revision + 1,
    committedAt,
    cause: { type: "system", name: "test" },
    operations,
  });
}

function protocolLimits(overrides: Record<string, number> = {}) {
  return {
    authorityFlushIntervalMs: 10,
    maxCommandBytes: 1_024,
    maxFrameBytes: 4_096,
    maxInlineBytes: 128,
    maxInteractionTtlMs: 60_000,
    maxMutationBatchCount: 16,
    maxMutationBytes: 1_024,
    maxPendingCommandBytes: 4_096,
    maxPendingMutationBytes: 4_096,
    maxPreviewBatchBytes: 1_024,
    maxPreviewBatchUpdates: 16,
    maxSnapshotBytes: 2_048,
    maxSubscriberQueueBytes: 4_096,
    maxSubscriptionsPerSession: 8,
    previewFlushIntervalMs: 10,
    previewReplaceIntervalMs: 100,
    ...overrides,
  };
}

function append(itemId: string, streamId: string, sequence: number, text: string): PreviewUpdate {
  return {
    itemId,
    streamId,
    channel: "message.text",
    segment: 0,
    op: "append",
    fromSequence: sequence,
    throughSequence: sequence,
    text,
  };
}

describe("contract authority reducer", () => {
  test("rejects only a genuine forward mutation gap", () => {
    const initial = snapshot();
    const first = mutation(initial, [{ entity: "run", op: "put", value: activeRun() }]);
    const current = applyCommittedMutation(initial, first);
    const futureBase = { ...current, revision: 2 };
    const third = mutation(futureBase, [
      { entity: "run", op: "put", value: { ...current.runs[0]!, usage: { total: 1 } } },
    ]);

    expect(() =>
      applySyncPayload(current, {
        baseRevision: 2,
        mutations: [third],
        throughRevision: 3,
        type: "mutations",
      }),
    ).toThrow("base revision 2");
  });

  test("rejects a fully replayed mutation batch from another Session", () => {
    const initial = snapshot();
    const current = applyCommittedMutation(
      initial,
      mutation(initial, [{ entity: "run", op: "put", value: activeRun() }]),
    );
    const other = snapshot();

    expect(() =>
      applySyncPayload(current, {
        baseRevision: 0,
        mutations: [mutation(other, [{ entity: "run", op: "put", value: activeRun() }])],
        throughRevision: 1,
        type: "mutations",
      }),
    ).toThrow("identities do not match");
  });

  test("validates local state even when a mutation sync is empty", () => {
    const invalid = {
      ...snapshot(),
      runs: [activeRun()],
      session: {
        ...session(),
        closedAt: time,
        status: "closed",
      },
    } as SessionSnapshot;

    expect(() =>
      applySyncPayload(invalid, {
        baseRevision: 0,
        mutations: [],
        throughRevision: 0,
        type: "mutations",
      }),
    ).toThrow("A closed Session cannot retain active Runs or open Interactions");
  });

  test.each(["snapshot", "mutations"] as const)(
    "enforces inline admission while applying a %s sync",
    (type) => {
      const initial = snapshot();
      const run = {
        ...activeRun(),
        input: [{ data: "aGk=", mediaType: "text/plain", type: "inline_blob" as const }],
      };
      const committed = mutation(initial, [{ entity: "run", op: "put", value: run }]);
      const payload =
        type === "snapshot"
          ? {
              minimumResumeRevision: 0,
              snapshot: applyCommittedMutation(initial, committed),
              type,
            }
          : { baseRevision: 0, mutations: [committed], throughRevision: 1, type };

      expect(() =>
        applySyncPayload(type === "snapshot" ? undefined : initial, payload, {
          maxInlineBytes: 1,
          maxMutationBatchCount: 16,
          maxMutationBytes: 64 * 1_024,
          maxSnapshotBytes: 64 * 1_024,
        }),
      ).toThrow("inline Blob");
    },
  );

  test("enforces the mutation count while applying sync", () => {
    const initial = snapshot();
    const run = activeRun();
    const first = mutation(initial, [{ entity: "run", op: "put", value: run }]);
    const atOne = applyCommittedMutation(initial, first);
    const second = mutation(atOne, [
      { entity: "run", op: "put", value: { ...run, usage: { total: 1 } } },
    ]);

    expect(() =>
      applySyncPayload(
        initial,
        {
          baseRevision: 0,
          mutations: [first, second],
          throughRevision: 2,
          type: "mutations",
        },
        {
          maxInlineBytes: 1_024,
          maxMutationBatchCount: 1,
          maxMutationBytes: 64 * 1_024,
          maxSnapshotBytes: 64 * 1_024,
        },
      ),
    ).toThrow("mutation count");
  });

  test.each(["snapshot", "mutations"] as const)(
    "enforces the encoded object limit while applying a %s sync",
    (type) => {
      const initial = snapshot();
      const committed = mutation(initial, [{ entity: "run", op: "put", value: activeRun() }]);
      const admitted = type === "snapshot" ? initial : committed;
      const bytes = new TextEncoder().encode(JSON.stringify(admitted)).byteLength;
      const payload =
        type === "snapshot"
          ? { minimumResumeRevision: 0, snapshot: initial, type }
          : { baseRevision: 0, mutations: [committed], throughRevision: 1, type };
      const limits = {
        maxInlineBytes: 1_024,
        maxMutationBatchCount: 16,
        maxMutationBytes: type === "mutations" ? bytes : 64 * 1_024,
        maxSnapshotBytes: type === "snapshot" ? bytes : 64 * 1_024,
      };

      expect(() =>
        applySyncPayload(type === "snapshot" ? undefined : initial, payload, limits),
      ).not.toThrow();
      expect(() =>
        applySyncPayload(type === "snapshot" ? undefined : initial, payload, {
          ...limits,
          ...(type === "snapshot"
            ? { maxSnapshotBytes: bytes - 1 }
            : { maxMutationBytes: bytes - 1 }),
        }),
      ).toThrow("byte limit");
    },
  );

  test("rejects cyclic, active, and overlapping Run retries", () => {
    const firstId = createDriverId();
    const secondId = createDriverId();
    const terminal = (id: DriverId, parentRunId: DriverId): Run => ({
      ...activeRun(id),
      parentRunId,
      status: "completed",
      endedAt: time,
      finishReason: "success",
    });

    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        runs: [terminal(firstId, secondId), terminal(secondId, firstId)],
      }),
    ).toThrow("cyclic parent chain");

    const active = activeRun(firstId);
    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        capturedAt: "2026-07-16T08:05:00.000Z",
        runs: [
          active,
          {
            ...activeRun(secondId),
            retryOf: active.id,
            status: "failed",
            endedAt: time,
            error: { code: "failed", message: "failed", retryable: true },
          },
        ],
      }),
    ).toThrow("only retry a terminal Run");

    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        capturedAt: "2026-07-16T08:05:00.000Z",
        runs: [
          {
            ...activeRun(firstId),
            status: "completed",
            endedAt: "2026-07-16T08:05:00.000Z",
            finishReason: "success",
          },
          {
            ...activeRun(secondId),
            retryOf: firstId,
            startedAt: "2026-07-16T08:04:00.000Z",
          },
        ],
      }),
    ).toThrow("cannot be earlier");
  });

  test("keeps an open Interaction request immutable", () => {
    const initial = snapshot();
    const run = activeRun();
    const tool = activeTool(run.id);
    const request = permission(run.id, tool.id);
    const waiting = applyCommittedMutation(
      initial,
      mutation(initial, [
        { op: "put", entity: "run", value: run },
        { op: "put", entity: "item", value: tool },
        { op: "put", entity: "interaction", value: request },
      ]),
    );

    expect(() =>
      applyCommittedMutation(
        waiting,
        mutation(waiting, [
          {
            op: "put",
            entity: "interaction",
            value: { ...request, request: { ...request.request, title: "Changed" } },
          },
        ]),
      ),
    ).toThrow("identity fields cannot change");

    expect(() =>
      applyCommittedMutation(
        waiting,
        mutation(waiting, [
          {
            entity: "interaction",
            op: "put",
            value: { ...request, expiresAt: "2026-07-16T08:10:00.000Z" },
          },
        ]),
      ),
    ).toThrow("expiration cannot change");
  });

  test("keeps first-commit entity order across Upserts", () => {
    const initial = snapshot();
    const run = activeRun();
    const first = activeTool(run.id, "first");
    const second = activeTool(run.id, "second");
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [
        { op: "put", entity: "run", value: run },
        { op: "put", entity: "item", value: first },
        { op: "put", entity: "item", value: second },
      ]),
    );
    const updated = applyCommittedMutation(
      running,
      mutation(running, [{ op: "put", entity: "item", value: { ...first, title: "Updated" } }]),
    );

    expect(updated.items.map((item) => item.id)).toEqual(["first", "second"]);
  });

  test("keeps Item semantic identity immutable", () => {
    const initial = snapshot();
    const run = activeRun();
    const message = {
      id: "message",
      runId: run.id,
      kind: "message" as const,
      status: "active" as const,
      createdAt: time,
      updatedAt: time,
      audience: "participants" as const,
      role: "agent" as const,
      content: [],
    };
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [
        { op: "put", entity: "run", value: run },
        { op: "put", entity: "item", value: message },
      ]),
    );

    expect(() =>
      applyCommittedMutation(
        running,
        mutation(running, [{ op: "put", entity: "item", value: { ...message, role: "user" } }]),
      ),
    ).toThrow("identity fields cannot change");
    expect(() =>
      validateSessionSnapshot({
        ...running,
        items: [{ ...message, role: "user", phase: "final" }],
      }),
    ).toThrow("cannot declare an Agent output phase");
  });

  test("compares immutable JSON independently of object key order", () => {
    const initial = snapshot();
    const run: Run = {
      ...activeRun(),
      input: [{ type: "json", value: { first: 1, second: 2 } }],
    };
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [{ op: "put", entity: "run", value: run }]),
    );
    const updated = applyCommittedMutation(
      running,
      mutation(running, [
        {
          op: "put",
          entity: "run",
          value: {
            ...run,
            input: [{ type: "json", value: { second: 2, first: 1 } }],
            usage: { total: 1 },
          },
        },
      ]),
    );

    expect(updated.runs[0]?.usage?.total).toBe(1);
  });
});

describe("contract Preview lane", () => {
  test("rejects empty appends and sequence zero", () => {
    expect(previewUpdateSchema.safeParse(append("message", "text", 1, "")).success).toBe(false);
    expect(
      previewUpdateSchema.safeParse({
        itemId: "message",
        streamId: "text",
        channel: "message.text",
        segment: 0,
        op: "replace",
        throughSequence: 0,
        text: "",
      }).success,
    ).toBe(false);
  });

  test("coalesces independent streams without changing per-stream order", () => {
    const updates = coalescePreviewUpdates([
      append("message", "text", 1, "a"),
      append("other", "text", 1, "x"),
      append("message", "text", 2, "b"),
    ]);

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ itemId: "message", text: "ab", throughSequence: 2 });
    expect(updates[1]).toMatchObject({ itemId: "other", text: "x" });
  });

  test("uses replace to heal gaps", () => {
    const gap = applyPreviewUpdate(undefined, append("message", "text", 2, "b"));
    expect(gap).toEqual({
      status: "gap",
      state: { text: undefined, throughSequence: 2 },
    });

    expect(
      applyPreviewUpdate(gap.state, {
        itemId: "message",
        streamId: "text",
        channel: "message.text",
        segment: 0,
        op: "replace",
        throughSequence: 1,
        text: "a",
      }),
    ).toEqual({ status: "duplicate", state: gap.state });

    const replaced = applyPreviewUpdate(gap.state, {
      itemId: "message",
      streamId: "text",
      channel: "message.text",
      segment: 0,
      op: "replace",
      throughSequence: 2,
      text: "ab",
    });
    expect(replaced).toEqual({
      status: "applied",
      state: { text: "ab", throughSequence: 2 },
    });
  });

  test("drops pending Preview data instead of growing behind a slow flush", async () => {
    let release: (() => void) | undefined;
    const firstFlush = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dropped: PreviewUpdate[][] = [];
    let flushes = 0;
    const buffer = createPreviewBuffer({
      maxBytes: 1024,
      maxDelayMs: 1000,
      maxUpdates: 1,
      flush: async () => {
        flushes += 1;
        await firstFlush;
      },
      onDrop: (updates) => dropped.push([...updates]),
    });

    buffer.push(append("message", "text", 1, "a"));
    buffer.push(append("message", "text", 2, "b"));
    expect(dropped).toHaveLength(1);
    expect(buffer.size).toBe(0);

    release?.();
    await buffer.flush();
    expect(flushes).toBe(1);
    buffer.dispose();
  });

  test("never emits an update array above its byte limit", async () => {
    const maxBytes = 300;
    const batches: PreviewUpdate[][] = [];
    const buffer = createPreviewBuffer({
      maxBytes,
      maxDelayMs: 1000,
      maxUpdates: 10,
      flush: (updates) => {
        batches.push([...updates]);
      },
    });

    buffer.push(append("first", "text", 1, "x".repeat(70)));
    buffer.push(append("second", "text", 1, "x".repeat(70)));
    await buffer.flush();

    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => jsonByteLength(batch) <= maxBytes)).toBe(true);
    buffer.dispose();
  });

  test("owns an admitted Preview update after push", async () => {
    const batches: PreviewUpdate[][] = [];
    const buffer = createPreviewBuffer({
      flush: (updates) => {
        batches.push([...updates]);
      },
      maxBytes: 1024,
      maxDelayMs: 1000,
      maxUpdates: 10,
    });
    const update = append("message", "text", 1, "safe");

    buffer.push(update);
    const admittedBytes = buffer.bytes;
    update.text = "mutated".repeat(100);
    await buffer.flush();

    expect(batches).toEqual([[append("message", "text", 1, "safe")]]);
    expect(admittedBytes).toBe(jsonByteLength(batches[0]));
    buffer.dispose();
  });

  test("rejects malformed Preview updates before admission", () => {
    const dropped: PreviewUpdate[][] = [];
    const buffer = createPreviewBuffer({
      flush: () => {},
      maxBytes: 1024,
      maxDelayMs: 1000,
      maxUpdates: 10,
      onDrop: (updates) => dropped.push([...updates]),
    });

    expect(() =>
      buffer.push({ ...append("message", "text", 1, "x"), throughSequence: 0 }),
    ).toThrow();
    expect({ bytes: buffer.bytes, dropped, size: buffer.size }).toEqual({
      bytes: 0,
      dropped: [],
      size: 0,
    });
    buffer.dispose();
  });

  test("admits an exact Preview byte budget and drops one byte below it", async () => {
    const update = append("message", "text", 1, "exact");
    const maxBytes = jsonByteLength([previewUpdateSchema.parse(update)]);
    const batches: PreviewUpdate[][] = [];
    const dropped: PreviewUpdate[][] = [];
    const exact = createPreviewBuffer({
      flush: (updates) => {
        batches.push([...updates]);
      },
      maxBytes,
      maxDelayMs: 1000,
      maxUpdates: 10,
    });
    const undersized = createPreviewBuffer({
      flush: () => {},
      maxBytes: maxBytes - 1,
      maxDelayMs: 1000,
      maxUpdates: 10,
      onDrop: (updates) => dropped.push([...updates]),
    });

    exact.push(update);
    undersized.push(update);
    await exact.flush();

    expect(exact.bytes).toBe(0);
    expect(batches).toEqual([[update]]);
    expect(jsonByteLength(batches[0])).toBe(maxBytes);
    expect(dropped).toEqual([[update]]);
    exact.dispose();
    undersized.dispose();
  });

  test.each([2_147_483_647, 2_147_483_648, Number.MAX_SAFE_INTEGER])(
    "accepts a safe Preview delay %p and clamps only the platform timer",
    (maxDelayMs) => {
      const buffer = createPreviewBuffer({
        flush: () => {},
        maxBytes: 1024,
        maxDelayMs,
        maxUpdates: 10,
      });

      buffer.push(append("message", "text", 1, "pending"));
      expect(buffer.size).toBe(1);
      buffer.dispose();
    },
  );

  test.each([
    { maxBytes: Number.NaN, maxDelayMs: 1, maxUpdates: 1 },
    { maxBytes: 1.5, maxDelayMs: 1, maxUpdates: 1 },
    { maxBytes: 1, maxDelayMs: 0, maxUpdates: 1 },
    { maxBytes: 1, maxDelayMs: 1.5, maxUpdates: 1 },
    { maxBytes: 1, maxDelayMs: Number.POSITIVE_INFINITY, maxUpdates: 1 },
    { maxBytes: 1, maxDelayMs: 1, maxUpdates: 1.5 },
  ])("rejects an invalid Preview buffer limit: %p", (limits) => {
    expect(() => createPreviewBuffer({ flush: () => {}, ...limits })).toThrow("positive integers");
  });

  test("disposal clears buffered data and prevents a delayed flush", async () => {
    let flushes = 0;
    const buffer = createPreviewBuffer({
      flush: () => {
        flushes += 1;
      },
      maxBytes: 1024,
      maxDelayMs: 5,
      maxUpdates: 10,
    });

    buffer.push(append("message", "text", 1, "pending"));
    buffer.dispose();
    await Bun.sleep(20);
    await buffer.flush();

    expect({ bytes: buffer.bytes, flushes, size: buffer.size }).toEqual({
      bytes: 0,
      flushes: 0,
      size: 0,
    });
    expect(() => buffer.push(append("message", "text", 2, "late"))).toThrow("disposed");
  });

  test("requires Preview to target a compatible active Item", () => {
    const initial = snapshot();
    const run = activeRun();
    const state = applyCommittedMutation(
      initial,
      mutation(initial, [
        { op: "put", entity: "run", value: run },
        { op: "put", entity: "item", value: activeTool(run.id) },
      ]),
    );

    expect(() =>
      validatePreviewBatch(state, {
        sessionId: state.session.id,
        runId: run.id,
        emittedAt: time,
        updates: [append("tool-1", "text", 1, "not a message")],
      }),
    ).toThrow("cannot target an Item of kind tool");
  });
});

describe("contract closed core", () => {
  test("keeps Coordinator resource policies out of peer negotiation", () => {
    const initialize = {
      protocolVersion: 2,
      role: "observer",
      implementation: { name: "observer", version: "1" },
      capabilities: {},
      limits: { maxFrameBytes: 1024 },
    };

    expect(initializeParamsSchema.safeParse(initialize).success).toBe(true);
    expect(
      initializeParamsSchema.safeParse({
        ...initialize,
        limits: { ...initialize.limits, maxPendingCommandBytes: 1 },
      }).success,
    ).toBe(false);
  });

  test.each([
    "maxCommandBytes",
    "maxMutationBytes",
    "maxPreviewBatchBytes",
    "maxSnapshotBytes",
  ] as const)("rejects %s that cannot fit in maxFrameBytes", (field) => {
    const limits = protocolLimits({ [field]: 4_096, maxFrameBytes: 4_096 });

    expect(
      initializeResultSchema.safeParse({
        protocolVersion: 2,
        implementation: { name: "coordinator", version: "1" },
        capabilities: {},
        limits,
      }).success,
    ).toBe(false);
  });
});
