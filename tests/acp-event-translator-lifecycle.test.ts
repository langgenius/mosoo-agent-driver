import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  zAgentResponse,
  zPromptRequest,
  zSessionNotification,
} from "../node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverId } from "../src/protocol/id";
import type { EventId, RunId, SessionId } from "../src/protocol/id";
import { toRuntimeEventInput } from "../src/runtime-events";
import { AcpAssistantTranscriptState } from "../src/runtimes/acp/acp-assistant-transcript-state";
import { limitAcpInput } from "../src/runtimes/acp/acp-driver-backend";
import { toPermissionRequest } from "../src/runtimes/acp/acp-permission-events";
import { toPromptStartEvents } from "../src/runtimes/acp/acp-session-events";
import { DriverEventPublisher } from "../src/runtimes/driver-event-publisher";
import { CMA_MAX_EVENT_BYTES, encodeCmaSseRecord } from "../src/stores/cma-store";
import { createCmaMemoryStore } from "../src/stores/memory";
import {
  DRIVER_TEST_IDS,
  driverBootPayload,
  driverStartInput,
} from "./driver-boot-payload-fixture";

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
  test("bounds an official ACP JSON-RPC failure across every terminal event", async () => {
    const originalMessage = "x".repeat(1_100_000);
    const wire = `${JSON.stringify({
      error: { code: -32_603, message: originalMessage },
      id: 1,
      jsonrpc: "2.0",
    })}\n`;
    const decoded = JSON.parse(
      await new Response(limitAcpInput(new Blob([wire]).stream())).text(),
    ) as unknown;
    const response = zAgentResponse.parse(decoded);

    if (!("error" in response)) {
      throw new Error("Expected an official ACP error response.");
    }

    const requestError = new RequestError(
      response.error.code,
      response.error.message,
      response.error.data,
    );
    const state = new AcpAssistantTranscriptState();
    state.begin({
      messageId: "message-1",
      runId: DRIVER_TEST_IDS.runId,
    });
    state.translateUpdate({
      update: {
        content: { text: "partial", type: "text" },
        messageId: "native-message-1",
        sessionUpdate: "agent_message_chunk",
      },
    });
    state.translateUpdate({
      update: {
        content: { text: "thought", type: "text" },
        messageId: "native-message-1",
        sessionUpdate: "agent_thought_chunk",
      },
    });
    state.translateUpdate({
      update: {
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: "Run command",
        toolCallId: "tool-1",
      },
    });
    const events = state.failPrompt({ code: "acp.turn_failed", message: requestError.message });
    const terminal = events.at(-1)!;
    const closures = events.slice(0, -1);
    const store = createCmaMemoryStore({ sessions: [{ id: DRIVER_TEST_IDS.sessionId }] });
    const canonicalEvents: DriverEventInput[] = [];
    let cmaRecordCount = 0;
    const logger = createBufferedSinkLogger({
      level: "debug",
      service: "acp-terminal-boundary-test",
      sink: async () => {},
    });
    let sequence = 0;
    const context = createAgentDriverContext({
      eventSink: {
        currentRunId: () => DRIVER_TEST_IDS.runId,
        pushEvents: async ({ events: drafts }) => {
          const envelopes = drafts.flatMap((draft) =>
            toDriverEventEnvelopes(driverBootPayload, draft, DRIVER_TEST_IDS.runId),
          );

          for (const envelope of envelopes) {
            canonicalEvents.push(envelope.event);
            cmaRecordCount += (
              await store.appendDriverEvent(DRIVER_TEST_IDS.sessionId, envelope.event)
            ).length;
          }

          return {
            accepted: envelopes.map((envelope) => ({
              eventId: envelope.eventId,
              seq: ++sequence,
              type: envelope.event.kind,
            })),
          };
        },
      },
      logger,
      payload: driverStartInput,
      permission: { request: async () => "reject_once" },
    });

    try {
      await new DriverEventPublisher("acp-fallback", () => "native-session-1").pushTerminal(
        context,
        "driver.acp.prompt.failed",
        closures,
        terminal,
      );
    } finally {
      await logger.destroy();
    }

    const boundedMessage =
      "ACP failure exceeded durable event capacity (originalMessageUtf8Bytes=1100000).";
    const closureMessages = events.flatMap((event): string[] => {
      const payload = eventPayload(event);
      const error = payload["error"];

      if (typeof error === "string") {
        return [error];
      }
      if (typeof error === "object" && error !== null && "message" in error) {
        return [String(error.message)];
      }
      return typeof payload["reason"] === "string" ? [payload["reason"]] : [];
    });
    const runError = eventPayload(terminal)["error"] as Record<string, unknown>;

    expect(new Set(closureMessages)).toEqual(new Set([boundedMessage]));
    expect(runError["details"]).toEqual({ originalMessageUtf8Bytes: 1_100_000 });
    expect(canonicalEvents).toHaveLength(5);
    expect(cmaRecordCount).toBe(4);
    expect(canonicalEvents.map((event) => event.kind).at(-1)).toBe("run.failed");
    expect(
      canonicalEvents.every(
        (event) => Buffer.byteLength(JSON.stringify(event), "utf8") < CMA_MAX_EVENT_BYTES,
      ),
    ).toBe(true);
    expect(JSON.stringify(canonicalEvents)).not.toContain(originalMessage);
  });

  test("bounds official ACP prompt text before provider dispatch", async () => {
    const parseText = (text: string): string => {
      const prompt = zPromptRequest.parse({
        prompt: [{ text, type: "text" }],
        sessionId: "native-session-1",
      }).prompt[0];

      return prompt?.type === "text" ? prompt.text : "";
    };

    expect(() =>
      toPromptStartEvents({
        messageId: "message-1",
        runId: DRIVER_TEST_IDS.runId,
        text: parseText("x".repeat(1_100_000)),
      }),
    ).toThrow("ACP message.added event exceeds 524288 UTF-8 bytes");

    const events = toPromptStartEvents({
      messageId: "message-1",
      runId: DRIVER_TEST_IDS.runId,
      text: parseText("x".repeat(500_000)),
    });
    const store = createCmaMemoryStore({ sessions: [{ id: DRIVER_TEST_IDS.sessionId }] });

    for (const event of events) {
      for (const { event: envelope } of toDriverEventEnvelopes(
        driverBootPayload,
        event,
        DRIVER_TEST_IDS.runId,
      )) {
        await expect(
          store.appendDriverEvent(DRIVER_TEST_IDS.sessionId, envelope),
        ).resolves.toBeArray();
      }
    }
  });

  test("normalizes official ACP empty chunks and tool titles before canonical ingress", () => {
    const state = new AcpAssistantTranscriptState();
    state.begin({
      messageId: "message-1",
      runId: DRIVER_TEST_IDS.runId,
    });

    for (const sessionUpdate of ["agent_message_chunk", "agent_thought_chunk"] as const) {
      const notification = zSessionNotification.parse({
        sessionId: "native-session-1",
        update: { content: { text: "", type: "text" }, sessionUpdate },
      });
      expect(state.translateUpdate(notification)).toEqual([]);
    }

    const message = state.translateUpdate(
      zSessionNotification.parse({
        sessionId: "native-session-1",
        update: {
          content: { text: "ok", type: "text" },
          sessionUpdate: "agent_message_chunk",
        },
      }),
    );
    expect(eventKinds(message)).toEqual(["message.started", "message.delta"]);
    expect(message[1]?.sourceEventId).toBe(`acp:${DRIVER_TEST_IDS.runId}:agent-message:1`);

    for (const sessionUpdate of ["tool_call", "tool_call_update"] as const) {
      const notification = zSessionNotification.parse({
        sessionId: "native-session-1",
        update: {
          sessionUpdate,
          title: "",
          toolCallId: sessionUpdate,
          ...(sessionUpdate === "tool_call" ? { kind: "execute" } : {}),
        },
      });
      const events = state.translateUpdate(notification);
      const update = requireEvent(events, "tool.call.updated");

      expect(eventPayload(requireEvent(events, "item.started"))["title"]).toBe(
        sessionUpdate === "tool_call" ? "execute" : "tool",
      );
      expect(eventPayload(update)).not.toHaveProperty("title");
      expect(() =>
        toDriverEventEnvelopes(driverBootPayload, update, DRIVER_TEST_IDS.runId),
      ).not.toThrow();
    }
  });

  test("keeps native assistant messages separate across tools and projects only the final one", () => {
    const state = new AcpAssistantTranscriptState();

    state.begin({
      messageId: "prompt-message-1",
      runId: RUN_ID,
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
    expect(eventPayload(completed)).toEqual({ finalMessageId, stopReason: "end_turn" });
    expect(
      events.find(
        (event) =>
          event.kind === "message.added" && eventPayload(event)["messageId"] === finalMessageId,
      )?.payload,
    ).toMatchObject({ content: finalText });
  });

  test("materializes oversized final text as bounded lossless CMA events", async () => {
    const state = new AcpAssistantTranscriptState();
    const runId = createDriverId() as RunId;
    const sessionId = createDriverId() as SessionId;
    const text = `开始😀${'"\n\\'.repeat(400_000)}结束`;

    state.begin({ messageId: createDriverId(), runId });
    const streamed = state.translateUpdate({
      update: {
        content: { text, type: "text" },
        messageId: "native-final",
        sessionUpdate: "agent_message_chunk",
      },
    });
    const terminal = state.completePrompt("end_turn", null);
    const snapshots = terminal.filter(
      (event) => event.kind === "message.added" || event.kind === "message.delta",
    );
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const records = [];

    expect(Buffer.byteLength(JSON.stringify(streamed.at(-1)), "utf8")).toBeGreaterThan(
      CMA_MAX_EVENT_BYTES,
    );
    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots.every((event) => event.delivery === "lossless")).toBe(true);

    for (const event of terminal) {
      const [envelope] = toRuntimeEventInput(
        {
          createId: () => createDriverId() as EventId,
          occurredAt: "2026-08-13T00:00:00.000Z",
          runId,
          sessionId,
        },
        event,
      );
      records.push(...(await store.appendDriverEvent(sessionId, envelope!)));
    }

    expect(
      records.every((record) => encodeCmaSseRecord(record).byteLength < CMA_MAX_EVENT_BYTES),
    ).toBe(true);
    expect(
      records
        .flatMap(({ event }) => {
          if (
            !("sourceEventKind" in event) ||
            !["message.added", "message.delta"].includes(event.sourceEventKind) ||
            typeof event.message !== "object" ||
            event.message === null
          ) {
            return [];
          }

          const message = event.message as Record<string, unknown>;
          return [String(message["content"] ?? message["contentDelta"] ?? "")];
        })
        .join(""),
    ).toBe(text);
    expect(requireEvent(terminal, "run.completed").payload).not.toHaveProperty("finalMessageText");
  });

  test("uses a later identified final after anonymous progress, but fails closed for an anonymous final", () => {
    const state = new AcpAssistantTranscriptState();

    state.begin({
      messageId: "prompt-message-1",
      runId: RUN_ID,
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

    const finalMessageId = eventPayloadString(finalDelta, "messageId");
    expect(eventPayload(completed)).toEqual({ finalMessageId, stopReason: "end_turn" });
    expect(
      events.find(
        (event) =>
          event.kind === "message.added" && eventPayload(event)["messageId"] === finalMessageId,
      )?.payload,
    ).toMatchObject({ content: identifiedFinalText });

    const anonymousFinalState = new AcpAssistantTranscriptState();

    anonymousFinalState.begin({
      messageId: "prompt-message-2",
      runId: SECOND_RUN_ID,
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
    const state = new AcpAssistantTranscriptState();

    state.begin({
      messageId: "message-1",
      runId: RUN_ID,
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
      "message.added",
      "message.completed",
      "usage.updated",
      "run.completed",
    ]);
    expect(kinds.filter((kind) => kind === "item.started")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "item.completed")).toHaveLength(1);
    expect(kinds.every((kind) => kind.includes("."))).toBe(true);
  });

  test("projects an execute tool with a nonzero raw exit as failed", () => {
    const state = new AcpAssistantTranscriptState();
    state.begin({ messageId: "message-1", runId: RUN_ID });
    state.translateUpdate({
      update: {
        kind: "execute",
        sessionUpdate: "tool_call",
        status: "in_progress",
        toolCallId: "tool-1",
      },
    });

    const events = state.translateUpdate({
      update: {
        rawOutput: {
          metadata: { exit: 7, output: "stdoutstderr", truncated: false },
          output: "stdoutstderr",
        },
        sessionUpdate: "tool_call_update",
        status: "completed",
        toolCallId: "tool-1",
      },
    });

    expect(eventPayload(requireEvent(events, "tool.call.updated"))).toMatchObject({
      kind: "execute",
      status: "failed",
      toolCallId: "tool-1",
    });
    expect(eventPayload(requireEvent(events, "item.completed"))).toMatchObject({
      itemId: "tool-1",
      status: "failed",
    });
    expect(eventPayload(requireEvent(events, "item.completed"))).not.toHaveProperty("result");
  });

  test("deduplicates identical ACP tool content and fails closed on oversized output", () => {
    const state = new AcpAssistantTranscriptState();
    state.begin({ messageId: "message-1", runId: RUN_ID });
    state.translateUpdate({
      update: {
        kind: "execute",
        sessionUpdate: "tool_call",
        status: "in_progress",
        toolCallId: "tool-1",
      },
    });

    expect(() =>
      state.translateUpdate({
        update: {
          rawOutput: "x".repeat(600_000),
          sessionUpdate: "tool_call_update",
          status: "completed",
          toolCallId: "tool-1",
        },
      }),
    ).toThrow("ACP tool update exceeds 524288 UTF-8 bytes");

    const events = state.translateUpdate({
      update: {
        content: { text: "done", type: "text" },
        rawOutput: "done",
        sessionUpdate: "tool_call_update",
        status: "completed",
        toolCallId: "tool-1",
      },
    });
    const update = eventPayload(requireEvent(events, "tool.call.updated"));

    expect(update).toMatchObject({ content: "done", status: "completed" });
    expect(update).not.toHaveProperty("rawOutput");
    expect(eventPayload(requireEvent(events, "item.completed"))).not.toHaveProperty("result");
  });

  test("fails closed on an oversized permission tool payload", () => {
    const state = new AcpAssistantTranscriptState();
    state.begin({ messageId: "message-1", runId: RUN_ID });

    expect(() =>
      state.translatePermission({
        params: {
          options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
          toolCall: {
            rawInput: "x".repeat(600_000),
            status: "in_progress",
            toolCallId: "tool-1",
          },
        },
        requestId: "request-1",
      }),
    ).toThrow("ACP tool update exceeds 524288 UTF-8 bytes");

    expect(
      state
        .translatePermission({
          params: {
            options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
            toolCall: { status: "in_progress", toolCallId: "tool-1" },
          },
          requestId: "request-1",
        })
        .events.map((event) => event.kind),
    ).toEqual(["message.started", "item.started", "tool.call.updated"]);
  });

  test("keeps a nonzero execute exit across partial updates", () => {
    const state = new AcpAssistantTranscriptState();
    state.begin({ messageId: "message-1", runId: RUN_ID });
    state.translateUpdate({
      update: {
        kind: "execute",
        sessionUpdate: "tool_call",
        status: "in_progress",
        toolCallId: "tool-1",
      },
    });
    state.translateUpdate({
      update: {
        rawOutput: {
          metadata: { exit: 7, output: "stderr", truncated: false },
          output: "stderr",
        },
        sessionUpdate: "tool_call_update",
        status: "in_progress",
        toolCallId: "tool-1",
      },
    });

    const events = state.translateUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        status: "completed",
        toolCallId: "tool-1",
      },
    });

    expect(eventPayload(requireEvent(events, "tool.call.updated"))).toMatchObject({
      kind: "execute",
      status: "failed",
      toolCallId: "tool-1",
    });
    expect(eventPayload(requireEvent(events, "item.completed"))).toMatchObject({
      itemId: "tool-1",
      status: "failed",
    });
  });

  test("does not reset tool identity fields omitted by a partial update", () => {
    const state = new AcpAssistantTranscriptState();
    state.begin({ messageId: "message-1", runId: RUN_ID });

    const started = state.translateUpdate({
      update: {
        kind: "shell",
        name: "Bash",
        sessionUpdate: "tool_call",
        status: "running",
        title: "Run command",
        toolCallId: "tool-1",
      },
    });
    const patched = state.translateUpdate({
      update: {
        name: "Shell",
        rawOutput: { text: "done" },
        sessionUpdate: "tool_call_update",
        status: "completed",
        toolCallId: "tool-1",
      },
    });
    const initialPayload = eventPayload(requireEvent(started, "tool.call.updated"));
    const patchPayload = eventPayload(requireEvent(patched, "tool.call.updated"));

    expect(initialPayload).toMatchObject({ kind: "shell", name: "Bash", title: "Run command" });
    expect(patchPayload).toMatchObject({ kind: "shell", name: "Shell", title: "Run command" });
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
      const state = new AcpAssistantTranscriptState();
      state.begin({ messageId: "message-1", runId: RUN_ID });
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
      const state = new AcpAssistantTranscriptState();
      state.begin({ messageId: "message-1", runId: RUN_ID });
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
    const state = new AcpAssistantTranscriptState();
    state.begin({ messageId: "message-1", runId: RUN_ID });

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
    const state = new AcpAssistantTranscriptState();

    state.begin({
      messageId: "message-1",
      runId: DRIVER_TEST_IDS.runId,
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

  test("translates ACP permission metadata without duplicating host lifecycle events", () => {
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

    expect(translation.events.map((event) => event.kind)).toEqual(["tool.call.updated"]);
    expect(translation.request).toEqual({
      rawInput: '{"command":"pwd"}',
      requestId: "rpc-42",
      title: "Run command",
      toolCallId: "tool-1",
      toolKind: "shell",
    });
    expect(translation.options).toEqual([
      { kind: "allow_once", name: "Allow once", optionId: "allow" },
      { kind: "reject_once", name: "Reject once", optionId: "reject" },
    ]);
  });
});
