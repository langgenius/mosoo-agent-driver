import { describe, expect, test } from "bun:test";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEvent } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import type { AgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { OpenAiAppServerEventBridge } from "../src/runtimes/openai/app-server-event-bridge";
import { OpenAiTurnTracker } from "../src/runtimes/openai/app-server-turn-tracker";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import { driverBootPayload as bootPayload } from "./driver-boot-payload-fixture";

interface EventBatch {
  events: DriverEvent[];
  reason: string;
}

function readEventPayloadString(event: DriverEvent, field: string): string | null {
  const payload = event.payload;

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function readAssistantMessageId(events: readonly DriverEvent[]): string {
  for (const event of events) {
    const messageId =
      readEventPayloadString(event, "messageId") ??
      readEventPayloadString(event, "parentMessageId");

    if (messageId !== null) {
      expect(isDriverId(messageId)).toBe(true);
      return messageId;
    }
  }

  throw new Error("Expected a platform assistant message ID.");
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
      pushEvents: async () => {},
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
        error: { message: "command failed" },
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
        .filter((event) =>
          ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
        ),
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

  test("closes only open item state when a mixed turn is cancelled", async () => {
    const { bridge, context, events, logger } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "item/reasoning/summaryTextDelta", {
      delta: "thinking",
      itemId: "reasoning-1",
      summaryIndex: 0,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/started", {
      item: { id: "tool-completed", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: { aggregatedOutput: "", id: "tool-completed", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/started", {
      item: { id: "tool-open", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.cancelTurn(context, "turn-1", "test.cancel");

    await expect(trackedTurn).rejects.toThrow("test.cancel");
    const toolStatuses = (toolCallId: string) =>
      events()
        .filter(
          (event) =>
            event.kind === "tool.call.updated" &&
            readEventPayloadString(event, "toolCallId") === toolCallId,
        )
        .map((event) => readEventPayloadString(event, "status"));
    expect(toolStatuses("tool-completed")).toEqual(["running", "completed"]);
    expect(toolStatuses("tool-open")).toEqual(["running", "failed"]);
    expect(events().filter((event) => event.kind === "thought.completed")).toHaveLength(1);
    const terminalEventCount = events().length;

    await bridge.handleNotification(context, "item/reasoning/summaryTextDelta", {
      delta: "late",
      itemId: "reasoning-1",
      summaryIndex: 0,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.cancelTurn(context, "turn-1", "test.cancel.retry");
    expect(events()).toHaveLength(terminalEventCount);
    await logger.destroy();
  });

  test("releases translation state between turns and ignores late terminal replay", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/plan/delta", {
      delta: "old plan",
      itemId: "plan-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-1",
        text: "first",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "notLoaded",
        status: "completed",
      },
    });
    const terminalEventCount = events().length;

    await bridge.handleNotification(context, "item/plan/delta", {
      delta: "late plan",
      itemId: "plan-late",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "late message",
      itemId: "message-late",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(events()).toHaveLength(terminalEventCount);

    await bridge.handleNotification(context, "item/plan/delta", {
      delta: "new plan",
      itemId: "plan-2",
      threadId: "thread-1",
      turnId: "turn-2",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-1",
        text: "second",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-2",
    });
    await logger.destroy();

    const planEvents = events().filter((event) => event.kind === "plan.updated");
    expect(planEvents.at(-1)).toMatchObject({
      payload: {
        entries: [{ content: "new plan" }],
      },
    });

    const completedMessageIds = events()
      .filter((event) => event.kind === "message.completed")
      .map((event) => readEventPayloadString(event, "messageId"));
    expect(completedMessageIds).toHaveLength(2);
    expect(new Set(completedMessageIds).size).toBe(2);
  });

  test("turn completion can arrive before the turn response is tracked", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
      },
    });

    await expect(bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId)).resolves.toBeUndefined();
    await logger.destroy();

    for (const event of events()) {
      expect(event.runId).toBeUndefined();
    }
    expect(events()).toMatchObject([
      {
        kind: "run.started",
        payload: {
          startedAt: expect.any(String),
        },
      },
      {
        kind: "run.completed",
        payload: {
          stopReason: "end_turn",
        },
      },
      {
        kind: "runtime.resume.updated",
        payload: {
          resumePointer: "thread-1",
          threadId: "thread-1",
        },
      },
    ]);
  });

  test("resume metadata failure does not reject a completed turn", async () => {
    const { bridge, context, events, logger } = createHarness({
      failNativeResumePublish: true,
    });
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await expect(
      bridge.handleNotification(context, "turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
        },
      }),
    ).resolves.toBeUndefined();
    await expect(trackedTurn).resolves.toBeUndefined();
    await logger.destroy();

    expect(events().some((event) => event.kind === "run.completed")).toBe(true);
  });

  test("turn errors wait for the authoritative failed turn", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "error", {
      error: {
        additionalDetails: "HTTP 502 from upstream.",
        message: "Response stream disconnected.",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
    });

    expect(events()).toEqual([]);
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        error: {
          additionalDetails: "HTTP 502 from upstream.",
          message: "Response stream disconnected.",
        },
        id: "turn-1",
        status: "failed",
      },
    });

    await expect(trackedTurn).rejects.toThrow(
      "Response stream disconnected.\nHTTP 502 from upstream.",
    );
    await logger.destroy();

    const failedEvent = events().find((event) => event.kind === "run.failed");
    expect(failedEvent?.runId).toBe(DRIVER_TEST_IDS.runId);
    expect(events()).toMatchObject([
      {
        kind: "run.started",
      },
      {
        kind: "run.failed",
        payload: {
          error: {
            code: "openai.turn_failed",
            message: "Response stream disconnected.\nHTTP 502 from upstream.",
          },
          recoverable: false,
        },
      },
    ]);
  });

  test("thread systemError waits for the authoritative failed turn", async () => {
    const { bridge, context, events, logger } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "thread/status/changed", {
      status: { type: "systemError" },
      threadId: "thread-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        error: {
          message: "The model returned an empty response.",
        },
        id: "turn-1",
        status: "failed",
      },
    });

    await expect(trackedTurn).rejects.toThrow("The model returned an empty response.");
    await logger.destroy();
    expect(events().filter((event) => event.kind === "run.failed")).toMatchObject([
      {
        payload: {
          error: {
            code: "openai.turn_failed",
            message: "The model returned an empty response.",
          },
        },
      },
    ]);
  });

  test("completed agent messages backfill text when no deltas streamed", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-1",
        text: "pong",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await logger.destroy();
    const assistantMessageId = readAssistantMessageId(events());

    expect(events()).toMatchObject([
      {
        kind: "message.started",
        payload: {
          messageId: assistantMessageId,
          role: "agent",
        },
      },
      {
        delivery: "best_effort",
        kind: "message.delta",
        payload: {
          contentDelta: "pong",
          messageId: assistantMessageId,
          role: "agent",
        },
      },
      {
        kind: "message.completed",
        payload: {
          messageId: assistantMessageId,
          role: "agent",
        },
      },
    ]);
  });

  test("uses item completion text as the authoritative final snapshot", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "损坏的流式片段",
      itemId: "message-final",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-final",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          {
            id: "message-final",
            text: "完整最终回答：中文 Markdown ✅",
            type: "agentMessage",
          },
        ],
        status: "completed",
      },
    });
    await logger.destroy();

    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    expect(readEventPayloadString(runCompleted, "finalMessageText")).toBe(
      "完整最终回答：中文 Markdown ✅",
    );
  });

  test("removes OpenAI private citation markup from streamed and final assistant text", async () => {
    const { bridge, context, events, logger } = createHarness();
    const privateCitation = "\uE200cite\uE202turn7search12\uE202turn8view0\uE201";

    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "before\uE200ci",
      itemId: "message-final",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "te\uE202turn7search12\uE202turn8view0",
      itemId: "message-final",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "\uE201after",
      itemId: "message-final",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-final",
        text: `before${privateCitation}after`,
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          {
            id: "message-final",
            text: `before${privateCitation}after`,
            type: "agentMessage",
          },
        ],
        status: "completed",
      },
    });
    await logger.destroy();

    const allEvents = events();
    const streamedText = allEvents
      .filter((event) => event.kind === "message.delta")
      .map((event) => readEventPayloadString(event, "contentDelta") ?? "")
      .join("");
    const runCompleted = allEvents.find((event) => event.kind === "run.completed");
    const diagnostics = allEvents.filter(
      (event) =>
        event.kind === "diagnostic.reported" &&
        readEventPayloadString(event, "code") === "openai.private_citation_markup_removed",
    );

    expect(streamedText).toBe("beforeafter");
    expect(runCompleted).toBeDefined();
    expect(readEventPayloadString(runCompleted!, "finalMessageText")).toBe("beforeafter");
    expect(diagnostics).toHaveLength(1);
  });

  test("flushes incomplete private markup when an item completes without a text snapshot", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "before\uE200cite\uE202turn7search12",
      itemId: "message-final",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-final",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await logger.destroy();

    const streamedText = events()
      .filter((event) => event.kind === "message.delta")
      .map((event) => readEventPayloadString(event, "contentDelta") ?? "")
      .join("");

    expect(streamedText).toBe("before\uE200cite\uE202turn7search12");
  });

  test("does not fall back to progress when the final turn item is incomplete", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-progress",
        text: "PROGRESS",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          { id: "message-progress", text: "PROGRESS", type: "agentMessage" },
          { id: "message-final", type: "agentMessage" },
        ],
        status: "completed",
      },
    });
    await logger.destroy();

    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    expect(readEventPayloadString(runCompleted, "finalMessageId")).toBeNull();
    expect(readEventPayloadString(runCompleted, "finalMessageText")).toBeNull();
  });

  test("uses the last completed assistant snapshot when turn items are omitted", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "PROGRESS",
      itemId: "message-progress",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-progress",
        text: "PROGRESS",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "最终回答：中文 Markdown ✅",
      itemId: "message-final",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-final",
        text: "最终回答：中文 Markdown ✅",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
      },
    });
    await logger.destroy();

    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    expect(readEventPayloadString(runCompleted, "finalMessageId")).not.toBeNull();
    expect(readEventPayloadString(runCompleted, "finalMessageText")).toBe(
      "最终回答：中文 Markdown ✅",
    );
  });

  test("uses completed snapshots when terminal items are not loaded", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/completed", {
      item: { id: "message-final", text: "FINAL", type: "agentMessage" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "notLoaded",
        status: "completed",
      },
    });
    await logger.destroy();

    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    expect(readEventPayloadString(runCompleted, "finalMessageText")).toBe("FINAL");
  });

  test("does not fall back when a full terminal item list has no assistant", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/completed", {
      item: { id: "message-progress", text: "PROGRESS", type: "agentMessage" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "full",
        status: "completed",
      },
    });
    await logger.destroy();

    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    expect(readEventPayloadString(runCompleted, "finalMessageText")).toBeNull();
  });

  test("uses first-seen item order when older completions arrive late", async () => {
    const { bridge, context, events, logger } = createHarness();

    for (const [itemId, delta] of [
      ["message-progress", "PROGRESS"],
      ["message-final", "FINAL"],
    ] as const) {
      await bridge.handleNotification(context, "item/agentMessage/delta", {
        delta,
        itemId,
        threadId: "thread-1",
        turnId: "turn-1",
      });
    }
    await bridge.handleNotification(context, "item/completed", {
      item: { id: "message-final", text: "FINAL", type: "agentMessage" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: { id: "message-progress", text: "PROGRESS", type: "agentMessage" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await logger.destroy();

    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    expect(readEventPayloadString(runCompleted, "finalMessageText")).toBe("FINAL");
  });

  test("completed turns app final items before run finish", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          {
            id: "message-1",
            text: "pong",
            type: "agentMessage",
          },
        ],
        status: "completed",
      },
    });
    await logger.destroy();
    const assistantMessageId = readAssistantMessageId(events());

    expect(events()).toMatchObject([
      {
        kind: "run.started",
        payload: {
          startedAt: expect.any(String),
        },
      },
      {
        kind: "message.started",
        payload: {
          messageId: assistantMessageId,
          role: "agent",
        },
      },
      {
        delivery: "best_effort",
        kind: "message.delta",
        payload: {
          contentDelta: "pong",
          messageId: assistantMessageId,
          role: "agent",
        },
      },
      {
        kind: "message.completed",
        payload: {
          messageId: assistantMessageId,
          role: "agent",
        },
      },
      {
        kind: "run.completed",
        payload: {
          stopReason: "end_turn",
        },
      },
      {
        kind: "runtime.resume.updated",
        payload: {
          resumePointer: "thread-1",
          threadId: "thread-1",
        },
      },
    ]);
  });

  test("final turn items do not duplicate already completed messages", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-1",
        text: "pong",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          {
            id: "message-1",
            text: "pong",
            type: "agentMessage",
          },
        ],
        status: "completed",
      },
    });
    await logger.destroy();
    const assistantMessageId = readAssistantMessageId(events());

    expect(events()).toMatchObject([
      {
        kind: "message.started",
        payload: {
          messageId: assistantMessageId,
          role: "agent",
        },
      },
      {
        delivery: "best_effort",
        kind: "message.delta",
        payload: {
          contentDelta: "pong",
          messageId: assistantMessageId,
          role: "agent",
        },
      },
      {
        kind: "message.completed",
        payload: {
          messageId: assistantMessageId,
          role: "agent",
        },
      },
      {
        kind: "run.started",
        payload: {
          startedAt: expect.any(String),
        },
      },
      {
        kind: "run.completed",
        payload: {
          stopReason: "end_turn",
        },
      },
      {
        kind: "runtime.resume.updated",
        payload: {
          resumePointer: "thread-1",
          threadId: "thread-1",
        },
      },
    ]);
  });

  test("rotates assistant message identity after each completed agent item", async () => {
    const { bridge, context, events, logger } = createHarness();

    const progressMessages = [
      "进度 1：已完成读取。",
      "进度 2：已完成工具准备。",
      "进度 3：准备最终总结。",
    ];

    for (const [index, progressMessage] of progressMessages.entries()) {
      await bridge.handleNotification(context, "item/agentMessage/delta", {
        delta: progressMessage,
        itemId: `message-progress-${index + 1}`,
        threadId: "thread-1",
        turnId: "turn-1",
      });
      await bridge.handleNotification(context, "item/completed", {
        item: {
          id: `message-progress-${index + 1}`,
          text: progressMessage,
          type: "agentMessage",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      });
    }
    await bridge.handleNotification(context, "item/started", {
      item: {
        id: "artifact-tool",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        aggregatedOutput: "artifact 已创建。",
        id: "artifact-tool",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "| 最终：表格 | `代码` | https://example.test/😀",
      itemId: "message-final",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-final",
        text: "| 最终：表格 | `代码` | https://example.test/😀",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          ...progressMessages.map((text, index) => ({
            id: `message-progress-${index + 1}`,
            text,
            type: "agentMessage",
          })),
          {
            aggregatedOutput: "artifact 已创建。",
            id: "artifact-tool",
            type: "commandExecution",
          },
          {
            id: "message-final",
            text: "| 最终：表格 | `代码` | https://example.test/😀",
            type: "agentMessage",
          },
        ],
        status: "completed",
      },
    });
    await logger.destroy();

    const assistantMessages = events().flatMap((event) => {
      if (event.kind !== "message.delta") {
        return [];
      }

      const messageId = readEventPayloadString(event, "messageId");
      const contentDelta = readEventPayloadString(event, "contentDelta");
      return messageId === null || contentDelta === null ? [] : [{ contentDelta, messageId }];
    });

    expect(assistantMessages.map((message) => message.contentDelta)).toEqual([
      ...progressMessages,
      "| 最终：表格 | `代码` | https://example.test/😀",
    ]);
    expect(new Set(assistantMessages.map((message) => message.messageId)).size).toBe(4);
    const toolParentMessageId = events()
      .filter((event) => event.kind === "item.started")
      .map((event) => readEventPayloadString(event, "parentMessageId"))
      .find((messageId): messageId is string => messageId !== null);

    expect(toolParentMessageId).toBe(assistantMessages.at(-1)?.messageId);
    expect(events().filter((event) => event.kind === "message.completed")).toHaveLength(4);
    expect(events().filter((event) => event.kind === "run.completed")).toHaveLength(1);
  });

  test("keeps interleaved assistant item identities isolated and ignores late replay", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "消息甲",
      itemId: "message-a",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "消息乙",
      itemId: "message-b",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: { id: "message-b", text: "消息乙", type: "agentMessage" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: { id: "message-a", text: "消息甲", type: "agentMessage" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "消息甲",
      itemId: "message-a",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          { id: "message-a", text: "消息甲", type: "agentMessage" },
          { id: "message-b", text: "消息乙", type: "agentMessage" },
        ],
        status: "completed",
      },
    });
    await logger.destroy();

    const deltas = events().flatMap((event) => {
      if (event.kind !== "message.delta") {
        return [];
      }

      const messageId = readEventPayloadString(event, "messageId");
      const contentDelta = readEventPayloadString(event, "contentDelta");
      return messageId === null || contentDelta === null ? [] : [{ contentDelta, messageId }];
    });

    expect(deltas.map((entry) => entry.contentDelta)).toEqual(["消息甲", "消息乙"]);
    expect(new Set(deltas.map((entry) => entry.messageId)).size).toBe(2);
    expect(events().filter((event) => event.kind === "message.completed")).toHaveLength(2);
    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    const finalMessageId = readEventPayloadString(runCompleted, "finalMessageId");

    expect(finalMessageId).toBe(deltas.find((entry) => entry.contentDelta === "消息乙")?.messageId);
    expect(readEventPayloadString(runCompleted, "finalMessageText")).toBe("消息乙");
  });

  test("command output streams as tool result content", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/started", {
      item: {
        id: "cmd-1",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/commandExecution/outputDelta", {
      delta: "hello",
      itemId: "cmd-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/commandExecution/outputDelta", {
      delta: " world",
      itemId: "cmd-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await logger.destroy();
    const assistantMessageId = readAssistantMessageId(events());

    expect(events()).toMatchObject([
      {
        kind: "message.started",
        payload: {
          messageId: assistantMessageId,
          role: "agent",
        },
      },
      {
        kind: "item.started",
        payload: {
          itemId: "cmd-1",
          itemType: "tool_call",
          parentMessageId: assistantMessageId,
          title: "Shell",
        },
      },
      {
        kind: "tool.call.updated",
        payload: {
          kind: "tool",
          parentMessageId: assistantMessageId,
          status: "running",
          title: "Shell",
          toolCallId: "cmd-1",
        },
      },
      {
        kind: "tool.call.updated",
        payload: {
          content: "hello",
          messageId: assistantMessageId,
          rawOutput: "hello",
          status: "running",
          toolCallId: "cmd-1",
        },
      },
      {
        kind: "tool.call.updated",
        payload: {
          content: " world",
          messageId: assistantMessageId,
          rawOutput: " world",
          status: "running",
          toolCallId: "cmd-1",
        },
      },
    ]);
    expect(events().some((event) => event.kind === "item.updated")).toBe(false);
  });

  test("turn plan updates map to the session plan custom event", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "turn/plan/updated", {
      explanation: null,
      plan: [
        {
          status: "inProgress",
          step: "Inspect stream events",
        },
        {
          status: "completed",
          step: "Patch bridge",
        },
      ],
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await logger.destroy();

    expect(events()).toEqual([
      {
        kind: "plan.updated",
        payload: {
          entries: [
            {
              content: "Inspect stream events",
              priority: "medium",
              status: "in_progress",
            },
            {
              content: "Patch bridge",
              priority: "medium",
              status: "completed",
            },
          ],
          source: "driver",
        },
      },
    ]);
  });
});
