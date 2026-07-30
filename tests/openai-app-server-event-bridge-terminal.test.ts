import { describe, expect, test } from "bun:test";

import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import { OpenAiAppServerEventBridge } from "../src/runtimes/openai/app-server-event-bridge";
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
});
