import { z } from "zod";

import {
  blobRefSchema,
  compareTimestamps,
  extensionNameSchema,
  extensionsSchema,
  opaqueIdSchema,
  protocolIdSchema,
  protocolErrorSchema,
  timestampSchema,
} from "./common";

export const coreResourceKindSchema = z.enum(["blob", "provider_job", "sandbox"]);
export const resourceKindSchema = z.union([coreResourceKindSchema, extensionNameSchema]);
export const resourceKeySchema = z.string().min(1).max(1056);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isCanonicalItemId(value: string): boolean {
  try {
    const bytes = Uint8Array.fromBase64(value, { alphabet: "base64url" });
    return (
      bytes.toBase64({ alphabet: "base64url", omitPadding: true }) === value &&
      opaqueIdSchema.safeParse(utf8Decoder.decode(bytes)).success
    );
  } catch {
    return false;
  }
}

export const blobReferenceKeySchema = resourceKeySchema.superRefine((value, context) => {
  const [kind, id, itemId, ...extra] = value.split(":");
  const canonicalId = protocolIdSchema.safeParse(id);
  const validOwner =
    extra.length === 0 &&
    canonicalId.success &&
    canonicalId.data === id &&
    ((itemId === undefined && (kind === "session" || kind === "run" || kind === "interaction")) ||
      (kind === "item" && itemId !== undefined && isCanonicalItemId(itemId)));

  if (!validOwner) {
    context.addIssue({
      code: "custom",
      message: "Blob reference key is not canonical.",
      input: value,
    });
  }
});

export const cleanupObligationSchema = z
  .strictObject({
    id: protocolIdSchema,
    sessionId: protocolIdSchema,
    runId: protocolIdSchema.optional(),
    kind: resourceKindSchema,
    resourceKey: resourceKeySchema,
    releaseAfter: timestampSchema,
    attempts: z.number().int().nonnegative().safe(),
    nextAttemptAt: timestampSchema,
    lastError: protocolErrorSchema.optional(),
    extensions: extensionsSchema.optional(),
  })
  .refine(
    (obligation) => compareTimestamps(obligation.nextAttemptAt, obligation.releaseAfter) >= 0,
    {
      message: "nextAttemptAt cannot be earlier than releaseAfter.",
      path: ["nextAttemptAt"],
    },
  );

export const blobManifestEntrySchema = z
  .strictObject({
    blob: blobRefSchema,
    sessionId: protocolIdSchema,
    references: z.array(blobReferenceKeySchema),
    deleteAfter: timestampSchema.optional(),
  })
  .superRefine((entry, context) => {
    for (const [index, reference] of entry.references.entries()) {
      if (reference.startsWith("session:") && reference !== `session:${entry.sessionId}`) {
        context.addIssue({
          code: "custom",
          message: "Blob Session reference must match its manifest owner.",
          path: ["references", index],
          input: reference,
        });
      }
    }

    if (new Set(entry.references).size !== entry.references.length) {
      context.addIssue({
        code: "custom",
        message: "Blob references must be unique.",
        path: ["references"],
        input: entry,
      });
    }

    if ((entry.references.length === 0) !== (entry.deleteAfter !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "deleteAfter must be present exactly when a Blob has no references.",
        path: ["deleteAfter"],
        input: entry,
      });
    }
  });

export type CoreResourceKind = z.infer<typeof coreResourceKindSchema>;
export type ResourceKind = z.infer<typeof resourceKindSchema>;
export type ResourceKey = z.infer<typeof resourceKeySchema>;
export type BlobReferenceKey = z.infer<typeof blobReferenceKeySchema>;
export type CleanupObligation = z.infer<typeof cleanupObligationSchema>;
export type BlobManifestEntry = z.infer<typeof blobManifestEntrySchema>;
