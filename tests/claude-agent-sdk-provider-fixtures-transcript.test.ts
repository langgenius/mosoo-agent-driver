import { describe, expect, test } from "bun:test";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { ClaudeAgentSdkMessageTranslator } from "../src/runtimes/claude/agent-sdk-message-translator";
import { driverStartInput as bootPayload } from "./driver-boot-payload-fixture";

interface EventBatch {
  readonly events: DriverEventInput[];
  readonly reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createHarness() {
  const batches: EventBatch[] = [];
  const nativeSessionIds: string[] = [];
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "claude-agent-sdk-provider-fixtures-test",
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
  const translator = new ClaudeAgentSdkMessageTranslator({
    push: async (_context, reason, events) => {
      batches.push({ events, reason });
    },
    recordNativeSessionId: async (_context, sessionId) => {
      nativeSessionIds.push(sessionId);
    },
  });

  return {
    context,
    events: () => batches.flatMap((batch) => batch.events),
    logger,
    nativeSessionIds,
    translator,
  };
}

describe("Claude Agent SDK provider fixtures", () => {
  test("marks an SDK tool error as failed", async () => {
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        message: {
          content: [{ id: "tool-1", input: { command: "false" }, name: "Bash", type: "tool_use" }],
        },
        type: "assistant",
        uuid: "assistant-1",
      },
      {
        message: {
          content: [
            {
              content: "Command failed",
              is_error: true,
              tool_use_id: "tool-1",
              type: "tool_result",
            },
          ],
        },
        type: "user",
        uuid: "user-1",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "tool.call.updated",
        payload: expect.objectContaining({ status: "failed", toolCallId: "tool-1" }),
      }),
    );
  });

  test("rotates assistant identity across a tool boundary and marks the final message", async () => {
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        message: {
          content: [
            { text: "进度：准备工具。", type: "text" },
            { id: "tool-1", input: { command: "pwd" }, name: "Bash", type: "tool_use" },
          ],
        },
        type: "assistant",
        uuid: "assistant-progress",
      },
      {
        message: {
          content: [
            {
              content: [{ text: "/workspace", type: "text" }],
              tool_use_id: "tool-1",
              type: "tool_result",
            },
          ],
        },
        type: "user",
        uuid: "tool-result",
      },
      {
        message: {
          content: [{ text: "最终：中文 Markdown ✅", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-final",
      },
      {
        result: "最终：中文 Markdown ✅",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    const textMessages = events().flatMap((event) => {
      if (event.kind !== "message.delta" || !isRecord(event.payload)) {
        return [];
      }

      const contentDelta = event.payload["contentDelta"];
      const messageId = event.payload["messageId"];
      return typeof contentDelta === "string" && typeof messageId === "string"
        ? [{ contentDelta, messageId }]
        : [];
    });
    const runCompleted = events().find((event) => event.kind === "run.completed");
    const runCompletedPayload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(textMessages.map((entry) => entry.contentDelta)).toEqual([
      "进度：准备工具。",
      "最终：中文 Markdown ✅",
    ]);
    expect(new Set(textMessages.map((entry) => entry.messageId)).size).toBe(2);
    expect(runCompletedPayload?.["finalMessageId"]).toBe(textMessages.at(-1)?.messageId);
  });

  test("uses the complete assistant message to repair an incomplete stream snapshot", async () => {
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        event: {
          delta: { text: "残缺流", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-final",
      },
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "assistant-final",
      },
      {
        event: {
          delta: { text: "迟到流", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-final",
      },
      {
        message: {
          content: [{ text: "完整最终回答", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-final",
      },
      {
        result: "完整最终回答",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    const runCompleted = events().find((event) => event.kind === "run.completed");
    const payload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;
    const snapshot = events().find(
      (event) => event.kind === "message.added" && isRecord(event.payload),
    );
    const translated = events();
    const snapshotIndex = translated.indexOf(snapshot!);
    const completedIndex = translated.findIndex((event) => event.kind === "message.completed");
    const terminalIndex = translated.findIndex((event) => event.kind === "run.completed");

    expect(payload?.["finalMessageText"]).toBe("完整最终回答");
    expect(snapshot).toMatchObject({
      kind: "message.added",
      payload: {
        content: [{ text: "完整最终回答", type: "text" }],
        role: "agent",
      },
    });
    expect(
      translated
        .filter((event) => event.kind === "message.delta" && isRecord(event.payload))
        .map((event) => (event.payload as Record<string, unknown>)["contentDelta"]),
    ).toEqual(["残缺流"]);
    expect(snapshotIndex).toBeLessThan(completedIndex);
    expect(completedIndex).toBeLessThan(terminalIndex);
  });

  test("drops thought and tool updates after their terminal events", async () => {
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        event: {
          content_block: { thinking: "", type: "thinking" },
          index: 0,
          type: "content_block_start",
        },
        type: "stream_event",
        uuid: "assistant-thought",
      },
      {
        event: {
          delta: { thinking: "before", type: "thinking_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-thought",
      },
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "assistant-thought",
      },
      {
        event: {
          delta: { thinking: "after", type: "thinking_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-thought",
      },
      {
        message: {
          content: [{ text: "done", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-thought",
      },
      {
        event: {
          content_block: { id: "tool-1", input: {}, name: "Read", type: "tool_use" },
          index: 0,
          type: "content_block_start",
        },
        type: "stream_event",
        uuid: "assistant-tool",
      },
      {
        message: {
          content: [
            {
              content: "ok",
              tool_use_id: "tool-1",
              type: "tool_result",
            },
          ],
        },
        type: "user",
        uuid: "user-tool",
      },
      {
        event: {
          delta: { partial_json: '{"late":true}', type: "input_json_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-tool",
      },
      {
        result: "done",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    const translated = events();
    const thoughtCompletedIndex = translated.findIndex(
      (event) => event.kind === "thought.completed",
    );
    const thoughtDeltas = translated
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.kind === "thought.delta");
    expect(thoughtDeltas).toHaveLength(1);
    expect(thoughtDeltas[0]!.index).toBeLessThan(thoughtCompletedIndex);
    const toolUpdates = translated.filter(
      (event) =>
        event.kind === "tool.call.updated" &&
        isRecord(event.payload) &&
        event.payload["toolCallId"] === "tool-1",
    );
    const toolCompletedIndex = toolUpdates.findIndex(
      (event) => (event.payload as Record<string, unknown>)["status"] === "completed",
    );
    expect(toolCompletedIndex).toBeGreaterThan(0);
    expect(toolCompletedIndex).toBe(toolUpdates.length - 1);
    expect(JSON.stringify(toolUpdates)).not.toContain('{"late":true}');
  });

  test("ignores streamed text arriving after its assistant message completed", async () => {
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        message: {
          content: [{ text: "complete", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-final",
      },
      {
        event: {
          delta: { text: "-late", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-final",
      },
      {
        result: "complete",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    const translated = events();
    const completed = translated.find((event) => event.kind === "message.completed");
    const messageId =
      completed !== undefined && isRecord(completed.payload)
        ? completed.payload["messageId"]
        : undefined;
    const completedIndex = translated.indexOf(completed!);
    expect(typeof messageId).toBe("string");
    expect(
      translated
        .slice(completedIndex + 1)
        .filter(
          (event) =>
            event.kind === "message.delta" &&
            isRecord(event.payload) &&
            event.payload["messageId"] === messageId,
        ),
    ).toEqual([]);
    expect(translated.find((event) => event.kind === "run.completed")).toMatchObject({
      payload: expect.objectContaining({ finalMessageText: "complete" }),
    });
  });

  test("repairs streamed tool input with a lossless assistant snapshot", async () => {
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        event: {
          content_block: { id: "tool-1", input: {}, name: "Read", type: "tool_use" },
          index: 0,
          type: "content_block_start",
        },
        type: "stream_event",
        uuid: "assistant-1",
      },
      {
        event: {
          delta: { partial_json: '{"path":"partial', type: "input_json_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-1",
      },
      {
        message: {
          content: [{ id: "tool-1", input: { path: "complete" }, name: "Read", type: "tool_use" }],
        },
        type: "assistant",
        uuid: "assistant-1",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    expect(
      events().filter(
        (event) =>
          event.kind === "tool.call.updated" &&
          event.delivery !== "best_effort" &&
          isRecord(event.payload) &&
          event.payload["toolCallId"] === "tool-1",
      ),
    ).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ rawInput: '{"path":"complete"}' }),
      }),
    );
  });

  test.each(["success", "error"] as const)(
    "closes every open item before a %s result terminal",
    async (outcome) => {
      const { context, events, logger, translator } = createHarness();
      const messages = [
        {
          event: {
            delta: { text: "partial", type: "text_delta" },
            index: 0,
            type: "content_block_delta",
          },
          type: "stream_event",
          uuid: "assistant-open",
        },
        {
          event: {
            content_block: { thinking: "", type: "thinking" },
            index: 1,
            type: "content_block_start",
          },
          type: "stream_event",
          uuid: "assistant-open",
        },
        {
          event: {
            content_block: { id: "tool-open", input: {}, name: "Read", type: "tool_use" },
            index: 2,
            type: "content_block_start",
          },
          type: "stream_event",
          uuid: "assistant-open",
        },
        outcome === "success"
          ? {
              result: "partial",
              subtype: "success",
              total_cost_usd: 0,
              type: "result",
              usage: {},
              uuid: "result-1",
            }
          : {
              errors: ["failed"],
              subtype: "error_during_execution",
              total_cost_usd: 0,
              type: "result",
              usage: {},
              uuid: "result-1",
            },
      ] as unknown as SDKMessage[];

      for (const message of messages) {
        await translator.handleSdkMessage(context, message, "run-1" as RunId);
      }
      await logger.destroy();

      const translated = events();
      const terminalIndex = translated.findIndex((event) =>
        ["run.completed", "run.failed"].includes(event.kind),
      );
      expect(terminalIndex).toBeGreaterThan(-1);
      for (const kind of ["message.completed", "thought.completed", "item.completed"] as const) {
        expect(translated.findIndex((event) => event.kind === kind)).toBeGreaterThan(-1);
        expect(translated.findIndex((event) => event.kind === kind)).toBeLessThan(terminalIndex);
      }
      expect(translated.slice(0, terminalIndex)).toContainEqual(
        expect.objectContaining({
          kind: "tool.call.updated",
          payload: expect.objectContaining({
            status: outcome === "success" ? "completed" : "failed",
            toolCallId: "tool-open",
          }),
        }),
      );
    },
  );

  test("keeps a start-less streamed reply on one message through its assistant envelope", async () => {
    // YEF-884 wire shape: message_start was lost, every frame carries its own
    // envelope uuid, and the aggregated assistant envelope (with the native
    // message id) arrives before message_stop. The reply must stay one
    // message instead of rendering as "P" / "ong. …" / full-text duplicates.
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        event: {
          delta: { text: "P", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "frame-delta-1",
      },
      {
        event: {
          delta: { text: "ong. What would you like to work on?", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "frame-delta-2",
      },
      {
        message: {
          content: [{ text: "Pong. What would you like to work on?", type: "text" }],
          id: "msg-pong",
        },
        type: "assistant",
        uuid: "envelope-1",
      },
      {
        event: { index: 0, type: "content_block_stop" },
        type: "stream_event",
        uuid: "frame-stop-1",
      },
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "frame-stop-2",
      },
      {
        result: "Pong. What would you like to work on?",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    const translated = events();
    const textMessages = translated.flatMap((event) => {
      if (event.kind !== "message.delta" || !isRecord(event.payload)) {
        return [];
      }

      const contentDelta = event.payload["contentDelta"];
      const messageId = event.payload["messageId"];
      return typeof contentDelta === "string" && typeof messageId === "string"
        ? [{ contentDelta, messageId }]
        : [];
    });
    const started = translated
      .filter((event) => event.kind === "message.started" && isRecord(event.payload))
      .map((event) => (event.payload as Record<string, unknown>)["messageId"]);
    const snapshot = translated.find(
      (event) => event.kind === "message.added" && isRecord(event.payload),
    );
    const snapshotPayload =
      snapshot === undefined || !isRecord(snapshot.payload) ? null : snapshot.payload;
    const runCompleted = translated.find((event) => event.kind === "run.completed");
    const payload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(textMessages.map((entry) => entry.contentDelta)).toEqual([
      "P",
      "ong. What would you like to work on?",
    ]);
    expect(new Set(textMessages.map((entry) => entry.messageId)).size).toBe(1);
    expect(started).toHaveLength(1);
    expect(snapshotPayload?.["messageId"]).toBe(textMessages[0]?.messageId);
    expect(snapshotPayload?.["content"]).toEqual([
      { text: "Pong. What would you like to work on?", type: "text" },
    ]);
    expect(payload?.["finalMessageId"]).toBe(textMessages[0]?.messageId);
    expect(payload?.["finalMessageText"]).toBe("Pong. What would you like to work on?");
  });

  test("anchors uuid-fractured stream fragments to one closed assistant message", async () => {
    // One scope streams one message at a time; per-envelope uuids must not
    // fracture a burst whose message_start frame was lost (YEF-884).
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        event: {
          delta: { text: "A", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-open-a",
      },
      {
        event: {
          delta: { text: "B", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-open-b",
      },
      {
        result: "B",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-interleaved",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    const translated = events();
    const started = translated
      .filter((event) => event.kind === "message.started" && isRecord(event.payload))
      .map((event) => (event.payload as Record<string, unknown>)["messageId"]);
    const terminalIndex = translated.findIndex((event) => event.kind === "run.completed");
    const completed = translated
      .slice(0, terminalIndex)
      .filter((event) => event.kind === "message.completed" && isRecord(event.payload))
      .map((event) => (event.payload as Record<string, unknown>)["messageId"]);
    const deltaMessageIds = translated
      .filter((event) => event.kind === "message.delta" && isRecord(event.payload))
      .map((event) => (event.payload as Record<string, unknown>)["messageId"]);

    expect(started).toHaveLength(1);
    expect(completed).toEqual(started);
    expect(new Set(deltaMessageIds)).toEqual(new Set(started));
  });

  test("binds the aggregated assistant envelope to an unconfirmed streamed burst", async () => {
    // Without a message_start frame the streamed burst is anchored to an
    // envelope uuid; the aggregated assistant envelope that follows in the
    // same scope is that burst's own aggregation and must not mint a
    // duplicate message (YEF-884).
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        event: {
          delta: { text: "相同文本", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-progress-a",
      },
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "assistant-progress-a",
      },
      {
        message: {
          content: [{ text: "相同文本", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-final-b",
      },
      {
        result: "相同文本",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    const textMessages = events().flatMap((event) => {
      if (event.kind !== "message.delta" || !isRecord(event.payload)) {
        return [];
      }

      const contentDelta = event.payload["contentDelta"];
      const messageId = event.payload["messageId"];
      return typeof contentDelta === "string" && typeof messageId === "string"
        ? [{ contentDelta, messageId }]
        : [];
    });
    const snapshot = events().find(
      (event) => event.kind === "message.added" && isRecord(event.payload),
    );
    const snapshotPayload =
      snapshot === undefined || !isRecord(snapshot.payload) ? null : snapshot.payload;
    const runCompleted = events().find((event) => event.kind === "run.completed");
    const payload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(textMessages.map((entry) => entry.contentDelta)).toEqual(["相同文本"]);
    expect(snapshotPayload?.["messageId"]).toBe(textMessages[0]?.messageId);
    expect(payload?.["finalMessageId"]).toBe(textMessages[0]?.messageId);
    expect(payload?.["finalMessageText"]).toBe("相同文本");
  });

  test("keeps duplicate text on distinct messages when the stream identity is confirmed", async () => {
    // A message_start frame proves the streamed message's native id, so an
    // assistant envelope with a different native id is a genuinely separate
    // message even when the text repeats.
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        event: {
          message: { id: "msg-progress" },
          type: "message_start",
        },
        type: "stream_event",
        uuid: "stream-1",
      },
      {
        event: {
          delta: { text: "相同文本", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "stream-2",
      },
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "stream-3",
      },
      {
        message: {
          content: [{ text: "相同文本", type: "text" }],
          id: "msg-final",
        },
        type: "assistant",
        uuid: "assistant-final",
      },
      {
        result: "相同文本",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    const textMessages = events().flatMap((event) => {
      if (event.kind !== "message.delta" || !isRecord(event.payload)) {
        return [];
      }

      const contentDelta = event.payload["contentDelta"];
      const messageId = event.payload["messageId"];
      return typeof contentDelta === "string" && typeof messageId === "string"
        ? [{ contentDelta, messageId }]
        : [];
    });
    const runCompleted = events().find((event) => event.kind === "run.completed");
    const payload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(textMessages.map((entry) => entry.contentDelta)).toEqual(["相同文本", "相同文本"]);
    expect(new Set(textMessages.map((entry) => entry.messageId)).size).toBe(2);
    expect(payload?.["finalMessageId"]).toBe(textMessages.at(-1)?.messageId);
    expect(payload?.["finalMessageText"]).toBe("相同文本");
  });
});
