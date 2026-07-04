import { z } from "zod";

import {
  audienceSchema,
  capabilitiesSchema,
  protocolIdSchema,
  extensionNameSchema,
  extensionsSchema,
  jsonValueSchema,
  opaqueIdSchema,
  protocolErrorSchema,
  protocolVersionSchema,
  provenanceSchema,
  revisionSchema,
  timestampSchema,
} from "./common";
import { permissionResolutionSchema, toolResolutionSchema } from "./command";
import { contentBlockSchema } from "./content";

const configOptionBase = {
  id: opaqueIdSchema,
  label: z.string().min(1),
  description: z.string().optional(),
  category: z.string().min(1).optional(),
  extensions: extensionsSchema.optional(),
} as const;

const selectChoiceSchema = z.strictObject({
  id: opaqueIdSchema,
  label: z.string().min(1),
  description: z.string().optional(),
});

export const configOptionSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...configOptionBase, type: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({
    ...configOptionBase,
    type: z.literal("string"),
    value: z.string(),
  }),
  z.strictObject({
    ...configOptionBase,
    type: z.literal("number"),
    value: z.number().finite(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  }),
  z.strictObject({
    ...configOptionBase,
    type: z.literal("select"),
    value: opaqueIdSchema,
    choices: z.array(selectChoiceSchema).min(1),
  }),
]);
export type ConfigOption = z.infer<typeof configOptionSchema>;

export const sessionSchema = z.strictObject({
  id: protocolIdSchema,
  status: z.enum(["open", "closed"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  closedAt: timestampSchema.optional(),
  title: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  capabilities: capabilitiesSchema,
  config: z.array(configOptionSchema),
  parent: z
    .strictObject({
      sessionId: protocolIdSchema,
      revision: revisionSchema,
    })
    .optional(),
  provenance: provenanceSchema.optional(),
  extensions: extensionsSchema.optional(),
});
export type Session = z.infer<typeof sessionSchema>;

export const tokenUsageSchema = z.strictObject({
  input: z.number().int().nonnegative().safe().optional(),
  output: z.number().int().nonnegative().safe().optional(),
  cachedInput: z.number().int().nonnegative().safe().optional(),
  reasoning: z.number().int().nonnegative().safe().optional(),
  total: z.number().int().nonnegative().safe().optional(),
  cost: z
    .strictObject({
      amount: z.number().nonnegative().finite(),
      currency: z.string().length(3),
    })
    .optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

const runBase = {
  id: protocolIdSchema,
  origin: z.enum(["user", "agent", "system"]),
  input: z.array(contentBlockSchema),
  startedAt: timestampSchema,
  parentRunId: protocolIdSchema.optional(),
  retryOf: protocolIdSchema.optional(),
  usage: tokenUsageSchema.optional(),
  provenance: provenanceSchema.optional(),
  extensions: extensionsSchema.optional(),
} as const;

export const runSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...runBase, status: z.literal("active") }),
  z.strictObject({
    ...runBase,
    status: z.literal("completed"),
    endedAt: timestampSchema,
    finishReason: z.enum(["success", "limit", "refusal", "other"]),
  }),
  z.strictObject({
    ...runBase,
    status: z.literal("failed"),
    endedAt: timestampSchema,
    error: protocolErrorSchema,
  }),
  z.strictObject({
    ...runBase,
    status: z.literal("cancelled"),
    endedAt: timestampSchema,
    reason: z.string().optional(),
  }),
]);
export type Run = z.infer<typeof runSchema>;
export type RunStatus = Run["status"];

export const itemStatusSchema = z.enum(["active", "completed", "failed", "cancelled"]);
export type ItemStatus = z.infer<typeof itemStatusSchema>;

const itemBase = {
  id: opaqueIdSchema,
  runId: protocolIdSchema,
  status: itemStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  audience: audienceSchema,
  error: protocolErrorSchema.optional(),
  provenance: provenanceSchema.optional(),
  extensions: extensionsSchema.optional(),
} as const;

export const messageItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal("message"),
  role: z.enum(["user", "agent"]),
  phase: z.enum(["commentary", "final"]).optional(),
  content: z.array(contentBlockSchema),
});

export const reasoningItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal("reasoning"),
  content: z.array(contentBlockSchema),
});

export const planEntrySchema = z.strictObject({
  id: opaqueIdSchema.optional(),
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  priority: z.enum(["high", "medium", "low"]).optional(),
});

export const planItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal("plan"),
  entries: z.array(planEntrySchema),
  explanation: z.string().optional(),
});

export const toolLocationSchema = z.strictObject({
  path: z.string().min(1),
  line: z.number().int().positive().safe().optional(),
});

export const toolItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal("tool"),
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  category: z.enum(["read", "edit", "search", "execute", "fetch", "agent", "other"]),
  origin: z.enum(["provider", "mcp", "host"]),
  server: z.string().min(1).optional(),
  input: jsonValueSchema.optional(),
  output: z.array(contentBlockSchema).optional(),
  structuredOutput: jsonValueSchema.optional(),
  locations: z.array(toolLocationSchema).optional(),
  terminalItemId: opaqueIdSchema.optional(),
});

export const terminalItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal("terminal"),
  command: z.string().optional(),
  cwd: z.string().min(1).optional(),
  stdout: z.array(contentBlockSchema),
  stderr: z.array(contentBlockSchema),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().min(1).nullable().optional(),
});

export const fileChangeSchema = z
  .strictObject({
    operation: z.enum(["create", "update", "delete", "move"]),
    path: z.string().min(1),
    oldPath: z.string().min(1).optional(),
    diff: contentBlockSchema.optional(),
  })
  .superRefine((change, context) => {
    if ((change.operation === "move") !== (change.oldPath !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "oldPath must be present exactly for a move operation.",
        path: ["oldPath"],
        input: change,
      });
    }
  });

export const changeItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal("change"),
  changes: z.array(fileChangeSchema),
});

export const artifactItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal("artifact"),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  content: z.array(contentBlockSchema).min(1),
});

export const extensionItemSchema = z.strictObject({
  ...itemBase,
  kind: z.literal("extension"),
  name: extensionNameSchema,
  value: jsonValueSchema,
});

export const itemSchema = z
  .discriminatedUnion("kind", [
    messageItemSchema,
    reasoningItemSchema,
    planItemSchema,
    toolItemSchema,
    terminalItemSchema,
    changeItemSchema,
    artifactItemSchema,
    extensionItemSchema,
  ])
  .superRefine((item, context) => {
    const terminal = item.status !== "active";

    if (terminal !== (item.endedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "endedAt must be present exactly when an item is terminal.",
        path: ["endedAt"],
        input: item,
      });
    }

    if ((item.status === "failed") !== (item.error !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "error must be present exactly when an item has failed.",
        path: ["error"],
        input: item,
      });
    }
  });

export type MessageItem = z.infer<typeof messageItemSchema>;
export type ReasoningItem = z.infer<typeof reasoningItemSchema>;
export type PlanEntry = z.infer<typeof planEntrySchema>;
export type PlanItem = z.infer<typeof planItemSchema>;
export type ToolItem = z.infer<typeof toolItemSchema>;
export type TerminalItem = z.infer<typeof terminalItemSchema>;
export type FileChange = z.infer<typeof fileChangeSchema>;
export type ChangeItem = z.infer<typeof changeItemSchema>;
export type ArtifactItem = z.infer<typeof artifactItemSchema>;
export type ExtensionItem = z.infer<typeof extensionItemSchema>;
export type Item = z.infer<typeof itemSchema>;
export type ItemKind = Item["kind"];

export const permissionOptionSchema = z.strictObject({
  id: opaqueIdSchema,
  label: z.string().min(1),
  description: z.string().optional(),
  effect: z.enum(["allow", "deny"]),
  scope: z.enum(["once", "session"]),
  extensions: extensionsSchema.optional(),
});

const permissionSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("item"), itemId: opaqueIdSchema }),
  z.strictObject({
    type: z.literal("resource"),
    operation: z.string().min(1),
    targets: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    type: z.literal("extension"),
    name: extensionNameSchema,
    value: jsonValueSchema,
  }),
]);

const inputQuestionBase = {
  id: opaqueIdSchema,
  prompt: z.string().min(1),
  required: z.boolean(),
} as const;

export const inputQuestionSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...inputQuestionBase, type: z.literal("text") }),
  z.strictObject({ ...inputQuestionBase, type: z.literal("secret") }),
  z.strictObject({ ...inputQuestionBase, type: z.literal("confirm") }),
  z.strictObject({
    ...inputQuestionBase,
    type: z.literal("single_select"),
    options: z.array(selectChoiceSchema).min(1),
    allowOther: z.boolean().optional(),
  }),
  z.strictObject({
    ...inputQuestionBase,
    type: z.literal("multi_select"),
    options: z.array(selectChoiceSchema).min(1),
    allowOther: z.boolean().optional(),
  }),
]);

const interactionBase = {
  id: protocolIdSchema,
  runId: protocolIdSchema,
  itemId: opaqueIdSchema.optional(),
  status: z.enum(["open", "resolved", "expired"]),
  blocking: z.boolean(),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  audience: audienceSchema,
  provenance: provenanceSchema.optional(),
  extensions: extensionsSchema.optional(),
} as const;

export const permissionInteractionSchema = z.strictObject({
  ...interactionBase,
  kind: z.literal("permission"),
  request: z.strictObject({
    title: z.string().min(1),
    description: z.string().optional(),
    subject: permissionSubjectSchema,
    options: z.array(permissionOptionSchema).min(1),
  }),
  resolution: permissionResolutionSchema.optional(),
});

export const inputInteractionSchema = z.strictObject({
  ...interactionBase,
  kind: z.literal("input"),
  request: z.strictObject({ questions: z.array(inputQuestionSchema).min(1) }),
  resolution: z
    .discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("answered"),
        answeredQuestionIds: z.array(opaqueIdSchema),
      }),
      z.strictObject({ type: z.literal("cancelled") }),
    ])
    .optional(),
});

export const toolInteractionSchema = z.strictObject({
  ...interactionBase,
  kind: z.literal("tool"),
  request: z.strictObject({
    name: z.string().min(1),
    input: jsonValueSchema.optional(),
  }),
  resolution: toolResolutionSchema.optional(),
});

export const extensionInteractionSchema = z.strictObject({
  ...interactionBase,
  kind: z.literal("extension"),
  name: extensionNameSchema,
  request: jsonValueSchema,
  resolution: jsonValueSchema.optional(),
});

export const interactionSchema = z
  .discriminatedUnion("kind", [
    permissionInteractionSchema,
    inputInteractionSchema,
    toolInteractionSchema,
    extensionInteractionSchema,
  ])
  .superRefine((interaction, context) => {
    const resolved = interaction.status === "resolved";

    if (resolved !== (interaction.resolution !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "resolution must be present exactly when an interaction is resolved.",
        path: ["resolution"],
        input: interaction,
      });
    }

    if ((interaction.status !== "open") !== (interaction.endedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "endedAt must be present exactly when an interaction is terminal.",
        path: ["endedAt"],
        input: interaction,
      });
    }
  });

export type PermissionOption = z.infer<typeof permissionOptionSchema>;
export type InputQuestion = z.infer<typeof inputQuestionSchema>;
export type PermissionInteraction = z.infer<typeof permissionInteractionSchema>;
export type InputInteraction = z.infer<typeof inputInteractionSchema>;
export type ToolInteraction = z.infer<typeof toolInteractionSchema>;
export type ExtensionInteraction = z.infer<typeof extensionInteractionSchema>;
export type Interaction = z.infer<typeof interactionSchema>;
export type InteractionKind = Interaction["kind"];

export const sessionSnapshotSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  revision: revisionSchema,
  capturedAt: timestampSchema,
  session: sessionSchema,
  runs: z.array(runSchema),
  items: z.array(itemSchema),
  interactions: z.array(interactionSchema),
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
