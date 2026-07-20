import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { MessageId, RunId } from "../../protocol/id";
import { RuntimeAssistantMessageIdIndex } from "../runtime-turn-transcript";
import { isRecord, readRecord, readString } from "./agent-sdk-json";

interface ClaudeAssistantFinalCandidate {
  readonly id: MessageId;
  readonly ordinal: number;
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
  readonly #authoritativeAssistantMessageIds = new Set<MessageId>();
  readonly #assistantMessageIds = new RuntimeAssistantMessageIdIndex<string>();
  readonly #assistantMessageOrdinals = new Map<MessageId, number>();
  readonly #assistantMessageRunIds = new Map<MessageId, RunId>();
  readonly #assistantMessageSequences = new Map<RunId, number>();
  readonly #blockToolCallIds = new Map<string, Map<number, string>>();
  readonly #lastCompletedAssistantMessages = new Map<RunId, ClaudeAssistantFinalCandidate>();
  readonly #streamedTextMessages = new Set<string>();
  readonly #streamingNativeMessageIds = new Map<string, string>();
  readonly #textByAssistantMessageId = new Map<MessageId, string>();

  reset(): void {
    this.#activeAssistantMessageIds.clear();
    this.#activeThoughtIds.clear();
    this.#authoritativeAssistantMessageIds.clear();
    this.#assistantMessageIds.reset();
    this.#assistantMessageOrdinals.clear();
    this.#assistantMessageRunIds.clear();
    this.#assistantMessageSequences.clear();
    this.#blockToolCallIds.clear();
    this.#lastCompletedAssistantMessages.clear();
    this.#streamedTextMessages.clear();
    this.#streamingNativeMessageIds.clear();
    this.#textByAssistantMessageId.clear();
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

  assistantMessages(): readonly (readonly [MessageId, RunId])[] {
    return [...this.#assistantMessageRunIds];
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

  takeThoughtId(messageId: string): string | undefined {
    const thoughtId = this.#activeThoughtIds.get(messageId);
    this.#activeThoughtIds.delete(messageId);
    return thoughtId;
  }

  takeAllThoughtIds(): readonly string[] {
    const thoughtIds = [...this.#activeThoughtIds.values()];
    this.#activeThoughtIds.clear();
    return thoughtIds;
  }

  streamScopeKey(runId: RunId, message: SDKMessage): string {
    const parentToolUseId = isRecord(message) ? readString(message, "parent_tool_use_id") : null;
    return `${runId}:${parentToolUseId ?? "main"}`;
  }

  setStreamingNativeMessageId(scope: string, nativeMessageId: string): void {
    this.#streamingNativeMessageIds.set(scope, nativeMessageId);
  }

  streamingNativeMessageId(scope: string): string | undefined {
    return this.#streamingNativeMessageIds.get(scope);
  }

  clearStreamingNativeMessageId(scope: string): void {
    this.#streamingNativeMessageIds.delete(scope);
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

  readNativeMessageId(message: SDKMessage): string | null {
    if (!isRecord(message)) {
      return null;
    }

    return readString(readRecord(message, "message"), "id") ?? readString(message, "uuid");
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
