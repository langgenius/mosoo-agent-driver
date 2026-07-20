import { describe, expect, test } from "bun:test";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { OpenAiAppServerEventBridge } from "../src/runtimes/openai/app-server-event-bridge";
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

function readAssistantMessageId(events: readonly DriverEventInput[]): string {
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
          additionalDetails: null,
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
});
