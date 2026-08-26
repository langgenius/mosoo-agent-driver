import { describe, expect, test } from "bun:test";

import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import {
  createOpenAiBridgeHarness as createHarness,
  readAssistantMessageId,
  readEventPayloadString,
} from "./openai-app-server-event-bridge-fixture";

describe("OpenAi app-server event bridge", () => {
  test("publishes a lossless completed assistant snapshot", async () => {
    const { bridge, context, events, logger } = createHarness();
    const finalText = "I will inspect the files.";

    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "I",
      itemId: "message-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-1",
        text: finalText,
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await logger.destroy();

    const assistantMessageId = readAssistantMessageId(events());
    const snapshot = events().find((event) => event.kind === "message.added");

    expect(snapshot).toMatchObject({
      kind: "message.added",
      payload: {
        content: finalText,
        messageId: assistantMessageId,
        role: "agent",
      },
    });
    expect(snapshot?.delivery).toBe("lossless");
  });

  test("preserves final phase and memory citations on completed snapshots", async () => {
    const { bridge, context, events, logger } = createHarness();
    const memoryCitation = {
      entries: [{ lineEnd: 8, lineStart: 4, note: "Relevant context", path: "MEMORY.md" }],
      threadIds: ["thread-memory"],
    };

    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-final",
        memoryCitation,
        phase: "final_answer",
        text: "Final answer",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await logger.destroy();

    expect(events().find((event) => event.kind === "message.added")).toMatchObject({
      payload: { memoryCitation, phase: "final" },
    });
    expect(events().find((event) => event.kind === "message.delta")?.payload).not.toHaveProperty(
      "phase",
    );
  });

  test("selects only final-phase messages once a turn uses explicit phases", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          { id: "legacy", memoryCitation: null, phase: null, text: "Legacy", type: "agentMessage" },
          {
            id: "final",
            memoryCitation: null,
            phase: "final_answer",
            text: "Authoritative final",
            type: "agentMessage",
          },
          {
            id: "commentary",
            memoryCitation: null,
            phase: "commentary",
            text: "Later commentary",
            type: "agentMessage",
          },
          {
            delivery: "async",
            id: "async-progress",
            memoryCitation: null,
            phase: "final_answer",
            text: "Asynchronous progress",
            type: "agentMessage",
          },
        ],
        status: "completed",
      },
    });
    await logger.destroy();

    const allEvents = events();
    const finalSnapshot = allEvents.find(
      (event) =>
        event.kind === "message.added" &&
        readEventPayloadString(event, "content") === "Authoritative final",
    );
    const runCompleted = allEvents.find((event) => event.kind === "run.completed");

    expect(finalSnapshot).toBeDefined();
    expect(runCompleted).toBeDefined();
    expect(readEventPayloadString(runCompleted!, "finalMessageId")).toBe(
      readEventPayloadString(finalSnapshot!, "messageId"),
    );
    expect(runCompleted!.payload).not.toHaveProperty("finalMessageText");
  });

  test("keeps asynchronous progress out of legacy final selection", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          {
            id: "legacy",
            memoryCitation: null,
            phase: null,
            text: "Legacy final",
            type: "agentMessage",
          },
          {
            delivery: "async",
            id: "async-progress",
            memoryCitation: null,
            phase: "final_answer",
            text: "Asynchronous progress",
            type: "agentMessage",
          },
        ],
        status: "completed",
      },
    });
    await logger.destroy();

    const allEvents = events();
    const finalSnapshot = allEvents.find(
      (event) =>
        event.kind === "message.added" &&
        readEventPayloadString(event, "content") === "Legacy final",
    );
    const asyncSnapshot = allEvents.find(
      (event) =>
        event.kind === "message.added" &&
        readEventPayloadString(event, "content") === "Asynchronous progress",
    );
    const runCompleted = allEvents.find((event) => event.kind === "run.completed");

    expect(readEventPayloadString(runCompleted!, "finalMessageId")).toBe(
      readEventPayloadString(finalSnapshot!, "messageId"),
    );
    expect(asyncSnapshot?.payload).toMatchObject({ phase: "commentary" });
  });

  test("does not fall back to a legacy snapshot when explicit commentary exists", async () => {
    const { bridge, context, events, logger } = createHarness();

    for (const item of [
      { id: "legacy", memoryCitation: null, phase: null, text: "Legacy", type: "agentMessage" },
      {
        id: "commentary",
        memoryCitation: null,
        phase: "commentary",
        text: "Commentary",
        type: "agentMessage",
      },
    ]) {
      await bridge.handleNotification(context, "item/completed", {
        item,
        threadId: "thread-1",
        turnId: "turn-1",
      });
    }
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "completed" },
    });
    await logger.destroy();

    const terminalPayload = events().find((event) => event.kind === "run.completed")?.payload;
    expect(terminalPayload).not.toHaveProperty("finalMessageId");
    expect(terminalPayload).not.toHaveProperty("finalMessageText");
  });

  test("fails an active turn exactly once when the provider exits", async () => {
    const { bridge, context, events, logger } = createHarness();
    const failure = new Error("app-server exited");
    const completion = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void completion.catch(() => {});

    await bridge.publishRunStarted(context, {
      runId: DRIVER_TEST_IDS.runId,
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/started", {
      item: {
        id: "tool-1",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });

    await expect(bridge.failActiveTurns(context, failure)).resolves.toBe(true);
    await expect(completion).rejects.toThrow("app-server exited");
    await expect(bridge.failActiveTurns(context, failure)).resolves.toBe(false);
    await logger.destroy();

    expect(
      events().filter((event) =>
        ["item.completed", "run.failed", "tool.call.updated"].includes(event.kind),
      ),
    ).toMatchObject([
      {
        kind: "tool.call.updated",
        payload: { status: "running", toolCallId: "tool-1" },
      },
      {
        kind: "tool.call.updated",
        payload: { status: "failed", toolCallId: "tool-1" },
      },
      {
        kind: "item.completed",
        payload: { itemId: "tool-1", status: "failed" },
      },
      {
        kind: "run.failed",
        payload: {
          error: {
            code: "openai.provider_failed",
            message: "app-server exited",
          },
          recoverable: false,
        },
      },
    ]);
  });

  test("replays run start after delivery rejection before committing deduplication", async () => {
    const { attempts, bridge, context, logger } = createHarness({
      failReasonOnce: "driver.openai.turn.started",
    });
    const started = { runId: DRIVER_TEST_IDS.runId, turnId: "turn-1" } as const;

    await expect(bridge.publishRunStarted(context, started)).rejects.toThrow("first attempt");
    await bridge.publishRunStarted(context, started);

    const starts = attempts.flatMap(({ events }) =>
      events.filter((event) => event.kind === "run.started"),
    );
    expect(starts).toHaveLength(2);
    expect(starts[0]!.sourceEventId).toBe(starts[1]!.sourceEventId);
    await logger.destroy();
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
        status: "inProgress",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        aggregatedOutput: "artifact 已创建。",
        id: "artifact-tool",
        status: "completed",
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
            status: "completed",
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
    expect(runCompleted.payload).not.toHaveProperty("finalMessageText");
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
          messageId: assistantMessageId,
          rawOutput: "hello",
          status: "running",
          toolCallId: "cmd-1",
        },
      },
      {
        kind: "tool.call.updated",
        payload: {
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
    await bridge.handleNotification(context, "turn/plan/updated", {
      explanation: null,
      plan: [
        {
          status: "completed",
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
        sourceEventId: "openai.turn.plan:turn-1:0",
      },
      {
        kind: "plan.updated",
        payload: {
          entries: [
            {
              content: "Inspect stream events",
              priority: "medium",
              status: "completed",
            },
            {
              content: "Patch bridge",
              priority: "medium",
              status: "completed",
            },
          ],
          source: "driver",
        },
        sourceEventId: "openai.turn.plan:turn-1:1",
      },
    ]);
  });
});
