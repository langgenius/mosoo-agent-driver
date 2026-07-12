import { describe, expect, test } from "bun:test";

import {
  CONTRACT_VERSION,
  SESSION_EVENT_KINDS,
  admitSessionEvent,
  createSessionEventFactory,
  deliveryOf,
  isKnownSessionEventKind,
  parseSessionEvent,
  visibilityOf,
} from "../src/contract";
import type { SessionEvent, SessionEventKind } from "../src/contract";
import { createDriverId } from "../src/protocol/id";

const SESSION_ID = "01J0000000000000000000000K";
const TURN_ID = "01J0000000000000000000000N";
const AT = "2026-07-13T00:00:00.000Z";

function envelope(kind: SessionEventKind, payload: unknown, turnId?: string): unknown {
  return {
    id: "01J0000000000000000000000G",
    seq: 1,
    sessionId: SESSION_ID,
    ...(turnId === undefined ? {} : { turnId }),
    at: AT,
    kind,
    payload,
  };
}

describe("session event envelope", () => {
  test("contract version is a bare integer", () => {
    expect(CONTRACT_VERSION).toBe(2);
  });

  test("parses a minimal session-plane event", () => {
    const event = parseSessionEvent(envelope("session.started", { resumed: false }));

    expect(event.kind).toBe("session.started");
    expect(event.seq).toBe(1);
    expect(event.payload).toEqual({ resumed: false });
  });

  test("rejects malformed envelopes", () => {
    expect(() => parseSessionEvent(null)).toThrow();
    expect(() => parseSessionEvent({})).toThrow();
    expect(() =>
      parseSessionEvent({ ...(envelope("turn.started", {}, TURN_ID) as object), seq: -1 }),
    ).toThrow();
    expect(() =>
      parseSessionEvent({ ...(envelope("turn.started", {}, TURN_ID) as object), sessionId: "x" }),
    ).toThrow();
    expect(() =>
      parseSessionEvent({ ...(envelope("turn.started", {}, TURN_ID) as object), at: "yesterday" }),
    ).toThrow();
  });

  test("turn-scoped kinds require turnId", () => {
    expect(() => parseSessionEvent(envelope("turn.started", {}))).toThrow(/turnId/);
    expect(() =>
      parseSessionEvent(envelope("item.delta", { itemId: "i1", stream: "text", delta: "hi" })),
    ).toThrow(/turnId/);
    expect(parseSessionEvent(envelope("turn.started", {}, TURN_ID)).turnId).toBe(TURN_ID);
  });

  test("strict on known kinds, open on unknown kinds", () => {
    expect(() =>
      parseSessionEvent(envelope("turn.completed", { status: "nope" }, TURN_ID)),
    ).toThrow();

    const extension = parseSessionEvent(
      envelope("x_codex.turn.diff", { diff: "--- a\n+++ b" }, undefined),
    );
    expect(extension.payload).toEqual({ diff: "--- a\n+++ b" });

    const future = parseSessionEvent(envelope("session.renamed", { title: "hi" }));
    expect(future.kind).toBe("session.renamed");
  });

  test("unknown envelope fields are preserved", () => {
    const raw = { ...(envelope("session.started", { resumed: true }) as object), futureField: 7 };
    const event = parseSessionEvent(raw) as SessionEvent & { futureField?: number };

    expect(event.futureField).toBe(7);
  });

  test("admitSessionEvent returns a rejection instead of throwing", () => {
    const outcome = admitSessionEvent({ kind: "item.delta" });

    expect(outcome.status).toBe("rejected");

    if (outcome.status === "rejected") {
      expect(outcome.reason.code).toBe("malformed_event");
      expect(outcome.reason.message.length).toBeGreaterThan(0);
    }

    const accepted = admitSessionEvent(envelope("session.started", { resumed: false }));
    expect(accepted.status).toBe("accepted");
  });
});

describe("session event payloads", () => {
  test("turn.completed requires an error when failed", () => {
    expect(() =>
      parseSessionEvent(envelope("turn.completed", { status: "failed" }, TURN_ID)),
    ).toThrow();

    const event = parseSessionEvent(
      envelope(
        "turn.completed",
        {
          status: "failed",
          stopReason: "cancelled",
          error: { code: "provider.crash", message: "boom", retryable: false },
        },
        TURN_ID,
      ),
    );
    expect(event.payload).toMatchObject({ status: "failed", error: { code: "provider.crash" } });
  });

  test("usage.updated carries cumulative + last tokens, context, and cost", () => {
    const event = parseSessionEvent(
      envelope("usage.updated", {
        tokens: { input: 100, cachedInput: 40, output: 20, reasoningOutput: 5, total: 125 },
        lastTokens: { input: 10, output: 2, total: 12 },
        context: { usedTokens: 5000, maxTokens: 200000 },
        cost: { amount: 0.02, currency: "USD" },
      }),
    );

    expect(event.payload).toMatchObject({
      tokens: { total: 125 },
      context: { maxTokens: 200000 },
    });
  });

  test("permission.requested needs at least one option", () => {
    const base = {
      requestId: "req-1",
      title: "Run this command?",
      detail: { type: "command", command: "rm -rf build", cwd: "/workspace" },
    };

    expect(() =>
      parseSessionEvent(envelope("permission.requested", { ...base, options: [] }, TURN_ID)),
    ).toThrow();

    const event = parseSessionEvent(
      envelope(
        "permission.requested",
        {
          ...base,
          options: [
            { optionId: "yes", name: "Allow once", kind: "allow_once" },
            { optionId: "always", name: "Always", kind: "allow_always" },
          ],
        },
        TURN_ID,
      ),
    );
    expect(event.payload).toMatchObject({ detail: { type: "command" } });
  });

  test("permission.resolved accepts open outcomes", () => {
    for (const outcome of [
      { type: "selected", optionId: "yes" },
      { type: "cancelled" },
      { type: "timeout" },
      { type: "x_vendor_deferred", queue: "later" },
    ]) {
      const event = parseSessionEvent(
        envelope("permission.resolved", { requestId: "req-1", outcome }, TURN_ID),
      );
      expect(event.payload).toMatchObject({ requestId: "req-1" });
    }
  });

  test("input.requested models codex request_user_input questions", () => {
    const event = parseSessionEvent(
      envelope("input.requested", {
        requestId: "req-2",
        questions: [
          {
            questionId: "q1",
            header: "Auth",
            question: "Which account?",
            options: [{ label: "work" }, { label: "personal", description: "gmail" }],
            allowFreeform: true,
            secret: false,
          },
        ],
      }),
    );

    expect(event.payload).toMatchObject({ questions: [{ questionId: "q1" }] });
  });

  test("item.updated validates typed patches and rejects garbage", () => {
    const event = parseSessionEvent(
      envelope(
        "item.updated",
        { itemId: "i1", kind: "tool_call", patch: { status: "completed", durationMs: 12 } },
        TURN_ID,
      ),
    );
    expect(event.payload).toMatchObject({ patch: { status: "completed" } });

    expect(() =>
      parseSessionEvent(
        envelope(
          "item.updated",
          { itemId: "i1", kind: "tool_call", patch: { durationMs: "fast" } },
          TURN_ID,
        ),
      ),
    ).toThrow();

    const unknownKind = parseSessionEvent(
      envelope(
        "item.updated",
        { itemId: "i1", kind: "x_web_search", patch: { results: 3 } },
        TURN_ID,
      ),
    );
    expect(unknownKind.payload).toMatchObject({ patch: { results: 3 } });
  });

  test("item.delta carries stream + optional index for parallel parts", () => {
    const event = parseSessionEvent(
      envelope(
        "item.delta",
        { itemId: "r1", stream: "reasoning_summary", index: 2, delta: "…" },
        TURN_ID,
      ),
    );
    expect(event.payload).toMatchObject({ stream: "reasoning_summary", index: 2 });

    expect(() =>
      parseSessionEvent(envelope("item.delta", { itemId: "r1", stream: "" }, TURN_ID)),
    ).toThrow();
  });

  test("session.config.updated speaks ACP v2 config options", () => {
    const event = parseSessionEvent(
      envelope("session.config.updated", {
        options: [
          {
            configId: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValueId: "gpt-6",
            options: [{ valueId: "gpt-6", name: "GPT-6" }],
          },
          { configId: "web", name: "Web search", type: "boolean", currentValue: true },
        ],
      }),
    );

    expect(event.payload).toMatchObject({ options: [{ type: "select" }, { type: "boolean" }] });
  });

  test("diagnostic and timing land in the ops plane", () => {
    const diagnostic = parseSessionEvent(
      envelope("diagnostic.reported", {
        severity: "warning",
        code: "provider.rate_limited",
        message: "slow down",
        retryable: true,
      }),
    );
    const timing = parseSessionEvent(
      envelope("timing.recorded", {
        stage: "driver_backend",
        path: "cold",
        startedAtMs: 100,
        totalMs: 350,
        phases: [{ name: "spawn", durationMs: 200 }],
      }),
    );

    expect(visibilityOf(diagnostic.kind)).toBe("owner_debug");
    expect(visibilityOf(timing.kind)).toBe("owner_debug");
    expect(visibilityOf("item.delta")).toBe("participant");
  });
});

describe("classification", () => {
  test("only item.delta is best-effort", () => {
    for (const kind of SESSION_EVENT_KINDS) {
      expect(deliveryOf(kind)).toBe(kind === "item.delta" ? "best_effort" : "lossless");
    }
  });

  test("kind registry is consistent", () => {
    expect(SESSION_EVENT_KINDS.length).toBe(17);

    for (const kind of SESSION_EVENT_KINDS) {
      expect(isKnownSessionEventKind(kind)).toBe(true);
    }

    expect(isKnownSessionEventKind("x_anything")).toBe(false);
  });
});

describe("session event factory", () => {
  test("assigns ids, monotonic seq, timestamps, and validates payloads", () => {
    const factory = createSessionEventFactory({
      sessionId: SESSION_ID,
      createId: () => createDriverId(),
      traceId: "trace-1",
    });

    const first = factory.emit("session.started", { resumed: false });
    const second = factory.emit(
      "item.delta",
      { itemId: "m1", stream: "text", delta: "hello" },
      { turnId: TURN_ID },
    );

    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(second.turnId).toBe(TURN_ID);
    expect(second.traceId).toBe("trace-1");
    expect(() => factory.emit("turn.started", {})).toThrow(/turnId/);
  });
});
