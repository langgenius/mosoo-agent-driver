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
    async (kind: "item" | "patch" | "plan" | "resolved request" | "terminal") => {
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
});
