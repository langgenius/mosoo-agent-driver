import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import type { RunId } from "../src/protocol/id";
import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { ClaudeAgentSdkMessageTranslator } from "../src/runtimes/claude/agent-sdk-message-translator";
import { driverStartInput as bootPayload } from "./driver-boot-payload-fixture";

interface EventBatch {
  readonly events: DriverEventInput[];
  readonly reason: string;
}

interface ClaudeProviderFixtureCase {
  readonly expectedEvents: readonly unknown[];
  readonly expectedNativeSessionIds: readonly string[];
  readonly messages: readonly unknown[];
  readonly runId: RunId;
}

const claudeFixtureNames = [
  "assistant-final-message",
  "result-failure-diagnostic",
  "stream-text-thinking-tool-result",
  "system-files-and-session",
  "unknown-message-ignored",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

function readClaudeProviderFixtureCase(path: string): ClaudeProviderFixtureCase {
  const fixture = readJsonFixture(path);

  if (!isRecord(fixture)) {
    throw new Error("Claude provider fixture must be an object.");
  }

  const messages = fixture["messages"];
  const expectedEvents = fixture["expectedEvents"];
  const expectedNativeSessionIds = fixture["expectedNativeSessionIds"] ?? [];
  const runId = fixture["runId"];

  if (
    !Array.isArray(messages) ||
    !Array.isArray(expectedEvents) ||
    !Array.isArray(expectedNativeSessionIds) ||
    typeof runId !== "string"
  ) {
    throw new Error("Claude provider fixture shape is malformed.");
  }

  if (!expectedNativeSessionIds.every((entry) => typeof entry === "string")) {
    throw new Error("Claude provider fixture expectedNativeSessionIds must be strings.");
  }

  return {
    expectedEvents,
    expectedNativeSessionIds,
    messages,
    runId: runId as RunId,
  };
}

function collectDriverIds(value: unknown, ids: Set<string>): void {
  if (typeof value === "string") {
    if (isDriverId(value)) {
      ids.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDriverIds(entry, ids);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const entry of Object.values(value)) {
    collectDriverIds(entry, ids);
  }
}

function isIsoTimestamp(value: string): boolean {
  return value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}

function normalizeClaudeValue(
  value: unknown,
  driverIds: ReadonlySet<string>,
  fieldName?: string,
): unknown {
  if (typeof value === "string") {
    for (const driverId of driverIds) {
      if (value === driverId) {
        return "<driver-id>";
      }

      if (value.startsWith(`${driverId}:`)) {
        return value.replace(driverId, "<driver-id>");
      }
    }

    if (fieldName !== undefined && fieldName.endsWith("At") && isIsoTimestamp(value)) {
      return "<iso-timestamp>";
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeClaudeValue(entry, driverIds));
  }

  if (!isRecord(value)) {
    return value;
  }

  const entries = Object.entries(value).flatMap(([key, entry]): [string, unknown][] =>
    entry === undefined ? [] : [[key, normalizeClaudeValue(entry, driverIds, key)]],
  );

  return Object.fromEntries(entries);
}

function normalizeClaudeEvents(events: readonly DriverEventInput[]): unknown[] {
  const driverIds = new Set<string>();

  for (const event of events) {
    collectDriverIds(event, driverIds);
  }

  return events.map((event) => normalizeClaudeValue(event, driverIds));
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
  test("keeps chunked stream deltas and the complete assistant snapshot on one message", async () => {
    // Real SDK wire shape: every envelope (each stream chunk and the complete
    // assistant replay) carries a distinct uuid; only the API message id inside
    // message_start / assistant.message is stable across the whole message.
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        event: {
          message: { id: "msg-api-1" },
          type: "message_start",
        },
        type: "stream_event",
        uuid: "envelope-1",
      },
      {
        event: {
          content_block: { text: "", type: "text" },
          index: 0,
          type: "content_block_start",
        },
        type: "stream_event",
        uuid: "envelope-2",
      },
      {
        event: {
          delta: { text: "Got it —", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "envelope-3",
      },
      {
        event: {
          delta: { text: " I'm here.", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "envelope-4",
      },
      {
        message: {
          content: [{ text: "Got it — I'm here.", type: "text" }],
          id: "msg-api-1",
        },
        type: "assistant",
        uuid: "envelope-5",
      },
      {
        event: {
          index: 0,
          type: "content_block_stop",
        },
        type: "stream_event",
        uuid: "envelope-6",
      },
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "envelope-7",
      },
      {
        result: "Got it — I'm here.",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "envelope-8",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    const startedEvents = events().filter((event) => event.kind === "message.started");
    const completedEvents = events().filter((event) => event.kind === "message.completed");
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

    expect(startedEvents).toHaveLength(1);
    expect(completedEvents).toHaveLength(1);
    expect(textMessages.map((entry) => entry.contentDelta)).toEqual(["Got it —", " I'm here."]);
    expect(new Set(textMessages.map((entry) => entry.messageId)).size).toBe(1);
    expect(payload?.["finalMessageId"]).toBe(textMessages[0]?.messageId);
    expect(payload?.["finalMessageText"]).toBe("Got it — I'm here.");
  });

  test("scopes interleaved subagent stream chunks away from the main message", async () => {
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        event: {
          message: { id: "msg-main" },
          type: "message_start",
        },
        parent_tool_use_id: null,
        type: "stream_event",
        uuid: "envelope-1",
      },
      {
        event: {
          message: { id: "msg-subagent" },
          type: "message_start",
        },
        parent_tool_use_id: "tool-task-1",
        type: "stream_event",
        uuid: "envelope-2",
      },
      {
        event: {
          delta: { text: "主线程回答", type: "text_delta" },
          type: "content_block_delta",
        },
        parent_tool_use_id: null,
        type: "stream_event",
        uuid: "envelope-3",
      },
      {
        event: {
          delta: { text: "子代理输出", type: "text_delta" },
          type: "content_block_delta",
        },
        parent_tool_use_id: "tool-task-1",
        type: "stream_event",
        uuid: "envelope-4",
      },
      {
        event: {
          delta: { text: "，继续。", type: "text_delta" },
          type: "content_block_delta",
        },
        parent_tool_use_id: null,
        type: "stream_event",
        uuid: "envelope-5",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    const textByMessageId = new Map<string, string>();

    for (const event of events()) {
      if (event.kind !== "message.delta" || !isRecord(event.payload)) {
        continue;
      }

      const contentDelta = event.payload["contentDelta"];
      const messageId = event.payload["messageId"];

      if (typeof contentDelta === "string" && typeof messageId === "string") {
        textByMessageId.set(messageId, (textByMessageId.get(messageId) ?? "") + contentDelta);
      }
    }

    expect([...textByMessageId.values()].toSorted()).toEqual(["主线程回答，继续。", "子代理输出"]);
  });

  test("does not promote a replayed stream-only message stop to canonical final", async () => {
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        event: {
          delta: { text: "中", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-final",
      },
      {
        event: {
          delta: { text: "中", type: "text_delta" },
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
        result: "中",
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

    const liveText = events().flatMap((event) => {
      if (event.kind !== "message.delta" || !isRecord(event.payload)) {
        return [];
      }

      const contentDelta = event.payload["contentDelta"];
      return typeof contentDelta === "string" ? [contentDelta] : [];
    });
    const runCompleted = events().find((event) => event.kind === "run.completed");
    const payload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(liveText).toEqual(["中", "中"]);
    expect(payload).not.toBeNull();
    expect(payload).not.toHaveProperty("finalMessageId");
    expect(payload).not.toHaveProperty("finalMessageText");
  });

  test("does not let a late older assistant completion replace the final message", async () => {
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        event: {
          delta: { text: "进度 A", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-progress-a",
      },
      {
        message: {
          content: [{ text: "最终回答 B", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-final-b",
      },
      {
        message: {
          content: [{ text: "进度 A（迟到完整快照）", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-progress-a",
      },
      {
        result: "最终回答 B",
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

    expect(runCompleted).toBeDefined();
    expect(payload).not.toBeNull();
    expect(payload?.["finalMessageText"]).toBe("最终回答 B");
  });

  test("fails closed when a newer assistant is still incomplete at result success", async () => {
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        message: {
          content: [{ text: "已完成的较早进度", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-progress-a",
      },
      {
        event: {
          delta: { text: "尚未结束的最终回答 B", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-final-b",
      },
      {
        result: "尚未结束的最终回答 B",
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

    expect(runCompleted).toBeDefined();
    expect(payload).not.toBeNull();
    expect(payload).not.toHaveProperty("finalMessageId");
    expect(payload).not.toHaveProperty("finalMessageText");
  });

  test("fails closed when an older full frame arrives after a newer incomplete message", async () => {
    const { context, events, logger, translator } = createHarness();
    const messages = [
      {
        event: {
          delta: { text: "最终回答 B 的流式片段", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-final-b",
      },
      {
        message: {
          content: [{ text: "迟到的进度 A", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-progress-a",
      },
      {
        result: "最终回答 B",
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

    expect(runCompleted).toBeDefined();
    expect(payload).not.toBeNull();
    expect(payload).not.toHaveProperty("finalMessageId");
    expect(payload).not.toHaveProperty("finalMessageText");
  });

  test("isolates parallel tool blocks by index and thought streams by message boundary", async () => {
    // Envelope uuids are per-frame on the real wire, so identity within a
    // scope comes from the burst anchor: parallel tool blocks of one message
    // are told apart by content-block index, and a message_stop boundary
    // separates one message's thought stream from the next.
    const { context, events, logger, translator } = createHarness();
    const stream = (uuid: string, event: Record<string, unknown>) =>
      ({ event, type: "stream_event", uuid }) as unknown as SDKMessage;
    const messages = [
      stream("frame-1", {
        content_block: { id: "tool-a", name: "Bash", type: "tool_use" },
        index: 0,
        type: "content_block_start",
      }),
      stream("frame-2", {
        content_block: { id: "tool-b", name: "Bash", type: "tool_use" },
        index: 1,
        type: "content_block_start",
      }),
      stream("frame-3", {
        delta: { partial_json: '{"a":', type: "input_json_delta" },
        index: 0,
        type: "content_block_delta",
      }),
      stream("frame-4", {
        delta: { partial_json: '{"b":1}', type: "input_json_delta" },
        index: 1,
        type: "content_block_delta",
      }),
      stream("frame-5", {
        delta: { partial_json: "1}", type: "input_json_delta" },
        index: 0,
        type: "content_block_delta",
      }),
      stream("frame-6", { type: "message_stop" }),
      stream("frame-7", {
        content_block: { thinking: "", type: "thinking" },
        index: 0,
        type: "content_block_start",
      }),
      stream("frame-8", {
        delta: { thinking: "A1", type: "thinking_delta" },
        index: 0,
        type: "content_block_delta",
      }),
      stream("frame-9", {
        delta: { thinking: "A2", type: "thinking_delta" },
        index: 0,
        type: "content_block_delta",
      }),
      stream("frame-10", { type: "message_stop" }),
      stream("frame-11", {
        content_block: { thinking: "", type: "thinking" },
        index: 0,
        type: "content_block_start",
      }),
      stream("frame-12", {
        delta: { thinking: "B1", type: "thinking_delta" },
        index: 0,
        type: "content_block_delta",
      }),
    ];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }
    await logger.destroy();

    const toolArguments = events().flatMap((event) => {
      if (event.kind !== "tool.call.updated" || !isRecord(event.payload)) {
        return [];
      }

      const rawInput = event.payload["rawInput"];
      const toolCallId = event.payload["toolCallId"];
      return typeof rawInput === "string" && typeof toolCallId === "string"
        ? [{ rawInput, toolCallId }]
        : [];
    });
    const thoughtDeltas = events().flatMap((event) => {
      if (event.kind !== "thought.delta" || !isRecord(event.payload)) {
        return [];
      }

      const contentDelta = event.payload["contentDelta"];
      const thoughtId = event.payload["thoughtId"];
      return typeof contentDelta === "string" && typeof thoughtId === "string"
        ? [{ contentDelta, thoughtId }]
        : [];
    });
    const thoughts = Object.fromEntries(
      thoughtDeltas.map(({ contentDelta, thoughtId }) => [contentDelta, thoughtId]),
    );

    expect(toolArguments).toEqual([
      { rawInput: '{"a":', toolCallId: "tool-a" },
      { rawInput: '{"b":1}', toolCallId: "tool-b" },
      { rawInput: "1}", toolCallId: "tool-a" },
    ]);
    expect(thoughts["A1"]).toBe(thoughts["A2"]);
    expect(thoughts["A1"]).not.toBe(thoughts["B1"]);
  });

  test.each(claudeFixtureNames)("apps provider-native fixture %s", async (name) => {
    const fixture = readClaudeProviderFixtureCase(
      `./fixtures/providers/claude-agent-sdk/cases/${name}.json`,
    );
    const { context, events, logger, nativeSessionIds, translator } = createHarness();

    for (const message of fixture.messages) {
      await translator.handleSdkMessage(context, message as SDKMessage, fixture.runId);
    }

    await logger.destroy();

    expect(nativeSessionIds).toEqual(fixture.expectedNativeSessionIds);
    expect(normalizeClaudeEvents(events())).toEqual(fixture.expectedEvents);
  });
});
