import { describe, expect, test } from "bun:test";

import {
  AuthorityOutcomeUnknownError,
  applyCommittedMutation,
  interactionSchema,
  itemSchema,
  previewUpdateSchema,
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

function userInputRequest(autoResolutionMs: number | null = null) {
  return {
    autoResolutionMs,
    itemId: "input-1",
    questions: [
      {
        id: "name",
        isOther: false,
        isSecret: false,
        options: null,
        question: "Name?",
      },
    ],
    threadId: THREAD_ID,
    turnId: TURN_ID,
  };
}

describe("OpenAI Contract adapter", () => {
  test("binds each Run to exactly one native Turn", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);

    await expect(
      harness.adapter.attachTurn({
        cause: { commandId: protocolId(4), type: "command" },
        run: activeRun("2026-07-16T08:00:00.000Z"),
        threadId: THREAD_ID,
        turnId: "turn-2",
      }),
    ).rejects.toThrow("already attached");
  });

  test("replays a terminal Turn that arrives before attachment", async () => {
    const harness = createHarness();
    const terminal = {
      threadId: THREAD_ID,
      turn: {
        completedAt: Date.parse("2026-07-16T08:00:00.200Z") / 1_000,
        durationMs: 200,
        error: null,
        id: TURN_ID,
        items: [],
        itemsView: "notLoaded",
        startedAt: Date.parse("2026-07-16T08:00:00.000Z") / 1_000,
        status: "completed",
      },
    };

    await harness.adapter.handleNotification("turn/completed", terminal);

    expect(harness.snapshot().runs[0]).toMatchObject({ status: "active" });
    await registerTurn(harness.adapter);
    expect(harness.snapshot().runs[0]).toMatchObject({
      finishReason: "success",
      status: "completed",
    });
    await expect(registerTurn(harness.adapter)).resolves.toBeUndefined();
    await expect(
      harness.adapter.handleNotification("turn/completed", terminal),
    ).resolves.toBeUndefined();
    expect(harness.snapshot().runs).toHaveLength(1);
    await expect(
      harness.adapter.attachTurn({
        ...turnAttachment(),
        run: {
          ...turnAttachment().run,
          input: [{ text: "changed", type: "text" }],
        },
      }),
    ).rejects.toThrow("different state");
  });

  test("replays item events before a pre-attachment terminal Turn", async () => {
    const harness = createHarness();

    await harness.adapter.handleNotification("item/started", {
      item: { id: "message-1", text: "", type: "agentMessage" },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/agentMessage/delta", {
      delta: "hello",
      itemId: "message-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/completed", {
      item: { id: "message-1", text: "hello", type: "agentMessage" },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("turn/completed", {
      threadId: THREAD_ID,
      turn: {
        id: TURN_ID,
        items: [],
        itemsView: "notLoaded",
        status: "completed",
      },
    });

    await registerTurn(harness.adapter);

    expect(harness.snapshot()).toMatchObject({
      items: [
        {
          content: [{ text: "hello", type: "text" }],
          id: "message-1",
          status: "completed",
        },
      ],
      runs: [{ id: RUN_ID, status: "completed" }],
    });
  });

  test("fails closed for a server request received before Turn attachment", async () => {
    const harness = createHarness();

    await expect(
      harness.adapter.handleServerRequest("item/tool/requestUserInput", 1, userInputRequest()),
    ).rejects.toThrow("before attachment");
    expect(harness.authority).toHaveLength(0);
  });

  test("bounds non-terminal Turn events waiting for attachment", async () => {
    const harness = createHarness();

    for (let index = 0; index < 1_024; index += 1) {
      await harness.adapter.handleNotification("item/agentMessage/delta", {
        delta: "x",
        itemId: "message-1",
        threadId: THREAD_ID,
        turnId: `turn-${String(index)}`,
      });
    }

    await expect(
      harness.adapter.handleNotification("item/agentMessage/delta", {
        delta: "x",
        itemId: "message-1",
        threadId: THREAD_ID,
        turnId: "turn-overflow",
      }),
    ).rejects.toThrow("pending Turn event limit");
    harness.adapter.dispose();
  });

  test("bounds terminal Turns waiting for attachment", async () => {
    const harness = createHarness();
    const terminal = (turnId: string) =>
      harness.adapter.handleNotification("turn/completed", {
        threadId: THREAD_ID,
        turn: {
          completedAt: null,
          durationMs: null,
          error: null,
          id: turnId,
          items: [],
          itemsView: "notLoaded",
          startedAt: null,
          status: "completed",
        },
      });

    for (let index = 0; index < 1_024; index += 1) {
      await terminal(`turn-${String(index)}`);
    }

    await expect(terminal("turn-overflow")).rejects.toThrow("pending terminal Turn limit");
    harness.adapter.dispose();
  });

  test("keeps a pre-attachment terminal Turn identity stable", async () => {
    const harness = createHarness();
    const terminal = {
      threadId: THREAD_ID,
      turn: {
        completedAt: null,
        durationMs: null,
        error: null,
        id: TURN_ID,
        items: [],
        itemsView: "notLoaded",
        startedAt: null,
        status: "completed",
      },
    };

    await harness.adapter.handleNotification("turn/completed", terminal);
    await expect(
      harness.adapter.handleNotification("turn/completed", structuredClone(terminal)),
    ).resolves.toBeUndefined();
    await expect(
      harness.adapter.handleNotification("turn/completed", {
        ...terminal,
        turn: { ...terminal.turn, status: "failed" },
      }),
    ).rejects.toThrow("changed before attachment");
    harness.adapter.dispose();
  });

  test("rejects changed Run state on an attachment retry", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);

    await expect(
      harness.adapter.attachTurn({
        cause: { commandId: protocolId(4), type: "command" },
        run: {
          ...activeRun("2026-07-16T08:00:00.000Z"),
          input: [{ text: "changed", type: "text" }],
        },
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
    ).rejects.toThrow("different state");
    expect(harness.authority).toHaveLength(1);
  });

  test("reuses the attachment mutation ID after an ambiguous Authority result", async () => {
    const harness = createHarness();
    harness.rejectNextAuthorityAfterCommit();

    await expect(harness.adapter.attachTurn(turnAttachment())).rejects.toThrow("result lost");
    const mutationId = harness.authority[0]?.mutationId;
    await expect(harness.adapter.attachTurn(turnAttachment())).resolves.toBeUndefined();

    expect(harness.authority.map((update) => update.mutationId)).toEqual([mutationId, mutationId]);
  });

  test("does not enter Authority when disposal wins an attachment race", async () => {
    const harness = createHarness();
    const attachment = harness.adapter.attachTurn(turnAttachment());
    harness.adapter.dispose();

    await expect(attachment).rejects.toThrow("disposed");
    expect(harness.authority).toHaveLength(0);
  });

  test("does not revive local state when disposal follows an entered Authority write", async () => {
    const harness = createHarness({ holdAuthority: true });
    const attachment = harness.adapter.attachTurn(turnAttachment());
    await harness.authorityEntered;
    harness.adapter.dispose();
    harness.releaseAuthority();

    await expect(attachment).resolves.toBeUndefined();
    expect(harness.authority).toHaveLength(1);
    await expect(
      harness.adapter.handleNotification("turn/completed", {
        threadId: THREAD_ID,
        turn: { id: TURN_ID, status: "completed" },
      }),
    ).rejects.toThrow("disposed");
  });

  test.each(["item", "patch", "plan", "resolved request", "terminal"] as const)(
    "reuses the first %s intent after an ambiguous Authority result",
    async (kind) => {
      const harness = createHarness();
      await registerTurn(harness.adapter);
      let method: string;
      let params: Record<string, unknown>;
      let expectedEntity: AuthorityOperation["entity"];

      switch (kind) {
        case "item":
          method = "item/completed";
          params = {
            item: { id: "message-1", text: "hello", type: "agentMessage" },
            threadId: THREAD_ID,
            turnId: TURN_ID,
          };
          expectedEntity = "item";
          break;
        case "patch":
          method = "item/fileChange/patchUpdated";
          params = {
            changes: [{ diff: "+hello", kind: { type: "add" }, path: "hello.txt" }],
            itemId: "change-1",
            threadId: THREAD_ID,
            turnId: TURN_ID,
          };
          expectedEntity = "item";
          break;
        case "plan":
          method = "turn/plan/updated";
          params = {
            explanation: "work",
            plan: [{ status: "inProgress", step: "inspect" }],
            threadId: THREAD_ID,
            turnId: TURN_ID,
          };
          expectedEntity = "item";
          break;
        case "resolved request":
          await harness.adapter.handleServerRequest(
            "item/tool/requestUserInput",
            61,
            userInputRequest(),
          );
          method = "serverRequest/resolved";
          params = { requestId: 61, threadId: THREAD_ID };
          expectedEntity = "interaction";
          break;
        case "terminal":
          method = "turn/completed";
          params = {
            threadId: THREAD_ID,
            turn: {
              id: TURN_ID,
              items: [],
              itemsView: "notLoaded",
              status: "completed",
            },
          };
          expectedEntity = "run";
          break;
      }

      harness.rejectNextAuthorityAfterCommit();
      await expect(harness.adapter.handleNotification(method, params)).rejects.toThrow(
        "result lost",
      );
      const first = harness.authority.at(-1)!;
      harness.advance(1_000);
      await expect(
        harness.adapter.handleNotification(method, structuredClone(params)),
      ).resolves.toBeUndefined();

      const retries = harness.authority.slice(-2);
      expect(retries.map((update) => update.mutationId)).toEqual([
        first.mutationId,
        first.mutationId,
      ]);
      expect(retries.map((update) => update.operations)).toEqual([
        first.operations,
        first.operations,
      ]);
      expect(first.operations.some((operation) => operation.entity === expectedEntity)).toBe(true);
      expect(JSON.stringify(first.operations)).toContain("2026-07-16T08:00:00.000Z");
    },
  );

  test.each([
    [
      "encoded Run",
      { maxBytes: 1_500, maxInlineBytes: 1_024 },
      [{ text: "x".repeat(2_048), type: "text" as const }],
      "encoded byte limit",
    ],
    [
      "inline Blob",
      { maxBytes: 10_000, maxInlineBytes: 1 },
      [{ data: "aGVsbG8=", mediaType: "text/plain", type: "inline_blob" as const }],
      "inline Blob",
    ],
  ] as const)(
    "rejects an oversized attachment %s before Authority",
    async (_, limits, input, error) => {
      const harness = createHarness({ admissionLimits: limits });

      await expect(
        harness.adapter.attachTurn({
          ...turnAttachment(),
          run: { ...turnAttachment().run, input: [...input] },
        }),
      ).rejects.toThrow(error);
      expect(harness.authority).toHaveLength(0);
    },
  );

  test("projects streaming text as Preview and repairs dropped Preview with the final Item", async () => {
    const harness = createHarness({ previewReplaceIntervalMs: 1_000 });
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/started", {
      item: { id: "message-1", phase: "final_answer", text: "", type: "agentMessage" },
      startedAtMs: Date.parse("2026-07-16T08:00:00.100Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/agentMessage/delta", {
      delta: "hel",
      itemId: "message-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    harness.advance(1_100);
    await harness.adapter.handleNotification("item/agentMessage/delta", {
      delta: "lo",
      itemId: "message-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(harness.previews.map((entry) => previewUpdateSchema.parse(entry.update))).toEqual([
      {
        channel: "message.text",
        fromSequence: 1,
        itemId: "message-1",
        op: "append",
        segment: 0,
        streamId: "message.text",
        text: "hel",
        throughSequence: 1,
      },
      {
        channel: "message.text",
        itemId: "message-1",
        op: "replace",
        segment: 0,
        streamId: "message.text",
        text: "hello",
        throughSequence: 2,
      },
    ]);

    await harness.adapter.handleNotification("item/completed", {
      completedAtMs: Date.parse("2026-07-16T08:00:01.300Z"),
      item: {
        id: "message-1",
        phase: "final_answer",
        text: "hello",
        type: "agentMessage",
      },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("turn/completed", {
      threadId: THREAD_ID,
      turn: {
        completedAt: Date.parse("2026-07-16T08:00:01.400Z") / 1_000,
        error: null,
        id: TURN_ID,
        items: [],
        itemsView: "notLoaded",
        startedAt: Date.parse("2026-07-16T08:00:00.000Z") / 1_000,
        status: "completed",
      },
    });

    const snapshot = harness.snapshot();
    expect(snapshot.runs).toMatchObject([
      { finishReason: "success", id: RUN_ID, status: "completed" },
    ]);
    expect(snapshot.items.map((item) => itemSchema.parse(item))).toMatchObject([
      {
        content: [{ text: "hello", type: "text" }],
        id: "message-1",
        kind: "message",
        phase: "final",
        role: "agent",
        status: "completed",
      },
    ]);

    await harness.adapter.handleNotification("item/agentMessage/delta", {
      delta: "late",
      itemId: "message-1",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(harness.previews).toHaveLength(2);
  });

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

  test("uses an empty file-change snapshot to clear prior active changes", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/fileChange/patchUpdated", {
      changes: [{ diff: "+old", kind: { type: "add" }, path: "old.txt" }],
      itemId: "change-clear",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/fileChange/patchUpdated", {
      changes: [],
      itemId: "change-clear",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({ changes: [], id: "change-clear", status: "active" }),
    );
  });

  test("retains sub-agent activity input", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/started", {
      item: {
        agentPath: "researcher",
        agentThreadId: "child-thread",
        id: "sub-agent-1",
        kind: "spawn",
        status: "inProgress",
        type: "subAgentActivity",
      },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({
        input: {
          agentPath: "researcher",
          agentThreadId: "child-thread",
          kind: "spawn",
        },
        name: "sub_agent_activity",
      }),
    );
  });

  test("preserves unrecognized native Item data in an Extension Item", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/completed", {
      item: {
        id: "review-1",
        review: "Check authentication boundaries.",
        type: "enteredReviewMode",
      },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(harness.snapshot().items[0]).toMatchObject({
      kind: "extension",
      status: "completed",
      value: {
        id: "review-1",
        review: "Check authentication boundaries.",
        type: "enteredReviewMode",
      },
    });
  });

  test("projects interactive server requests and maps protected resolutions back to app-server", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/started", {
      item: {
        aggregatedOutput: null,
        command: "git status",
        id: "command-1",
        status: "inProgress",
        type: "commandExecution",
      },
      startedAtMs: Date.parse("2026-07-16T08:00:00.100Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    const approvalId = await harness.adapter.handleServerRequest(
      "item/commandExecution/requestApproval",
      7,
      {
        command: "git status",
        itemId: "command-1",
        reason: "Needs approval",
        startedAtMs: Date.parse("2026-07-16T08:00:00.200Z"),
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
    );

    expect(approvalId).not.toBeNull();
    expect(
      interactionSchema.parse(
        harness.snapshot().interactions.find((interaction) => interaction.id === approvalId),
      ),
    ).toMatchObject({
      itemId: "command-1",
      kind: "permission",
      status: "open",
    });
    const approvalResolution = {
      kind: "permission",
      value: { optionId: "accept_session", type: "selected" },
    } satisfies InteractionResolution;
    harness.settleInteraction(approvalId!, approvalResolution);
    expect(harness.adapter.resolveInteraction(approvalId!, approvalResolution)).toEqual({
      id: 7,
      result: { decision: "acceptForSession" },
    });

    const restrictedApprovalId = await harness.adapter.handleServerRequest(
      "item/commandExecution/requestApproval",
      70,
      {
        availableDecisions: ["accept", "decline"],
        command: "git status",
        itemId: "command-1",
        reason: "Needs approval",
        startedAtMs: Date.parse("2026-07-16T08:00:00.200Z"),
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
    );
    expect(
      harness
        .snapshot()
        .interactions.find((interaction) => interaction.id === restrictedApprovalId),
    ).toMatchObject({
      request: {
        options: [{ id: "accept_once" }, { id: "decline" }],
      },
    });
    expect(() =>
      harness.adapter.resolveInteraction(restrictedApprovalId!, {
        kind: "permission",
        value: { optionId: "accept_session", type: "selected" },
      }),
    ).toThrow("unavailable option");
    const restrictedResolution = {
      kind: "permission",
      value: { optionId: "accept_once", type: "selected" },
    } satisfies InteractionResolution;
    harness.settleInteraction(restrictedApprovalId!, restrictedResolution);
    expect(harness.adapter.resolveInteraction(restrictedApprovalId!, restrictedResolution)).toEqual(
      { id: 70, result: { decision: "accept" } },
    );

    const inputId = await harness.adapter.handleServerRequest("item/tool/requestUserInput", 8, {
      autoResolutionMs: 60_000,
      itemId: "command-1",
      questions: [
        {
          header: "Mode",
          id: "mode",
          isOther: true,
          isSecret: false,
          options: [{ description: "Fast", label: "quick" }],
          question: "Which mode?",
        },
      ],
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    const inputResolution: InteractionResolution = {
      kind: "input",
      value: { answers: { mode: ["0"] }, type: "answered" },
    };
    expect(
      harness.snapshot().interactions.find((interaction) => interaction.id === inputId),
    ).toMatchObject({
      kind: "input",
      request: {
        questions: [
          {
            allowOther: true,
            options: [{ id: "0", label: "quick" }],
          },
        ],
      },
    });
    harness.settleInteraction(inputId!, inputResolution);
    expect(harness.adapter.resolveInteraction(inputId!, inputResolution)).toEqual({
      id: 8,
      result: { answers: { mode: { answers: ["quick"] } } },
    });

    await harness.adapter.handleNotification("item/started", {
      item: {
        arguments: { path: "README.md" },
        contentItems: null,
        durationMs: null,
        id: "call-1",
        namespace: "fs",
        status: "inProgress",
        success: null,
        tool: "read_file",
        type: "dynamicToolCall",
      },
      startedAtMs: Date.parse("2026-07-16T08:00:00.300Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    const toolId = await harness.adapter.handleServerRequest("item/tool/call", "tool-request", {
      arguments: { path: "README.md" },
      callId: "call-1",
      namespace: "fs",
      threadId: THREAD_ID,
      tool: "read_file",
      turnId: TURN_ID,
    });
    expect(
      harness.snapshot().interactions.find((interaction) => interaction.id === toolId),
    ).toMatchObject({
      itemId: "call-1",
    });
    const toolResolution = {
      kind: "tool",
      value: {
        output: [{ text: "contents", type: "text" }],
        type: "completed",
      },
    } satisfies InteractionResolution;
    harness.settleInteraction(toolId!, toolResolution);
    expect(harness.adapter.resolveInteraction(toolId!, toolResolution)).toEqual({
      id: "tool-request",
      result: {
        contentItems: [{ text: "contents", type: "inputText" }],
        success: true,
      },
    });
    await harness.adapter.handleNotification("item/completed", {
      completedAtMs: Date.parse("2026-07-16T08:00:00.400Z"),
      item: {
        arguments: { path: "README.md" },
        contentItems: [{ text: "contents", type: "inputText" }],
        durationMs: 100,
        id: "call-1",
        namespace: "fs",
        status: "completed",
        success: true,
        tool: "read_file",
        type: "dynamicToolCall",
      },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(harness.snapshot().items.find((item) => item.id === "call-1")).toMatchObject({
      kind: "tool",
      name: "fs/read_file",
      output: [{ text: "contents", type: "text" }],
      status: "completed",
    });

    const elicitationId = await harness.adapter.handleServerRequest(
      "mcpServer/elicitation/request",
      "elicitation-request",
      {
        _meta: null,
        message: "Choose a region",
        mode: "form",
        requestedSchema: {
          properties: { region: { type: "string" } },
          required: ["region"],
          type: "object",
        },
        serverName: "deployment",
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
    );
    expect(
      harness.snapshot().interactions.find((interaction) => interaction.id === elicitationId),
    ).toMatchObject({
      kind: "extension",
      name: OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION,
      request: { message: "Choose a region", mode: "form", serverName: "deployment" },
    });
    const elicitationResolution = {
      kind: "extension",
      name: OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION,
      value: { _meta: null, action: "accept", content: { region: "eu" } },
    } satisfies InteractionResolution;
    harness.settleInteraction(elicitationId!, elicitationResolution);
    expect(harness.adapter.resolveInteraction(elicitationId!, elicitationResolution)).toEqual({
      id: "elicitation-request",
      result: { _meta: null, action: "accept", content: { region: "eu" } },
    });
    expect(
      harness.snapshot().interactions.every((interaction) => interaction.status !== "open"),
    ).toBe(true);
  });

  test.each([
    { expectedMs: 500, requestedMs: 500 },
    { expectedMs: 1_000, requestedMs: 5_000 },
    { expectedMs: 1_000, requestedMs: 1.5 },
    { expectedMs: 1_000, requestedMs: null },
  ])(
    "bounds provider interaction timeout $requestedMs -> $expectedMs ms",
    async ({ expectedMs, requestedMs }) => {
      const harness = createHarness({ interactionTimeoutMs: 1_000 });
      await registerTurn(harness.adapter);
      await harness.adapter.handleServerRequest(
        "item/tool/requestUserInput",
        50,
        userInputRequest(requestedMs),
      );

      expect(harness.snapshot().interactions[0]?.expiresAt).toBe(
        new Date(Date.parse("2026-07-16T08:00:00.000Z") + expectedMs).toISOString(),
      );
    },
  );

  test("deduplicates a pending native request before creating Authority state", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    const before = harness.authority.length;
    const first = await harness.adapter.handleServerRequest(
      "item/tool/requestUserInput",
      51,
      userInputRequest(),
    );
    const second = await harness.adapter.handleServerRequest(
      "item/tool/requestUserInput",
      51,
      userInputRequest(),
    );

    expect(second).toBe(first);
    expect(harness.authority).toHaveLength(before + 1);
    expect(harness.snapshot().interactions).toHaveLength(1);
  });

  test("keeps a native request identity after an ambiguous Authority result", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    const request = userInputRequest();
    harness.rejectNextAuthorityAfterCommit();

    await expect(
      harness.adapter.handleServerRequest("item/tool/requestUserInput", 52, request),
    ).rejects.toThrow("result lost");
    const interactionId = harness.snapshot().interactions[0]?.id;
    await expect(
      harness.adapter.handleServerRequest("item/tool/requestUserInput", 52, request),
    ).resolves.toBe(interactionId);

    expect(harness.snapshot().interactions).toHaveLength(1);
    expect(
      harness.authority
        .slice(-2)
        .map((update) => update.operations[0])
        .map((operation) => (operation?.op === "put" ? operation.value.id : null)),
    ).toEqual([interactionId, interactionId]);
  });

  test.each([
    [
      "item identity",
      (request: ReturnType<typeof userInputRequest>) => ({ ...request, itemId: "input-2" }),
    ],
    [
      "question payload",
      (request: ReturnType<typeof userInputRequest>) => ({
        ...request,
        questions: [{ ...request.questions[0]!, question: "Changed?" }],
      }),
    ],
  ] as const)(
    "rejects a replay that changes the pending native request %s",
    async (_name, change) => {
      const harness = createHarness();
      await registerTurn(harness.adapter);
      const request = userInputRequest();
      await harness.adapter.handleServerRequest("item/tool/requestUserInput", 51, request);
      const before = harness.authority.length;

      await expect(
        harness.adapter.handleServerRequest("item/tool/requestUserInput", 51, change(request)),
      ).rejects.toThrow("changed identity");
      expect(harness.authority).toHaveLength(before);
      expect(harness.snapshot().interactions).toHaveLength(1);
    },
  );

  test("snapshots protected native request data before waiting for a decision", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    const params = {
      environmentId: null,
      itemId: "permission-1",
      permissions: { fileSystem: { read: ["/safe"] } },
      reason: "Read a directory",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    };
    const interactionId = await harness.adapter.handleServerRequest(
      "item/permissions/requestApproval",
      53,
      params,
    );
    params.permissions.fileSystem.read[0] = "/changed";
    const resolution = {
      kind: "permission",
      value: { optionId: "accept_once", type: "selected" },
    } satisfies InteractionResolution;
    harness.settleInteraction(interactionId!, resolution);

    expect(harness.adapter.resolveInteraction(interactionId!, resolution)).toEqual({
      id: 53,
      result: {
        permissions: { fileSystem: { read: ["/safe"] } },
        scope: "turn",
      },
    });
  });

  test("rejects a native request before commit when protected pending data exceeds its budget", async () => {
    const harness = createHarness({ maxPendingServerRequestBytes: 1 });
    await registerTurn(harness.adapter);
    const before = harness.authority.length;

    await expect(
      harness.adapter.handleServerRequest("item/tool/requestUserInput", 52, userInputRequest()),
    ).rejects.toThrow("pending request budget");
    expect(harness.authority).toHaveLength(before);
    expect(harness.snapshot().interactions).toHaveLength(0);
  });

  test("projects generated images as stable Tool items with renderable output", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/started", {
      item: {
        id: "image-1",
        result: "",
        revisedPrompt: null,
        status: "inProgress",
        type: "imageGeneration",
      },
      startedAtMs: Date.parse("2026-07-16T08:00:00.100Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/completed", {
      completedAtMs: Date.parse("2026-07-16T08:00:00.200Z"),
      item: {
        id: "image-1",
        result: "aGVsbG8=",
        revisedPrompt: "A blue whale",
        savedPath: "/workspace/whale.png",
        status: "completed",
        type: "imageGeneration",
      },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(harness.snapshot().items.find((item) => item.id === "image-1")).toMatchObject({
      input: { revisedPrompt: "A blue whale" },
      kind: "tool",
      locations: [{ path: "/workspace/whale.png" }],
      name: "image_generation",
      output: [{ data: "aGVsbG8=", mediaType: "image/png", type: "inline_blob" }],
      status: "completed",
    });
  });

  test.each([
    [
      "encoded Item",
      { maxBytes: 1_500, maxInlineBytes: 1_024 },
      {
        item: { id: "message-oversized", text: "x".repeat(2_048), type: "agentMessage" },
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
      "encoded byte limit",
    ],
    [
      "inline Blob",
      { maxBytes: 10_000, maxInlineBytes: 1 },
      {
        item: {
          id: "image-oversized",
          result: "aGVsbG8=",
          revisedPrompt: null,
          status: "completed",
          type: "imageGeneration",
        },
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
      "inline Blob",
    ],
  ] as const)(
    "rejects an oversized projected %s before Authority",
    async (_, limits, params, error) => {
      const harness = createHarness({ admissionLimits: limits });
      await registerTurn(harness.adapter);
      const before = harness.authority.length;

      await expect(harness.adapter.handleNotification("item/completed", params)).rejects.toThrow(
        error,
      );
      expect(harness.authority).toHaveLength(before);
      expect(harness.snapshot().items).toHaveLength(0);
    },
  );

  test("preserves multi-agent routing and status in Agent Tool items", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    const base = {
      agentsStates: {},
      id: "agent-call-1",
      model: "gpt-5",
      prompt: "Inspect the adapter",
      reasoningEffort: "high",
      receiverThreadIds: ["child-1"],
      senderThreadId: THREAD_ID,
      tool: "spawnAgent",
      type: "collabAgentToolCall",
    };
    await harness.adapter.handleNotification("item/started", {
      item: { ...base, status: "inProgress" },
      startedAtMs: Date.parse("2026-07-16T08:00:00.100Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/completed", {
      completedAtMs: Date.parse("2026-07-16T08:00:00.200Z"),
      item: {
        ...base,
        agentsStates: { "child-1": { message: "Done", status: "completed" } },
        status: "completed",
      },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(harness.snapshot().items.find((item) => item.id === "agent-call-1")).toMatchObject({
      category: "agent",
      input: {
        prompt: "Inspect the adapter",
        receiverThreadIds: ["child-1"],
        senderThreadId: THREAD_ID,
      },
      kind: "tool",
      name: "spawnAgent",
      status: "completed",
      structuredOutput: { "child-1": { message: "Done", status: "completed" } },
    });
  });

  test("atomically expires unresolved interactions before a cancelled Run", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/started", {
      item: {
        aggregatedOutput: "",
        command: "sleep 10",
        id: "command-1",
        status: "inProgress",
        type: "commandExecution",
      },
      startedAtMs: Date.parse("2026-07-16T08:00:00.100Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleServerRequest("item/commandExecution/requestApproval", 9, {
      command: "sleep 10",
      itemId: "command-1",
      startedAtMs: Date.parse("2026-07-16T08:00:00.200Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleServerRequest("mcpServer/elicitation/request", 90, {
      _meta: null,
      message: "Confirm",
      mode: "url",
      elicitationId: "external-1",
      serverName: "deployment",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      url: "https://example.com/confirm",
    });
    await harness.adapter.handleNotification("turn/completed", {
      threadId: THREAD_ID,
      turn: {
        completedAt: Date.parse("2026-07-16T08:00:00.500Z") / 1_000,
        error: null,
        id: TURN_ID,
        items: [],
        itemsView: "notLoaded",
        startedAt: Date.parse("2026-07-16T08:00:00.000Z") / 1_000,
        status: "interrupted",
      },
    });

    expect(harness.snapshot().runs[0]).toMatchObject({ id: RUN_ID, status: "cancelled" });
    expect(harness.snapshot().items[0]).toMatchObject({
      id: "command-1",
      status: "cancelled",
    });
    expect(harness.snapshot().interactions).toEqual([
      expect.objectContaining({ kind: "permission", status: "expired" }),
      expect.objectContaining({ kind: "extension", status: "expired" }),
    ]);
    expect(
      harness.snapshot().interactions.every((interaction) => interaction.resolution === undefined),
    ).toBe(true);
  });

  test("expires an overdue interaction while closing its Run", async () => {
    const harness = createHarness({ interactionTimeoutMs: 100 });
    await registerTurn(harness.adapter);
    await harness.adapter.handleServerRequest("item/tool/requestUserInput", 10, {
      autoResolutionMs: null,
      itemId: "input-1",
      questions: [
        {
          header: "Name",
          id: "name",
          isOther: false,
          isSecret: false,
          options: null,
          question: "Your name?",
        },
      ],
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    harness.advance(101);
    await harness.adapter.handleNotification("turn/completed", {
      threadId: THREAD_ID,
      turn: {
        completedAt: Date.parse("2026-07-16T08:00:00.101Z") / 1_000,
        error: null,
        id: TURN_ID,
        items: [],
        itemsView: "full",
        startedAt: Date.parse("2026-07-16T08:00:00.000Z") / 1_000,
        status: "completed",
      },
    });

    expect(harness.snapshot().interactions[0]).toMatchObject({
      status: "expired",
    });
    expect(harness.snapshot().interactions[0]).not.toHaveProperty("resolution");
  });

  test("closes an Interaction when app-server reports its request resolved elsewhere", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    const interactionId = await harness.adapter.handleServerRequest(
      "item/tool/requestUserInput",
      11,
      {
        autoResolutionMs: null,
        itemId: "input-1",
        questions: [
          {
            header: "Name",
            id: "name",
            isOther: false,
            isSecret: false,
            options: [],
            question: "Your name?",
          },
        ],
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
    );

    expect(
      harness.snapshot().interactions.find((interaction) => interaction.id === interactionId),
    ).toMatchObject({
      request: { questions: [{ id: "name", type: "text" }] },
      status: "open",
    });

    await harness.adapter.handleNotification("serverRequest/resolved", {
      requestId: 11,
      threadId: THREAD_ID,
    });

    expect(
      harness.snapshot().interactions.find((interaction) => interaction.id === interactionId),
    ).toMatchObject({ status: "expired" });
    expect(
      harness.adapter.resolveInteraction(interactionId!, {
        kind: "input",
        value: { type: "cancelled" },
      }),
    ).toBeNull();
  });

  test("fails closed when a successful Turn omits an active Item snapshot", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/started", {
      item: {
        aggregatedOutput: "",
        command: "pwd",
        id: "command-1",
        status: "inProgress",
        type: "commandExecution",
      },
      startedAtMs: Date.parse("2026-07-16T08:00:00.100Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("turn/completed", {
      threadId: THREAD_ID,
      turn: {
        completedAt: Date.parse("2026-07-16T08:00:00.200Z") / 1_000,
        error: null,
        id: TURN_ID,
        items: [],
        itemsView: "full",
        startedAt: Date.parse("2026-07-16T08:00:00.000Z") / 1_000,
        status: "completed",
      },
    });

    expect(harness.snapshot().items[0]).toMatchObject({
      error: { code: "openai.turn.incomplete" },
      status: "failed",
    });
    expect(harness.snapshot().runs[0]).toMatchObject({
      error: { code: "openai.turn.incomplete" },
      status: "failed",
    });
  });

  test("uses receipt time instead of untrusted provider lifecycle clocks", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    await harness.adapter.handleNotification("item/started", {
      item: { id: "message-1", text: "", type: "agentMessage" },
      startedAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("item/completed", {
      completedAtMs: Date.parse("2000-01-01T00:00:00.000Z"),
      item: { id: "message-1", text: "done", type: "agentMessage" },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await harness.adapter.handleNotification("turn/completed", {
      threadId: THREAD_ID,
      turn: {
        completedAt: Date.parse("1999-01-01T00:00:00.000Z") / 1_000,
        error: null,
        id: TURN_ID,
        items: [],
        itemsView: "notLoaded",
        startedAt: Date.parse("2099-01-01T00:00:00.000Z") / 1_000,
        status: "completed",
      },
    });

    expect(harness.snapshot().items[0]).toMatchObject({
      createdAt: "2026-07-16T08:00:00.000Z",
      endedAt: "2026-07-16T08:00:00.000Z",
      updatedAt: "2026-07-16T08:00:00.000Z",
    });
    expect(harness.snapshot().runs[0]).toMatchObject({
      endedAt: "2026-07-16T08:00:00.000Z",
      status: "completed",
    });
  });

  test("disposal releases all in-memory projection state", async () => {
    const harness = createHarness();
    await registerTurn(harness.adapter);
    harness.adapter.dispose();

    await expect(
      harness.adapter.handleNotification("turn/completed", {
        threadId: THREAD_ID,
        turn: { id: TURN_ID, status: "completed" },
      }),
    ).rejects.toThrow("disposed");
  });

  test.each([Number.POSITIVE_INFINITY, 1.5])("rejects invalid resource limit %p", (value) => {
    expect(() => createHarness({ previewCheckpointBytes: value })).toThrow("finite and positive");
  });
});
