import { z } from "zod";

import {
  compareTimestamps,
  extensionNameSchema,
  extensionsSchema,
  jsonValueSchema,
  opaqueIdSchema,
  protocolErrorSchema,
  protocolIdSchema,
  revisionSchema,
  requestDigestSchema,
  timestampSchema,
} from "./common";
import { contentBlockSchema } from "./content";

export const COMMAND_KINDS = [
  "interaction.resolve",
  "run.cancel",
  "run.start",
  "run.steer",
  "session.close",
  "session.configure",
] as const;
export const commandKindSchema = z.enum(COMMAND_KINDS);

const commandBase = {
  commandId: protocolIdSchema,
  sessionId: protocolIdSchema,
  expectedRevision: revisionSchema.optional(),
  extensions: extensionsSchema.optional(),
} as const;

export const permissionResolutionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("selected"), optionId: opaqueIdSchema }),
  z.strictObject({ type: z.literal("cancelled") }),
]);

export const inputResolutionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("answered"),
    answers: z.record(opaqueIdSchema, z.array(z.string()).min(1)),
  }),
  z.strictObject({ type: z.literal("cancelled") }),
]);

export const toolResolutionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("completed"),
    output: z.array(contentBlockSchema),
    structuredOutput: jsonValueSchema.optional(),
  }),
  z.strictObject({ type: z.literal("failed"), error: protocolErrorSchema }),
  z.strictObject({ type: z.literal("cancelled") }),
]);

export const interactionResolutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("permission"), value: permissionResolutionSchema }),
  z.strictObject({ kind: z.literal("input"), value: inputResolutionSchema }),
  z.strictObject({ kind: z.literal("tool"), value: toolResolutionSchema }),
  z.strictObject({
    kind: z.literal("extension"),
    name: extensionNameSchema,
    value: jsonValueSchema,
  }),
]);

export const commandSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...commandBase,
      kind: z.literal("run.start"),
      runId: protocolIdSchema,
      input: z.array(contentBlockSchema).min(1),
      parentRunId: protocolIdSchema.optional(),
      retryOf: protocolIdSchema.optional(),
    }),
    z.strictObject({
      ...commandBase,
      kind: z.literal("run.steer"),
      runId: protocolIdSchema,
      input: z.array(contentBlockSchema).min(1),
    }),
    z.strictObject({
      ...commandBase,
      kind: z.literal("run.cancel"),
      runId: protocolIdSchema,
      reason: z.string().optional(),
    }),
    z.strictObject({
      ...commandBase,
      kind: z.literal("session.close"),
      reason: z.string().optional(),
    }),
    z.strictObject({
      ...commandBase,
      kind: z.literal("session.configure"),
      changes: z.array(z.strictObject({ configId: opaqueIdSchema, value: jsonValueSchema })).min(1),
    }),
    z.strictObject({
      ...commandBase,
      kind: z.literal("interaction.resolve"),
      interactionId: protocolIdSchema,
      resolution: interactionResolutionSchema,
    }),
  ])
  .superRefine((command, context) => {
    if (command.kind !== "session.configure") {
      return;
    }

    const configIds = command.changes.map((change) => change.configId);

    if (new Set(configIds).size !== configIds.length) {
      context.addIssue({
        code: "custom",
        message: "A configure command may change each config option at most once.",
        path: ["changes"],
        input: command,
      });
    }
  });

export type PermissionResolution = z.infer<typeof permissionResolutionSchema>;
export type InputResolution = z.infer<typeof inputResolutionSchema>;
export type ToolResolution = z.infer<typeof toolResolutionSchema>;
export type InteractionResolution = z.infer<typeof interactionResolutionSchema>;
export type Command = z.infer<typeof commandSchema>;
export type CommandKind = z.infer<typeof commandKindSchema>;

export const commandStatusSchema = z.enum(["accepted", "completed", "failed", "cancelled"]);
export type CommandStatus = z.infer<typeof commandStatusSchema>;

export const commandRecordSchema = z
  .strictObject({
    commandId: protocolIdSchema,
    sessionId: protocolIdSchema,
    kind: commandKindSchema,
    requestDigest: requestDigestSchema,
    status: commandStatusSchema,
    acceptedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    result: jsonValueSchema.optional(),
    error: protocolErrorSchema.optional(),
  })
  .superRefine((record, context) => {
    const terminal = record.status !== "accepted";

    if (terminal !== (record.completedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "completedAt must be present exactly when a Command is terminal.",
        path: ["completedAt"],
        input: record,
      });
    }

    if (
      record.completedAt !== undefined &&
      compareTimestamps(record.completedAt, record.acceptedAt) < 0
    ) {
      context.addIssue({
        code: "custom",
        message: "completedAt cannot be earlier than acceptedAt.",
        path: ["completedAt"],
        input: record,
      });
    }

    if ((record.status === "failed") !== (record.error !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "error must be present exactly when a Command has failed.",
        path: ["error"],
        input: record,
      });
    }

    if (record.result !== undefined && record.status !== "completed") {
      context.addIssue({
        code: "custom",
        message: "result is only valid for a completed Command.",
        path: ["result"],
        input: record,
      });
    }
  });
export type CommandRecord = z.infer<typeof commandRecordSchema>;

export const commandReceiptSchema = z
  .strictObject({
    commandId: protocolIdSchema,
    status: commandStatusSchema,
    duplicate: z.boolean(),
    result: jsonValueSchema.optional(),
    error: protocolErrorSchema.optional(),
  })
  .superRefine((receipt, context) => {
    if ((receipt.status === "failed") !== (receipt.error !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "error must be present exactly when a Command has failed.",
        path: ["error"],
        input: receipt,
      });
    }

    if (receipt.result !== undefined && receipt.status !== "completed") {
      context.addIssue({
        code: "custom",
        message: "result is only valid for a completed Command.",
        path: ["result"],
        input: receipt,
      });
    }
  });
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
