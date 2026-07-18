import { describe, expect, test } from "bun:test";

import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import type { DriverEventInput } from "../src/protocol/events";
import {
  AcpTurnEventState,
  toPermissionRequest,
  toPermissionResolvedEvent,
  toSessionReadyEvents,
} from "../src/runtimes/acp/acp-event-translator";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

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
  test("keeps native assistant messages separate across tools and projects only the final one", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "prompt-message-1",
      runId: "run-1",
      sessionId: "session-1",
    });

    const progressOne = "进度 1：正在读取上游报告。";
    const progressTwo = "进度 2：已完成工具校验。";
    const finalChunkOne = [
      "CANARY-FINAL-START：中文与 ASCII 最终回答必须逐字保留。",
      "",
      "| 校验项 | 结果 |",
      "| --- | --- |",
      "| 多字节 | ✅ 中文😀 |",
      "",
      "链接：https://example.com/final-output",
      "",
    ].join("\n");
    const finalChunkTwo = ["```text", "最终代码块|中文😀|END", "```", "CANARY-FINAL-END"].join(
      "\n",
    );
    const finalText = `${finalChunkOne}${finalChunkTwo}`;
    const events = [
      ...state.translateUpdate({
        update: {
          content: { text: progressOne, type: "text" },
          messageId: "native-progress-1",
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...state.translateUpdate({
        update: {
          sessionUpdate: "tool_call",
          status: "running",
          title: "Read report",
          toolCallId: "tool-1",
        },
      }),
      ...state.translateUpdate({
        update: {
          content: { text: progressTwo, type: "text" },
          messageId: "native-progress-2",
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...state.translateUpdate({
        update: {
          content: { text: finalChunkOne, type: "text" },
          messageId: "native-final",
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...state.translateUpdate({
        update: {
          content: { text: finalChunkTwo, type: "text" },
          messageId: "native-final",
          sessionUpdate: "agent_message_chunk",
        },
      }),
      // A late replay of a settled progress message must not replace the
      // newer final message by arrival order.
      ...state.translateUpdate({
        update: {
          content: { text: "late progress replay", type: "text" },
          messageId: "native-progress-1",
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...state.completePrompt("end_turn", null),
    ];
    const messageDeltas = events.filter((event) => event.kind === "message.delta");
    const toolStarted = requireEvent(events, "item.started");
    const completed = requireEvent(events, "run.completed");

    expect(messageDeltas).toHaveLength(4);
    expect(messageDeltas.map((event) => eventPayloadString(event, "contentDelta"))).toEqual([
      progressOne,
      progressTwo,
      finalChunkOne,
      finalChunkTwo,
    ]);

    const [progressOneEvent, progressTwoEvent, finalChunkOneEvent, finalChunkTwoEvent] =
      messageDeltas;
    const progressOneId = eventPayloadString(progressOneEvent, "messageId");
    const progressTwoId = eventPayloadString(progressTwoEvent, "messageId");
    const finalMessageId = eventPayloadString(finalChunkOneEvent, "messageId");

    expect([...new Set([progressOneId, progressTwoId, finalMessageId])]).toHaveLength(3);
    expect(eventPayloadString(finalChunkTwoEvent, "messageId")).toBe(finalMessageId);
    expect(eventPayload(toolStarted)).toMatchObject({
      parentMessageId: progressOneId,
    });
    expect(eventPayload(completed)).toMatchObject({
      finalMessageId,
      finalMessageText: finalText,
    });
    expect(eventPayloadString(completed, "finalMessageText")).not.toContain(progressOne);
    expect(new TextEncoder().encode(eventPayloadString(completed, "finalMessageText"))).toEqual(
      new TextEncoder().encode(finalText),
    );
  });

  test("uses a later identified final after anonymous progress, but fails closed for an anonymous final", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "prompt-message-1",
      runId: "run-1",
      sessionId: "session-1",
    });

    const identifiedFinalText = "最终回答：native identity 使它可安全成为 canonical final。";
    const events = [
      ...state.translateUpdate({
        update: {
          content: { text: "进度消息，不能作为 canonical final。", type: "text" },
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...state.translateUpdate({
        update: {
          content: { text: identifiedFinalText, type: "text" },
          messageId: "native-final",
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...state.completePrompt("end_turn", null),
    ];
    const completed = requireEvent(events, "run.completed");
    const finalDelta = requireEvent(
      events.filter(
        (event) =>
          event.kind === "message.delta" &&
          eventPayloadString(event, "contentDelta") === identifiedFinalText,
      ),
      "message.delta",
    );

    expect(eventPayload(completed)).toMatchObject({
      finalMessageId: eventPayloadString(finalDelta, "messageId"),
      finalMessageText: identifiedFinalText,
    });

    const anonymousFinalState = new AcpTurnEventState();

    anonymousFinalState.begin({
      messageId: "prompt-message-2",
      runId: "run-2",
      sessionId: "session-1",
    });
    const anonymousFinalEvents = [
      ...anonymousFinalState.translateUpdate({
        update: {
          content: { text: "匿名进度消息，必须与后续匿名消息分隔。", type: "text" },
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...anonymousFinalState.translateUpdate({
        update: {
          content: { text: "已识别的进度消息。", type: "text" },
          messageId: "native-progress",
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...anonymousFinalState.translateUpdate({
        update: {
          content: { text: "匿名最终消息，不能猜测身份。", type: "text" },
          sessionUpdate: "agent_message_chunk",
        },
      }),
      ...anonymousFinalState.completePrompt("end_turn", null),
    ];
    const anonymousFailed = requireEvent(anonymousFinalEvents, "run.failed");
    const firstAnonymousDelta = requireEvent(
      anonymousFinalEvents.filter(
        (event) =>
          event.kind === "message.delta" &&
          eventPayloadString(event, "contentDelta") === "匿名进度消息，必须与后续匿名消息分隔。",
      ),
      "message.delta",
    );
    const finalAnonymousDelta = requireEvent(
      anonymousFinalEvents.filter(
        (event) =>
          event.kind === "message.delta" &&
          eventPayloadString(event, "contentDelta") === "匿名最终消息，不能猜测身份。",
      ),
      "message.delta",
    );

    expect(eventPayloadString(firstAnonymousDelta, "messageId")).not.toBe(
      eventPayloadString(finalAnonymousDelta, "messageId"),
    );
    expect(eventPayload(anonymousFailed)).toMatchObject({
      error: {
        code: "acp.empty_turn",
      },
      recoverable: true,
      stopReason: "end_turn",
    });
  });

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
      "message.completed",
      "usage.updated",
      "run.completed",
    ]);
    expect(kinds.filter((kind) => kind === "item.started")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "item.completed")).toHaveLength(1);
    expect(kinds.every((kind) => kind.includes("."))).toBe(true);
  });

  test("does not reset tool identity fields omitted by a partial update", () => {
    const state = new AcpTurnEventState();
    state.begin({ messageId: "message-1", runId: "run-1", sessionId: "session-1" });

    const started = state.translateUpdate({
      update: {
        kind: "shell",
        sessionUpdate: "tool_call",
        status: "running",
        title: "Run command",
        toolCallId: "tool-1",
      },
    });
    const patched = state.translateUpdate({
      update: {
        rawOutput: { text: "done" },
        sessionUpdate: "tool_call_update",
        status: "completed",
        toolCallId: "tool-1",
      },
    });
    const initialPayload = eventPayload(requireEvent(started, "tool.call.updated"));
    const patchPayload = eventPayload(requireEvent(patched, "tool.call.updated"));

    expect(initialPayload).toMatchObject({ kind: "shell", title: "Run command" });
    expect(patchPayload).toMatchObject({ kind: "shell", title: "Run command" });
  });

  test.each([
    ["raw output", { rawOutput: { late: true } }, { rawOutput: expect.stringContaining("late") }],
    [
      "locations",
      { locations: [{ line: 7, path: "/workspace/late.txt" }] },
      { locations: [{ line: 7, path: "/workspace/late.txt" }] },
    ],
    ["content", { content: { text: "late", type: "text" } }, { content: "late" }],
    [
      "terminal reference",
      { content: [{ terminalId: "terminal-late", type: "terminal" }] },
      { content: expect.stringContaining("terminal-late") },
    ],
  ] as const)("keeps a terminal tool completed while merging a later %s patch", (_name, patch, expected) => {
    const state = new AcpTurnEventState();
    state.begin({ messageId: "message-1", runId: "run-1", sessionId: "session-1" });
    const initial = state.translateUpdate({
      update: {
        kind: "shell",
        rawInput: { command: "true" },
        sessionUpdate: "tool_call",
        status: "completed",
        title: "Run command",
        toolCallId: "tool-terminal",
      },
    });
    const initialPayload = eventPayload(requireEvent(initial, "tool.call.updated"));
    const events = state.translateUpdate({
      update: {
        ...patch,
        sessionUpdate: "tool_call_update",
        status: "running",
        toolCallId: "tool-terminal",
      },
    });
    const update = requireEvent(events, "tool.call.updated");

    expect(update.delivery).toBe("lossless");
    expect(eventPayload(update)).toMatchObject({
      kind: "shell",
      rawInput: initialPayload["rawInput"],
      status: "completed",
      title: "Run command",
      ...expected,
    });
    expect(events.filter((event) => event.kind === "item.completed")).toHaveLength(0);
    expect(
      state.translateUpdate({
        update: {
          ...patch,
          sessionUpdate: "tool_call_update",
          status: "running",
          toolCallId: "tool-terminal",
        },
      }),
    ).toEqual([]);
  });

  test.each([
    ["completed", "running", "without content"],
    ["completed", "running", "with content"],
    ["completed", "failed", "without content"],
    ["completed", "failed", "with content"],
    ["failed", "running", "without content"],
    ["failed", "running", "with content"],
    ["failed", "completed", "without content"],
    ["failed", "completed", "with content"],
  ] as const)(
    "keeps the first %s status across a late %s update %s",
    (initialStatus, lateStatus, contentCase) => {
      const state = new AcpTurnEventState();
      state.begin({ messageId: "message-1", runId: "run-1", sessionId: "session-1" });
      state.translateUpdate({
        update: {
          sessionUpdate: "tool_call",
          status: initialStatus,
          toolCallId: "tool-terminal-status",
        },
      });
      const withContent = contentCase === "with content";
      const update = {
        ...(withContent ? { rawOutput: { late: true } } : {}),
        sessionUpdate: "tool_call_update",
        status: lateStatus,
        toolCallId: "tool-terminal-status",
      } as const;
      const events = state.translateUpdate({ update });

      if (withContent) {
        const enriched = requireEvent(events, "tool.call.updated");

        expect(enriched.delivery).toBe("lossless");
        expect(eventPayload(enriched)).toMatchObject({
          rawOutput: expect.stringContaining("late"),
          status: initialStatus,
        });
        expect(events.filter((event) => event.kind === "item.completed")).toHaveLength(0);
      } else {
        expect(events).toEqual([]);
      }

      expect(state.translateUpdate({ update })).toEqual([]);
    },
  );

  test("emits an empty plan as a full replacement", () => {
    const state = new AcpTurnEventState();
    state.begin({ messageId: "message-1", runId: "run-1", sessionId: "session-1" });

    expect(
      state.translateUpdate({
        update: { entries: [], sessionUpdate: "plan" },
      }),
    ).toEqual([
      {
        kind: "plan.updated",
        payload: { entries: [], source: "acp" },
      },
    ]);
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
    const translation = toPermissionRequest({
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

    const resolved = toPermissionResolvedEvent({
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

  test("maps max turn request stops to completed limited runs", () => {
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
      "run.completed",
    ]);
    expect(eventPayload(events[2])).toMatchObject({
      itemId: "tool-1",
      status: "completed",
    });
    expect(eventPayload(events[3])).toMatchObject({
      stopReason: "max_turn_requests",
    });
  });

  test("fails an empty end turn instead of reporting a blank completed run", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: "run-1",
      sessionId: "session-1",
    });

    const events = state.completePrompt("end_turn", {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });

    expect(eventKinds(events)).toEqual(["usage.updated", "run.failed"]);
    expect(eventPayload(events[1])).toMatchObject({
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
    const fallbackMessageId = eventPayloadString(events[3], "messageId");

    expect(eventPayload(events[4])).toMatchObject({
      contentDelta: "\npong\n",
      messageId: fallbackMessageId,
      role: "agent",
    });
    expect(eventPayload(events[7])).toMatchObject({
      finalMessageId: fallbackMessageId,
      finalMessageText: "\npong\n",
    });
  });

  test("treats a different native thought as the final assistant message boundary", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "message-1",
      runId: "run-1",
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
    const progressMessageId = eventPayloadString(messageDeltas[0], "messageId");
    const finalMessageId = eventPayloadString(messageDeltas[1], "messageId");
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
      runId: "run-1",
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
    expect("resumePointer" in eventPayload(events[0])).toBe(false);
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

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["non-finite", Number.POSITIVE_INFINITY],
  ] as const)("drops wholly invalid %s usage without blocking Run completion", (_name, value) => {
    const state = new AcpTurnEventState();
    state.begin({ messageId: "message-1", runId: "run-1", sessionId: "session-1" });
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
    state.begin({ messageId: "message-1", runId: "run-1", sessionId: "session-1" });

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
