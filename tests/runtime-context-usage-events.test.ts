import { describe, expect, test } from "bun:test";

import { projectDriverEventToCma } from "../src/projections/cma";
import type { EventId } from "../src/protocol/id";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  ingestRuntimeEventInput,
  parseRuntimeEventEnvelope,
} from "../src/runtime-events";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

const context = {
  createId: () => "01J0000000000000000000000G" as EventId,
  occurredAt: "2026-10-10T00:00:00.000Z",
  runtimeId: "acp-fallback",
  sessionId: DRIVER_TEST_IDS.sessionId,
};

function envelope(payload: unknown) {
  return {
    actor: "driver",
    delivery: "lossless",
    id: context.createId(),
    kind: "context.usage.updated",
    occurredAt: context.occurredAt,
    origin: "driver",
    payload,
    runtimeId: context.runtimeId,
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    sessionId: context.sessionId,
    visibility: "participant",
  };
}

describe("runtime context usage", () => {
  test.each([
    { used: 0, size: 0 },
    { used: 100, size: 200 },
    { used: 201, size: 200 },
  ])("admits context occupancy without adding usage charges: %j", (payload) => {
    const event = parseRuntimeEventEnvelope(envelope(payload));
    expect(event.payload).toEqual(payload);
    expect(ingestRuntimeEventInput(context, { kind: event.kind, payload })).toEqual({
      event,
      status: "accepted",
    });
    expect(projectDriverEventToCma(event)).toEqual([]);
  });

  test.each([
    {},
    { used: 1 },
    { size: 100 },
    { used: -1, size: 100 },
    { used: 1, size: -100 },
    { used: 0.5, size: 100 },
    { used: 1, size: 100.5 },
    { used: Number.NaN, size: 100 },
    { used: 1, size: Number.POSITIVE_INFINITY },
    { used: Number.MAX_SAFE_INTEGER + 1, size: 100 },
    { used: 1, size: Number.MAX_SAFE_INTEGER + 1 },
    { used: "1", size: 100 },
    { used: 1, size: 100, costUsd: 0.1 },
    { used: 1, size: 100, totalTokens: 1 },
  ])("rejects malformed context counters or billing fields: %j", (payload) => {
    expect(() => parseRuntimeEventEnvelope(envelope(payload))).toThrow();
    expect(
      ingestRuntimeEventInput(context, { kind: "context.usage.updated", payload }),
    ).toMatchObject({ status: "rejected" });
  });
});
