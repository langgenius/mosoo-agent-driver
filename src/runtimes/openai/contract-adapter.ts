import { isDeepStrictEqual } from "node:util";

import {
  assertProtocolAdmission,
  AuthorityOutcomeUnknownError,
  authorityContent,
  interactionSchema,
  itemSchema,
  runSchema,
} from "../../contract";
import type {
  ContentBlock,
  FileChange,
  Interaction,
  InteractionResolution,
  Item,
  MutationCause,
  ProtocolAdmissionLimits,
  ProtocolError,
  Run,
  TokenUsage,
} from "../../contract";
import { createDriverId } from "../../protocol/id";
import { isRecord, readArray, readNonEmptyString, readRecord, readString } from "./app-server-json";
import type { JsonObject, JsonRpcId } from "./app-server-json";
import {
  asJsonValue,
  createProviderMeta,
  ContractProjection,
  type ContractAuthorityUpdate,
  type ContractProjectionOptions,
} from "../contract-projection";
import {
  filterOpenAiPrivateCitations,
  OpenAiPrivateCitationStreamFilter,
} from "./private-citation-filter";

const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_PENDING_SERVER_REQUEST_BYTES = 8 * 1_024 * 1_024;
const MAX_PENDING_TURN_END_BYTES = 8 * 1_024 * 1_024;
const MAX_TRACKED_TURN_ENDS = 1_024;
const PROVIDER = "openai";
const PROVIDER_EXTENSION_ITEM = "openai.app-server/thread-item";
export const OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION = "openai.app-server/mcp-elicitation";
const providerMeta = createProviderMeta(PROVIDER);

type NativeItemLifecycle = "completed" | "started";

interface TurnState {
  cause: MutationCause;
  run: Run;
  runId: string;
  threadId: string;
  turnId: string;
  usageBaseline?: TokenUsage;
}

interface PendingServerRequest {
  bytes: number;
  commit?: Promise<void> | undefined;
  interaction: Interaction;
  method: string;
  params: JsonObject;
  requestId: JsonRpcId;
  turnId: string;
}

interface PendingTurnAttachment {
  cause: MutationCause;
  mutationId: string;
  run: Run;
  task?: Promise<void> | undefined;
  turn: TurnState;
}

interface PendingTurnEnd {
  bytes: number;
  params: JsonObject;
  task?: Promise<void> | undefined;
}

interface PendingTurnNotification {
  bytes: number;
  method: string;
  params: JsonObject;
}

type DynamicToolContentItem =
  | { imageUrl: string; type: "inputImage" }
  | { text: string; type: "inputText" };

export interface OpenAiAuthorityUpdate extends ContractAuthorityUpdate {
  readonly turnId: string;
}

export interface OpenAiContractAdapterOptions extends Omit<ContractProjectionOptions, "authority"> {
  readonly authority: (update: OpenAiAuthorityUpdate) => Promise<void>;
  readonly createId?: (() => string) | undefined;
  readonly interactionTimeoutMs?: number | undefined;
  readonly maxPendingServerRequestBytes?: number | undefined;
}

export interface OpenAiTurnAttachment {
  readonly cause: MutationCause;
  readonly run: Run;
  readonly threadId: string;
  readonly turnId: string;
}

export interface OpenAiServerReply {
  readonly id: JsonRpcId;
  readonly result: unknown;
}

function requireRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function requireString(value: JsonObject, key: string, label: string): string {
  const entry = readNonEmptyString(value, key);

  if (entry === null) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }

  return entry;
}

function readFiniteNumber(value: JsonObject, key: string): number | null {
  const entry = value[key];
  return typeof entry === "number" && Number.isFinite(entry) ? entry : null;
}

const usageKeys = ["cachedInput", "input", "output", "reasoning", "total"] as const;
const nativeUsageKeys = {
  cachedInput: "cachedInputTokens",
  input: "inputTokens",
  output: "outputTokens",
  reasoning: "reasoningOutputTokens",
  total: "totalTokens",
} as const satisfies Record<(typeof usageKeys)[number], string>;

function toUsage(value: JsonObject | null): TokenUsage | undefined {
  if (value === null) {
    return undefined;
  }

  const usage: TokenUsage = {};

  for (const key of usageKeys) {
    const entry = readFiniteNumber(value, nativeUsageKeys[key]);

    if (entry !== null && entry >= 0 && Number.isSafeInteger(entry)) {
      usage[key] = entry;
    }
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function subtractUsage(total: TokenUsage, baseline: TokenUsage): TokenUsage {
  const usage: TokenUsage = {};

  for (const key of usageKeys) {
    const value = total[key];

    if (value !== undefined) {
      usage[key] = Math.max(0, value - (baseline[key] ?? 0));
    }
  }

  return usage;
}

function monotonicUsage(previous: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const usage: TokenUsage = {};

  for (const key of usageKeys) {
    const value = next[key] ?? previous?.[key];

    if (value !== undefined) {
      usage[key] = Math.max(value, previous?.[key] ?? 0);
    }
  }

  return usage;
}

function latestTimestamp(previous: string | undefined, next: string): string {
  return previous !== undefined && Date.parse(previous) > Date.parse(next) ? previous : next;
}

function textContent(text: string): ContentBlock[] {
  return text.length === 0 ? [] : [{ text, type: "text" }];
}

function providerEventId(method: string, params: JsonObject): string {
  const ids = [
    readString(params, "turnId"),
    readString(readRecord(params, "turn"), "id"),
    readString(params, "itemId"),
    readString(readRecord(params, "item"), "id"),
  ].filter((entry) => entry !== null);
  return [method, ...ids].join(":").slice(0, 256);
}

function provenance(
  event: string,
  input: { itemId?: string; requestId?: string; threadId: string; turnId: string },
) {
  return providerMeta.provenance(event, input);
}

function itemStatus(item: JsonObject, lifecycle: NativeItemLifecycle): Item["status"] {
  if (lifecycle === "started") {
    return "active";
  }

  const status = readString(item, "status");

  if (status === "failed") {
    return "failed";
  }

  if (status === "declined") {
    return "cancelled";
  }

  return "completed";
}

function itemError(item: JsonObject, type: string): ProtocolError {
  const error = readRecord(item, "error");

  return {
    code: `openai.${type}.failed`,
    message: readString(error, "message") ?? `${type} failed.`,
    retryable: false,
  };
}

function toFileChanges(item: JsonObject): FileChange[] {
  return readArray(item, "changes").flatMap<FileChange>((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const path = readNonEmptyString(entry, "path");
    const kind = readRecord(entry, "kind");
    const type = readString(kind, "type");

    if (path === null || (type !== "add" && type !== "delete" && type !== "update")) {
      return [];
    }

    const movePath = readNonEmptyString(kind, "move_path");
    const diff = readString(entry, "diff");

    if (type === "update" && movePath !== null) {
      return [
        {
          ...(diff === null || diff.length === 0 ? {} : { diff: { text: diff, type: "text" } }),
          oldPath: path,
          operation: "move",
          path: movePath,
        },
      ];
    }

    return [
      {
        ...(diff === null || diff.length === 0 ? {} : { diff: { text: diff, type: "text" } }),
        operation: type === "add" ? "create" : type === "delete" ? "delete" : "update",
        path,
      },
    ];
  });
}

function toInputAnswer(params: JsonObject, questionId: string, answer: string): string {
  const question = readArray(params, "questions").find(
    (entry) => isRecord(entry) && readString(entry, "id") === questionId,
  );

  if (!isRecord(question)) {
    return answer;
  }

  for (const [index, option] of readArray(question, "options").entries()) {
    if (!isRecord(option)) {
      continue;
    }

    const label = readNonEmptyString(option, "label");

    if (label !== null && String(index) === answer) {
      return label;
    }
  }

  return answer;
}

function selectedOption(
  interaction: Interaction,
  resolution: Extract<InteractionResolution, { kind: "permission" }>["value"],
): string | null {
  if (resolution.type === "cancelled") {
    return null;
  }

  if (
    interaction.kind !== "permission" ||
    !interaction.request.options.some((option) => option.id === resolution.optionId)
  ) {
    throw new Error("OpenAI permission resolution selected an unavailable option.");
  }

  return resolution.optionId;
}

function dynamicToolName(value: JsonObject): string | null {
  const tool = readNonEmptyString(value, "tool");
  const namespace = readNonEmptyString(value, "namespace");
  return tool === null ? null : namespace === null ? tool : `${namespace}/${tool}`;
}

function toNativeToolContent(block: ContentBlock): DynamicToolContentItem[] {
  if (block.type === "text") {
    return [{ text: block.text, type: "inputText" }];
  }

  if (block.type === "json") {
    return [{ text: JSON.stringify(block.value), type: "inputText" }];
  }

  if (block.type === "resource_link" && block.mediaType?.startsWith("image/")) {
    return [{ imageUrl: block.uri, type: "inputImage" }];
  }

  if (block.type === "inline_blob" && block.mediaType.startsWith("image/")) {
    return [
      {
        imageUrl: `data:${block.mediaType};base64,${block.data}`,
        type: "inputImage",
      },
    ];
  }

  if (block.type === "extension") {
    return [{ text: JSON.stringify(block.value), type: "inputText" }];
  }

  return [];
}

function fromNativeToolContent(value: JsonObject | null): ContentBlock[] {
  return readArray(value, "contentItems").flatMap<ContentBlock>((entry) => {
    if (!isRecord(entry)) {
      const json = asJsonValue(entry);
      return json === undefined ? [] : [{ type: "json", value: json }];
    }

    if (readString(entry, "type") === "inputText") {
      const text = readString(entry, "text");
      return text === null ? [] : [{ text, type: "text" }];
    }

    if (readString(entry, "type") === "inputImage") {
      const imageUrl = readNonEmptyString(entry, "imageUrl");
      const dataUrl = imageUrl?.match(/^data:([^;,]+);base64,(.+)$/su);

      if (dataUrl?.[1] !== undefined && dataUrl[2] !== undefined) {
        return [{ data: dataUrl[2], mediaType: dataUrl[1], type: "inline_blob" }];
      }

      if (imageUrl !== null && URL.canParse(imageUrl)) {
        return [{ type: "resource_link", uri: imageUrl }];
      }
    }

    const json = asJsonValue(entry);
    return json === undefined ? [] : [{ type: "json", value: json }];
  });
}

export class OpenAiContractAdapter {
  readonly #admissionLimits: ProtocolAdmissionLimits | undefined;
  readonly #authority: OpenAiContractAdapterOptions["authority"];
  readonly #createId: () => string;
  readonly #endedTurns = new Map<string, TurnState>();
  readonly #interactionTimeoutMs: number;
  readonly #interactions = new Map<string, PendingServerRequest>();
  readonly #messageFilters = new Map<string, OpenAiPrivateCitationStreamFilter>();
  readonly #maxPendingServerRequestBytes: number;
  readonly #pendingTurnEnds = new Map<string, PendingTurnEnd>();
  readonly #pendingTurnNotifications = new Map<string, PendingTurnNotification[]>();
  readonly #pendingTurnReplays = new Map<string, Promise<void>>();
  readonly #pendingTurns = new Map<string, PendingTurnAttachment>();
  readonly #projection: ContractProjection;
  readonly #sessionId: string;
  readonly #turns = new Map<string, TurnState>();
  readonly #textEncoder = new TextEncoder();
  readonly #receiptTimes = new Map<string, string>();
  #disposed = false;
  #unknownReceiptEventId: string | undefined;
  #pendingServerRequestBytes = 0;
  #pendingTurnEndBytes = 0;
  #pendingTurnNotificationBytes = 0;
  #pendingTurnNotificationCount = 0;

  constructor(options: OpenAiContractAdapterOptions) {
    this.#admissionLimits =
      options.admissionLimits === undefined ? undefined : { ...options.admissionLimits };
    this.#authority = options.authority;
    this.#createId = options.createId ?? createDriverId;
    this.#interactionTimeoutMs = options.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
    this.#maxPendingServerRequestBytes =
      options.maxPendingServerRequestBytes ?? DEFAULT_PENDING_SERVER_REQUEST_BYTES;
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
      await this.#replayPendingTurn(input.turnId);
      return;
    }

    const ended = this.#endedTurns.get(input.turnId);

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
      await this.#replayPendingTurn(input.turnId);
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
    await this.#replayPendingTurn(input.turnId);
  }

  async handleNotification(method: string, value: unknown): Promise<void> {
    this.#assertActive();
    const params = requireRecord(value, `${method} params`);
    const eventTurnId =
      readNonEmptyString(params, "turnId") ?? readNonEmptyString(readRecord(params, "turn"), "id");

    if (eventTurnId !== null && this.#endedTurns.has(eventTurnId)) {
      return;
    }

    if (
      eventTurnId !== null &&
      (!this.#turns.has(eventTurnId) ||
        this.#pendingTurnNotifications.has(eventTurnId) ||
        this.#pendingTurnEnds.has(eventTurnId) ||
        this.#pendingTurnReplays.has(eventTurnId))
    ) {
      if (method === "turn/completed") {
        this.#rememberTurnEnd(eventTurnId, params);
      } else {
        this.#rememberTurnNotification(eventTurnId, method, params);
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

    const existing = [...this.#interactions].find(([, pending]) => pending.requestId === requestId);

    if (existing !== undefined) {
      const [interactionId, pending] = existing;

      if (
        pending.method !== method ||
        pending.turnId !== turnId ||
        !isDeepStrictEqual(pending.params, params)
      ) {
        throw new Error(
          `OpenAI app-server request ${String(requestId)} changed identity or content.`,
        );
      }

      await this.#commitInteraction(pending);
      return interactionId;
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
    const bytes = this.#textEncoder.encode(JSON.stringify(pending)).byteLength;

    if (bytes > this.#maxPendingServerRequestBytes - this.#pendingServerRequestBytes) {
      throw new RangeError("OpenAI app-server pending request budget is exhausted.");
    }

    const tracked = { ...pending, bytes };
    this.#interactions.set(interaction.id, tracked);
    this.#pendingServerRequestBytes += bytes;
    await this.#commitInteraction(tracked);
    return interaction.id;
  }

  resolveInteraction(
    interactionId: string,
    resolution: InteractionResolution,
  ): OpenAiServerReply | null {
    this.#assertActive();
    const pending = this.#interactions.get(interactionId);

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
    this.#endedTurns.clear();
    this.#interactions.clear();
    this.#pendingTurnEnds.clear();
    this.#pendingTurnNotifications.clear();
    this.#pendingTurnReplays.clear();
    this.#pendingTurns.clear();
    this.#pendingServerRequestBytes = 0;
    this.#pendingTurnEndBytes = 0;
    this.#pendingTurnNotificationBytes = 0;
    this.#pendingTurnNotificationCount = 0;
    this.#receiptTimes.clear();
    this.#unknownReceiptEventId = undefined;
    this.#messageFilters.clear();
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
      this.#messageFilters.delete(`${turn.turnId}\u0000${itemId}`);
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
      const explanation = readString(params, "explanation");
      const plan = itemSchema.parse({
        audience: "participants",
        createdAt: previous?.createdAt ?? occurredAt,
        entries: readArray(params, "plan").flatMap((entry, index) => {
          if (!isRecord(entry)) {
            return [];
          }

          const text = readNonEmptyString(entry, "step");
          const status = readString(entry, "status");
          return text === null
            ? []
            : [
                {
                  id: String(index),
                  status:
                    status === "completed"
                      ? "completed"
                      : status === "inProgress"
                        ? "in_progress"
                        : "pending",
                  text,
                },
              ];
        }),
        ...(explanation === null ? {} : { explanation }),
        id: itemId,
        kind: "plan",
        provenance: provenance(method, {
          itemId,
          threadId: turn.threadId,
          turnId: turn.turnId,
        }),
        runId: turn.runId,
        status: "active",
        updatedAt: latestTimestamp(previous?.updatedAt, occurredAt),
      });

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

    const status = readString(nativeTurn, "status");

    if (status === "inProgress") {
      return;
    }

    if (status !== "completed" && status !== "failed" && status !== "interrupted") {
      throw new Error(`${method} params.turn.status is unsupported.`);
    }

    await this.#withReceiptTime(providerEventId(method, params), async (endedAt) => {
      const terminalItems: Item[] = [];
      const completedItemIds = new Set<string>();

      for (const nativeItem of readArray(nativeTurn, "items")) {
        if (!isRecord(nativeItem)) {
          continue;
        }

        const itemId = readNonEmptyString(nativeItem, "id");

        if (itemId === null) {
          continue;
        }

        const existing = this.#projection.item(turn.runId, itemId);

        if (existing !== undefined && existing.status !== "active") {
          continue;
        }

        const projected = this.#projectItem(turn, nativeItem, "completed", endedAt, method);

        if (projected !== null) {
          completedItemIds.add(itemId);
          terminalItems.push(projected);
        }
      }

      const activeItems = this.#projection
        .items(turn.runId)
        .filter((item) => item.status === "active");
      const incompleteSnapshot =
        status === "completed" &&
        activeItems.some(
          (item) =>
            !completedItemIds.has(item.id) && !(item.kind === "plan" && item.id === "turn-plan"),
        );
      const runStatus =
        status === "failed" || incompleteSnapshot
          ? "failed"
          : status === "interrupted"
            ? "cancelled"
            : "completed";
      const runError: ProtocolError = {
        code: incompleteSnapshot ? "openai.turn.incomplete" : "openai.turn.failed",
        message: incompleteSnapshot
          ? "OpenAI turn completed without authoritative snapshots for active items."
          : (readString(readRecord(nativeTurn, "error"), "message") ?? "OpenAI turn failed."),
        retryable: false,
      };

      if (status === "completed") {
        const plan = activeItems.find(
          (item) =>
            item.kind === "plan" && item.id === "turn-plan" && !completedItemIds.has(item.id),
        );

        if (plan !== undefined) {
          terminalItems.push(
            itemSchema.parse({
              ...plan,
              endedAt,
              status: "completed",
              updatedAt: latestTimestamp(plan.updatedAt, endedAt),
            }),
          );
        }
      }

      await this.#projection.finishRun({
        cause: { providerEventId: providerEventId(method, params), type: "provider" },
        event: method,
        ...(runStatus === "failed" ? { error: runError } : {}),
        ...(runStatus === "completed" ? { finishReason: "success" } : {}),
        runId: turn.runId,
        status: runStatus,
        terminalItems,
      });
      this.#rememberEndedTurn(turn);
      this.#releaseTurn(turnId);
    });
  }

  async #onRequestResolved(params: JsonObject, method: string): Promise<void> {
    const requestId = params["requestId"];
    const threadId = requireString(params, "threadId", `${method} params`);

    if (typeof requestId !== "number" && typeof requestId !== "string") {
      throw new Error(`${method} params.requestId must be a string or number.`);
    }

    const entry = [...this.#interactions].find(([, pending]) => pending.requestId === requestId);

    if (entry === undefined) {
      return;
    }

    const [interactionId, pending] = entry;
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
    turn: TurnState,
    native: JsonObject,
    lifecycle: NativeItemLifecycle,
    occurredAt: string,
    event: string,
  ): Item | null {
    const id = readNonEmptyString(native, "id");
    const type = readString(native, "type");

    if (id === null || type === null || type === "userMessage") {
      return null;
    }

    const existing = this.#projection.item(turn.runId, id);
    const status = itemStatus(native, lifecycle);
    const updatedAt = latestTimestamp(existing?.updatedAt, occurredAt);
    const base = {
      audience: type === "hookPrompt" ? "operators" : "participants",
      createdAt: existing?.createdAt ?? occurredAt,
      ...(status === "active" ? {} : { endedAt: updatedAt }),
      ...(status === "failed" ? { error: itemError(native, type) } : {}),
      id,
      provenance: provenance(event, {
        itemId: id,
        threadId: turn.threadId,
        turnId: turn.turnId,
      }),
      runId: turn.runId,
      status,
      updatedAt,
    };
    if (type === "agentMessage") {
      const nativeText = readString(native, "text");

      if (nativeText === null) {
        return null;
      }

      const phase = readString(native, "phase");
      const text = filterOpenAiPrivateCitations(nativeText).text;
      return itemSchema.parse({
        ...base,
        content: textContent(text),
        kind: "message",
        ...(phase === "commentary"
          ? { phase: "commentary" }
          : phase === "final_answer"
            ? { phase: "final" }
            : {}),
        role: "agent",
      });
    }

    if (type === "reasoning") {
      const text = readArray(native, "summary")
        .filter((entry) => typeof entry === "string")
        .join("\n\n");

      return itemSchema.parse({
        ...base,
        content: textContent(text),
        kind: "reasoning",
      });
    }

    if (type === "commandExecution") {
      const command = readString(native, "command");

      if (command === null) {
        return null;
      }

      const exitCode = readFiniteNumber(native, "exitCode");
      const aggregatedOutput = readString(native, "aggregatedOutput") ?? "";
      const cwd = readNonEmptyString(native, "cwd");

      return itemSchema.parse({
        ...base,
        command,
        ...(cwd === null ? {} : { cwd }),
        ...(exitCode === null ? {} : { exitCode }),
        kind: "terminal",
        stderr: [],
        stdout: textContent(aggregatedOutput),
      });
    }

    if (type === "fileChange") {
      const changes = toFileChanges(native);

      return changes.length === 0 && existing?.kind !== "change"
        ? null
        : itemSchema.parse({ ...base, changes, kind: "change" });
    }

    if (type === "mcpToolCall") {
      const server = readNonEmptyString(native, "server");
      const tool = readNonEmptyString(native, "tool");

      if (server === null || tool === null) {
        return null;
      }

      const result = readRecord(native, "result");
      const jsonInput = asJsonValue(native["arguments"]);
      const output = readArray(result, "content").flatMap<ContentBlock>((entry) => {
        if (isRecord(entry) && readString(entry, "type") === "text") {
          const text = readString(entry, "text");

          if (text !== null) {
            return [{ text, type: "text" }];
          }
        }

        const value = asJsonValue(entry);
        return value === undefined ? [] : [{ type: "json", value }];
      });
      const structuredOutput = asJsonValue(result?.["structuredContent"]);

      return itemSchema.parse({
        ...base,
        category: "other",
        ...(jsonInput === undefined ? {} : { input: jsonInput }),
        kind: "tool",
        name: tool,
        origin: "mcp",
        ...(output.length === 0 ? {} : { output }),
        server,
        ...(structuredOutput === undefined || structuredOutput === null
          ? {}
          : { structuredOutput }),
      });
    }

    if (type === "webSearch") {
      const query = readString(native, "query");

      if (query === null) {
        return null;
      }

      const action = asJsonValue(native["action"]);
      const structuredOutput = asJsonValue(native["results"]);

      return itemSchema.parse({
        ...base,
        category: "search",
        input: {
          ...(action === undefined || action === null ? {} : { action }),
          query,
        },
        kind: "tool",
        name: "web_search",
        origin: "provider",
        ...(structuredOutput === undefined || structuredOutput === null
          ? {}
          : { structuredOutput }),
      });
    }

    if (type === "plan") {
      const text = readString(native, "text");

      if (text === null) {
        return null;
      }

      const completed = lifecycle === "completed" || readString(native, "status") === "completed";

      return itemSchema.parse({
        ...base,
        entries: [{ id: "0", status: completed ? "completed" : "pending", text }],
        kind: "plan",
      });
    }

    if (type === "imageGeneration") {
      const result = readNonEmptyString(native, "result");
      const revisedPrompt = readNonEmptyString(native, "revisedPrompt");
      const savedPath = readNonEmptyString(native, "savedPath");

      return itemSchema.parse({
        ...base,
        category: "other",
        ...(revisedPrompt === null ? {} : { input: { revisedPrompt } }),
        kind: "tool",
        ...(savedPath === null ? {} : { locations: [{ path: savedPath }] }),
        name: "image_generation",
        origin: "provider",
        ...(result === null
          ? {}
          : { output: [{ data: result, mediaType: "image/png", type: "inline_blob" }] }),
      });
    }

    if (type === "dynamicToolCall") {
      const name = dynamicToolName(native);

      if (name === null) {
        return null;
      }

      const input = asJsonValue(native["arguments"]);
      const output = fromNativeToolContent(native);

      return itemSchema.parse({
        ...base,
        category: "other",
        ...(input === undefined ? {} : { input }),
        kind: "tool",
        name,
        origin: "provider",
        ...(output.length === 0 ? {} : { output }),
      });
    }

    if (type === "collabAgentToolCall") {
      const name = readNonEmptyString(native, "tool");

      if (name === null) {
        return null;
      }

      const input = asJsonValue({
        model: native["model"] ?? null,
        prompt: native["prompt"] ?? null,
        reasoningEffort: native["reasoningEffort"] ?? null,
        receiverThreadIds: readArray(native, "receiverThreadIds"),
        senderThreadId: native["senderThreadId"] ?? null,
      });
      const structuredOutput = asJsonValue(native["agentsStates"]);

      return itemSchema.parse({
        ...base,
        category: "agent",
        ...(input === undefined ? {} : { input }),
        kind: "tool",
        name,
        origin: "provider",
        ...(structuredOutput === undefined ? {} : { structuredOutput }),
      });
    }

    if (type === "subAgentActivity") {
      const input = asJsonValue({
        agentPath: native["agentPath"] ?? null,
        agentThreadId: native["agentThreadId"] ?? null,
        kind: native["kind"] ?? null,
      });

      return itemSchema.parse({
        ...base,
        category: "agent",
        ...(input === undefined ? {} : { input }),
        kind: "tool",
        name: "sub_agent_activity",
        origin: "provider",
      });
    }

    if (type === "imageView" || type === "sleep") {
      const name =
        readNonEmptyString(native, "tool") ??
        (type === "imageView" ? "image_view" : type === "sleep" ? "sleep" : type);
      const input = native["arguments"] ?? native["path"] ?? native["durationMs"];
      const output = native["contentItems"];
      const jsonInput = asJsonValue(input);
      const jsonOutput = asJsonValue(output);

      return itemSchema.parse({
        ...base,
        category: type === "imageView" ? "read" : "other",
        ...(jsonInput === undefined ? {} : { input: jsonInput }),
        kind: "tool",
        name,
        origin: "provider",
        ...(jsonOutput !== undefined
          ? { output: [{ type: "json", value: jsonOutput }], structuredOutput: jsonOutput }
          : {}),
      });
    }

    return itemSchema.parse({
      ...base,
      kind: "extension",
      name: PROVIDER_EXTENSION_ITEM,
      value: asJsonValue(native) ?? { nativeType: type },
    });
  }

  #projectInteraction(
    method: string,
    requestId: JsonRpcId,
    params: JsonObject,
    turn: TurnState,
  ): Interaction | null {
    const createdAt = this.#projection.now().toISOString();
    const itemId =
      readNonEmptyString(params, "itemId") ??
      (method === "item/tool/call" ? readNonEmptyString(params, "callId") : null);
    const knownItem =
      itemId !== null && this.#projection.item(turn.runId, itemId) !== undefined
        ? itemId
        : undefined;
    const requestedTimeoutMs = readFiniteNumber(params, "autoResolutionMs");
    const timeoutMs =
      requestedTimeoutMs !== null &&
      Number.isSafeInteger(requestedTimeoutMs) &&
      requestedTimeoutMs > 0
        ? Math.min(requestedTimeoutMs, this.#interactionTimeoutMs)
        : this.#interactionTimeoutMs;
    const common = {
      audience: "participants",
      blocking: true,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
      id: this.#createId(),
      ...(knownItem === undefined ? {} : { itemId: knownItem }),
      provenance: provenance(method, {
        ...(itemId === null ? {} : { itemId }),
        requestId: String(requestId),
        threadId: turn.threadId,
        turnId: turn.turnId,
      }),
      runId: turn.runId,
      status: "open",
    };

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      const command = readNonEmptyString(params, "command");
      const reason = readString(params, "reason");
      const availableDecisions = params["availableDecisions"];
      const allowed =
        method === "item/commandExecution/requestApproval" && Array.isArray(availableDecisions)
          ? new Set(availableDecisions.filter((value) => typeof value === "string"))
          : null;
      const options = [
        {
          decision: "accept",
          effect: "allow",
          id: "accept_once",
          label: "Allow once",
          scope: "once",
        },
        {
          decision: "acceptForSession",
          effect: "allow",
          id: "accept_session",
          label: "Allow for session",
          scope: "session",
        },
        { decision: "decline", effect: "deny", id: "decline", label: "Decline", scope: "once" },
      ].flatMap(({ decision, ...option }) =>
        allowed === null || allowed.has(decision) ? [option] : [],
      );

      if (options.length === 0) {
        return null;
      }

      return interactionSchema.parse({
        ...common,
        kind: "permission",
        request: {
          ...(reason === null ? {} : { description: reason }),
          options,
          subject:
            knownItem === undefined
              ? {
                  operation: method,
                  targets: [itemId ?? command ?? method],
                  type: "resource",
                }
              : { itemId: knownItem, type: "item" },
          title:
            method === "item/fileChange/requestApproval"
              ? "Approve file changes"
              : method === "item/permissions/requestApproval"
                ? "Approve runtime permissions"
                : "Approve command execution",
        },
      });
    }

    if (method === "item/tool/requestUserInput") {
      const questions = readArray(params, "questions").flatMap((entry) => {
        if (!isRecord(entry)) {
          return [];
        }

        const id = readNonEmptyString(entry, "id");
        const prompt = readNonEmptyString(entry, "question");

        if (id === null || prompt === null) {
          return [];
        }

        const nativeOptions = entry["options"];
        const mappedOptions = Array.isArray(nativeOptions)
          ? nativeOptions.flatMap((option, index) => {
              if (!isRecord(option)) {
                return [];
              }

              const label = readNonEmptyString(option, "label");
              const description = readString(option, "description");
              return label === null
                ? []
                : [
                    {
                      ...(description === null ? {} : { description }),
                      id: String(index),
                      label,
                    },
                  ];
            })
          : [];
        const options = mappedOptions.length === 0 ? undefined : mappedOptions;

        return [
          {
            ...(options !== undefined && entry["isOther"] === true ? { allowOther: true } : {}),
            id,
            ...(options === undefined ? {} : { options }),
            prompt,
            required: true,
            type:
              options === undefined
                ? entry["isSecret"] === true
                  ? "secret"
                  : "text"
                : "single_select",
          },
        ];
      });

      return questions.length === 0
        ? null
        : interactionSchema.parse({
            ...common,
            kind: "input",
            request: { questions },
          });
    }

    if (method === "item/tool/call") {
      const tool = dynamicToolName(params);
      const input = asJsonValue(params["arguments"]);

      return tool === null
        ? null
        : interactionSchema.parse({
            ...common,
            kind: "tool",
            request: {
              ...(input === undefined ? {} : { input }),
              name: tool,
            },
          });
    }

    if (method === "mcpServer/elicitation/request") {
      const request = asJsonValue(params);

      return request === undefined
        ? null
        : interactionSchema.parse({
            ...common,
            kind: "extension",
            name: OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION,
            request,
          });
    }

    return null;
  }

  #toRequestResult(pending: PendingServerRequest, resolution: InteractionResolution): unknown {
    if (
      pending.method === "item/commandExecution/requestApproval" ||
      pending.method === "item/fileChange/requestApproval"
    ) {
      if (resolution.kind !== "permission") {
        throw new Error("OpenAI approval request requires a permission resolution.");
      }

      const optionId = selectedOption(pending.interaction, resolution.value);
      const decision =
        optionId === null
          ? "cancel"
          : optionId === "accept_once"
            ? "accept"
            : optionId === "accept_session"
              ? "acceptForSession"
              : optionId === "decline"
                ? "decline"
                : null;

      if (decision === null) {
        throw new Error("OpenAI approval resolution selected an unknown option.");
      }

      return { decision };
    }

    if (pending.method === "item/permissions/requestApproval") {
      if (resolution.kind !== "permission") {
        throw new Error("OpenAI permission profile request requires a permission resolution.");
      }

      const optionId = selectedOption(pending.interaction, resolution.value);
      const accepted = optionId === "accept_once" || optionId === "accept_session";

      if (
        optionId !== null &&
        optionId !== "accept_once" &&
        optionId !== "accept_session" &&
        optionId !== "decline"
      ) {
        throw new Error("OpenAI permission resolution selected an unknown option.");
      }

      return {
        permissions:
          accepted && isRecord(pending.params["permissions"]) ? pending.params["permissions"] : {},
        scope: optionId === "accept_session" ? "session" : "turn",
      };
    }

    if (pending.method === "item/tool/requestUserInput") {
      if (resolution.kind !== "input") {
        throw new Error("OpenAI user input request requires an input resolution.");
      }

      return {
        answers:
          resolution.value.type === "cancelled"
            ? {}
            : Object.fromEntries(
                Object.entries(resolution.value.answers).map(([id, answers]) => [
                  id,
                  {
                    answers: answers.map((answer) => toInputAnswer(pending.params, id, answer)),
                  },
                ]),
              ),
      };
    }

    if (pending.method === "item/tool/call") {
      if (resolution.kind !== "tool") {
        throw new Error("OpenAI dynamic tool request requires a tool resolution.");
      }

      if (resolution.value.type === "completed") {
        const contentItems = resolution.value.output.flatMap(toNativeToolContent);

        if (resolution.value.structuredOutput !== undefined) {
          contentItems.push({
            text: JSON.stringify(resolution.value.structuredOutput),
            type: "inputText",
          });
        }

        return { contentItems, success: true };
      }

      const message =
        resolution.value.type === "failed"
          ? resolution.value.error.message
          : "Tool call cancelled.";
      return {
        contentItems: [{ text: message, type: "inputText" }],
        success: false,
      };
    }

    if (pending.method === "mcpServer/elicitation/request") {
      if (
        resolution.kind !== "extension" ||
        resolution.name !== OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION
      ) {
        throw new Error("OpenAI MCP elicitation requires its namespaced extension resolution.");
      }

      const value = requireRecord(resolution.value, "OpenAI MCP elicitation resolution");
      const action = readString(value, "action");

      if (action !== "accept" && action !== "decline" && action !== "cancel") {
        throw new Error("OpenAI MCP elicitation resolution has an unsupported action.");
      }

      return {
        _meta: asJsonValue(value["_meta"]) ?? null,
        action,
        content: asJsonValue(value["content"]) ?? null,
      };
    }

    throw new Error(`Unsupported OpenAI app-server request: ${pending.method}.`);
  }

  #requireTurn(params: JsonObject, method: string): TurnState {
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

  async #commitTurn(pending: PendingTurnAttachment): Promise<void> {
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
    const occurredAt = this.#receiptTimes.get(eventId) ?? this.#projection.now().toISOString();
    this.#receiptTimes.set(eventId, occurredAt);

    try {
      const result = await operation(occurredAt);
      this.#receiptTimes.delete(eventId);
      if (this.#unknownReceiptEventId === eventId) {
        this.#unknownReceiptEventId = undefined;
      }
      return result;
    } catch (error) {
      if (error instanceof AuthorityOutcomeUnknownError) {
        this.#unknownReceiptEventId ??= eventId;

        if (this.#unknownReceiptEventId !== eventId) {
          this.#receiptTimes.delete(eventId);
        }
      } else {
        this.#receiptTimes.delete(eventId);
        if (this.#unknownReceiptEventId === eventId) {
          this.#unknownReceiptEventId = undefined;
        }
      }
      throw error;
    }
  }

  async #commitInteraction(pending: PendingServerRequest): Promise<void> {
    if (this.#projection.interaction(pending.interaction.id) !== undefined) {
      return;
    }

    pending.commit ??= this.#projection
      .putInteraction(
        pending.interaction.runId,
        pending.method,
        {
          providerEventId: `${pending.method}:${String(pending.requestId)}`.slice(0, 256),
          type: "provider",
        },
        pending.interaction,
      )
      .then(() => {})
      .finally(() => {
        pending.commit = undefined;
      });
    await pending.commit;
  }

  #rememberTurnNotification(turnId: string, method: string, params: JsonObject): void {
    if (this.#pendingTurnEnds.has(turnId)) {
      throw new Error(
        `OpenAI app-server event ${method} arrived after terminal Turn ${turnId} before attachment.`,
      );
    }

    const snapshot = structuredClone(params);
    const bytes = this.#textEncoder.encode(JSON.stringify(snapshot)).byteLength;

    if (
      this.#pendingTurnNotificationCount >= MAX_TRACKED_TURN_ENDS ||
      bytes > MAX_PENDING_TURN_END_BYTES - this.#pendingTurnNotificationBytes
    ) {
      throw new RangeError("OpenAI app-server pending Turn event limit is exhausted.");
    }

    const queue = this.#pendingTurnNotifications.get(turnId) ?? [];
    queue.push({ bytes, method, params: snapshot });
    this.#pendingTurnNotifications.set(turnId, queue);
    this.#pendingTurnNotificationBytes += bytes;
    this.#pendingTurnNotificationCount += 1;
  }

  async #replayPendingTurn(turnId: string): Promise<void> {
    const existing = this.#pendingTurnReplays.get(turnId);

    if (existing !== undefined) {
      await existing;
      return;
    }

    const task = this.#drainPendingTurn(turnId).finally(() => {
      if (this.#pendingTurnReplays.get(turnId) === task) {
        this.#pendingTurnReplays.delete(turnId);
      }
    });
    this.#pendingTurnReplays.set(turnId, task);
    await task;
  }

  async #drainPendingTurn(turnId: string): Promise<void> {
    for (;;) {
      const queue = this.#pendingTurnNotifications.get(turnId);
      const pending = queue?.[0];

      if (queue !== undefined && pending !== undefined) {
        await this.#dispatchNotification(pending.method, pending.params);

        if (this.#disposed || this.#pendingTurnNotifications.get(turnId) !== queue) {
          return;
        }

        queue.shift();
        this.#pendingTurnNotificationBytes -= pending.bytes;
        this.#pendingTurnNotificationCount -= 1;

        if (queue.length === 0) {
          this.#pendingTurnNotifications.delete(turnId);
        }
        continue;
      }

      await this.#replayTurnEnd(turnId);

      if (!this.#pendingTurnNotifications.has(turnId) && !this.#pendingTurnEnds.has(turnId)) {
        return;
      }
    }
  }

  #rememberTurnEnd(turnId: string, params: JsonObject): void {
    const existing = this.#pendingTurnEnds.get(turnId);

    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing.params, params)) {
        throw new Error(`OpenAI terminal Turn ${turnId} changed before attachment.`);
      }
      return;
    }

    const snapshot = structuredClone(params);
    const bytes = this.#textEncoder.encode(JSON.stringify(snapshot)).byteLength;

    if (
      this.#pendingTurnEnds.size >= MAX_TRACKED_TURN_ENDS ||
      bytes > MAX_PENDING_TURN_END_BYTES - this.#pendingTurnEndBytes
    ) {
      throw new RangeError("OpenAI app-server pending terminal Turn limit is exhausted.");
    }

    this.#pendingTurnEnds.set(turnId, { bytes, params: snapshot });
    this.#pendingTurnEndBytes += bytes;
  }

  async #replayTurnEnd(turnId: string): Promise<void> {
    const pending = this.#pendingTurnEnds.get(turnId);

    if (pending === undefined) {
      return;
    }

    pending.task ??= this.#onTurnEnd(pending.params, "turn/completed")
      .then(() => {
        if (this.#pendingTurnEnds.get(turnId) === pending) {
          this.#pendingTurnEnds.delete(turnId);
          this.#pendingTurnEndBytes -= pending.bytes;
        }
      })
      .finally(() => {
        pending.task = undefined;
      });
    await pending.task;
  }

  #rememberEndedTurn(turn: TurnState): void {
    this.#endedTurns.delete(turn.turnId);
    this.#endedTurns.set(turn.turnId, turn);

    if (this.#endedTurns.size > MAX_TRACKED_TURN_ENDS) {
      const oldest = this.#endedTurns.keys().next().value;

      if (oldest !== undefined) {
        this.#endedTurns.delete(oldest);
      }
    }
  }

  #dropInteraction(interactionId: string): void {
    const pending = this.#interactions.get(interactionId);

    if (pending !== undefined) {
      this.#pendingServerRequestBytes -= pending.bytes;
      this.#interactions.delete(interactionId);
      this.#projection.releaseInteraction(interactionId);
    }
  }

  #releaseTurn(turnId: string): void {
    this.#turns.delete(turnId);
    const prefix = `${turnId}\u0000`;

    for (const [id, pending] of this.#interactions) {
      if (pending.turnId === turnId) {
        this.#dropInteraction(id);
      }
    }

    for (const key of this.#messageFilters.keys()) {
      if (key.startsWith(prefix)) {
        this.#messageFilters.delete(key);
      }
    }
  }

  #messageFilter(turnId: string, itemId: string): OpenAiPrivateCitationStreamFilter {
    const key = `${turnId}\u0000${itemId}`;
    let filter = this.#messageFilters.get(key);

    if (filter === undefined) {
      filter = new OpenAiPrivateCitationStreamFilter();
      this.#messageFilters.set(key, filter);
    }

    return filter;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("OpenAI Contract adapter is disposed.");
    }
  }
}
