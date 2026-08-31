import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { jsonValueSchema } from "../../contract";
import type { DriverEventInput } from "../../protocol/events";
import type { MessageId, RunId, SessionId } from "../../protocol/id";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { assertClaudeDurableEventFits, ClaudeAgentSdkEventWriter } from "./agent-sdk-event-writer";
import {
  isRecord,
  readNumber,
  readRecord,
  readString,
  stringifyForDisplay,
} from "./agent-sdk-json";
import type { JsonObject } from "./agent-sdk-json";
import {
  aggregateClaudeModelUsage,
  toClaudeFilesPersistedEvents,
} from "./agent-sdk-message-events";
import {
  claudeAssistantOutcome,
  claudePermissionDenialAdvisory,
  claudePermissionDenials,
  claudeResultErrorDetails,
  claudeToolOutcome,
  isClaudeResultCancelled,
  isClaudeResultRetryable,
  isClaudeResultSuccessful,
} from "./agent-sdk-outcomes";
import { ClaudeAgentSdkMessageState, readClaudeSdkSessionId } from "./agent-sdk-message-state";
import {
  claudeBackgroundTasksClosedEvent,
  projectClaudeBackgroundTasksSnapshot,
} from "./agent-sdk-task-events";
import { isToolUseBlock, toToolCallId, toToolCallName, toToolResultText } from "./agent-sdk-tools";
import type { ClaudePermissionDenialAdvisory } from "./agent-sdk-outcomes";
interface ClaudeMessageTranslatorOptions {
  publicToolCallId(nativeToolCallId: string): string;
  readonly sessionId: SessionId;
  push(context: AgentDriverContext, reason: string, events: DriverEventInput[]): Promise<void>;
  pushTerminal(
    context: AgentDriverContext,
    reason: string,
    closures: readonly DriverEventInput[],
    terminal: DriverEventInput,
  ): Promise<void>;
  recordNativeSessionId(context: AgentDriverContext, sessionId: string): Promise<void>;
  replaceNativeSessionId(
    context: AgentDriverContext,
    previousSessionId: string,
    nextSessionId: string,
  ): Promise<void>;
}

const MAX_CLAUDE_STRUCTURED_TERMINAL_BYTES = 512 * 1_024;

function exhaustSdkMessage(value: never): unknown {
  return value;
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
  readonly #permissionDenialAdvisories = new Map<string, ClaudePermissionDenialAdvisory>();
  readonly #state: ClaudeAgentSdkMessageState;

  constructor(options: ClaudeMessageTranslatorOptions) {
    this.#options = options;
    this.#events = new ClaudeAgentSdkEventWriter({ push: options.push });
    this.#state = new ClaudeAgentSdkMessageState(options.sessionId);
  }

  resetTurnMessageState(): void {
    this.#state.reset();
    this.#events.resetTurnState();
    this.#permissionDenialAdvisories.clear();
  }

  async #cancelOpenTurn(context: AgentDriverContext): Promise<void> {
    for (const [messageId, thoughtId] of this.#state.activeThoughts()) {
      await this.#events.settleThought(context, thoughtId, "cancelled");
      this.#state.deleteThoughtId(messageId);
    }

    for (const [messageId, runId] of this.#state.assistantMessages()) {
      await this.#events.settleMessage(context, messageId, { status: "cancelled" });
      this.#state.completeAssistantMessage(runId, messageId, false);
    }

    await this.#events.finishTools(context, "cancelled");
    await this.#options.push(context, "driver.claude.tasks.finished", [
      claudeBackgroundTasksClosedEvent(),
    ]);
  }

  async finishTurnWithTerminal(
    context: AgentDriverContext,
    toolStatus: "cancelled" | "completed" | "failed",
    terminal: DriverEventInput,
    reason: string,
  ): Promise<void> {
    const closure = this.#events.prepareTurnClosure(toolStatus);
    await this.#options.pushTerminal(
      context,
      reason,
      [...closure.events, claudeBackgroundTasksClosedEvent()],
      terminal,
    );
    closure.commit();

    this.#state.clearThoughtIds();
    for (const [messageId, runId] of this.#state.assistantMessages()) {
      this.#state.completeAssistantMessage(runId, messageId, toolStatus === "completed");
    }
  }

  async cancelTurn(context: AgentDriverContext, runId: RunId, reason: string): Promise<void> {
    await this.finishTurnWithTerminal(
      context,
      "cancelled",
      this.#events.runCancelled(runId, reason),
      "driver.claude.turn.cancelled",
    );
  }

  async failTurn(
    context: AgentDriverContext,
    runId: RunId,
    code: string,
    message: string,
  ): Promise<void> {
    await this.finishTurnWithTerminal(
      context,
      "failed",
      this.#events.runError(runId, code, message, false),
      "driver.claude.turn.failed",
    );
  }

  async #endThought(context: AgentDriverContext, messageId: string): Promise<void> {
    const thoughtId = this.#state.thoughtIdForMessage(messageId);

    if (thoughtId !== undefined) {
      await this.#events.settleThought(context, thoughtId, "completed");
      this.#state.deleteThoughtId(messageId);
    }
  }

  async handleSdkMessage(
    context: AgentDriverContext,
    message: SDKMessage,
    runId: RunId,
  ): Promise<boolean> {
    const sessionId = readClaudeSdkSessionId(message);

    if (sessionId !== null && message.type !== "conversation_reset") {
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
      case "conversation_reset": {
        await this.#handleConversationReset(context, message);
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
        await this.#handleSystemMessage(context, message, runId);
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
        const unexpected = exhaustSdkMessage(message);
        await this.#events.pushRawDiagnostic(
          context,
          "driver.claude.message.unknown",
          isRecord(unexpected) ? unexpected : { value: String(unexpected) },
        );
        return false;
      }
    }
  }

  async #handleAssistantMessage(
    context: AgentDriverContext,
    message: Extract<SDKMessage, { type: "assistant" }>,
    runId: RunId,
  ): Promise<void> {
    await this.#retractWireItems(context, message.supersedes ?? []);
    const outcome = claudeAssistantOutcome(message);
    const messageId = this.#state.assistantMessageId(
      runId,
      this.#state.resolveAssistantMessageNativeId(
        this.#state.streamScopeKey(runId, message),
        readString(readRecord(message, "message"), "id"),
        message.uuid,
      ),
    );
    const content = Array.isArray(message.message.content) ? message.message.content : [];
    const authoritativeText: string[] = [];
    const toolCallIds: string[] = [];

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
        const toolCallId = this.#options.publicToolCallId(toToolCallId(block, messageId, index));
        toolCallIds.push(toolCallId);
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

    this.#state.bindWireAssistantMessage(message.uuid, messageId);
    this.#state.bindWireToolCalls(message.uuid, toolCallIds);

    if (authoritativeText.length > 0) {
      const text = authoritativeText.join("");
      if (await this.#events.pushMessageSnapshot(context, messageId, text)) {
        if (outcome.status === "completed") {
          this.#state.markAuthoritative(messageId, text);
        }
      }
    }

    if (outcome.status === "cancelled") {
      const thoughtId = this.#state.thoughtIdForMessage(messageId);
      if (thoughtId !== undefined) {
        await this.#events.settleThought(context, thoughtId, "cancelled");
        this.#state.deleteThoughtId(messageId);
      }
      await this.#events.ensureMessageStarted(context, messageId);
      await this.#events.settleMessage(context, messageId, { status: "cancelled" });
      this.#state.completeAssistantMessage(runId, messageId, false);
      return;
    }

    if (outcome.status === "failed") {
      await this.#endThought(context, messageId);
      await this.#events.ensureMessageStarted(context, messageId);
      await this.#events.settleMessage(context, messageId, {
        error: {
          code: `claude.${outcome.code}`,
          message: outcome.message,
          retryable: outcome.retryable,
        },
        status: "failed",
      });
      this.#state.completeAssistantMessage(runId, messageId, false);
      return;
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

    const toolCallId = this.#options.publicToolCallId(
      toToolCallId(block, messageId, index ?? this.#state.toolCallCount(messageId)),
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
    if (input && (!isRecord(input) || Object.keys(input).length > 0)) {
      await this.#events.pushToolSnapshot(context, toolCallId, stringifyForDisplay(input));
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
    const structuredOutput = jsonValueSchema.safeParse(message.tool_use_result);
    const toolCallIds: string[] = [];

    for (const block of blocks) {
      if (!isRecord(block)) {
        continue;
      }

      const nativeToolCallId = readString(block, "tool_use_id");
      const resultText = toToolResultText(block);

      if (!nativeToolCallId || resultText === null) {
        continue;
      }
      const toolCallId = this.#options.publicToolCallId(nativeToolCallId);
      toolCallIds.push(toolCallId);

      const outcome = claudeToolOutcome(message, block);

      // Tool results are emitted in transcript order so the live state reducer can attach them deterministically.
      await this.#events.pushToolResult({
        content: resultText,
        context,
        messageId:
          this.#events.toolParentMessageId(toolCallId) ??
          this.#state.activeAssistantMessageId(runId) ??
          this.#state.lastCompletedAssistantMessageId(runId) ??
          this.#state.assistantMessageId(runId, null),
        ...(outcome.nonExecutionKind === undefined
          ? {}
          : { nonExecutionKind: outcome.nonExecutionKind }),
        status: outcome.status,
        ...(structuredOutput.success ? { structuredOutput: structuredOutput.data } : {}),
        toolCallId,
        ...(outcome.userFeedback === undefined ? {} : { userFeedback: outcome.userFeedback }),
      });
    }

    if (message.uuid !== undefined) {
      this.#state.bindWireToolCalls(message.uuid, toolCallIds);
    }
  }

  async #endAssistantMessage(
    context: AgentDriverContext,
    runId: RunId,
    messageId: MessageId,
  ): Promise<void> {
    const ended = await this.#events.settleMessage(context, messageId, { status: "completed" });
    this.#state.completeAssistantMessage(runId, messageId, ended);
  }

  async #handleSystemMessage(
    context: AgentDriverContext,
    message: Extract<SDKMessage, { type: "system" }>,
    runId: RunId,
  ): Promise<void> {
    switch (message.subtype) {
      case "init": {
        await this.#events.pushSessionInfoUpdated(context);
        context.logger.info("driver.claude.session.initialized", {
          mcpServerCount: message.mcp_servers.length,
          model: message.model,
          nativeSessionIdPresent: true,
          toolCount: message.tools.length,
        });
        return;
      }
      case "files_persisted": {
        await this.#handleFilesPersisted(context, message);
        return;
      }
      case "informational": {
        const nativeToolCallId = message.tool_use_id;
        await this.#pushStandaloneMessage(context, runId, message.uuid, message.content, {
          level: message.level,
          ...(message.prevent_continuation === undefined
            ? {}
            : { preventContinuation: message.prevent_continuation }),
          subtype: message.subtype,
          ...(nativeToolCallId === undefined
            ? {}
            : { toolCallId: this.#options.publicToolCallId(nativeToolCallId) }),
        });
        return;
      }
      case "local_command_output": {
        await this.#pushStandaloneMessage(context, runId, message.uuid, message.content, {
          subtype: message.subtype,
        });
        return;
      }
      case "mirror_error": {
        await this.#events.pushRawDiagnostic(
          context,
          "driver.claude.mirror_error",
          {
            errorBytes: Buffer.byteLength(message.error, "utf8"),
            kind: "claude.mirror_error",
          },
          { message: "Claude transcript mirror write failed.", severity: "error" },
        );
        return;
      }
      case "model_refusal_fallback": {
        await this.#retractWireItems(context, message.retracted_message_uuids ?? []);
        await this.#events.pushDiagnostic(context, message);
        return;
      }
      case "permission_denied": {
        const denial = claudePermissionDenialAdvisory(message);
        if (denial !== null) {
          const toolCallId = this.#options.publicToolCallId(denial.toolCallId);
          this.#permissionDenialAdvisories.set(`${runId}:${toolCallId}`, {
            ...denial,
            toolCallId,
          });
        }
        return;
      }
      case "api_retry":
      case "commands_changed":
      case "compact_boundary":
      case "control_request_progress":
      case "elicitation_complete":
      case "hook_progress":
      case "hook_response":
      case "hook_started":
      case "memory_recall":
      case "model_refusal_no_fallback":
      case "notification":
      case "plugin_install":
      case "session_state_changed":
      case "status":
      case "task_notification":
      case "task_progress":
      case "task_started":
      case "task_updated":
      case "thinking_tokens":
      case "worker_shutting_down": {
        await this.#events.pushDiagnostic(context, message);
        return;
      }
      case "background_tasks_changed": {
        await this.#handleBackgroundTasksChanged(context, message);
        return;
      }
      default: {
        const unexpected = exhaustSdkMessage(message);
        await this.#events.pushRawDiagnostic(
          context,
          "driver.claude.system.unknown",
          isRecord(unexpected) ? unexpected : { value: String(unexpected) },
        );
      }
    }
  }

  async #handleBackgroundTasksChanged(
    context: AgentDriverContext,
    message: Extract<SDKMessage, { subtype: "background_tasks_changed"; type: "system" }>,
  ): Promise<void> {
    const { diagnostic, snapshot } = projectClaudeBackgroundTasksSnapshot(message);
    await this.#options.push(context, "driver.claude.tasks.replaced", [
      snapshot,
      ...(diagnostic === undefined ? [] : [diagnostic]),
    ]);
  }

  async #retractWireItems(
    context: AgentDriverContext,
    wireUuids: readonly string[],
  ): Promise<void> {
    for (const wireUuid of wireUuids) {
      const { messageId, toolCallIds } = this.#state.wireItems(wireUuid);

      if (messageId !== null) {
        const thoughtId = this.#state.thoughtIdForMessage(messageId);
        if (thoughtId !== undefined) {
          await this.#events.settleThought(context, thoughtId, "cancelled");
          this.#state.deleteThoughtId(messageId);
        }
        await this.#events.retractMessage(context, messageId);
        this.#state.commitWireMessageRetraction(wireUuid, messageId);
      }

      for (const toolCallId of toolCallIds) {
        await this.#events.retractTool(context, toolCallId);
      }
      this.#state.commitWireToolRetractions(wireUuid);
    }
  }

  async #pushStandaloneMessage(
    context: AgentDriverContext,
    runId: RunId,
    nativeMessageId: string,
    content: string,
    metadata: JsonObject,
  ): Promise<void> {
    if (content.length === 0) {
      await this.#events.pushRawDiagnostic(
        context,
        `driver.claude.${String(metadata["subtype"] ?? "message")}`,
        { content, ...metadata },
        { message: "Claude emitted an empty display message.", severity: "warn" },
      );
      return;
    }

    const messageId = this.#state.auxiliaryMessageId(runId, nativeMessageId);
    if (await this.#events.pushMessageSnapshot(context, messageId, content, metadata)) {
      await this.#events.settleMessage(context, messageId, { status: "completed" });
    }
  }

  async #handleConversationReset(
    context: AgentDriverContext,
    message: Extract<SDKMessage, { type: "conversation_reset" }>,
  ): Promise<void> {
    await this.#cancelOpenTurn(context);
    await this.#options.replaceNativeSessionId(
      context,
      message.session_id,
      message.new_conversation_id,
    );
    this.resetTurnMessageState();
    await this.#events.pushSessionInfoUpdated(context, true);
  }

  async #handleFilesPersisted(
    context: AgentDriverContext,
    message: Extract<SDKMessage, { type: "system"; subtype: "files_persisted" }>,
  ): Promise<void> {
    const events = toClaudeFilesPersistedEvents(message);
    for (const event of events) {
      assertClaudeDurableEventFits(
        event,
        "claude.files_persisted_too_large",
        "file persistence event",
      );
    }
    await this.#options.push(context, "driver.claude.files.persisted", events);
  }

  async #handleResultMessage(
    context: AgentDriverContext,
    message: Extract<SDKMessage, { type: "result" }>,
    runId: RunId,
  ): Promise<void> {
    const successful = isClaudeResultSuccessful(message);
    const cancelled = isClaudeResultCancelled(message);

    for (const denial of claudePermissionDenials(message)) {
      const toolCallId = this.#options.publicToolCallId(denial.toolCallId);
      const advisory = this.#permissionDenialAdvisories.get(`${runId}:${toolCallId}`);
      const messageId =
        this.#events.toolParentMessageId(toolCallId) ??
        this.#state.activeAssistantMessageId(runId) ??
        this.#state.lastCompletedAssistantMessageId(runId) ??
        null;
      await this.#events.ensureToolStarted({
        context,
        ...(messageId === null ? {} : { parentMessageId: messageId }),
        toolCallId,
        toolCallName: denial.name,
      });
      await this.#events.pushToolResult({
        ...(advisory?.agentId === undefined ? {} : { agentId: advisory.agentId }),
        authoritative: true,
        content: advisory?.message ?? denial.message,
        context,
        ...(advisory?.decisionReason === undefined
          ? {}
          : { decisionReason: advisory.decisionReason }),
        ...(advisory?.decisionReasonType === undefined
          ? {}
          : { decisionReasonType: advisory.decisionReasonType }),
        ...(messageId === null ? {} : { messageId }),
        rawInput: stringifyForDisplay(denial.input),
        status: "failed",
        toolCallId,
        toolCallName: denial.name,
      });
      this.#permissionDenialAdvisories.delete(`${runId}:${toolCallId}`);
    }

    await this.#events.pushUsage(
      context,
      aggregateClaudeModelUsage(message.modelUsage),
      message.total_cost_usd,
    );
    const finishResult = async (
      toolStatus: "cancelled" | "completed" | "failed",
      terminal: DriverEventInput,
      reason: string,
    ): Promise<void> => {
      try {
        await this.finishTurnWithTerminal(context, toolStatus, terminal, reason);
      } catch (error) {
        throw new ClaudeTerminalWriteError(error);
      }
    };

    if (cancelled) {
      await finishResult(
        "cancelled",
        this.#events.runCancelled(runId, message.terminal_reason ?? "provider.aborted"),
        "driver.claude.turn.cancelled",
      );
      return;
    }

    if (message.subtype === "success" && successful) {
      const resultText = isRecord(message) ? readString(message, "result") : null;
      const structuredOutput =
        message.structured_output === undefined
          ? undefined
          : jsonValueSchema.safeParse(message.structured_output);

      if (structuredOutput !== undefined && !structuredOutput.success) {
        await finishResult(
          "failed",
          this.#events.runError(
            runId,
            "claude.invalid_structured_output",
            "Claude Agent SDK returned a non-JSON structured output.",
            false,
          ),
          "driver.claude.turn.failed",
        );
        return;
      }

      const completedTerminal = this.#events.runFinished(runId, null, structuredOutput?.data);
      const structuredOutputTooLarge =
        structuredOutput?.success === true &&
        Buffer.byteLength(JSON.stringify(completedTerminal), "utf8") >
          MAX_CLAUDE_STRUCTURED_TERMINAL_BYTES;

      if (structuredOutputTooLarge) {
        await finishResult(
          "failed",
          this.#events.runError(
            runId,
            "claude.structured_output_too_large",
            "Claude Agent SDK structured output exceeds the runtime terminal event limit.",
            false,
          ),
          "driver.claude.turn.failed",
        );
        return;
      }

      if (
        structuredOutput === undefined &&
        resultText !== null &&
        resultText.length > 0 &&
        !this.#state.hasAssistantText(runId)
      ) {
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
        structuredOutput !== undefined || resultText === null || resultText.trim().length === 0
          ? null
          : this.#state.resolveFinalAssistantSnapshot(runId, resultText);

      await finishResult(
        "completed",
        this.#events.runFinished(runId, finalMessage, structuredOutput?.data),
        "driver.claude.turn.completed",
      );
      return;
    }

    await finishResult(
      "failed",
      this.#events.runError(
        runId,
        message.subtype === "success" ? "claude.api_error" : `claude.${message.subtype}`,
        message.subtype === "success"
          ? message.result || "Claude Agent SDK API request failed."
          : message.errors.join("\n") || "Claude Agent SDK turn failed.",
        isClaudeResultRetryable(message),
        claudeResultErrorDetails(message),
      ),
      "driver.claude.turn.failed",
    );
  }
}
