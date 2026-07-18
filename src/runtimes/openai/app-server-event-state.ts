import type { DriverEventInput } from "../../protocol/events";
import type { MessageId } from "../../protocol/id";
import type { AgentDriverContext } from "../agent-driver-backend";
import { RuntimeAssistantMessageIdIndex } from "../runtime-turn-transcript";

export type OpenAiEventPush = (
  context: AgentDriverContext,
  reason: string,
  events: DriverEventInput[],
) => Promise<void>;

export class OpenAiMessageState {
  readonly #completedSnapshots = new Map<
    string,
    {
      itemId: string;
      messageId: MessageId;
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
  readonly #reasoningStarted = new Set<string>();
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

  ensureReasoning(messageId: string, events: DriverEventInput[]): void {
    if (this.#reasoningEnded.has(messageId) || this.#reasoningStarted.has(messageId)) {
      return;
    }

    this.#reasoningStarted.add(messageId);
    events.push({
      kind: "thought.started",
      payload: {
        channel: "summary",
        thoughtId: messageId,
      },
    });
  }

  finishOpen(): DriverEventInput[] {
    const events: DriverEventInput[] = [];

    for (const messageId of this.#started) {
      this.markEnded(messageId);
      events.push({
        kind: "message.completed",
        payload: {
          messageId,
          role: "agent",
        },
      });
    }

    for (const thoughtId of this.#reasoningStarted) {
      if (this.markReasoningEnded(thoughtId)) {
        events.push({
          kind: "thought.completed",
          payload: {
            channel: "summary",
            thoughtId,
          },
        });
      }
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
    this.#turnMessageSequences.set(turnId, nextSequence);
    const generated = this.#turnMessages.getOrCreate(`${turnId}:${nextSequence}`);
    this.#turnMessageIds.set(turnId, generated);
    this.#turnByMessageId.set(generated, turnId);
    await this.ensureStarted(context, generated, push);
    return generated;
  }

  async ensureItemMessage(
    context: AgentDriverContext,
    input: { itemId: string; turnId: string },
    push: OpenAiEventPush,
  ): Promise<MessageId> {
    const itemKey = `${input.turnId}:${input.itemId}`;
    this.#observeItem(itemKey, input.turnId);
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

    this.#itemMessageIds.set(itemKey, messageId);
    this.#itemByMessageId.set(messageId, itemKey);
    this.#turnMessageIds.set(input.turnId, messageId);
    this.#turnByMessageId.set(messageId, input.turnId);
    await this.ensureStarted(context, messageId, push);
    return messageId;
  }

  recordSnapshot(input: {
    itemId: string;
    messageId: MessageId;
    text: string;
    turnId: string;
  }): void {
    const itemKey = `${input.turnId}:${input.itemId}`;
    const sequence = this.#observeItem(itemKey, input.turnId);

    this.#completedSnapshots.set(itemKey, { ...input, sequence });
  }

  finalSnapshot(turnId: string): { id: MessageId; text: string } | null {
    let finalSnapshot:
      | {
          itemId: string;
          messageId: MessageId;
          sequence: number;
          text: string;
          turnId: string;
        }
      | undefined;

    for (const snapshot of this.#completedSnapshots.values()) {
      if (
        snapshot.turnId === turnId &&
        (finalSnapshot === undefined || snapshot.sequence > finalSnapshot.sequence)
      ) {
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

    this.#started.add(messageId);
    await push(context, "driver.openai.message.started", [
      {
        kind: "message.started",
        payload: {
          messageId,
          role: "agent",
        },
      },
    ]);
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

  markReasoningEnded(messageId: string): boolean {
    if (this.#reasoningEnded.has(messageId)) {
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
    this.#reasoningStarted.clear();
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

  markCompleted(itemId: string): boolean {
    if (this.#completed.has(itemId)) {
      return false;
    }

    this.#completed.add(itemId);
    return true;
  }

  reset(): void {
    this.#completed.clear();
  }
}

export class OpenAiToolState {
  readonly #parentMessages = new Map<string, MessageId>();

  parentMessage(toolCallId: string): MessageId | null {
    return this.#parentMessages.get(toolCallId) ?? null;
  }

  async ensureStarted(
    context: AgentDriverContext,
    push: OpenAiEventPush,
    input: {
      parentMessageId: MessageId;
      reason: string;
      toolCallId: string;
      toolCallName: string;
    },
  ): Promise<void> {
    const started = this.#parentMessages.has(input.toolCallId);
    this.#parentMessages.set(input.toolCallId, input.parentMessageId);

    if (started) {
      return;
    }

    await push(context, input.reason, [
      {
        kind: "item.started",
        payload: {
          itemId: input.toolCallId,
          itemType: "tool_call",
          parentMessageId: input.parentMessageId,
          title: input.toolCallName,
        },
      },
      {
        kind: "tool.call.updated",
        payload: {
          kind: "tool",
          parentMessageId: input.parentMessageId,
          status: "running",
          title: input.toolCallName,
          toolCallId: input.toolCallId,
        },
      },
    ]);
  }

  failOpen(): DriverEventInput[] {
    const events = [...this.#parentMessages.keys()].flatMap<DriverEventInput>((toolCallId) => [
      {
        kind: "tool.call.updated",
        payload: {
          status: "failed",
          toolCallId,
        },
      },
      {
        kind: "item.completed",
        payload: {
          itemId: toolCallId,
          itemType: "tool_call",
          status: "failed",
        },
      },
    ]);
    this.#parentMessages.clear();
    return events;
  }

  markEnded(toolCallId: string): void {
    this.#parentMessages.delete(toolCallId);
  }

  reset(): void {
    this.#parentMessages.clear();
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

  createUpdatedEvent(): DriverEventInput {
    return {
      kind: "plan.updated",
      payload: {
        entries: [...this.#plans.values()]
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
