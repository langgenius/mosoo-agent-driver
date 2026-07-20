import { describe, expect, test } from "bun:test";

import {
  AuthorityOutcomeUnknownError,
  applyCommittedMutation,
  interactionSchema,
  validateSessionSnapshot,
} from "../src/contract";
import type {
  AuthorityOperation,
  CommittedMutation,
  InteractionResolution,
  ProtocolAdmissionLimits,
  Run,
  SessionSnapshot,
} from "../src/contract";
import {
  OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION,
  OpenAiContractAdapter,
  type OpenAiAuthorityUpdate,
} from "../src/runtimes/openai/contract-adapter";
import type { ContractPreviewUpdate } from "../src/runtimes/contract-projection";

const SESSION_ID = protocolId(1);
const RUN_ID = protocolId(2);
const COMMAND_ID = protocolId(3);
const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

function protocolId(value: number): string {
  return value.toString().padStart(26, "0");
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
        [OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION]: {},
        "interaction.input": {},
        "interaction.permission": {},
        "interaction.tool": {},
        "item.change": {},
        "item.plan": {},
        "item.reasoning": {},
        "item.terminal": {},
        "openai.app-server/thread-item": {},
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
  options: {
    admissionLimits?: ProtocolAdmissionLimits;
    holdAuthority?: boolean;
    interactionTimeoutMs?: number;
    maxPendingServerRequestBytes?: number;
    previewCheckpointBytes?: number;
    previewReplaceIntervalMs?: number;
  } = {},
) {
  let nowMs = Date.parse("2026-07-16T08:00:00.000Z");
  let snapshot = createInitialSnapshot(new Date(nowMs).toISOString());
  let nextId = 100;
  let rejectNextAuthorityAfterCommit = false;
  const authorityEntered = Promise.withResolvers<void>();
  const authorityGate = Promise.withResolvers<void>();
  const authority: OpenAiAuthorityUpdate[] = [];
  const committedMutationIds = new Set<string>();
  const previews: ContractPreviewUpdate[] = [];
  const commit = (
    cause: CommittedMutation["cause"],
    operations: AuthorityOperation[],
    mutationId = protocolId(1_000 + snapshot.revision + 1),
  ): void => {
    if (committedMutationIds.has(mutationId)) {
      return;
    }

    const revision = snapshot.revision + 1;
    const mutation: CommittedMutation = {
      baseRevision: snapshot.revision,
      cause,
      committedAt: new Date(nowMs).toISOString(),
      mutationId,
      operations,
      revision,
      sessionId: SESSION_ID,
    };
    snapshot = applyCommittedMutation(snapshot, mutation);
    committedMutationIds.add(mutationId);
  };
  const adapter = new OpenAiContractAdapter({
    admissionLimits: options.admissionLimits,
    authority: async (update) => {
      authority.push(update);
      if (options.holdAuthority === true) {
        authorityEntered.resolve();
        await authorityGate.promise;
      }
      commit(update.cause, [...update.operations] as AuthorityOperation[], update.mutationId);
      if (rejectNextAuthorityAfterCommit) {
        rejectNextAuthorityAfterCommit = false;
        throw new AuthorityOutcomeUnknownError("authority result lost");
      }
    },
    createId: () => protocolId(nextId++),
    interactionTimeoutMs: options.interactionTimeoutMs,
    maxPendingServerRequestBytes: options.maxPendingServerRequestBytes,
    now: () => new Date(nowMs),
    preview: (update) => previews.push(update),
    previewCheckpointBytes: options.previewCheckpointBytes,
    previewReplaceIntervalMs: options.previewReplaceIntervalMs,
    sessionId: SESSION_ID,
  });

  return {
    adapter,
    advance(milliseconds: number) {
      nowMs += milliseconds;
    },
    authority,
    authorityEntered: authorityEntered.promise,
    previews,
    rejectNextAuthorityAfterCommit() {
      rejectNextAuthorityAfterCommit = true;
    },
    releaseAuthority() {
      authorityGate.resolve();
    },
    settleInteraction(interactionId: string, resolution?: InteractionResolution) {
      const interaction = snapshot.interactions.find((entry) => entry.id === interactionId);

      if (interaction === undefined || interaction.status !== "open") {
        throw new Error("The test interaction must be open.");
      }

      if (resolution !== undefined && resolution.kind !== interaction.kind) {
        throw new Error("The test resolution kind must match the interaction kind.");
      }

      const endedAt = new Date(nowMs).toISOString();
      const authoritativeResolution =
        resolution?.kind === "input" && resolution.value.type === "answered"
          ? {
              answeredQuestionIds: Object.keys(resolution.value.answers),
              type: "answered" as const,
            }
          : resolution?.value;
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
                  resolution: authoritativeResolution,
                  status: "resolved",
                },
          ),
        },
      ]);
    },
    snapshot: () => snapshot,
  };
}

function turnAttachment() {
  return {
    cause: { commandId: COMMAND_ID, type: "command" as const },
    run: activeRun("2026-07-16T08:00:00.000Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
  };
}

async function registerTurn(adapter: OpenAiContractAdapter): Promise<void> {
  await adapter.attachTurn(turnAttachment());
}

describe("OpenAI Contract adapter", () => {
  test("checkpoints long Preview text before opening a bounded next segment", async () => {
    const harness = createHarness({
      previewCheckpointBytes: 5,
      previewReplaceIntervalMs: 10_000,
    });
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/started", {
      item: { id: "message-1", text: "", type: "agentMessage" },
      startedAtMs: Date.parse("2026-07-16T08:00:00.100Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/agentMessage/delta", {
      delta: "hello",
      itemId: "message-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(harness.previews).toHaveLength(0);
    expect(harness.snapshot().items[0]).toMatchObject({
      content: [{ text: "hello", type: "text" }],
      status: "active",
    });

    await harness.adapter.handleNotification("item/agentMessage/delta", {
      delta: "!",
      itemId: "message-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(harness.previews[0]?.update).toMatchObject({
      fromSequence: 1,
      op: "append",
      segment: 1,
      text: "!",
      throughSequence: 1,
    });
  });

  test("preserves reasoning section boundaries and replaces MCP progress snapshots", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/started", {
      item: { content: [], id: "reasoning-1", summary: [], type: "reasoning" },
      startedAtMs: Date.parse("2026-07-16T08:00:00.100Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/reasoning/summaryPartAdded", {
      itemId: "reasoning-1",
      summaryIndex: 0,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/reasoning/summaryTextDelta", {
      delta: "first",
      itemId: "reasoning-1",
      summaryIndex: 0,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/reasoning/summaryPartAdded", {
      itemId: "reasoning-1",
      summaryIndex: 1,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/reasoning/summaryTextDelta", {
      delta: "second",
      itemId: "reasoning-1",
      summaryIndex: 1,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/started", {
      item: {
        arguments: {},
        error: null,
        id: "mcp-1",
        result: null,
        server: "demo",
        status: "inProgress",
        tool: "work",
        type: "mcpToolCall",
      },
      startedAtMs: Date.parse("2026-07-16T08:00:00.200Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/mcpToolCall/progress", {
      itemId: "mcp-1",
      message: "one",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/mcpToolCall/progress", {
      itemId: "mcp-1",
      message: "two",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(harness.previews.map((entry) => entry.update)).toMatchObject([
      { channel: "reasoning.text", op: "append", text: "first", throughSequence: 1 },
      { channel: "reasoning.text", op: "append", text: "\n\n", throughSequence: 2 },
      { channel: "reasoning.text", op: "append", text: "second", throughSequence: 3 },
      { channel: "tool.progress", op: "replace", text: "one", throughSequence: 1 },
      { channel: "tool.progress", op: "replace", text: "two", throughSequence: 2 },
    ]);
  });

  test("removes private citation markup from Preview and authoritative messages", async () => {
    const harness = createHarness();
    const citation = "\uE200cite\uE202turn7search12\uE201";
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/started", {
      item: { id: "message-1", text: "", type: "agentMessage" },
      startedAtMs: Date.parse("2026-07-16T08:00:00.100Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/agentMessage/delta", {
      delta: "before\uE200ci",
      itemId: "message-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/agentMessage/delta", {
      delta: "te\uE202turn7search12\uE201after",
      itemId: "message-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/completed", {
      completedAtMs: Date.parse("2026-07-16T08:00:00.300Z"),
      item: { id: "message-1", text: `before${citation}after`, type: "agentMessage" },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(harness.previews.map((entry) => entry.update)).toMatchObject([
      { text: "before", throughSequence: 1 },
      { text: "after", throughSequence: 2 },
    ]);
    expect(harness.snapshot().items[0]).toMatchObject({
      content: [{ text: "beforeafter", type: "text" }],
      status: "completed",
    });
  });

  test("projects usage and authoritative terminal, change, MCP, and plan snapshots", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/started", {
      item: {
        aggregatedOutput: null,
        command: "pwd",
        cwd: "/workspace",
        exitCode: null,
        id: "command-1",
        status: "inProgress",
        type: "commandExecution",
      },
      startedAtMs: Date.parse("2026-07-16T08:00:00.100Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/completed", {
      completedAtMs: Date.parse("2026-07-16T08:00:00.200Z"),
      item: {
        aggregatedOutput: "/workspace\n",
        command: "pwd",
        cwd: "/workspace",
        exitCode: 0,
        id: "command-1",
        status: "completed",
        type: "commandExecution",
      },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/fileChange/patchUpdated", {
      changes: [
        {
          diff: "+hello",
          kind: { type: "add" },
          path: "hello.txt",
        },
      ],
      itemId: "change-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/completed", {
      completedAtMs: Date.parse("2026-07-16T08:00:00.300Z"),
      item: {
        changes: [
          {
            diff: "+hello",
            kind: { type: "add" },
            path: "hello.txt",
          },
        ],
        id: "change-1",
        status: "completed",
        type: "fileChange",
      },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/started", {
      item: {
        arguments: { path: "README.md" },
        error: null,
        id: "mcp-1",
        result: null,
        server: "files",
        status: "inProgress",
        tool: "read",
        type: "mcpToolCall",
      },
      startedAtMs: Date.parse("2026-07-16T08:00:00.400Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/completed", {
      completedAtMs: Date.parse("2026-07-16T08:00:00.500Z"),
      item: {
        arguments: { path: "README.md" },
        error: null,
        id: "mcp-1",
        result: {
          _meta: null,
          content: [{ text: "ok", type: "text" }],
          structuredContent: { bytes: 2 },
        },
        server: "files",
        status: "completed",
        tool: "read",
        type: "mcpToolCall",
      },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/started", {
      item: {
        action: null,
        id: "search-1",
        query: "",
        results: null,
        type: "webSearch",
      },
      startedAtMs: Date.parse("2026-07-16T08:00:00.550Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/completed", {
      completedAtMs: Date.parse("2026-07-16T08:00:00.560Z"),
      item: {
        action: { query: "protocol", queries: null, type: "search" },
        id: "search-1",
        query: "protocol",
        results: [{ title: "Result", type: "text_result", url: "https://example.com" }],
        type: "webSearch",
      },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/completed", {
      completedAtMs: Date.parse("2026-07-16T08:00:00.570Z"),
      item: { id: "native-plan", text: "Inspect the protocol", type: "plan" },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("turn/plan/updated", {
      explanation: "work",
      plan: [{ status: "inProgress", step: "inspect" }],
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("thread/tokenUsage/updated", {
      threadId: THREAD_ID,
      tokenUsage: {
        last: {
          cachedInputTokens: 2,
          inputTokens: 10,
          outputTokens: 4,
          reasoningOutputTokens: 1,
          totalTokens: 14,
        },
        total: {
          cachedInputTokens: 22,
          inputTokens: 110,
          outputTokens: 54,
          reasoningOutputTokens: 11,
          totalTokens: 164,
        },
      },
      turnId: TURN_ID,
    });

    await harness.adapter.handleNotification("thread/tokenUsage/updated", {
      threadId: THREAD_ID,
      tokenUsage: {
        last: {
          cachedInputTokens: 1,
          inputTokens: 3,
          outputTokens: 2,
          reasoningOutputTokens: 1,
          totalTokens: 5,
        },
        total: {
          cachedInputTokens: 23,
          inputTokens: 113,
          outputTokens: 56,
          reasoningOutputTokens: 12,
          totalTokens: 169,
        },
      },
      turnId: TURN_ID,
    });

    const snapshot = harness.snapshot();
    expect(snapshot.runs[0]?.usage).toEqual({
      cachedInput: 3,
      input: 13,
      output: 6,
      reasoning: 2,
      total: 19,
    });
    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "pwd",
          exitCode: 0,
          kind: "terminal",
          status: "completed",
          stdout: [{ text: "/workspace\n", type: "text" }],
        }),
        expect.objectContaining({
          changes: [
            {
              diff: { text: "+hello", type: "text" },
              operation: "create",
              path: "hello.txt",
            },
          ],
          kind: "change",
          status: "completed",
        }),
        expect.objectContaining({
          input: { path: "README.md" },
          kind: "tool",
          name: "read",
          origin: "mcp",
          output: [{ text: "ok", type: "text" }],
          server: "files",
          status: "completed",
          structuredOutput: { bytes: 2 },
        }),
        expect.objectContaining({
          input: {
            action: { query: "protocol", queries: null, type: "search" },
            query: "protocol",
          },
          kind: "tool",
          name: "web_search",
          structuredOutput: [{ title: "Result", type: "text_result", url: "https://example.com" }],
        }),
        expect.objectContaining({
          entries: [{ id: "0", status: "in_progress", text: "inspect" }],
          explanation: "work",
          id: "turn-plan",
          kind: "plan",
          status: "active",
        }),
        expect.objectContaining({
          entries: [{ id: "0", status: "completed", text: "Inspect the protocol" }],
          id: "native-plan",
          kind: "plan",
          status: "completed",
        }),
      ]),
    );

    await harness.adapter.handleNotification("turn/completed", {
      threadId: THREAD_ID,
      turn: {
        completedAt: Date.parse("2026-07-16T08:00:00.600Z") / 1_000,
        error: null,
        id: TURN_ID,
        items: [],
        itemsView: "notLoaded",
        startedAt: Date.parse("2026-07-16T08:00:00.000Z") / 1_000,
        status: "completed",
      },
    });
    expect(harness.snapshot().runs[0]).toMatchObject({ status: "completed" });
    expect(harness.snapshot().items.find((item) => item.id === "turn-plan")).toMatchObject({
      status: "completed",
    });
  });

  test.each([
    {
      error: { message: "command failed explicitly" },
      expectedError: "command failed explicitly",
      expectedStatus: "failed",
      label: "explicit failure",
      nativeStatus: "failed",
    },
    {
      error: null,
      expectedError: "commandExecution failed.",
      expectedStatus: "failed",
      label: "fallback failure",
      nativeStatus: "failed",
    },
    {
      error: null,
      expectedError: null,
      expectedStatus: "cancelled",
      label: "declined command",
      nativeStatus: "declined",
    },
  ] as const)(
    "projects $label as $expectedStatus",
    async ({ error, expectedError, expectedStatus, nativeStatus }) => {
      const harness = createHarness();
      await registerTurn(harness.adapter);
      await harness.adapter.handleNotification("item/completed", {
        completedAtMs: Date.parse("2026-07-16T08:00:00.100Z"),
        item: {
          aggregatedOutput: "command output",
          command: "false",
          error,
          exitCode: nativeStatus === "failed" ? 1 : null,
          id: `command-${nativeStatus}-${expectedError ?? "none"}`,
          status: nativeStatus,
          type: "commandExecution",
        },
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });

      const item = harness.snapshot().items[0];
      expect(item).toMatchObject({ kind: "terminal", status: expectedStatus });

      if (expectedError === null) {
        expect(item).not.toHaveProperty("error");
      } else {
        expect(item).toMatchObject({ error: { message: expectedError, retryable: false } });
      }
    },
  );
});
