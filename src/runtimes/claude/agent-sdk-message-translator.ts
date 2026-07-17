import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { DriverEventInput } from "../../protocol/events";
import type { MessageId, RunId } from "../../protocol/id";
import type { AgentDriverContext } from "../agent-driver-backend";
import { RuntimeAssistantMessageIdIndex } from "../runtime-turn-transcript";
import { ClaudeAgentSdkEventWriter } from "./agent-sdk-event-writer";
import {
  isRecord,
  readNumber,
  readRecord,
  readString,
  stringifyForDisplay,
} from "./agent-sdk-json";
import type { JsonObject } from "./agent-sdk-json";
import { toClaudeFilesPersistedEvents } from "./agent-sdk-message-events";
import { readClaudeSdkSessionId } from "./agent-sdk-message-state";
import { isToolUseBlock, toToolCallId, toToolCallName, toToolResultText } from "./agent-sdk-tools";
interface ClaudeMessageTranslatorOptions {
  push(context: AgentDriverContext, reason: string, events: DriverEventInput[]): Promise<void>;
  recordNativeSessionId(context: AgentDriverContext, sessionId: string): Promise<void>;
}

interface ClaudeAssistantFinalCandidate {
  readonly id: MessageId;
  readonly ordinal: number;
}

export class ClaudeTerminalWriteError extends Error {
  override readonly name = "ClaudeTerminalWriteError";

  constructor(cause: unknown) {
    super("Claude terminal delivery failed.", { cause });
  }
}

function toClaudeThoughtId(messageId: string): string {
  return `${messageId}:thought`;
}

export class ClaudeAgentSdkMessageTranslator {
  readonly #activeAssistantMessageIds = new Map<RunId, MessageId>();
  readonly #activeThoughtIds = new Map<string, string>();
  readonly #authoritativeAssistantMessageIds = new Set<MessageId>();
  readonly #assistantMessageIds = new RuntimeAssistantMessageIdIndex<string>();
  readonly #assistantMessageOrdinals = new Map<MessageId, number>();
  readonly #assistantMessageRunIds = new Map<MessageId, RunId>();
  readonly #assistantMessageSequences = new Map<RunId, number>();
  readonly #blockToolCallIds = new Map<string, Map<number, string>>();
  readonly #events: ClaudeAgentSdkEventWriter;
  readonly #lastCompletedAssistantMessages = new Map<RunId, ClaudeAssistantFinalCandidate>();
  readonly #options: ClaudeMessageTranslatorOptions;
  readonly #streamedTextMessages = new Set<string>();
  readonly #streamingNativeMessageIds = new Map<string, string>();
  readonly #textByAssistantMessageId = new Map<MessageId, string>();

  constructor(options: ClaudeMessageTranslatorOptions) {
    this.#options = options;
    this.#events = new ClaudeAgentSdkEventWriter({ push: options.push });
  }

  resetTurnMessageState(): void {
    this.#activeAssistantMessageIds.clear();
    this.#activeThoughtIds.clear();
    this.#authoritativeAssistantMessageIds.clear();
    this.#assistantMessageIds.reset();
    this.#assistantMessageOrdinals.clear();
    this.#assistantMessageRunIds.clear();
    this.#assistantMessageSequences.clear();
    this.#blockToolCallIds.clear();
    this.#events.resetTurnState();
    this.#lastCompletedAssistantMessages.clear();
    this.#streamedTextMessages.clear();
    this.#streamingNativeMessageIds.clear();
    this.#textByAssistantMessageId.clear();
  }

  async endActiveThought(context: AgentDriverContext): Promise<void> {
    const thoughtIds = [...this.#activeThoughtIds.values()];
    this.#activeThoughtIds.clear();

    for (const thoughtId of thoughtIds) {
      await this.#events.endThought(context, thoughtId);
    }
  }

  async finishTurn(
    context: AgentDriverContext,
    toolStatus: "completed" | "failed",
  ): Promise<void> {
    await this.endActiveThought(context);

    for (const [messageId, runId] of this.#assistantMessageRunIds) {
      await this.#endAssistantMessage(context, runId, messageId);
    }

    await this.#events.finishTools(context, toolStatus);
  }

  async #endThought(context: AgentDriverContext, messageId: string): Promise<void> {
    const thoughtId = this.#activeThoughtIds.get(messageId);
    this.#activeThoughtIds.delete(messageId);

    if (thoughtId !== undefined) {
      await this.#events.endThought(context, thoughtId);
    }
  }

  async handleSdkMessage(
    context: AgentDriverContext,
    message: SDKMessage,
    runId: RunId,
  ): Promise<boolean> {
    const sessionId = readClaudeSdkSessionId(message);

    if (sessionId) {
      await this.#options.recordNativeSessionId(context, sessionId);
    }

    switch (message.type) {
      case "assistant": {
        await this.#handleAssistantMessage(context, message, runId);
        return false;
      }
      case "auth_status":
      case "rate_limit_event":
      case "tool_progress":
      case "tool_use_summary": {
        await this.#events.pushDiagnostic(context, message);
        return false;
      }
      case "result": {
        await this.#handleResultMessage(context, message, runId);
        return true;
      }
      case "stream_event": {
        await this.#handleStreamEvent(context, message, runId);
        return false;
      }
      case "system": {
        await this.#handleSystemMessage(context, message);
        return false;
      }
      case "user": {
        await this.#handleUserMessage(context, message, runId);
        return false;
      }
      case "prompt_suggestion": {
        return false;
      }
      default: {
        return false;
      }
    }
  }

  async #handleAssistantMessage(
    context: AgentDriverContext,
    message: Extract<SDKMessage, { type: "assistant" }>,
    runId: RunId,
  ): Promise<void> {
    const messageId = this.#assistantMessageId(runId, this.#readNativeMessageId(message));
    const content = Array.isArray(message.message.content) ? message.message.content : [];
    const authoritativeText: string[] = [];

    for (const [index, block] of content.entries()) {
      if (!isRecord(block)) {
        continue;
      }

      const blockType = readString(block, "type");

      if (blockType === "text") {
        const text = readString(block, "text");

        if (text !== null) {
          authoritativeText.push(text);
        }
        const isDuplicateStreamedText =
          text === null || this.#streamedTextMessages.has(messageId);

        if (text && !isDuplicateStreamedText) {
          this.#appendAssistantText(messageId, text);
          // Claude content blocks are protocol-ordered; push each derived event before reading the next block.
          await this.#events.pushTextDelta({
            context,
            delta: text,
            messageId,
            reason: "driver.claude.message.text",
          });
        }
        continue;
      }

      if (isToolUseBlock(block)) {
        const toolCallId = toToolCallId(block, messageId, index);
        if (!this.#events.hasToolStarted(toolCallId)) {
          // Claude content blocks are protocol-ordered; keep tool start/args/end in wire order.
          await this.#events.ensureToolStarted({
            context,
            parentMessageId: messageId,
            toolCallId,
            toolCallName: toToolCallName(block),
          });
        }
        const { input } = block;
        if (input !== undefined) {
          await this.#events.pushToolSnapshot(context, toolCallId, stringifyForDisplay(input));
        }
      }
    }

    if (authoritativeText.length > 0) {
      const text = authoritativeText.join("");
      this.#authoritativeAssistantMessageIds.add(messageId);
      this.#textByAssistantMessageId.set(messageId, text);
      await this.#events.pushMessageSnapshot(context, messageId, text);
    }

    await this.#endAssistantMessage(context, runId, messageId);
  }

  async #handleStreamEvent(
    context: AgentDriverContext,
    message: Extract<SDKMessage, { type: "stream_event" }>,
    runId: RunId,
  ): Promise<void> {
    const event = isRecord(message.event) ? message.event : null;
    const eventType = readString(event, "type");
    const streamScopeKey = this.#streamScopeKey(runId, message);

    if (eventType === "message_start") {
      const nativeMessageId = readString(readRecord(event, "message"), "id");

      if (nativeMessageId !== null) {
        this.#streamingNativeMessageIds.set(streamScopeKey, nativeMessageId);
      }

      await this.#events.ensureMessageStarted(
        context,
        this.#assistantMessageId(runId, nativeMessageId),
      );
      return;
    }

    const messageId = this.#assistantMessageId(
      runId,
      this.#streamingNativeMessageIds.get(streamScopeKey) ?? this.#readNativeMessageId(message),
    );

    if (eventType === "content_block_start") {
      await this.#handleContentBlockStart(context, messageId, event);
      return;
    }

    if (eventType === "content_block_delta") {
      await this.#handleContentBlockDelta(context, messageId, event);
      return;
    }

    if (eventType === "content_block_stop") {
      const index = readNumber(event, "index");

      if (index !== null) {
        this.#blockToolCallIds.get(messageId)?.delete(index);
      }
      return;
    }

    if (eventType === "message_stop") {
      await this.#endThought(context, messageId);
      await this.#endAssistantMessage(context, runId, messageId);
      this.#streamingNativeMessageIds.delete(streamScopeKey);
      this.#blockToolCallIds.delete(messageId);
      return;
    }

    if (eventType === "message_delta") {
      const delta = readRecord(event, "delta");
      const usage = readRecord(event, "usage");
      await this.#events.pushUsage(context, usage ?? delta, null);
    }
  }

  #streamScopeKey(runId: RunId, message: SDKMessage): string {
    const parentToolUseId = isRecord(message)
      ? readString(message, "parent_tool_use_id")
      : null;
    return `${runId}:${parentToolUseId ?? "main"}`;
  }

  #appendStreamedText(messageId: string, text: string): void {
    this.#streamedTextMessages.add(messageId);
    this.#appendAssistantText(messageId as MessageId, text);
  }

  #appendAssistantText(messageId: MessageId, text: string): void {
    this.#textByAssistantMessageId.set(
      messageId,
      `${this.#textByAssistantMessageId.get(messageId) ?? ""}${text}`,
    );
  }

  async #handleContentBlockStart(
    context: AgentDriverContext,
    messageId: string,
    event: JsonObject | null,
  ): Promise<void> {
    const index = readNumber(event, "index");
    const block = readRecord(event, "content_block");

    if (!block) {
      return;
    }

    const blockType = readString(block, "type");

    if (blockType === "text") {
      const text = readString(block, "text");
      if (text) {
        this.#appendStreamedText(messageId, text);
        await this.#events.pushTextDelta({
          context,
          delta: text,
          messageId,
          reason: "driver.claude.message.text",
        });
      }
      return;
    }

    if (blockType === "thinking") {
      const thoughtId = this.#activeThoughtIds.get(messageId) ?? toClaudeThoughtId(messageId);
      this.#activeThoughtIds.set(messageId, thoughtId);
      await this.#events.ensureThoughtStarted(context, thoughtId);
      return;
    }

    if (!isToolUseBlock(block)) {
      return;
    }

    const toolCallIds = this.#blockToolCallIds.get(messageId) ?? new Map<number, string>();
    const toolCallId = toToolCallId(block, messageId, index ?? toolCallIds.size);
    await this.#events.ensureToolStarted({
      context,
      parentMessageId: messageId,
      toolCallId,
      toolCallName: toToolCallName(block),
    });

    if (index !== null) {
      toolCallIds.set(index, toolCallId);
      this.#blockToolCallIds.set(messageId, toolCallIds);
    }

    const { input } = block;
    if (input) {
      await this.#events.pushToolArguments({
        context,
        delta: stringifyForDisplay(input),
        reason: "driver.claude.tool.args",
        toolCallId,
      });
    }
  }

  async #handleContentBlockDelta(
    context: AgentDriverContext,
    messageId: string,
    event: JsonObject | null,
  ): Promise<void> {
    const delta = readRecord(event, "delta");
    const deltaType = readString(delta, "type");

    if (deltaType === "text_delta") {
      const text = readString(delta, "text");

      if (!text) {
        return;
      }

      this.#appendStreamedText(messageId, text);
      await this.#events.pushTextDelta({
        context,
        delta: text,
        messageId,
        reason: "driver.claude.message.delta",
      });
      return;
    }

    if (deltaType === "input_json_delta") {
      const index = readNumber(event, "index");
      const partialJson = readString(delta, "partial_json");
      const toolCallId = index === null ? null : this.#blockToolCallIds.get(messageId)?.get(index);

      if (partialJson && toolCallId) {
        await this.#events.pushToolArguments({
          context,
          delta: partialJson,
          reason: "driver.claude.tool.args.delta",
          toolCallId,
        });
      }
      return;
    }

    if (deltaType === "thinking_delta") {
      const thinkingText = readString(delta, "thinking");

      if (!thinkingText) {
        return;
      }

      const thoughtId = this.#activeThoughtIds.get(messageId) ?? toClaudeThoughtId(messageId);
      this.#activeThoughtIds.set(messageId, thoughtId);

      await this.#events.pushThoughtDelta({
        context,
        delta: thinkingText,
        thoughtId,
      });
    }
  }

  async #handleUserMessage(
    context: AgentDriverContext,
    message: Extract<SDKMessage, { type: "user" }>,
    runId: RunId,
  ): Promise<void> {
    const content = isRecord(message.message) ? message.message.content : null;
    const blocks = Array.isArray(content) ? content : [];

    for (const block of blocks) {
      if (!isRecord(block)) {
        continue;
      }

      const toolCallId = readString(block, "tool_use_id");
      const resultText = toToolResultText(block);

      if (!toolCallId || !resultText) {
        continue;
      }

      // Tool results are emitted in transcript order so the live state reducer can attach them deterministically.
      await this.#events.pushToolResult({
        content: resultText,
        context,
        messageId:
          this.#events.toolParentMessageId(toolCallId) ??
          this.#activeAssistantMessageIds.get(runId) ??
          this.#lastCompletedAssistantMessages.get(runId)?.id ??
          this.#assistantMessageId(runId, null),
        toolCallId,
      });
    }
  }

  #assistantMessageId(runId: RunId, nativeMessageId: string | null): MessageId {
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

  async #endAssistantMessage(
    context: AgentDriverContext,
    runId: RunId,
    messageId: MessageId,
  ): Promise<void> {
    const ended = await this.#events.endMessage(context, messageId);

    if (ended) {
      const ordinal = this.#requireAssistantMessageOrdinal(messageId);
      const current = this.#lastCompletedAssistantMessages.get(runId);

      // A reconnect can deliver an older complete assistant snapshot after a
      // newer message has already completed. Keep the snapshot repair for the
      // old message, but never let arrival order move the canonical final
      // candidate backwards.
      if (current === undefined || ordinal > current.ordinal) {
        this.#lastCompletedAssistantMessages.set(runId, { id: messageId, ordinal });
      }
    }

    if (this.#activeAssistantMessageIds.get(runId) === messageId) {
      this.#activeAssistantMessageIds.delete(runId);
    }
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

  #resolveFinalAssistantSnapshot(
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

  #readNativeMessageId(message: SDKMessage): string | null {
    if (!isRecord(message)) {
      return null;
    }

    return readString(readRecord(message, "message"), "id") ?? readString(message, "uuid");
  }

  async #handleSystemMessage(
    context: AgentDriverContext,
    message: Extract<SDKMessage, { type: "system" }>,
  ): Promise<void> {
    if (message.subtype === "init") {
      await this.#options.recordNativeSessionId(context, message.session_id);
      await this.#events.pushSessionInfoUpdated(context);
      context.logger.info("driver.claude.session.initialized", {
        mcpServerCount: message.mcp_servers.length,
        model: message.model,
        nativeSessionIdPresent: true,
        toolCount: message.tools.length,
      });
      return;
    }

    if (message.subtype === "files_persisted") {
      await this.#handleFilesPersisted(context, message);
    }
  }

  async #handleFilesPersisted(
    context: AgentDriverContext,
    message: Extract<SDKMessage, { type: "system"; subtype: "files_persisted" }>,
  ): Promise<void> {
    await this.#options.push(
      context,
      "driver.claude.files.persisted",
      toClaudeFilesPersistedEvents(message),
    );
  }

  async #handleResultMessage(
    context: AgentDriverContext,
    message: Extract<SDKMessage, { type: "result" }>,
    runId: RunId,
  ): Promise<void> {
    await this.finishTurn(context, message.subtype === "success" ? "completed" : "failed");
    await this.#events.pushUsage(
      context,
      isRecord(message.usage) ? message.usage : null,
      message.total_cost_usd,
    );

    if (message.subtype === "success") {
      const resultText = isRecord(message) ? readString(message, "result") : null;
      // SDKResultSuccess.result is the provider's terminal text. Bind it only
      // to a complete assistant snapshot with identical bytes; arrival order
      // alone cannot distinguish a late replayed progress frame from final.
      const finalMessage =
        resultText === null ? null : this.#resolveFinalAssistantSnapshot(runId, resultText);

      try {
        await this.#events.pushRunFinished(context, runId, finalMessage);
      } catch (error) {
        throw new ClaudeTerminalWriteError(error);
      }
      return;
    }

    try {
      await this.#events.pushRunError(
        context,
        runId,
        `claude.${message.subtype}`,
        message.errors.join("\n") || "Claude Agent SDK turn failed.",
      );
    } catch (error) {
      throw new ClaudeTerminalWriteError(error);
    }
  }
}
