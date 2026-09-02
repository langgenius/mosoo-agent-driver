import { describe, expect, test } from "bun:test";

import { CmaInvalidEventError, CmaUnsupportedFieldError } from "../src/projections/cma";
import { projectCmaInboundToDriverCommand, projectDriverEventToCma } from "../src/projections/cma";
import { ingestRuntimeEventInput } from "../src/runtime-events";
import { createDriverId } from "../src/protocol/id";
import type { EventId, RunId, SessionId } from "../src/protocol/id";

describe("CMA projection", () => {
  test("rejects malformed Claude terminal and structured payload fields", () => {
    const context = {
      createId: () => createDriverId() as EventId,
      occurredAt: "2026-08-12T00:00:00.000Z",
      sessionId: createDriverId() as SessionId,
    } as const;

    for (const input of [
      { kind: "message.failed", payload: { messageId: "message-1" } },
      {
        kind: "message.failed",
        payload: { error: { code: "failed" }, messageId: "message-1" },
      },
      {
        kind: "message.added",
        payload: {
          content: [{ text: "message", type: "text" }],
          messageId: "message-1",
          preventContinuation: "yes",
        },
      },
      {
        kind: "message.added",
        payload: { content: "message", messageId: "message-1", phase: "final_answer" },
      },
      {
        kind: "message.added",
        payload: { content: "message", memoryCitation: Symbol("bad"), messageId: "message-1" },
      },
      {
        kind: "tool.call.updated",
        payload: { nonExecutionKind: 1, status: "failed", toolCallId: "tool-1" },
      },
      {
        kind: "tool.call.updated",
        payload: { status: "completed", structuredOutput: Symbol("bad"), toolCallId: "tool-1" },
      },
    ]) {
      expect(ingestRuntimeEventInput(context, input).status).toBe("rejected");
    }
  });

  test("admits message snapshot phase and memory citations", () => {
    const context = {
      createId: () => createDriverId() as EventId,
      occurredAt: "2026-08-12T00:00:00.000Z",
      sessionId: createDriverId() as SessionId,
    } as const;
    const memoryCitation = {
      entries: [{ lineEnd: 2, lineStart: 1, path: "MEMORY.md" }],
      threadIds: ["thread-1"],
    };
    const result = ingestRuntimeEventInput(context, {
      kind: "message.added",
      payload: { content: "answer", memoryCitation, messageId: "message-1", phase: "final" },
    });

    expect(result).toMatchObject({
      event: {
        payload: { content: "answer", memoryCitation, messageId: "message-1", phase: "final" },
      },
      status: "accepted",
    });
  });

  test("projects user messages to input.start commands", () => {
    expect(
      projectCmaInboundToDriverCommand({
        commandId: "command-1",
        requestId: "request-1",
        runId: "run-1",
        text: "hello",
        type: "user.message",
      }),
    ).toEqual({
      commandId: "command-1",
      input: {
        text: "hello",
      },
      kind: "input.start",
      requestId: "request-1",
      runId: "run-1",
    });
  });

  test("projects interrupts and permission confirmations to driver commands", () => {
    expect(
      projectCmaInboundToDriverCommand({
        commandId: "cancel-1",
        reason: "user",
        type: "user.interrupt",
      }),
    ).toEqual({
      commandId: "cancel-1",
      kind: "turn.cancel",
      reason: "user",
    });
    expect(
      projectCmaInboundToDriverCommand({
        commandId: "permission-1",
        decision: "allow_once",
        requestId: "request-1",
        type: "user.tool_confirmation",
      }),
    ).toEqual({
      commandId: "permission-1",
      decision: "allow_once",
      kind: "permission.resolve",
      requestId: "request-1",
    });
  });

  test("projects custom tool results to mcp.execute commands", () => {
    expect(
      projectCmaInboundToDriverCommand({
        argumentsJson: '{"ok":true}',
        commandId: "mcp-1",
        requestId: "request-1",
        serverId: "server-1",
        toolCallId: "tool-1",
        toolName: "complete",
        type: "user.custom_tool_result",
      }),
    ).toEqual({
      argumentsJson: '{"ok":true}',
      commandId: "mcp-1",
      kind: "mcp.execute",
      requestId: "request-1",
      serverId: "server-1",
      toolCallId: "tool-1",
      toolName: "complete",
    });
  });

  test("rejects unsupported attachments instead of silently dropping them", () => {
    expect(() =>
      projectCmaInboundToDriverCommand({
        attachmentIds: ["file-1"],
        commandId: "command-1",
        requestId: "request-1",
        runId: "run-1",
        text: "hello",
        type: "user.message",
      }),
    ).toThrow(CmaUnsupportedFieldError);
  });

  test.each([
    [null, "must be an object"],
    [{ type: "unknown" }, "Unsupported CMA event type"],
    [{ type: "user.message" }, "commandId"],
    [
      {
        commandId: "command-1",
        decision: "always",
        requestId: "request-1",
        type: "user.tool_confirmation",
      },
      "decision",
    ],
  ])("classifies malformed inbound events as request errors", (input, message) => {
    expect(() => projectCmaInboundToDriverCommand(input)).toThrow(CmaInvalidEventError);
    expect(() => projectCmaInboundToDriverCommand(input)).toThrow(message);
  });

  test("projects permission requests to requires_action idle status", () => {
    expect(
      projectDriverEventToCma({
        kind: "permission.requested",
        payload: {
          agentId: "subagent-1",
          blockedPath: "/workspace/secret",
          decisionReason: "Path is outside the allowed roots.",
          details: '{"command":"vp test"}',
          description: "Read access to /workspace/secret",
          matchedAskRule: {
            ruleContent: "Read(/workspace/secret/**)",
            source: "project",
            toolName: "Read",
          },
          requestId: "permission-1",
          targetItemId: "tool-1",
          title: "Approve command",
          toolCall: {
            kind: "shell",
            toolCallId: "tool-1",
          },
        },
      }),
    ).toEqual([
      {
        requiresAction: {
          agentId: "subagent-1",
          blockedPath: "/workspace/secret",
          decisionReason: "Path is outside the allowed roots.",
          details: '{"command":"vp test"}',
          description: "Read access to /workspace/secret",
          matchedAskRule: {
            ruleContent: "Read(/workspace/secret/**)",
            source: "project",
            toolName: "Read",
          },
          requestId: "permission-1",
          targetItemId: "tool-1",
          title: "Approve command",
          toolCall: {
            kind: "shell",
            toolCallId: "tool-1",
          },
        },
        sessionStatus: "idle",
        sourceEventKind: "permission.requested",
        type: "session.status_idle",
      },
    ]);
    expect(
      projectDriverEventToCma({
        kind: "run.waiting",
        payload: { status: "waiting_input" },
      }),
    ).toMatchObject([
      {
        sessionStatus: "idle",
        type: "session.status_idle",
      },
    ]);
    expect(
      projectDriverEventToCma({
        kind: "diagnostic.reported",
        payload: { message: "private" },
      }),
    ).toEqual([]);
  });

  test("projects structured final output without flattening it into text", () => {
    const runId = createDriverId() as RunId;
    const context = {
      createId: () => createDriverId() as EventId,
      occurredAt: "2026-08-13T00:00:00.000Z",
      runId,
      sessionId: createDriverId() as SessionId,
    } as const;
    const event = {
      kind: "run.completed" as const,
      payload: {
        stopReason: "end_turn",
        structuredOutput: { answer: 42, citations: ["source-1"] },
      },
      runId,
    };

    expect(ingestRuntimeEventInput(context, event).status).toBe("accepted");
    expect(
      ingestRuntimeEventInput(context, {
        ...event,
        payload: { ...event.payload, structuredOutput: Symbol("invalid") },
      }).status,
    ).toBe("rejected");
    expect(projectDriverEventToCma(event)).toEqual([
      {
        metadata: {
          stopReason: "end_turn",
          structuredOutput: { answer: 42, citations: ["source-1"] },
        },
        sessionStatus: "idle",
        sourceEventKind: "run.completed",
        type: "session.status_idle",
      },
    ]);
  });

  test("projects driver event families to CMA outbound events", () => {
    expect(
      projectDriverEventToCma({
        kind: "message.delta",
        payload: {
          contentDelta: "hi",
          messageId: "message-1",
        },
      }),
    ).toMatchObject([
      {
        sourceEventKind: "message.delta",
        type: "agent.message",
      },
    ]);
    expect(
      projectDriverEventToCma({
        kind: "message.failed",
        payload: { error: { code: "provider.failed" }, messageId: "message-1" },
      }),
    ).toMatchObject([
      {
        message: { error: { code: "provider.failed" }, messageId: "message-1" },
        sourceEventKind: "message.failed",
        type: "agent.message",
      },
    ]);
    expect(
      projectDriverEventToCma({
        kind: "tool.call.updated",
        payload: {
          status: "completed",
          structuredOutput: {
            usage: { output_tokens_details: { thinking_tokens: 3 } },
          },
          toolCallId: "tool-1",
        },
      }),
    ).toMatchObject([
      {
        message: {
          structuredOutput: {
            usage: { output_tokens_details: { thinking_tokens: 3 } },
          },
        },
        type: "agent.tool_use",
      },
    ]);
    expect(
      projectDriverEventToCma({
        kind: "run.failed",
        payload: {
          error: {
            code: "driver.failed",
            details: { apiErrorStatus: 529, terminalReason: "api_error" },
            message: "failed",
          },
        },
      }),
    ).toMatchObject([
      {
        error: expect.objectContaining({
          error: expect.objectContaining({
            details: { apiErrorStatus: 529, terminalReason: "api_error" },
          }),
        }),
        sessionStatus: "terminated",
        sourceEventKind: "run.failed",
        type: "session.error",
      },
    ]);
    expect(
      projectDriverEventToCma({
        kind: "usage.updated",
        payload: {
          cachedWriteTokens: 3,
          inputTokens: 1,
          outputTokens: 2,
        },
      }),
    ).toMatchObject([
      {
        sourceEventKind: "usage.updated",
        type: "session.usage",
        usage: {
          cachedWriteTokens: 3,
          inputTokens: 1,
          outputTokens: 2,
        },
      },
    ]);
  });

  test.each([
    [true, "rescheduling", "session.status_rescheduling"],
    [false, "terminated", "session.error"],
  ] as const)("maps recoverable=%s run failures to %s", (recoverable, sessionStatus, type) => {
    expect(
      projectDriverEventToCma({
        kind: "run.failed",
        payload: {
          error: {
            code: "driver.failed",
            message: "failed",
          },
          recoverable,
        },
      }),
    ).toMatchObject([
      {
        sessionStatus,
        sourceEventKind: "run.failed",
        type,
      },
    ]);
  });
});
