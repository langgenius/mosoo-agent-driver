import { expect, test } from "bun:test";

import { AuthorityOutcomeUnknownError, interactionSchema, itemSchema } from "../src/contract";
import type { Item, Run } from "../src/contract";
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

function activeRun(startedAt: string, input = true): Run {
  return {
    id: RUN_ID,
    input: input ? [{ text: "hello", type: "text" }] : [],
    origin: input ? "user" : "system",
    startedAt,
    status: "active",
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
