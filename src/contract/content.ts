import { z } from "zod";

/**
 * Open string enum: known values keep literal types for DX, unknown non-empty
 * strings pass (contract rule: every enum is open; `x_*` is the extension
 * namespace, bare unknown values are reserved for future contract versions).
 */
export type OpenEnum<T extends string> = T | (string & {});

export function openEnum<const T extends readonly [string, ...string[]]>(_values: T) {
  return z.custom<OpenEnum<T[number]>>(
    (value) => typeof value === "string" && value.length > 0,
    "must be a non-empty string",
  );
}

export const metaSchema = z.record(z.string(), z.unknown());

const base64 = z.base64();
const uri = z.string().min(1);

/** MCP/ACP v2 aligned content blocks. Unknown `type` values pass through. */
export const textContentSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
  meta: metaSchema.optional(),
});

export const imageContentSchema = z
  .looseObject({
    type: z.literal("image"),
    mimeType: z.string().min(1),
    data: base64.optional(),
    uri: uri.optional(),
    meta: metaSchema.optional(),
  })
  .refine((block) => block.data !== undefined || block.uri !== undefined, {
    message: "image content requires data or uri",
  });

export const audioContentSchema = z.looseObject({
  type: z.literal("audio"),
  mimeType: z.string().min(1),
  data: base64,
  meta: metaSchema.optional(),
});

export const resourceLinkContentSchema = z.looseObject({
  type: z.literal("resource_link"),
  uri,
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  meta: metaSchema.optional(),
});

export const resourceContentSchema = z.looseObject({
  type: z.literal("resource"),
  resource: z.union([
    z.looseObject({ uri, mimeType: z.string().optional(), text: z.string() }),
    z.looseObject({ uri, mimeType: z.string().optional(), blob: base64 }),
  ]),
  meta: metaSchema.optional(),
});

const unknownContentSchema = z.looseObject({
  type: z.string().min(1),
  meta: metaSchema.optional(),
});

export type TextContent = z.infer<typeof textContentSchema>;
export type ImageContent = z.infer<typeof imageContentSchema>;
export type AudioContent = z.infer<typeof audioContentSchema>;
export type ResourceLinkContent = z.infer<typeof resourceLinkContentSchema>;
export type ResourceContent = z.infer<typeof resourceContentSchema>;
export type UnknownContent = z.infer<typeof unknownContentSchema>;

export type ContentBlock =
  | AudioContent
  | ImageContent
  | ResourceContent
  | ResourceLinkContent
  | TextContent
  | UnknownContent;

const TYPED_CONTENT_SCHEMAS: Record<string, z.ZodType<ContentBlock>> = {
  audio: audioContentSchema,
  image: imageContentSchema,
  resource: resourceContentSchema,
  resource_link: resourceLinkContentSchema,
  text: textContentSchema,
};

/** Strict on known `type` values, open on unknown ones (ACP v2 rule). */
export const contentBlockSchema: z.ZodType<ContentBlock> = z
  .looseObject({ type: z.string().min(1) })
  .transform((value, ctx) => {
    const schema = TYPED_CONTENT_SCHEMAS[value.type] ?? unknownContentSchema;
    const result = schema.safeParse(value);

    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: "custom",
          message: issue.message,
          path: [...issue.path],
          input: value,
        });
      }

      return z.NEVER;
    }

    return result.data;
  });

/** Best-effort plain-text rendering; non-text blocks become bracket labels. */
export function contentBlockText(block: ContentBlock): string {
  if (block.type === "text" && "text" in block && typeof block["text"] === "string") {
    return block["text"];
  }

  if (block.type === "resource" && "resource" in block) {
    const resource = block["resource"];

    if (typeof resource === "object" && resource !== null && "text" in resource) {
      const text = (resource as { text?: unknown }).text;

      if (typeof text === "string") {
        return text;
      }
    }
  }

  const name = "name" in block && typeof block["name"] === "string" ? `: ${block["name"]}` : "";
  return `[${block.type}${name}]`;
}
