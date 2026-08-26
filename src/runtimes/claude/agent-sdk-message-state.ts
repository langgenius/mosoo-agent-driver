import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { MessageId, RunId } from "../../protocol/id";
import { RuntimeAssistantMessageIdIndex } from "../runtime-turn-transcript";
import { isRecord, readRecord, readString } from "./agent-sdk-json";

interface ClaudeAssistantFinalCandidate {
  readonly id: MessageId;
  readonly ordinal: number;
}

interface ClaudeStreamMessageAnchor {
  /**
   * True when the anchor came from a message_start frame carrying the native
   * message id. An unconfirmed anchor was inferred from the first streamed
   * content frame after message_start was lost, so its native key is a
   * synthetic burst key derived from that frame's envelope uuid.
   */
  readonly confirmed: boolean;
  readonly nativeId: string;
}

// Envelope uuids are per-frame, so a burst key must never collide with a
// native id a later assistant envelope could present on its own.
function toStreamBurstNativeId(nativeMessageId: string): string {
  return `stream-burst:${nativeMessageId}`;
}

function toClaudeThoughtId(messageId: string): string {
  return `${messageId}:thought`;
}

export function readClaudeSdkSessionId(value: unknown): string | null {
  const record = isRecord(value) ? value : null;
  return readString(record, "session_id");
}

export class ClaudeAgentSdkMessageState {
  readonly #activeAssistantMessageIds = new Map<RunId, MessageId>();
  readonly #activeThoughtIds = new Map<string, string>();
  readonly #auxiliaryMessageIds = new RuntimeAssistantMessageIdIndex<string>();
  readonly #authoritativeAssistantMessageIds = new Set<MessageId>();
  readonly #assistantMessageIds = new RuntimeAssistantMessageIdIndex<string>();
  readonly #assistantMessageOrdinals = new Map<MessageId, number>();
  readonly #assistantMessageRunIds = new Map<MessageId, RunId>();
  readonly #assistantMessageSequences = new Map<RunId, number>();
  readonly #blockToolCallIds = new Map<string, Map<number, string>>();
  readonly #assistantWireAliases = new Map<string, string>();
  readonly #lastCompletedAssistantMessages = new Map<RunId, ClaudeAssistantFinalCandidate>();
  readonly #pendingAssistantStreamAnchors = new Map<string, ClaudeStreamMessageAnchor>();
  readonly #streamedTextMessages = new Set<string>();
  readonly #streamingNativeMessageIds = new Map<string, ClaudeStreamMessageAnchor>();
  readonly #streamingWireUuids = new Map<string, string>();
  readonly #textByAssistantMessageId = new Map<MessageId, string>();
  readonly #wireAssistantMessageIds = new Map<string, MessageId>();
  readonly #wireToolCallIds = new Map<string, readonly string[]>();

  reset(): void {
    this.#activeAssistantMessageIds.clear();
    this.#activeThoughtIds.clear();
    this.#auxiliaryMessageIds.reset();
    this.#assistantWireAliases.clear();
    this.#authoritativeAssistantMessageIds.clear();
    this.#assistantMessageIds.reset();
    this.#assistantMessageOrdinals.clear();
    this.#assistantMessageRunIds.clear();
    this.#assistantMessageSequences.clear();
    this.#blockToolCallIds.clear();
    this.#lastCompletedAssistantMessages.clear();
    this.#pendingAssistantStreamAnchors.clear();
    this.#streamedTextMessages.clear();
    this.#streamingNativeMessageIds.clear();
    this.#streamingWireUuids.clear();
    this.#textByAssistantMessageId.clear();
    this.#wireAssistantMessageIds.clear();
    this.#wireToolCallIds.clear();
  }

  assistantMessageId(runId: RunId, nativeMessageId: string | null): MessageId {
    const active = this.#activeAssistantMessageIds.get(runId);
    let messageId: MessageId;

    if (nativeMessageId !== null) {
      messageId = this.#assistantMessageIds.getOrCreate(`${runId}:native:${nativeMessageId}`);
    } else if (active !== undefined) {
      messageId = active;
    } else {
      const ordinal = this.#nextAssistantMessageSequence(runId);
      messageId = this.#assistantMessageIds.getOrCreate(`${runId}:sequence:${ordinal}`);
      this.#assistantMessageOrdinals.set(messageId, ordinal);
    }

    this.#ensureAssistantMessageOrdinal(runId, messageId);
    this.#assistantMessageRunIds.set(messageId, runId);
    this.#activeAssistantMessageIds.set(runId, messageId);
    return messageId;
  }

  auxiliaryMessageId(runId: RunId, nativeMessageId: string): MessageId {
    return this.#auxiliaryMessageIds.getOrCreate(`${runId}:${nativeMessageId}`);
  }

  assistantMessages(): readonly (readonly [MessageId, RunId])[] {
    return [...this.#assistantMessageRunIds];
  }

  bindWireAssistantMessage(wireUuid: string, messageId: MessageId): void {
    this.#wireAssistantMessageIds.set(wireUuid, messageId);
  }

  bindWireToolCalls(wireUuid: string, toolCallIds: readonly string[]): void {
    if (toolCallIds.length > 0) {
      this.#wireToolCallIds.set(wireUuid, [...toolCallIds]);
    }
  }

  wireItems(wireUuid: string): {
    readonly messageId: MessageId | null;
    readonly toolCallIds: readonly string[];
  } {
    return {
      messageId: this.#wireAssistantMessageIds.get(wireUuid) ?? null,
      toolCallIds: this.#wireToolCallIds.get(wireUuid) ?? [],
    };
  }

  commitWireMessageRetraction(wireUuid: string, messageId: MessageId): void {
    if (this.#wireAssistantMessageIds.get(wireUuid) !== messageId) {
      return;
    }

    this.#wireAssistantMessageIds.delete(wireUuid);
    this.#retractAssistantMessage(messageId);
  }

  commitWireToolRetractions(wireUuid: string): void {
    this.#wireToolCallIds.delete(wireUuid);
  }

  activeAssistantMessageId(runId: RunId): MessageId | undefined {
    return this.#activeAssistantMessageIds.get(runId);
  }

  lastCompletedAssistantMessageId(runId: RunId): MessageId | undefined {
    return this.#lastCompletedAssistantMessages.get(runId)?.id;
  }

  completeAssistantMessage(runId: RunId, messageId: MessageId, ended: boolean): void {
    if (ended) {
      const ordinal = this.#requireAssistantMessageOrdinal(messageId);
      const current = this.#lastCompletedAssistantMessages.get(runId);
      if (current === undefined || ordinal > current.ordinal) {
        this.#lastCompletedAssistantMessages.set(runId, { id: messageId, ordinal });
      }
    }

    if (this.#activeAssistantMessageIds.get(runId) === messageId) {
      this.#activeAssistantMessageIds.delete(runId);
    }
  }

  appendAssistantText(messageId: MessageId, text: string): void {
    this.#textByAssistantMessageId.set(
      messageId,
      `${this.#textByAssistantMessageId.get(messageId) ?? ""}${text}`,
    );
  }

  appendStreamedText(messageId: MessageId, text: string): void {
    this.#streamedTextMessages.add(messageId);
    this.appendAssistantText(messageId, text);
  }

  hasStreamedText(messageId: MessageId): boolean {
    return this.#streamedTextMessages.has(messageId);
  }

  markAuthoritative(messageId: MessageId, text: string): void {
    this.#authoritativeAssistantMessageIds.add(messageId);
    this.#textByAssistantMessageId.set(messageId, text);
  }

  thoughtId(messageId: string): string {
    const thoughtId = this.#activeThoughtIds.get(messageId) ?? toClaudeThoughtId(messageId);
    this.#activeThoughtIds.set(messageId, thoughtId);
    return thoughtId;
  }

  activeThoughts(): readonly (readonly [string, string])[] {
    return [...this.#activeThoughtIds];
  }

  thoughtIdForMessage(messageId: string): string | undefined {
    return this.#activeThoughtIds.get(messageId);
  }

  deleteThoughtId(messageId: string): void {
    this.#activeThoughtIds.delete(messageId);
  }

  clearThoughtIds(): void {
    this.#activeThoughtIds.clear();
  }

  streamScopeKey(runId: RunId, message: SDKMessage): string {
    const parentToolUseId = isRecord(message) ? readString(message, "parent_tool_use_id") : null;
    return `${runId}:${parentToolUseId ?? "main"}`;
  }

  setStreamingNativeMessageId(scope: string, nativeMessageId: string): void {
    this.#streamingNativeMessageIds.set(scope, { confirmed: true, nativeId: nativeMessageId });
    this.#streamingWireUuids.delete(scope);
    this.#pendingAssistantStreamAnchors.delete(scope);
  }

  streamingNativeMessageId(scope: string): string | undefined {
    return this.#streamingNativeMessageIds.get(scope)?.nativeId;
  }

  /**
   * Resolves the native key for a streamed content frame. The Anthropic wire
   * carries one message per scope between message boundaries, so the first
   * content frame after a lost message_start pins the scope to a burst key
   * instead of letting every frame's envelope uuid mint a new message.
   */
  anchorStreamingNativeMessageId(scope: string, nativeMessageId: string | null): string | null {
    const anchor = this.#streamingNativeMessageIds.get(scope);

    if (anchor !== undefined) {
      return anchor.nativeId;
    }

    if (nativeMessageId === null) {
      return null;
    }

    const burstNativeId = toStreamBurstNativeId(nativeMessageId);
    this.#streamingNativeMessageIds.set(scope, { confirmed: false, nativeId: burstNativeId });
    this.#pendingAssistantStreamAnchors.delete(scope);
    return burstNativeId;
  }

  clearStreamingNativeMessageId(scope: string): void {
    const anchor = this.#streamingNativeMessageIds.get(scope);
    this.#streamingNativeMessageIds.delete(scope);
    this.#streamingWireUuids.delete(scope);

    // The aggregated assistant envelope for this burst arrives after
    // message_stop; park the anchor so that envelope can bind to the streamed
    // message instead of minting a duplicate.
    if (anchor !== undefined) {
      this.#pendingAssistantStreamAnchors.set(scope, anchor);
    }
  }

  /**
   * Resolves the native key an aggregated assistant envelope should use. An
   * unconfirmed streamed burst in the same scope is that envelope's own
   * stream (per-scope bursts are serial), so bind to it and consume the
   * anchor — one envelope aggregates one burst. A confirmed anchor proves
   * the stream's identity and the envelope's native id wins.
   */
  resolveAssistantMessageNativeId(
    scope: string,
    nativeMessageId: string | null,
    wireUuid: string,
  ): string {
    const alias = this.#assistantWireAliases.get(wireUuid);

    if (alias !== undefined) {
      return alias;
    }

    const pending = this.#pendingAssistantStreamAnchors.get(scope);

    if (pending !== undefined) {
      this.#pendingAssistantStreamAnchors.delete(scope);
      return pending.confirmed
        ? nativeMessageId === pending.nativeId
          ? this.#bindAssistantWireAlias(pending.nativeId, wireUuid)
          : wireUuid
        : this.#bindAssistantWireAlias(pending.nativeId, wireUuid);
    }

    const live = this.#streamingNativeMessageIds.get(scope);

    if (live === undefined) {
      return wireUuid;
    }

    if (live.confirmed) {
      // The envelope arrived before message_stop; keep the confirmed anchor
      // so the remaining stream frames stay on the same message.
      const boundWireUuid = this.#streamingWireUuids.get(scope);
      if (
        nativeMessageId === live.nativeId &&
        (boundWireUuid === undefined || boundWireUuid === wireUuid)
      ) {
        this.#streamingWireUuids.set(scope, wireUuid);
        return this.#bindAssistantWireAlias(live.nativeId, wireUuid);
      }
      return wireUuid;
    }

    this.#streamingNativeMessageIds.delete(scope);
    return this.#bindAssistantWireAlias(live.nativeId, wireUuid);
  }

  #bindAssistantWireAlias(burstNativeId: string, wireUuid: string): string {
    // A replayed envelope re-presents the same wire uuid after the anchor is
    // consumed; remember the binding so it stays on the same message.
    this.#assistantWireAliases.set(wireUuid, burstNativeId);
    return burstNativeId;
  }

  setToolCallId(messageId: string, index: number, toolCallId: string): void {
    const toolCallIds = this.#blockToolCallIds.get(messageId) ?? new Map<number, string>();
    toolCallIds.set(index, toolCallId);
    this.#blockToolCallIds.set(messageId, toolCallIds);
  }

  toolCallId(messageId: string, index: number): string | undefined {
    return this.#blockToolCallIds.get(messageId)?.get(index);
  }

  toolCallCount(messageId: string): number {
    return this.#blockToolCallIds.get(messageId)?.size ?? 0;
  }

  deleteToolCallId(messageId: string, index: number): void {
    this.#blockToolCallIds.get(messageId)?.delete(index);
  }

  clearToolCallIds(messageId: string): void {
    this.#blockToolCallIds.delete(messageId);
  }

  resolveFinalAssistantSnapshot(
    runId: RunId,
    resultText: string,
  ): { id: MessageId; text: string } | null {
    let selected: ClaudeAssistantFinalCandidate | null = null;

    for (const [messageId, ordinal] of this.#assistantMessageOrdinals) {
      if (
        this.#assistantMessageRunIds.get(messageId) !== runId ||
        !this.#authoritativeAssistantMessageIds.has(messageId) ||
        this.#textByAssistantMessageId.get(messageId) !== resultText
      ) {
        continue;
      }

      if (selected === null || ordinal > selected.ordinal) {
        selected = { id: messageId, ordinal };
      }
    }

    return selected === null ? null : { id: selected.id, text: resultText };
  }

  hasAssistantText(runId: RunId): boolean {
    return [...this.#textByAssistantMessageId].some(
      ([messageId, text]) =>
        this.#assistantMessageRunIds.get(messageId) === runId && text.length > 0,
    );
  }

  readNativeMessageId(message: SDKMessage): string | null {
    if (!isRecord(message)) {
      return null;
    }

    return readString(readRecord(message, "message"), "id") ?? readString(message, "uuid");
  }

  #retractAssistantMessage(messageId: MessageId): void {
    const runId = this.#assistantMessageRunIds.get(messageId);

    if (runId !== undefined) {
      if (this.#activeAssistantMessageIds.get(runId) === messageId) {
        this.#activeAssistantMessageIds.delete(runId);
      }

      if (this.#lastCompletedAssistantMessages.get(runId)?.id === messageId) {
        this.#lastCompletedAssistantMessages.delete(runId);
      }
    }

    this.#assistantMessageRunIds.delete(messageId);
    this.#authoritativeAssistantMessageIds.delete(messageId);
    this.#blockToolCallIds.delete(messageId);
    this.#streamedTextMessages.delete(messageId);
    this.#textByAssistantMessageId.delete(messageId);
  }

  #nextAssistantMessageSequence(runId: RunId): number {
    const sequence = (this.#assistantMessageSequences.get(runId) ?? 0) + 1;
    this.#assistantMessageSequences.set(runId, sequence);
    return sequence;
  }

  #ensureAssistantMessageOrdinal(runId: RunId, messageId: MessageId): number {
    const existing = this.#assistantMessageOrdinals.get(messageId);
    if (existing !== undefined) {
      return existing;
    }

    const ordinal = this.#nextAssistantMessageSequence(runId);
    this.#assistantMessageOrdinals.set(messageId, ordinal);
    return ordinal;
  }

  #requireAssistantMessageOrdinal(messageId: MessageId): number {
    const ordinal = this.#assistantMessageOrdinals.get(messageId);
    if (ordinal === undefined) {
      throw new Error("Claude assistant message ordinal is not initialized.");
    }
    return ordinal;
  }
}
