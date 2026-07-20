import { describe, expect, test } from "bun:test";

import {
  ContractInvariantError,
  applyCommittedMutation,
  applySyncPayload,
  committedMutationSchema,
  deriveSessionActivity,
  interactionSchema,
  itemSchema,
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

describe("contract authority reducer", () => {
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
              } as unknown as Item,
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
});
