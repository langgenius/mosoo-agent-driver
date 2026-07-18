import { z } from "zod";

import { protocolIdSchema, revisionSchema } from "./common";
import { committedMutationSchema } from "./mutation";
import { previewBatchSchema } from "./preview";
import { sessionSnapshotSchema } from "./state";

export const snapshotSyncSchema = z
  .strictObject({
    type: z.literal("snapshot"),
    snapshot: sessionSnapshotSchema,
    minimumResumeRevision: revisionSchema,
  })
  .refine((sync) => sync.minimumResumeRevision <= sync.snapshot.revision, {
    message: "minimumResumeRevision cannot exceed the snapshot revision.",
    path: ["minimumResumeRevision"],
  });

export const mutationSyncSchema = z
  .strictObject({
    type: z.literal("mutations"),
    baseRevision: revisionSchema,
    throughRevision: revisionSchema,
    mutations: z.array(committedMutationSchema),
  })
  .superRefine((batch, context) => {
    let expected = batch.baseRevision + 1;
    let sessionId: string | undefined;

    for (const [index, mutation] of batch.mutations.entries()) {
      if (mutation.baseRevision !== expected - 1) {
        context.addIssue({
          code: "custom",
          message: `Expected base revision ${expected - 1}.`,
          path: ["mutations", index, "baseRevision"],
          input: mutation,
        });
      }

      if (mutation.revision !== expected) {
        context.addIssue({
          code: "custom",
          message: `Expected revision ${expected}.`,
          path: ["mutations", index, "revision"],
          input: mutation,
        });
      }

      sessionId ??= mutation.sessionId;

      if (mutation.sessionId !== sessionId) {
        context.addIssue({
          code: "custom",
          message: "Every mutation in a sync batch must belong to the same Session.",
          path: ["mutations", index, "sessionId"],
          input: mutation,
        });
      }

      expected += 1;
    }

    if (
      new Set(batch.mutations.map((mutation) => mutation.mutationId)).size !==
      batch.mutations.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Mutation identities must be unique within a sync batch.",
        path: ["mutations"],
        input: batch.mutations,
      });
    }

    const expectedThrough = batch.mutations.length === 0 ? batch.baseRevision : expected - 1;

    if (batch.throughRevision !== expectedThrough) {
      context.addIssue({
        code: "custom",
        message: `throughRevision must be ${expectedThrough}.`,
        path: ["throughRevision"],
        input: batch,
      });
    }
  });

export const syncPayloadSchema = z.union([snapshotSyncSchema, mutationSyncSchema]);
export type SnapshotSync = z.infer<typeof snapshotSyncSchema>;
export type MutationSync = z.infer<typeof mutationSyncSchema>;
export type SyncPayload = z.infer<typeof syncPayloadSchema>;

export const subscriptionUpdateSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("sync"),
    subscriptionId: protocolIdSchema,
    payload: syncPayloadSchema,
  }),
  z.strictObject({
    type: z.literal("preview"),
    subscriptionId: protocolIdSchema,
    payload: previewBatchSchema,
  }),
  z.strictObject({
    type: z.literal("resync_required"),
    subscriptionId: protocolIdSchema,
    lastSentRevision: revisionSchema,
    reason: z.enum(["slow_consumer", "tail_compacted", "server_restart"]),
  }),
]);
export type SubscriptionUpdate = z.infer<typeof subscriptionUpdateSchema>;
