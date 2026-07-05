import { z } from "zod";

import {
  protocolIdSchema,
  extensionsSchema,
  opaqueIdSchema,
  revisionSchema,
  timestampSchema,
} from "./common";
import { interactionSchema, itemSchema, runSchema, sessionSchema } from "./state";

export class AuthorityOutcomeUnknownError extends Error {
  override readonly name = "AuthorityOutcomeUnknownError";
}

export const putOperationSchema = z.discriminatedUnion("entity", [
  z.strictObject({ op: z.literal("put"), entity: z.literal("session"), value: sessionSchema }),
  z.strictObject({ op: z.literal("put"), entity: z.literal("run"), value: runSchema }),
  z.strictObject({ op: z.literal("put"), entity: z.literal("item"), value: itemSchema }),
  z.strictObject({
    op: z.literal("put"),
    entity: z.literal("interaction"),
    value: interactionSchema,
  }),
]);

export const removeOperationSchema = z.strictObject({
  op: z.literal("remove"),
  entity: z.literal("run"),
  id: protocolIdSchema,
  reason: z.enum(["compacted", "expired", "redacted"]),
});

export const authorityOperationSchema = z.union([putOperationSchema, removeOperationSchema]);
export type PutOperation = z.infer<typeof putOperationSchema>;
export type RemoveOperation = z.infer<typeof removeOperationSchema>;
export type AuthorityOperation = z.infer<typeof authorityOperationSchema>;

export const mutationCauseSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("command"), commandId: protocolIdSchema }),
  z.strictObject({ type: z.literal("provider"), providerEventId: opaqueIdSchema.optional() }),
  z.strictObject({ type: z.literal("alarm"), alarm: z.string().min(1).max(128) }),
  z.strictObject({ type: z.literal("system"), name: z.string().min(1).max(128) }),
]);
export type MutationCause = z.infer<typeof mutationCauseSchema>;

export const proposedMutationSchema = z.strictObject({
  mutationId: protocolIdSchema,
  sessionId: protocolIdSchema,
  baseRevision: revisionSchema,
  cause: mutationCauseSchema,
  operations: z.array(authorityOperationSchema).min(1),
  extensions: extensionsSchema.optional(),
});
export type ProposedMutation = z.infer<typeof proposedMutationSchema>;

export const committedMutationSchema = proposedMutationSchema.extend({
  revision: revisionSchema,
  committedAt: timestampSchema,
});
export type CommittedMutation = z.infer<typeof committedMutationSchema>;

export const mutationReceiptSchema = z.strictObject({
  mutationId: protocolIdSchema,
  revision: revisionSchema,
  duplicate: z.boolean(),
});
export type MutationReceipt = z.infer<typeof mutationReceiptSchema>;
