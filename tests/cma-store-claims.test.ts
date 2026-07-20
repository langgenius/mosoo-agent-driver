import { describe, expect, test } from "bun:test";

import type { CmaInboundEvent } from "../src/projections/cma";
import { createDriverId } from "../src/protocol/id";
import { parseRuntimeEventEnvelope } from "../src/runtime-events";
import type { RuntimeCommand } from "../src/runtime-command";
import { CmaStoreConflictError } from "../src/stores/cma-store";
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
});
