import { describe, expect, test } from "bun:test";

import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import {
  createOpenAiBridgeHarness as createHarness,
  readAssistantMessageId,
  readEventPayloadString,
} from "./openai-app-server-event-bridge-fixture";

describe("OpenAi app-server event bridge", () => {
  test("closes only open item state when a mixed turn is cancelled", async () => {
    const { bridge, context, events } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "item/reasoning/summaryTextDelta", {
      delta: "thinking",
      itemId: "reasoning-1",
      summaryIndex: 0,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/started", {
      item: { id: "tool-completed", status: "inProgress", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        aggregatedOutput: "",
        id: "tool-completed",
        status: "completed",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/started", {
      item: { id: "tool-open", status: "inProgress", type: "commandExecution" },
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
    expect(toolStatuses("tool-open")).toEqual(["running", "cancelled"]);
    expect(events().filter((event) => event.kind === "thought.cancelled")).toHaveLength(1);
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
  });

  test("does not duplicate streamed reasoning in the completed snapshot", async () => {
    const { bridge, context, events } = createHarness();

    await bridge.handleNotification(context, "item/reasoning/summaryTextDelta", {
      delta: "First",
      itemId: "reasoning-1",
      summaryIndex: 0,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/reasoning/summaryPartAdded", {
      itemId: "reasoning-1",
      summaryIndex: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/reasoning/summaryPartAdded", {
      itemId: "reasoning-1",
      summaryIndex: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/reasoning/summaryTextDelta", {
      delta: "Second",
      itemId: "reasoning-1",
      summaryIndex: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: { content: [], id: "reasoning-1", summary: ["First", "Second"], type: "reasoning" },
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(
      events()
        .filter((event) => event.kind === "thought.delta")
        .map((event) => readEventPayloadString(event, "contentDelta"))
        .join(""),
    ).toBe("First\n\nSecond");
    expect(events().filter((event) => event.kind === "thought.completed")).toHaveLength(1);
  });

  test("releases translation state between turns and ignores late terminal replay", async () => {
    const { bridge, context, events } = createHarness();

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
    const { bridge, context, events } = createHarness();

    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
      },
    });

    await expect(bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId)).resolves.toBeUndefined();

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
        kind: "runtime.resume.updated",
        payload: {
          resumePointer: "thread-1",
          threadId: "thread-1",
        },
      },
      {
        kind: "run.completed",
        payload: {
          stopReason: "end_turn",
        },
      },
    ]);
  });

  test("resume metadata failure does not reject a completed turn", async () => {
    const { bridge, context, events } = createHarness({
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

    expect(events().some((event) => event.kind === "run.completed")).toBe(true);
  });

  test("turn errors wait for the authoritative failed turn", async () => {
    const { bridge, context, events } = createHarness();

    await bridge.handleNotification(context, "error", {
      error: {
        additionalDetails: "HTTP 502 from upstream.",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
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
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
          message: "Response stream disconnected.",
        },
        id: "turn-1",
        status: "failed",
      },
    });

    await expect(trackedTurn).rejects.toThrow(
      "Response stream disconnected.\nHTTP 502 from upstream.",
    );

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
            details: {
              additionalDetails: "HTTP 502 from upstream.",
              codexErrorInfo: "responseStreamDisconnected",
              httpStatusCode: 502,
            },
            message: "Response stream disconnected.\nHTTP 502 from upstream.",
            retryable: true,
          },
          recoverable: true,
        },
      },
    ]);
  });

  test("thread systemError waits for the authoritative failed turn", async () => {
    const { bridge, context, events } = createHarness();
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
          codexErrorInfo: "serverOverloaded",
          message: "The model returned an empty response.",
        },
        id: "turn-1",
        status: "failed",
      },
    });

    await expect(trackedTurn).rejects.toThrow("The model returned an empty response.");
    expect(events().filter((event) => event.kind === "run.failed")).toMatchObject([
      {
        payload: {
          error: {
            code: "openai.turn_failed",
            details: { codexErrorInfo: "serverOverloaded" },
            message: "The model returned an empty response.",
            retryable: false,
          },
          recoverable: false,
        },
      },
    ]);
  });

  test("completed agent messages backfill text when no deltas streamed", async () => {
    const { bridge, context, events } = createHarness();

    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-1",
        text: "pong",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
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
        delivery: "lossless",
        kind: "message.added",
        payload: {
          content: "pong",
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
    const { bridge, context, events } = createHarness();

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

    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    const finalSnapshot = events().find(
      (event) =>
        event.kind === "message.added" &&
        readEventPayloadString(event, "content") === "完整最终回答：中文 Markdown ✅",
    );
    expect(finalSnapshot).toBeDefined();
    expect(readEventPayloadString(runCompleted, "finalMessageId")).toBe(
      readEventPayloadString(finalSnapshot!, "messageId"),
    );
    expect(runCompleted.payload).not.toHaveProperty("finalMessageText");
  });
});
