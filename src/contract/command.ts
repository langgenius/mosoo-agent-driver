import { z } from "zod";

import { contentBlockSchema, metaSchema } from "./content";
import { inputOutcomeSchema, permissionOutcomeSchema } from "./event";
import { sessionErrorSchema, toolCallOutputSchema } from "./item";

const ulid = z.ulid();
const requestId = z.string().min(1);

/**
 * Host → driver commands. Flat discriminated union: commands are few, small,
 * and host-issued (ids are ULIDs). The command set is closed per contract
 * version — a driver must reject kinds it does not know.
 */
const turnInput = z.array(contentBlockSchema).min(1);

export const sessionCommandSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("turn.start"),
    id: ulid,
    turnId: ulid,
    input: turnInput,
    meta: metaSchema.optional(),
  }),
  z.looseObject({
    kind: z.literal("turn.steer"),
    id: ulid,
    turnId: ulid,
    input: turnInput,
    meta: metaSchema.optional(),
  }),
  z.looseObject({
    kind: z.literal("turn.cancel"),
    id: ulid,
    turnId: ulid.optional(),
    reason: z.string().optional(),
    meta: metaSchema.optional(),
  }),
  z.looseObject({
    kind: z.literal("session.stop"),
    id: ulid,
    reason: z.string().min(1),
    meta: metaSchema.optional(),
  }),
  z.looseObject({
    kind: z.literal("session.config.set"),
    id: ulid,
    configId: z.string().min(1),
    value: z.union([
      z.looseObject({ type: z.literal("select"), valueId: z.string().min(1) }),
      z.looseObject({ type: z.literal("boolean"), value: z.boolean() }),
      z.looseObject({ type: z.string().min(1) }),
    ]),
    meta: metaSchema.optional(),
  }),
  z.looseObject({
    kind: z.literal("permission.resolve"),
    id: ulid,
    requestId,
    outcome: permissionOutcomeSchema,
    meta: metaSchema.optional(),
  }),
  z.looseObject({
    kind: z.literal("input.resolve"),
    id: ulid,
    requestId,
    outcome: inputOutcomeSchema,
    meta: metaSchema.optional(),
  }),
  z.looseObject({
    kind: z.literal("mcp.execute"),
    id: ulid,
    requestId,
    serverId: z.string().min(1),
    toolName: z.string().min(1),
    arguments: metaSchema,
    meta: metaSchema.optional(),
  }),
]);

export type SessionCommand = z.infer<typeof sessionCommandSchema>;
export type SessionCommandKind = SessionCommand["kind"];
export type SessionCommandOf<K extends SessionCommandKind> = Extract<SessionCommand, { kind: K }>;

export function parseSessionCommand(value: unknown): SessionCommand {
  return sessionCommandSchema.parse(value);
}

/** mcp.execute produces an MCP-shaped tool output; other commands none. */
export type McpExecuteResult = z.infer<typeof toolCallOutputSchema>;

/**
 * Command fate, reported by the driver: accepted → completed | failed |
 * cancelled. Host-side queueing states are host bookkeeping, not contract.
 */
export const commandUpdateSchema = z
  .looseObject({
    commandId: ulid,
    status: z.enum(["accepted", "completed", "failed", "cancelled"]),
    error: sessionErrorSchema.optional(),
    result: toolCallOutputSchema.optional(),
  })
  .refine((update) => update.status !== "failed" || update.error !== undefined, {
    message: "failed command update requires error",
  });

export type CommandUpdate = z.infer<typeof commandUpdateSchema>;

export function parseCommandUpdate(value: unknown): CommandUpdate {
  return commandUpdateSchema.parse(value);
}
