import { describe, expect, test } from "bun:test";

import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import {
  AcpTurnEventState,
  toPermissionRequest,
  toPermissionResolvedEvent,
} from "../src/runtimes/acp/acp-event-translator";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

const RUN_ID = "run-1" as RunId;
const SECOND_RUN_ID = "run-2" as RunId;

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
      runId: RUN_ID,
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
    const progressOneId = eventPayloadString(progressOneEvent!, "messageId");
    const progressTwoId = eventPayloadString(progressTwoEvent!, "messageId");
    const finalMessageId = eventPayloadString(finalChunkOneEvent!, "messageId");

    expect([...new Set([progressOneId, progressTwoId, finalMessageId])]).toHaveLength(3);
    expect(eventPayloadString(finalChunkTwoEvent!, "messageId")).toBe(finalMessageId);
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

  test("uses a later identified final and preserves anonymous message boundaries", () => {
    const state = new AcpTurnEventState();

    state.begin({
      messageId: "prompt-message-1",
      runId: RUN_ID,
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
      runId: SECOND_RUN_ID,
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
    const anonymousCompleted = requireEvent(anonymousFinalEvents, "run.completed");
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
    expect(eventPayload(anonymousCompleted)).toMatchObject({
      stopReason: "end_turn",
    });
  });

  test("maps ACP turn updates onto canonical runtime events with one tool lifecycle", () => {
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
    state.begin({ messageId: "message-1", runId: RUN_ID, sessionId: "session-1" });

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
  ] as const)(
    "keeps a terminal tool completed while merging a later %s patch",
    (_name, patch, expected) => {
      const state = new AcpTurnEventState();
      state.begin({ messageId: "message-1", runId: RUN_ID, sessionId: "session-1" });
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
    },
  );

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
      state.begin({ messageId: "message-1", runId: RUN_ID, sessionId: "session-1" });
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
    state.begin({ messageId: "message-1", runId: RUN_ID, sessionId: "session-1" });

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
      runId: RUN_ID,
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
      runId: RUN_ID,
    });

    expect(resolved.kind).toBe("permission.resolved");
    expect(eventPayload(resolved)).toMatchObject({
      optionId: "allow",
      optionKind: "allow_once",
      outcome: "selected",
      requestId: "rpc-42",
    });
  });
});
