import { describe, expect, test } from "bun:test";

import {
  ContractInvariantError,
  assertFrameAdmission,
  assertProtocolAdmission,
  applyCommittedMutation,
  applyPreviewUpdate,
  applySyncPayload,
  blobManifestEntrySchema,
  cleanupObligationSchema,
  coalescePreviewUpdates,
  commandReceiptSchema,
  commandSchema,
  compareTimestamps,
  committedMutationSchema,
  createPreviewBuffer,
  deriveSessionActivity,
  executorCommandParamsSchema,
  extensionContentSchema,
  initializeParamsSchema,
  initializeResultSchema,
  interactionSchema,
  itemSchema,
  jsonByteLength,
  jsonRpcRequestSchema,
  jsonRpcSuccessSchema,
  mutationSyncSchema,
  normalizeExecutorMutation,
  previewUpdateSchema,
  protocolIdSchema,
  validateCommand,
  validateExecutorMutation,
  validatePreviewBatch,
  validateSessionSnapshot,
} from "../src/contract";
import type {
  AuthorityOperation,
  CommittedMutation,
  Interaction,
  Item,
  PreviewUpdate,
  Run,
  Session,
  SessionSnapshot,
} from "../src/contract";
import { createDriverId, isDriverId } from "../src/protocol/id";

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

function activeTool(runId: string, id = "tool-1"): Item {
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

function finishRun(run: Run, status: Exclude<Run["status"], "active">): Run {
  switch (status) {
    case "completed":
      return { ...run, endedAt: time, finishReason: "success", status };
    case "failed":
      return {
        ...run,
        endedAt: time,
        error: { code: "test_failure", message: "failed", retryable: false },
        status,
      };
    case "cancelled":
      return { ...run, endedAt: time, reason: "test", status };
  }
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

function permission(runId: string, itemId: string, id = createDriverId()): Interaction {
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

describe("contract protocol IDs", () => {
  test.each([
    ["canonical", "01J00000000000000000000009", "01J00000000000000000000009"],
    ["lowercase", "01j00000000000000000000009", "01J00000000000000000000009"],
    ["maximum timestamp", "7ZZZZZZZZZZZZZZZZZZZZZZZZZ", "7ZZZZZZZZZZZZZZZZZZZZZZZZZ"],
    ["overflowing timestamp", "80000000000000000000000000", "80000000000000000000000000"],
  ] as const)("accepts and canonicalizes a %s ULID", (_case, input, expected) => {
    expect(protocolIdSchema.parse(input)).toBe(expected);
    expect(isDriverId(expected)).toBe(true);
  });

  test.each([
    ["UUID", "00000000-0000-4000-8000-000000000001"],
    ["excluded alphabet character", "01J0000000000000000000000I"],
    ["wrong length", "01J0000000000000000000000"],
  ] as const)("rejects a %s", (_case, input) => {
    expect(protocolIdSchema.safeParse(input).success).toBe(false);
  });
});

describe("contract timestamps", () => {
  test.each([
    [
      "later sub-millisecond fraction",
      "2026-07-16T08:00:00.0000009Z",
      "2026-07-16T08:00:00.0000001Z",
      1,
    ],
    [
      "earlier sub-millisecond fraction",
      "2026-07-16T08:00:00.0000001Z",
      "2026-07-16T08:00:00.0000009Z",
      -1,
    ],
    ["equivalent fraction precision", "2026-07-16T08:00:00.1Z", "2026-07-16T08:00:00.1000Z", 0],
    ["equivalent offsets", "2026-07-16T08:00:00+08:00", "2026-07-16T00:00:00Z", 0],
  ] as const)("compares %s exactly", (_case, left, right, expected) => {
    expect(compareTimestamps(left, right)).toBe(expected);
  });
});

describe("contract authority reducer", () => {
  test.each(["completed", "failed", "cancelled"] as const)(
    "allows an active Run to become %s exactly once",
    (status) => {
      const initial = snapshot();
      const run = activeRun();
      const running = applyCommittedMutation(
        initial,
        mutation(initial, [{ entity: "run", op: "put", value: run }]),
      );
      const terminal = finishRun(run, status);
      const ended = applyCommittedMutation(
        running,
        mutation(running, [{ entity: "run", op: "put", value: terminal }]),
      );

      expect(ended.runs[0]?.status).toBe(status);
      expect(() =>
        applyCommittedMutation(
          ended,
          mutation(ended, [
            { entity: "run", op: "put", value: { ...terminal, usage: { total: 1 } } },
          ]),
        ),
      ).toThrow(`Run status cannot transition from ${status} to ${status}`);
      expect(() =>
        applyCommittedMutation(
          initial,
          mutation(initial, [{ entity: "run", op: "put", value: terminal }]),
        ),
      ).toThrow("A Run must start active");
    },
  );

  test.each(terminalItemStatuses)(
    "allows a %s Item to gain content while its Run remains active",
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
      const enriched = itemSchema.parse({
        ...terminal,
        structuredOutput: { late: true },
        updatedAt: later,
      });
      const updated = applyCommittedMutation(
        ended,
        mutation(ended, [{ entity: "item", op: "put", value: enriched }], later),
      );

      expect(updated.items[0]).toEqual(enriched);
    },
  );

  test.each(terminalItemStatuses)(
    "rejects a new %s Item updated after its terminal time",
    (status) => {
      const initial = snapshot();
      const run = activeRun();
      const item = finishItem({ ...activeTool(run.id), updatedAt: later }, status);

      expect(() =>
        applyCommittedMutation(
          initial,
          mutation(
            initial,
            [
              { entity: "run", op: "put", value: run },
              { entity: "item", op: "put", value: item },
            ],
            later,
          ),
        ),
      ).toThrow(`Item ${item.id} endedAt`);
    },
  );

  test("requires terminal enrichment time to cover the fixed terminal time", () => {
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
    const terminal = { ...finishItem(item, "completed"), endedAt: later };
    const ended = applyCommittedMutation(
      active,
      mutation(active, [{ entity: "item", op: "put", value: terminal }], later),
    );

    expect(() =>
      applyCommittedMutation(
        ended,
        mutation(
          ended,
          [
            {
              entity: "item",
              op: "put",
              value: { ...terminal, structuredOutput: { late: true } },
            },
          ],
          later,
        ),
      ),
    ).toThrow(`Item ${item.id} updatedAt`);
  });

  test.each(
    terminalItemStatuses.flatMap((previous) =>
      (["active", ...terminalItemStatuses.filter((status) => status !== previous)] as const).map(
        (next) => [previous, next] as const,
      ),
    ),
  )("rejects an Item status transition from %s to %s", (previousStatus, nextStatus) => {
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
    const terminal = finishItem(item, previousStatus);
    const ended = applyCommittedMutation(
      active,
      mutation(active, [{ entity: "item", op: "put", value: terminal }]),
    );
    const content = itemSchema.parse({
      ...item,
      structuredOutput: { late: true },
      updatedAt: later,
    });
    const next = nextStatus === "active" ? content : finishItem(content, nextStatus);

    expect(() =>
      applyCommittedMutation(
        ended,
        mutation(ended, [{ entity: "item", op: "put", value: next }], later),
      ),
    ).toThrow(`Item status cannot transition from ${previousStatus} to ${nextStatus}`);
  });

  test.each(terminalItemStatuses)(
    "rejects a %s Item replay without content enrichment",
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

      for (const replay of [terminal, { ...terminal, updatedAt: later }]) {
        expect(() =>
          applyCommittedMutation(
            ended,
            mutation(ended, [{ entity: "item", op: "put", value: replay }], later),
          ),
        ).toThrow("must enrich content");
      }
    },
  );

  test.each(
    terminalItemStatuses.flatMap((status) =>
      (
        [
          ["provider", { event: "started", provider: "other" }],
          ["native event", { event: "updated", provider: "provider" }],
          [
            "native IDs",
            {
              event: "started",
              nativeIds: { requestId: "request-2", toolCallId: "tool-1" },
              provider: "provider",
            },
          ],
        ] as const
      ).map(([field, provenance]) => [status, field, provenance] as const),
    ),
  )("rejects a %s Item update that only changes provenance %s", (status, _field, provenance) => {
    const initial = snapshot();
    const run = activeRun();
    const item = itemSchema.parse({
      ...activeTool(run.id),
      provenance: {
        event: "started",
        nativeIds: { toolCallId: "tool-1" },
        provider: "provider",
      },
    });
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

    expect(() =>
      applyCommittedMutation(
        ended,
        mutation(
          ended,
          [
            {
              entity: "item",
              op: "put",
              value: { ...terminal, provenance, updatedAt: later },
            },
          ],
          later,
        ),
      ),
    ).toThrow("must enrich content");
  });

  test.each(terminalItemStatuses)(
    "keeps %s Item terminal outcome and semantic identity immutable during enrichment",
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
      const enriched = {
        ...terminal,
        structuredOutput: { late: true },
        updatedAt: later,
      };

      expect(() =>
        applyCommittedMutation(
          ended,
          mutation(
            ended,
            [{ entity: "item", op: "put", value: { ...enriched, endedAt: later } }],
            later,
          ),
        ),
      ).toThrow("terminal outcome fields cannot change");
      expect(() =>
        applyCommittedMutation(
          ended,
          mutation(
            ended,
            [{ entity: "item", op: "put", value: { ...enriched, audience: "operators" } }],
            later,
          ),
        ),
      ).toThrow("identity fields cannot change");

      if (status === "failed") {
        expect(() =>
          applyCommittedMutation(
            ended,
            mutation(
              ended,
              [
                {
                  entity: "item",
                  op: "put",
                  value: {
                    ...enriched,
                    error: { code: "changed", message: "changed", retryable: true },
                  },
                },
              ],
              later,
            ),
          ),
        ).toThrow("terminal outcome fields cannot change");
      }
    },
  );

  test.each(["resolved", "expired"] as const)(
    "allows an open Interaction to become %s exactly once",
    (status) => {
      const initial = snapshot();
      const run = activeRun();
      const item = activeTool(run.id);
      const request = permission(run.id, item.id);
      const waiting = applyCommittedMutation(
        initial,
        mutation(initial, [
          { entity: "run", op: "put", value: run },
          { entity: "item", op: "put", value: item },
          { entity: "interaction", op: "put", value: request },
        ]),
      );
      const terminal: Interaction =
        status === "resolved"
          ? {
              ...request,
              endedAt: time,
              resolution: { optionId: "allow", type: "selected" },
              status,
            }
          : { ...request, endedAt: request.expiresAt, status };
      const ended = applyCommittedMutation(
        waiting,
        mutation(
          waiting,
          [{ entity: "interaction", op: "put", value: terminal }],
          status === "expired" ? request.expiresAt : time,
        ),
      );

      expect(ended.interactions[0]?.status).toBe(status);
      expect(() =>
        applyCommittedMutation(
          ended,
          mutation(
            ended,
            [{ entity: "interaction", op: "put", value: terminal }],
            status === "expired" ? request.expiresAt : time,
          ),
        ),
      ).toThrow(`Interaction status cannot transition from ${status} to ${status}`);
    },
  );

  test.each([
    ["at", "2026-07-16T08:00:01.000Z"],
    ["after", "2026-07-16T08:00:02.000Z"],
  ] as const)("rejects an open Interaction captured %s its deadline", (_case, capturedAt) => {
    const run = activeRun();
    const item = activeTool(run.id);
    const request = {
      ...permission(run.id, item.id),
      expiresAt: "2026-07-16T08:00:01.000Z",
    };

    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        capturedAt,
        interactions: [request],
        items: [item],
        runs: [run],
      }),
    ).toThrow("Open Interaction");
  });

  test("derives activity from Run and Interaction facts", () => {
    const initial = snapshot();
    const run = activeRun();
    const tool = activeTool(run.id);
    const request = permission(run.id, tool.id);

    expect(deriveSessionActivity(initial)).toBe("idle");

    const running = applyCommittedMutation(
      initial,
      mutation(initial, [{ op: "put", entity: "run", value: run }]),
    );
    expect(deriveSessionActivity(running)).toBe("running");

    const waiting = applyCommittedMutation(
      running,
      mutation(running, [
        { op: "put", entity: "item", value: tool },
        { op: "put", entity: "interaction", value: request },
      ]),
    );
    expect(deriveSessionActivity(waiting)).toBe("requires_action");

    const done = applyCommittedMutation(
      waiting,
      mutation(waiting, [
        {
          op: "put",
          entity: "interaction",
          value: {
            ...request,
            status: "resolved",
            endedAt: time,
            resolution: { type: "selected", optionId: "allow" },
          },
        },
        {
          op: "put",
          entity: "item",
          value: { ...tool, status: "completed", endedAt: time },
        },
        {
          op: "put",
          entity: "run",
          value: {
            ...run,
            status: "completed",
            endedAt: time,
            finishReason: "success",
          },
        },
      ]),
    );
    expect(deriveSessionActivity(done)).toBe("idle");
  });

  test("rejects a Run that ends before subordinate state", () => {
    const initial = snapshot();
    const run = activeRun();
    const tool = activeTool(run.id);
    const request = permission(run.id, tool.id);
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [
        { entity: "run", op: "put", value: run },
        { entity: "item", op: "put", value: tool },
        { entity: "interaction", op: "put", value: request },
      ]),
    );
    const runEndedAt = "2026-07-16T08:00:01.000Z";
    const subordinateEndedAt = "2026-07-16T08:00:02.000Z";
    const terminalRun: Run = {
      ...run,
      endedAt: runEndedAt,
      finishReason: "success",
      status: "completed",
    };

    expect(() =>
      applyCommittedMutation(
        running,
        mutation(running, [
          {
            entity: "item",
            op: "put",
            value: {
              ...tool,
              endedAt: subordinateEndedAt,
              status: "completed",
              updatedAt: subordinateEndedAt,
            },
          },
          {
            entity: "interaction",
            op: "put",
            value: {
              ...request,
              endedAt: runEndedAt,
              resolution: { optionId: "deny", type: "selected" },
              status: "resolved",
            },
          },
          { entity: "run", op: "put", value: terminalRun },
        ]),
      ),
    ).toThrow("Run");

    expect(() =>
      applyCommittedMutation(
        running,
        mutation(running, [
          {
            entity: "item",
            op: "put",
            value: { ...tool, endedAt: runEndedAt, status: "completed" },
          },
          {
            entity: "interaction",
            op: "put",
            value: {
              ...request,
              endedAt: subordinateEndedAt,
              resolution: { optionId: "deny", type: "selected" },
              status: "resolved",
            },
          },
          { entity: "run", op: "put", value: terminalRun },
        ]),
      ),
    ).toThrow("Run");
  });

  test("rejects a Run that ends before an Item endedAt even when updatedAt is ordered", () => {
    const run = {
      ...activeRun(),
      endedAt: "2026-07-16T08:00:01.000Z",
      finishReason: "success" as const,
      status: "completed" as const,
    };

    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        capturedAt: "2026-07-16T08:00:02.000Z",
        items: [
          {
            ...activeTool(run.id),
            endedAt: "2026-07-16T08:00:02.000Z",
            status: "completed",
            updatedAt: run.endedAt,
          },
        ],
        runs: [run],
      }),
    ).toThrow("Run");
  });

  test("rejects a Run that ends before late terminal Item enrichment", () => {
    const enrichedAt = "2026-07-16T08:00:02.000Z";
    const run = {
      ...activeRun(),
      endedAt: "2026-07-16T08:00:01.000Z",
      finishReason: "success" as const,
      status: "completed" as const,
    };

    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        capturedAt: enrichedAt,
        items: [
          {
            ...activeTool(run.id),
            endedAt: time,
            status: "completed",
            structuredOutput: { late: true },
            updatedAt: enrichedAt,
          },
        ],
        runs: [run],
      }),
    ).toThrow("Run");
  });

  test("freezes the Item set after a Run becomes terminal", () => {
    const initial = snapshot();
    const run = activeRun();
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [{ entity: "run", op: "put", value: run }]),
    );
    const item = finishItem(activeTool(run.id), "completed");
    const endedTogether = applyCommittedMutation(
      running,
      mutation(running, [
        { entity: "item", op: "put", value: item },
        { entity: "run", op: "put", value: finishRun(run, "completed") },
      ]),
    );

    expect(endedTogether.items).toEqual([item]);
    expect(() =>
      applyCommittedMutation(
        endedTogether,
        mutation(endedTogether, [
          {
            entity: "item",
            op: "put",
            value: { ...item, id: "late-item" },
          },
        ]),
      ),
    ).toThrow("requires a Run that was active before the Mutation");
    expect(() =>
      applyCommittedMutation(
        endedTogether,
        mutation(
          endedTogether,
          [
            {
              entity: "item",
              op: "put",
              value: {
                ...item,
                structuredOutput: { late: true },
                updatedAt: later,
              },
            },
          ],
          later,
        ),
      ),
    ).toThrow("requires a Run that was active before the Mutation");
  });

  test("allows terminal Item enrichment in the Mutation that closes its active Run", () => {
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
    const terminal = finishItem(item, "completed");
    const endedItem = applyCommittedMutation(
      active,
      mutation(active, [{ entity: "item", op: "put", value: terminal }]),
    );
    const enriched = itemSchema.parse({
      ...terminal,
      structuredOutput: { late: true },
      updatedAt: later,
    });
    const closed = applyCommittedMutation(
      endedItem,
      mutation(
        endedItem,
        [
          {
            entity: "run",
            op: "put",
            value: { ...run, endedAt: later, finishReason: "success", status: "completed" },
          },
          { entity: "item", op: "put", value: enriched },
        ],
        later,
      ),
    );

    expect(closed.items[0]).toEqual(enriched);
    expect(closed.runs[0]?.status).toBe("completed");
  });

  test.each([
    ["decreases", { input: 9, total: 10 }],
    ["drops a field", { total: 10 }],
  ])("rejects cumulative Run usage that %s", (_name, usage) => {
    const initial = snapshot();
    const run = { ...activeRun(), usage: { input: 10, total: 10 } };
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [{ entity: "run", op: "put", value: run }]),
    );

    expect(() =>
      applyCommittedMutation(
        running,
        mutation(running, [{ entity: "run", op: "put", value: { ...run, usage } }]),
      ),
    ).toThrow("cannot be removed or decrease");
  });

  test.each([
    ["decreases", { amount: 0.5, currency: "USD" }],
    ["changes currency", { amount: 1, currency: "EUR" }],
  ])("rejects cumulative Run cost that %s", (_name, cost) => {
    const initial = snapshot();
    const run = {
      ...activeRun(),
      usage: { cost: { amount: 1, currency: "USD" }, total: 10 },
    };
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [{ entity: "run", op: "put", value: run }]),
    );

    expect(() =>
      applyCommittedMutation(
        running,
        mutation(running, [
          { entity: "run", op: "put", value: { ...run, usage: { ...run.usage, cost } } },
        ]),
      ),
    ).toThrow("cost cannot be removed, change currency, or decrease");
  });

  test.each([
    ["Item", "item"],
    ["Interaction", "interaction"],
  ] as const)("rejects an %s created before its owning Run", (_label, entity) => {
    const initial = snapshot();
    const run = { ...activeRun(), startedAt: "2026-07-16T08:00:01.000Z" };
    const value = entity === "item" ? activeTool(run.id) : permission(run.id, "tool-1");
    const subject = {
      ...activeTool(run.id),
      createdAt: run.startedAt,
      updatedAt: run.startedAt,
    };
    const operations: AuthorityOperation[] = [
      { entity: "run", op: "put", value: run },
      ...(entity === "interaction"
        ? [{ entity: "item" as const, op: "put" as const, value: subject }]
        : []),
      { entity, op: "put", value } as AuthorityOperation,
    ];

    expect(() =>
      applyCommittedMutation(initial, mutation(initial, operations, "2026-07-16T08:00:01.000Z")),
    ).toThrow("cannot be earlier");
  });

  test("orders child Run completion and accepts post-terminal Item enrichment", () => {
    const parentId = createDriverId();
    const childId = createDriverId();
    const parent: Run = {
      ...activeRun(parentId),
      endedAt: "2026-07-16T08:00:01.000Z",
      finishReason: "success",
      status: "completed",
    };
    const child: Run = {
      ...activeRun(childId),
      endedAt: "2026-07-16T08:00:02.000Z",
      finishReason: "success",
      parentRunId: parentId,
      status: "completed",
    };

    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        capturedAt: "2026-07-16T08:00:02.000Z",
        runs: [parent, child],
      }),
    ).toThrow("Parent Run");
    expect(
      validateSessionSnapshot({
        ...snapshot(),
        capturedAt: "2026-07-16T08:00:03.000Z",
        items: [
          {
            ...activeTool(parentId),
            endedAt: "2026-07-16T08:00:01.000Z",
            status: "completed",
            updatedAt: "2026-07-16T08:00:02.000Z",
          },
        ],
        runs: [{ ...parent, endedAt: "2026-07-16T08:00:03.000Z" }],
      }),
    ).toMatchObject({
      items: [
        {
          endedAt: "2026-07-16T08:00:01.000Z",
          updatedAt: "2026-07-16T08:00:02.000Z",
        },
      ],
    });
  });

  test("can expire an Interaction immediately when its owning Run terminates", () => {
    const initial = snapshot();
    const run = activeRun();
    const item = activeTool(run.id);
    const request = permission(run.id, item.id);
    const waiting = applyCommittedMutation(
      initial,
      mutation(initial, [
        { entity: "run", op: "put", value: run },
        { entity: "item", op: "put", value: item },
        { entity: "interaction", op: "put", value: request },
      ]),
    );
    const ended = applyCommittedMutation(
      waiting,
      mutation(waiting, [
        {
          entity: "item",
          op: "put",
          value: { ...item, endedAt: time, status: "cancelled" },
        },
        {
          entity: "interaction",
          op: "put",
          value: { ...request, endedAt: time, status: "expired" },
        },
        {
          entity: "run",
          op: "put",
          value: { ...run, endedAt: time, status: "cancelled" },
        },
      ]),
    );

    expect(ended.interactions[0]).toMatchObject({ endedAt: time, status: "expired" });
    expect(Date.parse(time)).toBeLessThan(Date.parse(request.expiresAt));
  });

  test("ignores replayed revisions and rejects gaps", () => {
    const initial = snapshot();
    const first = mutation(initial, [{ op: "put", entity: "run", value: activeRun() }]);
    const next = applyCommittedMutation(initial, first);

    expect(applyCommittedMutation(next, first)).toEqual(next);

    const gap = committedMutationSchema.parse({
      ...first,
      mutationId: createDriverId(),
      baseRevision: 2,
      revision: 3,
    });
    expect(() => applyCommittedMutation(next, gap)).toThrow(ContractInvariantError);
  });

  test("rejects two active top-level Runs", () => {
    const initial = snapshot();
    const invalid = mutation(initial, [
      { op: "put", entity: "run", value: activeRun() },
      { op: "put", entity: "run", value: activeRun() },
    ]);

    expect(() => applyCommittedMutation(initial, invalid)).toThrow(
      "at most one active top-level Run",
    );
  });

  test("requires atomic cleanup when a Session closes", () => {
    const initial = snapshot();
    const run = activeRun();
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [{ op: "put", entity: "run", value: run }]),
    );
    const closedSession: Session = {
      ...running.session,
      status: "closed",
      closedAt: time,
      updatedAt: time,
    };

    expect(() =>
      applyCommittedMutation(
        running,
        mutation(running, [{ op: "put", entity: "session", value: closedSession }]),
      ),
    ).toThrow("closed Session cannot retain active Runs");

    const closed = applyCommittedMutation(
      running,
      mutation(running, [
        {
          op: "put",
          entity: "run",
          value: {
            ...run,
            status: "cancelled",
            endedAt: time,
            reason: "session_closed",
          },
        },
        { op: "put", entity: "session", value: closedSession },
      ]),
    );
    expect(deriveSessionActivity(closed)).toBe("closed");
  });

  test("orders Session closure after its last update", () => {
    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        capturedAt: "2026-07-16T08:00:01.000Z",
        session: {
          ...session(),
          closedAt: time,
          status: "closed",
          updatedAt: "2026-07-16T08:00:01.000Z",
        },
      }),
    ).toThrow("Session closedAt cannot be earlier");

    const run = {
      ...activeRun(),
      endedAt: "2026-07-16T08:00:01.000Z",
      finishReason: "success" as const,
      status: "completed" as const,
    };
    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        capturedAt: "2026-07-16T08:00:01.000Z",
        runs: [run],
        session: { ...session(), closedAt: time, status: "closed" },
      }),
    ).toThrow("Session closedAt cannot be earlier");
  });

  test.each([
    [
      "Session updatedAt",
      () => ({
        ...snapshot(),
        session: { ...session(), updatedAt: "2026-07-16T08:00:01.000Z" },
      }),
    ],
    [
      "Run startedAt",
      () => ({
        ...snapshot(),
        runs: [{ ...activeRun(), startedAt: "2026-07-16T08:00:01.000Z" }],
      }),
    ],
    [
      "Item updatedAt",
      () => {
        const run = activeRun();
        return {
          ...snapshot(),
          items: [{ ...activeTool(run.id), updatedAt: "2026-07-16T08:00:01.000Z" }],
          runs: [run],
        };
      },
    ],
    [
      "Interaction createdAt",
      () => {
        const run = activeRun();
        return {
          ...snapshot(),
          interactions: [
            {
              audience: "participants" as const,
              blocking: true,
              createdAt: "2026-07-16T08:00:01.000Z",
              expiresAt: "2026-07-16T08:05:00.000Z",
              id: createDriverId(),
              kind: "input" as const,
              request: {
                questions: [
                  { id: "answer", prompt: "Answer?", required: true, type: "text" as const },
                ],
              },
              runId: run.id,
              status: "open" as const,
            },
          ],
          runs: [run],
        };
      },
    ],
  ])("rejects %s after snapshot capturedAt", (_label, value) => {
    expect(() => validateSessionSnapshot(value())).toThrow("cannot be later");
  });

  test("requires a positive Interaction lifetime", () => {
    const run = activeRun();
    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        interactions: [
          {
            audience: "participants",
            blocking: true,
            createdAt: time,
            expiresAt: time,
            id: createDriverId(),
            kind: "input",
            request: {
              questions: [{ id: "answer", prompt: "Answer?", required: true, type: "text" }],
            },
            runId: run.id,
            status: "open",
          },
        ],
        runs: [run],
      }),
    ).toThrow("must be later than createdAt");
  });

  test.each([
    [
      "text question with choices",
      {
        id: "name",
        options: [{ id: "a", label: "A" }],
        prompt: "Name?",
        required: true,
        type: "text",
      },
    ],
    [
      "select question without choices",
      { id: "mode", prompt: "Mode?", required: true, type: "single_select" },
    ],
    [
      "confirmation with free text",
      { allowOther: true, id: "confirm", prompt: "Continue?", required: true, type: "confirm" },
    ],
  ])("rejects an impossible Input shape: %s", (_name, question) => {
    expect(() =>
      interactionSchema.parse({
        audience: "participants",
        blocking: true,
        createdAt: time,
        expiresAt: "2026-07-16T08:05:00.000Z",
        id: createDriverId(),
        kind: "input",
        request: { questions: [question] },
        runId: createDriverId(),
        status: "open",
      }),
    ).toThrow();
  });

  test("scopes opaque Item IDs to their Run", () => {
    const sessionValue = session();
    const oldRun: Run = {
      ...activeRun(),
      status: "completed",
      endedAt: time,
      finishReason: "success",
    };
    const nextRun = activeRun();
    const value = validateSessionSnapshot({
      protocolVersion: 2,
      revision: 2,
      capturedAt: time,
      session: sessionValue,
      runs: [oldRun, nextRun],
      items: [
        { ...activeTool(oldRun.id, "call-1"), status: "completed", endedAt: time },
        activeTool(nextRun.id, "call-1"),
      ],
      interactions: [],
    });

    expect(value.items).toHaveLength(2);
  });

  test("removes a terminal Run and its subordinate entities as one operation", () => {
    const sessionValue = session();
    const run: Run = {
      ...activeRun(),
      status: "completed",
      endedAt: time,
      finishReason: "success",
    };
    const item: Item = {
      ...activeTool(run.id),
      status: "completed",
      endedAt: time,
    };
    const current = validateSessionSnapshot({
      protocolVersion: 2,
      revision: 1,
      capturedAt: time,
      session: sessionValue,
      runs: [run],
      items: [item],
      interactions: [],
    });
    const compacted = applyCommittedMutation(
      current,
      mutation(current, [{ op: "remove", entity: "run", id: run.id, reason: "compacted" }]),
    );

    expect(compacted.runs).toEqual([]);
    expect(compacted.items).toEqual([]);
  });

  test("compacts a retry target without retaining an unbounded history chain", () => {
    const firstId = createDriverId();
    const retryId = createDriverId();
    const first: Run = {
      ...activeRun(firstId),
      endedAt: time,
      finishReason: "success",
      status: "completed",
    };
    const retry: Run = {
      ...activeRun(retryId),
      endedAt: time,
      finishReason: "success",
      retryOf: firstId,
      status: "completed",
    };
    const current = validateSessionSnapshot({
      ...snapshot(),
      revision: 1,
      runs: [first, retry],
    });
    const compacted = applyCommittedMutation(
      current,
      mutation(current, [{ entity: "run", id: firstId, op: "remove", reason: "compacted" }]),
    );

    expect(compacted.runs).toEqual([retry]);
    const invalidInitial = snapshot();
    expect(() =>
      applyCommittedMutation(
        invalidInitial,
        mutation(invalidInitial, [
          {
            entity: "run",
            op: "put",
            value: { ...activeRun(), retryOf: createDriverId() },
          },
        ]),
      ),
    ).toThrow("has no retry target");

    const activeTarget = activeRun();
    const activeState = applyCommittedMutation(
      invalidInitial,
      mutation(invalidInitial, [{ entity: "run", op: "put", value: activeTarget }]),
    );
    const nextAttempt = { ...activeRun(), retryOf: activeTarget.id };
    const retried = applyCommittedMutation(
      activeState,
      mutation(activeState, [
        { entity: "run", op: "put", value: nextAttempt },
        {
          entity: "run",
          op: "put",
          value: {
            ...activeTarget,
            endedAt: time,
            error: { code: "failed", message: "failed", retryable: true },
            status: "failed",
          },
        },
      ]),
    );
    expect(retried.runs.map((run) => run.status)).toEqual(["failed", "active"]);
  });

  test("does not roll state back for a late snapshot", () => {
    const initial = snapshot();
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [{ op: "put", entity: "run", value: activeRun() }]),
    );

    expect(
      applySyncPayload(running, {
        type: "snapshot",
        snapshot: initial,
        minimumResumeRevision: 0,
      }),
    ).toEqual(running);
  });

  test("keeps Coordinator time monotonic across commits and equal-revision snapshots", () => {
    const initial = snapshot();
    const current = validateSessionSnapshot({
      ...initial,
      capturedAt: "2026-07-16T08:00:01.000Z",
    });
    expect(() =>
      applyCommittedMutation(
        current,
        mutation(current, [{ entity: "run", op: "put", value: activeRun() }]),
      ),
    ).toThrow("Mutation committedAt cannot be earlier");

    expect(
      applySyncPayload(current, {
        minimumResumeRevision: 0,
        snapshot: initial,
        type: "snapshot",
      }),
    ).toEqual(current);
  });

  test.each([
    ["complete replay", 1, 0, 1],
    ["partial overlap", 1, 0, 2],
  ] as const)(
    "accepts a %s mutation batch",
    (_case, currentRevision, baseRevision, throughRevision) => {
      const initial = snapshot();
      const run = activeRun();
      const first = mutation(initial, [{ entity: "run", op: "put", value: run }]);
      const atOne = applyCommittedMutation(initial, first);
      const second = mutation(atOne, [
        { entity: "run", op: "put", value: { ...run, usage: { total: 1 } } },
      ]);
      const current = currentRevision === 1 ? atOne : initial;
      const mutations = throughRevision === 1 ? [first] : [first, second];
      const result = applySyncPayload(current, {
        baseRevision,
        mutations,
        throughRevision,
        type: "mutations",
      });

      expect(result.revision).toBe(throughRevision === 1 ? currentRevision : 2);
      expect(result.runs[0]?.usage?.total).toBe(throughRevision === 1 ? undefined : 1);
    },
  );

  test("rejects only a genuine forward mutation gap", () => {
    const initial = snapshot();
    const first = mutation(initial, [{ entity: "run", op: "put", value: activeRun() }]);
    const current = applyCommittedMutation(initial, first);
    const futureBase = { ...current, revision: 2 };
    const third = mutation(futureBase, [
      { entity: "run", op: "put", value: { ...current.runs[0]!, usage: { total: 1 } } },
    ]);

    expect(() =>
      applySyncPayload(current, {
        baseRevision: 2,
        mutations: [third],
        throughRevision: 3,
        type: "mutations",
      }),
    ).toThrow("base revision 2");
  });

  test("rejects a fully replayed mutation batch from another Session", () => {
    const initial = snapshot();
    const current = applyCommittedMutation(
      initial,
      mutation(initial, [{ entity: "run", op: "put", value: activeRun() }]),
    );
    const other = snapshot();

    expect(() =>
      applySyncPayload(current, {
        baseRevision: 0,
        mutations: [mutation(other, [{ entity: "run", op: "put", value: activeRun() }])],
        throughRevision: 1,
        type: "mutations",
      }),
    ).toThrow("identities do not match");
  });

  test("validates local state even when a mutation sync is empty", () => {
    const invalid = {
      ...snapshot(),
      runs: [activeRun()],
      session: {
        ...session(),
        closedAt: time,
        status: "closed",
      },
    } as SessionSnapshot;

    expect(() =>
      applySyncPayload(invalid, {
        baseRevision: 0,
        mutations: [],
        throughRevision: 0,
        type: "mutations",
      }),
    ).toThrow("A closed Session cannot retain active Runs or open Interactions");
  });

  test.each(["snapshot", "mutations"] as const)(
    "enforces inline admission while applying a %s sync",
    (type) => {
      const initial = snapshot();
      const run = {
        ...activeRun(),
        input: [{ data: "aGk=", mediaType: "text/plain", type: "inline_blob" as const }],
      };
      const committed = mutation(initial, [{ entity: "run", op: "put", value: run }]);
      const payload =
        type === "snapshot"
          ? {
              minimumResumeRevision: 0,
              snapshot: applyCommittedMutation(initial, committed),
              type,
            }
          : { baseRevision: 0, mutations: [committed], throughRevision: 1, type };

      expect(() =>
        applySyncPayload(type === "snapshot" ? undefined : initial, payload, {
          maxInlineBytes: 1,
          maxMutationBatchCount: 16,
          maxMutationBytes: 64 * 1_024,
          maxSnapshotBytes: 64 * 1_024,
        }),
      ).toThrow("inline Blob");
    },
  );

  test("enforces the mutation count while applying sync", () => {
    const initial = snapshot();
    const run = activeRun();
    const first = mutation(initial, [{ entity: "run", op: "put", value: run }]);
    const atOne = applyCommittedMutation(initial, first);
    const second = mutation(atOne, [
      { entity: "run", op: "put", value: { ...run, usage: { total: 1 } } },
    ]);

    expect(() =>
      applySyncPayload(
        initial,
        {
          baseRevision: 0,
          mutations: [first, second],
          throughRevision: 2,
          type: "mutations",
        },
        {
          maxInlineBytes: 1_024,
          maxMutationBatchCount: 1,
          maxMutationBytes: 64 * 1_024,
          maxSnapshotBytes: 64 * 1_024,
        },
      ),
    ).toThrow("mutation count");
  });

  test.each(["snapshot", "mutations"] as const)(
    "enforces the encoded object limit while applying a %s sync",
    (type) => {
      const initial = snapshot();
      const committed = mutation(initial, [{ entity: "run", op: "put", value: activeRun() }]);
      const admitted = type === "snapshot" ? initial : committed;
      const bytes = new TextEncoder().encode(JSON.stringify(admitted)).byteLength;
      const payload =
        type === "snapshot"
          ? { minimumResumeRevision: 0, snapshot: initial, type }
          : { baseRevision: 0, mutations: [committed], throughRevision: 1, type };
      const limits = {
        maxInlineBytes: 1_024,
        maxMutationBatchCount: 16,
        maxMutationBytes: type === "mutations" ? bytes : 64 * 1_024,
        maxSnapshotBytes: type === "snapshot" ? bytes : 64 * 1_024,
      };

      expect(() =>
        applySyncPayload(type === "snapshot" ? undefined : initial, payload, limits),
      ).not.toThrow();
      expect(() =>
        applySyncPayload(type === "snapshot" ? undefined : initial, payload, {
          ...limits,
          ...(type === "snapshot"
            ? { maxSnapshotBytes: bytes - 1 }
            : { maxMutationBytes: bytes - 1 }),
        }),
      ).toThrow("byte limit");
    },
  );

  test("rejects cyclic, active, and overlapping Run retries", () => {
    const firstId = createDriverId();
    const secondId = createDriverId();
    const terminal = (id: string, parentRunId: string): Run => ({
      ...activeRun(id),
      parentRunId,
      status: "completed",
      endedAt: time,
      finishReason: "success",
    });

    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        runs: [terminal(firstId, secondId), terminal(secondId, firstId)],
      }),
    ).toThrow("cyclic parent chain");

    const active = activeRun(firstId);
    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        capturedAt: "2026-07-16T08:05:00.000Z",
        runs: [
          active,
          {
            ...activeRun(secondId),
            retryOf: active.id,
            status: "failed",
            endedAt: time,
            error: { code: "failed", message: "failed", retryable: true },
          },
        ],
      }),
    ).toThrow("only retry a terminal Run");

    expect(() =>
      validateSessionSnapshot({
        ...snapshot(),
        capturedAt: "2026-07-16T08:05:00.000Z",
        runs: [
          {
            ...activeRun(firstId),
            status: "completed",
            endedAt: "2026-07-16T08:05:00.000Z",
            finishReason: "success",
          },
          {
            ...activeRun(secondId),
            retryOf: firstId,
            startedAt: "2026-07-16T08:04:00.000Z",
          },
        ],
      }),
    ).toThrow("cannot be earlier");
  });

  test("keeps an open Interaction request immutable", () => {
    const initial = snapshot();
    const run = activeRun();
    const tool = activeTool(run.id);
    const request = permission(run.id, tool.id);
    const waiting = applyCommittedMutation(
      initial,
      mutation(initial, [
        { op: "put", entity: "run", value: run },
        { op: "put", entity: "item", value: tool },
        { op: "put", entity: "interaction", value: request },
      ]),
    );

    expect(() =>
      applyCommittedMutation(
        waiting,
        mutation(waiting, [
          {
            op: "put",
            entity: "interaction",
            value: { ...request, request: { ...request.request, title: "Changed" } },
          },
        ]),
      ),
    ).toThrow("identity fields cannot change");

    expect(() =>
      applyCommittedMutation(
        waiting,
        mutation(waiting, [
          {
            entity: "interaction",
            op: "put",
            value: { ...request, expiresAt: "2026-07-16T08:10:00.000Z" },
          },
        ]),
      ),
    ).toThrow("expiration cannot change");
  });

  test("keeps first-commit entity order across Upserts", () => {
    const initial = snapshot();
    const run = activeRun();
    const first = activeTool(run.id, "first");
    const second = activeTool(run.id, "second");
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [
        { op: "put", entity: "run", value: run },
        { op: "put", entity: "item", value: first },
        { op: "put", entity: "item", value: second },
      ]),
    );
    const updated = applyCommittedMutation(
      running,
      mutation(running, [{ op: "put", entity: "item", value: { ...first, title: "Updated" } }]),
    );

    expect(updated.items.map((item) => item.id)).toEqual(["first", "second"]);
  });

  test("keeps Item semantic identity immutable", () => {
    const initial = snapshot();
    const run = activeRun();
    const message = {
      id: "message",
      runId: run.id,
      kind: "message" as const,
      status: "active" as const,
      createdAt: time,
      updatedAt: time,
      audience: "participants" as const,
      role: "agent" as const,
      content: [],
    };
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [
        { op: "put", entity: "run", value: run },
        { op: "put", entity: "item", value: message },
      ]),
    );

    expect(() =>
      applyCommittedMutation(
        running,
        mutation(running, [{ op: "put", entity: "item", value: { ...message, role: "user" } }]),
      ),
    ).toThrow("identity fields cannot change");
    expect(() =>
      validateSessionSnapshot({
        ...running,
        items: [{ ...message, role: "user", phase: "final" }],
      }),
    ).toThrow("cannot declare an Agent output phase");
  });

  test("compares immutable JSON independently of object key order", () => {
    const initial = snapshot();
    const run: Run = {
      ...activeRun(),
      input: [{ type: "json", value: { first: 1, second: 2 } }],
    };
    const running = applyCommittedMutation(
      initial,
      mutation(initial, [{ op: "put", entity: "run", value: run }]),
    );
    const updated = applyCommittedMutation(
      running,
      mutation(running, [
        {
          op: "put",
          entity: "run",
          value: {
            ...run,
            input: [{ type: "json", value: { second: 2, first: 1 } }],
            usage: { total: 1 },
          },
        },
      ]),
    );

    expect(updated.runs[0]?.usage?.total).toBe(1);
  });
});

function append(itemId: string, streamId: string, sequence: number, text: string): PreviewUpdate {
  return {
    itemId,
    streamId,
    channel: "message.text",
    segment: 0,
    op: "append",
    fromSequence: sequence,
    throughSequence: sequence,
    text,
  };
}

describe("contract Preview lane", () => {
  test("rejects empty appends and sequence zero", () => {
    expect(previewUpdateSchema.safeParse(append("message", "text", 1, "")).success).toBe(false);
    expect(
      previewUpdateSchema.safeParse({
        itemId: "message",
        streamId: "text",
        channel: "message.text",
        segment: 0,
        op: "replace",
        throughSequence: 0,
        text: "",
      }).success,
    ).toBe(false);
  });

  test("coalesces independent streams without changing per-stream order", () => {
    const updates = coalescePreviewUpdates([
      append("message", "text", 1, "a"),
      append("other", "text", 1, "x"),
      append("message", "text", 2, "b"),
    ]);

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ itemId: "message", text: "ab", throughSequence: 2 });
    expect(updates[1]).toMatchObject({ itemId: "other", text: "x" });
  });

  test("uses replace to heal gaps", () => {
    const gap = applyPreviewUpdate(undefined, append("message", "text", 2, "b"));
    expect(gap).toEqual({
      status: "gap",
      state: { text: undefined, throughSequence: 2 },
    });

    expect(
      applyPreviewUpdate(gap.state, {
        itemId: "message",
        streamId: "text",
        channel: "message.text",
        segment: 0,
        op: "replace",
        throughSequence: 1,
        text: "a",
      }),
    ).toEqual({ status: "duplicate", state: gap.state });

    const replaced = applyPreviewUpdate(gap.state, {
      itemId: "message",
      streamId: "text",
      channel: "message.text",
      segment: 0,
      op: "replace",
      throughSequence: 2,
      text: "ab",
    });
    expect(replaced).toEqual({
      status: "applied",
      state: { text: "ab", throughSequence: 2 },
    });
  });

  test("drops pending Preview data instead of growing behind a slow flush", async () => {
    let release: (() => void) | undefined;
    const firstFlush = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dropped: PreviewUpdate[][] = [];
    let flushes = 0;
    const buffer = createPreviewBuffer({
      maxBytes: 1024,
      maxDelayMs: 1000,
      maxUpdates: 1,
      flush: async () => {
        flushes += 1;
        await firstFlush;
      },
      onDrop: (updates) => dropped.push([...updates]),
    });

    buffer.push(append("message", "text", 1, "a"));
    buffer.push(append("message", "text", 2, "b"));
    expect(dropped).toHaveLength(1);
    expect(buffer.size).toBe(0);

    release?.();
    await buffer.flush();
    expect(flushes).toBe(1);
    buffer.dispose();
  });

  test("never emits an update array above its byte limit", async () => {
    const maxBytes = 300;
    const batches: PreviewUpdate[][] = [];
    const buffer = createPreviewBuffer({
      maxBytes,
      maxDelayMs: 1000,
      maxUpdates: 10,
      flush: (updates) => batches.push([...updates]),
    });

    buffer.push(append("first", "text", 1, "x".repeat(70)));
    buffer.push(append("second", "text", 1, "x".repeat(70)));
    await buffer.flush();

    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => jsonByteLength(batch) <= maxBytes)).toBe(true);
    buffer.dispose();
  });

  test("owns an admitted Preview update after push", async () => {
    const batches: PreviewUpdate[][] = [];
    const buffer = createPreviewBuffer({
      flush: (updates) => batches.push([...updates]),
      maxBytes: 1024,
      maxDelayMs: 1000,
      maxUpdates: 10,
    });
    const update = append("message", "text", 1, "safe");

    buffer.push(update);
    const admittedBytes = buffer.bytes;
    update.text = "mutated".repeat(100);
    await buffer.flush();

    expect(batches).toEqual([[append("message", "text", 1, "safe")]]);
    expect(admittedBytes).toBe(jsonByteLength(batches[0]));
    buffer.dispose();
  });

  test("rejects malformed Preview updates before admission", () => {
    const dropped: PreviewUpdate[][] = [];
    const buffer = createPreviewBuffer({
      flush: () => {},
      maxBytes: 1024,
      maxDelayMs: 1000,
      maxUpdates: 10,
      onDrop: (updates) => dropped.push([...updates]),
    });

    expect(() =>
      buffer.push({ ...append("message", "text", 1, "x"), throughSequence: 0 }),
    ).toThrow();
    expect({ bytes: buffer.bytes, dropped, size: buffer.size }).toEqual({
      bytes: 0,
      dropped: [],
      size: 0,
    });
    buffer.dispose();
  });

  test("admits an exact Preview byte budget and drops one byte below it", async () => {
    const update = append("message", "text", 1, "exact");
    const maxBytes = jsonByteLength([previewUpdateSchema.parse(update)]);
    const batches: PreviewUpdate[][] = [];
    const dropped: PreviewUpdate[][] = [];
    const exact = createPreviewBuffer({
      flush: (updates) => batches.push([...updates]),
      maxBytes,
      maxDelayMs: 1000,
      maxUpdates: 10,
    });
    const undersized = createPreviewBuffer({
      flush: () => {},
      maxBytes: maxBytes - 1,
      maxDelayMs: 1000,
      maxUpdates: 10,
      onDrop: (updates) => dropped.push([...updates]),
    });

    exact.push(update);
    undersized.push(update);
    await exact.flush();

    expect(exact.bytes).toBe(0);
    expect(batches).toEqual([[update]]);
    expect(jsonByteLength(batches[0])).toBe(maxBytes);
    expect(dropped).toEqual([[update]]);
    exact.dispose();
    undersized.dispose();
  });

  test.each([2_147_483_647, 2_147_483_648, Number.MAX_SAFE_INTEGER])(
    "accepts a safe Preview delay %p and clamps only the platform timer",
    (maxDelayMs) => {
      const buffer = createPreviewBuffer({
        flush: () => {},
        maxBytes: 1024,
        maxDelayMs,
        maxUpdates: 10,
      });

      buffer.push(append("message", "text", 1, "pending"));
      expect(buffer.size).toBe(1);
      buffer.dispose();
    },
  );

  test.each([
    { maxBytes: Number.NaN, maxDelayMs: 1, maxUpdates: 1 },
    { maxBytes: 1.5, maxDelayMs: 1, maxUpdates: 1 },
    { maxBytes: 1, maxDelayMs: 0, maxUpdates: 1 },
    { maxBytes: 1, maxDelayMs: 1.5, maxUpdates: 1 },
    { maxBytes: 1, maxDelayMs: Number.POSITIVE_INFINITY, maxUpdates: 1 },
    { maxBytes: 1, maxDelayMs: 1, maxUpdates: 1.5 },
  ])("rejects an invalid Preview buffer limit: %p", (limits) => {
    expect(() => createPreviewBuffer({ flush: () => {}, ...limits })).toThrow("positive integers");
  });

  test("disposal clears buffered data and prevents a delayed flush", async () => {
    let flushes = 0;
    const buffer = createPreviewBuffer({
      flush: () => {
        flushes += 1;
      },
      maxBytes: 1024,
      maxDelayMs: 5,
      maxUpdates: 10,
    });

    buffer.push(append("message", "text", 1, "pending"));
    buffer.dispose();
    await Bun.sleep(20);
    await buffer.flush();

    expect({ bytes: buffer.bytes, flushes, size: buffer.size }).toEqual({
      bytes: 0,
      flushes: 0,
      size: 0,
    });
    expect(() => buffer.push(append("message", "text", 2, "late"))).toThrow("disposed");
  });

  test("requires Preview to target a compatible active Item", () => {
    const initial = snapshot();
    const run = activeRun();
    const state = applyCommittedMutation(
      initial,
      mutation(initial, [
        { op: "put", entity: "run", value: run },
        { op: "put", entity: "item", value: activeTool(run.id) },
      ]),
    );

    expect(() =>
      validatePreviewBatch(state, {
        sessionId: state.session.id,
        runId: run.id,
        emittedAt: time,
        updates: [append("tool-1", "text", 1, "not a message")],
      }),
    ).toThrow("cannot target an Item of kind tool");
  });
});

describe("contract closed core", () => {
  test("keeps Coordinator resource policies out of peer negotiation", () => {
    const initialize = {
      protocolVersion: 2,
      role: "observer",
      implementation: { name: "observer", version: "1" },
      capabilities: {},
      limits: { maxFrameBytes: 1024 },
    };

    expect(initializeParamsSchema.safeParse(initialize).success).toBe(true);
    expect(
      initializeParamsSchema.safeParse({
        ...initialize,
        limits: { ...initialize.limits, maxPendingCommandBytes: 1 },
      }).success,
    ).toBe(false);
  });

  test.each([
    "maxCommandBytes",
    "maxMutationBytes",
    "maxPreviewBatchBytes",
    "maxSnapshotBytes",
  ] as const)("rejects %s that cannot fit in maxFrameBytes", (field) => {
    const limits = protocolLimits({ [field]: 4_096, maxFrameBytes: 4_096 });

    expect(
      initializeResultSchema.safeParse({
        protocolVersion: 2,
        implementation: { name: "coordinator", version: "1" },
        capabilities: {},
        limits,
      }).success,
    ).toBe(false);
  });

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

  test("normalization preserves terminal status, error, and semantic identity for validation", () => {
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
    const terminal = finishItem(item, "failed");
    const ended = applyCommittedMutation(
      active,
      mutation(active, [{ entity: "item", op: "put", value: terminal }]),
    );
    const clientAt = "2099-01-01T00:00:00.000Z";
    const content = itemSchema.parse({
      ...item,
      endedAt: clientAt,
      status: "completed",
      structuredOutput: { late: true },
      updatedAt: clientAt,
    });
    const cases = [
      {
        expected: { status: "completed" },
        message: "Item status cannot transition",
        value: content,
      },
      {
        expected: { error: { code: "changed" } },
        message: "terminal outcome fields cannot change",
        value: itemSchema.parse({
          ...terminal,
          endedAt: clientAt,
          error: { code: "changed", message: "changed", retryable: true },
          structuredOutput: { late: true },
          updatedAt: clientAt,
        }),
      },
      {
        expected: { origin: "host" },
        message: "identity fields cannot change",
        value: itemSchema.parse({
          ...terminal,
          endedAt: clientAt,
          origin: "host",
          structuredOutput: { late: true },
          updatedAt: clientAt,
        }),
      },
    ];

    for (const testCase of cases) {
      const normalized = normalizeExecutorMutation(
        ended,
        proposal(ended, [{ entity: "item", op: "put", value: testCase.value }]),
        later,
        1_000,
      );

      expect(normalized.operations[0]).toMatchObject({
        value: { ...testCase.expected, endedAt: terminal.endedAt },
      });
      expect(() =>
        applyCommittedMutation(ended, {
          ...normalized,
          committedAt: later,
          revision: ended.revision + 1,
        }),
      ).toThrow(testCase.message);
    }
  });

  test("rejects unknown commands and accepts namespaced content extensions", () => {
    expect(
      commandSchema.safeParse({
        commandId: createDriverId(),
        sessionId: createDriverId(),
        kind: "run.pause",
      }).success,
    ).toBe(false);
    expect(
      extensionContentSchema.parse({
        type: "extension",
        name: "example.org/widget",
        value: { state: "ready" },
      }),
    ).toMatchObject({ name: "example.org/widget" });
  });

  test.each([
    [
      "request params",
      () =>
        jsonRpcRequestSchema.parse({
          id: 1,
          jsonrpc: "2.0",
          method: "test",
          params: () => undefined,
        }),
    ],
    [
      "success result",
      () =>
        jsonRpcSuccessSchema.parse({
          id: 1,
          jsonrpc: "2.0",
          result: 1n,
        }),
    ],
  ])("rejects non-JSON JSON-RPC %s", (_label, parse) => {
    expect(parse).toThrow();
  });

  test("requires contiguous reliable mutation batches", () => {
    const state = snapshot();
    const first = mutation(state, [{ op: "put", entity: "run", value: activeRun() }]);

    expect(
      mutationSyncSchema.safeParse({
        type: "mutations",
        baseRevision: 0,
        throughRevision: 2,
        mutations: [first],
      }).success,
    ).toBe(false);
    expect(
      mutationSyncSchema.safeParse({
        type: "mutations",
        baseRevision: 0,
        throughRevision: 2,
        mutations: [first, { ...first, baseRevision: 1, revision: 2 }],
      }).success,
    ).toBe(false);
  });

  test("validates terminal Command receipts and cleanup deadlines", () => {
    expect(
      commandReceiptSchema.safeParse({
        commandId: createDriverId(),
        status: "accepted",
        duplicate: false,
        result: { ok: true },
      }).success,
    ).toBe(false);
    expect(
      cleanupObligationSchema.safeParse({
        id: createDriverId(),
        sessionId: createDriverId(),
        kind: "sandbox",
        resourceKey: "sandbox-1",
        releaseAfter: "2026-07-16T08:05:00.000Z",
        attempts: 0,
        nextAttemptAt: time,
      }).success,
    ).toBe(false);
  });

  test("validates Commands against current revision and Interaction content", () => {
    const initial = snapshot();
    expect(() =>
      validateCommand(
        initial,
        {
          commandId: createDriverId(),
          sessionId: initial.session.id,
          expectedRevision: 1,
          kind: "run.start",
          runId: createDriverId(),
          input: [{ type: "text", text: "work" }],
        },
        time,
      ),
    ).toThrow("expected revision 1");

    const run = activeRun();
    const interaction: Interaction = {
      id: createDriverId(),
      runId: run.id,
      kind: "input",
      status: "open",
      blocking: true,
      createdAt: time,
      expiresAt: "2026-07-16T08:05:00.000Z",
      audience: "participants",
      request: {
        questions: [{ id: "confirm", prompt: "Continue?", type: "confirm", required: true }],
      },
    };
    const waiting = applyCommittedMutation(
      initial,
      mutation(initial, [
        { op: "put", entity: "run", value: run },
        { op: "put", entity: "interaction", value: interaction },
      ]),
    );
    expect(() =>
      validateSessionSnapshot({
        ...waiting,
        interactions: [
          {
            ...interaction,
            request: {
              questions: [
                {
                  ...interaction.request.questions[0],
                  options: [],
                },
              ],
            },
          },
        ],
      }),
    ).toThrow();
    const resolve = {
      commandId: createDriverId(),
      sessionId: waiting.session.id,
      kind: "interaction.resolve",
      interactionId: interaction.id,
      resolution: {
        kind: "input",
        value: { type: "answered", answers: { confirm: ["true"] } },
      },
    };

    expect(validateCommand(waiting, resolve, time)).toMatchObject({
      kind: "interaction.resolve",
    });
    expect(() =>
      validateCommand(
        waiting,
        {
          ...resolve,
          resolution: {
            kind: "input",
            value: { type: "answered", answers: { confirm: ["maybe"] } },
          },
        },
        time,
      ),
    ).toThrow("must be true or false");
    expect(() => validateCommand(waiting, resolve, "2026-07-16T08:06:00.000Z")).toThrow(
      "has expired",
    );
    expect(() => validateCommand(waiting, resolve, interaction.expiresAt)).toThrow("has expired");
  });

  test("rejects a Command acceptance time before the current snapshot", () => {
    const current = validateSessionSnapshot({
      ...snapshot(),
      capturedAt: "2026-07-16T08:00:01.000Z",
    });

    expect(() =>
      validateCommand(
        current,
        {
          commandId: createDriverId(),
          input: [{ text: "work", type: "text" }],
          kind: "run.start",
          runId: createDriverId(),
          sessionId: current.session.id,
        },
        time,
      ),
    ).toThrow("cannot precede");
  });

  test("preserves sub-millisecond ordering when accepting Commands", () => {
    const current = validateSessionSnapshot({
      ...snapshot(),
      capturedAt: "2026-07-16T08:00:00.0000009Z",
    });

    expect(() =>
      validateCommand(
        current,
        {
          commandId: createDriverId(),
          input: [{ text: "work", type: "text" }],
          kind: "run.start",
          runId: createDriverId(),
          sessionId: current.session.id,
        },
        "2026-07-16T08:00:00.0000001Z",
      ),
    ).toThrow("cannot precede");
  });

  test("requires a negotiated capability for extension ContentBlocks", () => {
    const initial = snapshot();
    const command = {
      commandId: createDriverId(),
      input: [{ name: "example.org/widget", type: "extension" as const, value: {} }],
      kind: "run.start" as const,
      runId: createDriverId(),
      sessionId: initial.session.id,
    };

    expect(() => validateCommand(initial, command, time)).toThrow("was not negotiated");
    expect(
      validateCommand(
        {
          ...initial,
          session: {
            ...initial.session,
            capabilities: { ...initial.session.capabilities, "example.org/widget": {} },
          },
        },
        command,
        time,
      ),
    ).toMatchObject({ kind: "run.start" });
  });

  test("requires a negotiated capability for extension Items", () => {
    const initial = snapshot();
    const run = activeRun();
    const item = {
      audience: "participants" as const,
      createdAt: time,
      id: "extension-1",
      kind: "extension" as const,
      name: "example.org/widget",
      runId: run.id,
      status: "active" as const,
      updatedAt: time,
      value: {},
    };

    expect(() => validateSessionSnapshot({ ...initial, items: [item], runs: [run] })).toThrow(
      "was not negotiated",
    );
    expect(() =>
      validateSessionSnapshot({
        ...initial,
        items: [item],
        runs: [run],
        session: {
          ...initial.session,
          capabilities: { ...initial.session.capabilities, "example.org/widget": {} },
        },
      }),
    ).not.toThrow();
  });

  test.each([
    [
      "Run input",
      (run: Run, content: Run["input"]) => ({ items: [], runs: [{ ...run, input: content }] }),
    ],
    [
      "Item content",
      (run: Run, content: Run["input"]) => ({
        items: [
          {
            audience: "participants" as const,
            content,
            createdAt: time,
            id: "message-1",
            kind: "message" as const,
            role: "agent" as const,
            runId: run.id,
            status: "active" as const,
            updatedAt: time,
          },
        ],
        runs: [run],
      }),
    ],
  ] as const)("validates extension capabilities in %s", (_case, makeState) => {
    const initial = snapshot();
    const extension = { name: "example.org/widget", type: "extension" as const, value: {} };
    const run = activeRun();
    const { items, runs } = makeState(run, [extension]);

    expect(() => validateSessionSnapshot({ ...initial, items, runs })).toThrow(
      "was not negotiated",
    );
    expect(() =>
      validateSessionSnapshot({
        ...initial,
        items,
        runs,
        session: {
          ...initial.session,
          capabilities: { ...initial.session.capabilities, "example.org/widget": {} },
        },
      }),
    ).not.toThrow();
  });

  test("accepts free-text select answers only when the question allows them", () => {
    const initial = snapshot();
    const run = activeRun();
    const interaction: Interaction = {
      audience: "participants",
      blocking: true,
      createdAt: time,
      expiresAt: "2026-07-16T08:05:00.000Z",
      id: createDriverId(),
      kind: "input",
      request: {
        questions: [
          {
            allowOther: true,
            id: "mode",
            options: [{ id: "fast", label: "Fast" }],
            prompt: "Mode?",
            required: true,
            type: "single_select",
          },
        ],
      },
      runId: run.id,
      status: "open",
    };
    const waiting = applyCommittedMutation(
      initial,
      mutation(initial, [
        { entity: "run", op: "put", value: run },
        { entity: "interaction", op: "put", value: interaction },
      ]),
    );
    const command = {
      commandId: createDriverId(),
      interactionId: interaction.id,
      kind: "interaction.resolve" as const,
      resolution: {
        kind: "input" as const,
        value: { answers: { mode: ["careful"] }, type: "answered" as const },
      },
      sessionId: waiting.session.id,
    };

    expect(validateCommand(waiting, command, time)).toMatchObject({
      kind: "interaction.resolve",
    });
    expect(() =>
      validateCommand(
        {
          ...waiting,
          interactions: [
            {
              ...interaction,
              request: {
                questions: [{ ...interaction.request.questions[0], allowOther: undefined }],
              },
            },
          ],
        },
        command,
        time,
      ),
    ).toThrow("unknown choice");
  });

  test.each([
    {
      answers: { confirm: ["true"], mode: ["fast"] },
      error: null,
      name: "required answers with optional questions omitted",
    },
    {
      answers: {
        confirm: ["false"],
        features: ["search", "edit"],
        mode: ["slow"],
        note: ["careful"],
      },
      error: null,
      name: "all question kinds",
    },
    {
      answers: { mode: ["fast"] },
      error: "missing required question confirm",
      name: "missing required answer",
    },
    {
      answers: { confirm: ["true"], mode: ["fast"], unknown: ["value"] },
      error: "unknown question unknown",
      name: "unknown question",
    },
    {
      answers: { confirm: ["true"], mode: ["fast", "slow"] },
      error: "exactly one value",
      name: "multiple single-select values",
    },
    {
      answers: { confirm: ["true"], features: ["search", "search"], mode: ["fast"] },
      error: "duplicate choices",
      name: "duplicate multi-select values",
    },
    {
      answers: { confirm: ["true"], features: ["unknown"], mode: ["fast"] },
      error: "unknown choice",
      name: "unknown multi-select choice",
    },
    {
      answers: { confirm: ["maybe"], mode: ["fast"] },
      error: "must be true or false",
      name: "invalid confirmation",
    },
    {
      answers: { confirm: ["true"], mode: ["fast"], note: ["one", "two"] },
      error: "exactly one value",
      name: "multiple text values",
    },
  ] as const)("validates combined input answers: $name", ({ answers, error }) => {
    const initial = snapshot();
    const run = activeRun();
    const interaction: Interaction = {
      audience: "participants",
      blocking: true,
      createdAt: time,
      expiresAt: "2026-07-16T08:05:00.000Z",
      id: createDriverId(),
      kind: "input",
      request: {
        questions: [
          { id: "confirm", prompt: "Continue?", required: true, type: "confirm" },
          {
            id: "mode",
            options: [
              { id: "fast", label: "Fast" },
              { id: "slow", label: "Slow" },
            ],
            prompt: "Mode?",
            required: true,
            type: "single_select",
          },
          {
            id: "features",
            options: [
              { id: "search", label: "Search" },
              { id: "edit", label: "Edit" },
            ],
            prompt: "Features?",
            required: false,
            type: "multi_select",
          },
          { id: "note", prompt: "Notes?", required: false, type: "text" },
        ],
      },
      runId: run.id,
      status: "open",
    };
    const waiting = applyCommittedMutation(
      initial,
      mutation(initial, [
        { entity: "run", op: "put", value: run },
        { entity: "interaction", op: "put", value: interaction },
      ]),
    );
    const command = {
      commandId: createDriverId(),
      interactionId: interaction.id,
      kind: "interaction.resolve",
      resolution: { kind: "input", value: { answers, type: "answered" } },
      sessionId: waiting.session.id,
    };

    if (error === null) {
      expect(validateCommand(waiting, command, time)).toMatchObject({
        kind: "interaction.resolve",
      });
    } else {
      expect(() => validateCommand(waiting, command, time)).toThrow(error);
    }
  });

  test("requires configuration capability and an unused steer Item ID", () => {
    const configurable = session();
    configurable.config = [{ id: "mode", label: "Mode", type: "boolean", value: false }];
    const idle = snapshot(configurable);
    const configure = {
      commandId: createDriverId(),
      sessionId: idle.session.id,
      kind: "session.configure" as const,
      changes: [{ configId: "mode", value: true }],
    };

    expect(() => validateCommand(idle, configure, time)).toThrow("does not support configuration");

    const run = activeRun();
    const commandId = createDriverId();
    const steerInitial = snapshot({
      ...session(),
      capabilities: { "run.steer": {} },
    });
    const steering = applyCommittedMutation(
      steerInitial,
      mutation(steerInitial, [
        { op: "put", entity: "run", value: run },
        {
          op: "put",
          entity: "item",
          value: {
            id: commandId,
            runId: run.id,
            kind: "message",
            status: "completed",
            createdAt: time,
            updatedAt: time,
            endedAt: time,
            audience: "participants",
            role: "user",
            content: [{ type: "text", text: "earlier" }],
          },
        },
      ]),
    );

    expect(() =>
      validateCommand(
        steering,
        {
          commandId,
          sessionId: steering.session.id,
          kind: "run.steer",
          runId: run.id,
          input: [{ type: "text", text: "again" }],
        },
        time,
      ),
    ).toThrow("already exists");
  });
});
