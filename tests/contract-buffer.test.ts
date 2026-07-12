import { describe, expect, test } from "bun:test";

import {
  coalesceSessionEvents,
  createSessionEventBuffer,
  createSessionEventFactory,
  isCoalescibleKind,
} from "../src/contract";
import type {
  SessionEvent,
  SessionEventInit,
  SessionEventKind,
  SessionEventPayload,
} from "../src/contract";
import { createDriverId } from "../src/protocol/id";

const SESSION_ID = "01J0000000000000000000000K";
const TURN_ID = "01J0000000000000000000000N";

function factory() {
  return createSessionEventFactory({ sessionId: SESSION_ID, createId: () => createDriverId() });
}

function emitter() {
  const events = factory();
  return <K extends SessionEventKind>(
    kind: K,
    payload: SessionEventPayload<K>,
    init?: SessionEventInit,
  ) => events.emit(kind, payload, { turnId: TURN_ID, ...init });
}

describe("coalesceSessionEvents", () => {
  test("adjacent same-stream deltas concatenate, keeping the last identity", () => {
    const emit = emitter();
    const events = [
      emit("item.delta", { itemId: "m1", stream: "text", delta: "he" }),
      emit("item.delta", { itemId: "m1", stream: "text", delta: "llo" }),
      emit("item.delta", { itemId: "m1", stream: "text", delta: " world" }),
    ];

    const coalesced = coalesceSessionEvents(events);

    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]?.payload).toMatchObject({ delta: "hello world" });
    expect(coalesced[0]?.seq).toBe(events[2]?.seq);
    expect(coalesced[0]?.id).toBe(events[2]?.id);
  });

  test("deltas never merge across items, streams, or indices", () => {
    const emit = emitter();
    const events = [
      emit("item.delta", { itemId: "m1", stream: "text", delta: "a" }),
      emit("item.delta", { itemId: "m2", stream: "text", delta: "b" }),
      emit("item.delta", { itemId: "m2", stream: "output", delta: "c" }),
      emit("item.delta", { itemId: "r1", stream: "reasoning_summary", index: 0, delta: "d" }),
      emit("item.delta", { itemId: "r1", stream: "reasoning_summary", index: 1, delta: "e" }),
    ];

    expect(coalesceSessionEvents(events)).toHaveLength(5);
  });

  test("barriers stop coalescing runs — order is never rearranged", () => {
    const emit = emitter();
    const events = [
      emit("item.delta", { itemId: "m1", stream: "text", delta: "a" }),
      emit("item.started", {
        item: { kind: "tool_call", itemId: "t1", name: "run", status: "pending" },
      }),
      emit("item.delta", { itemId: "m1", stream: "text", delta: "b" }),
    ];

    const coalesced = coalesceSessionEvents(events);

    expect(coalesced).toHaveLength(3);
    expect(coalesced.map((event) => event.kind)).toEqual([
      "item.delta",
      "item.started",
      "item.delta",
    ]);
  });

  test("adjacent item.updated patches merge with later fields winning", () => {
    const emit = emitter();
    const events = [
      emit("item.updated", {
        itemId: "t1",
        kind: "tool_call",
        patch: { status: "in_progress", progressMessage: "10%" },
      }),
      emit("item.updated", {
        itemId: "t1",
        kind: "tool_call",
        patch: { progressMessage: "90%", durationMs: 100 },
      }),
    ];

    const coalesced = coalesceSessionEvents(events);

    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]?.payload).toMatchObject({
      patch: { status: "in_progress", progressMessage: "90%", durationMs: 100 },
    });
  });

  test("adjacent usage.updated snapshots keep the last", () => {
    const emit = emitter();
    const events = [
      emit("usage.updated", { tokens: { input: 1, output: 1, total: 2 } }),
      emit("usage.updated", { tokens: { input: 5, output: 3, total: 8 } }),
    ];

    const coalesced = coalesceSessionEvents(events);

    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]?.payload).toMatchObject({ tokens: { total: 8 } });
  });

  test("events from different turns never merge", () => {
    const events = factory();
    const first = events.emit(
      "item.delta",
      { itemId: "m1", stream: "text", delta: "a" },
      { turnId: TURN_ID },
    );
    const second = events.emit(
      "item.delta",
      { itemId: "m1", stream: "text", delta: "b" },
      { turnId: "01J0000000000000000000000P" },
    );

    expect(coalesceSessionEvents([first, second])).toHaveLength(2);
  });

  test("classifies coalescible kinds", () => {
    expect(isCoalescibleKind("item.delta")).toBe(true);
    expect(isCoalescibleKind("item.updated")).toBe(true);
    expect(isCoalescibleKind("usage.updated")).toBe(true);
    expect(isCoalescibleKind("item.started")).toBe(false);
    expect(isCoalescibleKind("turn.completed")).toBe(false);
  });
});

describe("createSessionEventBuffer", () => {
  test("buffers coalescible events until the delay elapses", async () => {
    const emit = emitter();
    const batches: SessionEvent[][] = [];
    const buffer = createSessionEventBuffer({
      maxDelayMs: 5,
      flush: (events) => {
        batches.push(events);
      },
    });

    buffer.push(emit("item.delta", { itemId: "m1", stream: "text", delta: "he" }));
    buffer.push(emit("item.delta", { itemId: "m1", stream: "text", delta: "llo" }));

    expect(batches).toHaveLength(0);
    expect(buffer.size()).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]?.[0]?.payload).toMatchObject({ delta: "hello" });
  });

  test("barrier kinds flush the whole buffer immediately, in order", async () => {
    const emit = emitter();
    const batches: SessionEvent[][] = [];
    const buffer = createSessionEventBuffer({
      maxDelayMs: 1000,
      flush: (events) => {
        batches.push(events);
      },
    });

    buffer.push(emit("item.delta", { itemId: "m1", stream: "text", delta: "hi" }));
    buffer.push(
      emit("item.completed", {
        item: {
          kind: "message",
          itemId: "m1",
          role: "agent",
          content: [{ type: "text", text: "hi" }],
        },
      }),
    );

    await buffer.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((event) => event.kind)).toEqual(["item.delta", "item.completed"]);
  });

  test("flushes when maxCount is reached", async () => {
    const emit = emitter();
    const batches: SessionEvent[][] = [];
    const buffer = createSessionEventBuffer({
      maxDelayMs: 1000,
      maxCount: 3,
      flush: (events) => {
        batches.push(events);
      },
    });

    for (const delta of ["a", "b", "c"]) {
      buffer.push(emit("item.delta", { itemId: "m1", stream: "text", delta }));
    }

    await buffer.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]?.payload).toMatchObject({ delta: "abc" });
  });

  test("serializes flushes and reports background errors", async () => {
    const emit = emitter();
    const errors: unknown[] = [];
    const flushed: string[] = [];
    let fail = true;
    const buffer = createSessionEventBuffer({
      maxDelayMs: 1,
      flush: async (events) => {
        if (fail) {
          fail = false;
          throw new Error("uplink down");
        }

        flushed.push(...events.map((event) => event.kind));
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    buffer.push(emit("turn.started", {}));
    buffer.push(emit("turn.completed", { status: "completed" }));
    await buffer.flush();

    expect(errors).toHaveLength(1);
    expect(flushed).toEqual(["turn.completed"]);
  });
});
