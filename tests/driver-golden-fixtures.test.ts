import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { DriverCommandDelivery } from "../src/core/driver-command-delivery";
import type { EventId } from "../src/protocol/id";
import { parseDriverEventEnvelope } from "../src/protocol/events";
import {
  DURABLE_RUN_ERROR_MAX_UTF8_BYTES,
  RUNTIME_COMMAND_MAX_UTF8_BYTES,
  measureRuntimeCommandJson,
  normalizeDurableRunError,
  parseRuntimeCommand,
} from "../src/runtime-command";
import type { RuntimeCommandInput } from "../src/runtime-command";
import { ingestRuntimeEventInput } from "../src/runtime-events";
import type { RuntimeEventBuildContext } from "../src/runtime-events";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

const occurredAt = "2026-05-26T00:00:00.000Z";
const eventId = "01J0000000000000000000000G" as EventId;

const commandFixtures = [
  "input-start",
  "mcp-execute",
  "permission-resolve",
  "session-stop",
  "turn-cancel",
] as const;

const runtimeEventFixtures = [
  "agent-tasks-replaced",
  "diagnostic-reported",
  "message-delta",
  "permission-requested",
  "run-started",
  "tool-call-deltas",
  "tool-call-updated",
  "usage-updated",
] as const;

function readJsonFixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

function textFieldAtJsonSize<Value>(
  targetBytes: number,
  create: (text: string) => Value,
  unit = "x",
): Value {
  const baseBytes = measureRuntimeCommandJson(create(""));
  const unitBytes = measureRuntimeCommandJson(create(unit)) - baseBytes;
  const remaining = targetBytes - baseBytes;
  const value = create(
    unit.repeat(Math.floor(remaining / unitBytes)) + "x".repeat(remaining % unitBytes),
  );

  expect(measureRuntimeCommandJson(value)).toBe(targetBytes);
  return value;
}

function mcpCommandAtSize(targetBytes: number, unit = "x") {
  return textFieldAtJsonSize(
    targetBytes,
    (argumentsJson) => ({
      argumentsJson,
      commandId: "command-1",
      kind: "mcp.execute" as const,
      requestId: "request-1",
      runId: DRIVER_TEST_IDS.runId,
      serverId: "server-1",
      toolCallId: "tool-call-1",
      toolName: "tool-1",
    }),
    unit,
  );
}

function createRuntimeEventContext(): RuntimeEventBuildContext {
  return {
    createId: () => eventId,
    driverInstanceId: DRIVER_TEST_IDS.driverInstanceId,
    occurredAt,
    runId: DRIVER_TEST_IDS.runId,
    runtimeId: "runtime-1",
    sessionId: DRIVER_TEST_IDS.sessionId,
    traceId: "trace-1",
  };
}

describe("Driver golden fixtures", () => {
  test.each(commandFixtures)("parses runtime command fixture %s", (name) => {
    const fixture = readJsonFixture(`./fixtures/driver/commands/${name}.json`);
    expect(parseRuntimeCommand(fixture)).toEqual(fixture);
  });

  test("preserves validated attachment provenance on the exported command input", () => {
    const fixture = readJsonFixture("./fixtures/driver/commands/input-start.json") as {
      readonly input: { readonly text: string };
    };
    const attachmentIds = ["file-1"];
    const input = {
      ...fixture.input,
      attachmentIds,
    } satisfies RuntimeCommandInput;
    const parsed = parseRuntimeCommand({ ...fixture, input });
    attachmentIds[0] = "mutated";

    expect(parsed).toEqual({ ...fixture, input: { ...input, attachmentIds: ["file-1"] } });
  });

  test("keeps attachment provenance in replay identity after provider projection", () => {
    const fixture = readJsonFixture("./fixtures/driver/commands/input-start.json") as {
      readonly input: Record<string, unknown>;
    };
    const first = { ...fixture, input: { ...fixture.input, attachmentIds: ["file-1"] } };
    const changed = { ...fixture, input: { ...fixture.input, attachmentIds: ["file-2"] } };
    const delivery = new DriverCommandDelivery(new AbortController().signal);

    delivery.receive(parseRuntimeCommand(first), first);

    expect(() => delivery.replay(parseRuntimeCommand(changed), changed)).toThrow(
      "replayed with changed identity or content",
    );
  });

  test("rejects malformed input attachment IDs", () => {
    const fixture = readJsonFixture("./fixtures/driver/commands/input-start.json") as {
      readonly input: Record<string, unknown>;
    };

    expect(() =>
      parseRuntimeCommand({
        ...fixture,
        input: { ...fixture.input, attachmentIds: [""] },
      }),
    ).toThrow("input.attachmentIds must be an array of non-empty strings.");
  });

  test.each(commandFixtures)("rejects undeclared fields on runtime command %s", (name) => {
    const fixture = readJsonFixture(`./fixtures/driver/commands/${name}.json`);

    expect(() => parseRuntimeCommand({ ...(fixture as object), extra: true })).toThrow(
      "runtime command.extra is not allowed.",
    );
  });

  test("rejects undeclared fields on runtime command input", () => {
    const fixture = readJsonFixture("./fixtures/driver/commands/input-start.json") as {
      readonly input: Record<string, unknown>;
    };

    expect(() =>
      parseRuntimeCommand({ ...fixture, input: { ...fixture.input, extra: true } }),
    ).toThrow("input.extra is not allowed.");
  });

  test.each(["input-start", "mcp-execute", "permission-resolve", "turn-cancel"] as const)(
    "requires runId on run-scoped runtime command %s",
    (name) => {
      const fixture = readJsonFixture(`./fixtures/driver/commands/${name}.json`) as Record<
        string,
        unknown
      >;
      const { runId: _runId, ...withoutRunId } = fixture;

      expect(() => parseRuntimeCommand(withoutRunId)).toThrow("runId must be a non-empty string.");
    },
  );

  test.each(runtimeEventFixtures)("ingests runtime event fixture %s", (name) => {
    const outcome = ingestRuntimeEventInput(
      createRuntimeEventContext(),
      readJsonFixture(`./fixtures/driver/runtime-event-drafts/${name}.json`),
    );

    expect(outcome).toMatchObject({
      status: "accepted",
    });

    if (outcome.status !== "accepted") {
      throw new Error(outcome.rejection.message);
    }

    expect(outcome.event).toEqual(
      readJsonFixture(`./fixtures/driver/runtime-event-envelopes/${name}.json`),
    );
  });

  test("rejects extensions on fixed event envelope layers while preserving payload extensions", () => {
    const context = createRuntimeEventContext();
    const fixture = readJsonFixture(
      "./fixtures/driver/runtime-event-envelopes/diagnostic-reported.json",
    ) as Record<string, unknown>;

    expect(ingestRuntimeEventInput(context, { ...fixture, context: {} })).toMatchObject({
      rejection: { message: "Runtime event context is not allowed." },
      status: "rejected",
    });
    expect(
      ingestRuntimeEventInput(context, {
        ...fixture,
        native: { future: true, provider: "openai" },
      }),
    ).toMatchObject({
      rejection: { message: "Runtime event native reference future is not allowed." },
      status: "rejected",
    });
    expect(() =>
      parseDriverEventEnvelope({ event: fixture, eventId: "event-1", sequence: 1 }),
    ).toThrow("Driver event envelope sequence is not allowed.");

    const accepted = ingestRuntimeEventInput(context, {
      kind: "diagnostic.reported",
      payload: { code: "driver.test", future: { nested: true } },
    });
    expect(accepted).toMatchObject({
      event: { payload: { code: "driver.test", future: { nested: true } } },
      status: "accepted",
    });
    if (accepted.status === "accepted") {
      expect(ingestRuntimeEventInput(context, accepted.event)).toEqual(accepted);
    }
  });

  test("owns tool call snapshot and delta payload semantics", () => {
    const context = createRuntimeEventContext();
    const event = {
      kind: "tool.call.updated" as const,
      payload: {
        future: { nested: true },
        rawInputDelta: '{"path":',
        rawOutputDelta: "chunk",
        status: "running",
        toolCallId: "tool-delta-1",
      },
    };

    expect(ingestRuntimeEventInput(context, event)).toMatchObject({
      event: { payload: event.payload },
      status: "accepted",
    });
    expect(
      ingestRuntimeEventInput(context, {
        ...event,
        payload: { ...event.payload, rawInput: '{"path":"src"}' },
      }),
    ).toMatchObject({
      rejection: {
        message:
          "Runtime event tool.call.updated payload cannot contain both rawInput and rawInputDelta.",
      },
      status: "rejected",
    });
    expect(
      ingestRuntimeEventInput(context, {
        ...event,
        payload: { ...event.payload, rawOutput: "complete" },
      }),
    ).toMatchObject({
      rejection: {
        message:
          "Runtime event tool.call.updated payload cannot contain both rawOutput and rawOutputDelta.",
      },
      status: "rejected",
    });

    for (const payload of [
      { ...event.payload, rawInputDelta: 1 },
      { ...event.payload, rawOutputDelta: null },
    ]) {
      expect(ingestRuntimeEventInput(context, { ...event, payload })).toMatchObject({
        status: "rejected",
      });
    }

    expect(
      ingestRuntimeEventInput(context, {
        ...event,
        payload: { ...event.payload, rawInputMode: "future-extension" },
      }),
    ).toMatchObject({
      event: { payload: { ...event.payload, rawInputMode: "future-extension" } },
      status: "accepted",
    });
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, undefined])(
    "rejects non-JSON usage payload value %p at the shared event boundary",
    (tokens) => {
      expect(
        ingestRuntimeEventInput(createRuntimeEventContext(), {
          kind: "usage.updated",
          payload: { tokens },
        }),
      ).toMatchObject({ status: "rejected" });
    },
  );

  test("enforces the shared agent task payload contract", () => {
    expect(
      ingestRuntimeEventInput(createRuntimeEventContext(), {
        kind: "agent.task.updated",
        payload: {
          active: true,
          agentId: "agent-1",
          status: "running",
          taskId: "task-1",
          taskType: "local_agent",
        },
      }),
    ).toMatchObject({ status: "accepted" });

    for (const payload of [
      { status: "running" },
      { status: "unknown", taskId: "task-1" },
      { active: "yes", taskId: "task-1" },
    ]) {
      expect(
        ingestRuntimeEventInput(createRuntimeEventContext(), {
          kind: "agent.task.updated",
          payload,
        }),
      ).toMatchObject({ status: "rejected" });
    }
  });

  test("enforces the agent task replacement envelope and payload contract", () => {
    const context = createRuntimeEventContext();
    const event = {
      delivery: "lossless" as const,
      kind: "agent.tasks.replaced" as const,
      payload: {
        tasks: [{ taskId: "task-1", taskType: "local_agent", title: "Inspect repository" }],
      },
      visibility: "participant" as const,
    };

    expect(ingestRuntimeEventInput(context, event)).toMatchObject({ status: "accepted" });

    for (const input of [
      { ...event, delivery: "best_effort" },
      { ...event, visibility: "owner_debug" },
      { ...event, payload: {} },
      { ...event, payload: { tasks: [{ taskId: "" }] } },
      { ...event, payload: { tasks: [{ private: true, taskId: "task-1" }] } },
      { ...event, payload: { tasks: [{ taskId: "task-1" }, { taskId: "task-1" }] } },
    ]) {
      expect(ingestRuntimeEventInput(context, input)).toMatchObject({ status: "rejected" });
    }

    expect(
      ingestRuntimeEventInput({ ...context, driverInstanceId: undefined }, event),
    ).toMatchObject({ status: "rejected" });
    expect(ingestRuntimeEventInput({ ...context, runId: undefined }, event)).toMatchObject({
      status: "rejected",
    });

    expect(
      ingestRuntimeEventInput(context, {
        ...event,
        payload: {
          tasks: Array.from({ length: 256 }, (_, index) => ({
            taskId: `task-${String(index)}`,
            title: "界".repeat(4_096),
          })),
        },
      }),
    ).toMatchObject({ status: "rejected" });
  });

  test("owns the completed-run final message reference schema", () => {
    const context = createRuntimeEventContext();

    for (const payload of [{ finalMessageId: "message-1" }, {}]) {
      expect(ingestRuntimeEventInput(context, { kind: "run.completed", payload })).toMatchObject({
        status: "accepted",
      });
    }

    for (const payload of [
      { finalMessageId: "" },
      { finalMessageId: null },
      { finalMessageId: 1 },
      { finalMessageId: "message-1", finalMessageText: "answer" },
      { finalMessageText: "answer" },
    ]) {
      expect(ingestRuntimeEventInput(context, { kind: "run.completed", payload })).toMatchObject({
        status: "rejected",
      });
    }
  });

  test.each([
    ["run.cancel.requested", "running", "completed"],
    ["run.cancelled", "cancelled", "completed"],
    ["run.completed", "completed", "failed"],
    ["run.dispatched", "booting", "completed"],
    ["run.failed", "failed", "completed"],
    ["run.queued", "queued", "running"],
    ["run.started", "running", "completed"],
    ["run.steered", "waiting_input", "completed"],
    ["run.waiting", "waiting_input", "completed"],
  ] as const)("requires %s to agree with payload run.status", (kind, status, inconsistent) => {
    const error = { code: "test.failed", details: {}, message: "failed", retryable: false };
    const payload = {
      ...(kind === "run.failed" ? { error, recoverable: false } : {}),
      run: {
        completedAt: null,
        error: kind === "run.failed" ? error : null,
        startedAt: occurredAt,
        status,
      },
    };

    expect(ingestRuntimeEventInput(createRuntimeEventContext(), { kind, payload })).toMatchObject({
      status: "accepted",
    });
    expect(
      ingestRuntimeEventInput(createRuntimeEventContext(), {
        kind,
        payload: { ...payload, run: { ...payload.run, status: inconsistent } },
      }),
    ).toMatchObject({
      rejection: { message: `Runtime event ${kind} payload run.status is inconsistent.` },
      status: "rejected",
    });
  });

  test.each([
    ["run.cancel.requested", "running", "completed"],
    ["run.cancelled", "cancelled", "completed"],
    ["run.completed", "completed", "failed"],
    ["run.dispatched", "booting", "completed"],
    ["run.failed", "failed", "completed"],
    ["run.queued", "queued", "running"],
    ["run.started", "running", "completed"],
    ["run.steered", "waiting_input", "completed"],
    ["run.waiting", "waiting_input", "completed"],
  ] as const)("requires %s to agree with payload status", (kind, status, inconsistent) => {
    const error = { code: "test.failed", details: {}, message: "failed", retryable: false };
    const payload = {
      ...(kind === "run.failed" ? { error, recoverable: false } : {}),
      ...(kind === "run.started" ? { startedAt: occurredAt } : {}),
      status,
    };

    expect(ingestRuntimeEventInput(createRuntimeEventContext(), { kind, payload })).toMatchObject({
      status: "accepted",
    });
    expect(
      ingestRuntimeEventInput(createRuntimeEventContext(), {
        kind,
        payload: { ...payload, status: inconsistent },
      }),
    ).toMatchObject({
      rejection: { message: `Runtime event ${kind} payload status is inconsistent.` },
      status: "rejected",
    });
  });

  test("requires failed-run recoverability to agree with the durable error", () => {
    const event = {
      kind: "run.failed" as const,
      payload: {
        error: {
          code: "driver.retryable",
          details: {},
          message: "retryable",
          retryable: true,
        },
        recoverable: true,
        status: "failed",
      },
    };

    expect(ingestRuntimeEventInput(createRuntimeEventContext(), event)).toMatchObject({
      status: "accepted",
    });
    expect(
      ingestRuntimeEventInput(createRuntimeEventContext(), {
        ...event,
        payload: { ...event.payload, recoverable: false },
      }),
    ).toMatchObject({
      rejection: {
        message: "Runtime event run.failed payload recoverable must agree with error.retryable.",
      },
      status: "rejected",
    });
    expect(
      ingestRuntimeEventInput(createRuntimeEventContext(), {
        ...event,
        payload: { ...event.payload, recoverable: "yes" },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      ingestRuntimeEventInput(createRuntimeEventContext(), {
        ...event,
        payload: { ...event.payload, recoverable: undefined },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      ingestRuntimeEventInput(createRuntimeEventContext(), {
        ...event,
        payload: {
          ...event.payload,
          error: { ...event.payload.error, retryable: undefined },
        },
      }),
    ).toMatchObject({ status: "rejected" });
  });

  test("rejects non-primitive durable run error details instead of filtering them", () => {
    expect(
      ingestRuntimeEventInput(createRuntimeEventContext(), {
        kind: "run.failed",
        payload: {
          error: {
            code: "driver.invalid_details",
            details: { nested: { value: "lost" } },
            message: "invalid details",
            retryable: false,
          },
          recoverable: false,
          status: "failed",
        },
      }),
    ).toMatchObject({
      rejection: {
        message:
          "Runtime event run.failed payload error.details.nested must be a primitive JSON value.",
      },
      status: "rejected",
    });
  });

  test("preserves control reasons within the durable command limit", () => {
    const reason = `${"x".repeat(16 * 1_024)}界`;

    expect(
      parseRuntimeCommand({
        commandId: "cancel",
        kind: "turn.cancel",
        reason,
        runId: DRIVER_TEST_IDS.runId,
      }),
    ).toMatchObject({ kind: "turn.cancel", reason });
    expect(parseRuntimeCommand({ commandId: "stop", kind: "session.stop", reason })).toMatchObject({
      kind: "session.stop",
      reason,
    });
  });

  test.each(["x", "界", "\0"])(
    "bounds canonical runtime command JSON after %p UTF-8 encoding",
    (unit) => {
      const exact = mcpCommandAtSize(RUNTIME_COMMAND_MAX_UTF8_BYTES, unit);

      expect(parseRuntimeCommand(exact)).toEqual(exact);
      expect(() =>
        parseRuntimeCommand({ ...exact, argumentsJson: `${exact.argumentsJson}x` }),
      ).toThrow(`Runtime command exceeds ${String(RUNTIME_COMMAND_MAX_UTF8_BYTES)} UTF-8 bytes.`);
    },
  );

  test.each(["x", "界", "\0"])(
    "omits an oversized command error after %p UTF-8 encoding",
    (unit) => {
      const exact = textFieldAtJsonSize(
        DURABLE_RUN_ERROR_MAX_UTF8_BYTES,
        (message) => ({ code: "driver.failed", details: {}, message, retryable: false }),
        unit,
      );
      const oversized = { ...exact, message: `${exact.message}x` };

      expect(normalizeDurableRunError(exact)).toBe(exact);
      expect(normalizeDurableRunError(oversized)).toEqual({
        code: "driver.error_oversized",
        details: { originalBytes: DURABLE_RUN_ERROR_MAX_UTF8_BYTES + 1 },
        message: `Driver error exceeded ${String(DURABLE_RUN_ERROR_MAX_UTF8_BYTES)} UTF-8 bytes and was omitted.`,
        retryable: false,
      });
    },
  );
});

describe("Driver runtime stream identity contract", () => {
  test.each([
    ["message.added", "messageId", { content: "message" }],
    ["message.cancelled", "messageId", {}],
    ["message.completed", "messageId", {}],
    ["message.delta", "messageId", { contentDelta: "message" }],
    [
      "message.failed",
      "messageId",
      { error: { code: "failed", message: "failed", retryable: false } },
    ],
    ["message.started", "messageId", {}],
    ["thought.cancelled", "thoughtId", {}],
    ["thought.completed", "thoughtId", {}],
    ["thought.delta", "thoughtId", { contentDelta: "thought" }],
    ["thought.started", "thoughtId", {}],
  ] as const)("rejects %s without %s", (kind, identity, payload) => {
    expect(ingestRuntimeEventInput(createRuntimeEventContext(), { kind, payload })).toMatchObject({
      rejection: { message: `${kind} ${identity} must be a non-empty string.` },
      status: "rejected",
    });
  });
});
