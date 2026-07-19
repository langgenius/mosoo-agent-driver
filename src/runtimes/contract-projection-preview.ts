import { compareTimestamps, itemSchema } from "../contract";
import type {
  ContentBlock,
  Item,
  MutationCause,
  PreviewUpdate,
  ProtocolAdmissionLimits,
} from "../contract";
import type { ContractAuthorityUpdate } from "./contract-projection-authority";

export interface ContractPreviewUpdate {
  readonly runId: string;
  readonly sessionId: string;
  readonly update: PreviewUpdate;
}

export interface ContractProjectionOptions {
  readonly admissionLimits?: ProtocolAdmissionLimits | undefined;
  readonly authority: (update: ContractAuthorityUpdate) => Promise<void>;
  readonly now?: (() => Date) | undefined;
  readonly preview: (update: ContractPreviewUpdate) => void;
  readonly previewCheckpointBytes?: number | undefined;
  readonly previewReplaceIntervalMs?: number | undefined;
  readonly sessionId: string;
}

export function emitContractPreview(
  preview: ContractProjectionOptions["preview"],
  runId: string,
  sessionId: string,
  update: PreviewUpdate,
): void {
  try {
    preview({ runId, sessionId, update });
  } catch {
    // Preview is best-effort; retained state repairs a dropped callback.
  }
}

export const DEFAULT_PREVIEW_CHECKPOINT_BYTES = 128 * 1_024;
export const DEFAULT_PREVIEW_REPLACE_INTERVAL_MS = 1_000;

export interface PreviewStreamState {
  bytes: number;
  lastReplaceAtMs: number;
  mode: "append" | "replace";
  segment: number;
  sequence: number;
  text: string;
}

export type TextPreviewChannel =
  | "message.text"
  | "reasoning.text"
  | "terminal.stderr"
  | "terminal.stdout";

export interface AppendTextInput {
  readonly cause: MutationCause;
  readonly channel: TextPreviewChannel;
  readonly delta: string;
  readonly event: string;
  readonly itemId: string;
  readonly runId: string;
}

export interface CheckpointTextInput {
  readonly cause: MutationCause;
  readonly channel: TextPreviewChannel;
  readonly event: string;
  readonly itemId: string;
  readonly runId: string;
}

export interface ReplacePreviewInput {
  readonly channel: PreviewUpdate["channel"];
  readonly itemId: string;
  readonly runId: string;
  readonly text: string;
}

export function itemKey(runId: string, itemId: string): string {
  return `${runId}\u0000${itemId}`;
}

export function streamKey(runId: string, itemId: string, channel: string): string {
  return `${itemKey(runId, itemId)}\u0000${channel}`;
}

export function replaceCheckpointCause(
  runId: string,
  itemId: string,
  segment: number,
): MutationCause {
  return {
    providerEventId: `preview/replace:${runId}:${segment}:${itemId}`.slice(0, 256),
    type: "provider",
  };
}

export function latestTimestamp(previous: string, next: string): string {
  return compareTimestamps(previous, next) > 0 ? previous : next;
}

function textContent(text: string): ContentBlock[] {
  return text.length === 0 ? [] : [{ text, type: "text" }];
}

export function appendItemText(
  item: Item,
  channel: TextPreviewChannel,
  text: string,
  updatedAt: string,
): Item {
  if (item.kind === "message" && channel === "message.text") {
    return itemSchema.parse({
      ...item,
      content: [...item.content, ...textContent(text)],
      updatedAt: latestTimestamp(item.updatedAt, updatedAt),
    });
  }

  if (item.kind === "reasoning" && channel === "reasoning.text") {
    return itemSchema.parse({
      ...item,
      content: [...item.content, ...textContent(text)],
      updatedAt: latestTimestamp(item.updatedAt, updatedAt),
    });
  }

  if (item.kind === "terminal" && channel === "terminal.stdout") {
    return itemSchema.parse({
      ...item,
      stdout: [...item.stdout, ...textContent(text)],
      updatedAt: latestTimestamp(item.updatedAt, updatedAt),
    });
  }

  if (item.kind === "terminal" && channel === "terminal.stderr") {
    return itemSchema.parse({
      ...item,
      stderr: [...item.stderr, ...textContent(text)],
      updatedAt: latestTimestamp(item.updatedAt, updatedAt),
    });
  }

  return item;
}

export function advancePreviews(
  previews: Map<string, PreviewStreamState>,
  runId: string,
  itemId: string,
  atMs: number,
): void {
  const prefix = `${itemKey(runId, itemId)}\u0000`;

  for (const [key, preview] of previews) {
    if (!key.startsWith(prefix)) {
      continue;
    }

    previews.set(key, {
      bytes: 0,
      lastReplaceAtMs: atMs,
      mode: preview.mode,
      segment: preview.segment + 1,
      sequence: 0,
      text: "",
    });
  }
}

export function flushItemText(
  previews: ReadonlyMap<string, PreviewStreamState>,
  item: Item,
  updatedAt: string,
): Item {
  let next = item;

  for (const channel of [
    "message.text",
    "reasoning.text",
    "terminal.stdout",
    "terminal.stderr",
  ] as const) {
    const preview = previews.get(streamKey(item.runId, item.id, channel));
    if (preview?.mode === "replace" && preview.sequence > 0) {
      next = replaceItemText(next, channel, preview.text, updatedAt);
    } else if (preview?.text !== undefined && preview.text.length > 0) {
      next = appendItemText(next, channel, preview.text, updatedAt);
    }
  }

  return next;
}

export function replaceItemText(
  item: Item,
  channel: TextPreviewChannel,
  text: string,
  updatedAt: string,
): Item {
  if (item.kind === "terminal" && channel === "terminal.stdout") {
    return itemSchema.parse({
      ...item,
      stdout: textContent(text),
      updatedAt: latestTimestamp(item.updatedAt, updatedAt),
    });
  }

  if (item.kind === "terminal" && channel === "terminal.stderr") {
    return itemSchema.parse({
      ...item,
      stderr: textContent(text),
      updatedAt: latestTimestamp(item.updatedAt, updatedAt),
    });
  }

  return appendItemText(item, channel, text, updatedAt);
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  return new TextDecoder().decode(encoded.subarray(0, maxBytes), { stream: true });
}

export function itemText(item: Item, channel: TextPreviewChannel): string {
  if (item.kind === "message" && channel === "message.text") {
    return item.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  }

  if (item.kind === "reasoning" && channel === "reasoning.text") {
    return item.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  }

  if (item.kind === "terminal" && channel === "terminal.stdout") {
    return item.stdout.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  }

  if (item.kind === "terminal" && channel === "terminal.stderr") {
    return item.stderr.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  }

  return "";
}

export function matchesPreviewChannel(item: Item, channel: PreviewUpdate["channel"]): boolean {
  switch (channel) {
    case "message.text":
      return item.kind === "message";
    case "reasoning.text":
      return item.kind === "reasoning";
    case "terminal.stderr":
    case "terminal.stdout":
      return item.kind === "terminal";
    case "tool.progress":
      return item.kind === "tool";
    default:
      return true;
  }
}
