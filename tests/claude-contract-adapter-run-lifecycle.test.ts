import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  applyCommittedMutation,
  interactionSchema,
  validateSessionSnapshot,
} from "../src/contract";
import type {
  AuthorityOperation,
  CommittedMutation,
  InteractionResolution,
  Run,
  SessionSnapshot,
} from "../src/contract";
import { ClaudeContractAdapter } from "../src/runtimes/claude/contract-adapter";
import type {
  ContractAuthorityUpdate,
  ContractPreviewUpdate,
} from "../src/runtimes/contract-projection";

const SESSION_ID = protocolId(1);
const RUN_ID = protocolId(2);

function protocolId(value: number): string {
  return value.toString().padStart(26, "0");
}

function sdkMessage(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function activeRun(startedAt: string): Run {
  return {
    id: RUN_ID,
    input: [{ text: "hello", type: "text" }],
    origin: "user",
    startedAt,
    status: "active",
  };
}

function createInitialSnapshot(capturedAt: string): SessionSnapshot {
  return validateSessionSnapshot({
    capturedAt,
    interactions: [],
    items: [],
    protocolVersion: 2,
    revision: 0,
    runs: [activeRun(capturedAt)],
    session: {
      capabilities: {
        "interaction.permission": {},
        "item.artifact": {},
        "item.change": {},
        "item.plan": {},
        "item.reasoning": {},
        "item.terminal": {},
      },
      config: [],
      createdAt: capturedAt,
      id: SESSION_ID,
      status: "open",
      updatedAt: capturedAt,
    },
  });
}

function createHarness(
  interactionTimeoutMs = 5 * 60 * 1_000,
  maxToolInputBytes?: number,
  maxPendingPermissionBytes?: number,
  onAuthority?: (update: ContractAuthorityUpdate) => Promise<void> | void,
) {
  let nowMs = Date.parse("2026-07-16T08:00:00.000Z");
  let snapshot = createInitialSnapshot(new Date(nowMs).toISOString());
  let nextId = 100;
  const authority: ContractAuthorityUpdate[] = [];
  const previews: ContractPreviewUpdate[] = [];
  const commit = (cause: CommittedMutation["cause"], operations: AuthorityOperation[]): void => {
    const revision = snapshot.revision + 1;
    const mutation: CommittedMutation = {
      baseRevision: snapshot.revision,
      cause,
      committedAt: new Date(nowMs).toISOString(),
      mutationId: protocolId(1_000 + revision),
      operations,
      revision,
      sessionId: SESSION_ID,
    };
    snapshot = applyCommittedMutation(snapshot, mutation);
  };
  const adapter = new ClaudeContractAdapter({
    authority: async (update) => {
      authority.push(update);
      await onAuthority?.(update);
      commit(update.cause, [...update.operations] as AuthorityOperation[]);
    },
    createId: () => protocolId(nextId++),
    interactionTimeoutMs,
    maxPendingPermissionBytes,
    maxToolInputBytes,
    now: () => new Date(nowMs),
    preview: (update) => previews.push(update),
    sessionId: SESSION_ID,
  });

  return {
    adapter,
    advance(milliseconds: number) {
      nowMs += milliseconds;
    },
    authority,
    previews,
    settleInteraction(interactionId: string, resolution?: InteractionResolution) {
      const interaction = snapshot.interactions.find((entry) => entry.id === interactionId);

      if (interaction === undefined || interaction.status !== "open") {
        throw new Error("The test interaction must be open.");
      }

      if (resolution !== undefined && resolution.kind !== interaction.kind) {
        throw new Error("The test resolution kind must match the interaction kind.");
      }

      const endedAt = new Date(nowMs).toISOString();
      commit({ commandId: protocolId(2_000 + snapshot.revision + 1), type: "command" }, [
        {
          entity: "interaction",
          op: "put",
          value: interactionSchema.parse(
            resolution === undefined
              ? { ...interaction, endedAt, status: "expired" }
              : {
                  ...interaction,
                  endedAt,
                  resolution: resolution.value,
                  status: "resolved",
                },
          ),
        },
      ]);
    },
    snapshot: () => snapshot,
  };
}

async function registerRun(adapter: ClaudeContractAdapter): Promise<void> {
  adapter.attachRun(activeRun("2026-07-16T08:00:00.000Z"));
}

describe("Claude Contract adapter", () => {
  test("does not let a late stream stop overwrite authoritative tool input", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        event: {
          content_block: { id: "tool-1", input: {}, name: "Read", type: "tool_use" },
          index: 0,
          type: "content_block_start",
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        event: {
          delta: { partial_json: '{"value":1}', type: "input_json_delta" },
          index: 0,
          type: "content_block_delta",
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        message: {
          content: [{ id: "tool-1", input: { value: 2 }, name: "Read", type: "tool_use" }],
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "assistant",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        event: { index: 0, type: "content_block_stop" },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );

    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({ id: "tool:tool-1", input: { value: 2 } }),
    );
  });

  test("rejects oversized permission input before creating Authority state", async () => {
    const harness = createHarness(5 * 60 * 1_000, 8);
    await registerRun(harness.adapter);

    await expect(
      harness.adapter.openPermission(
        RUN_ID,
        "Bash",
        { payload: "too-large" },
        {
          requestId: "oversized-request",
          signal: new AbortController().signal,
          toolUseID: "tool-oversized",
        },
      ),
    ).rejects.toThrow("exceeds its byte limit");
    expect(harness.snapshot().items).toHaveLength(0);
    expect(harness.snapshot().interactions).toHaveLength(0);
  });

  test.each([Number.POSITIVE_INFINITY, 1.5])("rejects invalid tool input limit %p", (value) => {
    expect(() => createHarness(5 * 60 * 1_000, value)).toThrow(
      "limits must be finite and positive",
    );
  });

  test.each([Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid pending permission limit %p",
    (value) => {
      expect(() => createHarness(5 * 60 * 1_000, undefined, value)).toThrow(
        "limits must be finite and positive",
      );
    },
  );

  test("preserves first-seen assistant block order", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        message: {
          content: [
            { text: "before tool", type: "text" },
            { id: "tool-1", input: {}, name: "Read", type: "tool_use" },
            { thinking: "after tool", type: "thinking" },
          ],
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "assistant",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );

    expect(harness.snapshot().items.map((item) => item.kind)).toEqual([
      "message",
      "tool",
      "reasoning",
    ]);
  });

  test("isolates streamed tool indexes by assistant and drops invalid JSON fragments", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);

    for (const [uuid, toolId] of [
      ["assistant-a", "tool-a"],
      ["assistant-b", "tool-b"],
      ["assistant-c", "tool-c"],
    ] as const) {
      await harness.adapter.handleMessage(
        sdkMessage({
          event: {
            content_block: { id: toolId, name: "Read", type: "tool_use" },
            index: 0,
            type: "content_block_start",
          },
          parent_tool_use_id: null,
          session_id: "native-session-1",
          type: "stream_event",
          uuid,
        }),
        RUN_ID,
      );
    }

    for (const [uuid, partialJson] of [
      ["assistant-a", '{"a":1}'],
      ["assistant-b", '{"b":2}'],
      ["assistant-c", "{"],
    ] as const) {
      await harness.adapter.handleMessage(
        sdkMessage({
          event: {
            delta: { partial_json: partialJson, type: "input_json_delta" },
            index: 0,
            type: "content_block_delta",
          },
          parent_tool_use_id: null,
          session_id: "native-session-1",
          type: "stream_event",
          uuid,
        }),
        RUN_ID,
      );
    }

    for (const uuid of ["assistant-a", "assistant-b", "assistant-c"] as const) {
      await harness.adapter.handleMessage(
        sdkMessage({
          event: { index: 0, type: "content_block_stop" },
          parent_tool_use_id: null,
          session_id: "native-session-1",
          type: "stream_event",
          uuid,
        }),
        RUN_ID,
      );
    }

    expect(harness.snapshot().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool:tool-a", input: { a: 1 } }),
        expect.objectContaining({ id: "tool:tool-b", input: { b: 2 } }),
      ]),
    );
    const invalid = harness.snapshot().items.find((item) => item.id === "tool:tool-c");
    expect(invalid).toMatchObject({ id: "tool:tool-c", kind: "tool" });
    expect(invalid?.kind === "tool" ? invalid.input : null).toBeUndefined();
  });

  test("avoids phantom messages and cancels unresolved items at a successful result boundary", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        event: { type: "message_start" },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-empty",
      }),
      RUN_ID,
    );
    expect(harness.snapshot().items).toHaveLength(0);

    await harness.adapter.handleMessage(
      sdkMessage({
        elapsed_time_seconds: 1,
        session_id: "native-session-1",
        tool_name: "Read",
        tool_use_id: "tool-pending",
        type: "tool_progress",
        uuid: "progress-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        is_error: false,
        modelUsage: {},
        num_turns: 1,
        permission_denials: [],
        result: "done",
        session_id: "native-session-1",
        stop_reason: null,
        subtype: "success",
        terminal_reason: "background_requested",
        total_cost_usd: 0,
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: "result-1",
      }),
      RUN_ID,
    );

    expect(harness.snapshot().runs[0]).toMatchObject({
      finishReason: "other",
      status: "completed",
    });
    expect(harness.snapshot().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool:tool-pending", status: "cancelled" }),
        expect.objectContaining({ content: [{ text: "done", type: "text" }], status: "completed" }),
      ]),
    );
  });

  test("fences native sessions", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        mcp_servers: [],
        model: "sonnet",
        permissionMode: "default",
        session_id: "native-session-1",
        subtype: "init",
        tools: [],
        type: "system",
        uuid: "init-1",
      }),
      RUN_ID,
    );
    await expect(
      harness.adapter.handleMessage(
        sdkMessage({
          mcp_servers: [],
          model: "sonnet",
          permissionMode: "default",
          session_id: "native-session-2",
          subtype: "init",
          tools: [],
          type: "system",
          uuid: "init-2",
        }),
        RUN_ID,
      ),
    ).rejects.toThrow("different native session");
  });

  test.each([
    ["error_max_turns", "max_turns"],
    ["error_max_budget_usd", "budget_exhausted"],
    ["error_max_structured_output_retries", "structured_output_retry_exhausted"],
  ] as const)("treats %s as a limit", async (subtype, terminalReason) => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        errors: [`Run stopped at ${terminalReason}`],
        is_error: true,
        modelUsage: {},
        num_turns: 10,
        permission_denials: [],
        session_id: "native-session-1",
        stop_reason: null,
        subtype,
        terminal_reason: terminalReason,
        total_cost_usd: 0,
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: "result-1",
      }),
      RUN_ID,
    );

    expect(harness.snapshot().runs[0]).toMatchObject({
      finishReason: "limit",
      status: "completed",
    });
  });

  test("waits for task notification before making a task immutable", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        description: "Research",
        session_id: "native-session-1",
        subtype: "task_started",
        task_id: "task-1",
        type: "system",
        uuid: "task-start-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        description: "Research replay",
        session_id: "native-session-1",
        subtype: "task_started",
        task_id: "task-1",
        type: "system",
        uuid: "task-start-2",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        patch: { status: "completed" },
        session_id: "native-session-1",
        subtype: "task_updated",
        task_id: "task-1",
        type: "system",
        uuid: "task-update-1",
      }),
      RUN_ID,
    );
    expect(harness.snapshot().items[0]?.status).toBe("active");

    await harness.adapter.handleMessage(
      sdkMessage({
        output_file: "/tmp/task-1.output",
        session_id: "native-session-1",
        status: "completed",
        subtype: "task_notification",
        summary: "Research complete",
        task_id: "task-1",
        type: "system",
        usage: { duration_ms: 10, tool_uses: 1, total_tokens: 20 },
        uuid: "task-result-1",
      }),
      RUN_ID,
    );
    expect(harness.snapshot().items[0]).toMatchObject({
      output: [{ text: "Research complete", type: "text" }],
      status: "completed",
    });
  });
});
