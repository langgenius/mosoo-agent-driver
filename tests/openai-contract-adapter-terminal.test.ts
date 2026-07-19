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
});
