import { z } from "zod";

import { contentBlockSchema, metaSchema, openEnum } from "./content";
import type { OpenEnum } from "./content";

/**
 * Session transcript items. One lifecycle for every kind:
 * item.started (snapshot) → item.delta* / item.updated* → item.completed
 * (authoritative snapshot; may not equal the concatenation of deltas).
 *
 * `itemId` is an opaque non-empty string so adapters can pass vendor ids
 * (Codex UUIDv7, ACP toolCallId, …) through without a mapping table.
 */
export const itemIdSchema = z.string().min(1);

/** Unified status vocabulary (ACP tool statuses ∪ Codex item statuses). */
export const ITEM_STATUSES = ["pending", "in_progress", "completed", "failed", "declined"] as const;
export type ItemStatus = OpenEnum<(typeof ITEM_STATUSES)[number]>;
const itemStatusSchema = openEnum(ITEM_STATUSES);

export const sessionErrorSchema = z.looseObject({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean().optional(),
  detail: metaSchema.optional(),
});
export type SessionError = z.infer<typeof sessionErrorSchema>;

export const messageItemSchema = z.looseObject({
  kind: z.literal("message"),
  itemId: itemIdSchema,
  role: z.enum(["user", "agent"]),
  content: z.array(contentBlockSchema),
  /** Codex MessagePhase (e.g. commentary vs final); open. */
  phase: z.string().min(1).optional(),
  meta: metaSchema.optional(),
});

export const reasoningItemSchema = z.looseObject({
  kind: z.literal("reasoning"),
  itemId: itemIdSchema,
  /** Indexed parts: item.delta stream "reasoning_summary"/"reasoning" appends by `index`. */
  summary: z.array(z.string()),
  content: z.array(z.string()),
  meta: metaSchema.optional(),
});

export const planEntrySchema = z.looseObject({
  content: z.string(),
  status: openEnum(["pending", "in_progress", "completed"]),
  priority: openEnum(["high", "medium", "low"]).optional(),
});

export const planItemSchema = z.looseObject({
  kind: z.literal("plan"),
  itemId: itemIdSchema,
  /** Each snapshot/patch replaces the full entry list (ACP plan semantics). */
  entries: z.array(planEntrySchema),
  meta: metaSchema.optional(),
});

/** Best-effort parse of what a shell command does (Codex commandActions). */
export const commandActionSchema = z.looseObject({
  type: openEnum(["read", "list_files", "search", "unknown"]),
  command: z.string().optional(),
  path: z.string().optional(),
  query: z.string().optional(),
  name: z.string().optional(),
});

export const commandItemSchema = z.looseObject({
  kind: z.literal("command"),
  itemId: itemIdSchema,
  command: z.string(),
  status: itemStatusSchema,
  cwd: z.string().optional(),
  actions: z.array(commandActionSchema).optional(),
  /** Aggregated stdout+stderr; streamed via item.delta stream "output". */
  output: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().nonnegative().optional(),
  processId: z.string().optional(),
  source: openEnum(["agent", "user"]).optional(),
  meta: metaSchema.optional(),
});

/** Codex FileUpdateChange ∪ ACP v2 DiffChange. */
export const fileChangeSchema = z.looseObject({
  path: z.string().min(1),
  op: openEnum(["add", "modify", "delete", "move", "copy"]),
  oldPath: z.string().optional(),
  /** Unified diff when representable (git patch style); binary/dir changes omit it. */
  diff: z.string().nullable().optional(),
  fileType: openEnum(["text", "binary", "directory", "symlink"]).optional(),
});

export const fileChangeItemSchema = z.looseObject({
  kind: z.literal("file_change"),
  itemId: itemIdSchema,
  changes: z.array(fileChangeSchema).min(1),
  status: itemStatusSchema,
  meta: metaSchema.optional(),
});

export const toolCallOutputSchema = z.looseObject({
  content: z.array(contentBlockSchema),
  structured: z.unknown().optional(),
  isError: z.boolean().optional(),
});

export const toolCallLocationSchema = z.looseObject({
  path: z.string().min(1),
  line: z.number().int().nonnegative().optional(),
});

export const toolCallItemSchema = z.looseObject({
  kind: z.literal("tool_call"),
  itemId: itemIdSchema,
  name: z.string().min(1),
  status: itemStatusSchema,
  title: z.string().nullable().optional(),
  /** ACP ToolKind — generic rendering hint. */
  category: openEnum([
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "other",
  ]).optional(),
  origin: openEnum(["mcp", "provider", "host"]).optional(),
  /** MCP server name when origin is "mcp". */
  server: z.string().optional(),
  input: z.unknown().optional(),
  output: toolCallOutputSchema.nullable().optional(),
  error: sessionErrorSchema.nullable().optional(),
  locations: z.array(toolCallLocationSchema).optional(),
  /** Latest MCP progress message (LWW via item.updated). */
  progressMessage: z.string().nullable().optional(),
  durationMs: z.number().nonnegative().optional(),
  meta: metaSchema.optional(),
});

/**
 * Extension items carry vendor granularity the core does not type (Codex
 * webSearch, imageGeneration, collab agents, review mode, context compaction…).
 * Implementation-defined kinds should use the `x_` prefix; bare unknown kinds
 * are reserved for future contract versions. Both parse through this shape.
 */
export const extensionItemSchema = z.looseObject({
  kind: z.string().min(1),
  itemId: itemIdSchema,
  status: itemStatusSchema.optional(),
  payload: metaSchema.optional(),
  meta: metaSchema.optional(),
});

export type MessageItem = z.infer<typeof messageItemSchema>;
export type ReasoningItem = z.infer<typeof reasoningItemSchema>;
export type PlanEntry = z.infer<typeof planEntrySchema>;
export type PlanItem = z.infer<typeof planItemSchema>;
export type CommandAction = z.infer<typeof commandActionSchema>;
export type CommandItem = z.infer<typeof commandItemSchema>;
export type FileChange = z.infer<typeof fileChangeSchema>;
export type FileChangeItem = z.infer<typeof fileChangeItemSchema>;
export type ToolCallOutput = z.infer<typeof toolCallOutputSchema>;
export type ToolCallItem = z.infer<typeof toolCallItemSchema>;
export type ExtensionItem = z.infer<typeof extensionItemSchema>;

export type SessionItem =
  | CommandItem
  | ExtensionItem
  | FileChangeItem
  | MessageItem
  | PlanItem
  | ReasoningItem
  | ToolCallItem;

export type SessionItemKind = SessionItem["kind"];

const TYPED_ITEM_SCHEMAS = {
  command: commandItemSchema,
  file_change: fileChangeItemSchema,
  message: messageItemSchema,
  plan: planItemSchema,
  reasoning: reasoningItemSchema,
  tool_call: toolCallItemSchema,
} as const;

export const sessionItemSchema: z.ZodType<SessionItem> = z
  .looseObject({ kind: z.string().min(1), itemId: itemIdSchema })
  .transform((value, ctx) => {
    const schema =
      value.kind in TYPED_ITEM_SCHEMAS
        ? TYPED_ITEM_SCHEMAS[value.kind as keyof typeof TYPED_ITEM_SCHEMAS]
        : extensionItemSchema;
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

export function parseSessionItem(value: unknown): SessionItem {
  return sessionItemSchema.parse(value);
}

/**
 * item.updated patches: any typed item's fields minus identity (itemId/kind),
 * replace-per-field (LWW). Unknown item kinds accept any record patch.
 */
const identity = { kind: true, itemId: true } as const;
const ITEM_PATCH_SCHEMAS: Record<string, z.ZodType<Record<string, unknown>>> = {
  command: commandItemSchema.omit(identity).partial(),
  file_change: fileChangeItemSchema.omit(identity).partial(),
  message: messageItemSchema.omit(identity).partial(),
  plan: planItemSchema.omit(identity).partial(),
  reasoning: reasoningItemSchema.omit(identity).partial(),
  tool_call: toolCallItemSchema.omit(identity).partial(),
};

export type SessionItemPatch = Record<string, unknown>;

export function parseSessionItemPatch(kind: string, value: unknown): SessionItemPatch {
  return (ITEM_PATCH_SCHEMAS[kind] ?? metaSchema).parse(value);
}

/** Apply an item.updated patch: shallow replace-per-field, identity preserved. */
export function applySessionItemPatch<T extends SessionItem>(item: T, patch: SessionItemPatch): T {
  return { ...item, ...patch, itemId: item.itemId, kind: item.kind };
}
