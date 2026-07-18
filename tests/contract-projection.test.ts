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
import { isDriverId } from "../src/protocol/id";
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

type FinishRunInput = Parameters<ContractProjection["finishRun"]>[0];

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

function activeMessage(id: string, timestamp: string): Item {
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
  });
}

test.each([Number.NaN, 1.5])("Contract projection rejects invalid limit %p", (value) => {
  expect(
    () =>
      new ContractProjection({
        authority: async () => {},
        preview: () => {},
        previewCheckpointBytes: value,
        sessionId: SESSION_ID,
      }),
  ).toThrow("finite and positive");
});

test.each(["append", "replace"] as const)(
  "Contract projection treats a throwing Preview callback as best-effort for %s",
  async (mode) => {
    const timestamp = "2026-07-16T08:00:00.000Z";
    let previews = 0;
    const projection = new ContractProjection({
      authority: async () => {},
      preview: () => {
        previews += 1;
        throw new Error("subscriber failed");
      },
      sessionId: SESSION_ID,
    });
    projection.attachRun(activeRun(timestamp));
    const item =
      mode === "append"
        ? activeMessage("item-1", timestamp)
        : itemSchema.parse({
            audience: "participants",
            createdAt: timestamp,
            id: "item-1",
            kind: "terminal",
            runId: RUN_ID,
            status: "active",
            stderr: [],
            stdout: [],
            updatedAt: timestamp,
          });
    await projection.putItem(RUN_ID, "item/started", { name: "item", type: "system" }, item);

    if (mode === "append") {
      await expect(
        projection.appendText({
          cause: { providerEventId: "delta-1", type: "provider" },
          channel: "message.text",
          delta: "x",
          event: "message/delta",
          itemId: item.id,
          runId: RUN_ID,
        }),
      ).resolves.toBeUndefined();
      expect(projection.materializedText(RUN_ID, item.id, "message.text")).toBe("x");
    } else {
      await expect(
        projection.replacePreview({
          channel: "terminal.stdout",
          itemId: item.id,
          runId: RUN_ID,
          text: "x",
        }),
      ).resolves.toBeUndefined();
      expect(projection.materializedText(RUN_ID, item.id, "terminal.stdout")).toBe("x");
    }

    expect(previews).toBe(1);
  },
);

test.each(["item", "interaction", "run"] as const)(
  "Contract projection isolates an in-flight Authority %s submission",
  async (entity) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const timestamp = "2026-07-16T08:00:00.000Z";
    let captured: ContractAuthorityUpdate | undefined;
    const projection = new ContractProjection({
      authority: async (update) => {
        captured = update;
        entered.resolve();
        await release.promise;
      },
      preview: () => {},
      sessionId: SESSION_ID,
    });
    projection.attachRun(activeRun(timestamp));
    const interaction = interactionSchema.parse({
      audience: "participants",
      blocking: true,
      createdAt: timestamp,
      expiresAt: "2026-07-16T08:05:00.000Z",
      id: INTERACTION_ID,
      kind: "permission",
      request: {
        options: [{ effect: "deny", id: "deny", label: "Deny", scope: "once" }],
        subject: { operation: "execute", targets: ["workspace"], type: "resource" },
        title: "Run command?",
      },
      runId: RUN_ID,
      status: "open",
    });
    const write =
      entity === "item"
        ? projection.putItem(
            RUN_ID,
            "item/put",
            { name: "item", type: "system" },
            {
              ...activeMessage("message-1", timestamp),
              content: [
                { text: "safe", type: "text" },
                { data: "c2FmZQ==", mediaType: "text/plain", type: "inline_blob" },
              ],
            },
          )
        : entity === "interaction"
          ? projection.putInteraction(
              RUN_ID,
              "interaction/put",
              { name: "interaction", type: "system" },
              interaction,
            )
          : projection.updateUsage(
              RUN_ID,
              "run/usage",
              { name: "usage", type: "system" },
              { cost: { amount: 1, currency: "USD" }, input: 1, total: 1 },
            );
    await entered.promise;
    const corrupt = () => {
      const operation = captured?.operations[0];

      if (operation?.op !== "put") {
        throw new Error("Expected a put operation.");
      }

      if (operation.entity === "item" && operation.value.kind === "message") {
        operation.value.role = "user";
        const text = operation.value.content[0];
        const blob = operation.value.content[1];
        if (text?.type === "text") {
          text.text = "mutated";
        }
        if (blob?.type === "inline_blob") {
          blob.data = "bXV0YXRlZA==";
        }
      } else if (operation.entity === "interaction" && operation.value.kind === "permission") {
        operation.value.request.title = "Mutated";
        const option = operation.value.request.options[0];
        if (option !== undefined) {
          option.label = "Mutated";
        }
      } else if (operation.entity === "run" && operation.value.usage !== undefined) {
        operation.value.usage.input = 999;
        if (operation.value.usage.cost !== undefined) {
          operation.value.usage.cost.amount = 999;
        }
      }
    };
    corrupt();
    release.resolve();
    await write;
    corrupt();

    if (entity === "item") {
      expect(projection.item(RUN_ID, "message-1")).toMatchObject({
        content: [
          { text: "safe", type: "text" },
          { data: "c2FmZQ==", type: "inline_blob" },
        ],
        role: "agent",
      });
    } else if (entity === "interaction") {
      expect(projection.interaction(INTERACTION_ID)).toMatchObject({
        request: { options: [{ label: "Deny" }], title: "Run command?" },
      });
    } else {
      expect(projection.run(RUN_ID)?.usage).toEqual({
        cost: { amount: 1, currency: "USD" },
        input: 1,
        total: 1,
      });
    }
  },
);

test("Contract projection keeps its private Authority intent across a mutated unknown submission", async () => {
  const writes: ContractAuthorityUpdate[] = [];
  const timestamp = "2026-07-16T08:00:00.000Z";
  const projection = new ContractProjection({
    authority: async (update) => {
      writes.push(update);
      if (writes.length === 1) {
        const operation = update.operations[0];
        if (operation?.op === "put" && operation.entity === "item") {
          operation.value.updatedAt = "2026-07-16T08:00:01.000Z";
        }
        throw new AuthorityOutcomeUnknownError("result lost");
      }
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(timestamp));
  const item = activeMessage("message-1", timestamp);
  const write = () =>
    projection.putItem(RUN_ID, "item/put", { name: "item", type: "system" }, item);

  await expect(write()).rejects.toThrow("result lost");
  await write();

  expect(writes[1]?.mutationId).toBe(writes[0]?.mutationId);
  expect(writes[1]?.operations).toMatchObject([
    { entity: "item", op: "put", value: { updatedAt: timestamp } },
  ]);
  expect(projection.item(RUN_ID, item.id)?.updatedAt).toBe(timestamp);
});

test("Contract projection disposal preserves an in-flight result and fences queued writes", async () => {
  const writeEntered = Promise.withResolvers<void>();
  const releaseWrite = Promise.withResolvers<void>();
  const events: string[] = [];
  const projection = new ContractProjection({
    authority: async ({ event }) => {
      events.push(event);
      writeEntered.resolve();
      await releaseWrite.promise;
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun("2026-07-16T08:00:00.000Z"));
  const write = projection.putItem(
    RUN_ID,
    "message/started",
    { providerEventId: "message-1", type: "provider" },
    itemSchema.parse({
      audience: "participants",
      content: [],
      createdAt: "2026-07-16T08:00:00.000Z",
      id: "message-1",
      kind: "message",
      role: "agent",
      runId: RUN_ID,
      status: "active",
      updatedAt: "2026-07-16T08:00:00.000Z",
    }),
  );
  await writeEntered.promise;
  const queued = projection.putItem(
    RUN_ID,
    "message/queued",
    { providerEventId: "message-2", type: "provider" },
    activeMessage("message-2", "2026-07-16T08:00:00.000Z"),
  );
  const queuedResult = queued.then(
    () => ({ status: "fulfilled" as const }),
    (reason: unknown) => ({ reason, status: "rejected" as const }),
  );

  projection.dispose();
  projection.dispose();
  expect(
    await Promise.race([
      queuedResult,
      new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), 10)),
    ]),
  ).toMatchObject({ reason: { message: "Contract projection is disposed." }, status: "rejected" });
  releaseWrite.resolve();

  await expect(write).resolves.toMatchObject({ id: "message-1" });
  expect(await queuedResult).toMatchObject({ status: "rejected" });
  expect(events).toEqual(["message/started"]);
  expect(() => projection.run(RUN_ID)).toThrow("disposed");
});

test("Contract projection preserves an in-flight unknown Authority result after disposal", async () => {
  const writeEntered = Promise.withResolvers<void>();
  const releaseWrite = Promise.withResolvers<void>();
  const projection = new ContractProjection({
    authority: async () => {
      writeEntered.resolve();
      await releaseWrite.promise;
      throw new AuthorityOutcomeUnknownError("result lost after disposal");
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun("2026-07-16T08:00:00.000Z"));
  const write = projection.putItem(
    RUN_ID,
    "message/started",
    { providerEventId: "message-1", type: "provider" },
    activeMessage("message-1", "2026-07-16T08:00:00.000Z"),
  );
  await writeEntered.promise;
  projection.dispose();
  releaseWrite.resolve();

  await expect(write).rejects.toMatchObject({
    message: "result lost after disposal",
    name: "AuthorityOutcomeUnknownError",
  });
});

test("Contract projection bounds and releases its queued mutation count", async () => {
  const writeEntered = Promise.withResolvers<void>();
  const releaseWrite = Promise.withResolvers<void>();
  const timestamp = "2026-07-16T08:00:00.000Z";
  const projection = new ContractProjection({
    authority: async ({ event }) => {
      if (event === "message/active") {
        writeEntered.resolve();
        await releaseWrite.promise;
      }
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(timestamp));
  const active = projection.putItem(
    RUN_ID,
    "message/active",
    { name: "active", type: "system" },
    activeMessage("active", timestamp),
  );
  await writeEntered.promise;
  const queued = Array.from({ length: 1_023 }, (_, index) =>
    projection.putItem(
      RUN_ID,
      "message/queued",
      { name: `queued-${index}`, type: "system" },
      activeMessage(`queued-${index}`, timestamp),
    ),
  );
  const queuedResults = Promise.allSettled(queued);

  await expect(
    projection.putItem(
      RUN_ID,
      "message/overflow",
      { name: "overflow", type: "system" },
      activeMessage("overflow", timestamp),
    ),
  ).rejects.toThrow("1024 entries");
  projection.dispose();
  expect((await queuedResults).every((result) => result.status === "rejected")).toBe(true);
  releaseWrite.resolve();
  await expect(active).resolves.toMatchObject({ id: "active" });
});

test("Contract projection bounds queued mutation UTF-8 bytes", async () => {
  const writeEntered = Promise.withResolvers<void>();
  const releaseWrite = Promise.withResolvers<void>();
  const timestamp = "2026-07-16T08:00:00.000Z";
  const projection = new ContractProjection({
    authority: async ({ event }) => {
      if (event === "message/active") {
        writeEntered.resolve();
        await releaseWrite.promise;
      }
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(timestamp));
  await projection.putItem(
    RUN_ID,
    "message/started",
    { name: "started", type: "system" },
    activeMessage("message-1", timestamp),
  );
  const active = projection.putItem(
    RUN_ID,
    "message/active",
    { name: "active", type: "system" },
    activeMessage("message-2", timestamp),
  );
  await writeEntered.promise;

  await expect(
    projection.appendText({
      cause: { providerEventId: "large-delta", type: "provider" },
      channel: "message.text",
      delta: "x".repeat(32 * 1_024 * 1_024),
      event: "message/delta",
      itemId: "message-1",
      runId: RUN_ID,
    }),
  ).rejects.toThrow("33554432 UTF-8 bytes");
  releaseWrite.resolve();
  await active;
});

test("Contract projection gives every Authority write a protocol mutation ID", async () => {
  const mutationIds: string[] = [];
  const projection = new ContractProjection({
    authority: async ({ mutationId }) => {
      mutationIds.push(mutationId);
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun("2026-07-16T08:00:00.000Z"));

  await projection.putItem(
    RUN_ID,
    "message/started",
    { providerEventId: "message-1", type: "provider" },
    activeMessage("message-1", "2026-07-16T08:00:00.000Z"),
  );

  expect(mutationIds).toHaveLength(1);
  expect(isDriverId(mutationIds[0])).toBe(true);
});

test("Contract projection reuses a mutation ID after an ambiguous Authority failure", async () => {
  const mutationIds: string[] = [];
  const projection = new ContractProjection({
    authority: async ({ mutationId }) => {
      mutationIds.push(mutationId);

      if (mutationIds.length === 1) {
        throw new AuthorityOutcomeUnknownError("response lost after commit");
      }
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun("2026-07-16T08:00:00.000Z"));
  const item = activeMessage("message-1", "2026-07-16T08:00:00.000Z");
  const write = () =>
    projection.putItem(
      RUN_ID,
      "message/started",
      { providerEventId: "message-1", type: "provider" },
      item,
    );

  await expect(write()).rejects.toThrow("response lost");
  await expect(
    projection.putItem(
      RUN_ID,
      "message/started",
      { providerEventId: "message-1", type: "provider" },
      { ...item, content: [{ text: "changed", type: "text" }] },
    ),
  ).rejects.toThrow("changed while its outcome was unknown");
  await projection.putItem(
    RUN_ID,
    "message/started",
    { type: "provider", providerEventId: "message-1" },
    item,
  );
  await write();

  expect(mutationIds).toEqual([mutationIds[0], mutationIds[0]]);
  expect(projection.item(RUN_ID, item.id)).toEqual(item);
});

test("Contract projection retries a derived terminal intent without changing it", async () => {
  let nowMs = Date.parse("2026-07-16T08:00:00.000Z");
  const writes: ContractAuthorityUpdate[] = [];
  const projection = new ContractProjection({
    authority: async (update) => {
      writes.push(update);

      if (writes.length === 1) {
        throw new AuthorityOutcomeUnknownError("response lost after commit");
      }
    },
    now: () => new Date(nowMs),
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(new Date(nowMs).toISOString()));
  const finish = () =>
    projection.finishRun({
      cause: { providerEventId: "turn-1", type: "provider" },
      event: "turn/completed",
      runId: RUN_ID,
      status: "completed",
    });

  await expect(finish()).rejects.toThrow("response lost");
  nowMs += 1;
  await finish();

  expect(writes.map((write) => write.mutationId)).toEqual([
    writes[0]?.mutationId,
    writes[0]?.mutationId,
  ]);
  expect(writes[1]?.operations).toEqual(writes[0]?.operations);
});

test("Contract projection retries a checkpoint with its first timestamp", async () => {
  let nowMs = Date.parse("2026-07-16T08:00:00.000Z");
  const writes: ContractAuthorityUpdate[] = [];
  const projection = new ContractProjection({
    authority: async (update) => {
      if (update.event === "message/delta.checkpoint") {
        writes.push(update);

        if (writes.length === 1) {
          throw new AuthorityOutcomeUnknownError("response lost after commit");
        }
      }
    },
    now: () => new Date(nowMs),
    preview: () => {},
    previewCheckpointBytes: 1,
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(new Date(nowMs).toISOString()));
  await projection.putItem(
    RUN_ID,
    "message/started",
    { name: "start", type: "system" },
    activeMessage("message-1", new Date(nowMs).toISOString()),
  );
  const append = () =>
    projection.appendText({
      cause: { providerEventId: "delta-1", type: "provider" },
      channel: "message.text",
      delta: "x",
      event: "message/delta",
      itemId: "message-1",
      runId: RUN_ID,
    });

  await expect(append()).rejects.toThrow("response lost");
  nowMs += 1;
  await append();

  expect(writes[1]?.mutationId).toBe(writes[0]?.mutationId);
  expect(writes[1]?.operations).toEqual(writes[0]?.operations);
  expect(projection.item(RUN_ID, "message-1")).toMatchObject({
    content: [{ text: "x", type: "text" }],
  });
});

test("Contract projection serializes Authority writes and local state", async () => {
  const firstEntered = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const events: string[] = [];
  const projection = new ContractProjection({
    authority: async ({ event }) => {
      events.push(event);
      if (event === "first") {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  const timestamp = "2026-07-16T08:00:00.000Z";
  projection.attachRun(activeRun(timestamp));
  const first = projection.putItem(
    RUN_ID,
    "first",
    { type: "system", name: "first" },
    { ...activeMessage("message-1", timestamp), content: [{ text: "first", type: "text" }] },
  );
  await firstEntered.promise;
  const second = projection.putItem(
    RUN_ID,
    "second",
    { type: "system", name: "second" },
    { ...activeMessage("message-1", timestamp), content: [{ text: "second", type: "text" }] },
  );
  await Promise.resolve();

  expect(events).toEqual(["first"]);
  releaseFirst.resolve();
  await Promise.all([first, second]);

  expect(events).toEqual(["first", "second"]);
  expect(projection.item(RUN_ID, "message-1")).toMatchObject({
    content: [{ text: "second", type: "text" }],
  });
});

test.each([
  ["a queued checkpoint", "b", "cd", ["ab", "abcd"]],
  ["a queued Preview append", "bc", "d", ["abc"]],
] as const)(
  "Contract projection preserves text across %s",
  async (_name, firstDelta, followerDelta, expectedCheckpoints) => {
    const checkpointEntered = Promise.withResolvers<void>();
    const releaseCheckpoint = Promise.withResolvers<void>();
    const checkpoints: string[] = [];
    const timestamp = "2026-07-16T08:00:00.000Z";
    const projection = new ContractProjection({
      authority: async ({ event, operations }) => {
        if (!event.endsWith(".checkpoint")) {
          return;
        }

        const operation = operations[0];
        if (operation?.op === "put" && operation.entity === "item") {
          checkpoints.push(
            operation.value.kind === "message"
              ? operation.value.content
                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                  .join("")
              : "",
          );
        }

        if (checkpoints.length === 1) {
          checkpointEntered.resolve();
          await releaseCheckpoint.promise;
        }
      },
      now: () => new Date(timestamp),
      preview: () => {},
      previewCheckpointBytes: 2,
      sessionId: SESSION_ID,
    });
    projection.attachRun(activeRun(timestamp));
    await projection.putItem(
      RUN_ID,
      "message/started",
      { name: "start", type: "system" },
      activeMessage("message-1", timestamp),
    );
    const append = (delta: string, event: string) =>
      projection.appendText({
        cause: { providerEventId: event, type: "provider" },
        channel: "message.text",
        delta,
        event,
        itemId: "message-1",
        runId: RUN_ID,
      });
    await append("a", "delta-a");
    const first = append(firstDelta, "delta-first");
    await checkpointEntered.promise;
    const follower = append(followerDelta, "delta-follower");
    releaseCheckpoint.resolve();
    await Promise.all([first, follower]);

    expect(checkpoints).toEqual(expectedCheckpoints);
    expect(projection.materializedText(RUN_ID, "message-1", "message.text")).toBe(
      `a${firstDelta}${followerDelta}`,
    );
  },
);

test("Contract projection keeps Preview appended while checkpointText awaits Authority", async () => {
  const checkpointEntered = Promise.withResolvers<void>();
  const releaseCheckpoint = Promise.withResolvers<void>();
  const timestamp = "2026-07-16T08:00:00.000Z";
  const projection = new ContractProjection({
    authority: async ({ event }) => {
      if (event === "message/checkpoint") {
        checkpointEntered.resolve();
        await releaseCheckpoint.promise;
      }
    },
    now: () => new Date(timestamp),
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(timestamp));
  await projection.putItem(
    RUN_ID,
    "message/started",
    { name: "start", type: "system" },
    activeMessage("message-1", timestamp),
  );
  const append = (delta: string, event: string) =>
    projection.appendText({
      cause: { providerEventId: event, type: "provider" },
      channel: "message.text",
      delta,
      event,
      itemId: "message-1",
      runId: RUN_ID,
    });
  await append("a", "delta-a");
  const checkpoint = projection.checkpointText({
    cause: { providerEventId: "checkpoint-a", type: "provider" },
    channel: "message.text",
    event: "message/checkpoint",
    itemId: "message-1",
    runId: RUN_ID,
  });
  await checkpointEntered.promise;
  let appendSettled = false;
  const follower = append("b", "delta-b").finally(() => {
    appendSettled = true;
  });
  await Promise.resolve();
  const settledBeforeCheckpoint = appendSettled;
  releaseCheckpoint.resolve();
  await Promise.all([checkpoint, follower]);

  expect(settledBeforeCheckpoint).toBe(false);
  expect(projection.materializedText(RUN_ID, "message-1", "message.text")).toBe("ab");
});

test("Contract projection rejects Preview followers until an unknown checkpoint is retried", async () => {
  const checkpointEntered = Promise.withResolvers<void>();
  const rejectCheckpoint = Promise.withResolvers<void>();
  const timestamp = "2026-07-16T08:00:00.000Z";
  let attempts = 0;
  const projection = new ContractProjection({
    authority: async ({ event }) => {
      if (event === "message/checkpoint" && ++attempts === 1) {
        checkpointEntered.resolve();
        await rejectCheckpoint.promise;
        throw new AuthorityOutcomeUnknownError("checkpoint result lost");
      }
    },
    now: () => new Date(timestamp),
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(timestamp));
  await projection.putItem(
    RUN_ID,
    "message/started",
    { name: "start", type: "system" },
    activeMessage("message-1", timestamp),
  );
  const append = (delta: string, event: string) =>
    projection.appendText({
      cause: { providerEventId: event, type: "provider" },
      channel: "message.text",
      delta,
      event,
      itemId: "message-1",
      runId: RUN_ID,
    });
  const checkpoint = () =>
    projection.checkpointText({
      cause: { providerEventId: "checkpoint-a", type: "provider" },
      channel: "message.text",
      event: "message/checkpoint",
      itemId: "message-1",
      runId: RUN_ID,
    });
  await append("a", "delta-a");
  const first = checkpoint();
  await checkpointEntered.promise;
  const follower = append("b", "delta-b");
  const results = Promise.allSettled([first, follower]);
  rejectCheckpoint.resolve();

  const [checkpointResult, followerResult] = await results;
  expect(checkpointResult).toMatchObject({
    reason: { message: "checkpoint result lost" },
    status: "rejected",
  });
  expect(followerResult).toMatchObject({ status: "rejected" });
  expect(followerResult.status === "rejected" ? followerResult.reason : undefined).toBeInstanceOf(
    AuthorityOutcomeUnknownError,
  );
  await checkpoint();
  await append("b", "delta-b");

  expect(projection.materializedText(RUN_ID, "message-1", "message.text")).toBe("ab");
});

test("Contract projection derives finishRun after an in-flight Item update", async () => {
  const updateEntered = Promise.withResolvers<void>();
  const releaseUpdate = Promise.withResolvers<void>();
  const writes: ContractAuthorityUpdate[] = [];
  const timestamp = "2026-07-16T08:00:00.000Z";
  const projection = new ContractProjection({
    authority: async (update) => {
      writes.push(update);
      if (update.event === "message/updated") {
        updateEntered.resolve();
        await releaseUpdate.promise;
      }
    },
    now: () => new Date(timestamp),
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(timestamp));
  await projection.putItem(
    RUN_ID,
    "message/started",
    { name: "start", type: "system" },
    activeMessage("message-1", timestamp),
  );
  const updated = projection.putItem(
    RUN_ID,
    "message/updated",
    { name: "update", type: "system" },
    {
      ...activeMessage("message-1", timestamp),
      content: [{ text: "latest", type: "text" }],
    },
  );
  await updateEntered.promise;
  const finished = projection.finishRun({
    cause: { name: "finish", type: "system" },
    event: "run/finished",
    runId: RUN_ID,
    status: "completed",
  });
  releaseUpdate.resolve();
  await Promise.all([updated, finished]);

  const finishItem = writes
    .find((write) => write.event === "run/finished")
    ?.operations.find((operation) => operation.op === "put" && operation.entity === "item");
  expect(finishItem?.value).toMatchObject({
    content: [{ text: "latest", type: "text" }],
    status: "completed",
  });
});

test("Contract projection derives finishRun after an in-flight Interaction", async () => {
  const interactionEntered = Promise.withResolvers<void>();
  const releaseInteraction = Promise.withResolvers<void>();
  const writes: ContractAuthorityUpdate[] = [];
  const timestamp = "2026-07-16T08:00:00.000Z";
  const projection = new ContractProjection({
    authority: async (update) => {
      writes.push(update);
      if (update.event === "permission/requested") {
        interactionEntered.resolve();
        await releaseInteraction.promise;
      }
    },
    now: () => new Date(timestamp),
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(timestamp));
  const opened = projection.putInteraction(
    RUN_ID,
    "permission/requested",
    { providerEventId: "permission-1", type: "provider" },
    interactionSchema.parse({
      audience: "participants",
      blocking: true,
      createdAt: timestamp,
      expiresAt: "2026-07-16T08:05:00.000Z",
      id: INTERACTION_ID,
      kind: "permission",
      request: {
        options: [{ effect: "deny", id: "deny", label: "Deny", scope: "once" }],
        subject: { operation: "execute", targets: ["workspace"], type: "resource" },
        title: "Run command?",
      },
      runId: RUN_ID,
      status: "open",
    }),
  );
  await interactionEntered.promise;
  const finished = projection.finishRun({
    cause: { name: "finish", type: "system" },
    event: "run/finished",
    runId: RUN_ID,
    status: "completed",
  });
  releaseInteraction.resolve();
  await Promise.all([opened, finished]);

  expect(
    writes
      .find((write) => write.event === "run/finished")
      ?.operations.find((operation) => operation.op === "put" && operation.entity === "interaction")
      ?.value,
  ).toMatchObject({ id: INTERACTION_ID, status: "expired" });
});

test("Contract projection derives finishRun after an in-flight text checkpoint", async () => {
  const checkpointEntered = Promise.withResolvers<void>();
  const releaseCheckpoint = Promise.withResolvers<void>();
  const writes: ContractAuthorityUpdate[] = [];
  const timestamp = "2026-07-16T08:00:00.000Z";
  const projection = new ContractProjection({
    authority: async (update) => {
      writes.push(update);
      if (update.event === "message/delta.checkpoint") {
        checkpointEntered.resolve();
        await releaseCheckpoint.promise;
      }
    },
    now: () => new Date(timestamp),
    preview: () => {},
    previewCheckpointBytes: 2,
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun(timestamp));
  await projection.putItem(
    RUN_ID,
    "message/started",
    { name: "start", type: "system" },
    activeMessage("message-1", timestamp),
  );
  const append = (delta: string) =>
    projection.appendText({
      cause: { providerEventId: `delta-${delta}`, type: "provider" },
      channel: "message.text",
      delta,
      event: "message/delta",
      itemId: "message-1",
      runId: RUN_ID,
    });
  await append("a");
  const checkpoint = append("b");
  await checkpointEntered.promise;
  const finished = projection.finishRun({
    cause: { name: "finish", type: "system" },
    event: "run/finished",
    runId: RUN_ID,
    status: "completed",
  });
  releaseCheckpoint.resolve();
  await Promise.all([checkpoint, finished]);

  const finishItem = writes
    .find((write) => write.event === "run/finished")
    ?.operations.find((operation) => operation.op === "put" && operation.entity === "item");
  expect(finishItem?.value).toMatchObject({ status: "completed" });
  expect(
    finishItem?.value.kind === "message"
      ? finishItem.value.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("")
      : undefined,
  ).toBe("ab");
});

test.each([
  ["status", { status: "completed" }, { status: "failed" }],
  [
    "error",
    {
      error: { code: "first", message: "first", retryable: false },
      status: "failed",
    },
    {
      error: { code: "second", message: "second", retryable: false },
      status: "failed",
    },
  ],
  [
    "terminalItems",
    { status: "completed", terminalItems: [] },
    {
      status: "completed",
      terminalItems: [
        itemSchema.parse({
          ...activeMessage("message-1", "2026-07-16T08:00:00.000Z"),
          endedAt: "2026-07-16T08:00:01.000Z",
          status: "completed",
          updatedAt: "2026-07-16T08:00:01.000Z",
        }),
      ],
    },
  ],
  [
    "activeItemStatus",
    { activeItemStatus: "completed", status: "completed" },
    { activeItemStatus: "cancelled", status: "completed" },
  ],
] satisfies readonly [string, Partial<FinishRunInput>, Partial<FinishRunInput>][])(
  "Contract projection rejects changed finishRun %s after an unknown result",
  async (_name, firstPatch, changedPatch) => {
    const writes: ContractAuthorityUpdate[] = [];
    const timestamp = "2026-07-16T08:00:00.000Z";
    const projection = new ContractProjection({
      authority: async (update) => {
        writes.push(update);
        if (writes.length === 1) {
          throw new AuthorityOutcomeUnknownError("finish result lost");
        }
      },
      now: () => new Date(timestamp),
      preview: () => {},
      sessionId: SESSION_ID,
    });
    projection.attachRun(activeRun(timestamp));
    const base = {
      cause: { providerEventId: "finish-1", type: "provider" as const },
      event: "run/finished",
      runId: RUN_ID,
    };
    const first = { ...base, ...firstPatch } as FinishRunInput;
    const changed = { ...base, ...changedPatch } as FinishRunInput;

    await expect(projection.finishRun(first)).rejects.toThrow("finish result lost");
    await expect(projection.finishRun(changed)).rejects.toThrow(
      "changed while its outcome was unknown",
    );
    await projection.finishRun(first);

    expect(writes).toHaveLength(2);
    expect(writes[1]?.mutationId).toBe(writes[0]?.mutationId);
    expect(writes[1]?.operations).toEqual(writes[0]?.operations);
  },
);

test("Contract projection fail-stops writes behind an unresolved Authority outcome", async () => {
  const firstEntered = Promise.withResolvers<void>();
  const rejectFirst = Promise.withResolvers<void>();
  const events: string[] = [];
  let firstAttempts = 0;
  const projection = new ContractProjection({
    authority: async ({ event }) => {
      events.push(event);
      if (event === "first" && ++firstAttempts === 1) {
        firstEntered.resolve();
        await rejectFirst.promise;
        throw new AuthorityOutcomeUnknownError("response lost after commit");
      }
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  const timestamp = "2026-07-16T08:00:00.000Z";
  projection.attachRun(activeRun(timestamp));
  const firstItem = {
    ...activeMessage("message-1", timestamp),
    content: [{ text: "first", type: "text" as const }],
  };
  const secondItem = {
    ...activeMessage("message-1", timestamp),
    content: [{ text: "second", type: "text" as const }],
  };
  const first = projection.putItem(RUN_ID, "first", { name: "first", type: "system" }, firstItem);
  await firstEntered.promise;
  const second = projection.putItem(
    RUN_ID,
    "second",
    { name: "second", type: "system" },
    secondItem,
  );
  const failures = Promise.allSettled([first, second]);
  rejectFirst.resolve();

  expect(await failures).toMatchObject([
    { reason: { message: "response lost after commit" }, status: "rejected" },
    { reason: { message: "response lost after commit" }, status: "rejected" },
  ]);
  await expect(
    projection.putItem(
      RUN_ID,
      "second",
      { name: "second", type: "system" },
      { ...secondItem, content: [{ text: "changed", type: "text" }] },
    ),
  ).rejects.toBeInstanceOf(AuthorityOutcomeUnknownError);
  expect(events).toEqual(["first"]);

  await projection.putItem(RUN_ID, "first", { name: "first", type: "system" }, firstItem);
  await projection.putItem(RUN_ID, "second", { name: "second", type: "system" }, secondItem);

  expect(events).toEqual(["first", "first", "second"]);
  expect(projection.item(RUN_ID, "message-1")).toEqual(secondItem);
});

test("Contract projection lets an exact retry pass queued followers", async () => {
  const firstEntered = Promise.withResolvers<void>();
  const rejectFirst = Promise.withResolvers<void>();
  const events: string[] = [];
  let attempts = 0;
  const projection = new ContractProjection({
    authority: async ({ event }) => {
      events.push(event);
      if (event === "first" && ++attempts === 1) {
        firstEntered.resolve();
        await rejectFirst.promise;
        throw new AuthorityOutcomeUnknownError("result lost");
      }
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  const timestamp = "2026-07-16T08:00:00.000Z";
  const firstItem = activeMessage("message-1", timestamp);
  const secondItem = activeMessage("message-2", timestamp);
  projection.attachRun(activeRun(timestamp));
  const first = projection.putItem(RUN_ID, "first", { name: "first", type: "system" }, firstItem);
  await firstEntered.promise;
  const follower = projection.putItem(
    RUN_ID,
    "second",
    { name: "second", type: "system" },
    secondItem,
  );
  const retry = first.catch(() =>
    projection.putItem(RUN_ID, "first", { name: "first", type: "system" }, firstItem),
  );
  const results = Promise.allSettled([first, follower, retry]);
  rejectFirst.resolve();

  expect(await results).toMatchObject([
    { status: "rejected" },
    { status: "rejected" },
    { status: "fulfilled" },
  ]);
  expect(events).toEqual(["first", "first"]);
  await projection.putItem(RUN_ID, "second", { name: "second", type: "system" }, secondItem);
  expect(events).toEqual(["first", "first", "second"]);
});

test("Contract projection rejects an identical follower queued before an unknown result", async () => {
  const firstEntered = Promise.withResolvers<void>();
  const rejectFirst = Promise.withResolvers<void>();
  const mutationIds: string[] = [];
  let attempts = 0;
  const projection = new ContractProjection({
    authority: async ({ mutationId }) => {
      mutationIds.push(mutationId);
      if (++attempts === 1) {
        firstEntered.resolve();
        await rejectFirst.promise;
        throw new AuthorityOutcomeUnknownError("result lost");
      }
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  const timestamp = "2026-07-16T08:00:00.000Z";
  const item = activeMessage("message-1", timestamp);
  projection.attachRun(activeRun(timestamp));
  const write = () => projection.putItem(RUN_ID, "first", { name: "first", type: "system" }, item);
  const first = write();
  await firstEntered.promise;
  const follower = write();
  const results = Promise.allSettled([first, follower]);
  rejectFirst.resolve();

  expect(await results).toMatchObject([{ status: "rejected" }, { status: "rejected" }]);
  expect(attempts).toBe(1);
  await write();

  expect(attempts).toBe(2);
  expect(mutationIds[1]).toBe(mutationIds[0]);
});

test("Contract projection continues queued writes after a definite Authority rejection", async () => {
  const firstEntered = Promise.withResolvers<void>();
  const rejectFirst = Promise.withResolvers<void>();
  const events: string[] = [];
  const projection = new ContractProjection({
    authority: async ({ event }) => {
      events.push(event);
      if (event === "first") {
        firstEntered.resolve();
        await rejectFirst.promise;
        throw new Error("mutation rejected");
      }
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  const timestamp = "2026-07-16T08:00:00.000Z";
  projection.attachRun(activeRun(timestamp));
  const first = projection.putItem(
    RUN_ID,
    "first",
    { name: "first", type: "system" },
    activeMessage("message-1", timestamp),
  );
  await firstEntered.promise;
  const secondItem = {
    ...activeMessage("message-1", timestamp),
    content: [{ text: "second", type: "text" as const }],
  };
  const second = projection.putItem(
    RUN_ID,
    "second",
    { name: "second", type: "system" },
    secondItem,
  );
  const results = Promise.allSettled([first, second]);
  rejectFirst.resolve();

  expect(await results).toMatchObject([
    { reason: { message: "mutation rejected" }, status: "rejected" },
    { status: "fulfilled" },
  ]);
  expect(events).toEqual(["first", "second"]);
  expect(projection.item(RUN_ID, "message-1")).toEqual(secondItem);
});

test("Contract projection preserves sub-millisecond lifecycle order", async () => {
  let terminalRun: Run | undefined;
  const projection = new ContractProjection({
    authority: async ({ operations }) => {
      const operation = operations.at(-1);
      terminalRun =
        operation?.op === "put" && operation.entity === "run" ? operation.value : undefined;
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  projection.attachRun(activeRun("2026-07-16T08:00:00.0000009Z"));

  await projection.finishRun({
    cause: { type: "system", name: "finish" },
    endedAt: "2026-07-16T08:00:00.0000001Z",
    event: "finish",
    runId: RUN_ID,
    status: "completed",
  });

  expect(terminalRun).toMatchObject({ endedAt: "2026-07-16T08:00:00.0000009Z" });
});

test("Contract projection applies Authority admission before dispatch", async () => {
  let calls = 0;
  const projection = new ContractProjection({
    admissionLimits: { maxBytes: 1_024, maxInlineBytes: 1 },
    authority: async () => {
      calls += 1;
    },
    preview: () => {},
    sessionId: SESSION_ID,
  });
  const timestamp = "2026-07-16T08:00:00.000Z";
  projection.attachRun(activeRun(timestamp));

  await expect(
    projection.putItem(
      RUN_ID,
      "image",
      { type: "system", name: "image" },
      {
        ...activeMessage("message-1", timestamp),
        content: [{ data: "aGk=", mediaType: "text/plain", type: "inline_blob" }],
      },
    ),
  ).rejects.toThrow("inline Blob");
  expect(calls).toBe(0);

  const item = activeMessage("message-1", timestamp);
  await expect(
    projection.putItem(RUN_ID, "image", { name: "image", type: "system" }, item),
  ).resolves.toEqual(item);
  expect(calls).toBe(1);
});

test.each([
  ["an identical retry", (run: Run) => structuredClone(run), null],
  [
    "changed state",
    (run: Run) => ({ ...run, input: [{ text: "changed", type: "text" as const }] }),
    "already attached with different state",
  ],
] as const)("Contract projection handles %s for an attached Run", (_name, retry, error) => {
  const projection = new ContractProjection({
    authority: async () => {},
    preview: () => {},
    sessionId: SESSION_ID,
  });
  const run = activeRun("2026-07-16T08:00:00.000Z");
  projection.attachRun(run);

  if (error === null) {
    expect(() => projection.attachRun(retry(run))).not.toThrow();
    expect(projection.run(RUN_ID)).toEqual(run);
  } else {
    expect(() => projection.attachRun(retry(run))).toThrow(error);
    expect(projection.run(RUN_ID)).toEqual(run);
  }
});

test("Contract projection commits terminal snapshots and remaining cleanup atomically", async () => {
  const startedAt = "2026-07-16T08:00:00.000Z";
  const endedAt = "2026-07-16T08:00:01.000Z";
  const commits: AuthorityOperation[][] = [];
  const projection = new ContractProjection({
    authority: async ({ operations }) => commits.push([...operations]),
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
