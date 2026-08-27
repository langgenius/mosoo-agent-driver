import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ProtocolError } from "../../contract";
import type { DriverEventInput } from "../../protocol/events";
import type { MessageId, RunId } from "../../protocol/id";
import type { JsonValue } from "../../protocol/json";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { chunkJsonText } from "../provider-json";
import type { JsonObject } from "./agent-sdk-json";
import { toClaudeDiagnosticEvent, toClaudeUsageUpdatedEvents } from "./agent-sdk-message-events";

const MAX_CLAUDE_MESSAGE_CHUNK_BYTES = 512 * 1_024;
const MAX_CLAUDE_DURABLE_EVENT_BYTES = 1_020 * 1_024;

function claudeDurableEventBytes(event: DriverEventInput): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

export class ClaudeDurableEventTooLargeError extends RangeError {
  readonly code: string;

  constructor(code: string, subject: string, bytes: number) {
    super(`Claude ${subject} exceeds durable event capacity (${String(bytes)} UTF-8 bytes).`);
    this.code = code;
    this.name = "ClaudeDurableEventTooLargeError";
  }
}

export function assertClaudeDurableEventFits(
  event: DriverEventInput,
  code: string,
  subject: string,
): void {
  const bytes = claudeDurableEventBytes(event);

  if (bytes > MAX_CLAUDE_DURABLE_EVENT_BYTES) {
    throw new ClaudeDurableEventTooLargeError(code, subject, bytes);
  }
}

interface ClaudeAgentSdkEventWriterOptions {
  push(context: AgentDriverContext, reason: string, events: DriverEventInput[]): Promise<void>;
}

export interface ClaudeToolStartEvent {
  context: AgentDriverContext;
  parentMessageId?: string;
  toolCallId: string;
  toolCallName: string;
}

export interface ClaudeTextDeltaEvent {
  context: AgentDriverContext;
  delta: string;
  messageId: string;
  reason: string;
}

export interface ClaudeThoughtDeltaEvent {
  context: AgentDriverContext;
  delta: string;
  thoughtId: string;
}

export interface ClaudeToolArgumentsEvent {
  context: AgentDriverContext;
  delta: string;
  reason: string;
  toolCallId: string;
}

export interface ClaudeToolResultEvent {
  agentId?: string;
  authoritative?: boolean;
  content: string;
  context: AgentDriverContext;
  decisionReason?: string;
  decisionReasonType?: string;
  messageId?: string;
  nonExecutionKind?: string;
  rawInput?: string;
  status: "cancelled" | "completed" | "failed";
  structuredOutput?: JsonValue;
  toolCallId: string;
  toolCallName?: string;
  userFeedback?: string;
}

export interface ClaudeTurnClosure {
  readonly commit: () => void;
  readonly events: readonly DriverEventInput[];
}

type ClaudeMessageSettlement =
  | { readonly status: "cancelled" | "completed" }
  | { readonly error: ProtocolError; readonly status: "failed" };

export class ClaudeAgentSdkEventWriter {
  readonly #messageEnded = new Set<string>();
  readonly #messageRetracted = new Set<string>();
  readonly #messageSealed = new Set<string>();
  readonly #messageStarted = new Set<string>();
  readonly #options: ClaudeAgentSdkEventWriterOptions;
  readonly #thoughtEnded = new Set<string>();
  readonly #thoughtStarted = new Set<string>();
  readonly #toolEnded = new Set<string>();
  readonly #toolParentMessage = new Map<string, string>();
  readonly #toolStarted = new Set<string>();
  readonly #toolRetracted = new Set<string>();

  constructor(options: ClaudeAgentSdkEventWriterOptions) {
    this.#options = options;
  }

  hasToolStarted(toolCallId: string): boolean {
    return this.#toolStarted.has(toolCallId);
  }

  resetTurnState(): void {
    this.#messageEnded.clear();
    this.#messageRetracted.clear();
    this.#messageSealed.clear();
    this.#messageStarted.clear();
    this.#thoughtEnded.clear();
    this.#thoughtStarted.clear();
    this.#toolEnded.clear();
    this.#toolParentMessage.clear();
    this.#toolStarted.clear();
    this.#toolRetracted.clear();
  }

  toolParentMessageId(toolCallId: string): string | null {
    return this.#toolParentMessage.get(toolCallId) ?? null;
  }

  async settleMessage(
    context: AgentDriverContext,
    messageId: string,
    settlement: ClaudeMessageSettlement,
  ): Promise<boolean> {
    if (!this.#messageStarted.has(messageId) || this.#messageEnded.has(messageId)) {
      return false;
    }

    const event: DriverEventInput =
      settlement.status === "failed"
        ? {
            kind: "message.failed",
            payload: { error: settlement.error, messageId, role: "agent" },
          }
        : {
            kind: settlement.status === "completed" ? "message.completed" : "message.cancelled",
            payload: { messageId, role: "agent" },
          };
    await this.#options.push(
      context,
      settlement.status === "completed"
        ? "driver.claude.message.ended"
        : `driver.claude.message.${settlement.status}`,
      [event],
    );
    this.#messageEnded.add(messageId);
    return true;
  }

  async retractMessage(context: AgentDriverContext, messageId: string): Promise<void> {
    if (!this.#messageStarted.has(messageId) || this.#messageRetracted.has(messageId)) {
      return;
    }

    await this.#options.push(context, "driver.claude.message.retracted", [
      {
        kind: "message.cancelled",
        payload: { messageId, reason: "superseded", role: "agent" },
      },
    ]);
    this.#messageRetracted.add(messageId);
    this.#messageEnded.add(messageId);
  }

  async retractTool(context: AgentDriverContext, toolCallId: string): Promise<void> {
    if (!this.#toolStarted.has(toolCallId) || this.#toolRetracted.has(toolCallId)) {
      return;
    }

    const ended = this.#toolEnded.has(toolCallId);
    await this.#options.push(context, "driver.claude.tool.retracted", [
      {
        kind: "tool.call.updated",
        payload: { status: "cancelled", toolCallId },
      },
      ...(ended
        ? []
        : [
            {
              kind: "item.completed" as const,
              payload: { itemId: toolCallId, itemType: "tool_call", status: "cancelled" },
            },
          ]),
    ]);
    this.#toolRetracted.add(toolCallId);
    this.#toolEnded.add(toolCallId);
  }

  async ensureMessageStarted(context: AgentDriverContext, messageId: string): Promise<void> {
    if (this.#messageStarted.has(messageId)) {
      return;
    }

    await this.#options.push(context, "driver.claude.message.started", [
      {
        kind: "message.started",
        payload: {
          messageId,
          role: "agent",
        },
      },
    ]);
    this.#messageStarted.add(messageId);
  }

  async ensureToolStarted({
    context,
    parentMessageId,
    toolCallId,
    toolCallName,
  }: ClaudeToolStartEvent): Promise<void> {
    if (this.#toolStarted.has(toolCallId)) {
      return;
    }

    const events: DriverEventInput[] = [
      {
        kind: "item.started",
        payload: {
          itemId: toolCallId,
          itemType: "tool_call",
          ...(parentMessageId === undefined ? {} : { parentMessageId }),
          title: toolCallName,
        },
      },
      {
        kind: "tool.call.updated",
        payload: {
          kind: "tool",
          ...(parentMessageId === undefined ? {} : { parentMessageId }),
          status: "running",
          title: toolCallName,
          toolCallId,
        },
      },
    ];

    for (const event of events) {
      assertClaudeDurableEventFits(event, "claude.tool_start_too_large", "tool start");
    }

    if (parentMessageId !== undefined) {
      await this.ensureMessageStarted(context, parentMessageId);
    }
    await this.#options.push(context, "driver.claude.tool.started", events);
    if (parentMessageId !== undefined) {
      this.#toolParentMessage.set(toolCallId, parentMessageId);
    }
    this.#toolStarted.add(toolCallId);
  }

  async pushDiagnostic(context: AgentDriverContext, message: SDKMessage): Promise<void> {
    await this.pushRawDiagnostic(
      context,
      "driver.claude.diagnostic",
      toClaudeDiagnosticEvent(message),
    );
  }

  async pushRawDiagnostic(
    context: AgentDriverContext,
    reason: string,
    event: JsonObject,
    options: {
      readonly message?: string;
      readonly severity?: "error" | "info" | "warn";
    } = {},
  ): Promise<void> {
    await this.#options.push(context, reason, [
      {
        delivery: "best_effort",
        kind: "diagnostic.reported",
        payload: {
          message: options.message ?? reason,
          raw: event,
          severity: options.severity ?? "info",
        },
        visibility: "owner_debug",
      },
    ]);
  }

  runError(
    runId: RunId,
    code: string,
    message: string,
    retryable: boolean,
    details?: JsonObject,
  ): DriverEventInput {
    const event: DriverEventInput = {
      kind: "run.failed",
      payload: {
        error: {
          code,
          ...(details === undefined ? {} : { details }),
          message,
          retryable,
        },
        recoverable: retryable,
      },
      runId,
    };

    if (claudeDurableEventBytes(event) <= MAX_CLAUDE_DURABLE_EVENT_BYTES) {
      return event;
    }

    return {
      kind: "run.failed",
      payload: {
        error: {
          code,
          details: {
            ...(details === undefined
              ? {}
              : { originalDetailsUtf8Bytes: Buffer.byteLength(JSON.stringify(details), "utf8") }),
            originalMessageUtf8Bytes: Buffer.byteLength(message, "utf8"),
          },
          message: "Claude Agent SDK failure exceeded durable event capacity.",
          retryable,
        },
        recoverable: retryable,
      },
      runId,
    };
  }

  runFinished(
    runId: RunId,
    finalMessage: { readonly id: MessageId } | null,
    structuredOutput?: JsonValue,
  ): DriverEventInput {
    return {
      runId,
      kind: "run.completed",
      payload: {
        ...(finalMessage === null
          ? {}
          : {
              finalMessageId: finalMessage.id,
            }),
        stopReason: "end_turn",
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
      },
    };
  }

  runCancelled(runId: RunId, reason: string): DriverEventInput {
    const event: DriverEventInput = {
      kind: "run.cancelled",
      payload: { reason, stopReason: "cancelled" },
      runId,
    };

    if (claudeDurableEventBytes(event) <= MAX_CLAUDE_DURABLE_EVENT_BYTES) {
      return event;
    }

    return {
      kind: "run.cancelled",
      payload: {
        originalReasonUtf8Bytes: Buffer.byteLength(reason, "utf8"),
        reason: "Claude cancellation reason exceeded durable event capacity.",
        stopReason: "cancelled",
      },
      runId,
    };
  }

  async pushMessageSnapshot(
    context: AgentDriverContext,
    messageId: string,
    text: string,
    metadata: JsonObject = {},
  ): Promise<boolean> {
    if (this.#messageEnded.has(messageId)) {
      return false;
    }

    await this.ensureMessageStarted(context, messageId);
    const chunks = chunkJsonText(text, MAX_CLAUDE_MESSAGE_CHUNK_BYTES);
    const events: DriverEventInput[] = [
      {
        kind: "message.added",
        payload: {
          ...metadata,
          content: [{ text: chunks[0]!, type: "text" }],
          messageId,
          role: "agent",
        },
      },
      ...chunks.slice(1).map((contentDelta): DriverEventInput => ({
        kind: "message.delta",
        payload: { contentDelta, messageId, role: "agent" },
      })),
    ];

    for (const event of events) {
      assertClaudeDurableEventFits(
        event,
        "claude.message_snapshot_too_large",
        `message snapshot ${messageId}`,
      );
    }

    await this.#options.push(context, "driver.claude.message.snapshot", events);
    return true;
  }

  sealMessage(messageId: string): void {
    this.#messageSealed.add(messageId);
  }

  async pushSessionInfoUpdated(context: AgentDriverContext, resetTitle = false): Promise<void> {
    await this.#options.push(context, "driver.claude.session.info", [
      {
        kind: "session.info.updated",
        payload: {
          ...(resetTitle ? { title: null } : {}),
          updatedAt: new Date().toISOString(),
        },
      },
    ]);
  }

  async pushTextDelta({
    context,
    delta,
    messageId,
    reason,
  }: ClaudeTextDeltaEvent): Promise<boolean> {
    if (this.#messageEnded.has(messageId) || this.#messageSealed.has(messageId)) {
      return false;
    }

    await this.ensureMessageStarted(context, messageId);
    await this.#options.push(context, reason, [
      {
        delivery: "best_effort",
        kind: "message.delta",
        payload: {
          contentDelta: delta,
          messageId,
          role: "agent",
        },
      },
    ]);
    return true;
  }

  async ensureThoughtStarted(context: AgentDriverContext, thoughtId: string): Promise<void> {
    if (this.#thoughtStarted.has(thoughtId)) {
      return;
    }

    await this.#options.push(context, "driver.claude.thought.started", [
      {
        kind: "thought.started",
        payload: {
          channel: "summary",
          thoughtId,
        },
      },
    ]);
    this.#thoughtStarted.add(thoughtId);
  }

  async pushThoughtDelta({ context, delta, thoughtId }: ClaudeThoughtDeltaEvent): Promise<void> {
    if (this.#thoughtEnded.has(thoughtId)) {
      return;
    }

    await this.ensureThoughtStarted(context, thoughtId);
    await this.#options.push(context, "driver.claude.thought.delta", [
      {
        delivery: "best_effort",
        kind: "thought.delta",
        payload: {
          channel: "summary",
          contentDelta: delta,
          thoughtId,
        },
      },
    ]);
  }

  async settleThought(
    context: AgentDriverContext,
    thoughtId: string,
    status: "cancelled" | "completed",
  ): Promise<void> {
    if (!this.#thoughtStarted.has(thoughtId) || this.#thoughtEnded.has(thoughtId)) {
      return;
    }

    await this.#options.push(context, `driver.claude.thought.${status}`, [
      {
        kind: status === "completed" ? "thought.completed" : "thought.cancelled",
        payload: { channel: "summary", thoughtId },
      },
    ]);
    this.#thoughtEnded.add(thoughtId);
  }

  async pushToolArguments({
    context,
    delta,
    reason,
    toolCallId,
  }: ClaudeToolArgumentsEvent): Promise<void> {
    if (this.#toolEnded.has(toolCallId)) {
      return;
    }

    await this.#options.push(context, reason, [
      {
        delivery: "best_effort",
        kind: "tool.call.updated",
        payload: {
          rawInput: delta,
          status: "running",
          toolCallId,
        },
      },
    ]);
  }

  async pushToolSnapshot(
    context: AgentDriverContext,
    toolCallId: string,
    rawInput: string,
  ): Promise<void> {
    if (this.#toolEnded.has(toolCallId)) {
      return;
    }

    const event: DriverEventInput = {
      kind: "tool.call.updated",
      payload: {
        rawInput,
        status: "running",
        toolCallId,
      },
    };
    assertClaudeDurableEventFits(event, "claude.tool_input_too_large", `tool input ${toolCallId}`);
    await this.#options.push(context, "driver.claude.tool.snapshot", [event]);
  }

  async finishTools(
    context: AgentDriverContext,
    status: "cancelled" | "completed" | "failed",
  ): Promise<void> {
    const toolCallIds = [...this.#toolStarted].filter((id) => !this.#toolEnded.has(id));

    if (toolCallIds.length === 0) {
      return;
    }

    await this.#options.push(
      context,
      "driver.claude.tools.finished",
      toolCallIds.flatMap((toolCallId): DriverEventInput[] => [
        {
          kind: "tool.call.updated",
          payload: { status, toolCallId },
        },
        {
          kind: "item.completed",
          payload: { itemId: toolCallId, itemType: "tool_call", status },
        },
      ]),
    );
    for (const toolCallId of toolCallIds) {
      this.#toolEnded.add(toolCallId);
    }
  }

  prepareTurnClosure(status: "cancelled" | "completed" | "failed"): ClaudeTurnClosure {
    const messageIds = [...this.#messageStarted].filter((id) => !this.#messageEnded.has(id));
    const thoughtIds = [...this.#thoughtStarted].filter((id) => !this.#thoughtEnded.has(id));
    const toolCallIds = [...this.#toolStarted].filter((id) => !this.#toolEnded.has(id));
    const events: DriverEventInput[] = [
      ...thoughtIds.map((thoughtId): DriverEventInput => ({
        kind: status === "completed" ? "thought.completed" : "thought.cancelled",
        payload: { channel: "summary", thoughtId },
      })),
      ...messageIds.map((messageId): DriverEventInput => ({
        kind:
          status === "cancelled"
            ? "message.cancelled"
            : status === "failed"
              ? "message.failed"
              : "message.completed",
        payload:
          status === "failed"
            ? {
                error: {
                  code: "claude.turn_failed",
                  message: "Claude Agent SDK turn failed.",
                  retryable: false,
                },
                messageId,
                role: "agent",
              }
            : { messageId, role: "agent" },
      })),
      ...toolCallIds.flatMap((toolCallId): DriverEventInput[] => [
        {
          kind: "tool.call.updated",
          payload: { status, toolCallId },
        },
        {
          kind: "item.completed",
          payload: { itemId: toolCallId, itemType: "tool_call", status },
        },
      ]),
    ];

    return {
      commit: () => {
        for (const thoughtId of thoughtIds) this.#thoughtEnded.add(thoughtId);
        for (const messageId of messageIds) this.#messageEnded.add(messageId);
        for (const toolCallId of toolCallIds) this.#toolEnded.add(toolCallId);
      },
      events,
    };
  }

  async pushToolResult({
    agentId,
    authoritative = false,
    content,
    context,
    decisionReason,
    decisionReasonType,
    messageId,
    nonExecutionKind,
    rawInput,
    status,
    structuredOutput,
    toolCallId,
    toolCallName,
    userFeedback,
  }: ClaudeToolResultEvent): Promise<void> {
    if (this.#toolRetracted.has(toolCallId)) {
      return;
    }

    const ended = this.#toolEnded.has(toolCallId);

    if (ended && !authoritative) {
      return;
    }

    const events: DriverEventInput[] = [
      {
        kind: "tool.call.updated",
        payload: {
          ...(agentId === undefined ? {} : { agentId }),
          content,
          ...(decisionReason === undefined ? {} : { decisionReason }),
          ...(decisionReasonType === undefined ? {} : { decisionReasonType }),
          ...(messageId === undefined ? {} : { messageId }),
          ...(nonExecutionKind === undefined ? {} : { nonExecutionKind }),
          ...(rawInput === undefined ? {} : { rawInput }),
          status,
          ...(structuredOutput === undefined ? {} : { structuredOutput }),
          ...(toolCallName === undefined ? {} : { title: toolCallName }),
          toolCallId,
          ...(userFeedback === undefined ? {} : { userFeedback }),
        },
      },
    ];

    assertClaudeDurableEventFits(
      events[0]!,
      "claude.tool_result_too_large",
      `tool result ${toolCallId}`,
    );

    if (!ended && this.#toolStarted.has(toolCallId)) {
      events.push({
        kind: "item.completed",
        payload: {
          itemId: toolCallId,
          itemType: "tool_call",
          status,
        },
      });
    }

    await this.#options.push(context, "driver.claude.tool.result", events);
    if (!ended && this.#toolStarted.has(toolCallId)) {
      this.#toolEnded.add(toolCallId);
    }
  }

  async pushUsage(
    context: AgentDriverContext,
    usage: JsonObject | null,
    costAmount: number | null,
  ): Promise<void> {
    const events = toClaudeUsageUpdatedEvents(usage, costAmount);

    if (events.length === 0) {
      return;
    }

    await this.#options.push(context, "driver.claude.usage.updated", events);
  }
}
