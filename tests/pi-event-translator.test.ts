import { describe, expect, test } from "bun:test";

import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-event-envelope";
import type { DriverEventInput } from "../src/protocol/events";
import { isJsonObject } from "../src/protocol/json";
import type { JsonObject } from "../src/protocol/json";
import { PiEventTranslator } from "../src/runtimes/pi/pi-event-translator";
import { driverBootPayload, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

function completeAssistant(translator: PiEventTranslator, usage: JsonObject) {
  translator.translate({ type: "message_start", message: { role: "assistant" } });
  return translator.translate({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "stop", usage },
  });
}

function thinkingUpdate(translator: PiEventTranslator, update: JsonObject) {
  return translator.translate({ type: "message_update", assistantMessageEvent: update });
}

function finishThinking(translator: PiEventTranslator, thinking: string, stopReason = "stop") {
  return translator.translate({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "thinking", thinking }], stopReason },
  });
}

function thoughtText(events: DriverEventInput[]): string {
  return events
    .flatMap((event) => {
      const text = isJsonObject(event.payload) ? event.payload["contentDelta"] : undefined;
      return event.kind === "thought.delta" && typeof text === "string" ? [text] : [];
    })
    .join("");
}

describe("Pi thinking delivery", () => {
  test.each(["thinking_end", "message_end"])("preserves final-only content from %s", (source) => {
    const translator = new PiEventTranslator();
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    const events =
      source === "thinking_end"
        ? thinkingUpdate(translator, { type: source, contentIndex: 0, content: "A summary." })
        : finishThinking(translator, "A summary.");
    expect(
      events.filter((event) => event.kind.startsWith("thought.")).map((event) => event.kind),
    ).toEqual(["thought.started", "thought.delta", "thought.completed"]);
    expect(thoughtText(events)).toBe("A summary.");
    expect(events.find((event) => event.kind === "thought.delta")?.delivery).toBe("lossless");
    if (source === "thinking_end")
      expect(finishThinking(translator, "A summary.").map((event) => event.kind)).toEqual([
        "message.completed",
      ]);
    expect(translator.closeOpenItems()).toEqual([]);
  });

  test.each(["thinking_end", "message_end"])(
    "reconciles missing tail at %s without duplicating streamed text",
    (source) => {
      const translator = new PiEventTranslator();
      translator.translate({ type: "message_start", message: { role: "assistant" } });
      const events = thinkingUpdate(translator, { type: "thinking_start", contentIndex: 0 });
      events.push(
        ...thinkingUpdate(translator, { type: "thinking_delta", contentIndex: 0, delta: "First " }),
      );
      if (source === "thinking_end")
        events.push(
          ...thinkingUpdate(translator, {
            type: source,
            contentIndex: 0,
            content: "First second.",
          }),
        );
      events.push(...finishThinking(translator, "First second."));
      expect(thoughtText(events)).toBe("First second.");
      expect(events.filter((event) => event.kind === "thought.started")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "thought.completed")).toHaveLength(1);
      expect(
        events
          .filter((event) => event.kind === "thought.delta")
          .every((event) => event.delivery === "lossless"),
      ).toBe(true);
      expect(translator.closeOpenItems()).toEqual([]);
    },
  );

  test("ignores duplicate starts and ends and validates the final message", () => {
    const translator = new PiEventTranslator();
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    thinkingUpdate(translator, { type: "thinking_start", contentIndex: 0 });
    expect(thinkingUpdate(translator, { type: "thinking_start", contentIndex: 0 })).toEqual([]);
    thinkingUpdate(translator, { type: "thinking_delta", contentIndex: 0, delta: "summary" });
    expect(
      thinkingUpdate(translator, { type: "thinking_end", contentIndex: 0, content: "summary" }).map(
        (event) => event.kind,
      ),
    ).toEqual(["thought.completed"]);
    expect(
      thinkingUpdate(translator, { type: "thinking_end", contentIndex: 0, content: "summary" }),
    ).toEqual([]);
    expect(finishThinking(translator, "summary").map((event) => event.kind)).toEqual([
      "message.completed",
    ]);
  });

  test.each(["thinking_end", "message_end"])(
    "rejects conflicting %s content without exposing it in the error",
    (source) => {
      const translator = new PiEventTranslator();
      translator.translate({ type: "message_start", message: { role: "assistant" } });
      thinkingUpdate(translator, { type: "thinking_delta", contentIndex: 0, delta: "accepted" });
      expect(() =>
        source === "thinking_end"
          ? thinkingUpdate(translator, {
              type: source,
              contentIndex: 0,
              content: "conflicting private text",
            })
          : finishThinking(translator, "conflicting private text"),
      ).toThrow("Pi final thinking content does not match the delivered prefix.");
      expect(translator.closeOpenItems(true).map((event) => event.kind)).toEqual([
        "thought.cancelled",
        "message.completed",
      ]);
    },
  );

  test("chunks large final thinking within canonical event limits without splitting unicode", () => {
    const translator = new PiEventTranslator();
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    const text = '\u0000"\\😀'.repeat(100_000);
    const events = finishThinking(translator, text);
    const deltas = events.filter((event) => event.kind === "thought.delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(thoughtText(events)).toBe(text);
    for (const event of deltas) {
      expect(event.delivery).toBe("lossless");
      if (!isJsonObject(event.payload)) throw new Error("Missing thought payload.");
      const content = event.payload["contentDelta"];
      if (typeof content !== "string") throw new Error("Missing thought text.");
      expect(content.isWellFormed()).toBe(true);
      const canonical = toDriverEventEnvelopes(
        { ...driverBootPayload, runtime: "pi", runtimeTransport: "pi-rpc" },
        event,
        DRIVER_TEST_IDS.runId,
      );
      expect(Buffer.byteLength(JSON.stringify(canonical), "utf8")).toBeLessThan(1_024 * 1_024);
    }
  });

  test.each(["cleanup", "message_end"])("cancels incomplete thinking once on %s", (source) => {
    const translator = new PiEventTranslator();
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    const events = thinkingUpdate(translator, {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "partial",
    });
    expect(
      thinkingUpdate(translator, { type: "thinking_delta", contentIndex: 0, delta: "" }),
    ).toEqual([]);
    events.push(
      ...(source === "cleanup"
        ? translator.closeOpenItems(true)
        : finishThinking(translator, "partial", "aborted")),
    );
    expect(
      events.filter((event) => event.kind.startsWith("thought.")).map((event) => event.kind),
    ).toEqual(["thought.started", "thought.delta", "thought.cancelled"]);
    expect(translator.closeOpenItems(true)).toEqual([]);
  });

  test("bounds retained thinking across blocks and releases it after the message", () => {
    const translator = new PiEventTranslator();
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    const delta = "x".repeat(1_024 * 1_024);
    for (let contentIndex = 0; contentIndex < 16; contentIndex++)
      thinkingUpdate(translator, { type: "thinking_delta", contentIndex, delta });
    expect(() =>
      thinkingUpdate(translator, { type: "thinking_delta", contentIndex: 0, delta: "x" }),
    ).toThrow("Pi assistant message exceeds the thinking content byte limit.");
    translator.translate({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "stop" },
    });
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    expect(
      thoughtText(thinkingUpdate(translator, { type: "thinking_delta", contentIndex: 0, delta })),
    ).toBe(delta);
  });

  test("bounds empty thinking blocks before they can accumulate indefinitely", () => {
    const translator = new PiEventTranslator();
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    for (let contentIndex = 0; contentIndex < 1_000; contentIndex++)
      thinkingUpdate(translator, { type: "thinking_start", contentIndex });
    expect(() =>
      thinkingUpdate(translator, { type: "thinking_start", contentIndex: 1_000 }),
    ).toThrow("Pi assistant message exceeds the thinking block limit.");
    translator.closeOpenItems(true);
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    expect(thinkingUpdate(translator, { type: "thinking_start", contentIndex: 0 })).toHaveLength(1);
  });

  test("keeps separate thought blocks at their native content indexes and ignores signatures", () => {
    const translator = new PiEventTranslator();
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    const streamed = thinkingUpdate(translator, {
      type: "thinking_delta",
      contentIndex: 2,
      delta: "second",
    });
    const completed = translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "first", thinkingSignature: "hidden-one" },
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "second", thinkingSignature: "hidden-two" },
          { type: "thinking", thinkingSignature: "hidden-three" },
        ],
        stopReason: "stop",
      },
    });
    expect(thoughtText(completed)).toBe("first");
    expect(completed.filter((event) => event.kind === "thought.completed")).toHaveLength(2);
    expect(completed.findLast((event) => event.kind === "thought.completed")?.payload).toEqual(
      streamed[0]?.payload,
    );
    expect(JSON.stringify([...streamed, ...completed])).not.toContain("hidden-");
  });
});

describe("Pi Run usage", () => {
  test("accumulates assistant responses and successful compaction once per Run", () => {
    const translator = new PiEventTranslator();
    const first = completeAssistant(translator, {
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 2,
      reasoning: 2,
      totalTokens: 20,
      cost: { total: 0.125 },
    });
    const second = completeAssistant(translator, {
      input: 4,
      output: 3,
      cacheRead: 1,
      cacheWrite: 0,
      reasoning: 1,
      totalTokens: 8,
      cost: { total: 0.25 },
    });
    const usage = {
      input: 2,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 1,
      totalTokens: 3,
      cost: { total: 0.5 },
    };
    expect(
      translator.translate({ type: "entry_appended", entry: { type: "compaction", usage } }),
    ).toEqual([]);
    const compacted = translator.translate({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: { summary: "earlier work", usage },
    });
    expect(compacted.map((event) => event.kind)).toEqual(["context.compacted", "usage.updated"]);
    expect(first.at(-1)?.payload).toMatchObject({
      inputTokens: 10,
      totalTokens: 20,
      costAmount: 0.125,
    });
    expect(second.at(-1)?.payload).toMatchObject({
      inputTokens: 14,
      totalTokens: 28,
      costAmount: 0.375,
    });
    expect(compacted.at(-1)?.payload).toEqual({
      inputTokens: 16,
      outputTokens: 9,
      cachedReadTokens: 4,
      cachedWriteTokens: 2,
      thoughtTokens: 4,
      totalTokens: 31,
      costAmount: 0.875,
      costCurrency: "USD",
      usageContract: "anthropic_bucketed",
      source: "session_update",
    });
    expect(completeAssistant(new PiEventTranslator(), usage).at(-1)?.payload).toMatchObject({
      inputTokens: 2,
      totalTokens: 3,
      costAmount: 0.5,
    });
  });

  test.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "12",
    null,
  ])("ignores invalid token counts %s without poisoning later totals", (invalid) => {
    const translator = new PiEventTranslator();
    expect(
      completeAssistant(translator, { input: invalid }).some(
        (event) => event.kind === "usage.updated",
      ),
    ).toBe(false);
    completeAssistant(translator, { input: 5 });
    expect(
      completeAssistant(translator, { input: invalid }).some(
        (event) => event.kind === "usage.updated",
      ),
    ).toBe(false);
    expect(completeAssistant(translator, { input: 7 }).at(-1)?.payload).toMatchObject({
      inputTokens: 12,
    });
  });

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "0.5", null])(
    "ignores invalid cost %s without poisoning later totals",
    (invalid) => {
      const translator = new PiEventTranslator();
      expect(
        completeAssistant(translator, { cost: { total: invalid } }).some(
          (event) => event.kind === "usage.updated",
        ),
      ).toBe(false);
      completeAssistant(translator, { cost: { total: 0.25 } });
      completeAssistant(translator, { cost: { total: invalid } });
      expect(completeAssistant(translator, { cost: { total: 0.5 } }).at(-1)?.payload).toMatchObject(
        { costAmount: 0.75, costCurrency: "USD" },
      );
    },
  );

  test("rejects overflowing sums while preserving accepted counts and costs", () => {
    const translator = new PiEventTranslator();
    completeAssistant(translator, {
      input: Number.MAX_SAFE_INTEGER,
      cost: { total: Number.MAX_VALUE },
    });
    expect(
      completeAssistant(translator, { input: 1, cost: { total: Number.MAX_VALUE } }).some(
        (event) => event.kind === "usage.updated",
      ),
    ).toBe(false);
    expect(
      completeAssistant(translator, { input: 0, cost: { total: 0 } }).at(-1)?.payload,
    ).toMatchObject({
      inputTokens: Number.MAX_SAFE_INTEGER,
      costAmount: Number.MAX_VALUE,
    });
  });

  test("does not report cancelled or failed compaction as success or usage", () => {
    const translator = new PiEventTranslator();
    for (const record of [
      { aborted: true, result: { usage: { input: 100 } } },
      { aborted: false, errorMessage: "failed", result: { usage: { input: 100 } } },
      { aborted: false },
    ]) {
      expect(
        translator.translate({ type: "compaction_end", reason: "overflow", ...record }),
      ).toEqual([]);
    }
    expect(completeAssistant(translator, { input: 5 }).at(-1)?.payload).toMatchObject({
      inputTokens: 5,
    });
  });
});

describe("Pi tool event contract", () => {
  test("closes interrupted messages, thoughts and running tools once", () => {
    const translator = new PiEventTranslator();
    const first = translator.translate({ type: "message_start", message: { role: "assistant" } });
    translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "running", name: "bash" },
          { type: "toolCall", id: "done", name: "read" },
        ],
        stopReason: "toolUse",
      },
    });
    for (const toolCallId of ["running", "done"]) {
      translator.translate({
        type: "tool_execution_start",
        toolCallId,
        toolName: toolCallId === "running" ? "bash" : "read",
        args: { command: "sleep 60" },
      });
    }
    translator.translate({ type: "tool_execution_end", toolCallId: "done", toolName: "read" });
    const current = translator.translate({ type: "message_start", message: { role: "assistant" } });
    const thoughts = [];
    for (const contentIndex of [0, 1]) {
      thoughts.push(
        ...translator.translate({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_start", contentIndex },
        }),
      );
    }
    translator.translate({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
    });
    const closures = translator.closeOpenItems();
    expect(closures.map((event) => event.kind)).toEqual([
      "thought.completed",
      "message.completed",
      "tool.call.updated",
    ]);
    expect(closures[0]?.payload).toEqual(thoughts[1]?.payload);
    expect(closures[1]?.payload).toEqual(current[0]?.payload);
    const firstPayload = first[0]?.payload;
    if (!isJsonObject(firstPayload)) throw new Error("Missing assistant message start.");
    expect(closures[2]?.payload).toEqual({
      toolCallId: "running",
      parentMessageId: firstPayload["messageId"],
      title: "bash",
      kind: "tool",
      rawInput: '{"command":"sleep 60"}',
      status: "failed",
    });
    expect(
      closures.flatMap((event) =>
        toDriverEventEnvelopes(
          { ...driverBootPayload, runtime: "pi", runtimeTransport: "pi-rpc" },
          event,
          DRIVER_TEST_IDS.runId,
        ),
      ),
    ).toHaveLength(3);
    expect(translator.closeOpenItems()).toEqual([]);
  });

  test.each([
    { type: "tool_execution_update", isError: false, status: "running" },
    { type: "tool_execution_end", isError: false, status: "completed" },
    { type: "tool_execution_end", isError: true, status: "failed" },
  ])("accepts empty $status output through the Driver uplink", ({ type, isError, status }) => {
    const translator = new PiEventTranslator();
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "empty", name: "bash", arguments: { command: "true" } }],
        stopReason: "toolUse",
      },
    });
    translator.translate({
      type: "tool_execution_start",
      toolCallId: "empty",
      toolName: "bash",
      args: { command: "true" },
    });
    const events = translator.translate({
      type,
      toolCallId: "empty",
      toolName: "bash",
      isError,
      result: { content: [{ type: "text", text: "" }] },
      partialResult: { content: [{ type: "text", text: "" }] },
    });
    const canonical = events.flatMap((event) =>
      toDriverEventEnvelopes(
        { ...driverBootPayload, runtime: "pi", runtimeTransport: "pi-rpc" },
        event,
        DRIVER_TEST_IDS.runId,
      ),
    );
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.event.payload).toMatchObject({
      status,
      parentMessageId: expect.any(String),
    });
    expect(canonical[0]?.event.payload).not.toHaveProperty("rawOutput");
    if (type === "tool_execution_end")
      expect(canonical[0]?.event.payload).toHaveProperty("rawInput", '{"command":"true"}');
    if (type === "tool_execution_end") expect(translator.closeOpenItems()).toEqual([]);
  });

  test("keeps each completed tool attached to its original assistant message", () => {
    const translator = new PiEventTranslator();
    const first = translator.translate({ type: "message_start", message: { role: "assistant" } });
    translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "shell", name: "bash", arguments: { command: "pwd" } },
          { type: "toolCall", id: "file", name: "read", arguments: { path: "proof.txt" } },
        ],
        stopReason: "toolUse",
      },
    });
    const started = translator.translate({
      type: "tool_execution_start",
      toolCallId: "shell",
      toolName: "bash",
      args: { command: "pwd" },
    });
    const updated = translator.translate({
      type: "tool_execution_update",
      toolCallId: "shell",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "/work" }] },
    });
    const completed = translator.translate({
      type: "tool_execution_end",
      toolCallId: "shell",
      toolName: "bash",
      result: { content: [{ type: "text", text: "/workspace" }] },
      isError: false,
    });
    expect(started[0]?.payload).toMatchObject({ status: "running", title: "bash" });
    expect(updated[0]?.payload).toMatchObject({ status: "running", rawOutput: "/work" });
    expect(completed[0]?.payload).toMatchObject({
      status: "completed",
      rawInput: '{"command":"pwd"}',
      rawOutput: "/workspace",
    });
    // Arguments are AG-UI deltas, so a full native argument object occurs once.
    expect(started[0]?.payload).not.toHaveProperty("rawInput");
    expect(updated[0]?.payload).not.toHaveProperty("rawInput");

    const next = translator.translate({ type: "message_start", message: { role: "assistant" } });
    translator.translate({
      type: "tool_execution_start",
      toolCallId: "file",
      toolName: "read",
      args: { path: "proof.txt" },
    });
    const failed = translator.translate({
      type: "tool_execution_end",
      toolCallId: "file",
      toolName: "read",
      result: { content: [{ type: "text", text: "File does not exist." }] },
      isError: true,
    });
    expect(failed[0]?.payload).toMatchObject({
      status: "failed",
      rawInput: '{"path":"proof.txt"}',
      rawOutput: "File does not exist.",
    });
    const firstPayload = first[0]?.payload;
    if (!isJsonObject(firstPayload)) throw new Error("Missing assistant message start.");
    const firstId = firstPayload["messageId"];
    expect(next[0]?.payload).not.toHaveProperty("messageId", firstId);
    for (const event of [...started, ...updated, ...completed, ...failed]) {
      expect(event.payload).toHaveProperty("parentMessageId", firstId);
      expect(event.payload).not.toHaveProperty("outputText");
    }
  });

  test("rejects unassociated tool output instead of publishing an invisible tool", () => {
    const translator = new PiEventTranslator();
    expect(() =>
      translator.translate({
        type: "tool_execution_start",
        toolCallId: "unknown",
        toolName: "read",
        args: { path: "proof.txt" },
      }),
    ).toThrow("Pi tool event has no assistant message.");
  });
});
