import { z } from "zod";

export const PROTOCOL_VERSION = 2;
export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);
export const timestampSchema = z.iso.datetime({ offset: true });
export const revisionSchema = z.number().int().nonnegative().safe();

export const protocolIdSchema = z.ulid().transform((value) => value.toUpperCase());
export const opaqueIdSchema = z.string().min(1).max(256);
export const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const requestDigestSchema = z.strictObject({
  algorithm: z.literal("hmac-sha256"),
  keyId: z.string().min(1).max(128),
  value: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type RequestDigest = z.infer<typeof requestDigestSchema>;

export const extensionNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+\/[a-z][a-z0-9._-]*$/u);

export const jsonValueSchema = z.json();
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export const extensionsSchema = z.record(extensionNameSchema, jsonValueSchema);

export type JsonValue = z.infer<typeof jsonValueSchema>;
export type JsonObject = z.infer<typeof jsonObjectSchema>;
export type Extensions = z.infer<typeof extensionsSchema>;

export interface ProtocolAdmissionLimits {
  readonly maxBytes: number;
  readonly maxInlineBytes: number;
}

const textEncoder = new TextEncoder();
const timestampPartsPattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;

function timestampParts(value: string): readonly [number, string] {
  const match = timestampPartsPattern.exec(value);

  if (match === null) {
    throw new TypeError("Timestamp comparison requires ISO 8601 values with offsets.");
  }

  return [Date.parse(`${match[1]}${match[3]}`), match[2] ?? ""];
}

export function jsonByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);

  if (encoded === undefined) {
    throw new TypeError("Protocol admission requires a JSON value.");
  }

  return textEncoder.encode(encoded).byteLength;
}

export function compareTimestamps(left: string, right: string): -1 | 0 | 1 {
  const [leftSecond, leftFraction] = timestampParts(left);
  const [rightSecond, rightFraction] = timestampParts(right);

  if (leftSecond !== rightSecond) {
    return leftSecond < rightSecond ? -1 : 1;
  }

  const width = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(width, "0");
  const normalizedRight = rightFraction.padEnd(width, "0");
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
}

export function assertProtocolAdmission(
  value: unknown,
  { maxBytes, maxInlineBytes }: ProtocolAdmissionLimits,
  content: readonly { readonly data?: string; readonly type: string }[],
): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    !Number.isSafeInteger(maxInlineBytes) ||
    maxBytes < 1 ||
    maxInlineBytes < 1
  ) {
    throw new RangeError("Protocol admission limits must be positive safe integers.");
  }

  if (jsonByteLength(value) > maxBytes) {
    throw new RangeError("Protocol object exceeds its encoded byte limit.");
  }

  for (const block of content) {
    if (block.type === "inline_blob" && block.data !== undefined) {
      const data = block.data;
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      const size = Math.floor((data.length * 3) / 4) - padding;

      if (size > maxInlineBytes) {
        throw new RangeError("Protocol inline Blob exceeds its decoded byte limit.");
      }
    }
  }
}

export const audienceSchema = z.enum(["participants", "operators"]);
export type Audience = z.infer<typeof audienceSchema>;

export const provenanceSchema = z.strictObject({
  provider: z.string().min(1).max(128),
  event: z.string().min(1).max(256).optional(),
  nativeIds: z.record(z.string().min(1).max(64), opaqueIdSchema).optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const protocolErrorSchema = z.strictObject({
  code: z.string().min(1).max(128),
  message: z.string(),
  retryable: z.boolean(),
  details: jsonObjectSchema.optional(),
});
export type ProtocolError = z.infer<typeof protocolErrorSchema>;

export const CORE_CAPABILITIES = [
  "blob",
  "interaction.input",
  "interaction.permission",
  "interaction.tool",
  "item.artifact",
  "item.change",
  "item.plan",
  "item.reasoning",
  "item.terminal",
  "run.agent_initiated",
  "run.child",
  "run.resume",
  "run.steer",
  "session.configure",
] as const;

export const coreCapabilitySchema = z.enum(CORE_CAPABILITIES);
export const capabilityNameSchema = z.union([coreCapabilitySchema, extensionNameSchema]);
export const capabilitiesSchema = z.record(capabilityNameSchema, jsonObjectSchema);

export type CoreCapability = z.infer<typeof coreCapabilitySchema>;
export type CapabilityName = z.infer<typeof capabilityNameSchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export const implementationSchema = z.strictObject({
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  title: z.string().min(1).max(256).optional(),
});
export type Implementation = z.infer<typeof implementationSchema>;

export const leaseFenceSchema = z.strictObject({
  leaseId: protocolIdSchema,
  epoch: z.number().int().positive().safe(),
});
export type LeaseFence = z.infer<typeof leaseFenceSchema>;

export const leaseSchema = leaseFenceSchema.extend({
  expiresAt: timestampSchema,
  renewAfterMs: z.number().int().positive().safe(),
});
export type Lease = z.infer<typeof leaseSchema>;

export const blobRefSchema = z.strictObject({
  blobId: protocolIdSchema,
  mediaType: z.string().min(1).max(256),
  sizeBytes: z.number().int().nonnegative().safe(),
  digest: sha256Schema,
  name: z.string().min(1).max(1024).optional(),
});
export type BlobRef = z.infer<typeof blobRefSchema>;
