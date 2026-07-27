import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { DriverEventInput } from "../../protocol/events";
import type { MessageId, RunId } from "../../protocol/id";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
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
import { ClaudeAgentSdkMessageState, readClaudeSdkSessionId } from "./agent-sdk-message-state";
import { isToolUseBlock, toToolCallId, toToolCallName, toToolResultText } from "./agent-sdk-tools";
interface ClaudeMessageTranslatorOptions {
  push(context: AgentDriverContext, reason: string, events: DriverEventInput[]): Promise<void>;
  recordNativeSessionId(context: AgentDriverContext, sessionId: string): Promise<void>;
}

export class ClaudeTerminalWriteError extends Error {
  override readonly name = "ClaudeTerminalWriteError";

  constructor(cause: unknown) {
    super("Claude terminal delivery failed.", { cause });
  }
}

export class ClaudeAgentSdkMessageTranslator {
  readonly #events: ClaudeAgentSdkEventWriter;
  readonly #options: ClaudeMessageTranslatorOptions;
  readonly #state = new ClaudeAgentSdkMessageState();

  constructor(options: ClaudeMessageTranslatorOptions) {
    this.#options = options;
    this.#events = new ClaudeAgentSdkEventWriter({ push: options.push });
  }

  resetTurnMessageState(): void {
    this.#state.reset();
    this.#events.resetTurnState();
  }

  async endActiveThought(context: AgentDriverContext): Promise<void> {
    for (const thoughtId of this.#state.takeAllThoughtIds()) {
      await this.#events.endThought(context, thoughtId);
    }
  }

  async finishTurn(context: AgentDriverContext, toolStatus: "completed" | "failed"): Promise<void> {
    await this.endActiveThought(context);

    for (const [messageId, runId] of this.#state.assistantMessages()) {
      await this.#endAssistantMessage(context, runId, messageId);
    }

    await this.#events.finishTools(context, toolStatus);
  }

  async #endThought(context: AgentDriverContext, messageId: string): Promise<void> {
    const thoughtId = this.#state.takeThoughtId(messageId);

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
    const messageId = this.#state.assistantMessageId(
      runId,
      this.#state.resolveAssistantMessageNativeId(
        this.#state.streamScopeKey(runId, message),
        this.#state.readNativeMessageId(message),
      ),
    );
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
        const isDuplicateStreamedText = text === null || this.#state.hasStreamedText(messageId);

        if (text && !isDuplicateStreamedText) {
          // Claude content blocks are protocol-ordered; push each derived event before reading the next block.
          const pushed = await this.#events.pushTextDelta({
            context,
            delta: text,
            messageId,
            reason: "driver.claude.message.text",
          });
          if (pushed) {
            this.#state.appendAssistantText(messageId, text);
          }
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
      if (await this.#events.pushMessageSnapshot(context, messageId, text)) {
        this.#state.markAuthoritative(messageId, text);
      }
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
    const streamScopeKey = this.#state.streamScopeKey(runId, message);

    if (eventType === "message_start") {
      const nativeMessageId = readString(readRecord(event, "message"), "id");

      if (nativeMessageId !== null) {
        this.#state.setStreamingNativeMessageId(streamScopeKey, nativeMessageId);
      }

      await this.#events.ensureMessageStarted(
        context,
        this.#state.assistantMessageId(runId, nativeMessageId),
      );
      return;
    }

    // Content frames pin the scope to one message even when message_start was
    // lost; boundary frames only read the anchor so a bare message_stop does
    // not mint a message from its own envelope uuid.
    const isContentFrame =
      eventType === "content_block_start" || eventType === "content_block_delta";
    const messageId = this.#state.assistantMessageId(
      runId,
      isContentFrame
        ? this.#state.anchorStreamingNativeMessageId(
            streamScopeKey,
            this.#state.readNativeMessageId(message),
          )
        : (this.#state.streamingNativeMessageId(streamScopeKey) ??
            this.#state.readNativeMessageId(message)),
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
        this.#state.deleteToolCallId(messageId, index);
      }
      return;
    }

    if (eventType === "message_stop") {
      await this.#endThought(context, messageId);
      this.#events.sealMessage(messageId);
      this.#state.clearStreamingNativeMessageId(streamScopeKey);
      this.#state.clearToolCallIds(messageId);
      return;
    }

    if (eventType === "message_delta") {
      const delta = readRecord(event, "delta");
      const usage = readRecord(event, "usage");
      await this.#events.pushUsage(context, usage ?? delta, null);
    }
  }

  async #handleContentBlockStart(
    context: AgentDriverContext,
    messageId: MessageId,
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
      if (
        text &&
        (await this.#events.pushTextDelta({
          context,
          delta: text,
          messageId,
          reason: "driver.claude.message.text",
        }))
      ) {
        this.#state.appendStreamedText(messageId, text);
      }
      return;
    }

    if (blockType === "thinking") {
      const thoughtId = this.#state.thoughtId(messageId);
      await this.#events.ensureThoughtStarted(context, thoughtId);
      return;
    }

    if (!isToolUseBlock(block)) {
      return;
    }

    const toolCallId = toToolCallId(
      block,
      messageId,
      index ?? this.#state.toolCallCount(messageId),
    );
    await this.#events.ensureToolStarted({
      context,
      parentMessageId: messageId,
      toolCallId,
      toolCallName: toToolCallName(block),
    });

    if (index !== null) {
      this.#state.setToolCallId(messageId, index, toolCallId);
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
    messageId: MessageId,
    event: JsonObject | null,
  ): Promise<void> {
    const delta = readRecord(event, "delta");
    const deltaType = readString(delta, "type");

    if (deltaType === "text_delta") {
      const text = readString(delta, "text");

      if (!text) {
        return;
      }

      const pushed = await this.#events.pushTextDelta({
        context,
        delta: text,
        messageId,
        reason: "driver.claude.message.delta",
      });
      if (pushed) {
        this.#state.appendStreamedText(messageId, text);
      }
      return;
    }

    if (deltaType === "input_json_delta") {
      const index = readNumber(event, "index");
      const partialJson = readString(delta, "partial_json");
      const toolCallId = index === null ? null : this.#state.toolCallId(messageId, index);

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

      const thoughtId = this.#state.thoughtId(messageId);

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
          this.#state.activeAssistantMessageId(runId) ??
          this.#state.lastCompletedAssistantMessageId(runId) ??
          this.#state.assistantMessageId(runId, null),
        status: block["is_error"] === true ? "failed" : "completed",
        toolCallId,
      });
    }
  }

  async #endAssistantMessage(
    context: AgentDriverContext,
    runId: RunId,
    messageId: MessageId,
  ): Promise<void> {
    const ended = await this.#events.endMessage(context, messageId);
    this.#state.completeAssistantMessage(runId, messageId, ended);
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
      if (resultText !== null && resultText.length > 0 && !this.#state.hasAssistantText(runId)) {
        const messageId = this.#state.assistantMessageId(runId, null);
        if (await this.#events.pushMessageSnapshot(context, messageId, resultText)) {
          this.#state.markAuthoritative(messageId, resultText);
          await this.#endAssistantMessage(context, runId, messageId);
        }
      }
      // SDKResultSuccess.result is the provider's terminal text. Bind it only
      // to a complete assistant snapshot with identical bytes. Native crash
      // resume can omit every assistant frame, so the result is materialized
      // above only when no competing text candidate exists.
      const finalMessage =
        resultText === null ? null : this.#state.resolveFinalAssistantSnapshot(runId, resultText);

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
