import { describe, expect, test } from "bun:test";
import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";

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
import { AcpV1ContractAdapter } from "../src/runtimes/acp/v1-contract-adapter";
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
});
