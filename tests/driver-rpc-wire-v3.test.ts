import { describe, expect, test } from "bun:test";

import { DRIVER_PROTOCOL_VERSION } from "../src/protocol/boot";
import { driverRuntimeRpcSchemas } from "../src/protocol/orpc";
import {
  RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
  measureRuntimeCommandJson,
} from "../src/runtime-command";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

const invalidPositiveSafeIntegers = [
  0,
  -1,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
] as const;
const invalidNonNegativeSafeIntegers = invalidPositiveSafeIntegers.slice(1);

function helloInput(overrides: Record<string, unknown> = {}) {
  return {
    capabilities: [],
    driverVersion: "test",
    pid: 1,
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    runtime: "acp-fallback",
    startedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function helloOutput(runConfig: Record<string, unknown> = {}, runId: string | null = null) {
  return {
    acceptedCapabilities: [],
    connectionId: "connection-1",
    driverInstanceId: "driver-1",
    heartbeatIntervalMs: 250,
    runConfig: {
      commandLeaseMs: 0,
      envPolicy: "strict",
      eventBatchMaxSize: 1,
      organizationPath: "/workspace",
      ...runConfig,
    },
    runId,
  };
}

function heartbeatInput(pid: number, at = "2026-08-29T00:00:00.000Z") {
  return { at, pid, reason: "interval" };
}

function readyInput(pid: number) {
  return {
    at: "2026-08-29T00:00:00.000Z",
    driverInstanceId: "driver-1",
    pid,
  };
}

function logBatch(seq: number) {
  return {
    driverInstanceId: "driver-1",
    logs: [{ level: "info", message: "message", seq, timestamp: "now" }],
  };
}

function eventBatchOutput(seq: number, type = "message.delta") {
  return { accepted: [{ eventId: "source-1", seq, type }] };
}

function diagnosticEvent(payload: Record<string, unknown> = { message: "ok" }) {
  return {
    actor: "driver",
    delivery: "lossless",
    driverInstanceId: DRIVER_TEST_IDS.driverInstanceId,
    id: "01J0000000000000000000000G",
    kind: "diagnostic.reported",
    occurredAt: "2026-08-29T00:00:00.000Z",
    origin: "driver",
    payload,
    runId: DRIVER_TEST_IDS.runId,
    schemaVersion: "2026-08-29",
    sessionId: DRIVER_TEST_IDS.sessionId,
    visibility: "owner_debug",
  };
}

function textFieldAtJsonSize<Value>(targetBytes: number, create: (text: string) => Value): Value {
  const remaining = targetBytes - measureRuntimeCommandJson(create(""));
  const value = create("x".repeat(remaining));

  expect(measureRuntimeCommandJson(value)).toBe(targetBytes);
  return value;
}

describe("Driver RPC wire v3", () => {
  test.each([2, 4] as const)("rejects protocol version %d", (protocolVersion) => {
    expect(
      driverRuntimeRpcSchemas.driver.hello.input.safeParse(helloInput({ protocolVersion })).success,
    ).toBeFalse();
  });

  test.each(invalidPositiveSafeIntegers)(
    "rejects %p at every positive safe-integer field",
    (value) => {
      expect(
        driverRuntimeRpcSchemas.driver.hello.input.safeParse(helloInput({ pid: value })).success,
      ).toBeFalse();
      expect(
        driverRuntimeRpcSchemas.driver.heartbeat.input.safeParse(heartbeatInput(value)).success,
      ).toBeFalse();
      expect(driverRuntimeRpcSchemas.driver.ready.input.safeParse(readyInput(value)).success).toBe(
        false,
      );
      expect(
        driverRuntimeRpcSchemas.driver.hello.output.safeParse(
          helloOutput({ eventBatchMaxSize: value }),
        ).success,
      ).toBeFalse();
      expect(
        driverRuntimeRpcSchemas.driver.claimExternalToolEffect.output.safeParse({
          attempt: value,
          effectId: "effect-1",
          idempotencyKey: "idempotency-1",
          kind: "claimed",
        }).success,
      ).toBeFalse();
    },
  );

  test.each([
    [64, true],
    [65, false],
  ] as const)("validates wire-safe event batch limit %d", (eventBatchMaxSize, accepted) => {
    expect(
      driverRuntimeRpcSchemas.driver.hello.output.safeParse(helloOutput({ eventBatchMaxSize }))
        .success,
    ).toBe(accepted);
  });

  test.each([
    0,
    249,
    250.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ] as const)("rejects invalid heartbeat interval %p", (heartbeatIntervalMs) => {
    expect(
      driverRuntimeRpcSchemas.driver.hello.output.safeParse({
        ...helloOutput(),
        heartbeatIntervalMs,
      }).success,
    ).toBeFalse();
  });

  test.each(invalidNonNegativeSafeIntegers)(
    "rejects %p at every non-negative safe-integer field",
    (value) => {
      expect(
        driverRuntimeRpcSchemas.driver.hello.output.safeParse(
          helloOutput({ commandLeaseMs: value }),
        ).success,
      ).toBeFalse();
      expect(
        driverRuntimeRpcSchemas.driver.heartbeat.output.safeParse({
          heartbeatCount: value,
          ok: true,
        }).success,
      ).toBeFalse();
      expect(driverRuntimeRpcSchemas.driver.pushLogs.input.safeParse(logBatch(value)).success).toBe(
        false,
      );
      expect(
        driverRuntimeRpcSchemas.driver.pushEvents.output.safeParse(eventBatchOutput(value)).success,
      ).toBeFalse();
    },
  );

  test("accepts zero at every non-negative safe-integer field", () => {
    expect(driverRuntimeRpcSchemas.driver.hello.output.safeParse(helloOutput()).success).toBeTrue();
    expect(
      driverRuntimeRpcSchemas.driver.heartbeat.output.safeParse({ heartbeatCount: 0, ok: true })
        .success,
    ).toBeTrue();
    expect(driverRuntimeRpcSchemas.driver.pushLogs.input.safeParse(logBatch(0)).success).toBeTrue();
    expect(
      driverRuntimeRpcSchemas.driver.pushEvents.output.safeParse(eventBatchOutput(0)).success,
    ).toBeTrue();
  });

  test.each([
    ["event", "events", { event: diagnosticEvent(), eventId: "source-1" }],
    ["log", "logs", logBatch(0).logs[0]],
  ] as const)("bounds %s batches at 64 entries", (_label, field, entry) => {
    const schema =
      field === "events"
        ? driverRuntimeRpcSchemas.driver.pushEvents.input
        : driverRuntimeRpcSchemas.driver.pushLogs.input;
    const input = (length: number) => ({
      driverInstanceId: "driver-1",
      [field]: Array.from({ length }, () => entry),
    });

    expect(schema.safeParse(input(64)).success).toBeTrue();
    expect(schema.safeParse(input(65)).success).toBeFalse();
  });

  test.each([
    [
      "failure message",
      driverRuntimeRpcSchemas.driver.failRun.input,
      {
        driverInstanceId: "driver-1",
        error: { code: "failed", details: {}, message: "", retryable: false },
        runId: "run-1",
      },
    ],
    ["receipt type", driverRuntimeRpcSchemas.driver.pushEvents.output, eventBatchOutput(0, "")],
  ] as const)("rejects an empty %s", (_label, schema, input) => {
    expect(schema.safeParse(input).success).toBeFalse();
  });

  test("rejects an unknown receipt event type", () => {
    expect(
      driverRuntimeRpcSchemas.driver.pushEvents.output.safeParse(
        eventBatchOutput(0, "future.event"),
      ).success,
    ).toBeFalse();
  });

  test.each([
    [driverRuntimeRpcSchemas.driver.completeRun.input, { driverInstanceId: "driver-1" }],
    [driverRuntimeRpcSchemas.driver.completeRun.input, { driverInstanceId: "driver-1", runId: "" }],
    [
      driverRuntimeRpcSchemas.driver.failRun.input,
      {
        driverInstanceId: "driver-1",
        error: { code: "failed", details: {}, message: "failed", retryable: false },
      },
    ],
    [
      driverRuntimeRpcSchemas.driver.failRun.input,
      {
        driverInstanceId: "driver-1",
        error: { code: "failed", details: {}, message: "failed", retryable: false },
        runId: "",
      },
    ],
  ] as const)("requires an exact run id for every control terminal", (schema, input) => {
    expect(schema.safeParse(input).success).toBeFalse();
  });

  test.each([
    ["missing", { accepted: [{ seq: 0, type: "message.delta" }] }],
    ["empty", { accepted: [{ eventId: "", seq: 0, type: "message.delta" }] }],
    ["non-string", { accepted: [{ eventId: 1, seq: 0, type: "message.delta" }] }],
  ] as const)("rejects %s receipt eventId", (_label, input) => {
    expect(driverRuntimeRpcSchemas.driver.pushEvents.output.safeParse(input).success).toBeFalse();
  });

  test("rejects empty handshake identity fields", () => {
    expect(
      driverRuntimeRpcSchemas.driver.hello.input.safeParse(helloInput({ startedAt: "" })).success,
    ).toBeFalse();
    expect(
      driverRuntimeRpcSchemas.driver.heartbeat.input.safeParse(heartbeatInput(1, "")).success,
    ).toBeFalse();
    expect(driverRuntimeRpcSchemas.driver.hello.output.safeParse(helloOutput({}, "")).success).toBe(
      false,
    );
  });

  test("bounds run and mutually exclusive command terminal payloads", () => {
    const error = textFieldAtJsonSize(
      RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
      (message) => ({ code: "failed", details: {}, message, retryable: false }),
    );
    const result = textFieldAtJsonSize(
      RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
      (outputText) => ({
        outputText,
        requestId: "request-1",
        serverId: "server-1",
        toolName: "tool-1",
      }),
    );
    const commandUpdate = driverRuntimeRpcSchemas.driver.commandUpdate.input;
    const failRun = driverRuntimeRpcSchemas.driver.failRun.input;

    expect(failRun.safeParse({ driverInstanceId: "driver-1", error, runId: "run-1" }).success).toBe(
      true,
    );
    expect(
      failRun.safeParse({
        driverInstanceId: "driver-1",
        error: { ...error, message: `${error.message}x` },
        runId: "run-1",
      }).success,
    ).toBeFalse();

    expect(
      commandUpdate.safeParse({
        commandId: "command-1",
        driverInstanceId: "driver-1",
        error,
        status: "failed",
      }).success,
    ).toBeTrue();
    expect(
      commandUpdate.safeParse({
        commandId: "command-1",
        driverInstanceId: "driver-1",
        error: { ...error, message: `${error.message}x` },
        status: "failed",
      }).success,
    ).toBeFalse();
    expect(
      commandUpdate.safeParse({
        commandId: "command-1",
        driverInstanceId: "driver-1",
        result,
        status: "completed",
      }).success,
    ).toBeTrue();
    expect(
      commandUpdate.safeParse({
        commandId: "command-1",
        driverInstanceId: "driver-1",
        result: { ...result, outputText: `${result.outputText}x` },
        status: "completed",
      }).success,
    ).toBeFalse();
    expect(
      commandUpdate.safeParse({
        commandId: "command-1",
        driverInstanceId: "driver-1",
        error,
        result: null,
        status: "failed",
      }).success,
    ).toBeFalse();
  });

  test.each(["queued", "delivered", "expired"] as const)(
    "rejects database-only command status %s on Driver updates",
    (status) => {
      expect(
        driverRuntimeRpcSchemas.driver.commandUpdate.input.safeParse({
          commandId: "command-1",
          driverInstanceId: "driver-1",
          status,
        }).success,
      ).toBeFalse();
    },
  );

  test("enforces command update payloads by terminal status", () => {
    const schema = driverRuntimeRpcSchemas.driver.commandUpdate.input;
    const identity = { commandId: "command-1", driverInstanceId: "driver-1" };
    const error = { code: "failed", details: {}, message: "failed", retryable: false };
    const result = { requestId: "request-1" };

    for (const valid of [
      { ...identity, status: "accepted" },
      { ...identity, status: "cancelled" },
      { ...identity, status: "completed" },
      { ...identity, result, status: "completed" },
      { ...identity, error, status: "failed" },
    ]) {
      expect(schema.safeParse(valid).success).toBeTrue();
    }

    for (const invalid of [
      { ...identity, error, status: "accepted" },
      { ...identity, result, status: "accepted" },
      { ...identity, error, status: "cancelled" },
      { ...identity, result, status: "cancelled" },
      { ...identity, error, status: "completed" },
      { ...identity, result: null, status: "completed" },
      { ...identity, status: "failed" },
      { ...identity, error, result, status: "failed" },
    ]) {
      expect(schema.safeParse(invalid).success).toBeFalse();
    }
  });

  test("rejects duplicate capabilities on both sides of the handshake", () => {
    const capability = { id: "text_stream", status: "supported", version: 1 };

    expect(
      driverRuntimeRpcSchemas.driver.hello.input.safeParse(
        helloInput({ capabilities: [capability, capability] }),
      ).success,
    ).toBeFalse();
    expect(
      driverRuntimeRpcSchemas.driver.hello.output.safeParse({
        ...helloOutput(),
        acceptedCapabilities: [capability, capability],
      }).success,
    ).toBeFalse();
  });

  test("rejects unknown keys on every fixed RPC input and output object", () => {
    const failure = { code: "failed", details: {}, message: "failed", retryable: false };
    const claim = {
      attempt: 1,
      effectId: "effect-1",
      idempotencyKey: "idempotency-1",
      kind: "claimed",
    };
    const cases = [
      [
        driverRuntimeRpcSchemas.driver.observeExternalToolEffect.input,
        { commandId: "command-1", driverInstanceId: "driver-1" },
      ],
      [
        driverRuntimeRpcSchemas.driver.observeExternalToolEffect.output,
        { effectId: "effect-1", kind: "intent" },
      ],
      [
        driverRuntimeRpcSchemas.driver.claimExternalToolEffect.input,
        {
          claimToken: "00000000-0000-4000-8000-000000000001",
          commandId: "command-1",
          driverInstanceId: "driver-1",
        },
      ],
      [driverRuntimeRpcSchemas.driver.claimExternalToolEffect.output, claim],
      [
        driverRuntimeRpcSchemas.driver.commandUpdate.input,
        { commandId: "command-1", driverInstanceId: "driver-1", status: "accepted" },
      ],
      [driverRuntimeRpcSchemas.driver.commandUpdate.output, { ok: true }],
      [
        driverRuntimeRpcSchemas.driver.completeRun.input,
        { driverInstanceId: "driver-1", runId: "run-1" },
      ],
      [driverRuntimeRpcSchemas.driver.completeRun.output, { ok: true }],
      [
        driverRuntimeRpcSchemas.driver.failRun.input,
        { driverInstanceId: "driver-1", error: failure, runId: "run-1" },
      ],
      [driverRuntimeRpcSchemas.driver.failRun.output, { ok: true }],
      [driverRuntimeRpcSchemas.driver.heartbeat.input, heartbeatInput(1)],
      [driverRuntimeRpcSchemas.driver.heartbeat.output, { heartbeatCount: 0, ok: true }],
      [driverRuntimeRpcSchemas.driver.hello.input, helloInput()],
      [driverRuntimeRpcSchemas.driver.hello.output, helloOutput()],
      [
        driverRuntimeRpcSchemas.driver.settleExternalToolEffect.input,
        {
          claimToken: "00000000-0000-4000-8000-000000000001",
          commandId: "command-1",
          driverInstanceId: "driver-1",
          effectId: "effect-1",
          settlement: { kind: "unknown" },
        },
      ],
      [
        driverRuntimeRpcSchemas.driver.settleExternalToolEffect.output,
        { effectId: "effect-1", kind: "unknown" },
      ],
      [
        driverRuntimeRpcSchemas.driver.pushEvents.input,
        {
          driverInstanceId: "driver-1",
          events: [{ event: diagnosticEvent(), eventId: "source-1" }],
        },
      ],
      [driverRuntimeRpcSchemas.driver.pushEvents.output, eventBatchOutput(0)],
      [driverRuntimeRpcSchemas.driver.pushLogs.input, logBatch(0)],
      [driverRuntimeRpcSchemas.driver.pushLogs.output, { ok: true }],
      [driverRuntimeRpcSchemas.driver.ready.input, readyInput(1)],
      [driverRuntimeRpcSchemas.driver.ready.output, { ok: true }],
      [driverRuntimeRpcSchemas.driverInstance.nextCommand.input, { driverInstanceId: "driver-1" }],
      [driverRuntimeRpcSchemas.driverInstance.nextCommand.output, { command: null }],
    ] as const;

    for (const [schema, value] of cases) {
      expect(schema.safeParse({ ...value, future: true }).success).toBeFalse();
    }
  });

  test("rejects unknown keys on nested fixed RPC objects but preserves event payload extensions", () => {
    const event = diagnosticEvent({ future: { nested: true }, message: "ok" });
    const nestedCases = [
      [
        driverRuntimeRpcSchemas.driver.hello.input,
        helloInput({
          capabilities: [{ future: true, id: "text_stream", status: "supported", version: 1 }],
        }),
      ],
      [driverRuntimeRpcSchemas.driver.hello.output, helloOutput({ future: true })],
      [
        driverRuntimeRpcSchemas.driver.failRun.input,
        {
          driverInstanceId: "driver-1",
          error: { code: "failed", details: {}, future: true, message: "failed", retryable: false },
          runId: "run-1",
        },
      ],
      [
        driverRuntimeRpcSchemas.driver.commandUpdate.input,
        {
          commandId: "command-1",
          driverInstanceId: "driver-1",
          result: { future: true, requestId: "request-1" },
          status: "completed",
        },
      ],
      [
        driverRuntimeRpcSchemas.driver.settleExternalToolEffect.input,
        {
          claimToken: "00000000-0000-4000-8000-000000000001",
          commandId: "command-1",
          driverInstanceId: "driver-1",
          effectId: "effect-1",
          settlement: { future: true, kind: "unknown" },
        },
      ],
      [
        driverRuntimeRpcSchemas.driver.pushLogs.input,
        { driverInstanceId: "driver-1", logs: [{ ...logBatch(0).logs[0], future: true }] },
      ],
      [
        driverRuntimeRpcSchemas.driver.pushLogs.input,
        {
          driverInstanceId: "driver-1",
          logs: [{ ...logBatch(0).logs[0], context: { future: true } }],
        },
      ],
      [
        driverRuntimeRpcSchemas.driver.pushLogs.input,
        {
          driverInstanceId: "driver-1",
          logs: [
            { ...logBatch(0).logs[0], error: { future: true, message: "failed", name: "Error" } },
          ],
        },
      ],
      [
        driverRuntimeRpcSchemas.driver.pushEvents.input,
        { driverInstanceId: "driver-1", events: [{ event, eventId: "source-1", future: true }] },
      ],
      [
        driverRuntimeRpcSchemas.driver.pushEvents.input,
        {
          driverInstanceId: "driver-1",
          events: [{ event: { ...event, future: true }, eventId: "source-1" }],
        },
      ],
      [
        driverRuntimeRpcSchemas.driver.pushEvents.input,
        {
          driverInstanceId: "driver-1",
          events: [
            {
              event: { ...event, native: { future: true, provider: "openai" } },
              eventId: "source-1",
            },
          ],
        },
      ],
      [
        driverRuntimeRpcSchemas.driver.pushEvents.output,
        { accepted: [{ ...eventBatchOutput(0).accepted[0], future: true }] },
      ],
    ] as const;

    for (const [schema, value] of nestedCases) {
      expect(schema.safeParse(value).success).toBeFalse();
    }

    expect(
      driverRuntimeRpcSchemas.driver.pushEvents.input.safeParse({
        driverInstanceId: "driver-1",
        events: [{ event, eventId: "source-1" }],
      }).success,
    ).toBeTrue();
  });

  test("preserves empty log and tracing strings", () => {
    expect(
      driverRuntimeRpcSchemas.driver.pushLogs.input.safeParse({
        driverInstanceId: "driver-1",
        logs: [
          {
            context: { spanId: "", traceId: "" },
            error: { message: "", name: "" },
            level: "error",
            message: "",
            seq: 0,
            timestamp: "now",
          },
        ],
      }).success,
    ).toBeTrue();
  });

  test("rejects the previous runtime event schema", () => {
    expect(
      driverRuntimeRpcSchemas.driver.pushEvents.input.safeParse({
        driverInstanceId: DRIVER_TEST_IDS.driverInstanceId,
        events: [
          {
            event: {
              actor: "driver",
              delivery: "lossless",
              driverInstanceId: DRIVER_TEST_IDS.driverInstanceId,
              id: "01J0000000000000000000000G",
              kind: "diagnostic.reported",
              occurredAt: "2026-08-29T00:00:00.000Z",
              origin: "driver",
              payload: { message: "ok" },
              schemaVersion: "2026-05-26",
              sessionId: DRIVER_TEST_IDS.sessionId,
              visibility: "owner_debug",
            },
            eventId: "source-1",
          },
        ],
      }).success,
    ).toBeFalse();
  });
});
