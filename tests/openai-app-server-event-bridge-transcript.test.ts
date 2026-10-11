import { describe, expect, test } from "bun:test";

import { DriverTurnCancelledError } from "../src/core/driver-runtime-state";
import { MAX_THOUGHT_CONTENT_BYTES } from "../src/protocol/events";
import { OpenAiMessageState } from "../src/runtimes/openai/app-server-event-state";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import {
  createOpenAiBridgeHarness as createHarness,
  readAssistantMessageId,
  readEventPayloadString,
} from "./openai-app-server-event-bridge-fixture";

describe("OpenAi app-server event bridge", () => {
  test("bounds total thought state and releases capacity when a snapshot shrinks", () => {
    const messages = new OpenAiMessageState();
    const halfCapacity = "x".repeat(MAX_THOUGHT_CONTENT_BYTES / 2);
    messages.prepareReasoningText("first", halfCapacity)();
    messages.prepareReasoningText("second", halfCapacity)();
    expect(() => messages.prepareReasoningText("second", halfCapacity)()).not.toThrow();
    expect(() => messages.prepareReasoningText("third", "x")).toThrow("byte limit");
    expect(messages.currentReasoningText("third")).toBe("");

    messages.prepareReasoningText("first", "")();
    expect(() => messages.prepareReasoningText("third", halfCapacity)()).not.toThrow();
    expect(messages.currentReasoningText("third")).toBe(halfCapacity);
  });

  test("counts a split surrogate pair by its completed JSON byte length", () => {
    const messages = new OpenAiMessageState();
    messages.prepareReasoningText("first", "x".repeat(MAX_THOUGHT_CONTENT_BYTES - 6))();
    messages.prepareReasoningDelta("second", "\ud83d")();
    messages.prepareReasoningDelta("second", "\ude00")();
    messages.prepareReasoningDelta("second", "ab")();
    expect(messages.currentReasoningText("second")).toBe("😀ab");
    expect(() => messages.prepareReasoningDelta("second", "x")).toThrow("byte limit");
  });

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

  test("lets core cancellation replace a pre-response unselected completed turn", async () => {
    const { bridge, context, events, releaseTerminal, terminalAttempts, terminalHeld } =
      createHarness({ holdCompletedTerminalOnce: true });
    const controller = new AbortController();
    const admission = bridge.beginTurnAdmission(DRIVER_TEST_IDS.runId, controller.signal);
    bridge.armTurnAdmission(admission);
    const started = bridge.handleNotification(context, "turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    });
    bridge.bindTurnAdmission(admission, "turn-1");
    await started;
    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "done",
      itemId: "message-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const completion = bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });

    await terminalHeld;
    controller.abort(new DriverTurnCancelledError("test.cancel"));
    releaseTerminal();
    await completion;
    const trackedTurn = bridge.claimTurnAdmission(
      admission,
      "turn-1",
      DRIVER_TEST_IDS.runId,
      controller.signal,
    );
    void trackedTurn.catch(() => {});
    await bridge.cancelTurn(context, "turn-1", "test.cancel");

    await expect(trackedTurn).rejects.toThrow("test.cancel");
    expect(terminalAttempts.map(({ terminal }) => terminal.kind)).toEqual([
      "run.completed",
      "run.cancelled",
    ]);
    expect(terminalAttempts[0]?.cancellationSignal).toBe(controller.signal);
    expect(
      events().filter((event) =>
        ["run.cancel.requested", "run.cancelled", "run.completed"].includes(event.kind),
      ),
    ).toMatchObject([{ kind: "run.cancel.requested" }, { kind: "run.cancelled" }]);
    expect(events().filter((event) => event.kind === "message.completed")).toHaveLength(1);
    expect(events().filter((event) => event.kind === "message.cancelled")).toHaveLength(0);
    expect(events().filter((event) => event.kind === "agent.tasks.replaced")).toHaveLength(1);
  });

  test("publishes the complete reasoning snapshot after streamed previews", async () => {
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
    expect(events().filter((event) => event.kind === "thought.delta")).toEqual([
      expect.objectContaining({ delivery: "best_effort" }),
      expect.objectContaining({ delivery: "best_effort" }),
      expect.objectContaining({ delivery: "best_effort" }),
    ]);
    expect(events().filter((event) => event.kind === "thought.updated")).toMatchObject([
      { delivery: "lossless", payload: { content: "First\n\nSecond", offset: 0 } },
    ]);
    expect(events().filter((event) => event.kind === "thought.completed")).toHaveLength(1);
  });

  test.each([
    ["different", ["Revised summary"], "Revised summary"],
    ["shorter", ["First"], "First"],
    ["empty", [], ""],
  ] as const)(
    "replaces streamed reasoning with the %s final summary",
    async (_label, summary, text) => {
      const { bridge, context, events } = createHarness();
      await bridge.handleNotification(context, "item/reasoning/summaryTextDelta", {
        delta: "First draft\n\n",
        itemId: "reasoning-1",
        summaryIndex: 0,
        threadId: "thread-1",
        turnId: "turn-1",
      });
      const completion = {
        item: { content: [], id: "reasoning-1", summary: [...summary], type: "reasoning" },
        threadId: "thread-1",
        turnId: "turn-1",
      };
      await bridge.handleNotification(context, "item/completed", completion);
      await bridge.handleNotification(context, "item/completed", completion);

      const thoughtEvents = events().filter((event) => event.kind.startsWith("thought."));
      expect(thoughtEvents).toMatchObject([
        { kind: "thought.started" },
        {
          kind: "thought.delta",
          delivery: "best_effort",
          payload: { contentDelta: "First draft\n\n" },
        },
        { kind: "thought.updated", delivery: "lossless", payload: { content: text, offset: 0 } },
        { kind: "thought.completed" },
      ]);
      expect(
        new Set(thoughtEvents.map((event) => readEventPayloadString(event, "thoughtId"))).size,
      ).toBe(1);
    },
  );

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
        kind: "agent.tasks.replaced",
        payload: { tasks: [] },
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
        kind: "agent.tasks.replaced",
        payload: { tasks: [] },
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

  test("classifies exhausted streaming rate limits as recoverable", async () => {
    const { bridge, context, events } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        error: {
          codexErrorInfo: "rateLimitExceeded",
          message: "Streaming rate limit exceeded.",
        },
        id: "turn-1",
        status: "failed",
      },
    });

    await expect(trackedTurn).rejects.toThrow("Streaming rate limit exceeded.");
    expect(events().find((event) => event.kind === "run.failed")).toMatchObject({
      payload: {
        error: {
          details: { codexErrorInfo: "rateLimitExceeded" },
          retryable: true,
        },
        recoverable: true,
      },
    });
  });

  test("preserves actionable misalignment details without making the failure retryable", async () => {
    const { bridge, context, events } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        error: {
          codexErrorInfo: "misalignmentPolicyViolation",
          message: "The request was blocked by policy.",
          misalignment: {
            detailedExplanation: "The request needs a narrower authorized scope.",
            errorType: "scope_mismatch",
            steer: { message: "Continue only within the authorized repository." },
          },
        },
        id: "turn-1",
        status: "failed",
      },
    });

    await expect(trackedTurn).rejects.toThrow("The request was blocked by policy.");
    expect(events().find((event) => event.kind === "run.failed")).toMatchObject({
      payload: {
        error: {
          details: {
            codexErrorInfo: "misalignmentPolicyViolation",
            misalignmentDetailedExplanation: "The request needs a narrower authorized scope.",
            misalignmentErrorType: "scope_mismatch",
            misalignmentSteerMessage: "Continue only within the authorized repository.",
          },
          retryable: false,
        },
        recoverable: false,
      },
    });
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
