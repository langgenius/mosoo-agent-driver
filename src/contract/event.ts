import { z } from "zod";

import { metaSchema, openEnum } from "./content";
import type { OpenEnum } from "./content";
import { itemIdSchema, sessionErrorSchema, sessionItemSchema } from "./item";
import { parseSessionItemPatch } from "./item";

const ulid = z.ulid();
const isoTime = z.iso.datetime({ offset: true });
const requestId = z.string().min(1);

/** Provenance pointer back to the native provider event. */
export const nativeRefSchema = z.looseObject({
  provider: z.string().min(1),
  eventName: z.string().optional(),
  itemId: z.string().optional(),
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  requestId: z.string().optional(),
  sequence: z.number().optional(),
});
export type NativeRef = z.infer<typeof nativeRefSchema>;

// --- session plane ---

const sessionStartedPayload = z.looseObject({
  resumed: z.boolean(),
  /** Native session handle the host persists for future resume. */
  nativeSessionRef: z
    .looseObject({ provider: z.string().min(1), ref: z.string().min(1) })
    .nullable()
    .optional(),
});

const sessionInfoUpdatedPayload = z.looseObject({
  title: z.string().nullable().optional(),
});

/** ACP v2 SessionConfigOption (select/boolean + open). */
const configOptionBase = {
  configId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  category: openEnum(["mode", "model", "model_config", "thought_level"]).optional(),
  meta: metaSchema.optional(),
};

export const sessionConfigOptionSchema = z.union([
  z.looseObject({
    ...configOptionBase,
    type: z.literal("select"),
    currentValueId: z.string().min(1),
    options: z.array(
      z.looseObject({
        valueId: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
      }),
    ),
  }),
  z.looseObject({ ...configOptionBase, type: z.literal("boolean"), currentValue: z.boolean() }),
  z.looseObject({ ...configOptionBase, type: z.string().min(1) }),
]);
export type SessionConfigOption = z.infer<typeof sessionConfigOptionSchema>;

const sessionConfigUpdatedPayload = z.looseObject({
  options: z.array(sessionConfigOptionSchema),
});

export const availableCommandSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  inputHint: z.string().nullable().optional(),
});
export type AvailableCommand = z.infer<typeof availableCommandSchema>;

const sessionCommandsUpdatedPayload = z.looseObject({
  commands: z.array(availableCommandSchema),
});

export const tokenUsageSchema = z.looseObject({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative().optional(),
  output: z.number().nonnegative(),
  reasoningOutput: z.number().nonnegative().optional(),
  total: z.number().nonnegative(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

const usageUpdatedPayload = z.looseObject({
  /** Session-cumulative usage (Codex total / ACP used). */
  tokens: tokenUsageSchema.optional(),
  /** Most recent model call (Codex last). */
  lastTokens: tokenUsageSchema.optional(),
  context: z
    .looseObject({
      usedTokens: z.number().nonnegative(),
      maxTokens: z.number().positive().optional(),
    })
    .optional(),
  cost: z.looseObject({ amount: z.number().nonnegative(), currency: z.string().min(1) }).optional(),
});

// --- turn plane ---

const turnStartedPayload = z.looseObject({});

export const TURN_STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "max_turns",
  "refusal",
  "cancelled",
] as const;
export type TurnStopReason = OpenEnum<(typeof TURN_STOP_REASONS)[number]>;

const turnCompletedPayload = z
  .looseObject({
    status: z.enum(["completed", "cancelled", "failed"]),
    stopReason: openEnum(TURN_STOP_REASONS).optional(),
    error: sessionErrorSchema.nullable().optional(),
  })
  .refine((payload) => payload.status !== "failed" || payload.error != null, {
    message: "turn.completed with status failed requires error",
  });

// --- item plane ---

const itemStartedPayload = z.looseObject({ item: sessionItemSchema });
const itemCompletedPayload = z.looseObject({ item: sessionItemSchema });

const itemUpdatedPayload = z
  .looseObject({
    itemId: itemIdSchema,
    kind: z.string().min(1),
    patch: metaSchema,
  })
  .transform((payload, ctx) => {
    try {
      return { ...payload, patch: parseSessionItemPatch(payload.kind, payload.patch) };
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid item patch",
        input: payload.patch,
        path: ["patch"],
      });
      return z.NEVER;
    }
  });

export const ITEM_DELTA_STREAMS = ["text", "reasoning", "reasoning_summary", "output"] as const;
export type ItemDeltaStream = OpenEnum<(typeof ITEM_DELTA_STREAMS)[number]>;

const itemDeltaPayload = z.looseObject({
  itemId: itemIdSchema,
  stream: openEnum(ITEM_DELTA_STREAMS),
  /** Parallel part index (Codex reasoning summaryIndex/contentIndex). */
  index: z.number().int().nonnegative().optional(),
  delta: z.string(),
});

// --- interaction plane ---

export const permissionOptionSchema = z.looseObject({
  optionId: z.string().min(1),
  name: z.string().min(1),
  kind: openEnum(["allow_once", "allow_always", "reject_once", "reject_always"]),
  meta: metaSchema.optional(),
});
export type PermissionOption = z.infer<typeof permissionOptionSchema>;

/** Typed subject so hosts can render rich approval prompts (Codex-grade detail). */
export const permissionDetailSchema = z.union([
  z.looseObject({
    type: z.literal("command"),
    command: z.string(),
    cwd: z.string().optional(),
    reason: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("file_change"),
    changes: z.array(z.looseObject({ path: z.string().min(1), op: z.string().optional() })),
    reason: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("tool_call"),
    name: z.string().min(1),
    server: z.string().optional(),
    input: z.unknown().optional(),
  }),
  z.looseObject({ type: z.string().min(1) }),
]);
export type PermissionDetail = z.infer<typeof permissionDetailSchema>;

const permissionRequestedPayload = z.looseObject({
  requestId,
  itemId: itemIdSchema.optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  options: z.array(permissionOptionSchema).min(1),
  detail: permissionDetailSchema.optional(),
  expiresAt: isoTime.optional(),
});

/**
 * Open outcome union. Receivers that do not understand an outcome MUST treat
 * it as a rejection, never an approval.
 */
export const permissionOutcomeSchema = z.union([
  z.looseObject({ type: z.literal("selected"), optionId: z.string().min(1) }),
  z.looseObject({ type: z.literal("cancelled") }),
  z.looseObject({ type: z.literal("timeout") }),
  z.looseObject({ type: z.string().min(1) }),
]);
export type PermissionOutcome = z.infer<typeof permissionOutcomeSchema>;

const permissionResolvedPayload = z.looseObject({
  requestId,
  outcome: permissionOutcomeSchema,
});

export const inputQuestionSchema = z.looseObject({
  questionId: z.string().min(1),
  question: z.string().min(1),
  header: z.string().optional(),
  options: z
    .array(z.looseObject({ label: z.string().min(1), description: z.string().optional() }))
    .optional(),
  allowFreeform: z.boolean().optional(),
  secret: z.boolean().optional(),
});
export type InputQuestion = z.infer<typeof inputQuestionSchema>;

const inputRequestedPayload = z.looseObject({
  requestId,
  itemId: itemIdSchema.optional(),
  questions: z.array(inputQuestionSchema).min(1),
  expiresAt: isoTime.optional(),
});

export const inputOutcomeSchema = z.union([
  z.looseObject({
    type: z.literal("answered"),
    answers: z.record(z.string(), z.array(z.string())),
  }),
  z.looseObject({ type: z.literal("cancelled") }),
  z.looseObject({ type: z.string().min(1) }),
]);
export type InputOutcome = z.infer<typeof inputOutcomeSchema>;

const inputResolvedPayload = z.looseObject({
  requestId,
  outcome: inputOutcomeSchema,
});

// --- ops plane ---

const diagnosticReportedPayload = z.looseObject({
  severity: z.enum(["info", "warning", "error"]),
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean().optional(),
  itemId: itemIdSchema.optional(),
  detail: metaSchema.optional(),
});

const timingRecordedPayload = z.looseObject({
  stage: z.string().min(1),
  path: openEnum(["cold", "warm", "prewarm", "unknown"]).optional(),
  startedAtMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative(),
  phases: z.array(z.looseObject({ name: z.string().min(1), durationMs: z.number().nonnegative() })),
});

// --- registry ---

export const SESSION_EVENT_PAYLOAD_SCHEMAS = {
  "diagnostic.reported": diagnosticReportedPayload,
  "input.requested": inputRequestedPayload,
  "input.resolved": inputResolvedPayload,
  "item.completed": itemCompletedPayload,
  "item.delta": itemDeltaPayload,
  "item.started": itemStartedPayload,
  "item.updated": itemUpdatedPayload,
  "permission.requested": permissionRequestedPayload,
  "permission.resolved": permissionResolvedPayload,
  "session.commands.updated": sessionCommandsUpdatedPayload,
  "session.config.updated": sessionConfigUpdatedPayload,
  "session.info.updated": sessionInfoUpdatedPayload,
  "session.started": sessionStartedPayload,
  "timing.recorded": timingRecordedPayload,
  "turn.completed": turnCompletedPayload,
  "turn.started": turnStartedPayload,
  "usage.updated": usageUpdatedPayload,
} as const;

export const SESSION_EVENT_KINDS = Object.keys(SESSION_EVENT_PAYLOAD_SCHEMAS).toSorted() as [
  KnownSessionEventKind,
  ...KnownSessionEventKind[],
];

export type KnownSessionEventKind = keyof typeof SESSION_EVENT_PAYLOAD_SCHEMAS;
export type SessionEventKind = OpenEnum<KnownSessionEventKind>;

export type SessionEventPayloadMap = {
  [K in KnownSessionEventKind]: z.output<(typeof SESSION_EVENT_PAYLOAD_SCHEMAS)[K]>;
};

export type SessionEventPayload<K extends SessionEventKind> = K extends KnownSessionEventKind
  ? SessionEventPayloadMap[K]
  : Record<string, unknown>;

export interface SessionEvent<K extends SessionEventKind = SessionEventKind> {
  readonly id: string;
  /** Per-session monotonic counter assigned by the emitter. */
  readonly seq: number;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly at: string;
  readonly kind: K;
  readonly payload: SessionEventPayload<K>;
  readonly native?: NativeRef | undefined;
  readonly traceId?: string | undefined;
  readonly meta?: Record<string, unknown> | undefined;
}

const eventEnvelopeSchema = z.looseObject({
  id: ulid,
  seq: z.number().int().nonnegative(),
  sessionId: ulid,
  turnId: ulid.optional(),
  at: isoTime,
  kind: z.string().min(1),
  payload: z.unknown(),
  native: nativeRefSchema.optional(),
  traceId: z.string().min(1).optional(),
  meta: metaSchema.optional(),
});

/** Turn-scoped kinds require `turnId` on the envelope. */
const TURN_SCOPED_KINDS: ReadonlySet<string> = new Set([
  "item.completed",
  "item.delta",
  "item.started",
  "item.updated",
  "permission.requested",
  "permission.resolved",
  "turn.completed",
  "turn.started",
] satisfies KnownSessionEventKind[]);

export function isKnownSessionEventKind(kind: string): kind is KnownSessionEventKind {
  return kind in SESSION_EVENT_PAYLOAD_SCHEMAS;
}

/**
 * Strict on known kinds, open on unknown kinds: an unknown `kind` (extension
 * `x_*` or a future contract version) passes envelope validation with a
 * record payload and flows through pipelines untouched.
 */
export function parseSessionEvent(value: unknown): SessionEvent {
  const envelope = eventEnvelopeSchema.parse(value);

  if (TURN_SCOPED_KINDS.has(envelope.kind) && envelope.turnId === undefined) {
    throw new Error(`Session event ${envelope.kind} requires turnId.`);
  }

  const schema = isKnownSessionEventKind(envelope.kind)
    ? SESSION_EVENT_PAYLOAD_SCHEMAS[envelope.kind]
    : metaSchema;
  return { ...envelope, payload: schema.parse(envelope.payload) };
}

export type SessionEventIngress =
  | { readonly status: "accepted"; readonly event: SessionEvent }
  | {
      readonly status: "rejected";
      readonly reason: { readonly code: "malformed_event"; readonly message: string };
    };

/** Non-throwing ingress for network boundaries. */
export function admitSessionEvent(value: unknown): SessionEventIngress {
  try {
    return { status: "accepted", event: parseSessionEvent(value) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "session event is malformed";
    return { status: "rejected", reason: { code: "malformed_event", message } };
  }
}

// --- classification (static functions of kind, not wire fields) ---

/** Only deltas are droppable: the item.completed snapshot heals missed deltas. */
export function deliveryOf(kind: SessionEventKind): "best_effort" | "lossless" {
  return kind === "item.delta" ? "best_effort" : "lossless";
}

export function visibilityOf(kind: SessionEventKind): "owner_debug" | "participant" {
  return kind === "diagnostic.reported" || kind === "timing.recorded"
    ? "owner_debug"
    : "participant";
}

// --- emitter ---

export interface SessionEventFactoryOptions {
  readonly sessionId: string;
  readonly createId: () => string;
  readonly traceId?: string | undefined;
}

export interface SessionEventInit {
  readonly turnId?: string | undefined;
  readonly at?: string | undefined;
  readonly native?: NativeRef | undefined;
  readonly meta?: Record<string, unknown> | undefined;
}

export interface SessionEventFactory {
  emit<K extends SessionEventKind>(
    kind: K,
    payload: SessionEventPayload<K>,
    init?: SessionEventInit,
  ): SessionEvent<K>;
}

/** Emitter-side constructor: assigns id/seq/at and validates the payload. */
export function createSessionEventFactory(
  options: SessionEventFactoryOptions,
): SessionEventFactory {
  let seq = 0;

  return {
    emit(kind, payload, init = {}) {
      const event = {
        id: options.createId(),
        seq: seq++,
        sessionId: options.sessionId,
        ...(init.turnId === undefined ? {} : { turnId: init.turnId }),
        at: init.at ?? new Date().toISOString(),
        kind,
        payload,
        ...(init.native === undefined ? {} : { native: init.native }),
        ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
        ...(init.meta === undefined ? {} : { meta: init.meta }),
      };
      return parseSessionEvent(event) as SessionEvent<typeof kind>;
    },
  };
}
