import { expect, test } from "bun:test";

import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AsyncValueQueue } from "../src/core/async-value-queue";
import { ClaudeStreamingQuery } from "../src/runtimes/claude/agent-sdk-streaming-query";

function streamWithResets(count: number, uuid = "reset") {
  const published: string[] = [];
  const failures: unknown[] = [];
  const stream = new ClaudeStreamingQuery({
    reuse: true,
    createQuery: (prompts: AsyncIterable<SDKUserMessage>) => {
      const output = (async function* () {
        for await (const prompt of prompts) {
          yield {
            is_error: false,
            modelUsage: {},
            session_id: "native-session-0",
            subtype: "success",
            total_cost_usd: 0,
            type: "result",
            usage: {},
            user_message_uuid: prompt.uuid,
            uuid: "result-1",
          } as unknown as SDKMessage;
          for (let index = 1; index <= count; index += 1) {
            yield {
              new_conversation_id: `native-session-${index}`,
              session_id: `native-session-${index - 1}`,
              type: "conversation_reset",
              uuid,
            } as unknown as SDKMessage;
          }
          return;
        }
      })();
      return Object.assign(output, {
        initializationResult: async () => ({}),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
          session: { total_cost_usd: 0, model_usage: {} },
        }),
        close: () => {},
      }) as Query;
    },
    onFailure: (error) => failures.push(error),
    onIdleMessage: async (message) => {
      if (message.type === "conversation_reset") published.push(message.new_conversation_id);
    },
  });
  return { failures, published, stream };
}

test("the reader reaches EOF and observes the new native session before control delivery", async () => {
  const { published, stream } = streamWithResets(2);
  stream.submit("hello");
  await stream.finished;
  expect(stream.observedNativeSessionId).toBe("native-session-2");
  expect(published).toEqual([]);
  await expect(stream.flushControls()).rejects.toThrow("preceding Run terminal");
  await stream.releaseTurn();
  expect(published).toEqual(["native-session-1", "native-session-2"]);
  expect(stream.hasPendingControls).toBe(false);
});

test("excess controls fail explicitly while retaining the bounded queue for delivery", async () => {
  const { failures, published, stream } = streamWithResets(65);
  stream.submit("hello");
  await stream.finished;
  expect(failures).toHaveLength(1);
  expect(() => stream.throwIfFailed()).toThrow("64 messages or 64 KiB");
  await stream.releaseTurn();
  expect(published).toHaveLength(64);
  expect(published.at(-1)).toBe("native-session-64");
});

test("one oversized control cannot bypass the pending byte limit", async () => {
  const { failures, published, stream } = streamWithResets(1, "x".repeat(64 * 1_024));
  stream.submit("hello");
  await stream.finished;
  expect(failures).toHaveLength(1);
  expect(() => stream.throwIfFailed()).toThrow("64 messages or 64 KiB");
  expect(published).toEqual([]);
});

test("a control arriving while the previous delivery settles is flushed without another input", async () => {
  const output = new AsyncValueQueue<SDKMessage>("test output", 4);
  const published: string[] = [];
  const secondReset = {
    new_conversation_id: "native-session-2",
    session_id: "native-session-1",
    type: "conversation_reset",
    uuid: "reset-2",
  } as unknown as SDKMessage;
  const stream = new ClaudeStreamingQuery({
    reuse: true,
    createQuery: () =>
      ({
        initializationResult: async () => ({}),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
          session: { total_cost_usd: 0, model_usage: {} },
        }),
        next: () => output.next(),
      }) as unknown as Query,
    onFailure: (error) => {
      throw error;
    },
    onIdleMessage: async (message) => {
      if (message.type !== "conversation_reset") return;
      published.push(message.new_conversation_id);
      if (published.length === 1) queueMicrotask(() => output.push(secondReset));
    },
  });
  const messages = stream.submit("hello");
  output.push({
    is_error: false,
    modelUsage: {},
    session_id: "native-session-0",
    subtype: "success",
    type: "result",
    usage: {},
  } as unknown as SDKMessage);
  await messages.next();
  await stream.releaseTurn();
  output.push({
    new_conversation_id: "native-session-1",
    session_id: "native-session-0",
    type: "conversation_reset",
    uuid: "reset-1",
  } as unknown as SDKMessage);
  await new Promise<void>((resolve) => setImmediate(resolve));
  output.close();
  await stream.finished;
  expect(published).toEqual(["native-session-1", "native-session-2"]);
  expect(stream.hasPendingControls).toBe(false);
});
