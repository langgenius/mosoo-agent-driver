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

    expect(payload?.["finalMessageText"]).toBe("完整最终回答");
    expect(snapshot).toMatchObject({
      kind: "message.added",
      payload: {
        content: [{ text: "完整最终回答", type: "text" }],
        role: "agent",
      },
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

  test("closes every interleaved assistant message before the Run terminal", async () => {
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

    expect(started).toHaveLength(2);
    expect(completed).toEqual(started);
  });

  test("keeps duplicate text scoped to its native assistant message", async () => {
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
    const runCompleted = events().find((event) => event.kind === "run.completed");
    const payload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(textMessages.map((entry) => entry.contentDelta)).toEqual(["相同文本", "相同文本"]);
    expect(new Set(textMessages.map((entry) => entry.messageId)).size).toBe(2);
    expect(payload?.["finalMessageId"]).toBe(textMessages.at(-1)?.messageId);
    expect(payload?.["finalMessageText"]).toBe("相同文本");
  });
});
