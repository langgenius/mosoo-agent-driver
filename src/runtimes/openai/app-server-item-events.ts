import type { DriverEventInput } from "../../protocol/events";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { toOpenAiPlanStatus } from "./app-server-event-mapping";
import type {
  OpenAiEventPush,
  OpenAiItemState,
  OpenAiMessageState,
  OpenAiPlanState,
  OpenAiToolState,
} from "./app-server-event-state";
import { isRecord, readArray, readNonEmptyString, readRecord, readString } from "./app-server-json";
import type { JsonObject } from "./app-server-json";
import {
  toOpenAiFileChangeEvents,
  toOpenAiToolName,
  toOpenAiToolResultText,
} from "./event-translator";
import {
  filterOpenAiPrivateCitations,
  OpenAiPrivateCitationStreamFilter,
} from "./private-citation-filter";

export class OpenAiAppServerItemEventBridge {
  readonly #citationDiagnosticsEmitted = new Set<string>();
  readonly #citationFilters = new Map<string, OpenAiPrivateCitationStreamFilter>();
  readonly #items: OpenAiItemState;
  readonly #messages: OpenAiMessageState;
  readonly #plans: OpenAiPlanState;
  readonly #push: OpenAiEventPush;
  readonly #tools: OpenAiToolState;

  constructor(input: {
    items: OpenAiItemState;
    messages: OpenAiMessageState;
    plans: OpenAiPlanState;
    push: OpenAiEventPush;
    tools: OpenAiToolState;
  }) {
    this.#items = input.items;
    this.#messages = input.messages;
    this.#plans = input.plans;
    this.#push = input.push;
    this.#tools = input.tools;
  }

  reset(): void {
    this.#citationDiagnosticsEmitted.clear();
    this.#citationFilters.clear();
    this.#items.reset();
    this.#messages.reset();
    this.#plans.reset();
    this.#tools.reset();
  }

  finishOpen(): DriverEventInput[] {
    return [...this.#messages.finishOpen(), ...this.#tools.failOpen()];
  }

  async onMessageDelta(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const turnId = readNonEmptyString(params, "turnId");
    const itemId = readNonEmptyString(params, "itemId");
    const delta = readNonEmptyString(params, "delta");

    if (turnId === null || itemId === null || delta === null) {
      return;
    }

    const messageId = await this.#messages.ensureItemMessage(
      context,
      { itemId, turnId },
      this.#push,
    );

    if (this.#messages.isEnded(messageId)) {
      return;
    }

    const filteredDelta = this.#filterCitationDelta(messageId, delta);

    if (filteredDelta.length === 0) {
      return;
    }

    this.#messages.appendText(messageId, filteredDelta);
    await this.#push(context, "driver.openai.agent.delta", [
      {
        delivery: "best_effort",
        kind: "message.delta",
        payload: {
          contentDelta: filteredDelta,
          messageId,
          role: "agent",
        },
      },
    ]);
  }

  async onFilePatch(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const itemId = readNonEmptyString(params, "itemId");
    const turnId = readNonEmptyString(params, "turnId");

    if (itemId === null || turnId === null) {
      return;
    }

    const changes = readArray(params, "changes");
    const item = {
      changes,
      id: itemId,
      type: "fileChange",
    };
    const parentMessageId =
      this.#tools.parentMessage(itemId) ??
      (await this.#messages.ensureTurnMessage(context, turnId, this.#push));

    await this.#tools.ensureStarted(context, this.#push, {
      parentMessageId,
      reason: "driver.openai.file_change.patch_updated.synthetic_start",
      toolCallId: itemId,
      toolCallName: "File change",
    });

    const resultText = toOpenAiToolResultText(item);
    const events: DriverEventInput[] = [];

    if (resultText !== null && resultText.length > 0) {
      events.push({
        kind: "tool.call.updated",
        payload: {
          content: resultText,
          messageId: parentMessageId,
          rawOutput: resultText,
          status: "running",
          toolCallId: itemId,
        },
      });
    }

    events.push(...toOpenAiFileChangeEvents(item));

    if (events.length > 0) {
      await this.#push(context, "driver.openai.file_change.patch_updated", events);
    }
  }

  async onItemCompleted(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const item = readRecord(params, "item");
    const itemId = item === null ? null : readNonEmptyString(item, "id");
    const turnId = readNonEmptyString(params, "turnId");

    if (item === null || itemId === null || turnId === null) {
      return;
    }

    if (!this.#items.markCompleted(itemId)) {
      return;
    }

    const events: DriverEventInput[] = [];
    await this.#appendMessageEnd(context, events, item, itemId, turnId);
    this.#appendPlanEnd(events, item, itemId);
    this.#appendReasoningEnd(events, item, itemId);
    await this.#appendToolEnd(context, events, item, itemId, turnId);

    events.push(...toOpenAiFileChangeEvents(item));

    if (events.length > 0) {
      await this.#push(context, "driver.openai.item.completed", events);
    }
  }

  async onItemStarted(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const item = readRecord(params, "item");
    const turnId = readNonEmptyString(params, "turnId");

    if (item === null || turnId === null) {
      return;
    }

    const toolName = toOpenAiToolName(item);
    const itemId = readNonEmptyString(item, "id");

    if (toolName === null || itemId === null) {
      return;
    }

    await this.#tools.ensureStarted(context, this.#push, {
      parentMessageId: await this.#messages.ensureTurnMessage(context, turnId, this.#push),
      reason: "driver.openai.item.started",
      toolCallId: itemId,
      toolCallName: toolName,
    });
  }

  async onPlanDelta(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const itemId = readNonEmptyString(params, "itemId");
    const delta = readString(params, "delta");

    if (itemId === null || delta === null || delta.length === 0) {
      return;
    }

    this.#plans.appendDelta(itemId, delta);
    await this.#push(context, "driver.openai.plan.delta", [this.#plans.createUpdatedEvent()]);
  }

  async onReasoningDelta(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const itemId = readNonEmptyString(params, "itemId");
    const delta = readString(params, "delta") ?? readString(params, "part");

    if (itemId === null || delta === null || delta.length === 0) {
      return;
    }

    const messageId = `reasoning:${itemId}`;
    const events: DriverEventInput[] = [];

    if (this.#messages.isReasoningEnded(messageId)) {
      return;
    }

    this.#messages.ensureReasoning(messageId, events);
    events.push({
      delivery: "best_effort",
      kind: "thought.delta",
      payload: {
        channel: "summary",
        contentDelta: delta,
        thoughtId: messageId,
      },
    });

    await this.#push(context, "driver.openai.reasoning.summary", events);
  }

  async onReasoningPart(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const summaryIndex = params["summaryIndex"];

    if (typeof summaryIndex !== "number" || !Number.isInteger(summaryIndex) || summaryIndex < 1) {
      return;
    }

    await this.onReasoningDelta(context, { ...params, delta: "\n\n" });
  }

  async onToolOutput(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const itemId = readNonEmptyString(params, "itemId");
    const delta = readNonEmptyString(params, "delta");

    if (itemId === null || delta === null) {
      return;
    }

    const parentMessageId = this.#tools.parentMessage(itemId);

    if (parentMessageId === null) {
      return;
    }

    await this.#push(context, "driver.openai.tool.output", [
      {
        delivery: "best_effort",
        kind: "tool.call.updated",
        payload: {
          content: delta,
          messageId: parentMessageId,
          rawOutput: delta,
          status: "running",
          toolCallId: itemId,
        },
      },
    ]);
  }

  async onTurnItems(
    context: AgentDriverContext,
    params: JsonObject,
    turnId: string,
  ): Promise<void> {
    const turn = readRecord(params, "turn");

    for (const item of readArray(turn, "items")) {
      if (!isRecord(item)) {
        continue;
      }

      await this.onItemCompleted(context, {
        item,
        threadId: readString(params, "threadId"),
        turnId,
      });
    }
  }

  async resolveFinalMessage(
    context: AgentDriverContext,
    params: JsonObject,
    turnId: string,
  ): Promise<{ id: string; text: string } | null> {
    const turn = readRecord(params, "turn");

    if (turn === null) {
      return null;
    }

    const items = readArray(turn, "items");
    const itemsView = readString(turn, "itemsView");

    const finalAssistantItem = items.findLast(
      (item) => isRecord(item) && readString(item, "type") === "agentMessage",
    );

    if (!isRecord(finalAssistantItem)) {
      // Terminal notifications commonly use `itemsView: "notLoaded"` with an
      // empty items list. The provider's item/completed frames are complete
      // snapshots; first-seen item order remains stable when older completion
      // frames arrive late. A full or non-empty list stays authoritative.
      if (itemsView === "full" || (itemsView === null && items.length > 0)) {
        return null;
      }

      const completedSnapshot = this.#messages.finalSnapshot(turnId);

      if (completedSnapshot !== null) {
        this.#releaseCitationState(completedSnapshot.id);
      }

      return completedSnapshot;
    }

    const itemId = readNonEmptyString(finalAssistantItem, "id");
    const text = readString(finalAssistantItem, "text");

    // The provider's ordered turn snapshot is the only authoritative final
    // identity. If its final assistant item is incomplete, fail closed instead
    // of selecting an earlier progress item or an arrival-ordered stream item.
    if (itemId === null || text === null) {
      return null;
    }

    const messageId = await this.#messages.ensureItemMessage(
      context,
      { itemId, turnId },
      this.#push,
    );
    const filteredText = filterOpenAiPrivateCitations(text);
    await this.#reportCitations(context, messageId, filteredText.privateCitationCount);
    this.#messages.setText(messageId, filteredText.text);
    this.#releaseCitationState(messageId);
    return { id: messageId, text: filteredText.text };
  }

  async onTurnPlan(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const plan = readArray(params, "plan").flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }

      const content = readNonEmptyString(entry, "step");

      if (content === null) {
        return [];
      }

      return [
        {
          content,
          priority: "medium" as const,
          status: toOpenAiPlanStatus(readString(entry, "status")),
        },
      ];
    });

    await this.#push(context, "driver.openai.turn.plan.updated", [
      {
        kind: "plan.updated",
        payload: {
          entries: plan,
          source: "driver",
        },
      },
    ]);
  }

  async #appendMessageEnd(
    context: AgentDriverContext,
    events: DriverEventInput[],
    item: JsonObject,
    itemId: string,
    turnId: string,
  ): Promise<void> {
    if (readString(item, "type") !== "agentMessage") {
      return;
    }

    const finalText = readString(item, "text");
    const messageId = await this.#messages.ensureItemMessage(
      context,
      { itemId, turnId },
      this.#push,
    );
    const filteredFinalText = finalText === null ? null : filterOpenAiPrivateCitations(finalText);
    const currentText = this.#messages.currentText(messageId);

    if (filteredFinalText === null) {
      const trailingText = this.#citationFilters.get(messageId)?.finish().text ?? "";

      if (trailingText.length > 0) {
        this.#messages.appendText(messageId, trailingText);
        events.push({
          delivery: "best_effort",
          kind: "message.delta",
          payload: {
            contentDelta: trailingText,
            messageId,
            role: "agent",
          },
        });
      }
    }

    if (filteredFinalText !== null) {
      this.#appendCitationDiag(events, messageId, filteredFinalText.privateCitationCount);
    }

    if (filteredFinalText !== null && filteredFinalText.text.length > currentText.length) {
      if (filteredFinalText.text.startsWith(currentText)) {
        const delta = filteredFinalText.text.slice(currentText.length);
        this.#messages.appendText(messageId, delta);
        events.push({
          delivery: "best_effort",
          kind: "message.delta",
          payload: {
            contentDelta: delta,
            messageId,
            role: "agent",
          },
        });
      } else if (currentText.length === 0) {
        this.#messages.appendText(messageId, filteredFinalText.text);
        events.push({
          delivery: "best_effort",
          kind: "message.delta",
          payload: {
            contentDelta: filteredFinalText.text,
            messageId,
            role: "agent",
          },
        });
      } else {
        context.logger.warn("driver.openai.agent.final_text.mismatch", {
          currentLength: currentText.length,
          finalLength: filteredFinalText.text.length,
          itemId,
        });
      }
    }

    if (filteredFinalText !== null) {
      // item/completed is the provider's authoritative snapshot. Streaming
      // deltas may be missing or replayed, so canonical completion must not
      // inherit a corrupted accumulator even when live deltas cannot be undone.
      this.#messages.setText(messageId, filteredFinalText.text);
      this.#messages.recordSnapshot({
        itemId,
        messageId,
        text: filteredFinalText.text,
        turnId,
      });
    }

    this.#citationFilters.delete(messageId);

    if (this.#messages.markEnded(messageId)) {
      events.push({
        kind: "message.completed",
        payload: {
          messageId,
          role: "agent",
        },
      });
    }
  }

  #appendCitationDiag(
    events: DriverEventInput[],
    messageId: string,
    privateCitationCount: number,
  ): void {
    if (privateCitationCount === 0 || this.#citationDiagnosticsEmitted.has(messageId)) {
      return;
    }

    this.#citationDiagnosticsEmitted.add(messageId);
    events.push({
      kind: "diagnostic.reported",
      payload: {
        code: "openai.private_citation_markup_removed",
        details: {
          count: privateCitationCount,
        },
        message: "OpenAI private citation markup was removed from public assistant text.",
        severity: "warn",
        source: "openai",
      },
      visibility: "owner_debug",
    });
  }

  #filterCitationDelta(messageId: string, delta: string): string {
    let filter = this.#citationFilters.get(messageId);

    if (filter === undefined) {
      filter = new OpenAiPrivateCitationStreamFilter();
      this.#citationFilters.set(messageId, filter);
    }

    return filter.push(delta).text;
  }

  async #reportCitations(
    context: AgentDriverContext,
    messageId: string,
    privateCitationCount: number,
  ): Promise<void> {
    const events: DriverEventInput[] = [];
    this.#appendCitationDiag(events, messageId, privateCitationCount);

    if (events.length > 0) {
      await this.#push(context, "driver.openai.private_citation_markup_removed", events);
    }
  }

  #releaseCitationState(messageId: string): void {
    this.#citationDiagnosticsEmitted.delete(messageId);
    this.#citationFilters.delete(messageId);
  }

  #appendPlanEnd(events: DriverEventInput[], item: JsonObject, itemId: string): void {
    if (readString(item, "type") !== "plan") {
      return;
    }

    const planText = readString(item, "text");

    if (planText === null || planText.trim().length === 0) {
      return;
    }

    this.#plans.setCompleted(itemId, planText);
    events.push(this.#plans.createUpdatedEvent());
  }

  #appendReasoningEnd(events: DriverEventInput[], item: JsonObject, itemId: string): void {
    if (readString(item, "type") !== "reasoning") {
      return;
    }

    const summary = Array.isArray(item["summary"])
      ? item["summary"].filter((entry): entry is string => typeof entry === "string")
      : [];
    const messageId = `reasoning:${itemId}`;

    if (summary.length > 0) {
      this.#messages.ensureReasoning(messageId, events);
      events.push({
        delivery: "best_effort",
        kind: "thought.delta",
        payload: {
          channel: "summary",
          contentDelta: summary.join("\n\n"),
          thoughtId: messageId,
        },
      });
    }

    if (this.#messages.markReasoningEnded(messageId)) {
      events.push({
        kind: "thought.completed",
        payload: {
          channel: "summary",
          thoughtId: messageId,
        },
      });
    }
  }

  async #appendToolEnd(
    context: AgentDriverContext,
    events: DriverEventInput[],
    item: JsonObject,
    itemId: string,
    turnId: string,
  ): Promise<void> {
    const toolName = toOpenAiToolName(item);
    const parentMessageId =
      this.#tools.parentMessage(itemId) ??
      this.#messages.messageForTurn(turnId) ??
      (toolName === null
        ? null
        : await this.#messages.ensureTurnMessage(context, turnId, this.#push));

    if (parentMessageId === null || toolName === null) {
      return;
    }

    await this.#tools.ensureStarted(context, this.#push, {
      parentMessageId,
      reason: "driver.openai.item.completed.synthetic_start",
      toolCallId: itemId,
      toolCallName: toolName,
    });

    const nativeStatus = readString(item, "status");
    const status =
      nativeStatus === "failed" || nativeStatus === "declined" ? "failed" : "completed";
    const toolResult = toOpenAiToolResultText(item);

    events.push({
      kind: "tool.call.updated",
      payload: {
        ...(toolResult === null || toolResult.length === 0
          ? {}
          : {
              content: toolResult,
              messageId: parentMessageId,
              rawOutput: toolResult,
            }),
        status,
        toolCallId: itemId,
      },
    });
    events.push({
      kind: "item.completed",
      payload: {
        itemId,
        itemType: "tool_call",
        status,
      },
    });

    this.#tools.markEnded(itemId);
  }
}
