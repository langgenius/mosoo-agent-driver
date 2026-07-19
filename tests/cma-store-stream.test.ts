import { describe, expect, test } from "bun:test";

import type { CmaInboundEvent } from "../src/projections/cma";
import { createDriverId } from "../src/protocol/id";
import { parseRuntimeEventEnvelope } from "../src/runtime-events";
import type { RuntimeCommand } from "../src/runtime-command";
import {
  CMA_MAX_EVENT_BYTES,
  CMA_MAX_REPLAY_BYTES,
  CMA_MAX_STREAMS,
} from "../src/stores/cma-store";
import { createCmaMemoryStore } from "../src/stores/memory";

function driverEvent(
  sessionId: string,
  kind: string,
  payload: unknown,
  options: {
    readonly delivery?: "best_effort" | "lossless";
    readonly driverInstanceId?: string;
    readonly id?: string;
    readonly occurredAt?: string;
    readonly runId?: string;
    readonly sourceEventId?: string;
    readonly visibility?: "owner_debug" | "participant" | "public" | "system_internal";
  } = {},
) {
  return parseRuntimeEventEnvelope({
    actor: "driver",
    delivery: options.delivery ?? "lossless",
    ...(options.driverInstanceId === undefined
      ? {}
      : { driverInstanceId: options.driverInstanceId }),
    id: options.id ?? createDriverId(),
    kind,
    occurredAt: options.occurredAt ?? "2026-01-01T00:00:01.000Z",
    origin: "driver",
    payload,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    schemaVersion: "2026-05-26",
    sessionId,
    ...(options.sourceEventId === undefined ? {} : { sourceEventId: options.sourceEventId }),
    visibility: options.visibility ?? "participant",
  });
}

function interrupt(
  commandId: string,
  reason?: string,
): {
  readonly command: RuntimeCommand;
  readonly event: CmaInboundEvent;
} {
  return {
    command: {
      commandId,
      kind: "turn.cancel",
      ...(reason === undefined ? {} : { reason }),
    },
    event: {
      commandId,
      ...(reason === undefined ? {} : { reason }),
      type: "user.interrupt",
    },
  };
}

describe("CMA memory store lifecycle", () => {
  test("keeps a session idle until every pending permission is resolved", async () => {
    const sessionId = createDriverId();
    const runId = createDriverId();
    const driverInstanceId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const permission = (requestId: string) =>
      driverEvent(
        sessionId,
        "permission.requested",
        { requestId, title: requestId },
        { driverInstanceId, runId },
      );
    const resolved = (requestId: string) =>
      driverEvent(sessionId, "permission.resolved", { outcome: "approved", requestId });

    await store.appendDriverEvent(sessionId, permission("permission-a"));
    await store.appendDriverEvent(sessionId, permission("permission-b"));
    const [stillWaiting] = await store.appendDriverEvent(sessionId, resolved("permission-a"));
    expect(await store.getSession(sessionId)).toMatchObject({ status: "idle" });
    expect(stillWaiting?.event).toMatchObject({
      requiresAction: { requestId: "permission-b" },
      sessionStatus: "idle",
      type: "session.status_idle",
    });

    await store.appendDriverEvent(sessionId, resolved("permission-b"));
    expect(await store.getSession(sessionId)).toMatchObject({ status: "running" });
  });

  test("uses a distinct cursor for each command state transition", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const claim = await store.claimInboundEvent({ ...interrupt("command-1"), sessionId });

    if (!claim.claimed) {
      throw new Error("Expected the command claim to succeed.");
    }

    const settled = await store.settleInboundEvent({
      commandId: "command-1",
      commandResult: null,
      leaseId: claim.lease.id,
      sessionId,
      status: "completed",
    });
    const resumed = store
      .streamSessionEvents(sessionId, claim.event.cursor)
      [Symbol.asyncIterator]();

    expect((await resumed.next()).value).toMatchObject({
      commandStatus: "completed",
      cursor: settled.cursor,
      id: claim.event.id,
    });
    await resumed.return?.();
  });

  test("keeps replay cursors monotonic when an earlier command settles", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const claim = await store.claimInboundEvent({ ...interrupt("command-1"), sessionId });

    if (!claim.claimed) {
      throw new Error("Expected the command claim to succeed.");
    }

    await store.appendDriverEvent(
      sessionId,
      driverEvent(sessionId, "message.completed", { messageId: "message-1" }),
    );
    await store.settleInboundEvent({
      commandId: "command-1",
      commandResult: null,
      leaseId: claim.lease.id,
      sessionId,
      status: "completed",
    });

    const replay = store.streamSessionEvents(sessionId, claim.event.cursor)[Symbol.asyncIterator]();
    const firstResult = await replay.next();
    const secondResult = await replay.next();

    if (firstResult.done || secondResult.done) {
      throw new Error("Expected both replay events.");
    }

    const first = firstResult.value;
    const second = secondResult.value;
    await replay.return?.();

    expect([first.cursor, second.cursor]).toEqual([first.cursor, second.cursor].toSorted());

    const [terminal] = await store.appendDriverEvent(
      sessionId,
      driverEvent(
        sessionId,
        "run.failed",
        {
          error: { code: "fatal", details: {}, message: "failed", retryable: false },
          recoverable: false,
        },
        { runId: createDriverId() },
      ),
    );
    const resumed = [];

    for await (const event of store.streamSessionEvents(sessionId, second.cursor)) {
      resumed.push(event);
    }

    expect(resumed).toEqual([terminal]);
    const cursors = (await store.listSessionEvents(sessionId)).map((event) => event.cursor);
    expect(cursors).toEqual(cursors.toSorted());
  });

  test("atomically bridges replay and live events without persisting best-effort previews", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const replay = driverEvent(sessionId, "message.completed", {
      content: "replay",
      messageId: "message-1",
    });
    await store.appendDriverEvent(sessionId, replay);

    const events = store.streamSessionEvents(sessionId)[Symbol.asyncIterator]();
    const preview = driverEvent(
      sessionId,
      "message.delta",
      { contentDelta: "live", messageId: "message-2" },
      { delivery: "best_effort" },
    );
    await store.appendDriverEvent(sessionId, preview);

    expect((await events.next()).value).toMatchObject({
      event: { message: { content: "replay" } },
    });
    expect((await events.next()).value).toMatchObject({
      event: { message: { contentDelta: "live" } },
    });
    expect(await store.listSessionEvents(sessionId)).toHaveLength(1);
    await events.return?.();
  });

  test("bounds a stalled preview subscriber instead of retaining every delta", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const events = store.streamSessionEvents(sessionId)[Symbol.asyncIterator]();

    for (let index = 0; index < 1_000; index += 1) {
      await store.appendDriverEvent(
        sessionId,
        driverEvent(
          sessionId,
          "message.delta",
          { contentDelta: String(index), messageId: "message-1" },
          { delivery: "best_effort" },
        ),
      );
    }

    await expect(events.next()).rejects.toThrow("slow consumer");
    expect(await store.listSessionEvents(sessionId)).toHaveLength(0);
  });

  test("bounds replay copied into a subscription", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const content = "x".repeat(Math.floor(CMA_MAX_EVENT_BYTES / 2));
    let lastCursor = "";

    for (let index = 0; index <= Math.ceil(CMA_MAX_REPLAY_BYTES / content.length); index += 1) {
      const [record] = await store.appendDriverEvent(
        sessionId,
        driverEvent(sessionId, "message.completed", {
          content,
          messageId: `message-${index}`,
        }),
      );
      lastCursor = record?.cursor ?? lastCursor;
    }

    expect(() => store.streamSessionEvents(sessionId)[Symbol.asyncIterator]()).toThrow("replay");
    const resumed = store.streamSessionEvents(sessionId, lastCursor)[Symbol.asyncIterator]();
    await resumed.return?.();
  });

  test("bounds and releases live subscriptions", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const streams = Array.from({ length: CMA_MAX_STREAMS }, () =>
      store.streamSessionEvents(sessionId)[Symbol.asyncIterator](),
    );

    expect(() => store.streamSessionEvents(sessionId)[Symbol.asyncIterator]()).toThrow(
      "subscription limit",
    );
    await streams[0]?.return?.();
    const replacement = store.streamSessionEvents(sessionId)[Symbol.asyncIterator]();
    await replacement.return?.();
    await Promise.all(streams.slice(1).map(async (stream) => stream.return?.()));
  });

  test.each(["natural", "return", "throw"] as const)(
    "bounds terminal subscriptions and restores capacity after %s closure",
    async (closure) => {
      const sessionId = createDriverId();
      const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
      await store.appendDriverEvent(
        sessionId,
        driverEvent(
          sessionId,
          "run.failed",
          {
            error: { code: "fatal", details: {}, message: "failed", retryable: false },
            recoverable: false,
          },
          { runId: createDriverId() },
        ),
      );
      const streams = Array.from({ length: CMA_MAX_STREAMS }, () =>
        store.streamSessionEvents(sessionId)[Symbol.asyncIterator](),
      );

      expect(() => store.streamSessionEvents(sessionId)[Symbol.asyncIterator]()).toThrow(
        "subscription limit",
      );

      const released = streams.shift();

      if (!released) {
        throw new Error("Expected a terminal stream.");
      }

      if (closure === "natural") {
        while (!(await released.next()).done) {
          // Drain the terminal replay.
        }
      } else if (closure === "return") {
        await released.return?.();
      } else {
        await expect(released.throw?.(new Error("stop"))).rejects.toThrow("stop");
      }

      const replacement = store.streamSessionEvents(sessionId)[Symbol.asyncIterator]();
      await replacement.return?.();
      await Promise.all(streams.map(async (stream) => stream.return?.()));
    },
  );

  test("bounds queued subscriber bytes and releases the subscription", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const stream = store.streamSessionEvents(sessionId)[Symbol.asyncIterator]();
    const contentDelta = "x".repeat(Math.floor(CMA_MAX_EVENT_BYTES * 0.6));

    for (let index = 0; index < 3; index += 1) {
      await store.appendDriverEvent(
        sessionId,
        driverEvent(
          sessionId,
          "message.delta",
          { contentDelta, messageId: `message-${index}` },
          { delivery: "best_effort" },
        ),
      );
    }

    await expect(stream.next()).rejects.toThrow("subscriber byte limit");
    const replacement = store.streamSessionEvents(sessionId)[Symbol.asyncIterator]();
    await replacement.return?.();
  });

  test.each([
    [true, "rescheduling", false],
    [false, "terminated", true],
  ] as const)(
    "converges recoverable=%s failures to %s and closes only terminal streams",
    async (recoverable, status, closes) => {
      const sessionId = createDriverId();
      const runId = createDriverId();
      const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
      const events = store.streamSessionEvents(sessionId)[Symbol.asyncIterator]();
      await store.appendDriverEvent(
        sessionId,
        driverEvent(
          sessionId,
          "run.failed",
          {
            error: {
              code: "driver.failed",
              details: {},
              message: "failed",
              retryable: recoverable,
            },
            recoverable,
          },
          { runId },
        ),
      );

      expect(await store.getSession(sessionId)).toMatchObject({ status });
      expect((await events.next()).value.event).toMatchObject({ sessionStatus: status });

      if (closes) {
        expect(await events.next()).toEqual({ done: true, value: undefined });
      } else {
        await events.return?.();
      }
    },
  );
});
