import { isDeepStrictEqual } from "node:util";

import {
  assertProtocolAdmission,
  authorityContent,
  interactionSchema,
  runSchema,
} from "../../contract";
import type {
  Interaction,
  InteractionResolution,
  Item,
  ProtocolAdmissionLimits,
} from "../../contract";
import { createDriverId } from "../../protocol/id";
import { readArray, readNonEmptyString, readRecord, readString } from "./app-server-json";
import type { JsonObject, JsonRpcId } from "./app-server-json";
import { ContractProjection } from "../contract-projection";
import {
  monotonicUsage,
  type NativeItemLifecycle,
  projectOpenAiItem,
  providerEventId,
  provenance,
  readFiniteNumber,
  requireRecord,
  requireString,
  subtractUsage,
  toUsage,
} from "./contract-items";
import {
  type PendingServerRequest,
  projectOpenAiInteraction,
  toOpenAiRequestResult,
} from "./contract-interactions";
import { OpenAiContractTurnInbox } from "./contract-turn-inbox";
import { finishOpenAiTurn, projectOpenAiPlan } from "./contract-turn-lifecycle";
import { OpenAiContractAdapterState } from "./contract-adapter-state";
import type {
  OpenAiAuthorityUpdate,
  OpenAiContractAdapterOptions,
  OpenAiServerReply,
  OpenAiTurnAttachment,
  OpenAiTurnState,
  PendingOpenAiTurnAttachment,
} from "./contract-adapter-types";

export { OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION } from "./contract-interactions";

const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_PENDING_SERVER_REQUEST_BYTES = 8 * 1_024 * 1_024;
export type {
  OpenAiAuthorityUpdate,
  OpenAiContractAdapterOptions,
  OpenAiServerReply,
  OpenAiTurnAttachment,
} from "./contract-adapter-types";

export class OpenAiContractAdapter {
  readonly #admissionLimits: ProtocolAdmissionLimits | undefined;
  readonly #authority: OpenAiContractAdapterOptions["authority"];
  readonly #createId: () => string;
  readonly #inbox: OpenAiContractTurnInbox<OpenAiTurnState>;
  readonly #interactionTimeoutMs: number;
  readonly #maxPendingServerRequestBytes: number;
  readonly #pendingTurns = new Map<string, PendingOpenAiTurnAttachment>();
  readonly #projection: ContractProjection;
  readonly #sessionId: string;
  readonly #state: OpenAiContractAdapterState;
  readonly #turns = new Map<string, OpenAiTurnState>();
  #disposed = false;

  constructor(options: OpenAiContractAdapterOptions) {
    this.#admissionLimits =
      options.admissionLimits === undefined ? undefined : { ...options.admissionLimits };
    this.#authority = options.authority;
    this.#createId = options.createId ?? createDriverId;
    this.#interactionTimeoutMs = options.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
    this.#maxPendingServerRequestBytes =
      options.maxPendingServerRequestBytes ?? DEFAULT_PENDING_SERVER_REQUEST_BYTES;
    this.#state = new OpenAiContractAdapterState(this.#maxPendingServerRequestBytes);
    this.#sessionId = options.sessionId;
    this.#projection = new ContractProjection({
      admissionLimits: this.#admissionLimits,
      authority: async (update) => {
        const turn = [...this.#turns.values()].find((value) => value.runId === update.runId);

        if (turn === undefined) {
          throw new Error(`OpenAI app-server update references unknown run ${update.runId}.`);
        }

        await options.authority({ ...update, turnId: turn.turnId });
      },
      now: options.now,
      preview: options.preview,
      previewCheckpointBytes: options.previewCheckpointBytes,
      previewReplaceIntervalMs: options.previewReplaceIntervalMs,
      sessionId: options.sessionId,
    });
    this.#inbox = new OpenAiContractTurnInbox({
      dispatch: (method, params) => this.#dispatchNotification(method, params),
      replayEnd: (params) => this.#onTurnEnd(params, "turn/completed"),
    });

    if (
      [this.#interactionTimeoutMs, this.#maxPendingServerRequestBytes].some(
        (value) => !Number.isSafeInteger(value) || value < 1,
      )
    ) {
      throw new RangeError("OpenAI Contract adapter limits must be finite and positive.");
    }
  }

  /** Bind turn/started to the Run already created by the Coordinator. */
  async attachTurn(input: OpenAiTurnAttachment): Promise<void> {
    this.#assertActive();
    const run = runSchema.parse({
      ...input.run,
      provenance: provenance("turn/started", {
        threadId: input.threadId,
        turnId: input.turnId,
      }),
    });

    if (run.status !== "active") {
      throw new Error(`OpenAI turn ${input.turnId} requires an active run.`);
    }

    const existing = this.#turns.get(input.turnId);

    if (existing !== undefined) {
      if (existing.runId !== run.id || existing.threadId !== input.threadId) {
        throw new Error(`OpenAI turn ${input.turnId} is already registered to another run.`);
      }
      if (
        !isDeepStrictEqual(existing.run, run) ||
        !isDeepStrictEqual(existing.cause, input.cause)
      ) {
        throw new Error(`OpenAI turn ${input.turnId} is registered with different state.`);
      }

      this.#projection.attachRun(run);
      await this.#inbox.replay(input.turnId);
      return;
    }

    const ended = this.#inbox.ended(input.turnId);

    if (ended !== undefined) {
      if (ended.runId !== run.id || ended.threadId !== input.threadId) {
        throw new Error(`OpenAI turn ${input.turnId} is already registered to another run.`);
      }
      if (!isDeepStrictEqual(ended.run, run) || !isDeepStrictEqual(ended.cause, input.cause)) {
        throw new Error(`OpenAI turn ${input.turnId} is registered with different state.`);
      }
      return;
    }

    const pending = this.#pendingTurns.get(input.turnId);

    if (pending !== undefined) {
      if (
        pending.turn.runId !== run.id ||
        pending.turn.threadId !== input.threadId ||
        !isDeepStrictEqual(pending.run, run) ||
        !isDeepStrictEqual(pending.cause, input.cause)
      ) {
        throw new Error(`OpenAI turn ${input.turnId} changed while its attachment was pending.`);
      }

      await this.#commitTurn(pending);
      await this.#inbox.replay(input.turnId);
      return;
    }

    if (
      [
        ...this.#turns.values(),
        ...[...this.#pendingTurns.values()].map((entry) => entry.turn),
      ].some((turn) => turn.runId === run.id)
    ) {
      throw new Error(`OpenAI run ${run.id} is already attached to another turn.`);
    }

    const turn = {
      cause: input.cause,
      run,
      runId: run.id,
      threadId: input.threadId,
      turnId: input.turnId,
    };
    const attachment = {
      cause: input.cause,
      mutationId: this.#createId(),
      run,
      turn,
    };
    this.#pendingTurns.set(input.turnId, attachment);
    await this.#commitTurn(attachment);
    await this.#inbox.replay(input.turnId);
  }

  async handleNotification(method: string, value: unknown): Promise<void> {
    this.#assertActive();
    const params = requireRecord(value, `${method} params`);
    const eventTurnId =
      readNonEmptyString(params, "turnId") ?? readNonEmptyString(readRecord(params, "turn"), "id");

    if (eventTurnId !== null && this.#inbox.hasEnded(eventTurnId)) {
      return;
    }

    if (
      eventTurnId !== null &&
      (!this.#turns.has(eventTurnId) || this.#inbox.shouldBuffer(eventTurnId))
    ) {
      if (method === "turn/completed") {
        this.#inbox.rememberEnd(eventTurnId, params);
      } else {
        this.#inbox.rememberNotification(eventTurnId, method, params);
      }
      return;
    }

    await this.#dispatchNotification(method, params);
  }

  async #dispatchNotification(method: string, params: JsonObject): Promise<void> {
    switch (method) {
      case "item/started":
        await this.#onItem(params, "started", method);
        return;
      case "item/completed":
        await this.#onItem(params, "completed", method);
        return;
      case "item/agentMessage/delta":
        await this.#onText(params, method, "message.text", "delta");
        return;
      case "item/reasoning/summaryPartAdded":
        await this.#onReasoningPart(params, method);
        return;
      case "item/reasoning/summaryTextDelta":
        await this.#onText(params, method, "reasoning.text", "delta");
        return;
      case "item/commandExecution/outputDelta":
        await this.#onText(params, method, "terminal.stdout", "delta");
        return;
      case "item/mcpToolCall/progress":
        await this.#onProgress(params, method);
        return;
      case "serverRequest/resolved":
        await this.#onRequestResolved(params, method);
        return;
      case "item/fileChange/patchUpdated":
        await this.#onPatch(params, method);
        return;
      case "turn/plan/updated":
        await this.#onPlan(params, method);
        return;
      case "thread/tokenUsage/updated":
        await this.#onUsage(params, method);
        return;
      case "turn/completed":
        await this.#onTurnEnd(params, method);
        return;
      default:
        return;
    }
  }

  async handleServerRequest(
    method: string,
    requestId: JsonRpcId,
    value: unknown,
  ): Promise<string | null> {
    this.#assertActive();
    const params = requireRecord(value, `${method} params`);
    const turnId = readNonEmptyString(params, "turnId");

    if (turnId === null) {
      return null;
    }

    const turn = this.#turns.get(turnId);

    if (turn === undefined) {
      throw new Error(`OpenAI app-server request ${String(requestId)} arrived before attachment.`);
    }

    if (this.#projection.run(turn.runId)?.status !== "active") {
      return null;
    }

    const existing = this.#state.findInteraction(requestId);

    if (existing !== undefined) {
      const pending = existing;

      if (
        pending.method !== method ||
        pending.turnId !== turnId ||
        !isDeepStrictEqual(pending.params, params)
      ) {
        throw new Error(
          `OpenAI app-server request ${String(requestId)} changed identity or content.`,
        );
      }

      await this.#state.commitInteraction(pending, this.#projection);
      return pending.interaction.id;
    }

    const interaction = this.#projectInteraction(method, requestId, params, turn);

    if (interaction === null) {
      return null;
    }

    const pending = {
      interaction,
      method,
      params: structuredClone(params),
      requestId,
      turnId,
    };
    const tracked = this.#state.reserveInteraction(pending);
    await this.#state.commitInteraction(tracked, this.#projection);
    return interaction.id;
  }

  resolveInteraction(
    interactionId: string,
    resolution: InteractionResolution,
  ): OpenAiServerReply | null {
    this.#assertActive();
    const pending = this.#state.interaction(interactionId);

    if (pending === undefined) {
      return null;
    }

    const result = this.#toRequestResult(pending, resolution);
    this.#dropInteraction(interactionId);
    return { id: pending.requestId, result };
  }

  dispose(): void {
    this.#disposed = true;
    this.#projection.dispose();
    this.#inbox.dispose();
    this.#pendingTurns.clear();
    this.#state.clear();
    this.#turns.clear();
  }

  async #onItem(params: JsonObject, lifecycle: NativeItemLifecycle, method: string): Promise<void> {
    const turn = this.#requireTurn(params, method);
    const item = requireRecord(params["item"], `${method} params.item`);
    const itemId = requireString(item, "id", `${method} params.item`);
    const existing = this.#projection.item(turn.runId, itemId);

    if (existing !== undefined && existing.status !== "active") {
      return;
    }

    const eventId = providerEventId(method, params);
    await this.#withReceiptTime(eventId, async (occurredAt) => {
      const projected = this.#projectItem(turn, item, lifecycle, occurredAt, method);

      if (projected === null) {
        return;
      }

      await this.#projection.putItem(
        turn.runId,
        method,
        { providerEventId: eventId, type: "provider" },
        projected,
      );
    });

    if (lifecycle === "completed") {
      this.#state.deleteMessageFilter(turn.turnId, itemId);
    }
  }

  async #onPatch(params: JsonObject, method: string): Promise<void> {
    const turn = this.#requireTurn(params, method);
    const itemId = requireString(params, "itemId", `${method} params`);
    const existing = this.#projection.item(turn.runId, itemId);

    if (existing !== undefined && existing.status !== "active") {
      return;
    }

    const eventId = providerEventId(method, params);
    await this.#withReceiptTime(eventId, async (occurredAt) => {
      const projected = this.#projectItem(
        turn,
        {
          changes: readArray(params, "changes"),
          id: itemId,
          status: "inProgress",
          type: "fileChange",
        },
        "started",
        occurredAt,
        method,
      );

      if (projected === null) {
        return;
      }

      await this.#projection.putItem(
        turn.runId,
        method,
        { providerEventId: eventId, type: "provider" },
        projected,
      );
    });
  }

  async #onPlan(params: JsonObject, method: string): Promise<void> {
    const turn = this.#requireTurn(params, method);
    const itemId = "turn-plan";
    const previous = this.#projection.item(turn.runId, itemId);
    const eventId = providerEventId(method, params);
    await this.#withReceiptTime(eventId, async (occurredAt) => {
      const plan = projectOpenAiPlan(turn, params, occurredAt, method, previous);

      await this.#projection.putItem(
        turn.runId,
        method,
        { providerEventId: eventId, type: "provider" },
        plan,
      );
    });
  }

  async #onUsage(params: JsonObject, method: string): Promise<void> {
    const turn = this.#requireTurn(params, method);
    const tokenUsage = readRecord(params, "tokenUsage");
    const last = toUsage(readRecord(tokenUsage, "last"));
    const total = toUsage(readRecord(tokenUsage, "total"));

    if (last === undefined && total === undefined) {
      return;
    }

    if (total !== undefined && turn.usageBaseline === undefined) {
      turn.usageBaseline = subtractUsage(total, last ?? total);
    }

    const candidate =
      total === undefined ? last! : subtractUsage(total, turn.usageBaseline ?? total);
    const usage = monotonicUsage(this.#projection.run(turn.runId)?.usage, candidate);

    await this.#projection.updateUsage(
      turn.runId,
      method,
      { providerEventId: providerEventId(method, params), type: "provider" },
      usage,
    );
  }

  async #onTurnEnd(params: JsonObject, method: string): Promise<void> {
    const nativeTurn = requireRecord(params["turn"], `${method} params.turn`);
    const turnId = requireString(nativeTurn, "id", `${method} params.turn`);
    const turn = this.#turns.get(turnId);

    if (turn === undefined || this.#projection.run(turn.runId)?.status !== "active") {
      return;
    }

    await finishOpenAiTurn({
      method,
      params,
      projectItem: (state, item, lifecycle, occurredAt, event) =>
        this.#projectItem(state, item, lifecycle, occurredAt, event),
      projection: this.#projection,
      release: (id) => this.#releaseTurn(id),
      rememberEnded: (state) => this.#inbox.rememberEnded(state.turnId, state),
      turn,
      withReceiptTime: (eventId, operation) => this.#withReceiptTime(eventId, operation),
    });
  }

  async #onRequestResolved(params: JsonObject, method: string): Promise<void> {
    const requestId = params["requestId"];
    const threadId = requireString(params, "threadId", `${method} params`);

    if (typeof requestId !== "number" && typeof requestId !== "string") {
      throw new Error(`${method} params.requestId must be a string or number.`);
    }

    const pending = this.#state.findInteraction(requestId);

    if (pending === undefined) {
      return;
    }

    const interactionId = pending.interaction.id;
    const turn = this.#turns.get(pending.turnId);

    if (turn === undefined) {
      this.#dropInteraction(interactionId);
      return;
    }

    if (turn.threadId !== threadId) {
      throw new Error(`${method} params references the wrong thread.`);
    }

    const eventId = `${method}:${String(requestId)}`.slice(0, 256);
    await this.#withReceiptTime(eventId, async (endedAt) => {
      const interaction = interactionSchema.parse({
        ...pending.interaction,
        endedAt,
        status: "expired",
      });

      await this.#projection.putInteraction(
        turn.runId,
        method,
        { providerEventId: eventId, type: "provider" },
        interaction,
      );
      this.#dropInteraction(interactionId);
    });
  }

  async #onText(
    params: JsonObject,
    method: string,
    channel: "message.text" | "reasoning.text" | "terminal.stdout",
    textField: string,
  ): Promise<void> {
    const turn = this.#requireTurn(params, method);
    const itemId = requireString(params, "itemId", `${method} params`);
    const rawDelta = readString(params, textField);
    const item = this.#projection.item(turn.runId, itemId);

    if (
      rawDelta === null ||
      rawDelta.length === 0 ||
      item === undefined ||
      item.status !== "active" ||
      (channel === "message.text" && item.kind !== "message") ||
      (channel === "reasoning.text" && item.kind !== "reasoning") ||
      (channel === "terminal.stdout" && item.kind !== "terminal")
    ) {
      return;
    }

    const delta =
      channel === "message.text"
        ? this.#messageFilter(turn.turnId, itemId).push(rawDelta).text
        : rawDelta;

    if (delta.length === 0) {
      return;
    }

    await this.#projection.appendText({
      cause: {
        providerEventId: `${providerEventId(method, params)}:checkpoint`.slice(0, 256),
        type: "provider",
      },
      channel,
      delta,
      event: method,
      itemId,
      runId: turn.runId,
    });
  }

  async #onReasoningPart(params: JsonObject, method: string): Promise<void> {
    const summaryIndex = readFiniteNumber(params, "summaryIndex");

    if (summaryIndex === null || !Number.isInteger(summaryIndex) || summaryIndex < 1) {
      return;
    }

    const turn = this.#requireTurn(params, method);
    const itemId = requireString(params, "itemId", `${method} params`);
    const item = this.#projection.item(turn.runId, itemId);

    if (item === undefined || item.status !== "active" || item.kind !== "reasoning") {
      return;
    }

    await this.#projection.appendText({
      cause: {
        providerEventId: `${providerEventId(method, params)}:checkpoint`.slice(0, 256),
        type: "provider",
      },
      channel: "reasoning.text",
      delta: "\n\n",
      event: method,
      itemId,
      runId: turn.runId,
    });
  }

  async #onProgress(params: JsonObject, method: string): Promise<void> {
    const turn = this.#requireTurn(params, method);
    const itemId = requireString(params, "itemId", `${method} params`);
    const message = readString(params, "message");

    if (message === null) {
      return;
    }

    await this.#projection.replacePreview({
      channel: "tool.progress",
      itemId,
      runId: turn.runId,
      text: message,
    });
  }

  #projectItem(
    turn: OpenAiTurnState,
    native: JsonObject,
    lifecycle: NativeItemLifecycle,
    occurredAt: string,
    event: string,
  ): Item | null {
    return projectOpenAiItem(turn, native, lifecycle, occurredAt, event, (runId, itemId) =>
      this.#projection.item(runId, itemId),
    );
  }

  #projectInteraction(
    method: string,
    requestId: JsonRpcId,
    params: JsonObject,
    turn: OpenAiTurnState,
  ): Interaction | null {
    return projectOpenAiInteraction(method, requestId, params, turn, {
      createId: this.#createId,
      interactionTimeoutMs: this.#interactionTimeoutMs,
      item: (runId, itemId) => this.#projection.item(runId, itemId),
      now: () => this.#projection.now(),
    });
  }

  #toRequestResult(pending: PendingServerRequest, resolution: InteractionResolution): unknown {
    return toOpenAiRequestResult(pending, resolution);
  }

  #requireTurn(params: JsonObject, method: string): OpenAiTurnState {
    const turnId = requireString(params, "turnId", `${method} params`);
    const turn = this.#turns.get(turnId);

    if (turn === undefined) {
      throw new Error(`OpenAI app-server event ${method} references unknown turn ${turnId}.`);
    }

    const threadId = readNonEmptyString(params, "threadId");

    if (threadId !== null && threadId !== turn.threadId) {
      throw new Error(`OpenAI app-server event ${method} references the wrong thread.`);
    }

    return turn;
  }

  async #commitTurn(pending: PendingOpenAiTurnAttachment): Promise<void> {
    const update: OpenAiAuthorityUpdate = {
      cause: pending.cause,
      event: "turn/started",
      mutationId: pending.mutationId,
      operations: [{ entity: "run", op: "put", value: pending.run }],
      runId: pending.run.id,
      sessionId: this.#sessionId,
      turnId: pending.turn.turnId,
    };
    pending.task ??= Promise.resolve()
      .then(async () => {
        this.#assertActive();
        if (this.#admissionLimits !== undefined) {
          assertProtocolAdmission(
            update,
            this.#admissionLimits,
            authorityContent(update.operations),
          );
        }

        await this.#authority(update);

        if (this.#disposed) {
          return;
        }

        this.#turns.set(pending.turn.turnId, pending.turn);
        this.#projection.attachRun(pending.run);
        this.#pendingTurns.delete(pending.turn.turnId);
      })
      .finally(() => {
        pending.task = undefined;
      });
    await pending.task;
  }

  async #withReceiptTime<T>(
    eventId: string,
    operation: (occurredAt: string) => Promise<T>,
  ): Promise<T> {
    return this.#state.withReceiptTime(
      eventId,
      () => this.#projection.now().toISOString(),
      operation,
    );
  }

  #dropInteraction(interactionId: string): void {
    const pending = this.#state.dropInteraction(interactionId);

    if (pending !== undefined) {
      this.#projection.releaseInteraction(interactionId);
    }
  }

  #releaseTurn(turnId: string): void {
    this.#turns.delete(turnId);

    for (const pending of this.#state.releaseTurn(turnId)) {
      this.#projection.releaseInteraction(pending.interaction.id);
    }
  }

  #messageFilter(turnId: string, itemId: string) {
    return this.#state.messageFilter(turnId, itemId);
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("OpenAI Contract adapter is disposed.");
    }
  }
}
