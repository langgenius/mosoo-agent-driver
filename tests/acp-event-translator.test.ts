import { describe, expect, test } from "bun:test";

import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import type { DriverEventInput } from "../src/protocol/events";
import {
  AcpTurnEventState,
  toAcpPermissionRequest,
  toAcpPermissionResolvedEvent,
  toAcpSessionReadyEvents,
} from "../src/runtimes/acp/acp-event-translator";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

function eventKinds(events: readonly DriverEventInput[]): string[] {
  return events.map((event) => event.kind);
}

function eventPayload(event: DriverEventInput): Record<string, unknown> {
  expect(event.payload).toBeObject();
  return event.payload as Record<string, unknown>;
}

describe("ACP runtime event translation", () => {
  test("maps ACP turn updates onto canonical runtime events with one tool lifecycle", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: "run-1",
      sessionId: "session-1",
    });

    const events = [
      ...state.translateUpdate({
        update: {
          content: {
            text: "hello",
            type: "text",
          },
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...state.translateUpdate({
        update: {
          kind: "shell",
          rawInput: { command: "pwd" },
          sessionUpdate: "tool_call",
          status: "running",
          title: "Run command",
          toolCallId: "tool-1",
        },
      }),
      ...state.translateUpdate({
        update: {
          rawOutput: { text: "/workspace" },
          sessionUpdate: "tool_call_update",
          status: "completed",
          toolCallId: "tool-1",
        },
      }),
      ...state.translateUpdate({
        update: {
          rawOutput: { text: "/workspace" },
          sessionUpdate: "tool_call_update",
          status: "completed",
          toolCallId: "tool-1",
        },
      }),
      ...state.completePrompt("end_turn", { totalTokens: 12 }),
    ];

    const kinds = eventKinds(events);

    expect(kinds).toEqual([
      "message.started",
      "message.delta",
      "item.started",
      "tool.call.updated",
      "tool.call.updated",
      "item.completed",
      "tool.call.updated",
      "message.completed",
      "usage.updated",
      "run.completed",
    ]);
    expect(kinds.filter((kind) => kind === "item.started")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "item.completed")).toHaveLength(1);
    expect(kinds.every((kind) => kind.includes("."))).toBe(true);
  });

  test("omits empty ACP tool input before runtime event ingress", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: DRIVER_TEST_IDS.runId,
      sessionId: DRIVER_TEST_IDS.sessionId,
    });

    const events = state.translateUpdate({
      update: {
        content: {
          text: "Creating file",
          type: "text",
        },
        rawInput: "",
        sessionUpdate: "tool_call",
        status: "running",
        title: "Create file",
        toolCallId: "tool-1",
      },
    });
    const toolEvent = events.find((event) => event.kind === "tool.call.updated");

    expect(toolEvent).toBeDefined();
    expect(eventPayload(toolEvent as DriverEventInput)).toMatchObject({
      content: "Creating file",
    });
    expect(eventPayload(toolEvent as DriverEventInput)).not.toHaveProperty("rawInput");

    const envelopes = events.flatMap((event) =>
      toDriverEventEnvelopes(driverBootPayload, event, DRIVER_TEST_IDS.runId),
    );
    const canonicalToolEvent = envelopes
      .map((envelope) => envelope.event)
      .find((event) => event.kind === "tool.call.updated");

    expect(canonicalToolEvent).toBeDefined();
    expect(eventPayload(canonicalToolEvent as DriverEventInput)).not.toHaveProperty("rawInput");
  });

  test("preserves the ACP request id across permission request and resolution events", () => {
    const translation = toAcpPermissionRequest({
      params: {
        options: [
          { kind: "allow_once", name: "Allow once", optionId: "allow" },
          { kind: "reject_once", name: "Reject once", optionId: "reject" },
        ],
        toolCall: {
          kind: "shell",
          rawInput: { command: "pwd" },
          title: "Run command",
          toolCallId: "tool-1",
        },
      },
      requestId: "rpc-42",
      runId: "run-1",
    });

    const permissionEvent = translation.events.find(
      (event) => event.kind === "permission.requested",
    );

    expect(permissionEvent).toBeDefined();
    expect(translation.requestId).toBe("rpc-42");
    expect(translation.defaultOptionId).toBe("allow");
    expect(eventPayload(permissionEvent as DriverEventInput)).toMatchObject({
      defaultOptionId: "allow",
      requestId: "rpc-42",
      targetItemId: "tool-1",
      title: "Run command",
    });

    const resolved = toAcpPermissionResolvedEvent({
      option: translation.options[0] ?? null,
      requestId: translation.requestId,
      runId: "run-1",
    });

    expect(resolved.kind).toBe("permission.resolved");
    expect(eventPayload(resolved)).toMatchObject({
      optionId: "allow",
      optionKind: "allow_once",
      outcome: "selected",
      requestId: "rpc-42",
    });
  });

  test("starts permission tool calls through the turn event state", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: "run-1",
      sessionId: "session-1",
    });

    const translation = state.translatePermissionRequest({
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
      runId: "run-1",
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
    expect(eventPayload(events[2])).toMatchObject({
      itemId: "tool-1",
      status: "completed",
    });
  });

  test("maps max turn request stops to failed runs", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: "run-1",
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
      "run.failed",
    ]);
    expect(eventPayload(events[2])).toMatchObject({
      error: expect.any(String),
      itemId: "tool-1",
      status: "failed",
    });
    expect(eventPayload(events[3])).toMatchObject({
      error: {
        code: "acp.max_turn_requests",
        message: expect.any(String),
      },
      recoverable: false,
      stopReason: "max_turn_requests",
    });
  });

  test("ignores ACP user message echo chunks because driver input is the source of truth", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: "run-1",
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
      runId: "run-1",
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
            text: "pong",
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
    expect(eventPayload(events[4])).toMatchObject({
      contentDelta: "pong",
      messageId: "message-1",
      role: "agent",
    });
  });

  test("closes open stream items before a failed turn event", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: "run-1",
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
    const events = toAcpSessionReadyEvents({
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
    expect("resumePointer" in eventPayload(events[0])).toBe(false);
    expect(events[1]).toMatchObject({
      visibility: "owner_debug",
    });
  });

  test("normalizes ACP config options to the Mosoo session config contract", () => {
    const events = toAcpSessionReadyEvents({
      mode: "created",
      nativeSessionId: "native-session-1",
      setup: {
        configOptions: [
          {
            id: "approval",
          },
          {
            category: "model",
            currentValue: "deepseek/deepseek-v4-pro",
            id: "model",
            name: "Model",
            options: [
              "deepseek/deepseek-v4-flash",
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
          currentValue: "",
          id: "approval",
          name: "approval",
          type: "select",
          values: [],
        },
        {
          category: "model",
          currentValue: "deepseek/deepseek-v4-pro",
          id: "model",
          name: "Model",
          type: "select",
          values: [
            {
              name: "deepseek/deepseek-v4-flash",
              value: "deepseek/deepseek-v4-flash",
            },
            {
              name: "DeepSeek/DeepSeek V4 Pro",
              value: "deepseek/deepseek-v4-pro",
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
      runId: "run-1",
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
      runId: "run-1",
    });
  });
});
