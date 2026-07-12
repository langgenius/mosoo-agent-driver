/**
 * Driver Contract v2 — the canonical agent-session event/command contract.
 * Spec: docs/contract.md. Replaces the 2026-05-26 runtime-event generation;
 * the old modules remain wired until kernel/backends/host migrate.
 */

/**
 * Single integer, bumped only for breaking changes. Additions ride on
 * capabilities: absence of a capability key means unsupported.
 */
export const CONTRACT_VERSION = 2 as const;

/**
 * Capability advertisement: key → open detail object (ACP v2 style object
 * markers — presence means supported, details may grow without breakage).
 */
export type SessionCapabilities = Record<string, Record<string, unknown>>;

/** Capability keys with real variance across today's backends. */
export const KNOWN_CAPABILITY_KEYS = [
  "input.request",
  "item.delta",
  "mcp.execute",
  "native_resume",
  "permission.request",
  "session.config.set",
  "turn.steer",
] as const;
export type KnownCapabilityKey = (typeof KNOWN_CAPABILITY_KEYS)[number];

export {
  audioContentSchema,
  contentBlockSchema,
  contentBlockText,
  imageContentSchema,
  metaSchema,
  openEnum,
  resourceContentSchema,
  resourceLinkContentSchema,
  textContentSchema,
} from "./content";
export type {
  AudioContent,
  ContentBlock,
  ImageContent,
  OpenEnum,
  ResourceContent,
  ResourceLinkContent,
  TextContent,
} from "./content";

export {
  ITEM_STATUSES,
  applySessionItemPatch,
  commandActionSchema,
  commandItemSchema,
  extensionItemSchema,
  fileChangeItemSchema,
  fileChangeSchema,
  itemIdSchema,
  messageItemSchema,
  parseSessionItem,
  parseSessionItemPatch,
  planEntrySchema,
  planItemSchema,
  reasoningItemSchema,
  sessionErrorSchema,
  sessionItemSchema,
  toolCallItemSchema,
  toolCallLocationSchema,
  toolCallOutputSchema,
} from "./item";
export type {
  CommandAction,
  CommandItem,
  ExtensionItem,
  FileChange,
  FileChangeItem,
  ItemStatus,
  MessageItem,
  PlanEntry,
  PlanItem,
  ReasoningItem,
  SessionError,
  SessionItem,
  SessionItemKind,
  SessionItemPatch,
  ToolCallItem,
  ToolCallOutput,
} from "./item";

export {
  ITEM_DELTA_STREAMS,
  SESSION_EVENT_KINDS,
  SESSION_EVENT_PAYLOAD_SCHEMAS,
  TURN_STOP_REASONS,
  admitSessionEvent,
  availableCommandSchema,
  createSessionEventFactory,
  deliveryOf,
  inputOutcomeSchema,
  inputQuestionSchema,
  isKnownSessionEventKind,
  nativeRefSchema,
  parseSessionEvent,
  permissionDetailSchema,
  permissionOptionSchema,
  permissionOutcomeSchema,
  sessionConfigOptionSchema,
  tokenUsageSchema,
  visibilityOf,
} from "./event";
export type {
  AvailableCommand,
  InputOutcome,
  InputQuestion,
  ItemDeltaStream,
  KnownSessionEventKind,
  NativeRef,
  PermissionDetail,
  PermissionOption,
  PermissionOutcome,
  SessionConfigOption,
  SessionEvent,
  SessionEventFactory,
  SessionEventFactoryOptions,
  SessionEventIngress,
  SessionEventInit,
  SessionEventKind,
  SessionEventPayload,
  SessionEventPayloadMap,
  TokenUsage,
  TurnStopReason,
} from "./event";

export {
  commandUpdateSchema,
  parseCommandUpdate,
  parseSessionCommand,
  sessionCommandSchema,
} from "./command";
export type {
  CommandUpdate,
  McpExecuteResult,
  SessionCommand,
  SessionCommandKind,
  SessionCommandOf,
} from "./command";

export { coalesceSessionEvents, createSessionEventBuffer, isCoalescibleKind } from "./buffer";
export type { SessionEventBuffer, SessionEventBufferOptions } from "./buffer";
