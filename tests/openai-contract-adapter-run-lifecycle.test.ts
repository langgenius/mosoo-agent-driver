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
