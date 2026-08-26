import { createHash } from "node:crypto";

import type { DriverEventInput } from "../../protocol/events";
import { createDriverId, type MessageId } from "../../protocol/id";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import type { ProtocolError } from "../../contract";
import { RuntimeAssistantMessageIdIndex } from "../runtime-turn-transcript";
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
const MAX_OPENAI_PUBLIC_NATIVE_ID_BYTES = 256;
export const MAX_OPENAI_DURABLE_EVENT_BYTES = 1_020 * 1_024;

export function assertOpenAiDurableEventFits(event: DriverEventInput, subject: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");

  if (bytes > MAX_OPENAI_DURABLE_EVENT_BYTES) {
    throw new RangeError(
      `OpenAI ${subject} exceeds durable event capacity (${String(bytes)} UTF-8 bytes).`,
    );
  }
}

function openAiNativeIdKey(nativeId: string): string {
  return Buffer.byteLength(nativeId, "utf8") <= MAX_OPENAI_PUBLIC_NATIVE_ID_BYTES
    ? nativeId
    : createHash("sha256").update(nativeId).digest("hex");
}

export class OpenAiPublicIdState {
  readonly #publicIds = new Map<string, string>();

  publicId(nativeId: string, namespace = "id"): string {
    if (Buffer.byteLength(nativeId, "utf8") <= MAX_OPENAI_PUBLIC_NATIVE_ID_BYTES) {
      return nativeId;
    }

    const key = `${namespace}:${openAiNativeIdKey(nativeId)}`;
    const existing = this.#publicIds.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const publicId = createDriverId();
    this.#publicIds.set(key, publicId);
    return publicId;
  }

  reset(): void {
    this.#publicIds.clear();
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
  readonly #itemByMessageId = new Map<MessageId, string>();
  readonly #itemMessageIds = new Map<string, MessageId>();
  readonly #reasoningEnded = new Set<string>();
  readonly #reasoningIds = new RuntimeAssistantMessageIdIndex<string>();
  readonly #reasoningParts = new Map<string, Set<number>>();
  readonly #reasoningStarted = new Set<string>();
  readonly #reasoningTextById = new Map<string, string>();
  readonly #starting = new Map<MessageId, Promise<void>>();
  readonly #started = new Set<MessageId>();
  readonly #textById = new Map<MessageId, string>();
  readonly #turnByMessageId = new Map<MessageId, string>();
  readonly #turnMessages = new RuntimeAssistantMessageIdIndex<string>();
  readonly #turnMessageIds = new Map<string, MessageId>();
  readonly #turnMessageSequences = new Map<string, number>();
  readonly #turnNextItemSequences = new Map<string, number>();

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
    const existing = this.#turnMessageIds.get(turnId);

    if (existing !== undefined) {
      await this.ensureStarted(context, existing, push);
      return existing;
    }

    const nextSequence = (this.#turnMessageSequences.get(turnId) ?? 0) + 1;
    const generated = this.#turnMessages.getOrCreate(`${turnId}:${nextSequence}`);
    await this.ensureStarted(context, generated, push);
    this.#turnMessageSequences.set(turnId, nextSequence);
    this.#turnMessageIds.set(turnId, generated);
    this.#turnByMessageId.set(generated, turnId);
    return generated;
  }

  async ensureItemMessage(
    context: AgentDriverContext,
    input: { itemId: string; turnId: string },
    push: OpenAiEventPush,
  ): Promise<MessageId> {
    const itemKey = `${input.turnId}:${input.itemId}`;
    const existing = this.#itemMessageIds.get(itemKey);

    if (existing !== undefined) {
      if (!this.#ended.has(existing)) {
        this.#turnMessageIds.set(input.turnId, existing);
      }
      await this.ensureStarted(context, existing, push);
      return existing;
    }

    const activeMessageId = this.#turnMessageIds.get(input.turnId);
    const messageId =
      activeMessageId !== undefined &&
      !this.#ended.has(activeMessageId) &&
      !this.#itemByMessageId.has(activeMessageId)
        ? activeMessageId
        : this.#turnMessages.getOrCreate(`item:${itemKey}`);

    await this.ensureStarted(context, messageId, push);
    this.#observeItem(itemKey, input.turnId);
    this.#itemMessageIds.set(itemKey, messageId);
    this.#itemByMessageId.set(messageId, itemKey);
    this.#turnMessageIds.set(input.turnId, messageId);
    this.#turnByMessageId.set(messageId, input.turnId);
    return messageId;
  }

  recordSnapshot(input: {
    itemId: string;
    messageId: MessageId;
    phase: OpenAiMessagePhase;
    text: string;
    turnId: string;
  }): boolean {
    const itemKey = `${input.turnId}:${input.itemId}`;
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
    const previous = this.#completedSnapshots.get(`${input.turnId}:${input.itemId}`);
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
    const turnId = this.#turnByMessageId.get(messageId);

    if (turnId !== undefined) {
      this.#turnByMessageId.delete(messageId);

      if (this.#turnMessageIds.get(turnId) === messageId) {
        this.#turnMessageIds.delete(turnId);
      }
    }

    return true;
  }

  isEnded(messageId: MessageId): boolean {
    return this.#ended.has(messageId);
  }

  isReasoningEnded(messageId: string): boolean {
    return this.#reasoningEnded.has(messageId);
  }

  reasoningId(itemId: string): string {
    return this.#reasoningIds.getOrCreate(itemId);
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
    return this.#turnMessageIds.get(turnId) ?? null;
  }

  reset(): void {
    this.#completedSnapshots.clear();
    this.#ended.clear();
    this.#itemSequences.clear();
    this.#itemByMessageId.clear();
    this.#itemMessageIds.clear();
    this.#reasoningEnded.clear();
    this.#reasoningIds.reset();
    this.#reasoningParts.clear();
    this.#reasoningStarted.clear();
    this.#reasoningTextById.clear();
    this.#starting.clear();
    this.#started.clear();
    this.#textById.clear();
    this.#turnByMessageId.clear();
    this.#turnMessages.reset();
    this.#turnMessageIds.clear();
    this.#turnMessageSequences.clear();
    this.#turnNextItemSequences.clear();
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
  readonly #ids = new OpenAiPublicIdState();

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
    return this.#ids.publicId(nativeId, namespace);
  }

  reset(): void {
    this.#completed.clear();
    this.#ids.reset();
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
          sourceEventId: `openai.item.started:${input.sourceScope}:${input.publicToolCallId}`,
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
          sourceEventId: `openai.tool.started:${input.sourceScope}:${input.publicToolCallId}`,
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
  readonly #turnVersions = new Map<string, number>();

  currentLength(itemId: string): number {
    return this.#plans.get(itemId)?.content.length ?? 0;
  }

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
    this.#turnVersions.clear();
  }

  turnVersion(turnId: string): number {
    return this.#turnVersions.get(turnId) ?? 0;
  }

  advanceTurnVersion(turnId: string): void {
    this.#turnVersions.set(turnId, this.turnVersion(turnId) + 1);
  }
}
