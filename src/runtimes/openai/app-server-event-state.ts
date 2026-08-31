import type { DriverEventInput } from "../../protocol/events";
import type { MessageId } from "../../protocol/id";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import type { ProtocolError } from "../../contract";
import { createRuntimeSourceEventId, toRuntimePublicId } from "../runtime-public-id";
import { createRuntimeAssistantMessageId } from "../runtime-turn-transcript";
import { toOpenAiSessionUsageSummary } from "./app-server-event-mapping";
import { readRecord } from "./app-server-json";
import type { JsonObject } from "./app-server-json";

export type OpenAiEventPush = (
  context: AgentDriverContext,
  reason: string,
  events: DriverEventInput[],
) => Promise<void>;

export type OpenAiTerminalOutcome =
  | { kind: "cancelled" }
  | { kind: "completed" }
  | { error: ProtocolError; kind: "failed" };

export type OpenAiMessagePhase = "commentary" | "final" | null;

const usageKeys = [
  "cacheWriteInputTokens",
  "cachedInputTokens",
  "inputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;
export const MAX_OPENAI_DURABLE_EVENT_BYTES = 1_020 * 1_024;

export function assertOpenAiDurableEventFits(event: DriverEventInput, subject: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");

  if (bytes > MAX_OPENAI_DURABLE_EVENT_BYTES) {
    throw new RangeError(
      `OpenAI ${subject} exceeds durable event capacity (${String(bytes)} UTF-8 bytes).`,
    );
  }
}

type OpenAiTokenUsage = Partial<Record<(typeof usageKeys)[number], number>>;

function readUsage(value: JsonObject | null): OpenAiTokenUsage {
  return Object.fromEntries(
    usageKeys.flatMap((key) => {
      const entry = value?.[key];
      return typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0
        ? [[key, entry]]
        : [];
    }),
  );
}

function subtractUsage(total: OpenAiTokenUsage, baseline: OpenAiTokenUsage): OpenAiTokenUsage {
  return Object.fromEntries(
    usageKeys.flatMap((key) => {
      const value = total[key];
      return value === undefined ? [] : [[key, Math.max(0, value - (baseline[key] ?? 0))]];
    }),
  );
}

function monotonicUsage(previous: OpenAiTokenUsage, next: OpenAiTokenUsage): OpenAiTokenUsage {
  return Object.fromEntries(
    usageKeys.flatMap((key) => {
      const value = next[key] ?? previous[key];
      return value === undefined ? [] : [[key, Math.max(value, previous[key] ?? 0)]];
    }),
  );
}

export class OpenAiSessionUsageState {
  #lastTotal: OpenAiTokenUsage | null = null;
  readonly #turns = new Map<string, { baseline: OpenAiTokenUsage; current: OpenAiTokenUsage }>();

  prepareUpdate(turnId: string | null, params: JsonObject) {
    const tokenUsage = readRecord(params, "tokenUsage");
    const total = readUsage(readRecord(tokenUsage, "total"));
    const last = readUsage(readRecord(tokenUsage, "last"));
    const previous = turnId === null ? undefined : this.#turns.get(turnId);
    const baseline = previous?.baseline ?? this.#lastTotal ?? subtractUsage(total, last);
    const current = monotonicUsage(previous?.current ?? {}, subtractUsage(total, baseline));

    if (turnId === null) {
      return {
        commit: () => {
          this.#lastTotal = monotonicUsage(this.#lastTotal ?? {}, total);
        },
        usage: null,
      };
    }
    const changed = usageKeys.some((key) => (current[key] ?? 0) > (previous?.current[key] ?? 0));

    return {
      commit: () => {
        this.#lastTotal = monotonicUsage(this.#lastTotal ?? {}, total);
        this.#turns.set(turnId, { baseline, current });
      },
      usage: changed
        ? toOpenAiSessionUsageSummary({
            contextWindow:
              typeof tokenUsage?.["modelContextWindow"] === "number" &&
              Number.isSafeInteger(tokenUsage["modelContextWindow"]) &&
              tokenUsage["modelContextWindow"] >= 0
                ? tokenUsage["modelContextWindow"]
                : null,
            usage: current,
            used: last["totalTokens"] ?? null,
          })
        : null,
    };
  }

  release(turnId: string): void {
    this.#turns.delete(turnId);
  }

  reset(): void {
    this.#turns.clear();
    this.#lastTotal = null;
  }
}

export class OpenAiMessageState {
  readonly #completedSnapshots = new Map<
    string,
    {
      itemId: string;
      messageId: MessageId;
      phase: OpenAiMessagePhase;
      sequence: number;
      text: string;
      turnId: string;
    }
  >();
  readonly #ended = new Set<MessageId>();
  readonly #itemSequences = new Map<string, number>();
  readonly #itemMessageIds = new Map<string, MessageId>();
  readonly #reasoningEnded = new Set<string>();
  readonly #reasoningParts = new Map<string, Set<number>>();
  readonly #reasoningStarted = new Set<string>();
  readonly #reasoningTextById = new Map<string, string>();
  readonly #starting = new Map<MessageId, Promise<void>>();
  readonly #started = new Set<MessageId>();
  readonly #textById = new Map<MessageId, string>();
  readonly #turnNextItemSequences = new Map<string, number>();
  readonly #turnParentMessageIds = new Map<string, MessageId>();

  appendText(messageId: MessageId, delta: string): void {
    if (delta.length === 0 || this.#ended.has(messageId)) {
      return;
    }

    this.#textById.set(messageId, `${this.#textById.get(messageId) ?? ""}${delta}`);
  }

  currentText(messageId: MessageId): string {
    return this.#textById.get(messageId) ?? "";
  }

  setText(messageId: MessageId, text: string): void {
    this.#textById.set(messageId, text);
  }

  ensureReasoning(messageId: string, events: DriverEventInput[], commit = true): void {
    if (this.#reasoningEnded.has(messageId) || this.#reasoningStarted.has(messageId)) {
      return;
    }

    if (commit) {
      this.#reasoningStarted.add(messageId);
    }
    events.push({
      kind: "thought.started",
      payload: {
        channel: "summary",
        thoughtId: messageId,
      },
      sourceEventId: `openai.thought.started:${messageId}`,
    });
  }

  appendReasoningText(messageId: string, delta: string): void {
    if (delta.length === 0 || this.#reasoningEnded.has(messageId)) {
      return;
    }

    this.#reasoningTextById.set(
      messageId,
      `${this.#reasoningTextById.get(messageId) ?? ""}${delta}`,
    );
  }

  beginReasoningPart(messageId: string, summaryIndex: number, commit = true): boolean {
    if (this.#reasoningEnded.has(messageId)) {
      return false;
    }

    const parts = this.#reasoningParts.get(messageId) ?? new Set<number>();

    if (parts.has(summaryIndex)) {
      return false;
    }

    if (commit) {
      this.#reasoningParts.set(messageId, parts);
      parts.add(summaryIndex);
    }
    return true;
  }

  currentReasoningText(messageId: string): string {
    return this.#reasoningTextById.get(messageId) ?? "";
  }

  terminalEvents(outcome: OpenAiTerminalOutcome): DriverEventInput[] {
    const events: DriverEventInput[] = [];

    for (const messageId of this.#started) {
      events.push(
        outcome.kind === "completed"
          ? {
              kind: "message.completed",
              payload: { messageId, role: "agent" },
            }
          : outcome.kind === "cancelled"
            ? {
                kind: "message.cancelled",
                payload: { messageId, role: "agent" },
              }
            : {
                kind: "message.failed",
                payload: { error: outcome.error, messageId, role: "agent" },
              },
      );
    }

    for (const thoughtId of this.#reasoningStarted) {
      events.push({
        kind: outcome.kind === "completed" ? "thought.completed" : "thought.cancelled",
        payload: {
          channel: "summary",
          thoughtId,
        },
      });
    }

    return events;
  }

  async ensureTurnMessage(
    context: AgentDriverContext,
    turnId: string,
    push: OpenAiEventPush,
  ): Promise<MessageId> {
    const existing = this.#turnParentMessageIds.get(turnId);

    if (existing !== undefined) {
      await this.ensureStarted(context, existing, push);
      return existing;
    }

    const generated = createRuntimeAssistantMessageId(
      context.payload.execution.run.sessionId,
      "openai-message",
      `turn:${JSON.stringify(turnId)}`,
    );
    await this.ensureStarted(context, generated, push);
    this.#turnParentMessageIds.set(turnId, generated);
    return generated;
  }

  async ensureItemMessage(
    context: AgentDriverContext,
    input: { itemId: string; turnId: string },
    push: OpenAiEventPush,
  ): Promise<MessageId> {
    const itemKey = JSON.stringify([input.turnId, input.itemId]);
    const existing = this.#itemMessageIds.get(itemKey);

    if (existing !== undefined) {
      await this.ensureStarted(context, existing, push);
      return existing;
    }

    const messageId = createRuntimeAssistantMessageId(
      context.payload.execution.run.sessionId,
      "openai-message",
      `item:${itemKey}`,
    );

    await this.ensureStarted(context, messageId, push);
    this.#observeItem(itemKey, input.turnId);
    this.#itemMessageIds.set(itemKey, messageId);
    return messageId;
  }

  recordSnapshot(input: {
    itemId: string;
    messageId: MessageId;
    phase: OpenAiMessagePhase;
    text: string;
    turnId: string;
  }): boolean {
    const itemKey = JSON.stringify([input.turnId, input.itemId]);
    const sequence = this.#observeItem(itemKey, input.turnId);
    if (!this.needsSnapshot(input)) {
      return false;
    }

    this.#completedSnapshots.set(itemKey, { ...input, sequence });
    return true;
  }

  needsSnapshot(input: {
    itemId: string;
    messageId: MessageId;
    phase: OpenAiMessagePhase;
    text: string;
    turnId: string;
  }): boolean {
    const previous = this.#completedSnapshots.get(JSON.stringify([input.turnId, input.itemId]));
    return (
      previous?.messageId !== input.messageId ||
      previous.phase !== input.phase ||
      previous.text !== input.text
    );
  }

  finalSnapshot(turnId: string): { id: MessageId; text: string } | null {
    const turnSnapshots = [...this.#completedSnapshots.values()].filter(
      (snapshot) => snapshot.turnId === turnId,
    );
    const hasExplicitPhase = turnSnapshots.some((snapshot) => snapshot.phase !== null);
    let finalSnapshot:
      | {
          itemId: string;
          messageId: MessageId;
          phase: OpenAiMessagePhase;
          sequence: number;
          text: string;
          turnId: string;
        }
      | undefined;

    for (const snapshot of turnSnapshots) {
      if (
        (hasExplicitPhase && snapshot.phase !== "final") ||
        (!hasExplicitPhase && snapshot.phase !== null)
      ) {
        continue;
      }

      if (finalSnapshot === undefined || snapshot.sequence > finalSnapshot.sequence) {
        finalSnapshot = snapshot;
      }
    }

    return finalSnapshot === undefined
      ? null
      : { id: finalSnapshot.messageId, text: finalSnapshot.text };
  }

  async ensureStarted(
    context: AgentDriverContext,
    messageId: MessageId,
    push: OpenAiEventPush,
  ): Promise<void> {
    if (this.#ended.has(messageId) || this.#started.has(messageId)) {
      return;
    }

    const existing = this.#starting.get(messageId);

    if (existing !== undefined) {
      await existing;
      return;
    }

    const starting = (async () => {
      await push(context, "driver.openai.message.started", [
        {
          kind: "message.started",
          payload: {
            messageId,
            role: "agent",
          },
          sourceEventId: `openai.message.started:${messageId}`,
        },
      ]);
      this.#started.add(messageId);
    })();
    this.#starting.set(messageId, starting);

    try {
      await starting;
    } finally {
      if (this.#starting.get(messageId) === starting) {
        this.#starting.delete(messageId);
      }
    }
  }

  markEnded(messageId: MessageId): boolean {
    if (this.#ended.has(messageId)) {
      return false;
    }

    this.#ended.add(messageId);
    this.#started.delete(messageId);
    return true;
  }

  isEnded(messageId: MessageId): boolean {
    return this.#ended.has(messageId);
  }

  isReasoningEnded(messageId: string): boolean {
    return this.#reasoningEnded.has(messageId);
  }

  reasoningId(context: AgentDriverContext, itemId: string): MessageId {
    return createRuntimeAssistantMessageId(
      context.payload.execution.run.sessionId,
      "openai-reasoning",
      itemId,
    );
  }

  isReasoningStarted(messageId: string): boolean {
    return this.#reasoningStarted.has(messageId);
  }

  markReasoningEnded(messageId: string): boolean {
    if (this.#reasoningEnded.has(messageId) || !this.#reasoningStarted.has(messageId)) {
      return false;
    }

    this.#reasoningEnded.add(messageId);
    this.#reasoningStarted.delete(messageId);
    return true;
  }

  messageForTurn(turnId: string): MessageId | null {
    return this.#turnParentMessageIds.get(turnId) ?? null;
  }

  reset(): void {
    this.#completedSnapshots.clear();
    this.#ended.clear();
    this.#itemSequences.clear();
    this.#itemMessageIds.clear();
    this.#reasoningEnded.clear();
    this.#reasoningParts.clear();
    this.#reasoningStarted.clear();
    this.#reasoningTextById.clear();
    this.#starting.clear();
    this.#started.clear();
    this.#textById.clear();
    this.#turnNextItemSequences.clear();
    this.#turnParentMessageIds.clear();
  }

  #observeItem(itemKey: string, turnId: string): number {
    const existing = this.#itemSequences.get(itemKey);

    if (existing !== undefined) {
      return existing;
    }

    const sequence = (this.#turnNextItemSequences.get(turnId) ?? 0) + 1;
    this.#turnNextItemSequences.set(turnId, sequence);
    this.#itemSequences.set(itemKey, sequence);
    return sequence;
  }
}

export class OpenAiItemState {
  readonly #completed = new Set<string>();

  isCompleted(itemId: string): boolean {
    return this.#completed.has(itemId);
  }

  markCompleted(itemId: string): boolean {
    if (this.#completed.has(itemId)) {
      return false;
    }

    this.#completed.add(itemId);
    return true;
  }

  publicId(nativeId: string, namespace: "item" | "turn" = "item"): string {
    return toRuntimePublicId(nativeId, namespace === "item" ? "openai-item" : "openai-turn");
  }

  reset(): void {
    this.#completed.clear();
  }
}

export class OpenAiToolState {
  readonly #parentMessages = new Map<
    string,
    { parentMessageId: MessageId; publicToolCallId: string }
  >();
  readonly #starting = new Map<string, Promise<void>>();

  parentMessage(toolCallId: string): MessageId | null {
    return this.#parentMessages.get(toolCallId)?.parentMessageId ?? null;
  }

  publicToolCallId(toolCallId: string): string | null {
    return this.#parentMessages.get(toolCallId)?.publicToolCallId ?? null;
  }

  async ensureStarted(
    context: AgentDriverContext,
    push: OpenAiEventPush,
    input: {
      parentMessageId: MessageId;
      publicToolCallId: string;
      reason: string;
      sourceScope: string;
      toolCallId: string;
      toolCallName: string;
    },
  ): Promise<void> {
    if (this.#parentMessages.has(input.toolCallId)) {
      return;
    }

    const existing = this.#starting.get(input.toolCallId);

    if (existing !== undefined) {
      await existing;
      return;
    }

    const starting = (async () => {
      const events: DriverEventInput[] = [
        {
          kind: "item.started",
          payload: {
            itemId: input.publicToolCallId,
            itemType: "tool_call",
            parentMessageId: input.parentMessageId,
            title: input.toolCallName,
          },
          sourceEventId: createRuntimeSourceEventId(
            "openai.item.started",
            input.sourceScope,
            input.publicToolCallId,
          ),
        },
        {
          kind: "tool.call.updated",
          payload: {
            kind: "tool",
            parentMessageId: input.parentMessageId,
            status: "running",
            title: input.toolCallName,
            toolCallId: input.publicToolCallId,
          },
          sourceEventId: createRuntimeSourceEventId(
            "openai.tool.started",
            input.sourceScope,
            input.publicToolCallId,
          ),
        },
      ];
      for (const event of events) {
        assertOpenAiDurableEventFits(event, "tool start");
      }
      await push(context, input.reason, events);
      this.#parentMessages.set(input.toolCallId, {
        parentMessageId: input.parentMessageId,
        publicToolCallId: input.publicToolCallId,
      });
    })();
    this.#starting.set(input.toolCallId, starting);

    try {
      await starting;
    } finally {
      if (this.#starting.get(input.toolCallId) === starting) {
        this.#starting.delete(input.toolCallId);
      }
    }
  }

  terminalEvents(outcome: OpenAiTerminalOutcome): DriverEventInput[] {
    const status =
      outcome.kind === "completed"
        ? "completed"
        : outcome.kind === "cancelled"
          ? "cancelled"
          : "failed";
    const events = [...this.#parentMessages.values()].flatMap<DriverEventInput>(
      ({ publicToolCallId }) => [
        {
          kind: "tool.call.updated",
          payload: {
            status,
            toolCallId: publicToolCallId,
          },
        },
        {
          kind: "item.completed",
          payload: {
            itemId: publicToolCallId,
            itemType: "tool_call",
            status,
          },
        },
      ],
    );
    return events;
  }

  markEnded(toolCallId: string): void {
    this.#parentMessages.delete(toolCallId);
  }

  reset(): void {
    this.#parentMessages.clear();
    this.#starting.clear();
  }
}

export class OpenAiPlanState {
  readonly #plans = new Map<string, { content: string; status: "completed" | "in_progress" }>();

  appendDelta(itemId: string, delta: string): void {
    const current = this.#plans.get(itemId);
    this.#plans.set(itemId, {
      content: `${current?.content ?? ""}${delta}`,
      status: "in_progress",
    });
  }

  createDeltaEvent(itemId: string, delta: string): DriverEventInput {
    const plans = new Map(this.#plans);
    const current = plans.get(itemId);
    plans.set(itemId, {
      content: `${current?.content ?? ""}${delta}`,
      status: "in_progress",
    });
    return this.#createEvent(plans);
  }

  createCompletedEvent(itemId: string, content: string): DriverEventInput {
    const plans = new Map(this.#plans);
    plans.set(itemId, { content, status: "completed" });
    return this.#createEvent(plans);
  }

  #createEvent(
    plans: ReadonlyMap<string, { content: string; status: "completed" | "in_progress" }>,
  ): DriverEventInput {
    return {
      kind: "plan.updated",
      payload: {
        entries: [...plans.values()]
          .filter((entry) => entry.content.trim().length > 0)
          .map((entry) => ({
            content: entry.content.trim(),
            priority: "medium",
            status: entry.status,
          })),
        source: "driver",
      },
    };
  }

  setCompleted(itemId: string, content: string): void {
    this.#plans.set(itemId, {
      content,
      status: "completed",
    });
  }

  reset(): void {
    this.#plans.clear();
  }
}
