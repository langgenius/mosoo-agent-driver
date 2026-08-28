import { describe, expect, test } from "bun:test";

import {
  applyCommittedMutation,
  compareTimestamps,
  committedMutationSchema,
  deriveSessionActivity,
  itemSchema,
  protocolIdSchema,
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

describe("contract protocol IDs", () => {
  test.each([
    ["canonical", "01J00000000000000000000009", "01J00000000000000000000009"],
    ["lowercase", "01j00000000000000000000009", "01J00000000000000000000009"],
    ["maximum timestamp", "7ZZZZZZZZZZZZZZZZZZZZZZZZZ", "7ZZZZZZZZZZZZZZZZZZZZZZZZZ"],
  ] as const)("accepts and canonicalizes a %s ULID", (_case, input, expected) => {
    expect(protocolIdSchema.parse(input)).toBe(expected);
    expect(isDriverId(expected)).toBe(true);
  });

  test.each([
    ["UUID", "00000000-0000-4000-8000-000000000001"],
    ["excluded alphabet character", "01J0000000000000000000000I"],
    ["overflowing timestamp", "80000000000000000000000000"],
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
              value: { ...terminal, structuredOutput: { late: true } } as unknown as Item,
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
});
