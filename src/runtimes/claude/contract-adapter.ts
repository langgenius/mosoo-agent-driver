import { isDeepStrictEqual } from "node:util";

import type { CanUseTool, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  AuthorityOutcomeUnknownError,
  itemSchema,
  permissionInteractionSchema,
} from "../../contract";
import type {
  ContentBlock,
  InteractionResolution,
  PermissionInteraction,
  PermissionOption,
  ProtocolError,
  Run,
  TokenUsage,
  ToolItem,
} from "../../contract";
import { createDriverId } from "../../protocol/id";
import {
  asJsonValue,
  createProviderMeta,
  ContractProjection,
  nonEmpty,
  type ContractProjectionOptions,
} from "../contract-projection";
import {
  isRecord,
  readNumber,
  readRecord,
  readString,
  sumTokenCounts,
  toCostAmount,
  toTokenCount,
} from "./agent-sdk-json";
import type { JsonObject } from "./agent-sdk-json";

const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_PENDING_PERMISSION_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAX_TOOL_INPUT_BYTES = 1_024 * 1_024;
const PROVIDER = "anthropic";
const { cause: providerCause, provenance } = createProviderMeta(PROVIDER);

type PermissionOptions = Parameters<CanUseTool>[2];

interface PermissionCancellation {
  onAbort: () => void;
  readonly signals: Map<AbortSignal, () => void>;
}

interface PendingPermission {
  aborted: PermissionInteraction | null;
  abortTask: Promise<void> | null;
  readonly bytes: number;
  readonly cancellation: PermissionCancellation;
  readonly interaction: PermissionInteraction;
  readonly request: {
    readonly input: Record<string, unknown>;
    readonly options: Record<string, unknown>;
    readonly toolName: string;
  };
  readonly requestId: string;
  readonly runId: string;
  readonly sessionSuggestions: PermissionOptions["suggestions"];
  readonly toolUseId: string;
}

interface OpeningPermission {
  readonly bytes: number;
  readonly cancellation: PermissionCancellation;
  readonly request: PendingPermission["request"];
  readonly runId: string;
  readonly task: Promise<string>;
  readonly toolUseId: string;
}

interface ToolInputBuffer {
  readonly bytes: number;
  readonly overflowed: boolean;
  readonly text: string;
}

export interface ClaudeContractAdapterOptions extends ContractProjectionOptions {
  readonly createId?: (() => string) | undefined;
  readonly interactionTimeoutMs?: number | undefined;
  readonly maxPendingPermissionBytes?: number | undefined;
  readonly maxToolInputBytes?: number | undefined;
  readonly nativeSessionId?: string | undefined;
}

function toContentBlocks(value: unknown): ContentBlock[] {
  const values = Array.isArray(value) ? value : [value];

  return values.flatMap<ContentBlock>((entry) => {
    if (typeof entry === "string") {
      return entry.length === 0 ? [] : [{ text: entry, type: "text" }];
    }

    if (!isRecord(entry)) {
      const json = asJsonValue(entry);
      return json === undefined ? [] : [{ type: "json", value: json }];
    }

    if (entry["type"] === "text") {
      const text = readString(entry, "text");
      return text === null ? [] : [{ text, type: "text" }];
    }

    const source = readRecord(entry, "source");

    if (entry["type"] === "image" && source?.["type"] === "base64") {
      const data = readString(source, "data");
      const mediaType = readString(source, "media_type");
      return data === null || mediaType === null ? [] : [{ data, mediaType, type: "inline_blob" }];
    }

    if (entry["type"] === "image" && source?.["type"] === "url") {
      const uri = readString(source, "url");
      return uri !== null && URL.canParse(uri) ? [{ type: "resource_link", uri }] : [];
    }

    const json = asJsonValue(entry);
    return json === undefined ? [] : [{ type: "json", value: json }];
  });
}

function toolCategory(name: string): ToolItem["category"] {
  const normalized = name.toLowerCase();

  if (normalized === "read") {
    return "read";
  }

  if (["edit", "multiedit", "notebookedit", "write"].includes(normalized)) {
    return "edit";
  }

  if (["glob", "grep"].includes(normalized)) {
    return "search";
  }

  if (normalized === "bash") {
    return "execute";
  }

  if (["webfetch", "websearch"].includes(normalized)) {
    return "fetch";
  }

  if (["agent", "task", "sendmessage"].includes(normalized)) {
    return "agent";
  }

  return "other";
}

function toUsage(message: Extract<SDKMessage, { type: "result" }>): TokenUsage | undefined {
  const raw = isRecord(message.usage) ? message.usage : null;
  const cachedInput = toTokenCount(raw?.["cache_read_input_tokens"]);
  const input = toTokenCount(raw?.["input_tokens"]);
  const output = toTokenCount(raw?.["output_tokens"]);
  const total = sumTokenCounts(input, output);
  const cost = toCostAmount(message.total_cost_usd);
  const usage = {
    ...(cachedInput === null ? {} : { cachedInput }),
    ...(cost === null ? {} : { cost: { amount: cost, currency: "USD" } }),
    ...(input === null ? {} : { input }),
    ...(output === null ? {} : { output }),
    ...(total === null ? {} : { total }),
  } satisfies TokenUsage;

  return Object.keys(usage).length === 0 ? undefined : usage;
}

function permissionOptions(options: PermissionOptions): PermissionOption[] {
  const allowSession = options.suggestions?.some(
    (suggestion) => suggestion.destination === "session",
  );
  const result: PermissionOption[] = [
    { effect: "allow", id: "allow_once", label: "Allow once", scope: "once" },
  ];

  if (allowSession) {
    result.push({
      effect: "allow",
      id: "allow_session",
      label: "Allow for session",
      scope: "session",
    });
  }

  result.push({ effect: "deny", id: "deny_once", label: "Deny", scope: "once" });
  return result;
}

function isLimit(message: Extract<SDKMessage, { type: "result" }>): boolean {
  return (
    message.subtype === "error_max_turns" ||
    message.subtype === "error_max_budget_usd" ||
    message.subtype === "error_max_structured_output_retries" ||
    message.stop_reason === "max_tokens" ||
    message.terminal_reason === "max_turns" ||
    message.terminal_reason === "budget_exhausted" ||
    message.terminal_reason === "structured_output_retry_exhausted"
  );
}

function finishReason(
  message: Extract<SDKMessage, { type: "result" }>,
): "limit" | "other" | "refusal" | "success" {
  if (message.stop_reason === "refusal") {
    return "refusal";
  }

  if (isLimit(message)) {
    return "limit";
  }

  return message.terminal_reason === "background_requested" ||
    message.terminal_reason === "tool_deferred" ||
    message.terminal_reason === "tool_deferred_unavailable"
    ? "other"
    : "success";
}

function isRetryable(
  message: Exclude<Extract<SDKMessage, { type: "result" }>, { subtype: "success" }>,
): boolean {
  return (
    message.terminal_reason === "api_error" ||
    message.terminal_reason === "model_error" ||
    message.terminal_reason === "blocking_limit" ||
    message.terminal_reason === "rapid_refill_breaker"
  );
}

export class ClaudeContractAdapter {
  readonly #authoritativeToolInputs = new Set<string>();
  readonly #blockToolIds = new Map<string, string>();
  readonly #createId: () => string;
  #disposed = false;
  readonly #finishingRuns = new Set<string>();
  readonly #ids = new Map<string, Map<string, string>>();
  readonly #interactionTimeoutMs: number;
  readonly #maxPendingPermissionBytes: number;
  readonly #maxToolInputBytes: number;
  #nativeSessionId: string | null;
  readonly #openingPermissions = new Map<string, OpeningPermission>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #projection: ContractProjection;
  readonly #textEncoder = new TextEncoder();
  #pendingPermissionBytes = 0;
  #toolInputBytes = 0;
  readonly #toolInputFragments = new Map<string, ToolInputBuffer>();

  constructor(options: ClaudeContractAdapterOptions) {
    this.#createId = options.createId ?? createDriverId;
    this.#interactionTimeoutMs = options.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
    this.#maxPendingPermissionBytes =
      options.maxPendingPermissionBytes ?? DEFAULT_MAX_PENDING_PERMISSION_BYTES;
    this.#maxToolInputBytes = options.maxToolInputBytes ?? DEFAULT_MAX_TOOL_INPUT_BYTES;
    this.#nativeSessionId = options.nativeSessionId ?? null;
    this.#projection = new ContractProjection(options);

    if (
      [this.#interactionTimeoutMs, this.#maxPendingPermissionBytes, this.#maxToolInputBytes].some(
        (value) => !Number.isSafeInteger(value) || value < 1,
      )
    ) {
      throw new RangeError("Claude Agent SDK limits must be finite and positive.");
    }

    if (this.#nativeSessionId !== null && this.#nativeSessionId.trim().length === 0) {
      throw new Error("Claude Contract adapter requires a non-empty native session ID.");
    }
  }

  attachRun(run: Run): void {
    this.#assertActive();
    this.#projection.attachRun(run);
  }

  async handleMessage(message: SDKMessage, runId: string): Promise<boolean> {
    this.#assertActive();
    this.#assertNativeSession(message);

    if (this.#finishingRuns.has(runId) || this.#projection.run(runId)?.status !== "active") {
      return false;
    }

    switch (message.type) {
      case "assistant":
        await this.#onAssistant(message, runId);
        return false;
      case "result": {
        this.#finishingRuns.add(runId);
        try {
          await this.#onResult(message, runId);
          return true;
        } catch (error) {
          if (this.#projection.run(runId)?.status === "active") {
            this.#finishingRuns.delete(runId);
          }
          throw error;
        }
      }
      case "stream_event":
        await this.#onStreamEvent(message, runId);
        return false;
      case "tool_progress":
        await this.#onToolProgress(message, runId);
        return false;
      case "user":
        await this.#onUserMessage(message, runId);
        return false;
      case "system":
        await this.#onSystemMessage(message, runId);
        return false;
      default:
        return false;
    }
  }

  async openPermission(
    runId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: PermissionOptions,
  ): Promise<string> {
    this.#assertActive();
    if (this.#finishingRuns.has(runId)) {
      throw new Error("Claude permission request outlived its active Run.");
    }
    const projectedInput = this.#toolInput(input);

    if (!isRecord(projectedInput)) {
      throw new Error("Claude permission tool input must be finite JSON.");
    }

    const request = {
      input: projectedInput,
      options: structuredClone(
        Object.fromEntries(Object.entries(options).filter(([name]) => name !== "signal")),
      ),
      toolName,
    };
    const opening = this.#openingPermissions.get(options.requestId);

    if (opening !== undefined) {
      if (
        opening.runId !== runId ||
        opening.toolUseId !== options.toolUseID ||
        !isDeepStrictEqual(opening.request, request)
      ) {
        throw new Error(
          `Claude permission request ${options.requestId} changed identity or content.`,
        );
      }

      this.#trackSignal(opening.cancellation, options.signal);
      return opening.task;
    }

    const existingPermission = [...this.#pendingPermissions].find(
      ([, pending]) => pending.requestId === options.requestId,
    );

    if (existingPermission !== undefined) {
      const [interactionId, pending] = existingPermission;

      if (
        pending.runId !== runId ||
        pending.toolUseId !== options.toolUseID ||
        !isDeepStrictEqual(pending.request, request)
      ) {
        throw new Error(
          `Claude permission request ${options.requestId} changed identity or content.`,
        );
      }

      this.#trackSignal(pending.cancellation, options.signal);
      const aborted = this.#abortedSignal(pending.cancellation);
      if (aborted !== null) {
        await this.#abortPermission(interactionId);
        aborted.throwIfAborted();
      }
      return interactionId;
    }

    options.signal.throwIfAborted();
    const bytes = this.#textEncoder.encode(JSON.stringify(request)).byteLength;

    if (bytes > this.#maxPendingPermissionBytes - this.#pendingPermissionBytes) {
      throw new RangeError("Claude pending permission budget is exhausted.");
    }

    this.#pendingPermissionBytes += bytes;
    const cancellation: PermissionCancellation = {
      onAbort: () => {},
      signals: new Map(),
    };
    this.#trackSignal(cancellation, options.signal);
    const task = this.#createPermission(
      runId,
      toolName,
      projectedInput,
      options,
      request,
      bytes,
      cancellation,
    );
    const openingPermission: OpeningPermission = {
      bytes,
      cancellation,
      request,
      runId,
      task,
      toolUseId: options.toolUseID,
    };
    this.#openingPermissions.set(options.requestId, openingPermission);

    try {
      return await task;
    } catch (error) {
      this.#dropOpening(options.requestId, openingPermission);
      throw error;
    }
  }

  async #createPermission(
    runId: string,
    toolName: string,
    projectedInput: JsonObject,
    options: PermissionOptions,
    request: PendingPermission["request"],
    bytes: number,
    cancellation: PermissionCancellation,
  ): Promise<string> {
    this.#throwIfAborted(cancellation);
    const itemId = this.#id(runId, "tool", options.toolUseID);
    const now = this.#projection.now();
    const current = this.#projection.item(runId, itemId);
    const name = nonEmpty(toolName, "Tool");

    if (current !== undefined && (current.kind !== "tool" || current.status !== "active")) {
      throw new Error("Claude permission request references a terminal or non-tool item.");
    }

    if (current === undefined) {
      const item = itemSchema.parse({
        audience: "participants",
        category: toolCategory(name),
        createdAt: now.toISOString(),
        id: itemId,
        input: projectedInput,
        kind: "tool",
        name,
        origin: name.startsWith("mcp__") ? "mcp" : "provider",
        provenance: provenance("permission/requested", {
          requestId: options.requestId,
          toolUseId: options.toolUseID,
        }),
        runId,
        status: "active",
        title: nonEmpty(options.displayName ?? options.title, name),
        updatedAt: now.toISOString(),
      });
      await this.#retryUnknown(() =>
        this.#projection.putItem(
          runId,
          "permission/requested.tool",
          providerCause("permission/requested", options.requestId),
          item,
        ),
      );
      this.#authoritativeToolInputs.add(`${runId}:${itemId}`);
    }

    this.#throwIfAborted(cancellation);

    const interactionId = this.#createId();
    const interaction = permissionInteractionSchema.parse({
      audience: "participants",
      blocking: true,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#interactionTimeoutMs).toISOString(),
      id: interactionId,
      itemId,
      kind: "permission",
      provenance: provenance("permission/requested", {
        requestId: options.requestId,
        toolUseId: options.toolUseID,
      }),
      request: {
        ...(options.description === undefined ? {} : { description: options.description }),
        options: permissionOptions(options),
        subject: { itemId, type: "item" },
        title: nonEmpty(options.title ?? options.displayName, `Allow ${name}?`),
      },
      runId,
      status: "open",
    });
    await this.#retryUnknown(() =>
      this.#projection.putInteraction(
        runId,
        "permission/requested",
        providerCause("permission/requested", options.requestId),
        interaction,
      ),
    );

    this.#assertActive();
    if (this.#finishingRuns.has(runId) || this.#projection.run(runId)?.status !== "active") {
      throw new Error("Claude permission request outlived its active Run.");
    }

    this.#openingPermissions.delete(options.requestId);
    const pending: PendingPermission = {
      aborted: null,
      abortTask: null,
      bytes,
      cancellation,
      interaction,
      request,
      requestId: options.requestId,
      runId,
      sessionSuggestions: options.suggestions
        ?.filter((suggestion) => suggestion.destination === "session")
        .map((suggestion) => structuredClone(suggestion)),
      toolUseId: options.toolUseID,
    };
    this.#pendingPermissions.set(interactionId, pending);
    cancellation.onAbort = () => {
      void this.#abortPermission(interactionId).catch(() => {});
    };
    const aborted = this.#abortedSignal(cancellation);
    if (aborted !== null) {
      await this.#abortPermission(interactionId);
      aborted.throwIfAborted();
    }
    return interactionId;
  }

  async resolveInteraction(
    interactionId: string,
    resolution: InteractionResolution,
  ): Promise<PermissionResult | null> {
    this.#assertActive();
    const pending = this.#pendingPermissions.get(interactionId);

    if (pending === undefined) {
      return null;
    }

    if (this.#abortedSignal(pending.cancellation) !== null) {
      await this.#abortPermission(interactionId);
      return null;
    }

    if (resolution.kind !== "permission") {
      throw new Error("Claude permission interaction requires a permission resolution.");
    }

    const selected = resolution.value.type === "selected" ? resolution.value.optionId : null;
    const available = pending.interaction.request.options.some((option) => option.id === selected);

    if (selected !== null && !available) {
      throw new Error("Claude permission resolution selected an unavailable option.");
    }

    this.#projection.releaseInteraction(interactionId);
    this.#dropPermission(interactionId);

    if (selected === "allow_once" || selected === "allow_session") {
      return {
        behavior: "allow",
        toolUseID: pending.toolUseId,
        updatedInput: pending.request.input,
        ...(selected === "allow_session" && pending.sessionSuggestions !== undefined
          ? { updatedPermissions: pending.sessionSuggestions }
          : {}),
      };
    }

    return {
      behavior: "deny",
      interrupt: resolution.value.type === "cancelled",
      message: "Rejected by user.",
      toolUseID: pending.toolUseId,
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.#authoritativeToolInputs.clear();
    this.#blockToolIds.clear();
    this.#finishingRuns.clear();
    this.#ids.clear();
    for (const [requestId, opening] of this.#openingPermissions) {
      this.#dropOpening(requestId, opening);
    }
    for (const id of this.#pendingPermissions.keys()) {
      this.#dropPermission(id);
    }
    this.#pendingPermissionBytes = 0;
    this.#toolInputBytes = 0;
    this.#toolInputFragments.clear();
    this.#nativeSessionId = null;
    this.#projection.dispose();
  }

  async #onAssistant(
    message: Extract<SDKMessage, { type: "assistant" }>,
    runId: string,
  ): Promise<void> {
    const event = "assistant/message";
    const occurredAt = this.#projection.now().toISOString();
    const messageId = this.#id(runId, "message", message.uuid);
    const reasoningId = this.#reasoningId(runId, messageId);
    const text: ContentBlock[] = [];
    const reasoning: ContentBlock[] = [];

    for (const block of message.message.content) {
      if (!isRecord(block)) {
        continue;
      }

      if (block["type"] === "text") {
        const content = toContentBlocks(block);

        if (content.length > 0) {
          await this.#ensureMessage(runId, messageId, event, message.uuid);
          text.push(...content);
        }
        continue;
      }

      if (block["type"] === "thinking") {
        const thinking = readString(block, "thinking");
        if (thinking !== null) {
          await this.#ensureReasoning(runId, messageId, event, message.uuid);
          reasoning.push({ text: thinking, type: "text" });
        }
        continue;
      }

      if (this.#isToolUse(block)) {
        await this.#putToolUse(runId, messageId, block, event, occurredAt);
        continue;
      }

      const toolUseId = readString(block, "tool_use_id");
      if (toolUseId !== null) {
        await this.#completeTool(runId, toolUseId, block, undefined, event, occurredAt);
      }
    }

    if (text.length > 0 || this.#projection.item(runId, messageId)?.kind === "message") {
      const current = this.#projection.item(runId, messageId);
      if (current?.status === "active" || current === undefined) {
        await this.#projection.putItem(
          runId,
          event,
          providerCause(event, message.uuid),
          itemSchema.parse({
            audience: "participants",
            content: text,
            createdAt: current?.createdAt ?? occurredAt,
            endedAt: occurredAt,
            ...(message.error === undefined
              ? { status: "completed" }
              : {
                  error: {
                    code: `anthropic.${message.error}`,
                    message: `Assistant message failed: ${message.error}.`,
                    retryable:
                      message.error === "overloaded" ||
                      message.error === "rate_limit" ||
                      message.error === "server_error",
                  },
                  status: "failed",
                }),
            id: messageId,
            kind: "message",
            phase: "final",
            provenance: provenance(event, {
              messageId: message.uuid,
              ...(message.parent_tool_use_id === null
                ? {}
                : { parentToolUseId: message.parent_tool_use_id }),
            }),
            role: "agent",
            runId,
            updatedAt: occurredAt,
            ...(message.supersedes === undefined && message.timestamp === undefined
              ? {}
              : {
                  extensions: {
                    ...(message.timestamp === undefined
                      ? {}
                      : { "anthropic.agent-sdk/source-timestamp": message.timestamp }),
                    ...(message.supersedes === undefined
                      ? {}
                      : { "anthropic.agent-sdk/supersedes": message.supersedes }),
                  },
                }),
          }),
        );
      }
    }

    const currentReasoning = this.#projection.item(runId, reasoningId);
    if (reasoning.length > 0 || currentReasoning?.kind === "reasoning") {
      if (currentReasoning?.status === "active" || currentReasoning === undefined) {
        await this.#projection.putItem(
          runId,
          event,
          providerCause(event, message.uuid),
          itemSchema.parse({
            audience: "participants",
            content: reasoning,
            createdAt: currentReasoning?.createdAt ?? occurredAt,
            endedAt: occurredAt,
            id: reasoningId,
            kind: "reasoning",
            provenance: provenance(event, { messageId: message.uuid }),
            runId,
            status: "completed",
            updatedAt: occurredAt,
            ...(message.timestamp === undefined
              ? {}
              : {
                  extensions: {
                    "anthropic.agent-sdk/source-timestamp": message.timestamp,
                  },
                }),
          }),
        );
      }
    }
  }

  async #onStreamEvent(
    message: Extract<SDKMessage, { type: "stream_event" }>,
    runId: string,
  ): Promise<void> {
    const event = isRecord(message.event) ? message.event : null;
    const eventType = readString(event, "type");
    const messageId = this.#id(runId, "message", message.uuid);

    if (eventType === "message_start") {
      return;
    }

    if (eventType === "content_block_start") {
      const block = readRecord(event, "content_block");
      const index = readNumber(event, "index");

      if (block?.["type"] === "text") {
        await this.#ensureMessage(runId, messageId, "stream/content_block_start", message.uuid);
        const text = readString(block, "text");
        if (text !== null) {
          await this.#appendText(
            runId,
            messageId,
            "message.text",
            text,
            "stream/content_block_start",
          );
        }
      } else if (block?.["type"] === "thinking") {
        const reasoningId = await this.#ensureReasoning(
          runId,
          messageId,
          "stream/content_block_start",
          message.uuid,
        );
        const text = readString(block, "thinking");
        if (text !== null) {
          await this.#appendText(
            runId,
            reasoningId,
            "reasoning.text",
            text,
            "stream/content_block_start",
          );
        }
      } else if (block !== null && this.#isToolUse(block)) {
        const toolId = await this.#putToolUse(
          runId,
          messageId,
          block,
          "stream/content_block_start",
          this.#projection.now().toISOString(),
        );
        if (index !== null && !this.#authoritativeToolInputs.has(`${runId}:${toolId}`)) {
          this.#blockToolIds.set(`${runId}:${message.uuid}:${index}`, toolId);
        }
      }
      return;
    }

    if (eventType === "content_block_delta") {
      const delta = readRecord(event, "delta");
      const deltaType = readString(delta, "type");

      if (deltaType === "text_delta") {
        await this.#ensureMessage(runId, messageId, "stream/text_delta", message.uuid);
        await this.#appendText(
          runId,
          messageId,
          "message.text",
          readString(delta, "text") ?? "",
          "stream/text_delta",
        );
      } else if (deltaType === "thinking_delta") {
        const reasoningId = await this.#ensureReasoning(
          runId,
          messageId,
          "stream/thinking_delta",
          message.uuid,
        );
        await this.#appendText(
          runId,
          reasoningId,
          "reasoning.text",
          readString(delta, "thinking") ?? "",
          "stream/thinking_delta",
        );
      } else if (deltaType === "input_json_delta") {
        const index = readNumber(event, "index");
        const toolId =
          index === null ? undefined : this.#blockToolIds.get(`${runId}:${message.uuid}:${index}`);
        const fragment = readString(delta, "partial_json");
        if (toolId !== undefined && fragment !== null) {
          const key = `${runId}:${toolId}`;
          const current = this.#toolInputFragments.get(key) ?? {
            bytes: 0,
            overflowed: false,
            text: "",
          };

          if (!current.overflowed) {
            const addedBytes = this.#textEncoder.encode(fragment).byteLength;

            if (addedBytes > this.#maxToolInputBytes - this.#toolInputBytes) {
              this.#toolInputBytes -= current.bytes;
              this.#toolInputFragments.set(key, { bytes: 0, overflowed: true, text: "" });
            } else {
              this.#toolInputBytes += addedBytes;
              this.#toolInputFragments.set(key, {
                bytes: current.bytes + addedBytes,
                overflowed: false,
                text: current.text + fragment,
              });
            }
          }
        }
      }
      return;
    }

    if (eventType === "content_block_stop") {
      const index = readNumber(event, "index");
      const key = index === null ? null : `${runId}:${message.uuid}:${index}`;
      const toolId = key === null ? undefined : this.#blockToolIds.get(key);

      if (toolId !== undefined) {
        const item = this.#projection.item(runId, toolId);
        const fragmentKey = `${runId}:${toolId}`;
        const buffer = this.#toolInputFragments.get(fragmentKey);
        if (
          item?.kind === "tool" &&
          item.status === "active" &&
          buffer !== undefined &&
          !buffer.overflowed &&
          !this.#authoritativeToolInputs.has(fragmentKey)
        ) {
          try {
            const input = this.#toolInput(JSON.parse(buffer.text));
            if (input !== undefined) {
              await this.#projection.putItem(
                runId,
                "stream/input_json",
                providerCause("stream/input_json", toolId),
                itemSchema.parse({
                  ...item,
                  input,
                  updatedAt: this.#projection.now().toISOString(),
                }),
              );
            }
          } catch {}
        }
        this.#dropToolInput(fragmentKey);
      }
      if (key !== null) {
        this.#blockToolIds.delete(key);
      }
      return;
    }
  }

  async #onUserMessage(
    message: Extract<SDKMessage, { type: "user" }>,
    runId: string,
  ): Promise<void> {
    const blocks = Array.isArray(message.message.content) ? message.message.content : [];
    const occurredAt = this.#projection.now().toISOString();

    for (const block of blocks) {
      if (!isRecord(block) || block["type"] !== "tool_result") {
        continue;
      }

      const toolUseId = readString(block, "tool_use_id");
      if (toolUseId !== null) {
        await this.#completeTool(
          runId,
          toolUseId,
          block,
          message.tool_use_result,
          "user/tool_result",
          occurredAt,
        );
      }
    }
  }

  async #onToolProgress(
    message: Extract<SDKMessage, { type: "tool_progress" }>,
    runId: string,
  ): Promise<void> {
    const itemId = this.#id(runId, "tool", message.tool_use_id);
    const name = nonEmpty(message.tool_name, "Tool");
    let item = this.#projection.item(runId, itemId);

    if (item === undefined) {
      const now = this.#projection.now().toISOString();
      item = await this.#projection.putItem(
        runId,
        "tool/progress",
        providerCause("tool/progress", message.tool_use_id),
        itemSchema.parse({
          audience: "participants",
          category: toolCategory(name),
          createdAt: now,
          id: itemId,
          kind: "tool",
          name,
          origin: name.startsWith("mcp__") ? "mcp" : "provider",
          provenance: provenance("tool/progress", { toolUseId: message.tool_use_id }),
          runId,
          status: "active",
          updatedAt: now,
        }),
      );
    }

    if (item.status === "active") {
      await this.#projection.replacePreview({
        channel: "tool.progress",
        itemId,
        runId,
        text: `${name} (${message.elapsed_time_seconds.toFixed(1)}s)`,
      });
    }
  }

  async #onSystemMessage(
    message: Extract<SDKMessage, { type: "system" }>,
    runId: string,
  ): Promise<void> {
    if (message.subtype === "files_persisted" && message.files.length > 0) {
      const changes = message.files.flatMap((file) =>
        file.filename.trim().length === 0 ? [] : [{ operation: "update", path: file.filename }],
      );

      if (changes.length === 0) {
        return;
      }

      const now = this.#projection.now().toISOString();
      const id = this.#id(runId, "files", message.uuid);

      if (this.#projection.item(runId, id) !== undefined) {
        return;
      }

      await this.#projection.putItem(
        runId,
        "system/files_persisted",
        providerCause("system/files_persisted", message.uuid),
        itemSchema.parse({
          audience: "participants",
          changes,
          createdAt: now,
          endedAt: now,
          id,
          kind: "change",
          provenance: provenance("system/files_persisted", { messageId: message.uuid }),
          runId,
          status: "completed",
          updatedAt: now,
        }),
      );
      return;
    }

    if (message.subtype === "task_started") {
      const now = this.#projection.now().toISOString();
      const id = this.#id(runId, "task", message.task_id);

      if (this.#projection.item(runId, id) !== undefined) {
        return;
      }

      const name = nonEmpty(
        message.subagent_type ?? message.workflow_name ?? message.task_type,
        "Agent",
      );
      await this.#projection.putItem(
        runId,
        "system/task_started",
        providerCause("system/task_started", message.task_id),
        itemSchema.parse({
          audience: message.skip_transcript === true ? "operators" : "participants",
          category: "agent",
          createdAt: now,
          id,
          input: message.prompt,
          kind: "tool",
          name,
          origin: "provider",
          provenance: provenance("system/task_started", { taskId: message.task_id }),
          runId,
          status: "active",
          ...(message.description.trim().length === 0 ? {} : { title: message.description }),
          updatedAt: now,
        }),
      );
      return;
    }

    if (message.subtype === "task_progress") {
      const id = this.#id(runId, "task", message.task_id);
      const item = this.#projection.item(runId, id);
      if (item?.kind === "tool" && item.status === "active") {
        await this.#projection.replacePreview({
          channel: "tool.progress",
          itemId: id,
          runId,
          text: message.summary ?? message.description,
        });
      }
      return;
    }

    if (message.subtype === "task_updated") {
      const id = this.#id(runId, "task", message.task_id);
      const item = this.#projection.item(runId, id);
      const status = message.patch.status;
      if (item?.kind === "tool" && item.status === "active" && status !== undefined) {
        await this.#projection.replacePreview({
          channel: "tool.progress",
          itemId: id,
          runId,
          text: nonEmpty(message.patch.description, `Agent task ${status}`),
        });
      }
      return;
    }

    if (message.subtype === "task_notification") {
      const id = this.#id(runId, "task", message.task_id);
      const item = this.#projection.item(runId, id);
      if (item?.kind === "tool" && item.status === "active") {
        const now = this.#projection.now().toISOString();
        const failed = message.status === "failed";
        await this.#projection.putItem(
          runId,
          "system/task_notification",
          providerCause("system/task_notification", message.task_id),
          itemSchema.parse({
            ...item,
            endedAt: now,
            ...(failed
              ? {
                  error: {
                    code: "anthropic.task_failed",
                    message: nonEmpty(message.summary, "Agent task failed."),
                    retryable: false,
                  },
                }
              : {}),
            output: toContentBlocks(message.summary),
            status: failed ? "failed" : message.status === "stopped" ? "cancelled" : "completed",
            structuredOutput: asJsonValue(message.usage),
            updatedAt: now,
          }),
        );
      }
    }
  }

  async #onResult(message: Extract<SDKMessage, { type: "result" }>, runId: string): Promise<void> {
    const event = `result/${message.subtype}`;
    const cause = providerCause(event, message.uuid);
    const usage = toUsage(message);
    if (usage !== undefined) {
      await this.#projection.updateUsage(runId, event, cause, usage);
    }

    if (message.subtype === "success") {
      if (message.result.length > 0 && !this.#hasMessageText(runId, message.result)) {
        const now = this.#projection.now().toISOString();
        await this.#projection.putItem(
          runId,
          `${event}/final`,
          cause,
          itemSchema.parse({
            audience: "participants",
            content: [{ text: message.result, type: "text" }],
            createdAt: now,
            endedAt: now,
            id: this.#id(runId, "result", `${message.uuid}:final`),
            kind: "message",
            phase: "final",
            provenance: provenance(event, { messageId: message.uuid }),
            role: "agent",
            runId,
            status: "completed",
            updatedAt: now,
          }),
        );
      }

      if (message.structured_output !== undefined) {
        const now = this.#projection.now().toISOString();
        const structured = asJsonValue(message.structured_output);
        if (structured !== undefined) {
          await this.#projection.putItem(
            runId,
            `${event}/structured_output`,
            cause,
            itemSchema.parse({
              audience: "participants",
              content: [{ type: "json", value: structured }],
              createdAt: now,
              endedAt: now,
              id: this.#id(runId, "structured", message.uuid),
              kind: "artifact",
              name: "structured-output.json",
              provenance: provenance(event, { messageId: message.uuid }),
              runId,
              status: "completed",
              updatedAt: now,
            }),
          );
        }
      }

      await this.#projection.finishRun({
        activeItemStatus: "cancelled",
        cause,
        event,
        finishReason: finishReason(message),
        runId,
        status: "completed",
      });
      this.#releaseRun(runId);
      return;
    }

    const cancelled =
      message.terminal_reason === "aborted_streaming" ||
      message.terminal_reason === "aborted_tools";

    if (isLimit(message)) {
      await this.#projection.finishRun({
        activeItemStatus: "cancelled",
        cause,
        event,
        finishReason: "limit",
        runId,
        status: "completed",
      });
      this.#releaseRun(runId);
      return;
    }

    const error = {
      code: `anthropic.${message.subtype}`,
      ...(message.terminal_reason === undefined
        ? {}
        : {
            details: {
              terminalReason: message.terminal_reason,
            },
          }),
      message: message.errors.join("\n") || "Agent SDK run failed.",
      retryable: isRetryable(message),
    } satisfies ProtocolError;
    await this.#projection.finishRun({
      cause,
      ...(cancelled ? {} : { error }),
      event,
      runId,
      status: cancelled ? "cancelled" : "failed",
    });
    this.#releaseRun(runId);
  }

  async #ensureMessage(
    runId: string,
    messageId: string,
    event: string,
    nativeMessageId: string,
  ): Promise<void> {
    if (this.#projection.item(runId, messageId) !== undefined) {
      return;
    }

    const now = this.#projection.now().toISOString();
    await this.#projection.putItem(
      runId,
      event,
      providerCause(event, nativeMessageId),
      itemSchema.parse({
        audience: "participants",
        content: [],
        createdAt: now,
        id: messageId,
        kind: "message",
        phase: "final",
        provenance: provenance(event, { messageId: nativeMessageId }),
        role: "agent",
        runId,
        status: "active",
        updatedAt: now,
      }),
    );
  }

  async #ensureReasoning(
    runId: string,
    messageId: string,
    event: string,
    nativeMessageId: string,
  ): Promise<string> {
    const id = this.#reasoningId(runId, messageId);

    if (this.#projection.item(runId, id) === undefined) {
      const now = this.#projection.now().toISOString();
      await this.#projection.putItem(
        runId,
        event,
        providerCause(event, nativeMessageId),
        itemSchema.parse({
          audience: "participants",
          content: [],
          createdAt: now,
          id,
          kind: "reasoning",
          provenance: provenance(event, { messageId: nativeMessageId }),
          runId,
          status: "active",
          updatedAt: now,
        }),
      );
    }

    return id;
  }

  async #appendText(
    runId: string,
    itemId: string,
    channel: "message.text" | "reasoning.text",
    delta: string,
    event: string,
  ): Promise<void> {
    await this.#projection.appendText({
      cause: providerCause(event, itemId),
      channel,
      delta,
      event,
      itemId,
      runId,
    });
  }

  async #putToolUse(
    runId: string,
    parentMessageId: string,
    block: JsonObject,
    event: string,
    occurredAt: string,
  ): Promise<string> {
    const nativeId = readString(block, "id") ?? this.#createId();
    const id = this.#id(runId, "tool", nativeId);
    const existing = this.#projection.item(runId, id);
    const inputKey = `${runId}:${id}`;
    const authoritative = event === "assistant/message";

    if (existing !== undefined && existing.status !== "active") {
      return id;
    }

    if (!authoritative && this.#authoritativeToolInputs.has(inputKey)) {
      return id;
    }

    if (authoritative) {
      this.#dropToolInput(inputKey);
      for (const [key, toolId] of this.#blockToolIds) {
        if (toolId === id) {
          this.#blockToolIds.delete(key);
        }
      }
    }

    const name = nonEmpty(readString(block, "name"), "Tool");
    const type = readString(block, "type");
    const server = readString(block, "server_name");
    const input = this.#toolInput(block["input"]);
    await this.#projection.putItem(
      runId,
      event,
      providerCause(event, nativeId),
      itemSchema.parse({
        audience: "participants",
        category: toolCategory(name),
        createdAt: existing?.createdAt ?? occurredAt,
        id,
        input,
        kind: "tool",
        name,
        origin: type === "mcp_tool_use" || name.startsWith("mcp__") ? "mcp" : "provider",
        provenance: provenance(event, { messageId: parentMessageId, toolUseId: nativeId }),
        runId,
        ...(server === null || server.trim().length === 0 ? {} : { server }),
        status: "active",
        title: name,
        updatedAt: occurredAt,
      }),
    );
    if (authoritative) {
      this.#authoritativeToolInputs.add(inputKey);
    }
    return id;
  }

  async #completeTool(
    runId: string,
    nativeToolId: string,
    block: JsonObject,
    structuredOutput: unknown,
    event: string,
    occurredAt: string,
  ): Promise<void> {
    const id = this.#id(runId, "tool", nativeToolId);
    const existing = this.#projection.item(runId, id);

    if (existing !== undefined && (existing.kind !== "tool" || existing.status !== "active")) {
      return;
    }

    const failed = block["is_error"] === true;
    const output = toContentBlocks(block["content"]);
    const structured = asJsonValue(structuredOutput);
    const errorText = output
      .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
      .join("\n");
    await this.#projection.putItem(
      runId,
      event,
      providerCause(event, nativeToolId),
      itemSchema.parse({
        audience: "participants",
        category: existing?.kind === "tool" ? existing.category : "other",
        createdAt: existing?.createdAt ?? occurredAt,
        endedAt: occurredAt,
        ...(failed
          ? {
              error: {
                code: "anthropic.tool_failed",
                message: errorText || "Tool failed.",
                retryable: false,
              },
            }
          : {}),
        id,
        input: existing?.kind === "tool" ? existing.input : undefined,
        kind: "tool",
        name: existing?.kind === "tool" ? existing.name : "Tool",
        origin: existing?.kind === "tool" ? existing.origin : "provider",
        output,
        provenance: provenance(event, { toolUseId: nativeToolId }),
        runId,
        status: failed ? "failed" : "completed",
        ...(structured === undefined ? {} : { structuredOutput: structured }),
        title: existing?.kind === "tool" ? existing.title : undefined,
        updatedAt: occurredAt,
      }),
    );
  }

  #hasMessageText(runId: string, text: string): boolean {
    return this.#projection
      .items(runId)
      .some(
        (item) =>
          item.kind === "message" &&
          item.status === "completed" &&
          item.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") ===
            text,
      );
  }

  #reasoningId(runId: string, messageId: string): string {
    return this.#id(runId, "reasoning", `${messageId}:reasoning`);
  }

  #id(runId: string, kind: string, nativeId: string): string {
    const candidate = nativeId.length > 0 ? `${kind}:${nativeId}` : "";

    if (candidate.length > 0 && candidate.length <= 256) {
      return candidate;
    }

    let ids = this.#ids.get(runId);

    if (ids === undefined) {
      ids = new Map();
      this.#ids.set(runId, ids);
    }

    const key = `${kind}:${nativeId}`;
    let id = ids.get(key);

    if (id === undefined) {
      id = this.#createId();
      ids.set(key, id);
    }

    return id;
  }

  #isToolUse(block: JsonObject): boolean {
    return ["mcp_tool_use", "server_tool_use", "tool_use"].includes(
      readString(block, "type") ?? "",
    );
  }

  #assertNativeSession(message: SDKMessage): void {
    const sessionId = isRecord(message) ? readString(message, "session_id") : null;

    if (sessionId === null) {
      return;
    }

    if (sessionId.trim().length === 0) {
      throw new Error("Claude Agent SDK message has an empty native session ID.");
    }

    if (this.#nativeSessionId === null) {
      this.#nativeSessionId = sessionId;
      return;
    }

    if (sessionId !== this.#nativeSessionId) {
      throw new Error("Claude Agent SDK message belongs to a different native session.");
    }
  }

  #abortedInteraction(interaction: PermissionInteraction): PermissionInteraction {
    return permissionInteractionSchema.parse({
      ...interaction,
      endedAt: this.#projection.now().toISOString(),
      resolution: { type: "cancelled" },
      status: "resolved",
    });
  }

  async #putAbortedInteraction(
    interaction: PermissionInteraction,
    requestId: string,
  ): Promise<void> {
    await this.#retryUnknown(() =>
      this.#projection.putInteraction(
        interaction.runId,
        "permission/aborted",
        providerCause("permission/aborted", requestId),
        interaction,
      ),
    );
    this.#projection.releaseInteraction(interaction.id);
  }

  #abortPermission(interactionId: string): Promise<void> {
    const pending = this.#pendingPermissions.get(interactionId);

    if (pending === undefined) {
      return Promise.resolve();
    }

    if (pending.abortTask !== null) {
      return pending.abortTask.catch(() => this.#abortPermission(interactionId));
    }

    if (this.#projection.run(pending.runId)?.status !== "active") {
      this.#dropPermission(interactionId);
      return Promise.resolve();
    }

    pending.aborted ??= this.#abortedInteraction(pending.interaction);
    const task = this.#putAbortedInteraction(pending.aborted, pending.requestId)
      .then(() => this.#dropPermission(interactionId))
      .finally(() => {
        if (pending.abortTask === task) {
          pending.abortTask = null;
        }
      });
    pending.abortTask = task;
    return task;
  }

  #toolInput(value: unknown) {
    const input = asJsonValue(value);

    if (
      input !== undefined &&
      this.#textEncoder.encode(JSON.stringify(input)).byteLength > this.#maxToolInputBytes
    ) {
      throw new RangeError("Claude tool input exceeds its byte limit.");
    }

    return input;
  }

  async #retryUnknown<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof AuthorityOutcomeUnknownError)) {
        throw error;
      }

      return operation();
    }
  }

  #trackSignal(cancellation: PermissionCancellation, signal: AbortSignal): void {
    if (cancellation.signals.has(signal)) {
      return;
    }

    const onAbort = () => cancellation.onAbort();
    cancellation.signals.set(signal, onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  }

  #abortedSignal(cancellation: PermissionCancellation): AbortSignal | null {
    for (const signal of cancellation.signals.keys()) {
      if (signal.aborted) {
        return signal;
      }
    }

    return null;
  }

  #throwIfAborted(cancellation: PermissionCancellation): void {
    this.#abortedSignal(cancellation)?.throwIfAborted();
  }

  #clearSignals(cancellation: PermissionCancellation): void {
    cancellation.onAbort = () => {};
    for (const [signal, onAbort] of cancellation.signals) {
      signal.removeEventListener("abort", onAbort);
    }
    cancellation.signals.clear();
  }

  #dropOpening(requestId: string, opening: OpeningPermission): void {
    if (this.#openingPermissions.get(requestId) !== opening) {
      return;
    }

    this.#openingPermissions.delete(requestId);
    this.#pendingPermissionBytes -= opening.bytes;
    this.#clearSignals(opening.cancellation);
  }

  #releaseRun(runId: string): void {
    this.#finishingRuns.delete(runId);
    this.#ids.delete(runId);

    for (const key of this.#authoritativeToolInputs) {
      if (key.startsWith(`${runId}:`)) {
        this.#authoritativeToolInputs.delete(key);
      }
    }

    for (const [requestId, opening] of this.#openingPermissions) {
      if (opening.runId === runId) {
        this.#dropOpening(requestId, opening);
      }
    }

    for (const key of this.#blockToolIds.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.#blockToolIds.delete(key);
      }
    }

    for (const key of this.#toolInputFragments.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.#dropToolInput(key);
      }
    }

    for (const [id, pending] of this.#pendingPermissions) {
      if (pending.runId === runId) {
        this.#dropPermission(id);
      }
    }
  }

  #dropPermission(interactionId: string): void {
    const pending = this.#pendingPermissions.get(interactionId);

    if (pending !== undefined) {
      this.#pendingPermissionBytes -= pending.bytes;
      this.#pendingPermissions.delete(interactionId);
      this.#clearSignals(pending.cancellation);
    }
  }

  #dropToolInput(key: string): void {
    const buffer = this.#toolInputFragments.get(key);

    if (buffer !== undefined) {
      this.#toolInputBytes -= buffer.bytes;
      this.#toolInputFragments.delete(key);
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("Claude Contract adapter is disposed.");
    }
  }
}
