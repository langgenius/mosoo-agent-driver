import { expect, test } from "bun:test";

import { AuthorityOutcomeUnknownError, interactionSchema, itemSchema } from "../src/contract";
import type { Item, Run } from "../src/contract";
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
