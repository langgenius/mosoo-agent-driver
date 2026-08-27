import type { StopReason } from "@agentclientprotocol/sdk";

import type { DriverEventInput } from "../../protocol/events";
import { createDriverId } from "../../protocol/id";
import type { RunId } from "../../protocol/id";
import {
  MAX_RUN_TERMINAL_BATCH_BYTES,
  MAX_RUN_TERMINAL_BATCH_EVENTS,
} from "../driver-event-admission";
import { chunkJsonText } from "../provider-json";
import { toPermissionRequest } from "./acp-permission-events";
import type { AcpPermissionTranslation } from "./acp-permission-events";
import {
  normalizePromptUsage,
  summarizeContentBlock,
  toCommandEvents,
  toPlanEvents,
  toConfigEvents,
  toInfoEvents,
  toModeEvents,
  toUsageEvents,
} from "./acp-session-events";
import { AcpToolEventState, toRuntimeToolStatus } from "./acp-tool-events";
import {
  assertBoundedLosslessEvents,
  isRecord,
  MAX_ACP_LOSSLESS_EVENT_BYTES,
  readNonEmptyString,
  readRecord,
  readString,
} from "./acp-types";
import type { JsonObject } from "./acp-types";

const MAX_ACP_MESSAGE_EVENT_TEXT_BYTES = MAX_ACP_LOSSLESS_EVENT_BYTES - 1_024;
// An open item can require two terminal closures. Reserve four shared-batch
// slots for message/thought/final envelopes. A retained byte (notably a tool
// ID) can occur in both closures, so reserve one quarter of the byte budget for
// envelopes and admit half of the remaining three quarters. Measuring current
// retained state makes replay/no-op traffic free while keeping every possible
// ACP settlement below the shared 1024-event / 1 MiB hard limit.
const MAX_ACP_RETAINED_TURN_BYTES = (MAX_RUN_TERMINAL_BATCH_BYTES * 3) / 8;
const MAX_ACP_RETAINED_TURN_ITEMS = Math.floor((MAX_RUN_TERMINAL_BATCH_EVENTS - 4) / 2);
// Settled native IDs are only a replay-suppression cache. Bound and evict them
// independently; they cannot produce terminal closures.
const MAX_ACP_SETTLED_MESSAGE_HISTORY_BYTES = MAX_ACP_LOSSLESS_EVENT_BYTES;
const MAX_ACP_SETTLED_MESSAGE_HISTORY_ITEMS = 1_024;

export interface AcpAssistantTranscriptStateInput {
  readonly messageId: string;
  readonly runId: RunId;
}

export class AcpTurnStateLimitError extends RangeError {
  override readonly name = "AcpTurnStateLimitError";
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

export class AcpAssistantTranscriptState {
  #activeAssistantMessage: AcpAssistantMessageState | null = null;
  #lastCompletedAssistantMessage: { readonly hasVisibleText: boolean; readonly id: string } | null =
    null;
  #promptMessageId: string | null = null;
  #runId: RunId | null = null;
  #sequence = 0;
  readonly #settledAssistantNativeMessageIds = new Set<string>();
  #settledAssistantNativeMessageIdBytes = 0;
  #thoughtCompleted = false;
  #thoughtFallbackText = "";
  #thoughtFallbackNativeMessageId: string | null = null;
  #thoughtId: string | null = null;
  #thoughtStarted = false;
  readonly #tools = new AcpToolEventState();

  activeRunId(): RunId | null {
    return this.#runId;
  }

  begin(input: AcpAssistantTranscriptStateInput): void {
    this.clear();
    this.#promptMessageId = input.messageId;
    this.#runId = input.runId;
    this.#thoughtId = `${input.messageId}:thought`;
  }

  clear(): void {
    this.#activeAssistantMessage = null;
    this.#lastCompletedAssistantMessage = null;
    this.#promptMessageId = null;
    this.#runId = null;
    this.#sequence = 0;
    this.#settledAssistantNativeMessageIds.clear();
    this.#settledAssistantNativeMessageIdBytes = 0;
    this.#thoughtCompleted = false;
    this.#thoughtFallbackText = "";
    this.#thoughtFallbackNativeMessageId = null;
    this.#thoughtId = null;
    this.#thoughtStarted = false;
    this.#tools.clear();
  }

  checkpoint(): () => void {
    const activeAssistantMessage =
      this.#activeAssistantMessage === null ? null : { ...this.#activeAssistantMessage };
    const lastCompletedAssistantMessage =
      this.#lastCompletedAssistantMessage === null
        ? null
        : { ...this.#lastCompletedAssistantMessage };
    const sequence = this.#sequence;
    const settledAssistantNativeMessageIds = new Set(this.#settledAssistantNativeMessageIds);
    const settledAssistantNativeMessageIdBytes = this.#settledAssistantNativeMessageIdBytes;
    const thoughtCompleted = this.#thoughtCompleted;
    const thoughtFallbackNativeMessageId = this.#thoughtFallbackNativeMessageId;
    const thoughtFallbackText = this.#thoughtFallbackText;
    const thoughtStarted = this.#thoughtStarted;
    const restoreTools = this.#tools.checkpoint();

    return () => {
      this.#activeAssistantMessage = activeAssistantMessage;
      this.#lastCompletedAssistantMessage = lastCompletedAssistantMessage;
      this.#sequence = sequence;
      this.#settledAssistantNativeMessageIds.clear();
      settledAssistantNativeMessageIds.forEach((id) =>
        this.#settledAssistantNativeMessageIds.add(id),
      );
      this.#settledAssistantNativeMessageIdBytes = settledAssistantNativeMessageIdBytes;
      this.#thoughtCompleted = thoughtCompleted;
      this.#thoughtFallbackNativeMessageId = thoughtFallbackNativeMessageId;
      this.#thoughtFallbackText = thoughtFallbackText;
      this.#thoughtStarted = thoughtStarted;
      restoreTools();
    };
  }

  completePrompt(stopReason: StopReason, usage: unknown): DriverEventInput[] {
    const events: DriverEventInput[] = [];
    const runId = this.#requireRunId();
    const terminalError =
      stopReason === "end_turn" || stopReason === "cancelled"
        ? null
        : `ACP prompt stopped with ${stopReason}.`;

    events.push(...this.#promoteThought());
    events.push(
      ...(stopReason === "end_turn"
        ? this.#finishMessage()
        : this.#finishMessageWithOutcome(stopReason, terminalError)),
    );

    if (this.#thoughtStarted && !this.#thoughtCompleted) {
      this.#thoughtCompleted = true;
      events.push({
        kind: stopReason === "end_turn" ? "thought.completed" : "thought.cancelled",
        payload: {
          channel: "summary",
          ...(stopReason === "end_turn"
            ? {}
            : { reason: terminalError ?? "cancelled", stopReason }),
          thoughtId: this.#requireThoughtId(),
        },
        runId,
      });
    }

    events.push(
      ...this.#tools.completeOpen({
        ...(terminalError === null ? {} : { error: terminalError }),
        runId,
        status:
          stopReason === "end_turn"
            ? "completed"
            : stopReason === "cancelled"
              ? "cancelled"
              : "failed",
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
      (finalMessage === null || !finalMessage.hasVisibleText) &&
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
    } else if (terminalError !== null) {
      events.push({
        kind: "run.failed",
        payload: {
          error: {
            code: `acp.${stopReason}`,
            message: terminalError,
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
              }),
          stopReason,
        },
        runId,
      });
    }

    return assertBoundedLosslessEvents(events);
  }

  failPrompt(error: { code: string; message: string; recoverable?: boolean }): DriverEventInput[] {
    const runId = this.#runId;

    if (runId === null) {
      this.clear();
      return [];
    }

    const originalMessageUtf8Bytes = Buffer.byteLength(error.message, "utf8");
    const message =
      originalMessageUtf8Bytes <= 16 * 1_024
        ? error.message
        : `ACP failure exceeded durable event capacity (originalMessageUtf8Bytes=${originalMessageUtf8Bytes}).`;
    const events: DriverEventInput[] = [];
    const thoughtId = this.#thoughtId;

    events.push(...this.#failMessage({ ...error, message }));

    if (this.#thoughtStarted && !this.#thoughtCompleted && thoughtId !== null) {
      this.#thoughtCompleted = true;
      events.push({
        kind: "thought.cancelled",
        payload: {
          channel: "summary",
          reason: message,
          thoughtId,
        },
        runId,
      });
    }

    events.push(
      ...this.#tools.completeOpen({
        runId,
        status: "failed",
      }),
    );

    events.push({
      kind: "run.failed",
      payload: {
        error: {
          code: error.code,
          ...(message === error.message ? {} : { details: { originalMessageUtf8Bytes } }),
          message,
        },
        recoverable: error.recoverable ?? false,
      },
      runId,
    });

    return assertBoundedLosslessEvents(events);
  }

  translateUpdate(params: unknown): DriverEventInput[] {
    const record = isRecord(params) ? params : {};
    const update = readRecord(record, "update");
    const sessionUpdate = readString(update, "sessionUpdate");
    const retainsTurnState =
      this.#runId !== null &&
      (sessionUpdate === "agent_message_chunk" ||
        sessionUpdate === "agent_thought_chunk" ||
        sessionUpdate === "tool_call" ||
        sessionUpdate === "tool_call_update");
    const restore = retainsTurnState ? this.checkpoint() : null;

    try {
      let events: DriverEventInput[];

      switch (sessionUpdate) {
        case "agent_message_chunk": {
          events = this.#messageChunk(update);
          break;
        }
        case "agent_thought_chunk": {
          events = this.#thoughtChunk(update);
          break;
        }
        case "available_commands_update": {
          events = toCommandEvents(update);
          break;
        }
        case "config_option_update": {
          events = toConfigEvents(update);
          break;
        }
        case "current_mode_update": {
          events = toModeEvents(update);
          break;
        }
        case "plan": {
          events = toPlanEvents(update);
          break;
        }
        case "session_info_update": {
          events = toInfoEvents(update);
          break;
        }
        case "tool_call":
        case "tool_call_update": {
          events = this.#tool(update, sessionUpdate);
          break;
        }
        case "usage_update": {
          events = toUsageEvents(update);
          break;
        }
        case "user_message_chunk":
        case undefined:
        case null: {
          events = [];
          break;
        }
        default: {
          events = [
            {
              delivery: "best_effort",
              kind: "diagnostic.reported",
              payload: {
                message: `Unsupported ACP session update: ${sessionUpdate}.`,
                raw: update,
                severity: "info",
              },
              visibility: "owner_debug",
            },
          ];
          break;
        }
      }

      if (retainsTurnState) {
        this.#assertRetainedTurnState();
      }
      return assertBoundedLosslessEvents(events);
    } catch (error) {
      restore?.();
      throw error;
    }
  }

  translatePermission(input: { params: unknown; requestId: string }): AcpPermissionTranslation {
    const runId = this.activeRunId();
    const restore = runId === null ? null : this.checkpoint();

    try {
      const translation = toPermissionRequest({
        params: input.params,
        requestId: input.requestId,
        runId,
      });

      if (runId === null || translation.toolCall === null) {
        return {
          ...translation,
          events: assertBoundedLosslessEvents(translation.events),
        };
      }

      const parentStart = this.#ensureToolParentMessage(translation.targetItemId);
      this.#tools.patch({
        status: toRuntimeToolStatus(readString(translation.toolCall, "status")),
        toolCallId: translation.targetItemId,
        update: translation.toolCall,
      });
      const events = [
        ...parentStart,
        ...this.#tools.ensureStarted({
          parentMessageId: this.#toolParentMessageId(),
          runId,
          title: translation.request.title,
          toolCallId: translation.targetItemId,
        }),
        ...translation.events,
      ];
      this.#assertRetainedTurnState();

      return {
        ...translation,
        events: assertBoundedLosslessEvents(events),
      };
    } catch (error) {
      restore?.();
      throw error;
    }
  }

  #nextEventId(kind: string): string {
    this.#sequence += 1;
    return `acp:${this.#runId ?? "run"}:${kind}:${this.#sequence}`;
  }

  #messageChunk(update: JsonObject | null): DriverEventInput[] {
    const delta = summarizeContentBlock(update?.["content"]);
    if (delta === null) {
      return [];
    }

    const nativeMessageId = readNonEmptyString(update, "messageId");
    const started =
      nativeMessageId === null
        ? this.#startAnonymousMessage()
        : this.#startMessage(nativeMessageId);

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
        sourceEventId: this.#nextEventId("agent-message"),
      },
    ];
  }

  #thoughtChunk(update: JsonObject | null): DriverEventInput[] {
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
      events.push(...this.#finishMessage());
      this.#lastCompletedAssistantMessage = null;
      this.#clearThoughtFallback();
    } else if (!this.#settledAssistantNativeMessageIds.has(nativeMessageId)) {
      const active = this.#activeAssistantMessage;

      if (active !== null && active.nativeMessageId !== nativeMessageId) {
        // ACP runtimes can expose final answer text through a thought update.
        // A new native identity is an explicit message boundary: settle the
        // active progress message so this thought can become the final fallback.
        events.push(...this.#finishMessage());
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
      sourceEventId: this.#nextEventId("agent-thought"),
    });
    return events;
  }

  #tool(update: JsonObject | null, type: "tool_call" | "tool_call_update"): DriverEventInput[] {
    const toolCallId = readNonEmptyString(update, "toolCallId");

    if (toolCallId === null) {
      return [];
    }

    const runId = this.#requireRunId();
    const parentStart = this.#ensureToolParentMessage(toolCallId);
    const nativeStatus = readString(update, "status");
    const projected = this.#tools.patch({
      parentMessageId: this.#toolParentMessageId(),
      status: nativeStatus === null ? null : toRuntimeToolStatus(nativeStatus),
      toolCallId,
      update,
    });

    if (!projected.changed) {
      return parentStart;
    }

    const title =
      (typeof projected.payload["title"] === "string" ? projected.payload["title"] : null) ??
      (typeof projected.payload["kind"] === "string" ? projected.payload["kind"] : "tool");
    const events = [
      ...parentStart,
      ...this.#tools.ensureStarted({
        parentMessageId: this.#toolParentMessageId(),
        runId,
        title,
        toolCallId,
      }),
    ];

    events.push({
      ...(type === "tool_call_update"
        ? { delivery: projected.status === "running" ? "best_effort" : "lossless" }
        : {}),
      kind: "tool.call.updated",
      payload: projected.payload,
      runId,
      sourceEventId: this.#nextEventId(type.replaceAll("_", "-")),
    });

    if (projected.status !== "running") {
      const completion = this.#tools.complete({
        runId,
        status: projected.status,
        toolCallId,
        update,
      });

      if (completion !== null) {
        events.push(completion);
      }
    }

    return events;
  }

  #promoteThought(): DriverEventInput[] {
    if (this.#activeAssistantMessage !== null) {
      return [];
    }

    const contentDelta = this.#thoughtFallbackText;
    const nativeMessageId = this.#thoughtFallbackNativeMessageId;

    if (contentDelta.trim().length === 0 || nativeMessageId === null) {
      return [];
    }

    this.#clearThoughtFallback();
    const started = this.#startMessage(nativeMessageId);

    if (started === null) {
      return [];
    }

    started.message.text += contentDelta;
    return started.events;
  }

  #clearThoughtFallback(): void {
    this.#thoughtFallbackNativeMessageId = null;
    this.#thoughtFallbackText = "";
  }

  #finishMessage(): DriverEventInput[] {
    const message = this.#activeAssistantMessage;

    if (message === null) {
      return [];
    }

    this.#activeAssistantMessage = null;

    if (message.nativeMessageId !== null) {
      this.#rememberSettledAssistantMessage(message.nativeMessageId);
      this.#lastCompletedAssistantMessage = {
        hasVisibleText: message.text.trim().length > 0,
        id: message.id,
      };
    } else {
      // ACP v1 does not give anonymous chunks a stable message boundary. If
      // this is the last assistant message, do not let an earlier progress
      // message become the canonical final output.
      this.#lastCompletedAssistantMessage = null;
    }

    const chunks =
      message.text.length === 0
        ? []
        : chunkJsonText(message.text, MAX_ACP_MESSAGE_EVENT_TEXT_BYTES);

    return [
      ...(chunks.length === 0
        ? []
        : [
            {
              delivery: "lossless" as const,
              kind: "message.added" as const,
              payload: {
                content: chunks[0]!,
                messageId: message.id,
                role: "agent",
              },
              runId: this.#requireRunId(),
            },
          ]),
      ...chunks.slice(1).map((contentDelta): DriverEventInput => ({
        delivery: "lossless",
        kind: "message.delta",
        payload: {
          contentDelta,
          messageId: message.id,
          role: "agent",
        },
        runId: this.#requireRunId(),
      })),
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

  #finishMessageWithOutcome(stopReason: StopReason, error: string | null): DriverEventInput[] {
    const message = this.#activeAssistantMessage;

    if (message === null) {
      return [];
    }

    this.#activeAssistantMessage = null;
    this.#lastCompletedAssistantMessage = null;

    if (message.nativeMessageId !== null) {
      this.#rememberSettledAssistantMessage(message.nativeMessageId);
    }

    if (stopReason === "cancelled") {
      return [
        {
          kind: "message.cancelled",
          payload: { messageId: message.id, reason: "cancelled", role: "agent", stopReason },
          runId: this.#requireRunId(),
        },
      ];
    }

    return [
      {
        kind: "message.failed",
        payload: {
          error: {
            code: `acp.${stopReason}`,
            message: error ?? `ACP prompt stopped with ${stopReason}.`,
            retryable: false,
          },
          messageId: message.id,
          role: "agent",
          stopReason,
        },
        runId: this.#requireRunId(),
      },
    ];
  }

  #failMessage(error: {
    readonly code: string;
    readonly message: string;
    readonly recoverable?: boolean;
  }): DriverEventInput[] {
    const message = this.#activeAssistantMessage;

    if (message === null) {
      return [];
    }

    this.#activeAssistantMessage = null;
    this.#lastCompletedAssistantMessage = null;

    if (message.nativeMessageId !== null) {
      this.#rememberSettledAssistantMessage(message.nativeMessageId);
    }

    return [
      {
        kind: "message.failed",
        payload: {
          error: {
            code: error.code,
            message: error.message,
            retryable: error.recoverable ?? false,
          },
          messageId: message.id,
          role: "agent",
        },
        runId: this.#requireRunId(),
      },
    ];
  }

  #startMessage(nativeMessageId: string): AcpAssistantMessageStart | null {
    if (this.#settledAssistantNativeMessageIds.has(nativeMessageId)) {
      return null;
    }

    return this.#startUnsettledMessage(nativeMessageId);
  }

  #startAnonymousMessage(): AcpAssistantMessageStart {
    return this.#startUnsettledMessage(null);
  }

  #startUnsettledMessage(nativeMessageId: string | null): AcpAssistantMessageStart {
    const active = this.#activeAssistantMessage;

    if (active?.nativeMessageId === nativeMessageId) {
      return { events: [], message: active };
    }

    const events = this.#finishMessage();
    const message: AcpAssistantMessageState = {
      id: createDriverId(),
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

  #assertRetainedTurnState(): void {
    this.#tools.compactHistory();
    const assistantItems =
      (this.#activeAssistantMessage === null ? 0 : 1) +
      (this.#thoughtFallbackNativeMessageId === null ? 0 : 1);
    const itemCount = assistantItems + this.#tools.openItemCount();

    if (itemCount > MAX_ACP_RETAINED_TURN_ITEMS) {
      throw new AcpTurnStateLimitError(
        `ACP turn state exceeds ${MAX_ACP_RETAINED_TURN_ITEMS} retained open items.`,
      );
    }

    const retainedState = {
      activeAssistantMessage: this.#activeAssistantMessage,
      thoughtFallback:
        this.#thoughtFallbackNativeMessageId === null
          ? null
          : {
              nativeMessageId: this.#thoughtFallbackNativeMessageId,
              text: this.#thoughtFallbackText,
            },
      tools: this.#tools.retainedOpenState(),
    };
    const bytes = Buffer.byteLength(JSON.stringify(retainedState), "utf8");

    if (bytes > MAX_ACP_RETAINED_TURN_BYTES) {
      throw new AcpTurnStateLimitError(
        `ACP turn state exceeds ${MAX_ACP_RETAINED_TURN_BYTES} retained UTF-8 bytes.`,
      );
    }
  }

  #rememberSettledAssistantMessage(nativeMessageId: string): void {
    if (this.#settledAssistantNativeMessageIds.has(nativeMessageId)) {
      return;
    }

    this.#settledAssistantNativeMessageIds.add(nativeMessageId);
    this.#settledAssistantNativeMessageIdBytes += Buffer.byteLength(
      JSON.stringify(nativeMessageId),
      "utf8",
    );

    while (
      this.#settledAssistantNativeMessageIds.size > MAX_ACP_SETTLED_MESSAGE_HISTORY_ITEMS ||
      this.#settledAssistantNativeMessageIdBytes > MAX_ACP_SETTLED_MESSAGE_HISTORY_BYTES
    ) {
      const oldest = this.#settledAssistantNativeMessageIds.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#settledAssistantNativeMessageIds.delete(oldest);
      this.#settledAssistantNativeMessageIdBytes -= Buffer.byteLength(
        JSON.stringify(oldest),
        "utf8",
      );
    }
  }

  // Tool calls must be parented to an assistant message: the session event
  // projection drops tool starts without a parent, and the prompt message id
  // would attach them to the user's bubble. ACP agents may open a tool call
  // before any assistant chunk, so start an anonymous assistant message first,
  // matching the Claude runtime's ensureMessageStarted behavior.
  #ensureToolParentMessage(toolCallId: string): DriverEventInput[] {
    if (this.#tools.hasStarted(toolCallId) || this.#activeAssistantMessage !== null) {
      return [];
    }

    return this.#startAnonymousMessage().events;
  }
}
