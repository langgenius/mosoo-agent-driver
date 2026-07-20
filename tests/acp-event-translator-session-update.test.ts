import { describe, expect, test } from "bun:test";

import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import { AcpTurnEventState, toSessionReadyEvents } from "../src/runtimes/acp/acp-event-translator";

const RUN_ID = "run-1" as RunId;

function eventKinds(events: readonly DriverEventInput[]): string[] {
  return events.map((event) => event.kind);
}

function eventPayload(event: DriverEventInput): Record<string, unknown> {
  expect(event.payload).toBeObject();
  return event.payload as Record<string, unknown>;
}

function eventPayloadString(event: DriverEventInput, field: string): string {
  const value = eventPayload(event)[field];

  if (typeof value !== "string") {
    throw new Error(`Expected ACP event payload ${field} to be a string.`);
  }

  return value;
}

function requireEvent(events: readonly DriverEventInput[], kind: string): DriverEventInput {
  const event = events.find((candidate) => candidate.kind === kind);

  if (event === undefined) {
    throw new Error(`Expected ACP event ${kind}.`);
  }

  return event;
}

describe("ACP runtime event translation", () => {
  test("starts permission tool calls through the turn event state", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: RUN_ID,
      sessionId: "session-1",
    });

    const translation = state.translatePermission({
      params: {
        options: [{ kind: "allow_once", name: "Allow once", optionId: "allow" }],
        toolCall: {
          kind: "shell",
          rawInput: { command: "pwd" },
          title: "Run command",
          toolCallId: "tool-1",
        },
      },
      requestId: "rpc-42",
    });

    const events = [...translation.events, ...state.completePrompt("end_turn", null)];

    expect(eventKinds(events)).toEqual([
      "item.started",
      "tool.call.updated",
      "permission.requested",
      "item.completed",
      "run.completed",
    ]);
  });

  test("closes unfinished tool calls when a turn completes", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: RUN_ID,
      sessionId: "session-1",
    });

    const events = [
      ...state.translateUpdate({
        update: {
          sessionUpdate: "tool_call",
          status: "running",
          title: "Run command",
          toolCallId: "tool-1",
        },
      }),
      ...state.completePrompt("end_turn", null),
    ];

    expect(eventKinds(events)).toEqual([
      "item.started",
      "tool.call.updated",
      "item.completed",
      "run.completed",
    ]);
    expect(eventPayload(events[2]!)).toMatchObject({
      itemId: "tool-1",
      status: "completed",
    });
  });

  test("maps max turn request stops to completed limited runs", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: RUN_ID,
      sessionId: "session-1",
    });

    const events = [
      ...state.translateUpdate({
        update: {
          sessionUpdate: "tool_call",
          status: "running",
          title: "Run command",
          toolCallId: "tool-1",
        },
      }),
      ...state.completePrompt("max_turn_requests", null),
    ];

    expect(eventKinds(events)).toEqual([
      "item.started",
      "tool.call.updated",
      "item.completed",
      "run.completed",
    ]);
    expect(eventPayload(events[2]!)).toMatchObject({
      itemId: "tool-1",
      status: "completed",
    });
    expect(eventPayload(events[3]!)).toMatchObject({
      stopReason: "max_turn_requests",
    });
  });

  test("fails an empty end turn instead of reporting a blank completed run", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: RUN_ID,
      sessionId: "session-1",
    });

    const events = state.completePrompt("end_turn", {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });

    expect(eventKinds(events)).toEqual(["usage.updated", "run.failed"]);
    expect(eventPayload(events[1]!)).toMatchObject({
      error: {
        code: "acp.empty_turn",
        message: "ACP prompt ended without assistant output or tool activity.",
      },
      recoverable: true,
      stopReason: "end_turn",
    });
  });

  test("ignores ACP user message echo chunks because driver input is the source of truth", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: RUN_ID,
      sessionId: "session-1",
    });

    expect(
      state.translateUpdate({
        update: {
          content: {
            text: "hello",
            type: "text",
          },
          sessionUpdate: "user_message_chunk",
        },
      }),
    ).toEqual([]);
  });

  test("promotes message-scoped thought-only ACP output into an assistant message", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: RUN_ID,
      sessionId: "session-1",
    });

    const events = [
      ...state.translateUpdate({
        update: {
          content: {
            text: "\n",
            type: "text",
          },
          messageId: "opencode-message-1",
          sessionUpdate: "agent_thought_chunk",
        },
      }),
      ...state.translateUpdate({
        update: {
          content: {
            text: "pong\n",
            type: "text",
          },
          messageId: "opencode-message-1",
          sessionUpdate: "agent_thought_chunk",
        },
      }),
      ...state.completePrompt("end_turn", null),
    ];

    expect(eventKinds(events)).toEqual([
      "thought.started",
      "thought.delta",
      "thought.delta",
      "message.started",
      "message.delta",
      "message.completed",
      "thought.completed",
      "run.completed",
    ]);
    const fallbackMessageId = eventPayloadString(events[3]!, "messageId");

    expect(eventPayload(events[4]!)).toMatchObject({
      contentDelta: "\npong\n",
      messageId: fallbackMessageId,
      role: "agent",
    });
    expect(eventPayload(events[7]!)).toMatchObject({
      finalMessageId: fallbackMessageId,
      finalMessageText: "\npong\n",
    });
  });

  test("treats a different native thought as the final assistant message boundary", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: RUN_ID,
      sessionId: "session-1",
    });

    const progressText = "PROGRESS：正在整理资料。";
    const finalText = "FINAL：中文表格与结论均已完成。";
    const events = [
      ...state.translateUpdate({
        update: {
          content: { text: progressText, type: "text" },
          messageId: "native-progress",
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...state.translateUpdate({
        update: {
          content: { text: finalText, type: "text" },
          messageId: "native-final-thought",
          sessionUpdate: "agent_thought_chunk",
        },
      }),
      ...state.completePrompt("end_turn", null),
    ];
    const messageDeltas = events.filter((event) => event.kind === "message.delta");
    const progressMessageId = eventPayloadString(messageDeltas[0]!, "messageId");
    const finalMessageId = eventPayloadString(messageDeltas[1]!, "messageId");
    const completed = requireEvent(events, "run.completed");

    expect(eventKinds(events)).toEqual([
      "message.started",
      "message.delta",
      "message.completed",
      "thought.started",
      "thought.delta",
      "message.started",
      "message.delta",
      "message.completed",
      "thought.completed",
      "run.completed",
    ]);
    expect(progressMessageId).not.toBe(finalMessageId);
    expect(eventPayload(completed)).toMatchObject({
      finalMessageId,
      finalMessageText: finalText,
    });
    expect(eventPayloadString(completed, "finalMessageText")).not.toContain(progressText);
  });

  test("fails closed when an anonymous thought follows identified progress", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: RUN_ID,
      sessionId: "session-1",
    });

    const events = [
      ...state.translateUpdate({
        update: {
          content: { text: "PROGRESS：已识别但不是最终回答。", type: "text" },
          messageId: "native-progress",
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...state.translateUpdate({
        update: {
          content: { text: "匿名 thought 可能是更新的最终回答。", type: "text" },
          sessionUpdate: "agent_thought_chunk",
        },
      }),
      ...state.completePrompt("end_turn", null),
    ];
    const failed = requireEvent(events, "run.failed");

    expect(eventKinds(events)).toEqual([
      "message.started",
      "message.delta",
      "message.completed",
      "thought.started",
      "thought.delta",
      "thought.completed",
      "run.failed",
    ]);
    expect(eventPayload(failed)).toMatchObject({
      error: {
        code: "acp.empty_turn",
      },
      recoverable: true,
      stopReason: "end_turn",
    });
  });

  test("closes open stream items before a failed turn event", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: RUN_ID,
      sessionId: "session-1",
    });

    const events = [
      ...state.translateUpdate({
        update: {
          content: {
            text: "partial",
            type: "text",
          },
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...state.translateUpdate({
        update: {
          sessionUpdate: "tool_call",
          status: "running",
          title: "Run command",
          toolCallId: "tool-1",
        },
      }),
      ...state.failPrompt({
        code: "acp.turn_failed",
        message: "transport closed",
      }),
    ];

    expect(eventKinds(events)).toEqual([
      "message.started",
      "message.delta",
      "item.started",
      "tool.call.updated",
      "message.completed",
      "item.completed",
      "run.failed",
    ]);
  });

  test("emits native resume state from ACP session setup", () => {
    const events = toSessionReadyEvents({
      mode: "created",
      nativeSessionId: "native-session-1",
      setup: {
        currentModeId: "default",
      },
    });

    expect(eventKinds(events)).toEqual([
      "session.created",
      "runtime.resume.updated",
      "session.mode.updated",
    ]);
    expect("resumePointer" in eventPayload(events[0]!)).toBe(false);
    expect(events[1]).toMatchObject({
      visibility: "owner_debug",
    });
  });

  test("normalizes ACP config options to the Mosoo session config contract", () => {
    const events = toSessionReadyEvents({
      mode: "created",
      nativeSessionId: "native-session-1",
      setup: {
        configOptions: [
          {
            category: "model",
            currentValue: "deepseek/deepseek-v4-pro",
            id: "model",
            name: "Model",
            options: [
              {
                name: "DeepSeek/DeepSeek V4 Pro",
                value: "deepseek/deepseek-v4-pro",
              },
            ],
            type: "select",
          },
        ],
      },
    });
    const configEvent = events.find((event) => event.kind === "session.config.updated");
    const payload = eventPayload(configEvent as DriverEventInput);

    expect(payload).toEqual({
      options: [
        {
          category: "model",
          currentValue: "deepseek/deepseek-v4-pro",
          id: "model",
          name: "Model",
          type: "select",
          values: [
            {
              name: "DeepSeek/DeepSeek V4 Pro",
              value: "deepseek/deepseek-v4-pro",
            },
          ],
        },
      ],
    });
  });

  test("normalizes stable ACP boolean and grouped select config options", () => {
    const events = toSessionReadyEvents({
      mode: "created",
      nativeSessionId: "native-session-1",
      setup: {
        configOptions: [
          {
            currentValue: true,
            id: "auto-approve",
            name: "Auto approve",
            type: "boolean",
          },
          {
            currentValue: "fast",
            id: "model",
            name: "Model",
            options: [
              {
                group: "recommended",
                name: "Recommended",
                options: [{ name: "Fast", value: "fast" }],
              },
            ],
            type: "select",
          },
        ],
      },
    });
    const configEvent = events.find((event) => event.kind === "session.config.updated");

    expect(eventPayload(configEvent as DriverEventInput)).toEqual({
      options: [
        {
          currentValue: true,
          id: "auto-approve",
          name: "Auto approve",
          type: "boolean",
        },
        {
          currentValue: "fast",
          id: "model",
          name: "Model",
          type: "select",
          values: [
            {
              group: "recommended",
              groupName: "Recommended",
              name: "Fast",
              value: "fast",
            },
          ],
        },
      ],
    });
  });

  test("normalizes ACP commands to the Mosoo session commands contract", () => {
    const state = new AcpTurnEventState();
    const events = state.translateUpdate({
      update: {
        availableCommands: [
          {
            name: "init",
          },
        ],
        sessionUpdate: "available_commands_update",
      },
    });

    expect(events).toEqual([
      {
        kind: "session.commands.updated",
        payload: {
          commands: [
            {
              description: "",
              input: null,
              name: "init",
            },
          ],
        },
      },
    ]);
  });

  test("normalizes ACP usage sources to the Mosoo usage contract", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: RUN_ID,
      sessionId: "session-1",
    });

    const sessionUsage = state.translateUpdate({
      update: {
        cost: {
          amount: 0.25,
          currency: "USD",
        },
        sessionUpdate: "usage_update",
        size: 1_000,
        used: 12,
      },
    });
    const completionUsage = state.completePrompt("end_turn", {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });

    expect(sessionUsage).toEqual([
      {
        kind: "usage.updated",
        payload: {
          costAmount: 0.25,
          costCurrency: "USD",
          size: 1_000,
          source: "session_update",
          usageContract: "openai_total_with_cached_breakdown",
          used: 12,
        },
      },
    ]);
    expect(completionUsage).toContainEqual({
      kind: "usage.updated",
      payload: {
        inputTokens: 10,
        outputTokens: 2,
        raw: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
        },
        source: "prompt_response",
        totalTokens: 12,
        usageContract: "openai_total_with_cached_breakdown",
      },
      runId: RUN_ID,
    });
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["non-finite", Number.POSITIVE_INFINITY],
  ] as const)("drops wholly invalid %s usage without blocking Run completion", (_name, value) => {
    const state = new AcpTurnEventState();
    state.begin({ messageId: "message-1", runId: RUN_ID, sessionId: "session-1" });
    state.translateUpdate({
      update: {
        content: { text: "done", type: "text" },
        messageId: "assistant-1",
        sessionUpdate: "agent_message_chunk",
      },
    });

    expect(
      state.translateUpdate({
        update: {
          cost: { amount: -1, currency: "USD" },
          sessionUpdate: "usage_update",
          size: value,
          used: value,
        },
      }),
    ).toEqual([]);
    const completion = state.completePrompt("end_turn", {
      inputTokens: value,
      outputTokens: value,
      totalTokens: value,
    });

    expect(completion.some((event) => event.kind === "usage.updated")).toBe(false);
    expect(completion.at(-1)?.kind).toBe("run.completed");
  });

  test("keeps valid usage fields while omitting malformed siblings", () => {
    const state = new AcpTurnEventState();
    state.begin({ messageId: "message-1", runId: RUN_ID, sessionId: "session-1" });

    const [sessionUsage] = state.translateUpdate({
      update: {
        cost: { amount: -1, currency: "USD" },
        sessionUpdate: "usage_update",
        size: 1.5,
        used: 12,
      },
    });
    const completionUsage = state
      .completePrompt("end_turn", {
        inputTokens: -1,
        outputTokens: 2,
        totalTokens: 2,
      })
      .find((event) => event.kind === "usage.updated");

    expect(sessionUsage?.payload).toMatchObject({
      source: "session_update",
      used: 12,
    });
    expect(sessionUsage?.payload).not.toHaveProperty("size");
    expect(sessionUsage?.payload).not.toHaveProperty("costAmount");
    expect(completionUsage?.payload).toMatchObject({ outputTokens: 2, totalTokens: 2 });
    expect(completionUsage?.payload).not.toHaveProperty("inputTokens");
  });
});
