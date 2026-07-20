import { expect, test } from "bun:test";

import {
  AuthorityOutcomeUnknownError,
  applyCommittedMutation,
  interactionSchema,
  itemSchema,
  validateSessionSnapshot,
} from "../src/contract";
import type {
  AuthorityOperation,
  CommittedMutation,
  Item,
  Run,
  SessionSnapshot,
} from "../src/contract";
import {
  ContractProjection,
  type ContractAuthorityUpdate,
} from "../src/runtimes/contract-projection";

function protocolId(value: number): string {
  return value.toString().padStart(26, "0");
}

const SESSION_ID = protocolId(1);
const RUN_ID = protocolId(2);
const INTERACTION_ID = protocolId(3);
const RESOLVED_INTERACTION_ID = protocolId(5);

function activeRun(startedAt: string, input = true): Run {
  return {
    id: RUN_ID,
    input: input ? [{ text: "hello", type: "text" }] : [],
    origin: input ? "user" : "system",
    startedAt,
    status: "active",
  };
}

function childRun(id: string, parentRunId: string, startedAt: string): Run {
  return {
    id,
    input: [],
    origin: "system",
    parentRunId,
    startedAt,
    status: "active",
  };
}

function runTreeProjection(runs: readonly Run[], capturedAt: string) {
  const root = runs[0];

  if (root === undefined) {
    throw new Error("Run tree fixture requires a root.");
  }

  let committedAt = capturedAt;
  let snapshot: SessionSnapshot = validateSessionSnapshot({
    capturedAt,
    interactions: [],
    items: [],
    protocolVersion: 2,
    revision: 0,
    runs,
    session: {
      capabilities: { "run.child": {} },
      config: [],
      createdAt: root.startedAt,
      id: SESSION_ID,
      status: "open",
      updatedAt: root.startedAt,
    },
  });
  const projection = new ContractProjection({
    authority: async (update) => {
      const revision = snapshot.revision + 1;
      snapshot = applyCommittedMutation(snapshot, {
        baseRevision: snapshot.revision,
        cause: update.cause,
        committedAt,
        mutationId: protocolId(2_000 + revision),
        operations: [...update.operations],
        revision,
        sessionId: SESSION_ID,
      });
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });

  for (const run of runs) {
    projection.attachRun(run);
  }

  return {
    projection,
    setCommittedAt(value: string) {
      committedAt = value;
    },
    snapshot: () => snapshot,
  };
}

function activeMessage(id: string, timestamp: string): Extract<Item, { kind: "message" }> {
  return itemSchema.parse({
    audience: "participants",
    content: [],
    createdAt: timestamp,
    id,
    kind: "message",
    role: "agent",
    runId: RUN_ID,
    status: "active",
    updatedAt: timestamp,
  }) as Extract<Item, { kind: "message" }>;
}

test("Contract projection commits terminal snapshots and remaining cleanup atomically", async () => {
  const startedAt = "2026-07-16T08:00:00.000Z";
  const endedAt = "2026-07-16T08:00:01.000Z";
  const commits: AuthorityOperation[][] = [];
  const projection = new ContractProjection({
    authority: async ({ operations }) => {
      commits.push([...operations]);
    },
    now: () => new Date(endedAt),
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(startedAt));
  await projection.putItem(
    RUN_ID,
    "message/started",
    { providerEventId: "message-1", type: "provider" },
    activeMessage("message-1", startedAt),
  );
  await projection.putItem(
    RUN_ID,
    "message/started",
    { providerEventId: "message-2", type: "provider" },
    activeMessage("message-2", startedAt),
  );
  const error = { code: "turn.incomplete", message: "Missing snapshot.", retryable: false };

  await projection.finishRun({
    cause: { providerEventId: "turn/completed", type: "provider" },
    error,
    event: "turn/completed",
    runId: RUN_ID,
    status: "failed",
    terminalItems: [
      itemSchema.parse({
        ...activeMessage("message-1", startedAt),
        content: [{ text: "done", type: "text" }],
        endedAt,
        status: "completed",
        updatedAt: endedAt,
      }),
    ],
  });

  expect(commits.at(-1)).toMatchObject([
    { entity: "item", op: "put", value: { id: "message-1", status: "completed" } },
    {
      entity: "item",
      op: "put",
      value: { error, id: "message-2", status: "failed" },
    },
    { entity: "run", op: "put", value: { error, id: RUN_ID, status: "failed" } },
  ]);
  expect(projection.run(RUN_ID)).toBeUndefined();
});

test.each([
  [
    "an older requested end",
    "2026-07-16T08:00:01.000Z",
    "2026-07-16T08:00:00.500Z",
    "2026-07-16T08:00:01.000Z",
  ],
  [
    "a newer requested end",
    "2026-07-16T08:00:01.000Z",
    "2026-07-16T08:00:02.000Z",
    "2026-07-16T08:00:02.000Z",
  ],
  [
    "an offset Item update",
    "2026-07-16T16:00:01.500+08:00",
    "2026-07-16T09:00:01.000+01:00",
    "2026-07-16T16:00:01.500+08:00",
  ],
  [
    "a sub-millisecond Item update",
    "2026-07-16T08:00:00.1000009Z",
    "2026-07-16T08:00:00.1000001Z",
    "2026-07-16T08:00:00.1000009Z",
  ],
] as const)(
  "Contract projection ends an atomic terminal Item enrichment after %s",
  async (_name, updatedAt, requestedEnd, expectedEnd) => {
    const startedAt = "2026-07-16T08:00:00.000Z";
    const itemEndedAt = "2026-07-16T08:00:00.100Z";
    let committedAt = itemEndedAt;
    let snapshot: SessionSnapshot = validateSessionSnapshot({
      capturedAt: startedAt,
      interactions: [],
      items: [],
      protocolVersion: 2,
      revision: 0,
      runs: [activeRun(startedAt)],
      session: {
        capabilities: {},
        config: [],
        createdAt: startedAt,
        id: SESSION_ID,
        status: "open",
        updatedAt: startedAt,
      },
    });
    const projection = new ContractProjection({
      authority: async (update) => {
        const revision = snapshot.revision + 1;
        snapshot = applyCommittedMutation(snapshot, {
          baseRevision: snapshot.revision,
          cause: update.cause,
          committedAt,
          mutationId: protocolId(1_000 + revision),
          operations: [...update.operations],
          revision,
          sessionId: SESSION_ID,
        });
      },
      preview: () => {},
      sessionId: SESSION_ID,
    });
    projection.attachRun(activeRun(startedAt));
    const terminal = itemSchema.parse({
      ...activeMessage("message-1", startedAt),
      content: [{ text: "before", type: "text" }],
      endedAt: itemEndedAt,
      status: "completed",
      updatedAt: itemEndedAt,
    });
    await projection.putItem(
      RUN_ID,
      "message/completed",
      { providerEventId: "message-1", type: "provider" },
      terminal,
    );
    committedAt = "2026-07-18T00:00:00.000Z";

    await projection.finishRun({
      cause: { providerEventId: "run-1", type: "provider" },
      endedAt: requestedEnd,
      event: "run/completed",
      runId: RUN_ID,
      status: "completed",
      terminalItems: [
        itemSchema.parse({
          ...terminal,
          content: [{ text: "after", type: "text" }],
          updatedAt,
        }),
      ],
    });

    expect(snapshot.items[0]).toMatchObject({
      content: [{ text: "after", type: "text" }],
      endedAt: itemEndedAt,
      updatedAt,
    });
    expect(snapshot.runs[0]).toMatchObject({ endedAt: expectedEnd, status: "completed" });
  },
);

test("Contract projection bubbles a descendant Run boundary through every parent", async () => {
  const startedAt = "2026-07-16T08:00:00.000Z";
  const childRunId = protocolId(7);
  const grandchildRunId = protocolId(8);
  const child = childRun(childRunId, RUN_ID, "2026-07-16T08:00:00.100Z");
  const grandchild = childRun(grandchildRunId, childRunId, "2026-07-16T08:00:00.200Z");
  const descendantEnd = "2026-07-16T16:00:03.0000009+08:00";
  const tree = runTreeProjection([activeRun(startedAt), child, grandchild], grandchild.startedAt);

  tree.setCommittedAt(descendantEnd);
  await tree.projection.finishRun({
    cause: { providerEventId: "grandchild-1", type: "provider" },
    endedAt: descendantEnd,
    event: "grandchild/completed",
    runId: grandchildRunId,
    status: "completed",
  });
  tree.setCommittedAt("2026-07-16T08:00:04.000Z");
  await tree.projection.finishRun({
    cause: { providerEventId: "child-1", type: "provider" },
    endedAt: "2026-07-16T08:00:01.000Z",
    event: "child/completed",
    runId: childRunId,
    status: "completed",
  });
  tree.setCommittedAt("2026-07-16T08:00:05.000Z");
  await tree.projection.finishRun({
    cause: { providerEventId: "parent-1", type: "provider" },
    endedAt: "2026-07-16T08:00:02.000Z",
    event: "parent/completed",
    runId: RUN_ID,
    status: "completed",
  });

  expect(tree.snapshot().runs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ endedAt: descendantEnd, id: childRunId }),
      expect.objectContaining({ endedAt: descendantEnd, id: RUN_ID }),
    ]),
  );
});

test("Contract projection retains the latest sibling Run boundary regardless of finish order", async () => {
  const startedAt = "2026-07-16T08:00:00.000Z";
  const firstRunId = protocolId(7);
  const secondRunId = protocolId(8);
  const first = childRun(firstRunId, RUN_ID, "2026-07-16T08:00:00.100Z");
  const second = childRun(secondRunId, RUN_ID, "2026-07-16T08:00:00.200Z");
  const latestEnd = "2026-07-16T16:00:04.0000009+08:00";
  const tree = runTreeProjection([activeRun(startedAt), first, second], second.startedAt);

  tree.setCommittedAt("2026-07-16T08:00:05.000Z");
  await tree.projection.finishRun({
    cause: { providerEventId: "first-1", type: "provider" },
    endedAt: latestEnd,
    event: "first/completed",
    runId: firstRunId,
    status: "completed",
  });
  tree.setCommittedAt("2026-07-16T08:00:06.000Z");
  await tree.projection.finishRun({
    cause: { providerEventId: "second-1", type: "provider" },
    endedAt: "2026-07-16T08:00:03.000Z",
    event: "second/completed",
    runId: secondRunId,
    status: "completed",
  });
  tree.setCommittedAt("2026-07-16T08:00:07.000Z");
  await tree.projection.finishRun({
    cause: { providerEventId: "parent-1", type: "provider" },
    endedAt: "2026-07-16T08:00:02.000Z",
    event: "parent/completed",
    runId: RUN_ID,
    status: "completed",
  });

  expect(tree.snapshot().runs.find((run) => run.id === RUN_ID)).toMatchObject({
    endedAt: latestEnd,
    status: "completed",
  });
});

test.each([
  ["an earlier requested end", "2026-07-16T08:00:01.0000001Z", "child"],
  ["a later requested end", "2026-07-16T08:00:02.0000001Z", "requested"],
] as const)(
  "Contract projection combines a finished child Run with %s",
  async (_name, requestedEnd, expected) => {
    const startedAt = "2026-07-16T08:00:00.000Z";
    const childStartedAt = "2026-07-16T08:00:00.500Z";
    const childEndedAt = "2026-07-16T16:00:01.0000009+08:00";
    const childRunId = protocolId(7);
    const child = childRun(childRunId, RUN_ID, childStartedAt);
    const tree = runTreeProjection([activeRun(startedAt), child], childStartedAt);
    const { projection } = tree;

    tree.setCommittedAt(childEndedAt);
    await projection.finishRun({
      cause: { providerEventId: "child-1", type: "provider" },
      endedAt: childEndedAt,
      event: "child/completed",
      runId: childRunId,
      status: "completed",
    });
    tree.setCommittedAt("2026-07-18T00:00:00.000Z");
    await projection.finishRun({
      cause: { providerEventId: "parent-1", type: "provider" },
      endedAt: requestedEnd,
      event: "parent/completed",
      runId: RUN_ID,
      status: "completed",
    });

    expect(tree.snapshot().runs.find((run) => run.id === RUN_ID)).toMatchObject({
      endedAt: expected === "child" ? childEndedAt : requestedEnd,
      status: "completed",
    });
  },
);

test("Contract projection propagates a child boundary once after an unknown Authority retry", async () => {
  const startedAt = "2026-07-16T08:00:00.000Z";
  const childStartedAt = "2026-07-16T08:00:00.500Z";
  const childEndedAt = "2026-07-16T08:00:01.0000009Z";
  const childRunId = protocolId(7);
  const child = childRun(childRunId, RUN_ID, childStartedAt);
  let committedAt = childEndedAt;
  let childAttempts = 0;
  let snapshot: SessionSnapshot = validateSessionSnapshot({
    capturedAt: childStartedAt,
    interactions: [],
    items: [],
    protocolVersion: 2,
    revision: 0,
    runs: [activeRun(startedAt), child],
    session: {
      capabilities: { "run.child": {} },
      config: [],
      createdAt: startedAt,
      id: SESSION_ID,
      status: "open",
      updatedAt: startedAt,
    },
  });
  const committed = new Set<string>();
  const writes: ContractAuthorityUpdate[] = [];
  const projection = new ContractProjection({
    authority: async (update) => {
      writes.push(update);

      if (!committed.has(update.mutationId)) {
        const revision = snapshot.revision + 1;
        snapshot = applyCommittedMutation(snapshot, {
          baseRevision: snapshot.revision,
          cause: update.cause,
          committedAt,
          mutationId: update.mutationId,
          operations: [...update.operations],
          revision,
          sessionId: SESSION_ID,
        });
        committed.add(update.mutationId);
      }

      if (update.event === "child/completed" && ++childAttempts === 1) {
        throw new AuthorityOutcomeUnknownError("child result lost after commit");
      }
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(startedAt));
  projection.attachRun(child);
  const finishChild = () =>
    projection.finishRun({
      cause: { providerEventId: "child-1", type: "provider" },
      endedAt: childEndedAt,
      event: "child/completed",
      runId: childRunId,
      status: "completed",
    });

  await expect(finishChild()).rejects.toThrow("child result lost after commit");
  expect(projection.run(childRunId)).toMatchObject({ status: "active" });
  await finishChild();
  committedAt = "2026-07-16T08:00:02.000Z";
  await projection.finishRun({
    cause: { providerEventId: "parent-1", type: "provider" },
    endedAt: "2026-07-16T08:00:01.0000001Z",
    event: "parent/completed",
    runId: RUN_ID,
    status: "completed",
  });

  expect(writes.slice(0, 2).map(({ mutationId }) => mutationId)).toEqual([
    writes[0]?.mutationId,
    writes[0]?.mutationId,
  ]);
  expect(snapshot.revision).toBe(2);
  expect(snapshot.runs.find((run) => run.id === RUN_ID)).toMatchObject({
    endedAt: childEndedAt,
    status: "completed",
  });
});

test("Contract projection releases child boundaries with their parent and on disposal", async () => {
  const startedAt = "2026-07-16T08:00:00.000Z";
  const childRunId = protocolId(7);
  const child = childRun(childRunId, RUN_ID, "2026-07-16T08:00:00.500Z");
  const childEndedAt = "2026-07-16T08:00:01.000Z";
  const terminalRuns: Run[] = [];
  const options = {
    authority: async ({ operations }: ContractAuthorityUpdate) => {
      const operation = operations.at(-1);

      if (operation?.op === "put" && operation.entity === "run") {
        terminalRuns.push(operation.value);
      }
    },
    preview: () => {},
    sessionId: SESSION_ID,
  };
  const projection = new ContractProjection(options);
  projection.attachRun(activeRun(startedAt));
  projection.attachRun(child);
  await projection.finishRun({
    cause: { providerEventId: "child-1", type: "provider" },
    endedAt: childEndedAt,
    event: "child/completed",
    runId: childRunId,
    status: "completed",
  });
  await projection.finishRun({
    cause: { providerEventId: "parent-1", type: "provider" },
    endedAt: "2026-07-16T08:00:00.750Z",
    event: "parent/completed",
    runId: RUN_ID,
    status: "completed",
  });

  projection.attachRun(activeRun(startedAt));
  await projection.finishRun({
    cause: { providerEventId: "reused-1", type: "provider" },
    endedAt: "2026-07-16T08:00:00.750Z",
    event: "reused/completed",
    runId: RUN_ID,
    status: "completed",
  });
  expect(terminalRuns.at(-1)).toMatchObject({ endedAt: "2026-07-16T08:00:00.750Z" });

  const disposable = new ContractProjection(options);
  disposable.attachRun(activeRun(startedAt));
  disposable.attachRun(child);
  await disposable.finishRun({
    cause: { providerEventId: "disposable-child-1", type: "provider" },
    endedAt: childEndedAt,
    event: "disposable-child/completed",
    runId: childRunId,
    status: "completed",
  });
  disposable.dispose();
  disposable.dispose();
  expect(() => disposable.run(RUN_ID)).toThrow("disposed");
});

test.each([
  ["an active Item", (at: string) => [activeMessage("message-1", at)]],
  [
    "an Item from another Run",
    (at: string) => [
      itemSchema.parse({
        ...activeMessage("message-1", at),
        endedAt: at,
        runId: protocolId(99),
        status: "completed",
      }),
    ],
  ],
  [
    "duplicate Item IDs",
    (at: string) => {
      const item = itemSchema.parse({
        ...activeMessage("message-1", at),
        endedAt: at,
        status: "completed",
      });
      return [item, item];
    },
  ],
] as const)(
  "Contract projection rejects terminal snapshots with %s",
  async (_name, terminalItems) => {
    const timestamp = "2026-07-16T08:00:00.000Z";
    const projection = new ContractProjection({
      authority: async () => {},
      now: () => new Date(timestamp),
      preview: () => {},
      sessionId: SESSION_ID,
    });
    projection.attachRun(activeRun(timestamp));

    await expect(
      projection.finishRun({
        cause: { providerEventId: "turn/completed", type: "provider" },
        event: "turn/completed",
        runId: RUN_ID,
        status: "completed",
        terminalItems: terminalItems(timestamp),
      }),
    ).rejects.toThrow("invalid terminal Item");
    expect(projection.run(RUN_ID)?.status).toBe("active");
  },
);

test("Contract projection never ends a Run before a later Interaction", async () => {
  let now = new Date("2026-07-16T08:00:00.000Z");
  let snapshot: SessionSnapshot = validateSessionSnapshot({
    capturedAt: now.toISOString(),
    interactions: [],
    items: [],
    protocolVersion: 2,
    revision: 0,
    runs: [activeRun(now.toISOString())],
    session: {
      capabilities: {
        "example.com/interaction": {},
        "interaction.permission": {},
      },
      config: [],
      createdAt: now.toISOString(),
      id: SESSION_ID,
      status: "open",
      updatedAt: now.toISOString(),
    },
  });
  const projection = new ContractProjection({
    authority: async (update) => {
      const revision = snapshot.revision + 1;
      const mutation: CommittedMutation = {
        baseRevision: snapshot.revision,
        cause: update.cause,
        committedAt: now.toISOString(),
        mutationId: protocolId(1_000 + revision),
        operations: [...update.operations] as AuthorityOperation[],
        revision,
        sessionId: SESSION_ID,
      };
      snapshot = applyCommittedMutation(snapshot, mutation);
    },
    now: () => now,
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(now.toISOString()));
  now = new Date("2026-07-16T08:00:01.000Z");
  await projection.putInteraction(
    RUN_ID,
    "permission/requested",
    { providerEventId: "permission-1", type: "provider" },
    interactionSchema.parse({
      audience: "participants",
      blocking: true,
      createdAt: now.toISOString(),
      expiresAt: "2026-07-16T08:05:01.000Z",
      id: INTERACTION_ID,
      kind: "permission",
      request: {
        options: [
          {
            effect: "deny",
            id: "deny",
            label: "Deny",
            scope: "once",
          },
        ],
        subject: {
          operation: "execute",
          targets: ["workspace"],
          type: "resource",
        },
        title: "Run command?",
      },
      runId: RUN_ID,
      status: "open",
    }),
  );
  now = new Date("2026-07-16T08:00:02.000Z");
  await projection.putInteraction(
    RUN_ID,
    "permission/requested",
    { providerEventId: "permission-2-open", type: "provider" },
    interactionSchema.parse({
      audience: "participants",
      blocking: true,
      createdAt: "2026-07-16T08:00:01.500Z",
      expiresAt: "2026-07-16T08:05:01.500Z",
      id: RESOLVED_INTERACTION_ID,
      kind: "permission",
      request: {
        options: [
          {
            effect: "deny",
            id: "deny",
            label: "Deny",
            scope: "once",
          },
        ],
        subject: {
          operation: "execute",
          targets: ["workspace"],
          type: "resource",
        },
        title: "Run another command?",
      },
      runId: RUN_ID,
      status: "open",
    }),
  );
  await projection.putInteraction(
    RUN_ID,
    "permission/resolved",
    { providerEventId: "permission-2-resolved", type: "provider" },
    interactionSchema.parse({
      ...projection.interaction(RESOLVED_INTERACTION_ID),
      endedAt: now.toISOString(),
      resolution: { type: "cancelled" },
      status: "resolved",
    }),
  );
  const extensionId = protocolId(6);
  await projection.putInteraction(
    RUN_ID,
    "extension/requested",
    { providerEventId: "extension-1", type: "provider" },
    interactionSchema.parse({
      audience: "participants",
      blocking: true,
      createdAt: now.toISOString(),
      expiresAt: "2026-07-16T08:05:02.000Z",
      id: extensionId,
      kind: "extension",
      name: "example.com/interaction",
      request: { prompt: "Continue?" },
      runId: RUN_ID,
      status: "open",
    }),
  );
  await projection.finishRun({
    cause: { providerEventId: "result-1", type: "provider" },
    endedAt: "2026-07-16T08:00:00.500Z",
    event: "result/completed",
    runId: RUN_ID,
    status: "completed",
  });

  expect(snapshot.runs[0]).toMatchObject({
    endedAt: "2026-07-16T08:00:02.000Z",
    status: "completed",
  });
  expect(snapshot.interactions[0]).toMatchObject({
    endedAt: "2026-07-16T08:00:02.000Z",
    status: "expired",
  });
  expect(snapshot.interactions[0]).not.toHaveProperty("resolution");
  expect(snapshot.interactions.find((entry) => entry.id === extensionId)).toMatchObject({
    endedAt: "2026-07-16T08:00:02.000Z",
    status: "expired",
  });
});

test("Contract projection checkpoints every text channel before clearing Preview", async () => {
  const timestamp = "2026-07-16T08:00:00.000Z";
  const previews: string[] = [];
  const projection = new ContractProjection({
    authority: async () => {},
    now: () => new Date(timestamp),
    preview: ({ update }) => previews.push(update.text),
    previewCheckpointBytes: 4,
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(timestamp, false));
  await projection.putItem(
    RUN_ID,
    "terminal/created",
    { providerEventId: "terminal-1", type: "provider" },
    itemSchema.parse({
      audience: "participants",
      createdAt: timestamp,
      id: "terminal-1",
      kind: "terminal",
      runId: RUN_ID,
      status: "active",
      stderr: [],
      stdout: [],
      updatedAt: timestamp,
    }),
  );
  await projection.replacePreview({
    channel: "terminal.stderr",
    itemId: "terminal-1",
    runId: RUN_ID,
    text: "err",
  });
  await projection.replacePreview({
    channel: "terminal.stdout",
    itemId: "terminal-1",
    runId: RUN_ID,
    text: "large",
  });

  expect(projection.item(RUN_ID, "terminal-1")).toMatchObject({
    stderr: [{ text: "err", type: "text" }],
    stdout: [{ text: "large", type: "text" }],
  });
  expect(projection.materializedText(RUN_ID, "terminal-1", "terminal.stderr")).toBe("err");
  expect(projection.materializedText(RUN_ID, "terminal-1", "terminal.stdout")).toBe("large");

  await projection.putItem(
    RUN_ID,
    "message/started",
    { providerEventId: "message-1", type: "provider" },
    itemSchema.parse({
      audience: "participants",
      content: [],
      createdAt: timestamp,
      id: "message-1",
      kind: "message",
      role: "agent",
      runId: RUN_ID,
      status: "active",
      updatedAt: timestamp,
    }),
  );
  await projection.replacePreview({
    channel: "tool.progress",
    itemId: "message-1",
    runId: RUN_ID,
    text: "a😀b",
  });

  expect(previews.at(-1)).toBe("err");
  await projection.putItem(
    RUN_ID,
    "tool/started",
    { providerEventId: "tool-1", type: "provider" },
    itemSchema.parse({
      audience: "participants",
      category: "other",
      createdAt: timestamp,
      id: "tool-1",
      kind: "tool",
      name: "Tool",
      origin: "provider",
      runId: RUN_ID,
      status: "active",
      updatedAt: timestamp,
    }),
  );
  await projection.replacePreview({
    channel: "tool.progress",
    itemId: "tool-1",
    runId: RUN_ID,
    text: "a😀b",
  });

  expect(previews.at(-1)).toBe("a");
});
