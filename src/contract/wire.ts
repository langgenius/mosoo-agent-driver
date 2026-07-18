import { z } from "zod";

import {
  capabilitiesSchema,
  implementationSchema,
  jsonByteLength,
  jsonObjectSchema,
  jsonValueSchema,
  leaseFenceSchema,
  leaseSchema,
  protocolErrorSchema,
  protocolIdSchema,
  protocolVersionSchema,
  revisionSchema,
} from "./common";
import { commandReceiptSchema, commandRecordSchema, commandSchema } from "./command";
import { mutationReceiptSchema, proposedMutationSchema } from "./mutation";
import { executorPreviewSubmissionSchema } from "./preview";
import { subscriptionUpdateSchema, syncPayloadSchema } from "./sync";

const MAX_JSON_RPC_ID_LENGTH = 256;
const maxJsonRpcId = "0".repeat(MAX_JSON_RPC_ID_LENGTH);
const maxLease = { epoch: Number.MAX_SAFE_INTEGER, leaseId: "Z".repeat(26) };
const CORE_OBJECT_ENVELOPE_BYTES = Math.max(
  jsonByteLength({
    id: maxJsonRpcId,
    jsonrpc: "2.0",
    method: "command/submit",
    params: {},
  }) - 2,
  jsonByteLength({
    id: maxJsonRpcId,
    jsonrpc: "2.0",
    method: "executor/mutate",
    params: { lease: maxLease, mutation: {} },
  }) - 2,
  jsonByteLength({
    id: maxJsonRpcId,
    jsonrpc: "2.0",
    method: "executor/preview",
    params: { batch: {}, lease: maxLease },
  }) - 2,
  jsonByteLength({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      payload: {
        minimumResumeRevision: Number.MAX_SAFE_INTEGER,
        snapshot: {},
        type: "snapshot",
      },
      subscriptionId: "Z".repeat(26),
      type: "sync",
    },
  }) - 2,
  jsonByteLength({
    id: maxJsonRpcId,
    jsonrpc: "2.0",
    result: {
      initial: {
        minimumResumeRevision: Number.MAX_SAFE_INTEGER,
        snapshot: {},
        type: "snapshot",
      },
      lease: maxLease,
      subscriptionId: "Z".repeat(26),
    },
  }) - 2,
);
const INLINE_BLOB_ENVELOPE_BYTES = jsonByteLength({
  data: "",
  mediaType: "x",
  type: "inline_blob",
});

export function assertFrameAdmission(frame: unknown, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Protocol frame limit must be a positive safe integer.");
  }

  if (jsonByteLength(frame) > maxBytes) {
    throw new RangeError("Protocol frame byte limit exceeded.");
  }
}

export const protocolLimitsSchema = z.strictObject({
  authorityFlushIntervalMs: z.number().int().positive().safe(),
  maxCommandBytes: z.number().int().positive().safe(),
  maxFrameBytes: z.number().int().positive().safe(),
  maxInlineBytes: z.number().int().positive().safe(),
  maxInteractionTtlMs: z.number().int().positive().safe(),
  maxMutationBytes: z.number().int().positive().safe(),
  maxMutationBatchCount: z.number().int().positive().safe(),
  maxPendingMutationBytes: z.number().int().positive().safe(),
  maxPendingCommandBytes: z.number().int().positive().safe(),
  maxPreviewBatchBytes: z.number().int().positive().safe(),
  maxPreviewBatchUpdates: z.number().int().positive().safe(),
  maxSnapshotBytes: z.number().int().positive().safe(),
  maxSubscriberQueueBytes: z.number().int().positive().safe(),
  maxSubscriptionsPerSession: z.number().int().positive().safe(),
  previewFlushIntervalMs: z.number().int().positive().safe(),
  previewReplaceIntervalMs: z.number().int().positive().safe(),
});
export type ProtocolLimits = z.infer<typeof protocolLimitsSchema>;

export const peerLimitsSchema = protocolLimitsSchema.pick({ maxFrameBytes: true });
export type PeerLimits = z.infer<typeof peerLimitsSchema>;

export const initializeParamsSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  role: z.enum(["executor", "controller", "observer"]),
  implementation: implementationSchema,
  capabilities: capabilitiesSchema,
  limits: peerLimitsSchema,
});

export const initializeResultSchema = z
  .strictObject({
    protocolVersion: protocolVersionSchema,
    implementation: implementationSchema,
    capabilities: capabilitiesSchema,
    limits: protocolLimitsSchema,
  })
  .superRefine((result, context) => {
    const { limits } = result;

    for (const field of [
      "maxCommandBytes",
      "maxMutationBytes",
      "maxPreviewBatchBytes",
      "maxSnapshotBytes",
    ] as const) {
      if (limits[field] + CORE_OBJECT_ENVELOPE_BYTES > limits.maxFrameBytes) {
        context.addIssue({
          code: "custom",
          message: `${field} must leave room for its JSON-RPC envelope.`,
          path: ["limits", field],
          input: limits,
        });
      }
    }

    if (
      Math.ceil(limits.maxInlineBytes / 3) * 4 +
        INLINE_BLOB_ENVELOPE_BYTES +
        CORE_OBJECT_ENVELOPE_BYTES >
      limits.maxFrameBytes
    ) {
      context.addIssue({
        code: "custom",
        message: "maxInlineBytes must leave room for base64 encoding and its JSON-RPC envelope.",
        path: ["limits", "maxInlineBytes"],
        input: limits,
      });
    }

    if (jsonByteLength({ id: maxJsonRpcId, jsonrpc: "2.0", result }) > limits.maxFrameBytes) {
      context.addIssue({
        code: "custom",
        message: "initialize result cannot fit in maxFrameBytes.",
        path: ["limits", "maxFrameBytes"],
        input: limits,
      });
    }
  });

export const subscribeParamsSchema = z.strictObject({
  sessionId: protocolIdSchema,
  afterRevision: revisionSchema.optional(),
  includePreviews: z.boolean(),
});

export const subscribeResultSchema = z.strictObject({
  subscriptionId: protocolIdSchema,
  initial: syncPayloadSchema,
});

export const unsubscribeParamsSchema = z.strictObject({
  subscriptionId: protocolIdSchema,
});

export const executorAttachParamsSchema = z.strictObject({
  sessionId: protocolIdSchema,
  executorId: protocolIdSchema,
  afterRevision: revisionSchema.optional(),
  previousLease: leaseFenceSchema.optional(),
});

export const executorAttachResultSchema = z.strictObject({
  lease: leaseSchema,
  subscriptionId: protocolIdSchema,
  initial: syncPayloadSchema,
});

export const executorRenewParamsSchema = z.strictObject({
  sessionId: protocolIdSchema,
  lease: leaseFenceSchema,
});

export const executorMutateParamsSchema = z.strictObject({
  lease: leaseFenceSchema,
  mutation: proposedMutationSchema,
});

export const executorCommandParamsSchema = z.strictObject({
  lease: leaseFenceSchema,
  command: commandSchema,
});

export const executorCommandResultParamsSchema = z
  .strictObject({
    lease: leaseFenceSchema,
    commandId: protocolIdSchema,
    status: z.enum(["completed", "failed", "cancelled"]),
    result: z.json().optional(),
    error: protocolErrorSchema.optional(),
  })
  .superRefine((record, context) => {
    if ((record.status === "failed") !== (record.error !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "error must be present exactly when command execution failed.",
        path: ["error"],
        input: record,
      });
    }

    if (record.result !== undefined && record.status !== "completed") {
      context.addIssue({
        code: "custom",
        message: "result is only valid for completed command execution.",
        path: ["result"],
        input: record,
      });
    }
  });

export const commandGetParamsSchema = z.strictObject({
  sessionId: protocolIdSchema,
  commandId: protocolIdSchema,
});

export const methodSchemas = {
  "command/get": { params: commandGetParamsSchema, result: commandRecordSchema },
  "command/submit": { params: commandSchema, result: commandReceiptSchema },
  "executor/attach": { params: executorAttachParamsSchema, result: executorAttachResultSchema },
  "executor/command": { params: executorCommandParamsSchema, result: commandReceiptSchema },
  "executor/commandResult": {
    params: executorCommandResultParamsSchema,
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "executor/mutate": { params: executorMutateParamsSchema, result: mutationReceiptSchema },
  "executor/preview": {
    params: executorPreviewSubmissionSchema,
    result: z.never(),
  },
  "executor/renew": { params: executorRenewParamsSchema, result: leaseSchema },
  initialize: { params: initializeParamsSchema, result: initializeResultSchema },
  "session/subscribe": { params: subscribeParamsSchema, result: subscribeResultSchema },
  "session/unsubscribe": {
    params: unsubscribeParamsSchema,
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "session/update": { params: subscriptionUpdateSchema, result: z.never() },
} as const;

export type CoreMethod = keyof typeof methodSchemas;
export const CORE_METHODS = Object.keys(methodSchemas) as [CoreMethod, ...CoreMethod[]];
export const coreMethodSchema = z.enum(CORE_METHODS);

export const jsonRpcIdSchema = z.union([
  z.string().max(MAX_JSON_RPC_ID_LENGTH),
  z.number().int().safe(),
]);
const jsonRpcParamsSchema = z.union([jsonObjectSchema, z.array(jsonValueSchema)]);

export const jsonRpcRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: jsonRpcIdSchema,
  method: z.string().min(1),
  params: jsonRpcParamsSchema.optional(),
});

export const jsonRpcNotificationSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: jsonRpcParamsSchema.optional(),
});

export const jsonRpcSuccessSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: jsonRpcIdSchema,
  result: jsonValueSchema,
});

export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  overloaded: -32001,
  conflict: -32009,
  staleRevision: -32010,
  leaseExpired: -32011,
  resyncRequired: -32012,
  unsupported: -32013,
  resourceExhausted: -32014,
} as const;

export const jsonRpcErrorSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: jsonRpcIdSchema.nullable(),
  error: z.strictObject({
    code: z.number().int().safe(),
    message: z.string(),
    data: protocolErrorSchema.optional(),
  }),
});

export type InitializeParams = z.infer<typeof initializeParamsSchema>;
export type InitializeResult = z.infer<typeof initializeResultSchema>;
export type SubscribeParams = z.infer<typeof subscribeParamsSchema>;
export type SubscribeResult = z.infer<typeof subscribeResultSchema>;
export type UnsubscribeParams = z.infer<typeof unsubscribeParamsSchema>;
export type ExecutorAttachParams = z.infer<typeof executorAttachParamsSchema>;
export type ExecutorAttachResult = z.infer<typeof executorAttachResultSchema>;
export type ExecutorRenewParams = z.infer<typeof executorRenewParamsSchema>;
export type ExecutorMutateParams = z.infer<typeof executorMutateParamsSchema>;
export type ExecutorCommandParams = z.infer<typeof executorCommandParamsSchema>;
export type ExecutorCommandResultParams = z.infer<typeof executorCommandResultParamsSchema>;
export type CommandGetParams = z.infer<typeof commandGetParamsSchema>;
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;
export type JsonRpcSuccess = z.infer<typeof jsonRpcSuccessSchema>;
export type JsonRpcError = z.infer<typeof jsonRpcErrorSchema>;
