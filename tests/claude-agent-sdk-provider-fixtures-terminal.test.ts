import { describe, expect, test } from "bun:test";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { MessageId, RunId } from "../src/protocol/id";
import {
  createClaudeAgentSdkHarness as createHarness,
  isRecord,
  messageText,
} from "./claude-agent-sdk-test-helpers";
import {
  normalizeClaudeProviderEvents as normalizeClaudeEvents,
  readProviderFixture,
} from "./provider-fixture-test-helpers";

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
  "unknown-message-diagnostic",
] as const;

function readClaudeProviderFixtureCase(path: string): ClaudeProviderFixtureCase {
  const fixture = readProviderFixture<ClaudeProviderFixtureCase>(path, {
    arrays: ["expectedEvents", "messages"],
    strings: ["runId"],
  });
  const expectedNativeSessionIds = fixture.expectedNativeSessionIds ?? [];

  if (
    !Array.isArray(expectedNativeSessionIds) ||
    !expectedNativeSessionIds.every((entry) => typeof entry === "string")
  ) {
    throw new TypeError(`Provider fixture ${path} has malformed native session IDs.`);
  }

  return { ...fixture, expectedNativeSessionIds };
}

describe("Claude Agent SDK provider fixtures", () => {
  test("preserves Driver ID equivalence classes while normalizing fixtures", () => {
    const firstMessageId = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as MessageId;
    const secondMessageId = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as MessageId;

    expect(
      normalizeClaudeEvents([
        {
          kind: "message.started",
          payload: { messageId: firstMessageId, role: "agent" },
        },
        {
          kind: "thought.started",
          payload: { channel: "summary", thoughtId: `${firstMessageId}:thought` },
        },
        {
          kind: "message.started",
          payload: { messageId: secondMessageId, role: "agent" },
        },
      ]),
    ).toEqual([
      {
        kind: "message.started",
        payload: { messageId: "<driver-id>", role: "agent" },
      },
      {
        kind: "thought.started",
        payload: { channel: "summary", thoughtId: "<driver-id>:thought" },
      },
      {
        kind: "message.started",
        payload: { messageId: "<driver-id-2>", role: "agent" },
      },
    ]);
  });

  test("keeps chunked stream deltas and the complete assistant snapshot on one message", async () => {
    // Real SDK wire shape: every envelope (each stream chunk and the complete
    // assistant replay) carries a distinct uuid; only the API message id inside
    // message_start / assistant.message is stable across the whole message.
    const { context, events, translator } = createHarness();
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
    expect(payload).not.toHaveProperty("finalMessageText");
    expect(messageText(events(), payload?.["finalMessageId"])).toBe("Got it — I'm here.");
  });

  test("scopes interleaved subagent stream chunks away from the main message", async () => {
    const { context, events, translator } = createHarness();
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
    const { context, events, translator } = createHarness();
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

  test("materializes a result-only native resume completion", async () => {
    const { context, events, translator } = createHarness();
    const messages = [
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "replayed-empty-message",
      },
      {
        result: "recovered final answer",
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

    const translated = events();
    const started = translated.filter((event) => event.kind === "message.started");
    const completed = translated.filter((event) => event.kind === "message.completed");
    const snapshot = translated.find((event) => event.kind === "message.added");
    const runCompleted = translated.find((event) => event.kind === "run.completed");
    const snapshotPayload =
      snapshot === undefined || !isRecord(snapshot.payload) ? null : snapshot.payload;
    const completedPayload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(snapshotPayload?.["content"]).toEqual([
      { text: "recovered final answer", type: "text" },
    ]);
    expect(completedPayload?.["finalMessageId"]).toBe(snapshotPayload?.["messageId"]);
    expect(completedPayload).not.toHaveProperty("finalMessageText");
    expect(messageText(translated, completedPayload?.["finalMessageId"])).toBe(
      "recovered final answer",
    );
  });

  test("keeps structured output as the canonical final payload", async () => {
    const { context, events, translator } = createHarness();

    await translator.handleSdkMessage(
      context,
      {
        is_error: false,
        modelUsage: {},
        permission_denials: [],
        result: "structured output placeholder",
        structured_output: { answer: 42, citations: ["source-1"] },
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-structured",
      } as unknown as SDKMessage,
      "run-1" as RunId,
    );

    expect(events().map(({ kind }) => kind)).not.toContain("message.added");
    expect(events()).toContainEqual({
      kind: "run.completed",
      payload: {
        stopReason: "end_turn",
        structuredOutput: { answer: 42, citations: ["source-1"] },
      },
      runId: "run-1" as RunId,
    });
  });

  test("fails closed for a non-JSON structured output", async () => {
    const { context, events, translator } = createHarness();

    await translator.handleSdkMessage(
      context,
      {
        is_error: false,
        modelUsage: {},
        permission_denials: [],
        result: "structured output placeholder",
        structured_output: Symbol("invalid"),
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-invalid-structured",
      } as unknown as SDKMessage,
      "run-1" as RunId,
    );

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "run.failed",
        payload: expect.objectContaining({
          error: expect.objectContaining({ code: "claude.invalid_structured_output" }),
        }),
      }),
    );
    expect(events().map(({ kind }) => kind)).not.toContain("run.completed");
  });

  test("retracts a superseded refusal before publishing its replacement", async () => {
    const { context, events, translator } = createHarness();
    const messages = [
      {
        message: {
          content: [{ text: "stale refusal", type: "text" }],
          id: "native-refusal",
        },
        parent_tool_use_id: null,
        session_id: "session-1",
        type: "assistant",
        uuid: "wire-refusal",
      },
      {
        message: {
          content: [{ text: "canonical replacement", type: "text" }],
          id: "native-replacement",
        },
        parent_tool_use_id: null,
        session_id: "session-1",
        supersedes: ["wire-refusal"],
        type: "assistant",
        uuid: "wire-replacement",
      },
      {
        is_error: false,
        modelUsage: {},
        permission_denials: [],
        result: "canonical replacement",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-replacement",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }

    const snapshots = events().flatMap((event) => {
      if (event.kind !== "message.added" || !isRecord(event.payload)) {
        return [];
      }
      const content = event.payload["content"];
      const messageId = event.payload["messageId"];
      return Array.isArray(content) && typeof messageId === "string"
        ? [{ messageId, text: (content[0] as { text?: unknown } | undefined)?.text }]
        : [];
    });
    const stale = snapshots.find(({ text }) => text === "stale refusal");
    const replacement = snapshots.find(({ text }) => text === "canonical replacement");
    const cancellationIndex = events().findIndex(
      (event) =>
        event.kind === "message.cancelled" &&
        isRecord(event.payload) &&
        event.payload["messageId"] === stale?.messageId,
    );
    const replacementIndex = events().findIndex(
      (event) =>
        event.kind === "message.added" &&
        isRecord(event.payload) &&
        event.payload["messageId"] === replacement?.messageId,
    );
    const completed = events().find((event) => event.kind === "run.completed");

    expect(stale).toBeDefined();
    expect(replacement).toBeDefined();
    expect(cancellationIndex).toBeGreaterThan(-1);
    expect(cancellationIndex).toBeLessThan(replacementIndex);
    expect(completed?.payload).toMatchObject({
      finalMessageId: replacement?.messageId,
    });
    expect(completed?.payload).not.toHaveProperty("finalMessageText");
    expect(messageText(events(), replacement?.messageId)).toBe("canonical replacement");
  });

  test("applies refusal fallback retractions idempotently to messages and tool results", async () => {
    const { context, events, translator } = createHarness();
    const fallback = {
      content: "Retrying with fallback model.",
      direction: "retry",
      fallback_model: "claude-fallback",
      original_model: "claude-primary",
      request_id: "request-1",
      retracted_message_uuids: ["wire-refusal", "wire-tool-result", "unknown-wire"],
      session_id: "session-1",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      type: "system",
      uuid: "fallback-notice",
    };
    const messages = [
      {
        message: {
          content: [
            { text: "stale refusal", type: "text" },
            { id: "tool-old", input: { command: "pwd" }, name: "Bash", type: "tool_use" },
          ],
          id: "native-refusal",
        },
        parent_tool_use_id: null,
        session_id: "session-1",
        type: "assistant",
        uuid: "wire-refusal",
      },
      {
        message: {
          content: [{ content: "stale tool result", tool_use_id: "tool-old", type: "tool_result" }],
        },
        session_id: "session-1",
        type: "user",
        uuid: "wire-tool-result",
      },
      fallback,
      { ...fallback, uuid: "fallback-notice-replayed" },
      {
        is_error: false,
        modelUsage: {},
        permission_denials: [
          {
            decisionReason: "denied before fallback",
            tool_input: { command: "pwd" },
            tool_name: "Bash",
            tool_use_id: "tool-old",
          },
        ],
        result: "canonical replacement",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "late-authoritative-denial",
      },
      {
        message: {
          content: [{ text: "canonical replacement", type: "text" }],
          id: "native-replacement",
        },
        parent_tool_use_id: null,
        session_id: "session-1",
        type: "assistant",
        uuid: "wire-replacement",
      },
      {
        is_error: false,
        modelUsage: {},
        permission_denials: [],
        result: "canonical replacement",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-replacement",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }

    const retractedMessages = events().filter(
      (event) =>
        event.kind === "message.cancelled" &&
        isRecord(event.payload) &&
        event.payload["reason"] === "superseded",
    );
    const cancelledTools = events().filter(
      (event) =>
        event.kind === "tool.call.updated" &&
        isRecord(event.payload) &&
        event.payload["status"] === "cancelled" &&
        event.payload["toolCallId"] === "tool-old",
    );
    const completed = events().find((event) => event.kind === "run.completed");
    const retractionIndex = events().findIndex(
      (event) =>
        event.kind === "tool.call.updated" &&
        isRecord(event.payload) &&
        event.payload["status"] === "cancelled" &&
        event.payload["toolCallId"] === "tool-old",
    );
    const toolUpdatesAfterRetraction = events()
      .slice(retractionIndex + 1)
      .filter(
        (event) =>
          event.kind === "tool.call.updated" &&
          isRecord(event.payload) &&
          event.payload["toolCallId"] === "tool-old",
      );

    expect(retractedMessages).toHaveLength(1);
    expect(cancelledTools).toHaveLength(1);
    expect(toolUpdatesAfterRetraction).toEqual([]);
    expect(completed?.payload).not.toHaveProperty("finalMessageText");
    expect(
      messageText(
        events(),
        isRecord(completed?.payload) ? completed.payload["finalMessageId"] : null,
      ),
    ).toBe("canonical replacement");
  });

  test("keeps assistant envelopes distinct when they share an API message id", async () => {
    const { context, events, translator } = createHarness();
    const messages = [
      {
        message: { content: [{ text: "first", type: "text" }], id: "shared-native" },
        parent_tool_use_id: null,
        session_id: "session-1",
        type: "assistant",
        uuid: "wire-first",
      },
      {
        message: { content: [{ text: "second", type: "text" }], id: "shared-native" },
        parent_tool_use_id: null,
        session_id: "session-1",
        type: "assistant",
        uuid: "wire-second",
      },
      {
        is_error: false,
        modelUsage: {},
        permission_denials: [],
        result: "second",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-second",
      },
    ] as unknown as SDKMessage[];

    for (const message of messages) {
      await translator.handleSdkMessage(context, message, "run-1" as RunId);
    }

    const snapshots = events().flatMap((event) => {
      if (event.kind !== "message.added" || !isRecord(event.payload)) {
        return [];
      }
      const content = event.payload["content"];
      const messageId = event.payload["messageId"];
      return Array.isArray(content) && typeof messageId === "string"
        ? [{ messageId, text: (content[0] as { text?: unknown } | undefined)?.text }]
        : [];
    });
    const completed = events().find((event) => event.kind === "run.completed");

    expect(snapshots.map(({ text }) => text)).toEqual(["first", "second"]);
    expect(new Set(snapshots.map(({ messageId }) => messageId)).size).toBe(2);
    expect(completed?.payload).toMatchObject({
      finalMessageId: snapshots[1]?.messageId,
    });
    expect(completed?.payload).not.toHaveProperty("finalMessageText");
    expect(messageText(events(), snapshots[1]?.messageId)).toBe("second");
  });

  test("turns provider-aborted result frames into runtime cancellation", async () => {
    const { context, events, translator } = createHarness();

    await translator.handleSdkMessage(
      context,
      {
        errors: ["aborted"],
        is_error: true,
        modelUsage: {},
        permission_denials: [],
        subtype: "error_during_execution",
        terminal_reason: "aborted_tools",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-aborted",
      } as unknown as SDKMessage,
      "run-1" as RunId,
    );

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "run.cancelled",
        payload: expect.objectContaining({ reason: "aborted_tools" }),
      }),
    );
    expect(events().map(({ kind }) => kind)).not.toContain("run.failed");
  });

  test("does not let a late older assistant completion replace the final message", async () => {
    const { context, events, translator } = createHarness();
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

    const runCompleted = events().find((event) => event.kind === "run.completed");
    const payload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(runCompleted).toBeDefined();
    expect(payload).not.toBeNull();
    expect(payload).not.toHaveProperty("finalMessageText");
    expect(messageText(events(), payload?.["finalMessageId"])).toBe("最终回答 B");
  });

  test("fails closed when a newer assistant is still incomplete at result success", async () => {
    const { context, events, translator } = createHarness();
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

    const runCompleted = events().find((event) => event.kind === "run.completed");
    const payload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(runCompleted).toBeDefined();
    expect(payload).not.toBeNull();
    expect(payload).not.toHaveProperty("finalMessageId");
    expect(payload).not.toHaveProperty("finalMessageText");
  });

  test("fails closed when an older full frame arrives after a newer incomplete message", async () => {
    const { context, events, translator } = createHarness();
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
    const { context, events, translator } = createHarness();
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

    const toolArguments = events().flatMap((event) => {
      if (event.kind !== "tool.call.updated" || !isRecord(event.payload)) {
        return [];
      }

      const rawInputDelta = event.payload["rawInputDelta"];
      const toolCallId = event.payload["toolCallId"];
      return typeof rawInputDelta === "string" && typeof toolCallId === "string"
        ? [{ rawInputDelta, toolCallId }]
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
      { rawInputDelta: '{"a":', toolCallId: "tool-a" },
      { rawInputDelta: '{"b":1}', toolCallId: "tool-b" },
      { rawInputDelta: "1}", toolCallId: "tool-a" },
    ]);
    expect(thoughts["A1"]).toBe(thoughts["A2"]);
    expect(thoughts["A1"]).not.toBe(thoughts["B1"]);
  });

  test.each(claudeFixtureNames)("apps provider-native fixture %s", async (name) => {
    const fixture = readClaudeProviderFixtureCase(
      `./fixtures/providers/claude-agent-sdk/cases/${name}.json`,
    );
    const { context, events, nativeSessionIds, translator } = createHarness();

    for (const message of fixture.messages) {
      await translator.handleSdkMessage(context, message as SDKMessage, fixture.runId);
    }

    expect(nativeSessionIds).toEqual(fixture.expectedNativeSessionIds);
    expect(normalizeClaudeEvents(events())).toEqual(fixture.expectedEvents);
  });
});
