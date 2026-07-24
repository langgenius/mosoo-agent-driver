import { describe, expect, test } from "bun:test";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { OpenAiAppServerEventBridge } from "../src/runtimes/openai/app-server-event-bridge";
import { OpenAiTurnTracker } from "../src/runtimes/openai/app-server-turn-tracker";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import { driverStartInput as bootPayload } from "./driver-boot-payload-fixture";

interface EventBatch {
  events: DriverEventInput[];
  reason: string;
}

function readEventPayloadString(event: DriverEventInput, field: string): string | null {
  const payload = event.payload;

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function createHarness(options: { failNativeResumePublish?: boolean; holdReason?: string } = {}) {
  const batches: EventBatch[] = [];
  const heldPush = Promise.withResolvers<void>();
  const releasePush = Promise.withResolvers<void>();
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "openai-app-server-event-bridge-test",
    sink: async () => {},
  });
  const context: AgentDriverContext = createAgentDriverContext({
    eventSink: {
      pushEvents: async () => ({ accepted: [] }),
    },
    logger,
    payload: bootPayload,
    permission: {
      request: async () => "allow_once",
    },
  });
  const bridge = new OpenAiAppServerEventBridge({
    push: async (_context, reason, events) => {
      batches.push({ events, reason });
      if (reason === options.holdReason) {
        heldPush.resolve();
        await releasePush.promise;
      }
      if (
        options.failNativeResumePublish === true &&
        reason === "driver.openai.native_resume_ref.updated"
      ) {
        throw new Error("event sink unavailable");
      }
    },
    requireThreadId: () => "thread-1",
  });

  return {
    batches,
    bridge,
    context,
    events: () => batches.flatMap((batch) => batch.events),
    heldPush: heldPush.promise,
    logger,
    releasePush: releasePush.resolve,
  };
}

describe("OpenAi app-server event bridge", () => {
  test("bounds terminal turn deduplication and clears it on shutdown", () => {
    const tracker = new OpenAiTurnTracker();

    for (let index = 0; index <= 1_024; index += 1) {
      tracker.settle(`turn-${index}`, { kind: "completed" });
    }

    expect(tracker.hasTerminal("turn-0")).toBe(false);
    expect(tracker.hasTerminal("turn-1")).toBe(true);
    expect(tracker.markTurnStarted("turn-1")).toBe(false);

    tracker.clearActiveTurns();
    expect(tracker.hasTerminal("turn-1")).toBe(false);
  });

  test("treats rejected turns as terminal", async () => {
    const tracker = new OpenAiTurnTracker();
    const tracked = tracker.track("turn-1", DRIVER_TEST_IDS.runId);

    tracker.rejectTurn("turn-1", new Error("cancelled"));

    await expect(tracked).rejects.toThrow("cancelled");
    await expect(tracker.track("turn-1", DRIVER_TEST_IDS.runId)).rejects.toThrow("cancelled");
    expect(tracker.hasTerminal("turn-1")).toBe(true);
    expect(tracker.markTurnStarted("turn-1")).toBe(false);
  });

  test("rejects active waiters when teardown interrupts terminal settlement", async () => {
    const tracker = new OpenAiTurnTracker();
    const tracked = tracker.track("turn-1", DRIVER_TEST_IDS.runId);

    expect(tracker.beginSettlement("turn-1")).toBe(true);
    expect(tracker.activeRunId("turn-1")).toBeNull();
    tracker.rejectActiveTurns(new Error("driver stopped"));

    await expect(tracked).rejects.toThrow("driver stopped");
    expect(tracker.hasTerminal("turn-1")).toBe(true);
  });

  test("shares duplicate turn tracking without orphaning the first waiter", async () => {
    const tracker = new OpenAiTurnTracker();
    const first = tracker.track("turn-1", DRIVER_TEST_IDS.runId);
    const duplicate = tracker.track("turn-1", DRIVER_TEST_IDS.runId);

    await expect(tracker.track("turn-1", DRIVER_TEST_IDS.secondRunId)).rejects.toThrow(
      "another run",
    );
    tracker.settle("turn-1", { kind: "completed" });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([undefined, undefined]);
  });

  test("closes visible message, tool, and run state when a turn is cancelled", async () => {
    const { bridge, context, events, logger } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "item/started", {
      item: {
        id: "tool-1",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.cancelTurn(context, "turn-1", "test.cancel");

    await expect(trackedTurn).rejects.toThrow("test.cancel");
    expect(events()).toMatchObject([
      { kind: "message.started" },
      { kind: "item.started" },
      { kind: "tool.call.updated", payload: { status: "running", toolCallId: "tool-1" } },
      { kind: "run.cancel.requested", runId: DRIVER_TEST_IDS.runId },
      { kind: "message.completed" },
      { kind: "tool.call.updated", payload: { status: "failed", toolCallId: "tool-1" } },
      { kind: "item.completed", payload: { itemId: "tool-1", status: "failed" } },
      { kind: "run.cancelled", runId: DRIVER_TEST_IDS.runId },
    ]);
    const terminalEventCount = events().length;

    await bridge.handleNotification(context, "item/completed", {
      item: {
        aggregatedOutput: "late",
        id: "tool-1",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(events()).toHaveLength(terminalEventCount);
    await logger.destroy();
  });

  test("closes open item state when the provider interrupts a turn", async () => {
    const { bridge, context, events, logger } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "item/started", {
      item: { id: "tool-1", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted" },
    });

    await expect(trackedTurn).rejects.toThrow("interrupted");
    expect(events().slice(-4)).toMatchObject([
      { kind: "message.completed" },
      { kind: "tool.call.updated", payload: { status: "failed", toolCallId: "tool-1" } },
      { kind: "item.completed", payload: { itemId: "tool-1", status: "failed" } },
      {
        kind: "run.cancelled",
        payload: { requestedBy: "provider", stopReason: "cancelled" },
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
    await logger.destroy();
  });

  test("closes open item state before a failed turn", async () => {
    const { bridge, context, events, logger } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "item/started", {
      item: { id: "tool-1", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        error: { additionalDetails: null, message: "command failed" },
        id: "turn-1",
        status: "failed",
      },
    });

    await expect(trackedTurn).rejects.toThrow("command failed");
    expect(events().slice(-4)).toMatchObject([
      { kind: "message.completed" },
      { kind: "tool.call.updated", payload: { status: "failed", toolCallId: "tool-1" } },
      { kind: "item.completed", payload: { itemId: "tool-1", status: "failed" } },
      { kind: "run.failed", runId: DRIVER_TEST_IDS.runId },
    ]);
    await logger.destroy();
  });

  test("closes open item state before a successful turn without loaded items", async () => {
    const { bridge, context, events, logger } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "item/started", {
      item: { id: "tool-1", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "completed" },
    });

    await expect(trackedTurn).resolves.toBeUndefined();
    const terminalIndex = events().findIndex((event) => event.kind === "run.completed");
    expect(events().slice(terminalIndex - 3, terminalIndex + 1)).toMatchObject([
      { kind: "message.completed" },
      { kind: "tool.call.updated", payload: { status: "failed", toolCallId: "tool-1" } },
      { kind: "item.completed", payload: { itemId: "tool-1", status: "failed" } },
      { kind: "run.completed", runId: DRIVER_TEST_IDS.runId },
    ]);
    await logger.destroy();
  });

  test("keeps cancellation terminal while turn completion is awaiting item delivery", async () => {
    const harness = createHarness({ holdReason: "driver.openai.item.completed" });
    const trackedTurn = harness.bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await harness.bridge.handleNotification(harness.context, "item/started", {
      item: { id: "tool-1", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const completion = harness.bridge.handleNotification(harness.context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [{ aggregatedOutput: "done", id: "tool-1", type: "commandExecution" }],
        itemsView: "full",
        status: "completed",
      },
    });
    await harness.heldPush;
    await harness.bridge.cancelTurn(harness.context, "turn-1", "test.cancel");
    harness.releasePush();
    await completion;

    await expect(trackedTurn).rejects.toThrow("test.cancel");
    await expect(harness.bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId)).rejects.toThrow(
      "test.cancel",
    );
    expect(
      harness
        .events()
        .filter((event) => ["run.cancelled", "run.completed", "run.failed"].includes(event.kind)),
    ).toMatchObject([{ kind: "run.cancelled", runId: DRIVER_TEST_IDS.runId }]);
    await harness.logger.destroy();
  });

  test.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["declined", "failed"],
  ] as const)("maps completed native tool status %s to %s", async (nativeStatus, status) => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/completed", {
      item: {
        aggregatedOutput: "output",
        id: "tool-1",
        status: nativeStatus,
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(
      events()
        .filter((event) => event.kind === "tool.call.updated")
        .map((event) => readEventPayloadString(event, "status")),
    ).toEqual(["running", status]);
    expect(events().find((event) => event.kind === "item.completed")?.payload).toMatchObject({
      status,
    });
    await logger.destroy();
  });

  test("orders cancellation after an in-flight item update", async () => {
    const { bridge, context, events, heldPush, logger, releasePush } = createHarness({
      holdReason: "driver.openai.message.started",
    });
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    const itemUpdate = bridge.handleNotification(context, "item/started", {
      item: {
        id: "tool-1",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await heldPush;
    const cancellation = bridge.cancelTurn(
      context,
      "turn-1",
      "test.cancel",
      async () => itemUpdate,
    );

    releasePush();
    await Promise.all([cancellation, itemUpdate]);
    await expect(trackedTurn).rejects.toThrow("test.cancel");
    expect(events().at(-1)?.kind).toBe("run.cancelled");
    expect(
      events().findLastIndex(
        (event) =>
          event.kind === "tool.call.updated" &&
          readEventPayloadString(event, "status") === "running",
      ),
    ).toBeLessThan(events().findLastIndex((event) => event.kind === "run.cancelled"));
    await logger.destroy();
  });
});
