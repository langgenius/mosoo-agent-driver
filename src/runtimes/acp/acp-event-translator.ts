import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import { RuntimeAssistantMessageIdIndex } from "../runtime-turn-transcript";
import { toAcpPermissionRequest } from "./acp-permission-events";
import type { AcpPermissionTranslation } from "./acp-permission-events";
import {
  normalizePromptUsage,
  summarizeContentBlock,
  toAvailableCommandsEvents,
  toPlanEvents,
  toSessionConfigEvents,
  toSessionInfoEvents,
  toSessionModeEvents,
  toUsageUpdateEvents,
} from "./acp-session-events";
import {
  AcpToolEventState,
  isTerminalToolStatus,
  toRuntimeToolStatus,
  toToolCallPayload,
} from "./acp-tool-events";
import { isRecord, readNonEmptyString, readRecord, readString } from "./acp-types";
import type { AcpPromptStopReason, JsonObject } from "./acp-types";

export type { AcpPermissionOption, AcpPermissionTranslation } from "./acp-permission-events";
export { toAcpPermissionRequest, toAcpPermissionResolvedEvent } from "./acp-permission-events";
export {
  shouldIgnoreAcpReplayUpdate,
  toAcpAuthSessionEvent,
  toAcpInitializeEvents,
  toAcpPromptStartEvents,
  toAcpSessionReadyEvents,
} from "./acp-session-events";

export interface AcpTurnEventStateInput {
  readonly messageId: string;
  readonly runId: RunId;
  readonly sessionId: string;
}

interface AcpAssistantMessageState {
  readonly id: string;
  readonly nativeMessageId: string | null;
  text: string;
}

interface AcpAssistantMessageStart {
  readonly events: DriverEventInput[];
  readonly message: AcpAssistantMessageState;
}

export class AcpTurnEventState {
  #activeAssistantMessage: AcpAssistantMessageState | null = null;
  readonly #assistantMessageIds = new RuntimeAssistantMessageIdIndex<string>();
  #lastCompletedAssistantMessage: Pick<AcpAssistantMessageState, "id" | "text"> | null = null;
  #promptMessageId: string | null = null;
  #runId: RunId | null = null;
  #sequence = 0;
  #sessionId: string | null = null;
  readonly #settledAssistantNativeMessageIds = new Set<string>();
  #unidentifiedAssistantMessageSequence = 0;
  #thoughtCompleted = false;
  #thoughtFallbackText = "";
  #thoughtFallbackNativeMessageId: string | null = null;
  #thoughtId: string | null = null;
  #thoughtStarted = false;
  readonly #tools = new AcpToolEventState();

  activeRunId(): RunId | null {
    return this.#runId;
  }

  begin(input: AcpTurnEventStateInput): void {
    this.#activeAssistantMessage = null;
    this.#assistantMessageIds.reset();
    this.#lastCompletedAssistantMessage = null;
    this.#promptMessageId = input.messageId;
    this.#runId = input.runId;
    this.#sequence = 0;
    this.#sessionId = input.sessionId;
    this.#settledAssistantNativeMessageIds.clear();
    this.#unidentifiedAssistantMessageSequence = 0;
    this.#thoughtCompleted = false;
    this.#thoughtFallbackText = "";
    this.#thoughtFallbackNativeMessageId = null;
    this.#thoughtId = `${input.messageId}:thought`;
    this.#thoughtStarted = false;
    this.#tools.clear();
  }

  clear(): void {
    this.#activeAssistantMessage = null;
    this.#assistantMessageIds.reset();
    this.#lastCompletedAssistantMessage = null;
    this.#promptMessageId = null;
    this.#runId = null;
    this.#sequence = 0;
    this.#sessionId = null;
    this.#settledAssistantNativeMessageIds.clear();
    this.#unidentifiedAssistantMessageSequence = 0;
    this.#thoughtCompleted = false;
    this.#thoughtFallbackText = "";
    this.#thoughtFallbackNativeMessageId = null;
    this.#thoughtId = null;
    this.#thoughtStarted = false;
    this.#tools.clear();
  }

  completePrompt(stopReason: AcpPromptStopReason, usage: unknown): DriverEventInput[] {
    const events: DriverEventInput[] = [];
    const runId = this.#requireRunId();

    events.push(...this.#promoteThoughtFallbackToMessage());
    events.push(...this.#completeActiveAssistantMessage());

    if (this.#thoughtStarted && !this.#thoughtCompleted) {
      this.#thoughtCompleted = true;
      events.push({
        kind: "thought.completed",
        payload: {
          channel: "summary",
          thoughtId: this.#requireThoughtId(),
        },
        runId,
      });
    }

    const promptFailed = stopReason === "max_turn_requests";
    const toolStatus = stopReason === "cancelled" || promptFailed ? "failed" : "completed";
    const toolError =
      stopReason === "cancelled"
        ? "Turn cancelled before tool completion."
        : promptFailed
          ? "Turn failed after the maximum turn request limit."
          : undefined;
    events.push(
      ...this.#tools.completeOpen({
        runId,
        status: toolStatus,
        ...(toolError === undefined ? {} : { error: toolError }),
      }),
    );

    const usagePayload = normalizePromptUsage(usage);

    if (usagePayload !== null) {
      events.push({
        kind: "usage.updated",
        payload: usagePayload,
        runId,
      });
    }

    const finalMessage = this.#lastCompletedAssistantMessage;
    const emptyTurn =
      stopReason === "end_turn" &&
      (finalMessage === null || finalMessage.text.trim().length === 0) &&
      !this.#tools.hasActivity();

    if (stopReason === "cancelled") {
      events.push({
        kind: "run.cancelled",
        payload: {
          requestedBy: "user",
          stopReason: "cancelled",
        },
        runId,
      });
    } else if (promptFailed) {
      events.push({
        kind: "run.failed",
        payload: {
          error: {
            code: "acp.max_turn_requests",
            message: "ACP prompt stopped after the maximum turn request limit.",
          },
          recoverable: false,
          stopReason,
        },
        runId,
      });
    } else if (emptyTurn) {
      events.push({
        kind: "run.failed",
        payload: {
          error: {
            code: "acp.empty_turn",
            message: "ACP prompt ended without assistant output or tool activity.",
          },
          recoverable: true,
          stopReason,
        },
        runId,
      });
    } else {
      events.push({
        kind: "run.completed",
        payload: {
          ...(finalMessage === null
            ? {}
            : {
                finalMessageId: finalMessage.id,
                finalMessageText: finalMessage.text,
              }),
          stopReason,
        },
        runId,
      });
    }

    this.clear();
    return events;
  }

  failPrompt(error: { code: string; message: string; recoverable?: boolean }): DriverEventInput[] {
    const runId = this.#runId;

    if (runId === null) {
      this.clear();
      return [];
    }

    const events: DriverEventInput[] = [];
    const thoughtId = this.#thoughtId;

    events.push(...this.#completeActiveAssistantMessage());

    if (this.#thoughtStarted && !this.#thoughtCompleted && thoughtId !== null) {
      events.push({
        kind: "thought.completed",
        payload: {
          channel: "summary",
          thoughtId,
        },
        runId,
      });
    }

    events.push(
      ...this.#tools.completeOpen({
        error: error.message,
        runId,
        status: "failed",
      }),
    );

    events.push({
      kind: "run.failed",
      payload: {
        error: {
          code: error.code,
          message: error.message,
        },
        recoverable: error.recoverable ?? false,
      },
      runId,
    });

    this.clear();
    return events;
  }

  translateUpdate(params: unknown): DriverEventInput[] {
    const record = isRecord(params) ? params : {};
    const update = readRecord(record, "update");
    const sessionUpdate = readString(update, "sessionUpdate");

    switch (sessionUpdate) {
      case "agent_message_chunk": {
        return this.#translateAgentMessageChunk(update);
      }
      case "agent_thought_chunk": {
        return this.#translateThoughtChunk(update);
      }
      case "available_commands_update": {
        return toAvailableCommandsEvents(update);
      }
      case "config_option_update": {
        return toSessionConfigEvents(update);
      }
      case "current_mode_update": {
        return toSessionModeEvents(update);
      }
      case "plan": {
        return toPlanEvents(update);
      }
      case "session_info_update": {
        return toSessionInfoEvents(update);
      }
      case "tool_call": {
        return this.#translateToolCall(update);
      }
      case "tool_call_update": {
        return this.#translateToolCallUpdate(update);
      }
      case "usage_update": {
        return toUsageUpdateEvents(update);
      }
      case "user_message_chunk":
      case undefined:
      case null: {
        return [];
      }
      default: {
        return [
          {
            kind: "diagnostic.reported",
            payload: {
              message: `Unsupported ACP session update: ${sessionUpdate}.`,
              raw: update,
              severity: "info",
            },
            visibility: "owner_debug",
          },
        ];
      }
    }
  }

  translatePermissionRequest(input: {
    params: unknown;
    requestId: string;
  }): AcpPermissionTranslation {
    const runId = this.activeRunId();
    const translation = toAcpPermissionRequest({
      params: input.params,
      requestId: input.requestId,
      runId,
    });

    if (runId === null || translation.toolCall === null) {
      return translation;
    }

    return {
      ...translation,
      events: [
        ...this.#tools.ensureStarted({
          parentMessageId: this.#toolParentMessageId(),
          runId,
          title: translation.title,
          toolCallId: translation.targetItemId,
        }),
        ...translation.events,
      ],
    };
  }

  #nextSourceEventId(kind: string): string {
    this.#sequence += 1;
    return `acp:${this.#sessionId ?? "session"}:${this.#runId ?? "run"}:${kind}:${this.#sequence}`;
  }

  #translateAgentMessageChunk(update: JsonObject | null): DriverEventInput[] {
    const delta = summarizeContentBlock(update?.["content"]);
    if (delta === null) {
      return [];
    }

    const nativeMessageId = readNonEmptyString(update, "messageId");
    const started =
      nativeMessageId === null
        ? this.#startUnidentifiedAssistantMessage()
        : this.#startIdentifiedAssistantMessage(nativeMessageId);

    if (started === null) {
      // An already settled native message can only be a late replay. Keeping
      // the newer active message intact avoids letting a progress replay win
      // the final-message identity by arrival order.
      return [];
    }

    started.message.text += delta;

    return [
      ...started.events,
      {
        delivery: "best_effort",
        kind: "message.delta",
        payload: {
          contentBlock: update?.["content"],
          contentDelta: delta,
          messageId: started.message.id,
          role: "agent",
        },
        runId: this.#requireRunId(),
        sourceEventId: this.#nextSourceEventId("agent-message"),
      },
    ];
  }

  #translateThoughtChunk(update: JsonObject | null): DriverEventInput[] {
    const delta = summarizeContentBlock(update?.["content"]);

    if (delta === null) {
      return [];
    }

    const nativeMessageId = readNonEmptyString(update, "messageId");
    const events: DriverEventInput[] = [];

    if (nativeMessageId === null) {
      // Thought updates can carry the provider's final answer. Without a
      // native identity there is no safe way to decide whether this text
      // belongs to the active assistant message or starts a newer one. Close
      // the live message boundary, then fail closed instead of projecting an
      // earlier identified progress message as canonical final output.
      events.push(...this.#completeActiveAssistantMessage());
      this.#lastCompletedAssistantMessage = null;
      this.#clearThoughtFallback();
    } else if (!this.#settledAssistantNativeMessageIds.has(nativeMessageId)) {
      const active = this.#activeAssistantMessage;

      if (active !== null && active.nativeMessageId !== nativeMessageId) {
        // ACP runtimes can expose final answer text through a thought update.
        // A new native identity is an explicit message boundary: settle the
        // active progress message so this thought can become the final fallback.
        events.push(...this.#completeActiveAssistantMessage());
      }

      if (this.#activeAssistantMessage === null) {
        if (this.#thoughtFallbackNativeMessageId === nativeMessageId) {
          this.#thoughtFallbackText += delta;
        } else {
          this.#thoughtFallbackNativeMessageId = nativeMessageId;
          this.#thoughtFallbackText = delta;
        }
      }
    }

    events.push(...this.#ensureThoughtStarted(), {
      delivery: "best_effort",
      kind: "thought.delta",
      payload: {
        channel: "summary",
        contentBlock: update?.["content"],
        contentDelta: delta,
        thoughtId: this.#requireThoughtId(),
      },
      runId: this.#requireRunId(),
      sourceEventId: this.#nextSourceEventId("agent-thought"),
    });
    return events;
  }

  #translateToolCall(update: JsonObject | null): DriverEventInput[] {
    const toolCallId = readNonEmptyString(update, "toolCallId");

    if (toolCallId === null) {
      return [];
    }

    const runId = this.#requireRunId();
    const status = toRuntimeToolStatus(readString(update, "status"));
    const title =
      readNonEmptyString(update, "title") ?? readNonEmptyString(update, "kind") ?? "tool";
    const events = this.#tools.ensureStarted({
      parentMessageId: this.#toolParentMessageId(),
      runId,
      title,
      toolCallId,
    });

    events.push({
      kind: "tool.call.updated",
      payload: toToolCallPayload(toolCallId, status, update),
      runId,
      sourceEventId: this.#nextSourceEventId("tool-call"),
    });

    if (isTerminalToolStatus(readString(update, "status"))) {
      const completion = this.#tools.complete({ runId, status, toolCallId, update });

      if (completion !== null) {
        events.push(completion);
      }
    }

    return events;
  }

  #translateToolCallUpdate(update: JsonObject | null): DriverEventInput[] {
    const toolCallId = readNonEmptyString(update, "toolCallId");

    if (toolCallId === null) {
      return [];
    }

    const runId = this.#requireRunId();
    const status = toRuntimeToolStatus(readString(update, "status"));
    const title =
      readNonEmptyString(update, "title") ?? readNonEmptyString(update, "kind") ?? "tool";
    const events = this.#tools.ensureStarted({
      parentMessageId: this.#toolParentMessageId(),
      runId,
      title,
      toolCallId,
    });

    events.push({
      delivery: status === "running" ? "best_effort" : "lossless",
      kind: "tool.call.updated",
      payload: toToolCallPayload(toolCallId, status, update),
      runId,
      sourceEventId: this.#nextSourceEventId("tool-call-update"),
    });

    if (isTerminalToolStatus(readString(update, "status"))) {
      const completion = this.#tools.complete({ runId, status, toolCallId, update });

      if (completion !== null) {
        events.push(completion);
      }
    }

    return events;
  }

  #promoteThoughtFallbackToMessage(): DriverEventInput[] {
    if (this.#activeAssistantMessage !== null) {
      return [];
    }

    const contentDelta = this.#thoughtFallbackText;
    const nativeMessageId = this.#thoughtFallbackNativeMessageId;

    if (contentDelta.trim().length === 0 || nativeMessageId === null) {
      return [];
    }

    this.#clearThoughtFallback();
    const started = this.#startIdentifiedAssistantMessage(nativeMessageId);

    if (started === null) {
      return [];
    }

    started.message.text += contentDelta;
    return [
      ...started.events,
      {
        delivery: "best_effort",
        kind: "message.delta",
        payload: {
          contentBlock: {
            text: contentDelta,
            type: "text",
          },
          contentDelta,
          messageId: started.message.id,
          role: "agent",
        },
        runId: this.#requireRunId(),
        sourceEventId: this.#nextSourceEventId("agent-thought-fallback-message"),
      },
    ];
  }

  #clearThoughtFallback(): void {
    this.#thoughtFallbackNativeMessageId = null;
    this.#thoughtFallbackText = "";
  }

  #completeActiveAssistantMessage(): DriverEventInput[] {
    const message = this.#activeAssistantMessage;

    if (message === null) {
      return [];
    }

    this.#activeAssistantMessage = null;

    if (message.nativeMessageId !== null) {
      this.#settledAssistantNativeMessageIds.add(message.nativeMessageId);
      this.#lastCompletedAssistantMessage = {
        id: message.id,
        text: message.text,
      };
    } else {
      // ACP v1 does not give anonymous chunks a stable message boundary. If
      // this is the last assistant message, do not let an earlier progress
      // message become the canonical final output.
      this.#lastCompletedAssistantMessage = null;
    }

    return [
      {
        kind: "message.completed",
        payload: {
          messageId: message.id,
          role: "agent",
        },
        runId: this.#requireRunId(),
      },
    ];
  }

  #startIdentifiedAssistantMessage(nativeMessageId: string): AcpAssistantMessageStart | null {
    if (this.#settledAssistantNativeMessageIds.has(nativeMessageId)) {
      return null;
    }

    const active = this.#activeAssistantMessage;

    if (active?.nativeMessageId === nativeMessageId) {
      return { events: [], message: active };
    }

    const events = this.#completeActiveAssistantMessage();
    const message: AcpAssistantMessageState = {
      id: this.#assistantMessageIds.getOrCreate(`native:${nativeMessageId}`),
      nativeMessageId,
      text: "",
    };

    this.#activeAssistantMessage = message;
    this.#clearThoughtFallback();
    events.push({
      kind: "message.started",
      payload: {
        messageId: message.id,
        role: "agent",
      },
      runId: this.#requireRunId(),
    });
    return { events, message };
  }

  #startUnidentifiedAssistantMessage(): AcpAssistantMessageStart {
    const active = this.#activeAssistantMessage;

    if (active?.nativeMessageId === null) {
      return { events: [], message: active };
    }

    const events = this.#completeActiveAssistantMessage();
    this.#unidentifiedAssistantMessageSequence += 1;
    const message: AcpAssistantMessageState = {
      id: this.#assistantMessageIds.getOrCreate(
        `fallback:unidentified:${this.#unidentifiedAssistantMessageSequence}`,
      ),
      nativeMessageId: null,
      text: "",
    };

    this.#activeAssistantMessage = message;
    this.#clearThoughtFallback();
    events.push({
      kind: "message.started",
      payload: {
        messageId: message.id,
        role: "agent",
      },
      runId: this.#requireRunId(),
    });
    return { events, message };
  }

  #ensureThoughtStarted(): DriverEventInput[] {
    if (this.#thoughtStarted) {
      return [];
    }

    this.#thoughtStarted = true;
    return [
      {
        kind: "thought.started",
        payload: {
          channel: "summary",
          thoughtId: this.#requireThoughtId(),
        },
        runId: this.#requireRunId(),
      },
    ];
  }

  #requireRunId(): RunId {
    if (this.#runId === null) {
      throw new Error("ACP turn run id is not initialized.");
    }

    return this.#runId;
  }

  #requireThoughtId(): string {
    if (this.#thoughtId === null) {
      throw new Error("ACP turn thought id is not initialized.");
    }

    return this.#thoughtId;
  }

  #toolParentMessageId(): string | undefined {
    return this.#activeAssistantMessage?.id ?? this.#promptMessageId ?? undefined;
  }
}
