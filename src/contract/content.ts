import { z } from "zod";

import { blobRefSchema, extensionNameSchema, extensionsSchema, jsonValueSchema } from "./common";

export const textContentSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
});

export const jsonContentSchema = z.strictObject({
  type: z.literal("json"),
  value: jsonValueSchema,
});

export const inlineBlobContentSchema = z.strictObject({
  type: z.literal("inline_blob"),
  mediaType: z.string().min(1).max(256),
  data: z.base64(),
  name: z.string().min(1).max(1024).optional(),
  alt: z.string().optional(),
});

export const blobRefContentSchema = z.strictObject({
  type: z.literal("blob_ref"),
  blob: blobRefSchema,
  alt: z.string().optional(),
});

export const resourceLinkContentSchema = z.strictObject({
  type: z.literal("resource_link"),
  uri: z.url(),
  name: z.string().min(1).max(1024).optional(),
  mediaType: z.string().min(1).max(256).optional(),
  digest: z.string().min(1).max(256).optional(),
});

export const extensionContentSchema = z.strictObject({
  type: z.literal("extension"),
  name: extensionNameSchema,
  value: jsonValueSchema,
  extensions: extensionsSchema.optional(),
});

export const contentBlockSchema = z.discriminatedUnion("type", [
  textContentSchema,
  jsonContentSchema,
  inlineBlobContentSchema,
  blobRefContentSchema,
  resourceLinkContentSchema,
  extensionContentSchema,
]);

export type TextContent = z.infer<typeof textContentSchema>;
export type JsonContent = z.infer<typeof jsonContentSchema>;
export type InlineBlobContent = z.infer<typeof inlineBlobContentSchema>;
export type BlobRefContent = z.infer<typeof blobRefContentSchema>;
export type ResourceLinkContent = z.infer<typeof resourceLinkContentSchema>;
export type ExtensionContent = z.infer<typeof extensionContentSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export function hasBlobRef(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((block) => block.type === "blob_ref");
}

export function contentExtensionNames(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap((block) => (block.type === "extension" ? [block.name] : []));
}
