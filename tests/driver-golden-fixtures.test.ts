import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { EventId } from "../src/protocol/id";
import { parseRuntimeCommand } from "../src/runtime-command";
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
  "tool-call-updated",
  "usage-updated",
] as const;

function readJsonFixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
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

  test("preserves v1 compatibility for API-materialized input attachments", () => {
    const fixture = readJsonFixture("./fixtures/driver/commands/input-start.json") as {
      readonly input: Record<string, unknown>;
    };

    expect(
      parseRuntimeCommand({
        ...fixture,
        input: { ...fixture.input, attachmentIds: ["file-1"] },
      }),
    ).toEqual(fixture);
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

  test("bounds control reasons without dropping their commands", () => {
    const limit = "x".repeat(16 * 1_024);
    const oversized = `${limit}界`;
    const summary = "Runtime command reason exceeded 16384 UTF-8 bytes (received 16387).";

    expect(
      parseRuntimeCommand({ commandId: "cancel-at-limit", kind: "turn.cancel", reason: limit }),
    ).toMatchObject({ reason: limit });
    expect(
      parseRuntimeCommand({
        commandId: "cancel-oversized",
        kind: "turn.cancel",
        reason: oversized,
      }),
    ).toMatchObject({ kind: "turn.cancel", reason: summary });
    expect(
      parseRuntimeCommand({ commandId: "stop-oversized", kind: "session.stop", reason: oversized }),
    ).toMatchObject({ kind: "session.stop", reason: summary });
  });
});
