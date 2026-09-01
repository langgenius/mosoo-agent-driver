import { describe, expect, test } from "bun:test";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { RunId } from "../src/protocol/id";
import {
  createClaudeAgentSdkHarness as createHarness,
  isRecord,
  messageText,
} from "./claude-agent-sdk-test-helpers";

describe("Claude Agent SDK provider fixtures", () => {
  test("projects visible task activity without leaking task internals", async () => {
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        description: "Inspect the repository",
        is_backgrounded: true,
        prompt: "private task prompt",
        session_id: "native-session-1",
        subtype: "task_started",
        task_id: "task-1",
        task_type: "local_agent",
        tool_use_id: "tool-1",
        type: "system",
        uuid: "task-started-1",
      },
      {
        description: "Inspecting tests",
        last_tool_name: "Read",
        session_id: "native-session-1",
        subtype: "task_progress",
        summary: "private progress summary",
        task_id: "task-1",
        tool_use_id: "tool-1",
        type: "system",
        usage: { duration_ms: 10, tool_uses: 1, total_tokens: 50 },
        uuid: "task-progress-1",
      },
      {
        patch: { description: "Finalizing", error: "private task error", status: "running" },
        session_id: "native-session-1",
        subtype: "task_updated",
        task_id: "task-1",
        type: "system",
        uuid: "task-updated-1",
      },
      {
        elapsed_time_seconds: 5,
        heartbeat: true,
        parent_tool_use_id: null,
        session_id: "native-session-1",
        tool_name: "Agent",
        tool_use_id: "tool-1",
        type: "tool_progress",
        uuid: "tool-heartbeat-1",
      },
      {
        output_file: "/tmp/private-task-output",
        resource_links: [
          {
            mimeType: "application/pdf",
            name: "report.pdf",
            uri: "file:///workspace/report.pdf",
          },
        ],
        session_id: "native-session-1",
        status: "completed",
        subtype: "task_notification",
        summary: "private terminal summary",
        task_id: "task-1",
        tool_use_id: "tool-1",
        type: "system",
        usage: { duration_ms: 25, tool_uses: 2, total_tokens: 100 },
        uuid: "task-notification-1",
      },
      {
        session_id: "native-session-1",
        subtype: "background_tasks_changed",
        tasks: [
          {
            description: "Inspect the repository",
            task_id: "task-1",
            task_type: "local_agent",
          },
          {
            ambient: true,
            description: "private ambient task",
            task_id: "ambient-task",
            task_type: "local_agent",
          },
        ],
        type: "system",
        uuid: "background-tasks-1",
      },
      {
        session_id: "native-session-1",
        subtype: "background_tasks_changed",
        tasks: [],
        type: "system",
        uuid: "background-tasks-2",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    const taskEvents = events().filter((event) => event.kind === "agent.tasks.replaced");
    expect(taskEvents).toHaveLength(2);
    expect(taskEvents.at(0)).toMatchObject({
      delivery: "lossless",
      payload: {
        tasks: [
          {
            taskId: "task-1",
            taskType: "local_agent",
            title: "Inspect the repository",
          },
        ],
      },
      visibility: "participant",
    });
    expect(taskEvents.at(1)).toEqual({
      delivery: "lossless",
      kind: "agent.tasks.replaced",
      payload: { tasks: [] },
      visibility: "participant",
    });
    expect(JSON.stringify(taskEvents)).not.toContain("private");
    expect(events().filter((event) => event.kind === "diagnostic.reported")).toHaveLength(4);
    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "tool.call.updated",
        payload: expect.objectContaining({
          status: "completed",
          structuredOutput: {
            resourceLinks: [
              {
                mimeType: "application/pdf",
                name: "report.pdf",
                uri: "file:///workspace/report.pdf",
              },
            ],
          },
          toolCallId: "tool-1",
        }),
      }),
    );
  });

  test("closes visible tasks before the run terminal and resets them between turns", async () => {
    const { context, events, translator } = createHarness();

    await translator.handleSdkMessage(
      context,
      {
        session_id: "native-session-1",
        subtype: "background_tasks_changed",
        tasks: [
          {
            description: "Inspect the repository",
            task_id: "task-1",
            task_type: "local_agent",
          },
        ],
        type: "system",
        uuid: "background-tasks-1",
      } as unknown as SDKMessage,
      "run-1" as RunId,
    );
    await translator.handleSdkMessage(
      context,
      {
        result: "",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      } as unknown as SDKMessage,
      "run-1" as RunId,
    );

    const terminalIndex = events().findIndex((event) => event.kind === "run.completed");
    expect(terminalIndex).toBeGreaterThan(0);
    expect(events().slice(0, terminalIndex)).toContainEqual({
      delivery: "lossless",
      kind: "agent.tasks.replaced",
      payload: { tasks: [] },
      visibility: "participant",
    });

    const beforeReset = events().length;
    translator.resetTurnMessageState();
    await translator.handleSdkMessage(
      context,
      {
        session_id: "native-session-1",
        subtype: "background_tasks_changed",
        tasks: [
          {
            description: "Inspect the repository again",
            task_id: "task-1",
            task_type: "local_agent",
          },
        ],
        type: "system",
        uuid: "background-tasks-2",
      } as unknown as SDKMessage,
      "run-2" as RunId,
    );
    expect(events().slice(beforeReset)).toContainEqual({
      delivery: "lossless",
      kind: "agent.tasks.replaced",
      payload: {
        tasks: [
          {
            taskId: "task-1",
            taskType: "local_agent",
            title: "Inspect the repository again",
          },
        ],
      },
      visibility: "participant",
    });
  });

  test("preserves the prior task snapshot when the visible-task bound is exceeded", async () => {
    const { context, events, translator } = createHarness();
    const message = (tasks: Array<{ description: string; task_id: string; task_type: string }>) =>
      ({
        session_id: "native-session-1",
        subtype: "background_tasks_changed",
        tasks,
        type: "system",
        uuid: `background-tasks-${String(tasks.length)}`,
      }) as unknown as SDKMessage;

    await translator.handleSdkMessage(
      context,
      message([{ description: "Inspect", task_id: "task-1", task_type: "local_agent" }]),
      "run-1" as RunId,
    );
    await translator.handleSdkMessage(
      context,
      message(
        Array.from({ length: 257 }, (_, index) => ({
          description: "Inspect",
          task_id: `task-${String(index)}`,
          task_type: "local_agent",
        })),
      ),
      "run-1" as RunId,
    );

    expect(events().filter((event) => event.kind === "agent.tasks.replaced")).toMatchObject([
      { payload: { tasks: [{ taskId: "task-1" }] } },
    ]);
    expect(events().filter((event) => event.kind === "diagnostic.reported")).toMatchObject([
      { payload: { code: "claude.visible_background_tasks_too_many" } },
    ]);
  });

  test("projects informational, local command, mirror failure, and conversation reset frames", async () => {
    const { events, handleMessages, nativeSessionResets } = createHarness();
    const messages = [
      {
        content: "A stop hook blocked continuation.",
        level: "warning",
        prevent_continuation: true,
        session_id: "native-session-1",
        subtype: "informational",
        tool_use_id: "tool-1",
        type: "system",
        uuid: "informational-1",
      },
      {
        error: "Transcript mirror write failed.",
        key: {
          projectKey: "project-1",
          sessionId: "native-session-1",
          subpath: "events.jsonl",
        },
        session_id: "native-session-1",
        subtype: "mirror_error",
        type: "system",
        uuid: "mirror-1",
      },
      {
        new_conversation_id: "native-session-2",
        session_id: "native-session-1",
        type: "conversation_reset",
        uuid: "reset-1",
      },
      {
        content: "Local command output.",
        session_id: "native-session-2",
        subtype: "local_command_output",
        type: "system",
        uuid: "local-command-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "message.added",
        payload: expect.objectContaining({
          content: [{ text: "A stop hook blocked continuation.", type: "text" }],
          level: "warning",
          preventContinuation: true,
          subtype: "informational",
          toolCallId: "tool-1",
        }),
      }),
    );
    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "message.added",
        payload: expect.objectContaining({
          content: [{ text: "Local command output.", type: "text" }],
          subtype: "local_command_output",
        }),
      }),
    );
    expect(events()).toContainEqual(
      expect.objectContaining({
        delivery: "best_effort",
        kind: "diagnostic.reported",
        payload: expect.objectContaining({
          message: "Claude transcript mirror write failed.",
          raw: {
            errorBytes: 31,
            kind: "claude.mirror_error",
          },
          severity: "error",
        }),
      }),
    );
    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "session.info.updated",
        payload: expect.objectContaining({ title: null }),
      }),
    );
    expect(nativeSessionResets).toEqual([["native-session-1", "native-session-2"]]);
  });

  test("cancels a truncated assistant frame", async () => {
    const { context, events, translator } = createHarness();

    await translator.handleSdkMessage(
      context,
      {
        aborted: true,
        message: { content: [{ text: "partial", type: "text" }] },
        type: "assistant",
        uuid: "assistant-aborted",
      } as unknown as SDKMessage,
      "run-1" as RunId,
    );

    const transcript = events();
    expect(transcript).toContainEqual(
      expect.objectContaining({
        kind: "message.added",
        payload: expect.objectContaining({ content: [{ text: "partial", type: "text" }] }),
      }),
    );
    expect(transcript.findIndex(({ kind }) => kind === "message.added")).toBeLessThan(
      transcript.findIndex(({ kind }) => kind === "message.cancelled"),
    );
    expect(transcript.map(({ kind }) => kind)).not.toContain("message.completed");
  });

  test("fails an assistant frame carrying an SDK error", async () => {
    const { context, events, translator } = createHarness();

    await translator.handleSdkMessage(
      context,
      {
        error: "rate_limit",
        message: { content: [] },
        type: "assistant",
        uuid: "assistant-error",
      } as unknown as SDKMessage,
      "run-1" as RunId,
    );

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "message.failed",
        payload: expect.objectContaining({
          error: expect.objectContaining({ code: "claude.rate_limit", retryable: true }),
        }),
      }),
    );
    expect(events().findIndex(({ kind }) => kind === "message.started")).toBeLessThan(
      events().findIndex(({ kind }) => kind === "message.failed"),
    );
    expect(events().map(({ kind }) => kind)).not.toContain("message.completed");
  });

  test("fails a terminating API error carried by a success result", async () => {
    const { context, events, translator } = createHarness();

    await translator.handleSdkMessage(
      context,
      {
        api_error_status: 529,
        is_error: true,
        modelUsage: {},
        permission_denials: [],
        result: "API Error: 529",
        session_id: "native-session-1",
        stop_reason: null,
        subtype: "success",
        terminal_reason: "api_error",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-api-error",
      } as unknown as SDKMessage,
      "run-1" as RunId,
    );

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "run.failed",
        payload: expect.objectContaining({
          error: expect.objectContaining({
            details: { apiErrorStatus: 529, terminalReason: "api_error" },
            retryable: true,
          }),
          recoverable: true,
        }),
      }),
    );
    expect(events().map(({ kind }) => kind)).not.toContain("run.completed");
  });

  test("marks an SDK tool error as failed", async () => {
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        message: {
          content: [{ id: "tool-1", input: { command: "false" }, name: "Bash", type: "tool_use" }],
        },
        type: "assistant",
        uuid: "assistant-1",
      },
      {
        message: {
          content: [
            {
              content: "Command failed",
              is_error: true,
              tool_use_id: "tool-1",
              type: "tool_result",
            },
          ],
        },
        type: "user",
        uuid: "user-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "tool.call.updated",
        payload: expect.objectContaining({ status: "failed", toolCallId: "tool-1" }),
      }),
    );
  });

  test("classifies wrapper-level tool non-execution metadata", async () => {
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        message: {
          content: [{ id: "tool-1", input: {}, name: "Bash", type: "tool_use" }],
        },
        type: "assistant",
        uuid: "assistant-1",
      },
      {
        message: {
          content: [
            {
              content: "Request interrupted",
              is_error: true,
              tool_use_id: "tool-1",
              type: "tool_result",
            },
          ],
        },
        tool_result_meta: [
          {
            id: "tool-1",
            non_execution_kind: "interrupted",
            user_feedback: "Stop here",
          },
        ],
        tool_use_result: {
          resourceLinks: [
            {
              mimeType: "application/pdf",
              name: "report.pdf",
              uri: "file:///workspace/report.pdf",
            },
          ],
          usage: { output_tokens_details: { thinking_tokens: 3 } },
        },
        type: "user",
        uuid: "user-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "tool.call.updated",
        payload: expect.objectContaining({
          nonExecutionKind: "interrupted",
          status: "cancelled",
          structuredOutput: {
            resourceLinks: [
              {
                mimeType: "application/pdf",
                name: "report.pdf",
                uri: "file:///workspace/report.pdf",
              },
            ],
            usage: { output_tokens_details: { thinking_tokens: 3 } },
          },
          toolCallId: "tool-1",
          userFeedback: "Stop here",
        }),
      }),
    );
  });

  test("materializes authoritative result permission denials without a tool result", async () => {
    const { context, events, translator } = createHarness();
    const nativeAgentId = `agent-${"a".repeat(300)}`;

    await translator.handleSdkMessage(
      context,
      {
        agent_id: nativeAgentId,
        decision_reason: "Blocked by policy X",
        decision_reason_type: "rule",
        message: "Denied by policy X",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "tool-denied",
        type: "system",
        uuid: "denial-advisory",
      } as unknown as SDKMessage,
      "run-1" as RunId,
    );
    await translator.handleSdkMessage(
      context,
      {
        is_error: false,
        modelUsage: {},
        permission_denials: [
          { tool_input: { command: "pwd" }, tool_name: "Bash", tool_use_id: "tool-denied" },
        ],
        result: "done",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      } as unknown as SDKMessage,
      "run-1" as RunId,
    );

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "tool.call.updated",
        payload: expect.objectContaining({
          rawInput: '{"command":"pwd"}',
          content: "Denied by policy X",
          decisionReason: "Blocked by policy X",
          decisionReasonType: "rule",
          status: "failed",
          title: "Bash",
          toolCallId: "tool-denied",
        }),
      }),
    );
    const denial = events().findLast(
      (event) =>
        event.kind === "tool.call.updated" &&
        isRecord(event.payload) &&
        event.payload["toolCallId"] === "tool-denied",
    );
    const agentId =
      denial !== undefined && isRecord(denial.payload) ? denial.payload["agentId"] : null;
    expect(agentId).toMatch(/^rid1_[A-Za-z0-9_-]{43}$/);
    expect(agentId).not.toBe(nativeAgentId);
    expect(events().filter(({ kind }) => kind === "item.started")).toHaveLength(1);
    expect(events().filter(({ kind }) => kind === "item.completed")).toHaveLength(1);
  });

  test("lets result permission denials override earlier tool terminals", async () => {
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        message: {
          content: [
            { id: "tool-completed", input: {}, name: "Read", type: "tool_use" },
            { id: "tool-cancelled", input: {}, name: "Bash", type: "tool_use" },
          ],
        },
        type: "assistant",
        uuid: "assistant-1",
      },
      {
        message: {
          content: [
            { content: "ok", tool_use_id: "tool-completed", type: "tool_result" },
            {
              content: "interrupted",
              is_error: true,
              tool_use_id: "tool-cancelled",
              type: "tool_result",
            },
          ],
        },
        tool_result_meta: [{ id: "tool-cancelled", non_execution_kind: "cancelled" }],
        type: "user",
        uuid: "user-1",
      },
      {
        is_error: false,
        modelUsage: {},
        permission_denials: [
          { tool_input: {}, tool_name: "Read", tool_use_id: "tool-completed" },
          { tool_input: {}, tool_name: "Bash", tool_use_id: "tool-cancelled" },
        ],
        result: "done",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    for (const toolCallId of ["tool-completed", "tool-cancelled"]) {
      const statuses = events().flatMap((event) => {
        if (event.kind !== "tool.call.updated" || !isRecord(event.payload)) {
          return [];
        }
        return event.payload["toolCallId"] === toolCallId &&
          typeof event.payload["status"] === "string"
          ? [event.payload["status"]]
          : [];
      });
      expect(statuses.at(-1)).toBe("failed");
      expect(
        events().filter(
          (event) =>
            event.kind === "item.completed" &&
            isRecord(event.payload) &&
            event.payload["itemId"] === toolCallId,
        ),
      ).toHaveLength(1);
    }
  });

  test("rotates assistant identity across a tool boundary and marks the final message", async () => {
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        message: {
          content: [
            { text: "进度：准备工具。", type: "text" },
            { id: "tool-1", input: { command: "pwd" }, name: "Bash", type: "tool_use" },
          ],
        },
        type: "assistant",
        uuid: "assistant-progress",
      },
      {
        message: {
          content: [
            {
              content: [{ text: "/workspace", type: "text" }],
              tool_use_id: "tool-1",
              type: "tool_result",
            },
          ],
        },
        type: "user",
        uuid: "tool-result",
      },
      {
        message: {
          content: [{ text: "最终：中文 Markdown ✅", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-final",
      },
      {
        result: "最终：中文 Markdown ✅",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    const textMessages = events().flatMap((event) => {
      if (event.kind !== "message.delta" || !isRecord(event.payload)) {
        return [];
      }

      const contentDelta = event.payload["contentDelta"];
      const messageId = event.payload["messageId"];
      return typeof contentDelta === "string" && typeof messageId === "string"
        ? [{ contentDelta, messageId }]
        : [];
    });
    const runCompleted = events().find((event) => event.kind === "run.completed");
    const runCompletedPayload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(textMessages.map((entry) => entry.contentDelta)).toEqual([
      "进度：准备工具。",
      "最终：中文 Markdown ✅",
    ]);
    expect(new Set(textMessages.map((entry) => entry.messageId)).size).toBe(2);
    expect(runCompletedPayload?.["finalMessageId"]).toBe(textMessages.at(-1)?.messageId);
  });

  test("uses the complete assistant message to repair an incomplete stream snapshot", async () => {
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        event: {
          delta: { text: "残缺流", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-final",
      },
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "assistant-final",
      },
      {
        event: {
          delta: { text: "迟到流", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-final",
      },
      {
        message: {
          content: [{ text: "完整最终回答", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-final",
      },
      {
        result: "完整最终回答",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    const runCompleted = events().find((event) => event.kind === "run.completed");
    const payload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;
    const snapshot = events().find(
      (event) => event.kind === "message.added" && isRecord(event.payload),
    );
    const translated = events();
    const snapshotIndex = translated.indexOf(snapshot!);
    const completedIndex = translated.findIndex((event) => event.kind === "message.completed");
    const terminalIndex = translated.findIndex((event) => event.kind === "run.completed");

    expect(payload).not.toHaveProperty("finalMessageText");
    expect(messageText(events(), payload?.["finalMessageId"])).toBe("完整最终回答");
    expect(snapshot).toMatchObject({
      kind: "message.added",
      payload: {
        content: [{ text: "完整最终回答", type: "text" }],
        role: "agent",
      },
    });
    expect(
      translated
        .filter((event) => event.kind === "message.delta" && isRecord(event.payload))
        .map((event) => (event.payload as Record<string, unknown>)["contentDelta"]),
    ).toEqual(["残缺流"]);
    expect(snapshotIndex).toBeLessThan(completedIndex);
    expect(completedIndex).toBeLessThan(terminalIndex);
  });

  test("drops thought and tool updates after their terminal events", async () => {
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        event: {
          content_block: { thinking: "", type: "thinking" },
          index: 0,
          type: "content_block_start",
        },
        type: "stream_event",
        uuid: "assistant-thought",
      },
      {
        event: {
          delta: { thinking: "before", type: "thinking_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-thought",
      },
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "assistant-thought",
      },
      {
        event: {
          delta: { thinking: "after", type: "thinking_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-thought",
      },
      {
        message: {
          content: [{ text: "done", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-thought",
      },
      {
        event: {
          content_block: { id: "tool-1", input: {}, name: "Read", type: "tool_use" },
          index: 0,
          type: "content_block_start",
        },
        type: "stream_event",
        uuid: "assistant-tool",
      },
      {
        message: {
          content: [
            {
              content: "ok",
              tool_use_id: "tool-1",
              type: "tool_result",
            },
          ],
        },
        type: "user",
        uuid: "user-tool",
      },
      {
        event: {
          delta: { partial_json: '{"late":true}', type: "input_json_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-tool",
      },
      {
        result: "done",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    const translated = events();
    const thoughtCompletedIndex = translated.findIndex(
      (event) => event.kind === "thought.completed",
    );
    const thoughtDeltas = translated
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.kind === "thought.delta");
    expect(thoughtDeltas).toHaveLength(1);
    expect(thoughtDeltas[0]!.index).toBeLessThan(thoughtCompletedIndex);
    const toolUpdates = translated.filter(
      (event) =>
        event.kind === "tool.call.updated" &&
        isRecord(event.payload) &&
        event.payload["toolCallId"] === "tool-1",
    );
    const toolCompletedIndex = toolUpdates.findIndex(
      (event) => (event.payload as Record<string, unknown>)["status"] === "completed",
    );
    expect(toolCompletedIndex).toBeGreaterThan(0);
    expect(toolCompletedIndex).toBe(toolUpdates.length - 1);
    expect(JSON.stringify(toolUpdates)).not.toContain('{"late":true}');
  });

  test("ignores streamed text arriving after its assistant message completed", async () => {
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        message: {
          content: [{ text: "complete", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-final",
      },
      {
        event: {
          delta: { text: "-late", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-final",
      },
      {
        result: "complete",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    const translated = events();
    const completed = translated.find((event) => event.kind === "message.completed");
    const messageId =
      completed !== undefined && isRecord(completed.payload)
        ? completed.payload["messageId"]
        : undefined;
    const completedIndex = translated.indexOf(completed!);
    expect(typeof messageId).toBe("string");
    expect(
      translated
        .slice(completedIndex + 1)
        .filter(
          (event) =>
            event.kind === "message.delta" &&
            isRecord(event.payload) &&
            event.payload["messageId"] === messageId,
        ),
    ).toEqual([]);
    const terminal = translated.find((event) => event.kind === "run.completed");
    expect(terminal?.payload).not.toHaveProperty("finalMessageText");
    expect(
      messageText(
        translated,
        isRecord(terminal?.payload) ? terminal.payload["finalMessageId"] : null,
      ),
    ).toBe("complete");
  });

  test("repairs streamed tool input with a lossless assistant snapshot", async () => {
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        event: {
          content_block: { id: "tool-1", input: {}, name: "Read", type: "tool_use" },
          index: 0,
          type: "content_block_start",
        },
        type: "stream_event",
        uuid: "assistant-1",
      },
      {
        event: {
          delta: { partial_json: '{"path":"partial', type: "input_json_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-1",
      },
      {
        message: {
          content: [{ id: "tool-1", input: { path: "complete" }, name: "Read", type: "tool_use" }],
        },
        type: "assistant",
        uuid: "assistant-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    expect(
      events().filter(
        (event) =>
          event.kind === "tool.call.updated" &&
          event.delivery === "best_effort" &&
          isRecord(event.payload) &&
          event.payload["toolCallId"] === "tool-1",
      ),
    ).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ rawInputDelta: '{"path":"partial' }),
      }),
    );
    expect(events()).not.toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ rawInput: "{}", toolCallId: "tool-1" }),
      }),
    );
    expect(
      events().filter(
        (event) =>
          event.kind === "tool.call.updated" &&
          event.delivery !== "best_effort" &&
          isRecord(event.payload) &&
          event.payload["toolCallId"] === "tool-1",
      ),
    ).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ rawInput: '{"path":"complete"}' }),
      }),
    );
  });

  test.each(["success", "error"] as const)(
    "closes every open item before a %s result terminal",
    async (outcome) => {
      const { events, handleMessages } = createHarness();
      const messages = [
        {
          event: {
            delta: { text: "partial", type: "text_delta" },
            index: 0,
            type: "content_block_delta",
          },
          type: "stream_event",
          uuid: "assistant-open",
        },
        {
          event: {
            content_block: { thinking: "", type: "thinking" },
            index: 1,
            type: "content_block_start",
          },
          type: "stream_event",
          uuid: "assistant-open",
        },
        {
          event: {
            content_block: { id: "tool-open", input: {}, name: "Read", type: "tool_use" },
            index: 2,
            type: "content_block_start",
          },
          type: "stream_event",
          uuid: "assistant-open",
        },
        outcome === "success"
          ? {
              result: "partial",
              subtype: "success",
              total_cost_usd: 0,
              type: "result",
              usage: {},
              uuid: "result-1",
            }
          : {
              errors: ["failed"],
              subtype: "error_during_execution",
              total_cost_usd: 0,
              type: "result",
              usage: {},
              uuid: "result-1",
            },
      ] as unknown as SDKMessage[];

      await handleMessages(messages);

      const translated = events();
      const terminalIndex = translated.findIndex((event) =>
        ["run.completed", "run.failed"].includes(event.kind),
      );
      expect(terminalIndex).toBeGreaterThan(-1);
      const closureKinds =
        outcome === "success"
          ? (["message.completed", "thought.completed", "item.completed"] as const)
          : (["message.failed", "thought.cancelled", "item.completed"] as const);
      for (const kind of closureKinds) {
        expect(translated.findIndex((event) => event.kind === kind)).toBeGreaterThan(-1);
        expect(translated.findIndex((event) => event.kind === kind)).toBeLessThan(terminalIndex);
      }
      expect(translated.slice(0, terminalIndex)).toContainEqual(
        expect.objectContaining({
          kind: "tool.call.updated",
          payload: expect.objectContaining({
            status: outcome === "success" ? "completed" : "failed",
            toolCallId: "tool-open",
          }),
        }),
      );
    },
  );

  test("keeps a start-less streamed reply on one message through its assistant envelope", async () => {
    // YEF-884 wire shape: message_start was lost, every frame carries its own
    // envelope uuid, and the aggregated assistant envelope (with the native
    // message id) arrives before message_stop. The reply must stay one
    // message instead of rendering as "P" / "ong. …" / full-text duplicates.
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        event: {
          delta: { text: "P", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "frame-delta-1",
      },
      {
        event: {
          delta: { text: "ong. What would you like to work on?", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "frame-delta-2",
      },
      {
        message: {
          content: [{ text: "Pong. What would you like to work on?", type: "text" }],
          id: "msg-pong",
        },
        type: "assistant",
        uuid: "envelope-1",
      },
      {
        event: { index: 0, type: "content_block_stop" },
        type: "stream_event",
        uuid: "frame-stop-1",
      },
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "frame-stop-2",
      },
      {
        result: "Pong. What would you like to work on?",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    const translated = events();
    const textMessages = translated.flatMap((event) => {
      if (event.kind !== "message.delta" || !isRecord(event.payload)) {
        return [];
      }

      const contentDelta = event.payload["contentDelta"];
      const messageId = event.payload["messageId"];
      return typeof contentDelta === "string" && typeof messageId === "string"
        ? [{ contentDelta, messageId }]
        : [];
    });
    const started = translated
      .filter((event) => event.kind === "message.started" && isRecord(event.payload))
      .map((event) => (event.payload as Record<string, unknown>)["messageId"]);
    const snapshot = translated.find(
      (event) => event.kind === "message.added" && isRecord(event.payload),
    );
    const snapshotPayload =
      snapshot === undefined || !isRecord(snapshot.payload) ? null : snapshot.payload;
    const runCompleted = translated.find((event) => event.kind === "run.completed");
    const payload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(textMessages.map((entry) => entry.contentDelta)).toEqual([
      "P",
      "ong. What would you like to work on?",
    ]);
    expect(new Set(textMessages.map((entry) => entry.messageId)).size).toBe(1);
    expect(started).toHaveLength(1);
    expect(snapshotPayload?.["messageId"]).toBe(textMessages[0]?.messageId);
    expect(snapshotPayload?.["content"]).toEqual([
      { text: "Pong. What would you like to work on?", type: "text" },
    ]);
    expect(payload?.["finalMessageId"]).toBe(textMessages[0]?.messageId);
    expect(payload).not.toHaveProperty("finalMessageText");
    expect(messageText(translated, payload?.["finalMessageId"])).toBe(
      "Pong. What would you like to work on?",
    );
  });

  test("anchors uuid-fractured stream fragments to one closed assistant message", async () => {
    // One scope streams one message at a time; per-envelope uuids must not
    // fracture a burst whose message_start frame was lost (YEF-884).
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        event: {
          delta: { text: "A", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-open-a",
      },
      {
        event: {
          delta: { text: "B", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-open-b",
      },
      {
        result: "B",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-interleaved",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    const translated = events();
    const started = translated
      .filter((event) => event.kind === "message.started" && isRecord(event.payload))
      .map((event) => (event.payload as Record<string, unknown>)["messageId"]);
    const terminalIndex = translated.findIndex((event) => event.kind === "run.completed");
    const completed = translated
      .slice(0, terminalIndex)
      .filter((event) => event.kind === "message.completed" && isRecord(event.payload))
      .map((event) => (event.payload as Record<string, unknown>)["messageId"]);
    const deltaMessageIds = translated
      .filter((event) => event.kind === "message.delta" && isRecord(event.payload))
      .map((event) => (event.payload as Record<string, unknown>)["messageId"]);

    expect(started).toHaveLength(1);
    expect(completed).toEqual(started);
    expect(new Set(deltaMessageIds)).toEqual(new Set(started));
  });

  test("binds the aggregated assistant envelope to an unconfirmed streamed burst", async () => {
    // Without a message_start frame the streamed burst is anchored to an
    // envelope uuid; the aggregated assistant envelope that follows in the
    // same scope is that burst's own aggregation and must not mint a
    // duplicate message (YEF-884).
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        event: {
          delta: { text: "相同文本", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "assistant-progress-a",
      },
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "assistant-progress-a",
      },
      {
        message: {
          content: [{ text: "相同文本", type: "text" }],
        },
        type: "assistant",
        uuid: "assistant-final-b",
      },
      {
        result: "相同文本",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    const textMessages = events().flatMap((event) => {
      if (event.kind !== "message.delta" || !isRecord(event.payload)) {
        return [];
      }

      const contentDelta = event.payload["contentDelta"];
      const messageId = event.payload["messageId"];
      return typeof contentDelta === "string" && typeof messageId === "string"
        ? [{ contentDelta, messageId }]
        : [];
    });
    const snapshot = events().find(
      (event) => event.kind === "message.added" && isRecord(event.payload),
    );
    const snapshotPayload =
      snapshot === undefined || !isRecord(snapshot.payload) ? null : snapshot.payload;
    const runCompleted = events().find((event) => event.kind === "run.completed");
    const payload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(textMessages.map((entry) => entry.contentDelta)).toEqual(["相同文本"]);
    expect(snapshotPayload?.["messageId"]).toBe(textMessages[0]?.messageId);
    expect(payload?.["finalMessageId"]).toBe(textMessages[0]?.messageId);
    expect(payload).not.toHaveProperty("finalMessageText");
    expect(messageText(events(), payload?.["finalMessageId"])).toBe("相同文本");
  });

  test("keeps a confirmed streamed assistant replay on its original message", async () => {
    const { events, handleMessages } = createHarness();
    const assistant = {
      message: {
        content: [{ text: "canonical", type: "text" }],
        id: "native-message",
      },
      type: "assistant",
      uuid: "wire-assistant",
    };
    const messages = [
      {
        event: {
          message: { id: "native-message" },
          type: "message_start",
        },
        type: "stream_event",
        uuid: "stream-start",
      },
      {
        event: {
          delta: { text: "canonical", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "stream-delta",
      },
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "stream-stop",
      },
      assistant,
      assistant,
      {
        result: "canonical",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    const started = events().filter((event) => event.kind === "message.started");
    const completed = events().filter((event) => event.kind === "message.completed");
    const snapshots = events().filter((event) => event.kind === "message.added");
    const runCompleted = events().find((event) => event.kind === "run.completed");
    const startedMessageId = isRecord(started[0]?.payload)
      ? started[0].payload["messageId"]
      : undefined;

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    expect(runCompleted?.payload).toMatchObject({
      finalMessageId: startedMessageId,
    });
    expect(runCompleted?.payload).not.toHaveProperty("finalMessageText");
    expect(messageText(events(), startedMessageId)).toBe("canonical");
  });

  test("keeps distinct live assistant envelopes that share a native message id", async () => {
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        event: { message: { id: "shared-native" }, type: "message_start" },
        type: "stream_event",
        uuid: "stream-start",
      },
      {
        event: {
          delta: { text: "first", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "stream-first",
      },
      {
        message: { content: [{ text: "first", type: "text" }], id: "shared-native" },
        type: "assistant",
        uuid: "wire-first",
      },
      {
        event: {
          delta: { text: "second", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "stream-second",
      },
      {
        message: { content: [{ text: "second", type: "text" }], id: "shared-native" },
        type: "assistant",
        uuid: "wire-second",
      },
      {
        result: "second",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    const snapshots = events().filter((event) => event.kind === "message.added");
    const messageIds = snapshots.flatMap((event) =>
      isRecord(event.payload) && typeof event.payload["messageId"] === "string"
        ? [event.payload["messageId"]]
        : [],
    );
    const runCompleted = events().find((event) => event.kind === "run.completed");

    expect(snapshots).toHaveLength(2);
    expect(new Set(messageIds).size).toBe(2);
    expect(runCompleted?.payload).toMatchObject({
      finalMessageId: messageIds.at(-1),
    });
    expect(runCompleted?.payload).not.toHaveProperty("finalMessageText");
    expect(messageText(events(), messageIds.at(-1))).toBe("second");
  });

  test("keeps duplicate text on distinct messages when the stream identity is confirmed", async () => {
    // A message_start frame proves the streamed message's native id, so an
    // assistant envelope with a different native id is a genuinely separate
    // message even when the text repeats.
    const { events, handleMessages } = createHarness();
    const messages = [
      {
        event: {
          message: { id: "msg-progress" },
          type: "message_start",
        },
        type: "stream_event",
        uuid: "stream-1",
      },
      {
        event: {
          delta: { text: "相同文本", type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
        uuid: "stream-2",
      },
      {
        event: { type: "message_stop" },
        type: "stream_event",
        uuid: "stream-3",
      },
      {
        message: {
          content: [{ text: "相同文本", type: "text" }],
          id: "msg-final",
        },
        type: "assistant",
        uuid: "assistant-final",
      },
      {
        result: "相同文本",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "result-1",
      },
    ] as unknown as SDKMessage[];

    await handleMessages(messages);

    const textMessages = events().flatMap((event) => {
      if (event.kind !== "message.delta" || !isRecord(event.payload)) {
        return [];
      }

      const contentDelta = event.payload["contentDelta"];
      const messageId = event.payload["messageId"];
      return typeof contentDelta === "string" && typeof messageId === "string"
        ? [{ contentDelta, messageId }]
        : [];
    });
    const runCompleted = events().find((event) => event.kind === "run.completed");
    const payload =
      runCompleted === undefined || !isRecord(runCompleted.payload) ? null : runCompleted.payload;

    expect(textMessages.map((entry) => entry.contentDelta)).toEqual(["相同文本", "相同文本"]);
    expect(new Set(textMessages.map((entry) => entry.messageId)).size).toBe(2);
    expect(payload?.["finalMessageId"]).toBe(textMessages.at(-1)?.messageId);
    expect(payload).not.toHaveProperty("finalMessageText");
    expect(messageText(events(), payload?.["finalMessageId"])).toBe("相同文本");
  });
});
