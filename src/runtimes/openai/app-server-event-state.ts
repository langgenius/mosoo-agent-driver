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
  readonly #ended = new Set<string>();
  readonly #reasoningStarted = new Set<string>();
  readonly #started = new Set<string>();
  readonly #textById = new Map<string, string>();
  readonly #turnByMessageId = new Map<MessageId, string>();
  readonly #turnMessages = new RuntimeAssistantMessageIdIndex<string>();
  readonly #turnMessageIds = new Map<string, MessageId>();
  readonly #turnMessageSequences = new Map<string, number>();

  appendText(messageId: string, delta: string): void {
    if (delta.length === 0) {
      return;
    }

    this.#textById.set(messageId, `${this.#textById.get(messageId) ?? ""}${delta}`);
  }

  currentText(messageId: string): string {
    return this.#textById.get(messageId) ?? "";
  }

  ensureReasoningStarted(messageId: string, events: DriverEventInput[]): void {
    if (this.#reasoningStarted.has(messageId)) {
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

  async ensureTurnMessage(
    context: AgentDriverContext,
    turnId: string,
    push: OpenAiEventPush,
  ): Promise<MessageId> {
    const existing = this.#turnMessageIds.get(turnId);

    if (existing !== undefined) {
      await this.ensureMessageStarted(context, existing, push);
      return existing;
    }

    const nextSequence = (this.#turnMessageSequences.get(turnId) ?? 0) + 1;
    this.#turnMessageSequences.set(turnId, nextSequence);
    const generated = this.#turnMessages.getOrCreate(`${turnId}:${nextSequence}`);
    this.#turnMessageIds.set(turnId, generated);
    this.#turnByMessageId.set(generated, turnId);
    await this.ensureMessageStarted(context, generated, push);
    return generated;
  }

  async ensureMessageStarted(
    context: AgentDriverContext,
    messageId: string,
    push: OpenAiEventPush,
  ): Promise<void> {
    if (this.#started.has(messageId)) {
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
    const turnId = this.#turnByMessageId.get(messageId);

    if (turnId !== undefined) {
      this.#turnByMessageId.delete(messageId);

      if (this.#turnMessageIds.get(turnId) === messageId) {
        this.#turnMessageIds.delete(turnId);
      }
    }

    return true;
  }

  messageForTurn(turnId: string): MessageId | null {
    return this.#turnMessageIds.get(turnId) ?? null;
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
}

export class OpenAiToolState {
  readonly #parentMessages = new Map<string, string>();
  readonly #started = new Set<string>();

  parentMessage(toolCallId: string): string | null {
    return this.#parentMessages.get(toolCallId) ?? null;
  }

  async ensureStarted(
    context: AgentDriverContext,
    push: OpenAiEventPush,
    input: {
      parentMessageId: string;
      reason: string;
      toolCallId: string;
      toolCallName: string;
    },
  ): Promise<void> {
    this.#parentMessages.set(input.toolCallId, input.parentMessageId);

    if (this.#started.has(input.toolCallId)) {
      return;
    }

    this.#started.add(input.toolCallId);
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
}
