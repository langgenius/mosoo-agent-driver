import { describe, expect, test } from "bun:test";

import {
  assertFrameAdmission,
  assertProtocolAdmission,
  applyCommittedMutation,
  blobManifestEntrySchema,
  committedMutationSchema,
  executorCommandParamsSchema,
  initializeResultSchema,
  itemSchema,
  jsonRpcRequestSchema,
  normalizeExecutorMutation,
  validateCommand,
  validateExecutorMutation,
  validateSessionSnapshot,
} from "../src/contract";
import type {
  AuthorityOperation,
  CommittedMutation,
  Interaction,
  Item,
  Run,
  Session,
  SessionSnapshot,
} from "../src/contract";
import { createDriverId } from "../src/protocol/id";

const time = "2026-07-16T08:00:00.000Z";
const later = "2026-07-16T08:00:01.000Z";
const terminalItemStatuses = ["completed", "failed", "cancelled"] as const;

function session(id = createDriverId()): Session {
  return {
    id,
    status: "open",
    createdAt: time,
    updatedAt: time,
    capabilities: {
      "interaction.input": {},
      "interaction.permission": {},
      "run.child": {},
    },
    config: [],
  };
}

function snapshot(sessionValue = session()): SessionSnapshot {
  return validateSessionSnapshot({
    protocolVersion: 2,
    revision: 0,
    capturedAt: time,
    session: sessionValue,
    runs: [],
    items: [],
    interactions: [],
  });
}

function activeRun(id = createDriverId()): Run {
  return {
    id,
    status: "active",
    origin: "user",
    input: [{ type: "text", text: "work" }],
    startedAt: time,
  };
}

function activeTool(runId: string, id = "tool-1"): Extract<Item, { kind: "tool" }> {
  return {
    id,
    runId,
    kind: "tool",
    status: "active",
    createdAt: time,
    updatedAt: time,
    audience: "participants",
    name: "shell",
    category: "execute",
    origin: "provider",
  };
}

function finishItem(item: Item, status: Exclude<Item["status"], "active">): Item {
  return {
    ...item,
    endedAt: time,
    ...(status === "failed"
      ? { error: { code: "test_failure", message: "failed", retryable: false } }
      : {}),
    status,
  };
}

function permission(
  runId: string,
  itemId: string,
  id = createDriverId(),
): Extract<Interaction, { kind: "permission" }> {
  return {
    id,
    runId,
    itemId,
    kind: "permission",
    status: "open",
    blocking: true,
    createdAt: time,
    expiresAt: "2026-07-16T08:05:00.000Z",
    audience: "participants",
    request: {
      title: "Run command",
      subject: { type: "item", itemId },
      options: [
        { id: "allow", label: "Allow", effect: "allow", scope: "once" },
        { id: "deny", label: "Deny", effect: "deny", scope: "once" },
      ],
    },
  };
}

function mutation(
  state: SessionSnapshot,
  operations: readonly AuthorityOperation[],
  committedAt = time,
): CommittedMutation {
  return committedMutationSchema.parse({
    mutationId: createDriverId(),
    sessionId: state.session.id,
    baseRevision: state.revision,
    revision: state.revision + 1,
    committedAt,
    cause: { type: "system", name: "test" },
    operations,
  });
}

function proposal(state: SessionSnapshot, operations: readonly AuthorityOperation[]) {
  return {
    baseRevision: state.revision,
    cause: { name: "provider-event", type: "system" as const },
    mutationId: createDriverId(),
    operations,
    sessionId: state.session.id,
  };
}

function protocolLimits(overrides: Record<string, number> = {}) {
  return {
    authorityFlushIntervalMs: 10,
    maxCommandBytes: 1_024,
    maxFrameBytes: 4_096,
    maxInlineBytes: 128,
    maxInteractionTtlMs: 60_000,
    maxMutationBatchCount: 16,
    maxMutationBytes: 1_024,
    maxPendingCommandBytes: 4_096,
    maxPendingMutationBytes: 4_096,
    maxPreviewBatchBytes: 1_024,
    maxPreviewBatchUpdates: 16,
    maxSnapshotBytes: 2_048,
    maxSubscriberQueueBytes: 4_096,
    maxSubscriptionsPerSession: 8,
    previewFlushIntervalMs: 10,
    previewReplaceIntervalMs: 100,
    ...overrides,
  };
}

describe("contract closed core", () => {
  test("rejects initialize results that cannot fit in their own frame", () => {
    const limits = protocolLimits({
      maxCommandBytes: 1,
      maxFrameBytes: 100,
      maxInlineBytes: 1,
      maxMutationBytes: 1,
      maxPreviewBatchBytes: 1,
      maxSnapshotBytes: 1,
    });
    const result = {
      protocolVersion: 2,
      implementation: { name: "coordinator", version: "1" },
      capabilities: {},
      limits,
    };

    expect(
      new TextEncoder().encode(JSON.stringify({ id: 0, jsonrpc: "2.0", result })).byteLength,
    ).toBeGreaterThan(limits.maxFrameBytes);
    expect(initializeResultSchema.safeParse(result).success).toBe(false);
  });

  test("reserves the complete JSON-RPC envelope in frame limits", () => {
    const result = {
      protocolVersion: 2,
      implementation: { name: "coordinator", version: "1" },
      capabilities: {},
      limits: protocolLimits({ maxCommandBytes: 4_095, maxFrameBytes: 4_096 }),
    };

    expect(initializeResultSchema.safeParse(result).success).toBe(false);
    const frame = { id: "request", jsonrpc: "2.0", method: "command/get", params: {} };
    const bytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
    expect(() => assertFrameAdmission(frame, bytes)).not.toThrow();
    expect(() => assertFrameAdmission(frame, bytes - 1)).toThrow("frame byte limit");
  });

  test("reserves the largest snapshot response envelope at its boundary", () => {
    const maxFrameBytes = 4_096;
    const envelope = {
      id: "0".repeat(256),
      jsonrpc: "2.0",
      result: {
        initial: {
          minimumResumeRevision: Number.MAX_SAFE_INTEGER,
          snapshot: {},
          type: "snapshot",
        },
        lease: { epoch: Number.MAX_SAFE_INTEGER, leaseId: "Z".repeat(26) },
        subscriptionId: "Z".repeat(26),
      },
    };
    const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope)).byteLength - 2;
    const result = (maxSnapshotBytes: number) => ({
      capabilities: {},
      implementation: { name: "coordinator", version: "1" },
      limits: protocolLimits({ maxFrameBytes, maxSnapshotBytes }),
      protocolVersion: 2,
    });

    expect(initializeResultSchema.safeParse(result(maxFrameBytes - envelopeBytes)).success).toBe(
      true,
    );
    expect(
      initializeResultSchema.safeParse(result(maxFrameBytes - envelopeBytes + 1)).success,
    ).toBe(false);
  });

  test("bounds JSON-RPC string identities used by the envelope reserve", () => {
    const request = (id: string) => ({ id, jsonrpc: "2.0", method: "test" });

    expect(jsonRpcRequestSchema.safeParse(request("0".repeat(256))).success).toBe(true);
    expect(jsonRpcRequestSchema.safeParse(request("0".repeat(257))).success).toBe(false);
  });

  test("enforces inline and encoded object admission limits at their boundaries", () => {
    const value = {
      content: [{ data: "aA==", mediaType: "text/plain", type: "inline_blob" }],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;

    expect(() =>
      assertProtocolAdmission(value, { maxBytes: bytes, maxInlineBytes: 1 }, value.content),
    ).not.toThrow();
    expect(() =>
      assertProtocolAdmission(value, { maxBytes: bytes - 1, maxInlineBytes: 1 }, value.content),
    ).toThrow("byte limit");
    const oversized = {
      content: [{ data: "aGk=", mediaType: "text/plain", type: "inline_blob" }],
    };
    expect(() =>
      assertProtocolAdmission(oversized, { maxBytes: 1_024, maxInlineBytes: 1 }, oversized.content),
    ).toThrow("inline Blob");

    const initial = snapshot();
    expect(() =>
      validateCommand(
        initial,
        {
          commandId: createDriverId(),
          input: [{ data: "aGk=", mediaType: "text/plain", type: "inline_blob" }],
          kind: "run.start",
          runId: createDriverId(),
          sessionId: initial.session.id,
        },
        time,
        { maxBytes: 1_024, maxInlineBytes: 1 },
      ),
    ).toThrow("inline Blob");

    expect(
      validateCommand(
        initial,
        {
          commandId: createDriverId(),
          input: [
            {
              type: "json",
              value: { data: "aGk=", type: "inline_blob" },
            },
          ],
          kind: "run.start",
          runId: createDriverId(),
          sessionId: initial.session.id,
        },
        time,
        { maxBytes: 1_024, maxInlineBytes: 1 },
      ),
    ).toMatchObject({ kind: "run.start" });
  });

  test.each([
    (id: string) => `session:${id}`,
    (id: string) => `run:${id}`,
    (id: string) => `interaction:${id}`,
    (id: string) => `item:${id}:dG9vbC0x`,
  ])("accepts a canonical Blob manifest reference", (reference) => {
    const sessionId = createDriverId();

    expect(
      blobManifestEntrySchema.safeParse({
        blob: {
          blobId: createDriverId(),
          digest: `sha256:${"0".repeat(64)}`,
          mediaType: "text/plain",
          sizeBytes: 0,
        },
        references: [reference(sessionId)],
        sessionId,
      }).success,
    ).toBe(true);
  });

  test("accepts a canonical Blob reference for a maximum UTF-8 Item ID", () => {
    const itemId = "\u0800".repeat(256);
    const encodedItemId = new TextEncoder()
      .encode(itemId)
      .toBase64({ alphabet: "base64url", omitPadding: true });
    const sessionId = createDriverId();
    const reference = `item:${sessionId}:${encodedItemId}`;

    expect(reference.length).toBe(1_056);
    expect(
      blobManifestEntrySchema.safeParse({
        blob: {
          blobId: createDriverId(),
          digest: `sha256:${"0".repeat(64)}`,
          mediaType: "text/plain",
          sizeBytes: 0,
        },
        references: [reference],
        sessionId,
      }).success,
    ).toBe(true);
  });

  test("rejects a Blob manifest reference owned by another Session", () => {
    const sessionId = createDriverId();

    expect(
      blobManifestEntrySchema.safeParse({
        blob: {
          blobId: createDriverId(),
          digest: `sha256:${"0".repeat(64)}`,
          mediaType: "text/plain",
          sizeBytes: 0,
        },
        references: [`session:${createDriverId()}`],
        sessionId,
      }).success,
    ).toBe(false);
  });

  test.each([
    "not-canonical",
    `session:${"a".repeat(26)}`,
    `item:${"0".repeat(26)}:a`,
    `item:${"0".repeat(26)}:YR`,
    `item:${"0".repeat(26)}:_w`,
    `item:${"0".repeat(26)}:dG9vbC0x=`,
  ])("rejects a non-canonical Blob manifest reference: %s", (reference) => {
    expect(
      blobManifestEntrySchema.safeParse({
        blob: {
          blobId: createDriverId(),
          digest: `sha256:${"0".repeat(64)}`,
          mediaType: "text/plain",
          sizeBytes: 0,
        },
        references: [reference],
        sessionId: createDriverId(),
      }).success,
    ).toBe(false);
  });

  test("fences commands delivered to an Executor", () => {
    const command = {
      commandId: createDriverId(),
      sessionId: createDriverId(),
      kind: "run.start" as const,
      runId: createDriverId(),
      input: [{ type: "text" as const, text: "work" }],
    };

    expect(executorCommandParamsSchema.safeParse(command).success).toBe(false);
    expect(
      executorCommandParamsSchema.safeParse({
        lease: { leaseId: createDriverId(), epoch: 1 },
        command,
      }).success,
    ).toBe(true);
  });

  test.each([
    {
      label: "remove state",
      operation: (run: Run): AuthorityOperation => ({
        entity: "run",
        id: run.id,
        op: "remove",
        reason: "compacted",
      }),
      message: "cannot remove",
    },
    {
      label: "modify the Session",
      operation: (_run: Run, state: SessionSnapshot): AuthorityOperation => ({
        entity: "session",
        op: "put",
        value: { ...state.session, title: "Changed" },
      }),
      message: "cannot modify the Session",
    },
    {
      label: "create a user Run",
      operation: (): AuthorityOperation => ({
        entity: "run",
        op: "put",
        value: activeRun(createDriverId()),
      }),
      message: "create a user-originated Run",
    },
    {
      label: "create a user message",
      operation: (run: Run): AuthorityOperation => ({
        entity: "item",
        op: "put",
        value: {
          audience: "participants",
          content: [{ text: "forged", type: "text" }],
          createdAt: time,
          endedAt: time,
          id: "forged-user-message",
          kind: "message",
          role: "user",
          runId: run.id,
          status: "completed",
          updatedAt: time,
        },
      }),
      message: "write a user Message Item",
    },
  ])("prevents an Executor from $label", ({ operation, message }) => {
    const initial = snapshot();
    const run = activeRun();
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [{ entity: "run", op: "put", value: run }]),
    );

    expect(() =>
      validateExecutorMutation(running, {
        baseRevision: running.revision,
        cause: { name: "provider-event", type: "system" },
        mutationId: createDriverId(),
        operations: [operation(run, running)],
        sessionId: running.session.id,
      }),
    ).toThrow(message);
  });

  test("reserves Interaction resolution for the Coordinator", () => {
    const initial = snapshot();
    const run = activeRun();
    const tool = activeTool(run.id);
    const request = permission(run.id, tool.id);
    const waiting = applyCommittedMutation(
      initial,
      mutation(initial, [
        { entity: "run", op: "put", value: run },
        { entity: "item", op: "put", value: tool },
        { entity: "interaction", op: "put", value: request },
      ]),
    );

    expect(() =>
      validateExecutorMutation(waiting, {
        baseRevision: waiting.revision,
        cause: { name: "provider-event", type: "system" },
        mutationId: createDriverId(),
        operations: [
          {
            entity: "interaction",
            op: "put",
            value: {
              ...request,
              endedAt: time,
              resolution: { type: "cancelled" },
              status: "resolved",
            },
          },
        ],
        sessionId: waiting.session.id,
      }),
    ).toThrow("resolve an Interaction");

    expect(
      validateExecutorMutation(waiting, {
        baseRevision: waiting.revision,
        cause: { name: "provider-event", type: "system" },
        mutationId: createDriverId(),
        operations: [
          {
            entity: "interaction",
            op: "put",
            value: { ...request, endedAt: time, status: "expired" },
          },
        ],
        sessionId: waiting.session.id,
      }),
    ).toMatchObject({ baseRevision: waiting.revision });
  });

  test("normalizes Executor lifecycle time and Interaction TTL with the Coordinator clock", () => {
    const initial = snapshot();
    const run = activeRun();
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [{ entity: "run", op: "put", value: run }]),
    );
    const clientCreatedAt = "2099-01-01T00:00:00.000Z";
    const interactionId = createDriverId();
    const proposed = {
      baseRevision: running.revision,
      cause: { name: "provider-event", type: "system" as const },
      mutationId: createDriverId(),
      operations: [
        {
          entity: "item" as const,
          op: "put" as const,
          value: {
            ...activeTool(run.id),
            createdAt: clientCreatedAt,
            updatedAt: clientCreatedAt,
          },
        },
        {
          entity: "interaction" as const,
          op: "put" as const,
          value: {
            audience: "participants" as const,
            blocking: true,
            createdAt: clientCreatedAt,
            expiresAt: "2099-01-01T00:00:05.000Z",
            id: interactionId,
            kind: "permission" as const,
            request: {
              options: [
                { effect: "deny" as const, id: "deny", label: "Deny", scope: "once" as const },
              ],
              subject: { operation: "execute", targets: ["workspace"], type: "resource" as const },
              title: "Run command?",
            },
            runId: run.id,
            status: "open" as const,
          },
        },
      ],
      sessionId: running.session.id,
    };
    const acceptedAt = "2026-07-16T08:00:01.000Z";
    const normalized = normalizeExecutorMutation(running, proposed, acceptedAt, 1_000);

    expect(normalized.operations).toMatchObject([
      { value: { createdAt: acceptedAt, updatedAt: acceptedAt } },
      {
        value: {
          createdAt: acceptedAt,
          expiresAt: "2026-07-16T08:00:02.000Z",
        },
      },
    ]);
    const waiting = applyCommittedMutation(running, {
      ...normalized,
      committedAt: acceptedAt,
      revision: running.revision + 1,
    });
    const expiredAt = "2026-07-16T08:00:02.000Z";
    const interaction = waiting.interactions[0]!;
    const expiry = normalizeExecutorMutation(
      waiting,
      {
        baseRevision: waiting.revision,
        cause: { name: "provider-event", type: "system" },
        mutationId: createDriverId(),
        operations: [
          {
            entity: "interaction",
            op: "put",
            value: {
              ...interaction,
              endedAt: clientCreatedAt,
              expiresAt: "2099-01-01T01:00:00.000Z",
              status: "expired",
            },
          },
        ],
        sessionId: waiting.session.id,
      },
      expiredAt,
      1_000,
    );

    expect(expiry.operations[0]).toMatchObject({
      value: {
        endedAt: expiredAt,
        expiresAt: "2026-07-16T08:00:02.000Z",
      },
    });
  });

  test.each(
    (["new", "active"] as const).flatMap((mode) =>
      terminalItemStatuses.map((status) => [mode, status] as const),
    ),
  )("normalizes and applies terminal Item creation from %s state as %s", (mode, status) => {
    const initial = snapshot();
    const run = activeRun();
    const item = activeTool(run.id);
    const current = applyCommittedMutation(
      initial,
      mutation(initial, [
        { entity: "run", op: "put", value: run },
        ...(mode === "active"
          ? [{ entity: "item" as const, op: "put" as const, value: item }]
          : []),
      ]),
    );
    const clientAt = "2099-01-01T00:00:00.000Z";
    const value = itemSchema.parse({
      ...finishItem({ ...item, createdAt: clientAt, updatedAt: clientAt }, status),
      endedAt: clientAt,
    });
    const normalized = normalizeExecutorMutation(
      current,
      proposal(current, [{ entity: "item", op: "put", value }]),
      later,
      1_000,
    );
    const committed = applyCommittedMutation(current, {
      ...normalized,
      committedAt: later,
      revision: current.revision + 1,
    });

    expect(normalized.operations[0]).toMatchObject({
      value: {
        createdAt: mode === "active" ? time : later,
        endedAt: later,
        status,
        updatedAt: later,
      },
    });
    expect(committed.items[0]).toMatchObject({ endedAt: later, status, updatedAt: later });
  });

  test.each(terminalItemStatuses)(
    "normalizes and applies %s Item enrichment without moving endedAt",
    (status) => {
      const initial = snapshot();
      const run = activeRun();
      const item = activeTool(run.id);
      const active = applyCommittedMutation(
        initial,
        mutation(initial, [
          { entity: "run", op: "put", value: run },
          { entity: "item", op: "put", value: item },
        ]),
      );
      const terminal = finishItem(item, status);
      const ended = applyCommittedMutation(
        active,
        mutation(active, [{ entity: "item", op: "put", value: terminal }]),
      );
      const clientAt = "2099-01-01T00:00:00.000Z";
      const value = itemSchema.parse({
        ...terminal,
        endedAt: clientAt,
        structuredOutput: { late: true },
        updatedAt: clientAt,
      });
      const normalized = normalizeExecutorMutation(
        ended,
        proposal(ended, [{ entity: "item", op: "put", value }]),
        later,
        1_000,
      );
      const committed = applyCommittedMutation(ended, {
        ...normalized,
        committedAt: later,
        revision: ended.revision + 1,
      });

      expect(normalized.operations[0]).toMatchObject({
        value: { endedAt: terminal.endedAt, status, updatedAt: later },
      });
      expect(committed.items[0]).toMatchObject({
        endedAt: terminal.endedAt,
        status,
        structuredOutput: { late: true },
        updatedAt: later,
      });

      const replay = normalizeExecutorMutation(
        ended,
        proposal(ended, [
          {
            entity: "item",
            op: "put",
            value: itemSchema.parse({ ...terminal, endedAt: clientAt, updatedAt: clientAt }),
          },
        ]),
        later,
        1_000,
      );
      expect(replay.operations[0]).toMatchObject({
        value: { endedAt: terminal.endedAt, updatedAt: later },
      });
      expect(() =>
        applyCommittedMutation(ended, {
          ...replay,
          committedAt: later,
          revision: ended.revision + 1,
        }),
      ).toThrow("must enrich content");
    },
  );

  test.each(terminalItemStatuses)(
    "normalizes %s Item enrichment before closing its Run in the same Mutation",
    (status) => {
      const initial = snapshot();
      const run = activeRun();
      const item = activeTool(run.id);
      const active = applyCommittedMutation(
        initial,
        mutation(initial, [
          { entity: "run", op: "put", value: run },
          { entity: "item", op: "put", value: item },
        ]),
      );
      const terminal = finishItem(item, status);
      const ended = applyCommittedMutation(
        active,
        mutation(active, [{ entity: "item", op: "put", value: terminal }]),
      );
      const clientAt = "2099-01-01T00:00:00.000Z";
      const value = itemSchema.parse({
        ...terminal,
        endedAt: clientAt,
        structuredOutput: { late: true },
        updatedAt: clientAt,
      });
      const normalized = normalizeExecutorMutation(
        ended,
        proposal(ended, [
          {
            entity: "run",
            op: "put",
            value: { ...run, endedAt: clientAt, finishReason: "success", status: "completed" },
          },
          { entity: "item", op: "put", value },
        ]),
        later,
        1_000,
      );
      const committed = applyCommittedMutation(ended, {
        ...normalized,
        committedAt: later,
        revision: ended.revision + 1,
      });

      expect(normalized.operations).toMatchObject([
        { value: { endedAt: later, status: "completed" } },
        { value: { endedAt: terminal.endedAt, status, updatedAt: later } },
      ]);
      expect(committed.runs[0]?.status).toBe("completed");
      expect(committed.items[0]).toMatchObject({
        endedAt: terminal.endedAt,
        structuredOutput: { late: true },
      });
    },
  );
});
