import { describe, expect, test } from "bun:test";

import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import { OpenAiAppServerEventBridge } from "../src/runtimes/openai/app-server-event-bridge";
import { DRIVER_TEST_IDS, driverStartInput as bootPayload } from "./driver-boot-payload-fixture";

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
    await expect(completion).rejects.toBe(failure);
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
