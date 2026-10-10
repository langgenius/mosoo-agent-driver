import { describe, expect, test } from "bun:test";

import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-event-envelope";
import { parseDriverEventEnvelope } from "../src/protocol/events";
import type { EventId } from "../src/protocol/id";
import type { NativeCheckpoint } from "../src/protocol/native-checkpoint";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  ingestRuntimeEventInput,
  parseRuntimeEventEnvelope,
  type RuntimeEventBuildContext,
} from "../src/runtime-events";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

const checkpoint = {
  formatVersion: 1,
  nativeRef: { kind: "openai_thread_id", runtimeId: "openai-runtime", value: "thread-1" },
  runId: DRIVER_TEST_IDS.runId,
} satisfies NativeCheckpoint;
const eventFields = {
  actor: "driver",
  delivery: "lossless",
  driverInstanceId: DRIVER_TEST_IDS.driverInstanceId,
  id: "01J0000000000000000000000G" as EventId,
  occurredAt: "2026-10-10T00:00:00.000Z",
  origin: "driver",
  runtimeId: checkpoint.nativeRef.runtimeId,
  schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
  sessionId: DRIVER_TEST_IDS.sessionId,
  visibility: "participant",
} as const;
const completedEvent = {
  ...eventFields,
  kind: "run.completed",
  payload: { checkpoint, finalMessageId: "message-1" },
  runId: checkpoint.runId,
} as const;
const resetPayload = {
  newNativeRef: { ...checkpoint.nativeRef, value: "thread-2" },
  previousCheckpoint: checkpoint,
  previousNativeRef: checkpoint.nativeRef,
};
const resetEvent = {
  ...eventFields,
  kind: "runtime.session.reset",
  payload: resetPayload,
} as const;
const sessionContext = {
  createId: () => eventFields.id,
  driverInstanceId: eventFields.driverInstanceId,
  occurredAt: eventFields.occurredAt,
  runtimeId: eventFields.runtimeId,
  sessionId: eventFields.sessionId,
} satisfies RuntimeEventBuildContext;
const runContext = { ...sessionContext, runId: checkpoint.runId };

function expectRejectedEnvelope(event: unknown): void {
  expect(() => parseRuntimeEventEnvelope(event)).toThrow();
  expect(ingestRuntimeEventInput(runContext, event)).toMatchObject({ status: "rejected" });
}

describe("completed run checkpoints", () => {
  test("admits the explicit checkpoint through envelope and draft ingress", () => {
    expect(parseRuntimeEventEnvelope(completedEvent)).toEqual(completedEvent);
    expect(ingestRuntimeEventInput(runContext, completedEvent)).toEqual({
      event: completedEvent,
      status: "accepted",
    });
    expect(
      ingestRuntimeEventInput(runContext, {
        kind: completedEvent.kind,
        payload: completedEvent.payload,
      }),
    ).toEqual({ event: completedEvent, status: "accepted" });
  });

  test.each([
    ["missing", {}],
    ["null", { checkpoint: null }],
    ["unsupported version", { checkpoint: { ...checkpoint, formatVersion: 2 } }],
    ["invalid run ID", { checkpoint: { ...checkpoint, runId: "../outside" } }],
    ["invalid native ref", { checkpoint: { ...checkpoint, nativeRef: {} } }],
    ["another run", { checkpoint: { ...checkpoint, runId: DRIVER_TEST_IDS.secondRunId } }],
    [
      "another runtime",
      {
        checkpoint: {
          ...checkpoint,
          nativeRef: {
            kind: "claude_session_id",
            runtimeId: "claude-agent-sdk",
            value: "session-1",
          },
        },
      },
    ],
    ["extra checkpoint path", { checkpoint: { ...checkpoint, path: "../../outside" } }],
  ] as const)("rejects %s checkpoints at both ingress boundaries", (_name, payload) => {
    expectRejectedEnvelope({ ...completedEvent, payload });
    expect(
      ingestRuntimeEventInput(runContext, { kind: completedEvent.kind, payload }),
    ).toMatchObject({
      status: "rejected",
    });
  });

  test.each(["runId", "runtimeId"])("requires the envelope %s for checkpoint identity", (field) => {
    const event: Record<string, unknown> = { ...completedEvent };
    delete event[field];
    expectRejectedEnvelope(event);
  });

  test("rejects the previous event schema version", () => {
    expectRejectedEnvelope({ ...completedEvent, schemaVersion: "2026-08-29" });
  });
});

describe("runtime session reset events", () => {
  test.each([
    ["no checkpoint", null],
    ["a committed checkpoint", checkpoint],
  ] as const)("admits a reset with %s", (_name, previousCheckpoint) => {
    const payload = { ...resetPayload, previousCheckpoint };
    const event = { ...resetEvent, payload };

    expect(parseRuntimeEventEnvelope(event)).toEqual(event);
    expect(ingestRuntimeEventInput(runContext, event)).toEqual({ event, status: "accepted" });
    expect(ingestRuntimeEventInput(sessionContext, { kind: event.kind, payload })).toEqual({
      event,
      status: "accepted",
    });
  });

  test("preserves explicit session scope while another run is active", () => {
    const [envelope] = toDriverEventEnvelopes(
      driverBootPayload,
      { kind: resetEvent.kind, payload: resetPayload, runId: null },
      DRIVER_TEST_IDS.secondRunId,
    );

    expect(envelope?.event).toMatchObject({ kind: resetEvent.kind, payload: resetPayload });
    expect(Object.hasOwn(envelope!.event, "runId")).toBe(false);
    expect(parseDriverEventEnvelope(envelope)).toEqual(envelope);
    expect(() =>
      toDriverEventEnvelopes(
        driverBootPayload,
        { kind: resetEvent.kind, payload: resetPayload },
        DRIVER_TEST_IDS.secondRunId,
      ),
    ).toThrow("must be scoped to the session");
  });

  test.each([null, DRIVER_TEST_IDS.runId])("rejects an explicit wire run ID %p", (runId) => {
    expectRejectedEnvelope({ ...resetEvent, runId });
  });

  test.each(["driverInstanceId", "runtimeId"])("requires the envelope %s", (field) => {
    const event: Record<string, unknown> = { ...resetEvent };
    delete event[field];
    expectRejectedEnvelope(event);
  });

  test("requires lossless delivery", () => {
    expectRejectedEnvelope({ ...resetEvent, delivery: "best_effort" });
  });

  test.each(["previousCheckpoint", "previousNativeRef", "newNativeRef"])(
    "requires the reset payload field %s",
    (field) => {
      const payload: Record<string, unknown> = { ...resetPayload };
      delete payload[field];

      expectRejectedEnvelope({ ...resetEvent, payload });
      expect(
        ingestRuntimeEventInput(sessionContext, { kind: resetEvent.kind, payload }),
      ).toMatchObject({
        status: "rejected",
      });
    },
  );

  test.each([
    ["invalid checkpoint", { previousCheckpoint: { ...checkpoint, formatVersion: 2 } }],
    ["invalid previous ref", { previousNativeRef: null }],
    ["invalid new ref", { newNativeRef: null }],
    [
      "different previous ref",
      { previousNativeRef: { ...checkpoint.nativeRef, value: "thread-3" } },
    ],
    [
      "different checkpoint runtime",
      {
        previousCheckpoint: {
          ...checkpoint,
          nativeRef: {
            kind: "claude_session_id",
            runtimeId: "claude-agent-sdk",
            value: "thread-1",
          },
        },
      },
    ],
    [
      "different previous runtime without a checkpoint",
      {
        previousCheckpoint: null,
        previousNativeRef: {
          kind: "claude_session_id",
          runtimeId: "claude-agent-sdk",
          value: "session-1",
        },
      },
    ],
    [
      "different new runtime",
      {
        newNativeRef: {
          kind: "claude_session_id",
          runtimeId: "claude-agent-sdk",
          value: "session-2",
        },
      },
    ],
  ] as const)("rejects a reset with %s", (_name, fields) => {
    const payload = { ...resetPayload, ...fields };
    expectRejectedEnvelope({ ...resetEvent, payload });
    expect(
      ingestRuntimeEventInput(sessionContext, { kind: resetEvent.kind, payload }),
    ).toMatchObject({
      status: "rejected",
    });
  });

  test.each([
    "runId",
    "runtimeId",
    "sessionId",
    "driverInstanceId",
    "traceId",
    "path",
    "relativePath",
  ])("rejects the extra reset payload field %s", (field) => {
    const payload = { ...resetPayload, [field]: "unexpected" };
    expectRejectedEnvelope({ ...resetEvent, payload });
    expect(
      ingestRuntimeEventInput(sessionContext, { kind: resetEvent.kind, payload }),
    ).toMatchObject({
      status: "rejected",
    });
  });

  test("strips native ref extensions using the shared ref parser", () => {
    expect(
      parseRuntimeEventEnvelope({
        ...resetEvent,
        payload: {
          previousCheckpoint: {
            ...checkpoint,
            nativeRef: { ...checkpoint.nativeRef, extra: true },
          },
          previousNativeRef: { ...resetPayload.previousNativeRef, extra: true },
          newNativeRef: { ...resetPayload.newNativeRef, extra: true },
        },
      }),
    ).toEqual(resetEvent);
  });
});
