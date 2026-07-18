import { describe, expect, test } from "bun:test";

import type { CmaInboundEvent } from "../src/projections/cma";
import { createDriverId } from "../src/protocol/id";
import { parseRuntimeEventEnvelope } from "../src/runtime-events";
import type { RuntimeEventEnvelope } from "../src/runtime-events";
import type { RuntimeCommand } from "../src/runtime-command";
import {
  CMA_MAX_EVENT_BYTES,
  CMA_MAX_REPLAY_BYTES,
  CMA_MAX_STREAMS,
  CmaStoreConflictError,
  encodeCmaSseRecord,
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
  test("claims inbound commands once and returns their settled result on retries", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const input = { ...interrupt("command-1"), sessionId };

    const first = await store.claimInboundEvent(input);
    const concurrentRetry = await store.claimInboundEvent(input);

    if (!first.claimed) {
      throw new Error("Expected the first command claim to succeed.");
    }

    expect(first.claimed).toBe(true);
    expect(first.event.commandStatus).toBe("accepted");
    expect(concurrentRetry).toMatchObject({
      claimed: false,
      event: {
        commandStatus: "accepted",
        id: first.event.id,
      },
    });

    const completed = await store.settleInboundEvent({
      commandId: "command-1",
      commandResult: { requestId: "request-1" },
      leaseId: first.lease.id,
      sessionId,
      status: "completed",
    });
    const completedRetry = await store.claimInboundEvent(input);

    expect(completed).toMatchObject({
      commandResult: { requestId: "request-1" },
      commandStatus: "completed",
    });
    expect(completedRetry).toMatchObject({
      claimed: false,
      event: completed,
    });
    await expect(
      store.claimInboundEvent({ ...interrupt("command-1", "changed"), sessionId }),
    ).rejects.toBeInstanceOf(CmaStoreConflictError);
  });

  test("reclaims expired command leases and rejects stale settlers", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({
      now: () => now,
      sessions: [{ id: sessionId }],
    });
    const input = { ...interrupt("command-1"), sessionId };
    const first = await store.claimInboundEvent(input);

    if (!first.claimed) {
      throw new Error("Expected the first command claim to succeed.");
    }

    now = new Date("2026-01-01T00:00:31.000Z");
    const reclaimed = await store.claimInboundEvent(input);

    if (!reclaimed.claimed) {
      throw new Error("Expected the expired command claim to be reclaimed.");
    }

    expect(reclaimed.event.id).toBe(first.event.id);
    expect(reclaimed.lease.id).not.toBe(first.lease.id);
    await expect(
      store.settleInboundEvent({
        commandId: "command-1",
        commandResult: null,
        leaseId: first.lease.id,
        sessionId,
        status: "completed",
      }),
    ).rejects.toBeInstanceOf(CmaStoreConflictError);
    await expect(
      store.settleInboundEvent({
        commandId: "command-1",
        commandResult: null,
        leaseId: reclaimed.lease.id,
        sessionId,
        status: "completed",
      }),
    ).resolves.toMatchObject({ commandStatus: "completed" });
  });

  test.each([
    ["renew", 30_000],
    ["renew", 30_001],
    ["settle", 30_000],
    ["settle", 30_001],
  ] as const)("rejects %s at an expired lease boundary of %d ms", async (operation, elapsedMs) => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ now: () => now, sessions: [{ id: sessionId }] });
    const input = { ...interrupt("command-1"), sessionId };
    const claim = await store.claimInboundEvent(input);

    if (!claim.claimed) {
      throw new Error("Expected the command claim to succeed.");
    }

    now = new Date(now.getTime() + elapsedMs);
    const attempt =
      operation === "renew"
        ? store.renewInboundEventClaim({
            commandId: "command-1",
            leaseId: claim.lease.id,
            sessionId,
          })
        : store.settleInboundEvent({
            commandId: "command-1",
            commandResult: null,
            leaseId: claim.lease.id,
            sessionId,
            status: "completed",
          });

    await expect(attempt).rejects.toBeInstanceOf(CmaStoreConflictError);
    await expect(store.claimInboundEvent(input)).resolves.toMatchObject({ claimed: true });
  });

  test("keeps a completed settlement idempotent after its lease expires", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ now: () => now, sessions: [{ id: sessionId }] });
    const claim = await store.claimInboundEvent({ ...interrupt("command-1"), sessionId });

    if (!claim.claimed) {
      throw new Error("Expected the command claim to succeed.");
    }

    const settlement = {
      commandId: "command-1",
      commandResult: { requestId: "request-1" },
      leaseId: claim.lease.id,
      sessionId,
      status: "completed",
    } as const;
    const completed = await store.settleInboundEvent(settlement);
    now = new Date("2026-01-01T00:00:31.000Z");

    await expect(store.settleInboundEvent(settlement)).resolves.toEqual(completed);
    await expect(
      store.settleInboundEvent({ ...settlement, commandResult: { requestId: "changed" } }),
    ).rejects.toBeInstanceOf(CmaStoreConflictError);
  });

  test("does not reclaim an expired command after its session terminates", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({
      now: () => now,
      sessions: [{ id: sessionId }],
    });
    const input = { ...interrupt("command-1"), sessionId };
    const claim = await store.claimInboundEvent(input);

    if (!claim.claimed) {
      throw new Error("Expected the command claim to succeed.");
    }

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
    now = new Date("2026-01-01T00:00:31.000Z");

    await expect(store.claimInboundEvent(input)).rejects.toThrow("terminated");
    await expect(
      store.renewInboundEventClaim({
        commandId: "command-1",
        leaseId: claim.lease.id,
        sessionId,
      }),
    ).rejects.toBeInstanceOf(CmaStoreConflictError);
    await expect(
      store.settleInboundEvent({
        commandId: "command-1",
        commandResult: null,
        leaseId: claim.lease.id,
        sessionId,
        status: "completed",
      }),
    ).rejects.toBeInstanceOf(CmaStoreConflictError);
  });

  test("allows a terminated session's original owner to settle a live lease", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ now: () => now, sessions: [{ id: sessionId }] });
    const claim = await store.claimInboundEvent({ ...interrupt("command-1"), sessionId });

    if (!claim.claimed) {
      throw new Error("Expected the command claim to succeed.");
    }

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
    now = new Date("2026-01-01T00:00:29.999Z");

    await expect(
      store.settleInboundEvent({
        commandId: "command-1",
        commandResult: null,
        leaseId: claim.lease.id,
        sessionId,
        status: "completed",
      }),
    ).resolves.toMatchObject({ commandStatus: "completed" });
  });

  test("renews a live command lease without changing its owner", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({
      now: () => now,
      sessions: [{ id: sessionId }],
    });
    const input = { ...interrupt("command-1"), sessionId };
    const claim = await store.claimInboundEvent(input);

    if (!claim.claimed) {
      throw new Error("Expected the command claim to succeed.");
    }

    now = new Date("2026-01-01T00:00:10.000Z");
    const renewed = await store.renewInboundEventClaim({
      commandId: "command-1",
      leaseId: claim.lease.id,
      sessionId,
    });
    now = new Date("2026-01-01T00:00:31.000Z");

    expect(renewed.id).toBe(claim.lease.id);
    expect(renewed.expiresAt).toBe("2026-01-01T00:00:40.000Z");
    expect(await store.claimInboundEvent(input)).toMatchObject({ claimed: false });
  });

  test.each([
    ["completed", { requestId: "request-1" }],
    ["failed", null],
  ] as const)("publishes an accepted command followed by its %s state", async (status, result) => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const events = store.streamSessionEvents(sessionId)[Symbol.asyncIterator]();
    const claim = await store.claimInboundEvent({ ...interrupt("command-1"), sessionId });

    if (!claim.claimed) {
      throw new Error("Expected the command claim to succeed.");
    }

    const settled = await store.settleInboundEvent({
      commandId: "command-1",
      commandResult: result,
      leaseId: claim.lease.id,
      sessionId,
      status,
    });

    expect(await events.next()).toMatchObject({
      done: false,
      value: {
        commandStatus: "accepted",
        id: claim.event.id,
      },
    });
    expect(await events.next()).toMatchObject({
      done: false,
      value: {
        commandResult: result,
        commandStatus: status,
        id: claim.event.id,
      },
    });
    expect(settled.cursor).not.toBe(claim.event.cursor);
    expect(await store.listSessionEvents(sessionId)).toEqual([settled]);
    await events.return?.();
  });

  test("preserves accepted replay when a command settles before replay is consumed", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const claim = await store.claimInboundEvent({ ...interrupt("command-1"), sessionId });

    if (!claim.claimed) {
      throw new Error("Expected the command claim to succeed.");
    }

    const events = store.streamSessionEvents(sessionId)[Symbol.asyncIterator]();
    await store.settleInboundEvent({
      commandId: "command-1",
      commandResult: { requestId: "request-1" },
      leaseId: claim.lease.id,
      sessionId,
      status: "completed",
    });

    expect((await events.next()).value).toMatchObject({
      commandStatus: "accepted",
      id: claim.event.id,
    });
    expect((await events.next()).value).toMatchObject({
      commandStatus: "completed",
      id: claim.event.id,
    });
    await events.return?.();
  });

  test("orders inbound command states by their latest transition", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const claimA = await store.claimInboundEvent({ ...interrupt("command-a"), sessionId });
    const claimB = await store.claimInboundEvent({ ...interrupt("command-b"), sessionId });

    if (!claimA.claimed || !claimB.claimed) {
      throw new Error("Expected both command claims to succeed.");
    }

    await store.settleInboundEvent({
      commandId: "command-b",
      commandResult: null,
      leaseId: claimB.lease.id,
      sessionId,
      status: "completed",
    });
    await store.settleInboundEvent({
      commandId: "command-a",
      commandResult: null,
      leaseId: claimA.lease.id,
      sessionId,
      status: "completed",
    });

    expect(
      (await store.listSessionEvents(sessionId)).map((event) => event.command?.commandId),
    ).toEqual(["command-b", "command-a"]);
  });

  test("deduplicates stable source events and rejects changed or cross-session identities", async () => {
    const sessionId = createDriverId();
    const otherSessionId = createDriverId();
    const store = createCmaMemoryStore({
      sessions: [{ id: sessionId }, { id: otherSessionId }],
    });
    const sourceEventId = createDriverId();
    const source = driverEvent(
      sessionId,
      "message.completed",
      { content: "complete", messageId: "message-1" },
      {
        id: createDriverId(),
        occurredAt: "2026-01-01T00:00:02.000Z",
        sourceEventId,
      },
    );
    const retrySource = driverEvent(
      sessionId,
      "message.completed",
      { content: "complete", messageId: "message-1" },
      { id: createDriverId(), sourceEventId },
    );

    const first = await store.appendDriverEvent(sessionId, source);
    const retry = await store.appendDriverEvent(sessionId, retrySource);

    expect(retry).toEqual(first);
    expect(await store.listSessionEvents(sessionId)).toHaveLength(1);

    await expect(
      store.appendDriverEvent(
        sessionId,
        driverEvent(
          sessionId,
          "message.completed",
          { content: "changed", messageId: "message-1" },
          { id: createDriverId(), sourceEventId },
        ),
      ),
    ).rejects.toBeInstanceOf(CmaStoreConflictError);
    await expect(
      store.appendDriverEvent(
        sessionId,
        driverEvent(
          sessionId,
          "message.completed",
          { content: "complete", messageId: "message-1" },
          { id: createDriverId(), sourceEventId, visibility: "public" },
        ),
      ),
    ).rejects.toBeInstanceOf(CmaStoreConflictError);
    await expect(
      store.appendDriverEvent(sessionId, driverEvent(otherSessionId, "message.completed", {})),
    ).rejects.toThrow("sessionId");
    expect(await store.listSessionEvents(otherSessionId)).toHaveLength(0);
  });

  test.each([
    [
      "run.failed",
      {
        error: { code: "fatal", details: {}, message: "failed", retryable: false },
        recoverable: false,
      },
      { runId: createDriverId() },
    ],
    [
      "permission.requested",
      { requestId: "permission-1", title: "Approve" },
      { driverInstanceId: createDriverId(), runId: createDriverId() },
    ],
  ] as const)("rejects best-effort authoritative %s events", async (kind, payload, options) => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const event = driverEvent(sessionId, kind, payload, {
      ...options,
      delivery: "best_effort",
    });

    await expect(store.appendDriverEvent(sessionId, event)).rejects.toThrow("lossless");
    expect(await store.getSession(sessionId)).toMatchObject({ status: "idle" });
    expect(await store.listSessionEvents(sessionId)).toEqual([]);
  });

  test.each([
    [0, true],
    [1, false],
  ] as const)(
    "bounds the final UTF-8 SSE frame at max bytes + %d",
    async (extraBytes, accepted) => {
      const sessionId = createDriverId();
      const options = {
        idFactory: () => "event-1",
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        sessions: [{ id: sessionId }],
      } as const;
      const measure = createCmaMemoryStore(options);
      const [base] = await measure.appendDriverEvent(
        sessionId,
        driverEvent(sessionId, "message.completed", {
          content: "",
          messageId: "message-1",
        }),
      );

      if (!base) {
        throw new Error("Expected a projected event.");
      }

      const contentBytes = CMA_MAX_EVENT_BYTES - encodeCmaSseRecord(base).byteLength + extraBytes;
      const content = `界${"x".repeat(contentBytes - 3)}`;
      const store = createCmaMemoryStore(options);
      const result = store.appendDriverEvent(
        sessionId,
        driverEvent(sessionId, "message.completed", { content, messageId: "message-1" }),
      );

      if (accepted) {
        const [record] = await result;
        expect(record && encodeCmaSseRecord(record)).toHaveLength(CMA_MAX_EVENT_BYTES);
      } else {
        await expect(result).rejects.toThrow("SSE event frame exceeds");
        expect(await store.listSessionEvents(sessionId)).toEqual([]);
      }
    },
  );

  test.each([
    [0, true],
    [1, false],
  ] as const)(
    "bounds a settled command result at final frame bytes + %d",
    async (extraBytes, accepted) => {
      const sessionId = createDriverId();
      const options = {
        idFactory: () => "event-1",
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        sessions: [{ id: sessionId }],
      } as const;
      const input = {
        command: {
          argumentsJson: "{}",
          commandId: "command-1",
          kind: "mcp.execute",
          requestId: "request-1",
          serverId: "server-1",
          toolName: "tool-1",
        },
        event: {
          argumentsJson: "{}",
          commandId: "command-1",
          requestId: "request-1",
          serverId: "server-1",
          toolName: "tool-1",
          type: "user.custom_tool_result",
        },
        sessionId,
      } as const;
      const measure = createCmaMemoryStore(options);
      const measuredClaim = await measure.claimInboundEvent(input);

      if (!measuredClaim.claimed) {
        throw new Error("Expected the command claim to succeed.");
      }

      const baseResult = {
        outputText: "",
        requestId: "request-1",
        serverId: "server-1",
        toolName: "tool-1",
      };
      const measured = {
        ...measuredClaim.event,
        commandResult: baseResult,
        commandStatus: "completed",
        cursor: createDriverId(),
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as const;
      const outputBytes =
        CMA_MAX_EVENT_BYTES - encodeCmaSseRecord(measured).byteLength + extraBytes;
      const commandResult = {
        ...baseResult,
        outputText: `界${"x".repeat(outputBytes - 3)}`,
      };
      const store = createCmaMemoryStore(options);
      const claim = await store.claimInboundEvent(input);

      if (!claim.claimed) {
        throw new Error("Expected the command claim to succeed.");
      }

      const result = store.settleInboundEvent({
        commandId: "command-1",
        commandResult,
        leaseId: claim.lease.id,
        sessionId,
        status: "completed",
      });

      if (accepted) {
        const record = await result;
        expect(encodeCmaSseRecord(record)).toHaveLength(CMA_MAX_EVENT_BYTES);
      } else {
        await expect(result).rejects.toThrow("SSE event frame exceeds");
        expect(await store.listSessionEvents(sessionId)).toEqual([claim.event]);
        await expect(store.claimInboundEvent(input)).resolves.toMatchObject({
          claimed: false,
          event: { commandStatus: "accepted" },
        });
      }
    },
  );

  test("does not commit session state before final frame admission", async () => {
    const sessionId = createDriverId();
    const driverInstanceId = createDriverId();
    const runId = createDriverId();
    const options = {
      idFactory: () => "event-1",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sessions: [{ id: sessionId }],
    } as const;
    const permission = (title: string) =>
      driverEvent(
        sessionId,
        "permission.requested",
        { requestId: "permission-1", title },
        { driverInstanceId, runId },
      );
    const measure = createCmaMemoryStore(options);
    const [base] = await measure.appendDriverEvent(sessionId, permission("x"));

    if (!base) {
      throw new Error("Expected a projected permission event.");
    }

    const targetBytes = CMA_MAX_EVENT_BYTES - encodeCmaSseRecord(base).byteLength + 2;
    const title = `界${"x".repeat(targetBytes - 3)}`;
    const store = createCmaMemoryStore(options);

    await expect(store.appendDriverEvent(sessionId, permission(title))).rejects.toThrow(
      "SSE event frame exceeds",
    );
    expect(await store.getSession(sessionId)).toMatchObject({ status: "idle" });
    expect(await store.listSessionEvents(sessionId)).toEqual([]);

    const [resolved] = await store.appendDriverEvent(
      sessionId,
      driverEvent(sessionId, "permission.resolved", {
        outcome: "approved",
        requestId: "permission-1",
      }),
    );
    expect(resolved?.event).toMatchObject({ sessionStatus: "idle" });
    expect(await store.getSession(sessionId)).toMatchObject({ status: "idle" });
  });

  test("validates canonical input, ignores JSON key order, and owns stored values", async () => {
    const sessionId = createDriverId();
    const sourceId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const nested = { value: "before" };
    const source = driverEvent(
      sessionId,
      "message.completed",
      { a: 1, b: 2, metadata: nested, messageId: "message-1" },
      { id: sourceId },
    );
    const reordered = driverEvent(
      sessionId,
      "message.completed",
      { metadata: { value: "before" }, b: 2, a: 1, messageId: "message-1" },
      { id: sourceId },
    );

    const first = await store.appendDriverEvent(sessionId, source);
    expect(await store.appendDriverEvent(sessionId, reordered)).toEqual(first);
    nested.value = "after";
    expect(await store.listSessionEvents(sessionId)).toMatchObject([
      { event: { message: { metadata: { value: "before" } } } },
    ]);
    await expect(
      store.appendDriverEvent(sessionId, {
        kind: "permission.requested",
        payload: {},
      } as unknown as RuntimeEventEnvelope),
    ).rejects.toThrow("schema version");
  });

  test("acknowledges private and post-terminal events without exposing or reopening them", async () => {
    const sessionId = createDriverId();
    const runId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const diagnostic = driverEvent(
      sessionId,
      "diagnostic.reported",
      { message: "private" },
      { visibility: "owner_debug" },
    );

    expect(await store.appendDriverEvent(sessionId, diagnostic)).toEqual([]);
    expect(await store.appendDriverEvent(sessionId, diagnostic)).toEqual([]);
    await store.appendDriverEvent(
      sessionId,
      driverEvent(
        sessionId,
        "run.failed",
        {
          error: { code: "fatal", details: {}, message: "failed", retryable: false },
          recoverable: false,
        },
        { runId },
      ),
    );
    const lateUsage = driverEvent(sessionId, "usage.updated", { inputTokens: 1 });

    expect(await store.appendDriverEvent(sessionId, lateUsage)).toEqual([]);
    expect(await store.appendDriverEvent(sessionId, lateUsage)).toEqual([]);
    expect(await store.getSession(sessionId)).toMatchObject({ status: "terminated" });
    expect(await store.listSessionEvents(sessionId)).toHaveLength(1);
  });

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
