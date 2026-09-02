import { describe, expect, test } from "bun:test";

import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import { AcpAssistantTranscriptState } from "../src/runtimes/acp/acp-assistant-transcript-state";
import {
  toAuthEvent,
  toInitializeEvents,
  toSessionReadyEvents,
} from "../src/runtimes/acp/acp-session-events";
import { beginAcpTranscript } from "./acp-test-helpers";

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
    const state = beginAcpTranscript({ runId: RUN_ID });

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
      "message.started",
      "item.started",
      "tool.call.updated",
      "message.completed",
      "tool.call.updated",
      "item.completed",
      "run.completed",
    ]);
  });

  test("closes unfinished tool calls when a turn completes", () => {
    const state = beginAcpTranscript({ runId: RUN_ID });

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
      "message.started",
      "item.started",
      "tool.call.updated",
      "message.completed",
      "tool.call.updated",
      "item.completed",
      "run.completed",
    ]);
    expect(eventPayload(events[4]!)).toMatchObject({
      status: "completed",
      toolCallId: "tool-1",
    });
    expect(eventPayload(events[5]!)).toMatchObject({
      itemId: "tool-1",
      status: "completed",
    });
  });

  test("fails open items when max turn requests stops a prompt", () => {
    const state = beginAcpTranscript({ runId: RUN_ID });

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
      "message.started",
      "item.started",
      "tool.call.updated",
      "message.failed",
      "tool.call.updated",
      "item.completed",
      "run.failed",
    ]);
    expect(eventPayload(events[4]!)).toMatchObject({
      error: "ACP prompt stopped with max_turn_requests.",
      status: "failed",
      toolCallId: "tool-1",
    });
    expect(eventPayload(events[5]!)).toMatchObject({
      error: "ACP prompt stopped with max_turn_requests.",
      itemId: "tool-1",
      status: "failed",
    });
    expect(eventPayload(events[6]!)).toMatchObject({
      error: {
        code: "acp.max_turn_requests",
        message: "ACP prompt stopped with max_turn_requests.",
        retryable: false,
      },
      recoverable: false,
      stopReason: "max_turn_requests",
    });
  });

  test("cancels every open item when the prompt is cancelled", () => {
    const state = beginAcpTranscript({ runId: RUN_ID });
    const events = [
      ...state.translateUpdate({
        update: {
          content: { text: "partial answer", type: "text" },
          messageId: "native-message-1",
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...state.translateUpdate({
        update: {
          content: { text: "partial thought", type: "text" },
          messageId: "native-message-1",
          sessionUpdate: "agent_thought_chunk",
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
      ...state.completePrompt("cancelled", null),
    ];

    expect(eventKinds(events)).toContain("message.cancelled");
    expect(eventKinds(events)).toContain("thought.cancelled");
    expect(eventKinds(events)).toContain("run.cancelled");
    expect(
      events.some(
        (event) =>
          event.kind === "tool.call.updated" && eventPayload(event)["status"] === "cancelled",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.kind === "item.completed" && eventPayload(event)["status"] === "cancelled",
      ),
    ).toBe(true);
    expect(eventKinds(events)).not.toContain("message.completed");
  });

  test("fails an empty end turn instead of reporting a blank completed run", () => {
    const state = beginAcpTranscript({ runId: RUN_ID });

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
        retryable: true,
      },
      recoverable: true,
      stopReason: "end_turn",
    });
  });

  test("ignores ACP user message echo chunks because driver input is the source of truth", () => {
    const state = beginAcpTranscript({ runId: RUN_ID });

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
    const state = beginAcpTranscript({ runId: RUN_ID });

    const streamed = [
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
    ];
    const terminal = state.completePrompt("end_turn", null);
    const events = [...streamed, ...terminal];

    expect(eventKinds(events)).toEqual([
      "thought.started",
      "thought.delta",
      "thought.delta",
      "message.started",
      "message.added",
      "message.completed",
      "thought.completed",
      "run.completed",
    ]);
    const fallbackMessageId = eventPayloadString(events[3]!, "messageId");

    expect(eventPayload(events[4]!)).toMatchObject({
      content: "\npong\n",
      messageId: fallbackMessageId,
    });
    expect(eventPayload(events[7]!)).toEqual({
      finalMessageId: fallbackMessageId,
      stopReason: "end_turn",
    });
    expect(terminal.every((event) => event.delivery !== "best_effort")).toBe(true);
  });

  test("treats a different native thought as the final assistant message boundary", () => {
    const state = beginAcpTranscript({ runId: RUN_ID });

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
    const progressMessageId = eventPayloadString(
      requireEvent(events, "message.delta"),
      "messageId",
    );
    const finalMessageId = eventPayloadString(
      events.find(
        (event) => event.kind === "message.added" && eventPayload(event)["content"] === finalText,
      )!,
      "messageId",
    );
    const completed = requireEvent(events, "run.completed");

    expect(eventKinds(events)).toEqual([
      "message.started",
      "message.delta",
      "message.added",
      "message.completed",
      "thought.started",
      "thought.delta",
      "message.started",
      "message.added",
      "message.completed",
      "thought.completed",
      "run.completed",
    ]);
    expect(progressMessageId).not.toBe(finalMessageId);
    expect(eventPayload(completed)).toEqual({ finalMessageId, stopReason: "end_turn" });
    expect(
      events.find(
        (event) =>
          event.kind === "message.added" && eventPayload(event)["messageId"] === finalMessageId,
      )?.payload,
    ).toMatchObject({ content: finalText });
  });

  test("fails closed when an anonymous thought follows identified progress", () => {
    const state = beginAcpTranscript({ runId: RUN_ID });

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
      "message.added",
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
    const state = beginAcpTranscript({ runId: RUN_ID });

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
      "message.failed",
      "tool.call.updated",
      "item.completed",
      "run.failed",
    ]);
    expect(eventPayload(requireEvent(events, "run.failed"))).toMatchObject({
      error: { message: "transport closed", retryable: false },
    });
    expect(eventPayload(events[5]!)).not.toHaveProperty("error");
    expect(eventPayload(events[6]!)).not.toHaveProperty("error");
  });

  test("emits native resume state from ACP session setup", () => {
    const events = toSessionReadyEvents({
      mode: "created",
      nativeSessionId: "native-session-1",
      setup: {
        modes: {
          availableModes: [{ id: "default", name: "Default" }],
          currentModeId: "default",
        },
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
    expect(events[2]?.delivery).toBe("best_effort");
    expect(eventPayload(events[2]!)).toEqual({
      availableModes: [{ id: "default", name: "Default" }],
      currentMode: "default",
    });
  });

  test("normalizes ACP config options to the mosoo session config contract", () => {
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

    expect(configEvent?.delivery).toBe("best_effort");
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

  test("normalizes ACP commands to the mosoo session commands contract", () => {
    const state = new AcpAssistantTranscriptState();
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

  test("fails closed on an oversized lossless session snapshot", () => {
    const state = new AcpAssistantTranscriptState();

    expect(() =>
      state.translateUpdate({
        update: {
          availableCommands: [{ description: "x".repeat(600_000), name: "huge" }],
          sessionUpdate: "available_commands_update",
        },
      }),
    ).toThrow("ACP session.commands.updated event exceeds 524288 UTF-8 bytes");
  });

  test("bounds provider IDs without copying the native session ID into source IDs", () => {
    const nativeSessionId = "s".repeat(600_000);

    expect(() => toSessionReadyEvents({ mode: "created", nativeSessionId, setup: {} })).toThrow(
      "ACP runtime.resume.updated event exceeds 524288 UTF-8 bytes",
    );
    expect(() => toAuthEvent({ methodId: nativeSessionId, status: "authenticated" })).toThrow(
      "ACP auth.session.updated event exceeds 524288 UTF-8 bytes",
    );

    const state = beginAcpTranscript({ runId: RUN_ID });
    const sourceEventId = state.translateUpdate({
      update: {
        content: { text: "hello", type: "text" },
        sessionUpdate: "agent_message_chunk",
      },
    })[1]?.sourceEventId;

    expect(sourceEventId).toBe("acp:run-1:agent-message:1");
  });

  test("keeps unbounded initialize telemetry best effort", () => {
    const value = "x".repeat(600_000);
    const events = toInitializeEvents({
      agentCapabilities: { _meta: { value } },
      authMethods: [{ id: value, name: value }],
      protocolVersion: 1,
    } as never);

    expect(events.map((event) => event.delivery)).toEqual(["best_effort", "best_effort"]);
  });

  test("maps ACP 1.3 session timestamps and ignores removed setup aliases", () => {
    const state = new AcpAssistantTranscriptState();
    const info = state.translateUpdate({
      update: {
        sessionUpdate: "session_info_update",
        title: "Session title",
        updatedAt: "2026-08-13T00:00:00.000Z",
      },
    });
    const legacyReady = toSessionReadyEvents({
      mode: "created",
      nativeSessionId: "native-session-1",
      setup: {
        capabilities: { fileSystem: true },
        currentModeId: "legacy-mode",
        currentModel: "legacy-model",
        models: ["legacy-model"],
        options: [],
        providers: ["legacy-provider"],
        sessionCapabilities: { legacy: true },
        visibleModes: [],
      },
    });

    expect(info).toEqual([
      {
        kind: "session.info.updated",
        payload: {
          title: "Session title",
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
      },
    ]);
    expect(
      [
        { sessionUpdate: "session_info_update", title: "" },
        { sessionUpdate: "session_info_update", updatedAt: "not-a-time" },
      ].flatMap((update) => state.translateUpdate({ update })),
    ).toEqual([]);
    expect(eventKinds(legacyReady)).toEqual(["session.created", "runtime.resume.updated"]);
    expect(
      state.translateUpdate({
        update: {
          commands: [{ name: "legacy" }],
          sessionUpdate: "available_commands_update",
        },
      }),
    ).toEqual([]);
  });

  test("normalizes ACP usage sources to the mosoo usage contract", () => {
    const state = beginAcpTranscript({ runId: RUN_ID });

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
      cachedReadTokens: 90,
      cachedWriteTokens: 7,
      inputTokens: 10,
      outputTokens: 2,
      thoughtTokens: 3,
      totalTokens: 112,
    });

    expect(sessionUsage).toEqual([
      {
        kind: "usage.updated",
        payload: {
          costAmount: 0.25,
          costCurrency: "USD",
          size: 1_000,
          source: "session_update",
          usageContract: "anthropic_bucketed",
          used: 12,
        },
      },
    ]);
    expect(completionUsage).toContainEqual({
      kind: "usage.updated",
      payload: {
        cachedReadTokens: 90,
        cachedWriteTokens: 7,
        inputTokens: 10,
        outputTokens: 2,
        source: "prompt_response",
        thoughtTokens: 3,
        totalTokens: 112,
        usageContract: "anthropic_bucketed",
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
    const state = beginAcpTranscript({ runId: RUN_ID });
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
    const state = beginAcpTranscript({ runId: RUN_ID });

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
