import { describe, expect, test } from "bun:test";
import type {
  CreateTerminalRequest,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionNotification,
} from "@agentclientprotocol/sdk";

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
  Run,
  SessionSnapshot,
} from "../src/contract";
import { AcpV1ContractAdapter, toConfigOptions } from "../src/runtimes/acp/v1-contract-adapter";
import {
  type ContractAuthorityUpdate,
  type ContractPreviewUpdate,
} from "../src/runtimes/contract-projection";

const SESSION_ID = protocolId(1);
const RUN_ID = protocolId(2);
const NATIVE_SESSION_ID = "native-session-1";

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
  previewCheckpointBytes?: number,
  maxPendingPermissionBytes?: number,
  beforeAuthority?: (update: ContractAuthorityUpdate) => Promise<void>,
  afterAuthority?: (update: ContractAuthorityUpdate) => Promise<void>,
) {
  let nowMs = Date.parse("2026-07-16T08:00:00.000Z");
  let snapshot = createInitialSnapshot(new Date(nowMs).toISOString());
  let nextId = 100;
  const authority: ContractAuthorityUpdate[] = [];
  const committedMutationIds = new Set<string>();
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
  const adapter = new AcpV1ContractAdapter({
    authority: async (update) => {
      await beforeAuthority?.(update);
      authority.push(update);
      if (!committedMutationIds.has(update.mutationId)) {
        committedMutationIds.add(update.mutationId);
        commit(update.cause, [...update.operations] as AuthorityOperation[]);
      }
      try {
        await afterAuthority?.(update);
      } catch (cause) {
        throw new AuthorityOutcomeUnknownError(
          cause instanceof Error ? cause.message : "Authority outcome is unknown.",
          { cause },
        );
      }
    },
    createId: () => protocolId(nextId++),
    interactionTimeoutMs,
    maxPendingPermissionBytes,
    nativeSessionId: NATIVE_SESSION_ID,
    now: () => new Date(nowMs),
    preview: (update) => previews.push(update),
    previewCheckpointBytes,
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

async function registerRun(adapter: AcpV1ContractAdapter): Promise<void> {
  adapter.attachRun(activeRun("2026-07-16T08:00:00.000Z"));
}

function notification(update: SessionNotification["update"]): SessionNotification {
  return { sessionId: NATIVE_SESSION_ID, update };
}

describe("ACP V1 Contract adapter", () => {
  test("preserves streamed rich-content order and repairs Preview at prompt completion", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: { text: "hello ", type: "text" },
        messageId: "message-1",
        sessionUpdate: "agent_message_chunk",
      }),
    );
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: { data: "aA==", mimeType: "image/png", type: "image" },
        messageId: "message-1",
        sessionUpdate: "agent_message_chunk",
      }),
    );
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: { text: "world", type: "text" },
        messageId: "message-1",
        sessionUpdate: "agent_message_chunk",
      }),
    );
    await harness.adapter.completePrompt(RUN_ID, {
      stopReason: "end_turn",
      usage: {
        cachedReadTokens: 2,
        inputTokens: 3,
        outputTokens: 5,
        thoughtTokens: 1,
        totalTokens: 8,
      },
    });

    expect(harness.previews.map((entry) => entry.update)).toMatchObject([
      { op: "append", segment: 0, text: "hello " },
      { op: "append", segment: 2, text: "world" },
    ]);
    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({
        content: [
          { text: "hello ", type: "text" },
          { data: "aA==", mediaType: "image/png", type: "inline_blob" },
          { text: "world", type: "text" },
        ],
        id: "message:message-1",
        kind: "message",
        status: "completed",
      }),
    );
    expect(harness.snapshot().runs[0]).toMatchObject({
      finishReason: "success",
      status: "completed",
      usage: {
        cachedInput: 2,
        input: 3,
        output: 5,
        reasoning: 1,
        total: 8,
      },
    });
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["non-finite", Number.POSITIVE_INFINITY],
  ] as const)("ignores %s prompt usage without blocking the Run terminal", async (_name, value) => {
    const harness = createHarness();
    await registerRun(harness.adapter);

    await harness.adapter.completePrompt(RUN_ID, {
      stopReason: "end_turn",
      usage: {
        cachedReadTokens: value,
        inputTokens: value,
        outputTokens: value,
        thoughtTokens: value,
        totalTokens: value,
      },
    });

    expect(harness.snapshot().runs[0]).toMatchObject({
      finishReason: "success",
      status: "completed",
    });
    expect(harness.snapshot().runs[0]).not.toHaveProperty("usage");
  });

  test("retains valid prompt usage while omitting malformed fields", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);

    await harness.adapter.completePrompt(RUN_ID, {
      stopReason: "end_turn",
      usage: {
        cachedReadTokens: 1.5,
        inputTokens: -1,
        outputTokens: 2,
        thoughtTokens: Number.MAX_SAFE_INTEGER + 1,
        totalTokens: 2,
      },
    });

    expect(harness.snapshot().runs[0]).toMatchObject({
      finishReason: "success",
      status: "completed",
      usage: { output: 2, total: 2 },
    });
  });

  test("projects tool diffs and terminal snapshots, then treats request limits as limits", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: [
          {
            newText: "new\n",
            oldText: "old\n",
            path: "/workspace/file.txt",
            type: "diff",
          },
          { terminalId: "terminal-1", type: "terminal" },
        ],
        kind: "execute",
        rawInput: { command: "printf new" },
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: "Update file",
        toolCallId: "tool-1",
      }),
    );
    await harness.adapter.handleTerminalOutput(RUN_ID, "terminal-1", {
      exitStatus: { exitCode: 0, signal: null },
      output: "new\n",
      truncated: false,
    });
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        rawOutput: { changed: true },
        sessionUpdate: "tool_call_update",
        status: "completed",
        toolCallId: "tool-1",
      }),
    );
    await harness.adapter.completePrompt(RUN_ID, { stopReason: "max_turn_requests" });

    expect(harness.snapshot().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tool:tool-1",
          kind: "tool",
          status: "completed",
          structuredOutput: { changed: true },
          terminalItemId: "terminal:terminal-1",
        }),
        expect.objectContaining({
          changes: [
            expect.objectContaining({
              operation: "update",
              path: "/workspace/file.txt",
            }),
          ],
          id: "change:tool-1",
          kind: "change",
          status: "completed",
        }),
        expect.objectContaining({
          exitCode: 0,
          id: "terminal:terminal-1",
          kind: "terminal",
          status: "completed",
          stdout: [{ text: "new\n", type: "text" }],
        }),
      ]),
    );
    expect(harness.snapshot().runs[0]).toMatchObject({
      finishReason: "limit",
      status: "completed",
    });
  });

  test("translates accepted permission decisions and leaves deadline ownership to the Coordinator", async () => {
    const harness = createHarness(1_000);
    await registerRun(harness.adapter);
    const request = {
      options: [
        { kind: "allow_once", name: "Allow", optionId: "yes" },
        { kind: "reject_once", name: "Deny", optionId: "no" },
      ],
      sessionId: NATIVE_SESSION_ID,
      toolCall: {
        title: "Run command",
        toolCallId: "tool-1",
      },
    } satisfies RequestPermissionRequest;
    const interactionId = await harness.adapter.openPermission(RUN_ID, request);
    expect(await harness.adapter.openPermission(RUN_ID, request)).toBe(interactionId);
    expect(harness.snapshot().interactions).toHaveLength(1);
    const interaction = harness.snapshot().interactions.find((entry) => entry.id === interactionId);
    const allowId =
      interaction?.kind === "permission"
        ? interaction.request.options.find((option) => option.effect === "allow")?.id
        : undefined;
    const resolution = {
      kind: "permission",
      value: { optionId: allowId!, type: "selected" },
    } satisfies InteractionResolution;

    harness.settleInteraction(interactionId, resolution);
    await expect(harness.adapter.resolveInteraction(interactionId, resolution)).resolves.toEqual({
      outcome: { optionId: "yes", outcome: "selected" },
    });
    expect(
      harness.snapshot().interactions.find((entry) => entry.id === interactionId),
    ).toMatchObject({ status: "resolved" });

    const lateId = await harness.adapter.openPermission(RUN_ID, {
      ...request,
      toolCall: { title: "Read file", toolCallId: "tool-2" },
    });
    harness.advance(1_001);
    harness.settleInteraction(lateId);
    await expect(
      harness.adapter.resolveInteraction(lateId, {
        kind: "permission",
        value: { type: "cancelled" },
      }),
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(harness.snapshot().interactions.find((entry) => entry.id === lateId)).toMatchObject({
      status: "expired",
    });

    await harness.adapter.completePrompt(RUN_ID, { stopReason: "cancelled" });
    expect(harness.snapshot().runs[0]?.status).toBe("cancelled");
    expect(harness.snapshot().interactions.every((entry) => entry.status !== "open")).toBe(true);
  });

  test.each([
    [
      "tool payload",
      (request: RequestPermissionRequest): RequestPermissionRequest => ({
        ...request,
        toolCall: { ...request.toolCall, title: "Changed command" },
      }),
    ],
    [
      "permission options",
      (request: RequestPermissionRequest): RequestPermissionRequest => ({
        ...request,
        options: [{ ...request.options[0]!, name: "Changed choice" }],
      }),
    ],
  ] as const)("rejects a permission replay with changed %s", async (_name, change) => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    const request = {
      options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
      sessionId: NATIVE_SESSION_ID,
      toolCall: { title: "Run command", toolCallId: "tool-replay" },
    } satisfies RequestPermissionRequest;
    await harness.adapter.openPermission(RUN_ID, request);
    const before = harness.authority.length;

    await expect(harness.adapter.openPermission(RUN_ID, change(request))).rejects.toThrow(
      "changed identity",
    );
    expect(harness.authority).toHaveLength(before);
    expect(harness.snapshot().interactions).toHaveLength(1);
  });

  test("bounds pending permission payloads and restores budget after resolution", async () => {
    const request = (toolCallId: string) =>
      ({
        options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
        sessionId: NATIVE_SESSION_ID,
        toolCall: { title: "Run command", toolCallId },
      }) satisfies RequestPermissionRequest;
    const firstRequest = request("tool-1");
    const secondRequest = request("tool-2");
    const maxPendingPermissionBytes = new TextEncoder().encode(
      JSON.stringify(firstRequest),
    ).byteLength;
    const harness = createHarness(5 * 60 * 1_000, undefined, maxPendingPermissionBytes);
    await registerRun(harness.adapter);
    const interactionId = await harness.adapter.openPermission(RUN_ID, firstRequest);
    const authorityCount = harness.authority.length;

    await expect(harness.adapter.openPermission(RUN_ID, secondRequest)).rejects.toThrow(
      "pending permission budget",
    );
    expect(harness.authority).toHaveLength(authorityCount);

    const resolution = {
      kind: "permission",
      value: { type: "cancelled" },
    } satisfies InteractionResolution;
    harness.settleInteraction(interactionId, resolution);
    await harness.adapter.resolveInteraction(interactionId, resolution);
    await expect(harness.adapter.openPermission(RUN_ID, secondRequest)).resolves.toBeDefined();
  });

  test("coalesces concurrent permission replays within one byte reservation", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const request = {
      options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
      sessionId: NATIVE_SESSION_ID,
      toolCall: { title: "Run command", toolCallId: "tool-concurrent" },
    } satisfies RequestPermissionRequest;
    const limit = new TextEncoder().encode(JSON.stringify(request)).byteLength;
    let first = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, limit, async () => {
      if (first) {
        first = false;
        blocked.resolve();
        await release.promise;
      }
    });
    await registerRun(harness.adapter);
    const firstPermission = harness.adapter.openPermission(RUN_ID, request);
    await blocked.promise;
    const secondPermission = harness.adapter.openPermission(RUN_ID, request);

    release.resolve();
    const [firstId, secondId] = await Promise.all([firstPermission, secondPermission]);
    expect(secondId).toBe(firstId);
    expect(harness.snapshot().interactions).toHaveLength(1);
  });

  test("retries the exact permission intent after an ambiguous authority result", async () => {
    let failAfterCommit = true;
    const harness = createHarness(
      5 * 60 * 1_000,
      undefined,
      undefined,
      undefined,
      async (update) => {
        if (failAfterCommit && update.event === "permission/requested") {
          failAfterCommit = false;
          throw new Error("ambiguous authority result");
        }
      },
    );
    await registerRun(harness.adapter);
    const request = {
      options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
      sessionId: NATIVE_SESSION_ID,
      toolCall: { title: "Run command", toolCallId: "tool-ambiguous" },
    } satisfies RequestPermissionRequest;

    await expect(harness.adapter.openPermission(RUN_ID, request)).rejects.toThrow("ambiguous");
    const first = harness.authority.filter((update) => update.event === "permission/requested")[0]!;
    harness.advance(1_000);
    await expect(
      harness.adapter.openPermission(RUN_ID, {
        ...request,
        toolCall: { ...request.toolCall, toolCallId: "tool-other" },
      }),
    ).rejects.toBeInstanceOf(AuthorityOutcomeUnknownError);
    await expect(harness.adapter.openPermission(RUN_ID, request)).resolves.toBe(
      (first.operations[0] as { value: { id: string } }).value.id,
    );
    const retries = harness.authority.filter((update) => update.event === "permission/requested");

    expect(retries).toHaveLength(2);
    expect(retries[1]).toEqual(first);
  });

  test.each(["cancelled", "selected"] as const)(
    "coordinates an unknown permission replay after the Interaction is %s",
    async (outcome) => {
      let loseResult = true;
      const request = {
        options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
        sessionId: NATIVE_SESSION_ID,
        toolCall: { title: "Run command", toolCallId: "tool-resolved-unknown" },
      } satisfies RequestPermissionRequest;
      const limit = new TextEncoder().encode(JSON.stringify(request)).byteLength;
      const harness = createHarness(
        5 * 60 * 1_000,
        undefined,
        limit,
        undefined,
        async (update) => {
          if (loseResult && update.event === "permission/requested") {
            loseResult = false;
            throw new Error("authority result lost");
          }
        },
      );
      await registerRun(harness.adapter);

      await expect(harness.adapter.openPermission(RUN_ID, request)).rejects.toBeInstanceOf(
        AuthorityOutcomeUnknownError,
      );
      const first = harness.authority.find((update) => update.event === "permission/requested")!;
      const interactionId = (first.operations[0] as { value: { id: string } }).value.id;
      const resolution =
        outcome === "selected"
          ? ({
              kind: "permission",
              value: { optionId: "permission-option:yes", type: "selected" },
            } satisfies InteractionResolution)
          : ({
              kind: "permission",
              value: { type: "cancelled" },
            } satisfies InteractionResolution);
      harness.settleInteraction(interactionId, resolution);
      await expect(harness.adapter.resolveInteraction(interactionId, resolution)).resolves.toEqual(
        outcome === "selected"
          ? { outcome: { optionId: "yes", outcome: "selected" } }
          : { outcome: { outcome: "cancelled" } },
      );
      await expect(
        harness.adapter.openPermission(RUN_ID, {
          ...request,
          toolCall: { ...request.toolCall, toolCallId: "tool-changed" },
        }),
      ).rejects.toBeInstanceOf(AuthorityOutcomeUnknownError);

      harness.advance(1_000);
      await expect(harness.adapter.openPermission(RUN_ID, request)).resolves.toBe(interactionId);
      const retries = harness.authority.filter(
        (update) => update.event === "permission/requested",
      );
      expect(retries).toEqual([first, first]);
      expect(harness.snapshot().interactions.find(({ id }) => id === interactionId)?.status).toBe(
        "resolved",
      );
      await expect(
        harness.adapter.openPermission(RUN_ID, {
          ...request,
          toolCall: { ...request.toolCall, toolCallId: "tool-next-permission" },
        }),
      ).resolves.toBeDefined();
    },
  );

  test("releases a retained permission budget when its unknown retry is definitely rejected", async () => {
    const request = (toolCallId: string) =>
      ({
        options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
        sessionId: NATIVE_SESSION_ID,
        toolCall: { title: "Run command", toolCallId },
      }) satisfies RequestPermissionRequest;
    const first = request("tool-a");
    const second = request("tool-b");
    const limit = new TextEncoder().encode(JSON.stringify(first)).byteLength;
    let rejectRetry = false;
    let loseFirstResult = true;
    const harness = createHarness(
      5 * 60 * 1_000,
      undefined,
      limit,
      async (update) => {
        if (rejectRetry && update.event === "permission/requested") {
          rejectRetry = false;
          throw new Error("authority unavailable");
        }
      },
      async (update) => {
        if (loseFirstResult && update.event === "permission/requested") {
          loseFirstResult = false;
          rejectRetry = true;
          throw new Error("authority result lost");
        }
      },
    );
    await registerRun(harness.adapter);

    await expect(harness.adapter.openPermission(RUN_ID, first)).rejects.toBeInstanceOf(
      AuthorityOutcomeUnknownError,
    );
    await expect(harness.adapter.openPermission(RUN_ID, first)).rejects.toThrow(
      "authority unavailable",
    );
    await expect(harness.adapter.openPermission(RUN_ID, second)).resolves.toBeDefined();
  });

  test("applies the permission byte budget atomically", async () => {
    const request = (toolCallId: string) =>
      ({
        options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
        sessionId: NATIVE_SESSION_ID,
        toolCall: { title: "Run command", toolCallId },
      }) satisfies RequestPermissionRequest;
    const firstRequest = request("tool-aaa");
    const secondRequest = request("tool-bbb");
    const limit = new TextEncoder().encode(JSON.stringify(firstRequest)).byteLength;
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, limit, async () => {
      if (first) {
        first = false;
        blocked.resolve();
        await release.promise;
      }
    });
    await registerRun(harness.adapter);
    const firstPermission = harness.adapter.openPermission(RUN_ID, firstRequest);
    await blocked.promise;
    const secondPermission = harness.adapter.openPermission(RUN_ID, secondRequest);
    let secondState: "pending" | "rejected" | "resolved" = "pending";
    void secondPermission.then(
      () => {
        secondState = "resolved";
      },
      () => {
        secondState = "rejected";
      },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(secondState).toBe("rejected");

    release.resolve();
    await expect(firstPermission).resolves.toBeDefined();
    await expect(secondPermission).rejects.toThrow("pending permission budget");
    expect(harness.snapshot().interactions).toHaveLength(1);
  });

  test.each([
    ["tool", "permission/requested.tool"],
    ["interaction", "permission/requested"],
  ] as const)(
    "releases permission budget after a definite %s Authority rejection",
    async (_stage, failedEvent) => {
      const request = (toolCallId: string) =>
        ({
          options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
          sessionId: NATIVE_SESSION_ID,
          toolCall: { title: "Run command", toolCallId },
        }) satisfies RequestPermissionRequest;
      const firstRequest = request("tool-aaa");
      const secondRequest = request("tool-bbb");
      const limit = new TextEncoder().encode(JSON.stringify(firstRequest)).byteLength;
      let fail = true;
      const harness = createHarness(5 * 60 * 1_000, undefined, limit, async (update) => {
        if (fail && update.event === failedEvent) {
          fail = false;
          throw new Error("authority unavailable");
        }
      });
      await registerRun(harness.adapter);

      await expect(harness.adapter.openPermission(RUN_ID, firstRequest)).rejects.toThrow(
        "authority unavailable",
      );
      const interactionId = await harness.adapter.openPermission(RUN_ID, secondRequest);
      const resolution = {
        kind: "permission",
        value: { type: "cancelled" },
      } satisfies InteractionResolution;
      harness.settleInteraction(interactionId, resolution);
      await harness.adapter.resolveInteraction(interactionId, resolution);
      await expect(harness.adapter.openPermission(RUN_ID, firstRequest)).resolves.toBeDefined();
    },
  );

  test("fails queued updates after the first projection failure", async () => {
    let attempts = 0;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "session/agent_message_chunk") {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("authority unavailable");
        }
      }
    });
    await registerRun(harness.adapter);
    const update = (messageId: string) =>
      harness.adapter.handleSessionUpdate(
        RUN_ID,
        notification({
          content: { text: messageId, type: "text" },
          messageId,
          sessionUpdate: "agent_message_chunk",
        }),
      );
    const settled = await Promise.allSettled([update("first"), update("second")]);

    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(attempts).toBe(1);
    await expect(
      harness.adapter.completePrompt(RUN_ID, { stopReason: "end_turn" }),
    ).rejects.toThrow("authority unavailable");
  });

  test("recovers an ambiguous session update after rejecting a changed retry", async () => {
    const mutationIds: string[] = [];
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "session/tool_call") {
        mutationIds.push(update.mutationId);

        if (mutationIds.length === 1) {
          throw new AuthorityOutcomeUnknownError("authority result lost");
        }
      }
    });
    await registerRun(harness.adapter);
    const tool = {
      content: [],
      kind: "execute",
      rawInput: { command: "true" },
      sessionUpdate: "tool_call",
      status: "in_progress",
      title: "Run command",
      toolCallId: "tool-1",
    } satisfies SessionNotification["update"];
    const update = notification(tool);
    await expect(harness.adapter.handleSessionUpdate(RUN_ID, update)).rejects.toThrow(
      "authority result lost",
    );
    harness.advance(1_000);

    await expect(
      harness.adapter.handleSessionUpdate(
        RUN_ID,
        notification({ ...tool, title: "Changed command" }),
      ),
    ).rejects.toThrow("changed while its outcome was unknown");
    expect(mutationIds).toHaveLength(1);

    await harness.adapter.handleSessionUpdate(RUN_ID, update);
    await harness.adapter.completePrompt(RUN_ID, { stopReason: "end_turn" });

    expect(mutationIds).toEqual([mutationIds[0], mutationIds[0]]);
    expect(harness.snapshot().runs[0]?.status).toBe("completed");
  });

  test("rejects a pre-admitted follower without locking out an explicit retry", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const mutationIds: string[] = [];
    let first = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event !== "session/tool_call") {
        return;
      }

      mutationIds.push(update.mutationId);
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
        throw new AuthorityOutcomeUnknownError("authority result lost");
      }
    });
    await registerRun(harness.adapter);
    const update = notification({
      sessionUpdate: "tool_call",
      status: "in_progress",
      title: "Run command",
      toolCallId: "tool-follower",
    });
    const leader = harness.adapter.handleSessionUpdate(RUN_ID, update);
    await entered.promise;
    const follower = harness.adapter.handleSessionUpdate(RUN_ID, update);
    release.resolve();

    const settled = await Promise.allSettled([leader, follower]);
    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(
      settled.every(
        (result) =>
          result.status === "rejected" && result.reason instanceof AuthorityOutcomeUnknownError,
      ),
    ).toBe(true);
    expect(mutationIds).toHaveLength(1);

    await harness.adapter.handleSessionUpdate(RUN_ID, update);
    expect(mutationIds).toEqual([mutationIds[0], mutationIds[0]]);
  });

  test("coalesces concurrent exact retries of one unknown session update", async () => {
    let first = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (first && update.event === "session/agent_message_chunk") {
        first = false;
        throw new AuthorityOutcomeUnknownError("authority result lost");
      }
    });
    await registerRun(harness.adapter);
    const update = notification({
      content: { text: "x", type: "text" },
      messageId: "message-retry",
      sessionUpdate: "agent_message_chunk",
    });
    await expect(harness.adapter.handleSessionUpdate(RUN_ID, update)).rejects.toBeInstanceOf(
      AuthorityOutcomeUnknownError,
    );

    await Promise.all([
      harness.adapter.handleSessionUpdate(RUN_ID, update),
      harness.adapter.handleSessionUpdate(RUN_ID, update),
    ]);
    await harness.adapter.completePrompt(RUN_ID, { stopReason: "end_turn" });

    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({
        content: [{ text: "x", type: "text" }],
        id: "message:message-retry",
      }),
    );
  });

  test("freezes a permission tool mutation across an unknown exact retry", async () => {
    const mutationIds: string[] = [];
    let first = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event !== "permission/requested.tool") {
        return;
      }

      mutationIds.push(update.mutationId);
      if (first) {
        first = false;
        throw new AuthorityOutcomeUnknownError("authority result lost");
      }
    });
    await registerRun(harness.adapter);
    const request = {
      options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
      sessionId: NATIVE_SESSION_ID,
      toolCall: { title: "Run command", toolCallId: "tool-time" },
    } satisfies RequestPermissionRequest;

    await expect(harness.adapter.openPermission(RUN_ID, request)).rejects.toBeInstanceOf(
      AuthorityOutcomeUnknownError,
    );
    harness.advance(1_000);
    await expect(harness.adapter.openPermission(RUN_ID, request)).resolves.toBeDefined();

    expect(mutationIds).toEqual([mutationIds[0], mutationIds[0]]);
  });

  test("freezes terminal registration across an unknown exact retry", async () => {
    const mutationIds: string[] = [];
    let first = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event !== "terminal/created") {
        return;
      }

      mutationIds.push(update.mutationId);
      if (first) {
        first = false;
        throw new AuthorityOutcomeUnknownError("authority result lost");
      }
    });
    await registerRun(harness.adapter);
    const request = {
      command: "true",
      sessionId: NATIVE_SESSION_ID,
    } satisfies CreateTerminalRequest;

    await expect(
      harness.adapter.registerTerminal(RUN_ID, "terminal-time", request),
    ).rejects.toBeInstanceOf(AuthorityOutcomeUnknownError);
    harness.advance(1_000);
    await expect(
      harness.adapter.registerTerminal(RUN_ID, "terminal-time", request),
    ).resolves.toBe("terminal:terminal-time");

    expect(mutationIds).toEqual([mutationIds[0], mutationIds[0]]);
  });

  test("drains streamed updates before completing the Run", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "session/agent_message_chunk") {
        blocked.resolve();
        await release.promise;
      }
    });
    await registerRun(harness.adapter);
    const update = harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: { text: "last", type: "text" },
        messageId: "message-last",
        sessionUpdate: "agent_message_chunk",
      }),
    );
    await blocked.promise;
    let completed = false;
    const completion = harness.adapter
      .completePrompt(RUN_ID, { stopReason: "end_turn" })
      .then(() => {
        completed = true;
      });
    await Bun.sleep(0);
    const completedBeforeUpdate = completed;

    release.resolve();
    await Promise.all([update, completion]);
    expect(completedBeforeUpdate).toBe(false);
    expect(harness.snapshot().runs[0]?.status).toBe("completed");
    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({
        content: [{ text: "last", type: "text" }],
        kind: "message",
        status: "completed",
      }),
    );
  });

  test("drains terminal authority writes before completing the Run", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = createHarness(5 * 60 * 1_000, 5, undefined, async (update) => {
      if (update.event === "preview/replace.checkpoint") {
        blocked.resolve();
        await release.promise;
      }
    });
    await registerRun(harness.adapter);
    await harness.adapter.registerTerminal(RUN_ID, "terminal-1");
    const output = harness.adapter.handleTerminalOutput(RUN_ID, "terminal-1", {
      exitStatus: null,
      output: "abcdef",
      truncated: false,
    });
    await blocked.promise;
    let completed = false;
    const completion = harness.adapter
      .completePrompt(RUN_ID, { stopReason: "end_turn" })
      .then(() => {
        completed = true;
      });
    await Bun.sleep(0);

    expect(completed).toBe(false);
    release.resolve();
    await Promise.all([output, completion]);
    expect(harness.snapshot().runs[0]?.status).toBe("completed");
  });

  test("drains a permission authority write before completing the Run", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "permission/requested") {
        blocked.resolve();
        await release.promise;
      }
    });
    await registerRun(harness.adapter);
    const permission = harness.adapter.openPermission(RUN_ID, {
      options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
      sessionId: NATIVE_SESSION_ID,
      toolCall: { title: "Run command", toolCallId: "tool-last" },
    });
    await blocked.promise;
    let completed = false;
    const completion = harness.adapter
      .completePrompt(RUN_ID, { stopReason: "end_turn" })
      .then(() => {
        completed = true;
      });
    await Bun.sleep(0);

    expect(completed).toBe(false);
    release.resolve();
    await Promise.all([permission, completion]);
    expect(harness.snapshot().runs[0]?.status).toBe("completed");
    expect(harness.snapshot().interactions.every((entry) => entry.status !== "open")).toBe(true);
  });

  test.each([
    [
      "prompt completion",
      (adapter: AcpV1ContractAdapter) => adapter.completePrompt(RUN_ID, { stopReason: "end_turn" }),
    ],
    [
      "session update",
      (adapter: AcpV1ContractAdapter) =>
        adapter.handleSessionUpdate(
          RUN_ID,
          notification({
            content: { text: "late", type: "text" },
            messageId: "late-message",
            sessionUpdate: "agent_message_chunk",
          }),
        ),
    ],
    [
      "terminal output",
      (adapter: AcpV1ContractAdapter) =>
        adapter.handleTerminalOutput(RUN_ID, "terminal-late", {
          exitStatus: null,
          output: "late",
          truncated: false,
        }),
    ],
    [
      "terminal exit",
      (adapter: AcpV1ContractAdapter) =>
        adapter.handleTerminalExit(RUN_ID, "terminal-late", {
          exitCode: 0,
          signal: null,
        }),
    ],
  ] as const)("ignores late %s after the Run is terminal", async (_name, lateEvent) => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.registerTerminal(RUN_ID, "terminal-late");
    await harness.adapter.completePrompt(RUN_ID, { stopReason: "end_turn" });
    const before = harness.authority.length;

    await lateEvent(harness.adapter);
    expect(harness.authority).toHaveLength(before);
  });

  test("returns session-scoped updates and rejects the wrong native session", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    const update = {
      configOptions: [],
      sessionUpdate: "config_option_update",
    } satisfies SessionNotification["update"];

    await expect(
      harness.adapter.handleSessionUpdate(RUN_ID, notification(update)),
    ).resolves.toEqual(update);
    await expect(
      harness.adapter.handleSessionUpdate(RUN_ID, {
        sessionId: "other-session",
        update,
      }),
    ).rejects.toThrow("active native session");
  });

  test("maps stable boolean and grouped select options into the Session config", () => {
    const options = [
      {
        currentValue: true,
        id: "auto-approve",
        name: "Auto approve",
        type: "boolean",
      },
      {
        currentValue: "fast",
        id: "model",
        name: "Model",
        options: [
          {
            group: "recommended",
            name: "Recommended",
            options: [{ name: "Fast", value: "fast" }],
          },
        ],
        type: "select",
      },
    ] satisfies SessionConfigOption[];

    expect(toConfigOptions(options)).toEqual([
      {
        id: "auto-approve",
        label: "Auto approve",
        type: "boolean",
        value: true,
      },
      {
        choices: [{ id: "fast", label: "Fast" }],
        extensions: {
          "agentclientprotocol.v1/select-groups": [
            { id: "recommended", label: "Recommended", optionIds: ["fast"] },
          ],
        },
        id: "model",
        label: "Model",
        type: "select",
        value: "fast",
      },
    ]);
  });

  test("checkpoints full terminal snapshots without retaining or duplicating large Preview text", async () => {
    const harness = createHarness(5 * 60 * 1_000, 5);
    await registerRun(harness.adapter);
    await harness.adapter.registerTerminal(RUN_ID, "terminal-1");
    const beforeCheckpoint = harness.authority.length;

    await harness.adapter.handleTerminalOutput(RUN_ID, "terminal-1", {
      exitStatus: null,
      output: "abcdef",
      truncated: true,
    });
    expect(harness.authority).toHaveLength(beforeCheckpoint + 1);
    expect(harness.previews).toHaveLength(0);
    expect(harness.snapshot().items[0]).toMatchObject({
      kind: "terminal",
      status: "active",
      stdout: [{ text: "abcdef", type: "text" }],
    });

    await harness.adapter.handleTerminalOutput(RUN_ID, "terminal-1", {
      exitStatus: null,
      output: "abcdef",
      truncated: false,
    });
    expect(harness.authority).toHaveLength(beforeCheckpoint + 1);

    await harness.adapter.handleTerminalExit(RUN_ID, "terminal-1", {
      exitCode: 0,
      signal: null,
    });
    expect(harness.snapshot().items[0]).toMatchObject({ kind: "terminal", status: "active" });

    await harness.adapter.completePrompt(RUN_ID, { stopReason: "end_turn" });
    expect(harness.snapshot().items[0]).toMatchObject({
      extensions: {
        "agentclientprotocol.v1/terminal-output": { truncated: true },
      },
      exitCode: 0,
      kind: "terminal",
      status: "completed",
      stdout: [{ text: "abcdef", type: "text" }],
    });
  });

  test("accepts the final terminal snapshot after wait-for-exit resolves", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.registerTerminal(RUN_ID, "terminal-tail");
    await harness.adapter.handleTerminalOutput(RUN_ID, "terminal-tail", {
      exitStatus: null,
      output: "prefix",
      truncated: false,
    });
    await harness.adapter.handleTerminalExit(RUN_ID, "terminal-tail", {
      exitCode: 0,
      signal: null,
    });
    await harness.adapter.handleTerminalOutput(RUN_ID, "terminal-tail", {
      exitStatus: { exitCode: 0, signal: null },
      output: "prefix-tail",
      truncated: false,
    });

    expect(harness.snapshot().items[0]).toMatchObject({
      exitCode: 0,
      kind: "terminal",
      status: "completed",
      stdout: [{ text: "prefix-tail", type: "text" }],
    });
  });

  test("ignores draft v1 plan operations that were not negotiated", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);

    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        plan: {
          entries: [],
          planId: "draft-plan",
          type: "items",
        },
        sessionUpdate: "plan_update",
      }),
    );

    expect(harness.snapshot().items).toHaveLength(0);
  });

  test("honors explicit empty collection replacements in tool updates", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: [
          { content: { text: "temporary", type: "text" }, type: "content" },
          {
            newText: "new",
            oldText: "old",
            path: "/workspace/file.txt",
            type: "diff",
          },
          { terminalId: "terminal-1", type: "terminal" },
        ],
        sessionUpdate: "tool_call",
        title: "Read",
        toolCallId: "tool-1",
      }),
    );
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: [],
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
      }),
    );

    const tool = harness.snapshot().items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({
      kind: "tool",
      output: [],
    });
    expect(tool).not.toHaveProperty("terminalItemId");
    expect(harness.snapshot().items.find((item) => item.kind === "change")).toMatchObject({
      changes: [],
      status: "active",
    });
  });

  test("treats nullable v1 tool patch fields as omitted", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: [
          { content: { text: "kept", type: "text" }, type: "content" },
          {
            newText: "new",
            oldText: "old",
            path: "/workspace/file.txt",
            type: "diff",
          },
          { terminalId: "terminal-1", type: "terminal" },
        ],
        kind: "edit",
        locations: [{ line: 2, path: "/workspace/file.txt" }],
        rawInput: { path: "/workspace/file.txt" },
        rawOutput: { changed: true },
        sessionUpdate: "tool_call",
        title: "Edit",
        toolCallId: "tool-1",
      }),
    );
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: null,
        kind: null,
        locations: null,
        rawInput: null,
        rawOutput: null,
        sessionUpdate: "tool_call_update",
        status: null,
        title: null,
        toolCallId: "tool-1",
      }),
    );

    expect(harness.snapshot().items.find((item) => item.kind === "tool")).toMatchObject({
      category: "edit",
      input: { path: "/workspace/file.txt" },
      locations: [{ line: 2, path: "/workspace/file.txt" }],
      output: [{ text: "kept", type: "text" }],
      status: "active",
      structuredOutput: { changed: true },
      terminalItemId: "terminal:terminal-1",
      title: "Edit",
    });
    expect(harness.snapshot().items.find((item) => item.kind === "change")).toMatchObject({
      changes: [expect.objectContaining({ path: "/workspace/file.txt" })],
      status: "active",
    });
  });

  test.each([
    ["raw output", { rawOutput: { late: true } }, { structuredOutput: { late: true } }],
    [
      "locations",
      { locations: [{ line: 7, path: "/workspace/late.txt" }] },
      { locations: [{ line: 7, path: "/workspace/late.txt" }] },
    ],
    [
      "content",
      { content: [{ content: { text: "late", type: "text" }, type: "content" }] },
      { output: [{ text: "late", type: "text" }] },
    ],
    [
      "terminal reference",
      { content: [{ terminalId: "terminal-late", type: "terminal" }] },
      { terminalItemId: "terminal:terminal-late" },
    ],
  ] as const)("enriches a completed tool with a later %s patch", async (_name, patch, expected) => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        kind: "execute",
        rawInput: { command: "true" },
        sessionUpdate: "tool_call",
        status: "completed",
        title: "Run command",
        toolCallId: "tool-late",
      }),
    );
    const endedAt = harness.snapshot().items.find((item) => item.kind === "tool")?.endedAt;

    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        ...patch,
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-late",
      } as SessionNotification["update"]),
    );

    expect(harness.snapshot().items.find((item) => item.kind === "tool")).toMatchObject({
      category: "execute",
      endedAt,
      input: { command: "true" },
      status: "completed",
      title: "Run command",
      ...expected,
    });
  });

  test("ignores a completed tool replay that carries no new content", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        kind: "execute",
        rawInput: { command: "true" },
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: "Run command",
        toolCallId: "tool-replay",
      }),
    );
    const completed = notification({
      rawOutput: { exitCode: 0 },
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolCallId: "tool-replay",
    });
    await harness.adapter.handleSessionUpdate(RUN_ID, completed);
    const authorityCount = harness.authority.length;

    harness.advance(1_000);
    await expect(harness.adapter.handleSessionUpdate(RUN_ID, completed)).resolves.toBeNull();

    expect(harness.authority).toHaveLength(authorityCount);
    expect(harness.snapshot().items.find((item) => item.kind === "tool")).toMatchObject({
      input: { command: "true" },
      status: "completed",
      structuredOutput: { exitCode: 0 },
    });
  });

  test.each(["completed", "failed"] as const)(
    "propagates status-only %s tool updates to existing file changes",
    async (status) => {
      const harness = createHarness();
      await registerRun(harness.adapter);
      await harness.adapter.handleSessionUpdate(
        RUN_ID,
        notification({
          content: [
            {
              newText: "new",
              oldText: "old",
              path: "/workspace/file.txt",
              type: "diff",
            },
          ],
          sessionUpdate: "tool_call",
          title: "Edit",
          toolCallId: "tool-1",
        }),
      );
      await harness.adapter.handleSessionUpdate(
        RUN_ID,
        notification({
          sessionUpdate: "tool_call_update",
          status,
          toolCallId: "tool-1",
        }),
      );

      expect(harness.snapshot().items.find((item) => item.kind === "change")).toMatchObject({
        changes: [
          {
            diff: {
              type: "json",
              value: { newText: "new", oldText: "old" },
            },
            operation: "update",
            path: "/workspace/file.txt",
          },
        ],
        status,
      });
    },
  );

  test("rejects empty permission choices before creating authority state", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);

    await expect(
      harness.adapter.openPermission(RUN_ID, {
        options: [],
        sessionId: NATIVE_SESSION_ID,
        toolCall: { title: "Read", toolCallId: "tool-1" },
      }),
    ).rejects.toThrow("at least one option");
    expect(harness.snapshot().items).toHaveLength(0);
    expect(harness.snapshot().interactions).toHaveLength(0);
  });

  test.each([Number.POSITIVE_INFINITY, 1.5])("rejects invalid timeout %p", (value) => {
    expect(() => createHarness(value)).toThrow("finite and positive");
  });

  test.each([Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid pending permission limit %p",
    (value) => {
      expect(() => createHarness(5 * 60 * 1_000, undefined, value)).toThrow("finite and positive");
    },
  );
});
