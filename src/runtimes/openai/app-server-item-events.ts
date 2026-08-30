import type { AgentDriverContext } from "../../core/agent-driver-backend";
import type { DriverEventInput } from "../../protocol/events";
import { chunkJsonText } from "../provider-json";
import { toOpenAiPlanStatus } from "./app-server-event-mapping";
import {
  assertOpenAiDurableEventFits,
  MAX_OPENAI_DURABLE_EVENT_BYTES,
} from "./app-server-event-state";
import type {
  OpenAiEventPush,
  OpenAiItemState,
  OpenAiMessageState,
  OpenAiPlanState,
  OpenAiTerminalOutcome,
  OpenAiToolState,
} from "./app-server-event-state";
import { isRecord, readArray, readNonEmptyString, readRecord, readString } from "./app-server-json";
import type { JsonObject } from "./app-server-json";
import {
  OpenAiAgentTaskState,
  openAiAgentTasksClosedEvent,
  toOpenAiAgentTaskId,
  type OpenAiSubAgentActivity,
} from "./app-server-agent-task-events";
import {
  toOpenAiCollaborationOutput,
  toOpenAiFileChangeEvents,
  toOpenAiMessagePhase,
  toOpenAiToolName,
  toOpenAiToolRawInput,
  toOpenAiToolResultText,
  toOpenAiToolStructuredOutput,
} from "./event-translator";
import {
  filterOpenAiPrivateCitations,
  OpenAiPrivateCitationStreamFilter,
} from "./private-citation-filter";

const MAX_OPENAI_MESSAGE_EVENT_TEXT_BYTES = 512 * 1_024;

export function chunkOpenAiText(
  text: string,
  firstChunkBytes = MAX_OPENAI_MESSAGE_EVENT_TEXT_BYTES,
  remainingChunkBytes = MAX_OPENAI_MESSAGE_EVENT_TEXT_BYTES,
): string[] {
  return chunkJsonText(text, firstChunkBytes, remainingChunkBytes);
}

function toOpenAiMessageSnapshotEvents(input: {
  readonly item: JsonObject;
  readonly itemId: string;
  readonly messageId: string;
  readonly phase: ReturnType<typeof toOpenAiMessagePhase>;
  readonly sourcePrefix: string;
  readonly text: string;
}): DriverEventInput[] {
  const createAddedEvent = (content: string): DriverEventInput => ({
    delivery: "lossless",
    kind: "message.added",
    payload: {
      content,
      ...(input.item["memoryCitation"] === null || input.item["memoryCitation"] === undefined
        ? {}
        : { memoryCitation: input.item["memoryCitation"] }),
      messageId: input.messageId,
      ...(input.phase === null ? {} : { phase: input.phase }),
      role: "agent",
    },
    sourceEventId: `${input.sourcePrefix}:0`,
  });
  const createDeltaEvent = (contentDelta: string, index: number): DriverEventInput => ({
    delivery: "lossless",
    kind: "message.delta",
    payload: {
      contentDelta,
      messageId: input.messageId,
      role: "agent",
    },
    sourceEventId: `${input.sourcePrefix}:${String(index)}`,
  });
  const emptyAddedEvent = createAddedEvent("");
  const metadataBytes = Buffer.byteLength(JSON.stringify(emptyAddedEvent), "utf8");
  assertOpenAiDurableEventFits(emptyAddedEvent, `message snapshot ${input.itemId}`);
  const emptyDeltaEvent = createDeltaEvent("", input.text.length);
  const deltaMetadataBytes = Buffer.byteLength(JSON.stringify(emptyDeltaEvent), "utf8");
  assertOpenAiDurableEventFits(emptyDeltaEvent, `message snapshot ${input.itemId}`);
  const chunks = chunkOpenAiText(
    input.text,
    Math.min(MAX_OPENAI_MESSAGE_EVENT_TEXT_BYTES, MAX_OPENAI_DURABLE_EVENT_BYTES - metadataBytes),
    Math.min(
      MAX_OPENAI_MESSAGE_EVENT_TEXT_BYTES,
      MAX_OPENAI_DURABLE_EVENT_BYTES - deltaMetadataBytes,
    ),
  );

  const events: DriverEventInput[] = [
    createAddedEvent(chunks[0]!),
    ...chunks.slice(1).map((contentDelta, index) => createDeltaEvent(contentDelta, index + 1)),
  ];
  assertOpenAiDurableEventFits(events[0]!, `message snapshot ${input.itemId}`);
  return events;
}

interface OpenAiItemCompletionCommit {
  readonly commit: () => void;
  readonly events: DriverEventInput[];
}

function readOpenAiSubAgentActivity(item: JsonObject): OpenAiSubAgentActivity | null {
  if (readString(item, "type") !== "subAgentActivity") {
    return null;
  }

  const kind = readString(item, "kind");
  const agentId = readNonEmptyString(item, "agentThreadId");
  const agentPath = readNonEmptyString(item, "agentPath");

  if (
    agentId === null ||
    agentPath === null ||
    (kind !== "started" && kind !== "interacted" && kind !== "interrupted" && kind !== "completed")
  ) {
    throw new Error("OpenAI sub-agent activity is malformed.");
  }

  return { agentId, agentPath, kind };
}

function withOpenAiEventIds(
  events: readonly DriverEventInput[],
  sourcePrefix: string,
): DriverEventInput[] {
  return events.map((event, index) => ({
    ...event,
    sourceEventId: event.sourceEventId ?? `${sourcePrefix}:${String(index)}`,
  }));
}

function toOpenAiItemLifecycleEvents(
  item: JsonObject,
  itemId: string,
  phase: "completed" | "started",
): DriverEventInput[] {
  const itemType = readString(item, "type");

  switch (itemType) {
    // These are translated by their dedicated message, plan, reasoning, or tool paths.
    case "agentMessage":
    case "plan":
    case "reasoning":
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "webSearch":
    case "imageView":
    case "sleep":
      return [];
    // User messages and standalone function outputs are input echoes, while hook/*
    // notifications own hook lifecycle. Their ThreadItem copies must not publish duplicates.
    case "userMessage":
    case "hookPrompt":
    case "functionCallOutput":
      return [];
    case "subAgentActivity": {
      // App-server emits a started/completed pair for one display activity. Publish it once.
      // Completion is authoritative and is also the only phase present in turn snapshots.
      if (phase === "started") {
        return [];
      }

      const { agentId, agentPath, kind: activityKind } = readOpenAiSubAgentActivity(item)!;

      return [
        {
          delivery: "lossless",
          kind: "agent.task.updated",
          payload: {
            ...(activityKind === "started"
              ? { active: true, status: "running" }
              : activityKind === "interacted"
                ? {}
                : {
                    active: false,
                    status: activityKind === "interrupted" ? "cancelled" : "completed",
                  }),
            activityKind,
            agentId,
            agentPath,
            taskId: toOpenAiAgentTaskId(agentId),
            title: `Sub-agent ${activityKind}`,
          },
        },
      ];
    }
    case "imageGeneration": {
      if (phase === "started") {
        return [];
      }

      const status = readString(item, "status");
      const revisedPrompt = readString(item, "revisedPrompt");
      const transparentBackground = item["transparentBackground"];
      const imageMetadata = {
        imageId: itemId,
        ...(revisedPrompt === null ? {} : { revisedPrompt }),
        ...(typeof transparentBackground === "boolean" ? { transparentBackground } : {}),
      };

      if (status === "failed") {
        return [
          {
            kind: "diagnostic.reported",
            payload: {
              code: "openai.image_generation.failed",
              details: {
                ...imageMetadata,
              },
              message: "OpenAI image generation failed.",
              severity: "error",
              source: "openai",
            },
            visibility: "owner_debug",
          },
        ];
      }

      if (status !== "completed" || readNonEmptyString(item, "result") === null) {
        throw new Error("OpenAI completed image generation did not contain a PNG result.");
      }

      throw new Error(
        "OpenAI image generation completed without a supported durable image transport.",
      );
    }
    case "enteredReviewMode":
    case "exitedReviewMode":
      return phase === "completed"
        ? [
            {
              kind: "review.updated",
              payload: {
                mode: itemType === "enteredReviewMode" ? "entered" : "exited",
                review: readString(item, "review") ?? "",
                reviewId: itemId,
                status: "completed",
              },
            },
          ]
        : [];
    case "contextCompaction":
      return phase === "completed"
        ? [
            {
              kind: "context.compacted",
              payload: { itemId, status: "completed" },
            },
          ]
        : [];
    default:
      return [
        {
          kind: "diagnostic.reported",
          payload: {
            code: "openai.item.unknown",
            details: { itemId, itemType, phase },
            message: `OpenAI ${String(itemType)} item is unknown to this protocol snapshot.`,
            severity: "error",
            source: "openai",
          },
          visibility: "owner_debug",
        },
      ];
  }
}

function toOpenAiToolStatus(
  item: JsonObject,
  phase: "completed" | "started",
): "cancelled" | "completed" | "failed" | null {
  const itemType = readString(item, "type");
  const nativeStatus = readString(item, "status");

  if (phase === "started") {
    if (itemType === "collabAgentToolCall" && nativeStatus !== "inProgress") {
      throw new Error(
        `OpenAI ${itemType} started with non-running status ${String(nativeStatus)}.`,
      );
    }
    if (itemType === "imageGeneration" && nativeStatus !== "in_progress") {
      throw new Error(
        `OpenAI ${itemType} started with non-running status ${String(nativeStatus)}.`,
      );
    }
    return null;
  }

  switch (itemType) {
    case "commandExecution":
    case "fileChange":
      if (nativeStatus === "completed") {
        return "completed";
      }
      if (nativeStatus === "failed" || nativeStatus === "declined") {
        return "failed";
      }
      break;
    case "mcpToolCall":
    case "dynamicToolCall":
    case "imageGeneration":
      if (nativeStatus === "completed") {
        return "completed";
      }
      if (nativeStatus === "failed") {
        return "failed";
      }
      break;
    case "collabAgentToolCall":
      if (nativeStatus === "completed") {
        return "completed";
      }
      if (nativeStatus === "failed") {
        return "failed";
      }
      if (nativeStatus === "interrupted") {
        return "cancelled";
      }
      break;
    default:
      return null;
  }

  throw new Error(
    `OpenAI ${String(itemType)} completed with non-terminal status ${String(nativeStatus)}.`,
  );
}

export class OpenAiAppServerItemEventBridge {
  readonly #agentTasks = new OpenAiAgentTaskState();
  readonly #citationDiagnosticsEmitted = new Set<string>();
  readonly #citationFilters = new Map<string, OpenAiPrivateCitationStreamFilter>();
  readonly #items: OpenAiItemState;
  readonly #messages: OpenAiMessageState;
  readonly #plans: OpenAiPlanState;
  readonly #push: OpenAiEventPush;
  readonly #pushSession: OpenAiEventPush;
  readonly #tools: OpenAiToolState;

  constructor(input: {
    items: OpenAiItemState;
    messages: OpenAiMessageState;
    plans: OpenAiPlanState;
    push: OpenAiEventPush;
    pushSession: OpenAiEventPush;
    tools: OpenAiToolState;
  }) {
    this.#items = input.items;
    this.#messages = input.messages;
    this.#plans = input.plans;
    this.#push = input.push;
    this.#pushSession = input.pushSession;
    this.#tools = input.tools;
  }

  reset(): void {
    this.#agentTasks.reset();
    this.#citationDiagnosticsEmitted.clear();
    this.#citationFilters.clear();
    this.#items.reset();
    this.#messages.reset();
    this.#plans.reset();
    this.#tools.reset();
  }

  terminalEvents(outcome: OpenAiTerminalOutcome): [DriverEventInput, ...DriverEventInput[]] {
    return [
      openAiAgentTasksClosedEvent(),
      ...this.#messages.terminalEvents(outcome),
      ...this.#tools.terminalEvents(outcome),
    ];
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
    const publicItemId = this.#items.publicId(itemId);
    const parentMessageId =
      this.#tools.parentMessage(itemId) ??
      (await this.#messages.ensureTurnMessage(context, turnId, this.#push));

    await this.#tools.ensureStarted(context, this.#push, {
      parentMessageId,
      publicToolCallId: publicItemId,
      reason: "driver.openai.file_change.patch_updated.synthetic_start",
      sourceScope: this.#items.publicId(turnId, "turn"),
      toolCallId: itemId,
      toolCallName: "File change",
    });

    const events = toOpenAiFileChangeEvents(item);

    for (const event of events) {
      assertOpenAiDurableEventFits(event, `file change ${publicItemId}`);
    }

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

    if (this.#items.isCompleted(itemId)) {
      return;
    }

    // Validate and prepare the full completion before committing replay state.
    const toolStatus = toOpenAiToolStatus(item, "completed");
    const activity = readOpenAiSubAgentActivity(item);
    const agentTaskUpdate = activity === null ? null : this.#agentTasks.prepare(activity);
    const publicItemId = this.#items.publicId(itemId);
    const publicTurnId = this.#items.publicId(turnId, "turn");
    const lifecycleEvents = toOpenAiItemLifecycleEvents(item, publicItemId, "completed");
    const completions = await Promise.all([
      this.#prepareMessageEnd(context, item, itemId, publicItemId, publicTurnId, turnId),
      this.#preparePlanEnd(item, itemId),
      this.#prepareReasoningEnd(context, item, itemId),
      this.#prepareToolEnd(context, item, itemId, publicItemId, publicTurnId, toolStatus, turnId),
    ]);
    const events = completions.flatMap((completion) => completion.events);

    events.push(...toOpenAiFileChangeEvents(item));
    events.push(...lifecycleEvents);
    events.push(...(agentTaskUpdate?.events ?? []));

    if (events.length > 0) {
      const durableEvents = withOpenAiEventIds(
        events,
        `openai.item.completed:${publicTurnId}:${publicItemId}`,
      );
      for (const event of durableEvents) {
        assertOpenAiDurableEventFits(event, `item completion ${publicItemId}`);
      }
      await this.#push(context, "driver.openai.item.completed", durableEvents);
    }

    for (const completion of completions) {
      completion.commit();
    }
    agentTaskUpdate?.commit();
    this.#items.markCompleted(itemId);
  }

  async onPostTerminalSubAgentActivity(
    context: AgentDriverContext,
    params: JsonObject,
  ): Promise<void> {
    const item = readRecord(params, "item");
    const itemId = item === null ? null : readNonEmptyString(item, "id");
    const turnId = readNonEmptyString(params, "turnId");

    if (item === null || itemId === null || turnId === null || this.#items.isCompleted(itemId)) {
      return;
    }

    const publicItemId = this.#items.publicId(itemId);
    const publicTurnId = this.#items.publicId(turnId, "turn");
    const events = withOpenAiEventIds(
      toOpenAiItemLifecycleEvents(item, publicItemId, "completed"),
      `openai.item.completed:${publicTurnId}:${publicItemId}`,
    );
    for (const event of events) {
      assertOpenAiDurableEventFits(event, `post-terminal sub-agent activity ${publicItemId}`);
    }
    await this.#pushSession(context, "driver.openai.sub_agent.post_terminal", events);
    this.#items.markCompleted(itemId);
  }

  async onItemStarted(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const item = readRecord(params, "item");
    const turnId = readNonEmptyString(params, "turnId");

    if (item === null || turnId === null) {
      return;
    }

    const toolName = toOpenAiToolName(item);
    const itemId = readNonEmptyString(item, "id");

    if (itemId === null) {
      return;
    }
    const publicItemId = this.#items.publicId(itemId);
    const publicTurnId = this.#items.publicId(turnId, "turn");

    if (toolName === null) {
      const events = withOpenAiEventIds(
        toOpenAiItemLifecycleEvents(item, publicItemId, "started"),
        `openai.item.started:${publicTurnId}:${publicItemId}`,
      );

      if (events.length > 0) {
        for (const event of events) {
          assertOpenAiDurableEventFits(event, `item start ${publicItemId}`);
        }
        await this.#push(context, "driver.openai.item.started", events);
      }
      return;
    }

    toOpenAiToolStatus(item, "started");

    await this.#tools.ensureStarted(context, this.#push, {
      parentMessageId: await this.#messages.ensureTurnMessage(context, turnId, this.#push),
      publicToolCallId: publicItemId,
      reason: "driver.openai.item.started",
      sourceScope: publicTurnId,
      toolCallId: itemId,
      toolCallName: toolName,
    });
  }

  async onPlanDelta(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const itemId = readNonEmptyString(params, "itemId");
    const turnId = readNonEmptyString(params, "turnId");
    const delta = readString(params, "delta");

    if (itemId === null || turnId === null || delta === null || delta.length === 0) {
      return;
    }
    const publicItemId = this.#items.publicId(itemId);
    const publicTurnId = this.#items.publicId(turnId, "turn");

    const event = {
      ...this.#plans.createDeltaEvent(itemId, delta),
      sourceEventId: `openai.plan.delta:${publicTurnId}:${publicItemId}:${String(
        this.#plans.currentLength(itemId),
      )}`,
    };
    assertOpenAiDurableEventFits(event, `plan update ${publicItemId}`);
    await this.#push(context, "driver.openai.plan.delta", [event]);
    this.#plans.appendDelta(itemId, delta);
  }

  async onReasoningDelta(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const itemId = readNonEmptyString(params, "itemId");
    const delta = readString(params, "delta") ?? readString(params, "part");

    if (itemId === null || delta === null || delta.length === 0) {
      return;
    }

    const messageId = this.#messages.reasoningId(itemId);
    const events: DriverEventInput[] = [];

    if (this.#messages.isReasoningEnded(messageId)) {
      return;
    }

    const currentLength = this.#messages.currentReasoningText(messageId).length;
    this.#messages.ensureReasoning(messageId, events, false);
    events.push(
      ...chunkOpenAiText(delta).map((contentDelta): DriverEventInput => ({
        delivery: "lossless",
        kind: "thought.delta",
        payload: {
          channel: "summary",
          contentDelta,
          thoughtId: messageId,
        },
      })),
    );

    await this.#push(
      context,
      "driver.openai.reasoning.summary",
      withOpenAiEventIds(events, `openai.reasoning.delta:${messageId}:${String(currentLength)}`),
    );
    this.#messages.ensureReasoning(messageId, [], true);
    this.#messages.appendReasoningText(messageId, delta);
  }

  async onReasoningPart(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const summaryIndex = params["summaryIndex"];

    const itemId = readNonEmptyString(params, "itemId");

    if (
      itemId === null ||
      typeof summaryIndex !== "number" ||
      !Number.isInteger(summaryIndex) ||
      summaryIndex < 1 ||
      !this.#messages.beginReasoningPart(this.#messages.reasoningId(itemId), summaryIndex, false)
    ) {
      return;
    }

    await this.onReasoningDelta(context, { ...params, delta: "\n\n" });
    this.#messages.beginReasoningPart(this.#messages.reasoningId(itemId), summaryIndex, true);
  }

  async onToolOutput(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const itemId = readNonEmptyString(params, "itemId");
    const delta = readNonEmptyString(params, "delta");

    if (itemId === null || delta === null) {
      return;
    }

    const parentMessageId = this.#tools.parentMessage(itemId);
    const publicToolCallId = this.#tools.publicToolCallId(itemId);

    if (parentMessageId === null || publicToolCallId === null) {
      return;
    }

    await this.#push(context, "driver.openai.tool.output", [
      {
        delivery: "best_effort",
        kind: "tool.call.updated",
        payload: {
          messageId: parentMessageId,
          rawOutputDelta: delta,
          status: "running",
          toolCallId: publicToolCallId,
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

    const assistantItems = items.filter(
      (item): item is JsonObject =>
        isRecord(item) &&
        readString(item, "type") === "agentMessage" &&
        readString(item, "delivery") !== "async",
    );
    const hasExplicitPhase = assistantItems.some((item) => toOpenAiMessagePhase(item) !== null);
    const finalAssistantItem = hasExplicitPhase
      ? assistantItems.findLast((item) => toOpenAiMessagePhase(item) === "final")
      : assistantItems.at(-1);

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
    const phase = toOpenAiMessagePhase(finalAssistantItem);
    const publicItemId = this.#items.publicId(itemId);
    const publicTurnId = this.#items.publicId(turnId, "turn");
    await this.#reportCitations(context, messageId, filteredText.privateCitationCount);
    const snapshot = {
      itemId,
      messageId,
      phase,
      text: filteredText.text,
      turnId,
    };

    if (this.#messages.needsSnapshot(snapshot)) {
      const sourcePrefix = `openai.turn.final_message:${publicTurnId}:${publicItemId}`;
      const snapshotEvents = toOpenAiMessageSnapshotEvents({
        item: finalAssistantItem,
        itemId,
        messageId,
        phase,
        sourcePrefix,
        text: filteredText.text,
      });
      await this.#push(
        context,
        "driver.openai.turn.final_message",
        withOpenAiEventIds(
          [
            ...snapshotEvents,
            ...(this.#messages.isEnded(messageId)
              ? [
                  {
                    kind: "message.completed" as const,
                    payload: { messageId, role: "agent" },
                    sourceEventId: `${sourcePrefix}:completed`,
                  },
                ]
              : []),
          ],
          sourcePrefix,
        ),
      );
      this.#messages.setText(messageId, filteredText.text);
      this.#messages.recordSnapshot(snapshot);
    }
    this.#releaseCitationState(messageId);
    return { id: messageId, text: filteredText.text };
  }

  async onTurnPlan(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const turnId = readNonEmptyString(params, "turnId");
    if (turnId === null) {
      return;
    }
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

    const event: DriverEventInput = {
      kind: "plan.updated",
      payload: {
        entries: plan,
        source: "driver",
      },
      sourceEventId: `openai.turn.plan:${this.#items.publicId(turnId, "turn")}:${String(
        this.#plans.turnVersion(turnId),
      )}`,
    };
    assertOpenAiDurableEventFits(event, "turn plan update");
    await this.#push(context, "driver.openai.turn.plan.updated", [event]);
    this.#plans.advanceTurnVersion(turnId);
  }

  async #prepareMessageEnd(
    context: AgentDriverContext,
    item: JsonObject,
    itemId: string,
    publicItemId: string,
    publicTurnId: string,
    turnId: string,
  ): Promise<OpenAiItemCompletionCommit> {
    if (readString(item, "type") !== "agentMessage") {
      return { commit: () => {}, events: [] };
    }

    const events: DriverEventInput[] = [];
    const finalText = readString(item, "text");
    const isAsync = readString(item, "delivery") === "async";
    const messageId = await this.#messages.ensureItemMessage(
      context,
      { itemId, turnId },
      this.#push,
    );
    const filteredFinalText = finalText === null ? null : filterOpenAiPrivateCitations(finalText);
    let trailingText = "";

    if (filteredFinalText === null) {
      trailingText = this.#citationFilters.get(messageId)?.previewFinish().text ?? "";

      if (trailingText.length > 0) {
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

    const commitCitationDiagnostic =
      filteredFinalText !== null
        ? this.#appendCitationDiag(events, messageId, filteredFinalText.privateCitationCount)
        : false;

    if (filteredFinalText !== null) {
      events.push(
        ...toOpenAiMessageSnapshotEvents({
          item,
          itemId,
          messageId,
          phase: toOpenAiMessagePhase(item),
          sourcePrefix: `openai.item.completed:${publicTurnId}:${publicItemId}`,
          text: filteredFinalText.text,
        }),
      );
    }

    if (!this.#messages.isEnded(messageId)) {
      events.push({
        kind: "message.completed",
        payload: {
          messageId,
          role: "agent",
        },
      });
    }

    return {
      commit: () => {
        if (commitCitationDiagnostic) {
          this.#citationDiagnosticsEmitted.add(messageId);
        }
        if (filteredFinalText === null) {
          this.#citationFilters.get(messageId)?.finish();
          this.#messages.appendText(messageId, trailingText);
        } else {
          // item/completed is the provider's authoritative snapshot. Streaming
          // deltas may be missing or replayed, so canonical completion must not
          // inherit a corrupted accumulator even when live deltas cannot be undone.
          this.#messages.setText(messageId, filteredFinalText.text);
          if (!isAsync) {
            this.#messages.recordSnapshot({
              itemId,
              messageId,
              phase: toOpenAiMessagePhase(item),
              text: filteredFinalText.text,
              turnId,
            });
          }
        }
        this.#citationFilters.delete(messageId);
        this.#messages.markEnded(messageId);
      },
      events,
    };
  }

  #appendCitationDiag(
    events: DriverEventInput[],
    messageId: string,
    privateCitationCount: number,
  ): boolean {
    if (privateCitationCount === 0 || this.#citationDiagnosticsEmitted.has(messageId)) {
      return false;
    }

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
    return true;
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
    const commit = this.#appendCitationDiag(events, messageId, privateCitationCount);

    if (events.length > 0) {
      await this.#push(context, "driver.openai.private_citation_markup_removed", events);
    }
    if (commit) {
      this.#citationDiagnosticsEmitted.add(messageId);
    }
  }

  #releaseCitationState(messageId: string): void {
    this.#citationDiagnosticsEmitted.delete(messageId);
    this.#citationFilters.delete(messageId);
  }

  #preparePlanEnd(item: JsonObject, itemId: string): OpenAiItemCompletionCommit {
    if (readString(item, "type") !== "plan") {
      return { commit: () => {}, events: [] };
    }

    const planText = readString(item, "text");

    if (planText === null || planText.trim().length === 0) {
      return { commit: () => {}, events: [] };
    }

    return {
      commit: () => this.#plans.setCompleted(itemId, planText),
      events: [this.#plans.createCompletedEvent(itemId, planText)],
    };
  }

  #prepareReasoningEnd(
    context: AgentDriverContext,
    item: JsonObject,
    itemId: string,
  ): OpenAiItemCompletionCommit {
    if (readString(item, "type") !== "reasoning") {
      return { commit: () => {}, events: [] };
    }

    const events: DriverEventInput[] = [];
    const summary = Array.isArray(item["summary"])
      ? item["summary"].filter((entry): entry is string => typeof entry === "string")
      : [];
    const messageId = this.#messages.reasoningId(itemId);
    const summaryText = summary.join("\n\n");
    const currentText = this.#messages.currentReasoningText(messageId);
    const missingText = summaryText.startsWith(currentText)
      ? summaryText.slice(currentText.length)
      : currentText.length === 0
        ? summaryText
        : "";

    if (
      summaryText.length > 0 &&
      currentText.length > 0 &&
      summaryText !== currentText &&
      missingText.length === 0
    ) {
      context.logger.warn("driver.openai.reasoning.final_text.mismatch", {
        currentLength: currentText.length,
        finalLength: summaryText.length,
        itemId,
      });
    }

    if (missingText.length > 0) {
      this.#messages.ensureReasoning(messageId, events, false);
      events.push(
        ...chunkOpenAiText(missingText).map((contentDelta, index): DriverEventInput => ({
          delivery: "lossless",
          kind: "thought.delta",
          payload: {
            channel: "summary",
            contentDelta,
            thoughtId: messageId,
          },
          sourceEventId: `openai.reasoning.completed:${messageId}:${String(index)}`,
        })),
      );
    }

    const shouldStart = missingText.length > 0 && !this.#messages.isReasoningStarted(messageId);
    if (this.#messages.isReasoningStarted(messageId) || shouldStart) {
      events.push({
        kind: "thought.completed",
        payload: {
          channel: "summary",
          thoughtId: messageId,
        },
        sourceEventId: `openai.reasoning.completed:${messageId}:terminal`,
      });
    }

    return {
      commit: () => {
        if (shouldStart) {
          this.#messages.ensureReasoning(messageId, [], true);
        }
        this.#messages.appendReasoningText(messageId, missingText);
        this.#messages.markReasoningEnded(messageId);
      },
      events,
    };
  }

  async #prepareToolEnd(
    context: AgentDriverContext,
    item: JsonObject,
    itemId: string,
    publicItemId: string,
    publicTurnId: string,
    status: "cancelled" | "completed" | "failed" | null,
    turnId: string,
  ): Promise<OpenAiItemCompletionCommit> {
    const events: DriverEventInput[] = [];
    const toolName = toOpenAiToolName(item);
    const parentMessageId =
      this.#tools.parentMessage(itemId) ??
      this.#messages.messageForTurn(turnId) ??
      (toolName === null
        ? null
        : await this.#messages.ensureTurnMessage(context, turnId, this.#push));

    if (parentMessageId === null || toolName === null) {
      return { commit: () => {}, events };
    }

    await this.#tools.ensureStarted(context, this.#push, {
      parentMessageId,
      publicToolCallId: publicItemId,
      reason: "driver.openai.item.completed.synthetic_start",
      sourceScope: publicTurnId,
      toolCallId: itemId,
      toolCallName: toolName,
    });

    const itemType = readString(item, "type");
    const terminalStatus = status ?? "completed";
    const toolResult = toOpenAiToolResultText(item);
    const rawInput = toOpenAiToolRawInput(item);
    const collaborationOutput = toOpenAiCollaborationOutput(item);
    const receiverThreadIds = readArray(item, "receiverThreadIds").filter(
      (entry): entry is string => typeof entry === "string",
    );
    const structuredOutput =
      toOpenAiToolStructuredOutput(item) ??
      collaborationOutput ??
      (itemType === "webSearch"
        ? {
            action: item["action"] ?? null,
            query: readString(item, "query"),
            results: item["results"] ?? null,
          }
        : null);

    events.push({
      kind: "tool.call.updated",
      payload: {
        ...(itemType === "collabAgentToolCall" && receiverThreadIds.length === 1
          ? { agentId: receiverThreadIds[0] }
          : {}),
        ...(toolResult === null ||
        toolResult.length === 0 ||
        ((itemType === "dynamicToolCall" || itemType === "collabAgentToolCall") &&
          structuredOutput !== null)
          ? {}
          : {
              messageId: parentMessageId,
              rawOutput: toolResult,
            }),
        ...(structuredOutput === null ? {} : { structuredOutput }),
        ...(rawInput === null ? {} : { rawInput }),
        status: terminalStatus,
        toolCallId: publicItemId,
      },
      sourceEventId: `openai.item.completed:${publicTurnId}:${publicItemId}:0`,
    });
    assertOpenAiDurableEventFits(events[0]!, `tool completion ${publicItemId}`);
    events.push({
      kind: "item.completed",
      payload: {
        itemId: publicItemId,
        itemType: "tool_call",
        status: terminalStatus,
      },
    });

    return {
      commit: () => this.#tools.markEnded(itemId),
      events,
    };
  }
}
