import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import type { RunId } from "../src/protocol/id";
import type { AgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { ClaudeAgentSdkMessageTranslator } from "../src/runtimes/claude/agent-sdk-message-translator";
import { driverBootPayload as bootPayload } from "./driver-boot-payload-fixture";

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
    runId,
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
      pushEvents: async () => {},
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

    expect(payload?.["finalMessageText"]).toBe("完整最终回答");
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
