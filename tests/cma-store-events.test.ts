import { describe, expect, test } from "bun:test";

import { createDriverId } from "../src/protocol/id";
import { parseRuntimeEventEnvelope } from "../src/runtime-events";
import type { RuntimeEventEnvelope } from "../src/runtime-events";
import {
  CMA_MAX_EVENT_BYTES,
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

describe("CMA memory store lifecycle", () => {
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
});
