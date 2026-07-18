import { describe, expect, test } from "bun:test";

import { CmaInvalidEventError, CmaUnsupportedFieldError } from "../src/projections/cma";
import { projectCmaInboundToDriverCommand, projectDriverEventToCma } from "../src/projections/cma";

describe("CMA projection", () => {
  test("projects user messages to input.start commands", () => {
    expect(
      projectCmaInboundToDriverCommand({
        attachmentIds: ["file-1"],
        commandId: "command-1",
        requestId: "request-1",
        runId: "run-1",
        text: "hello",
        type: "user.message",
      }),
    ).toEqual({
      commandId: "command-1",
      input: {
        attachmentIds: ["file-1"],
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
        toolName: "complete",
        type: "user.custom_tool_result",
      }),
    ).toEqual({
      argumentsJson: '{"ok":true}',
      commandId: "mcp-1",
      kind: "mcp.execute",
      requestId: "request-1",
      serverId: "server-1",
      toolName: "complete",
    });
  });

  test("rejects unsupported inbound fields instead of silently dropping them", () => {
    expect(() =>
      projectCmaInboundToDriverCommand({
        commandId: "command-1",
        metadata: {
          unsupported: true,
        },
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
          details: '{"command":"vp test"}',
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
          details: '{"command":"vp test"}',
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
        kind: "run.failed",
        payload: {
          error: {
            code: "driver.failed",
            message: "failed",
          },
        },
      }),
    ).toMatchObject([
      {
        sessionStatus: "terminated",
        sourceEventKind: "run.failed",
        type: "session.error",
      },
    ]);
    expect(
      projectDriverEventToCma({
        kind: "usage.updated",
        payload: {
          inputTokens: 1,
          outputTokens: 2,
        },
      }),
    ).toMatchObject([
      {
        sourceEventKind: "usage.updated",
        type: "session.usage",
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
