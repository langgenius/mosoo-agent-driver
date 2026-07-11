import { isDeepStrictEqual } from "node:util";

import type {
  ContentBlock as AcpContentBlock,
  CreateTerminalRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  TerminalOutputResponse,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
  ToolKind,
  Usage,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";

import { configOptionSchema, interactionSchema, itemSchema, toolItemSchema } from "../../contract";
import type {
  ConfigOption,
  ContentBlock,
  FileChange,
  Interaction,
  InteractionResolution,
  Item,
  ItemStatus,
  ProtocolError,
  Run,
  TokenUsage,
  ToolItem,
} from "../../contract";
import { createDriverId } from "../../protocol/id";
import {
  asJsonValue,
  AuthorityOutcomeUnknownError,
  createProviderMeta,
  ContractProjection,
  nonEmpty,
  type ContractProjectionOptions,
} from "../contract-projection";

const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_PENDING_PERMISSION_BYTES = 8 * 1_024 * 1_024;
const MAX_PENDING_UPDATE_BYTES = 32 * 1_024 * 1_024;
const MAX_PENDING_UPDATES = 1_024;
const PROVIDER = "agent-client-protocol";
const SELECT_GROUPS_EXTENSION = "agentclientprotocol.v1/select-groups";
const TERMINAL_OUTPUT_EXTENSION = "agentclientprotocol.v1/terminal-output";
const { cause: providerCause, provenance } = createProviderMeta(PROVIDER);

interface PermissionIntent {
  readonly bytes: number;
  released: boolean;
  readonly receivedAt: string;
  readonly request: RequestPermissionRequest;
  readonly runId: string;
}

interface PendingPermission {
  readonly intent: PermissionIntent;
  readonly interaction: Interaction;
  opened: boolean;
  readonly optionIds: ReadonlyMap<string, string>;
  response?: RequestPermissionResponse;
  readonly toolCallId: string;
}

interface OpeningPermission {
  readonly intent: PermissionIntent;
  readonly promise: Promise<string>;
}

interface PendingTerminalExit {
  readonly endedAt: string;
  readonly exit: WaitForTerminalExitResponse;
}

interface UnknownSessionUpdate {
  readonly error: AuthorityOutcomeUnknownError;
  readonly notification: SessionNotification;
  readonly receivedAt: string;
  retry?: Promise<SessionUpdate | null>;
  readonly runId: string;
}

interface UnknownPermission {
  readonly error: AuthorityOutcomeUnknownError;
  readonly intent: PermissionIntent;
  retry?: Promise<string>;
}

interface TerminalIntent {
  readonly receivedAt: string;
  readonly request: CreateTerminalRequest | undefined;
  readonly runId: string;
  readonly terminalId: string;
}

interface UnknownTerminal {
  readonly error: AuthorityOutcomeUnknownError;
  readonly intent: TerminalIntent;
  retry?: Promise<string>;
}

export interface AcpV1ContractAdapterOptions extends ContractProjectionOptions {
  readonly createId?: (() => string) | undefined;
  readonly interactionTimeoutMs?: number | undefined;
  readonly maxPendingPermissionBytes?: number | undefined;
  readonly nativeSessionId: string;
}

function resourceName(uri: string): string {
  try {
    const path = new URL(uri).pathname;
    return decodeURIComponent(path.split("/").filter(Boolean).at(-1) ?? "resource").slice(0, 1_024);
  } catch {
    return "resource";
  }
}

function toContentBlocks(block: AcpContentBlock): ContentBlock[] {
  switch (block.type) {
    case "text":
      return [{ text: block.text, type: "text" }];
    case "image":
    case "audio":
      return [{ data: block.data, mediaType: block.mimeType, type: "inline_blob" }];
    case "resource_link": {
      if (URL.canParse(block.uri)) {
        return [
          {
            ...(block.mimeType === undefined || block.mimeType === null
              ? {}
              : { mediaType: block.mimeType }),
            name: nonEmpty(block.name, resourceName(block.uri)),
            type: "resource_link",
            uri: block.uri,
          },
        ];
      }

      const value = asJsonValue(block);
      return value === undefined ? [] : [{ type: "json", value }];
    }
    case "resource": {
      const resource = block.resource;

      if ("text" in resource) {
        const content: ContentBlock[] = [{ text: resource.text, type: "text" }];

        if (URL.canParse(resource.uri)) {
          content.unshift({
            ...(resource.mimeType === undefined || resource.mimeType === null
              ? {}
              : { mediaType: resource.mimeType }),
            name: resourceName(resource.uri),
            type: "resource_link",
            uri: resource.uri,
          });
        }

        return content;
      }

      return [
        {
          data: resource.blob,
          mediaType: resource.mimeType ?? "application/octet-stream",
          name: resourceName(resource.uri),
          type: "inline_blob",
        },
      ];
    }
  }
}

function toolCategory(kind: ToolKind | null | undefined): ToolItem["category"] {
  switch (kind) {
    case "read":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "search":
      return "search";
    case "execute":
      return "execute";
    case "fetch":
      return "fetch";
    default:
      return "other";
  }
}

function itemStatus(status: ToolCall["status"] | null | undefined): ItemStatus {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : "active";
}

function toolError(title: string): ProtocolError {
  return {
    code: "agent_client_protocol.tool_failed",
    message: `${title} failed.`,
    retryable: false,
  };
}

function toOutput(content: readonly ToolCallContent[]): ContentBlock[] {
  return content.flatMap((entry) =>
    entry.type === "content" ? toContentBlocks(entry.content) : [],
  );
}

function toChanges(content: readonly ToolCallContent[]): FileChange[] {
  return content.flatMap<FileChange>((entry) => {
    if (entry.type !== "diff" || entry.path.trim().length === 0) {
      return [];
    }

    return [
      {
        diff: {
          type: "json",
          value: {
            newText: entry.newText,
            oldText: entry.oldText ?? null,
          },
        },
        operation: entry.oldText === undefined || entry.oldText === null ? "create" : "update",
        path: entry.path,
      },
    ];
  });
}

function toUsage(usage: Usage, previous: TokenUsage | undefined): TokenUsage {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const cachedInput = usage.cachedReadTokens;
  const reasoning = usage.thoughtTokens;
  const total = usage.totalTokens;

  return {
    ...previous,
    ...(cachedInput !== undefined &&
    cachedInput !== null &&
    Number.isSafeInteger(cachedInput) &&
    cachedInput >= (previous?.cachedInput ?? 0)
      ? { cachedInput }
      : {}),
    ...(Number.isSafeInteger(input) && input >= (previous?.input ?? 0) ? { input } : {}),
    ...(Number.isSafeInteger(output) && output >= (previous?.output ?? 0) ? { output } : {}),
    ...(reasoning !== undefined &&
    reasoning !== null &&
    Number.isSafeInteger(reasoning) &&
    reasoning >= (previous?.reasoning ?? 0)
      ? { reasoning }
      : {}),
    ...(Number.isSafeInteger(total) && total >= (previous?.total ?? 0) ? { total } : {}),
  };
}

function configDescription(value: string | null | undefined) {
  return value === undefined || value === null ? {} : { description: value };
}

export function toConfigOptions(options: readonly SessionConfigOption[]): ConfigOption[] {
  return options.map((option) => {
    const base = {
      ...(option.category === undefined || option.category === null || option.category.length === 0
        ? {}
        : { category: option.category }),
      ...configDescription(option.description),
      id: option.id,
      label: nonEmpty(option.name, option.id),
    };

    if (option.type === "boolean") {
      return configOptionSchema.parse({ ...base, type: "boolean", value: option.currentValue });
    }

    const groups = option.options.flatMap((entry) => ("group" in entry ? [entry] : []));
    const choices = option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));

    return configOptionSchema.parse({
      ...base,
      choices: choices.map((choice) => ({
        ...configDescription(choice.description),
        id: choice.value,
        label: nonEmpty(choice.name, choice.value),
      })),
      ...(groups.length === 0
        ? {}
        : {
            extensions: {
              [SELECT_GROUPS_EXTENSION]: groups.map((group) => ({
                id: group.group,
                label: group.name,
                optionIds: group.options.map((choice) => choice.value),
              })),
            },
          }),
      type: "select",
      value: option.currentValue,
    });
  });
}

export class AcpV1ContractAdapter {
  readonly #createId: () => string;
  #disposed = false;
  readonly #ids = new Map<string, Map<string, string>>();
  readonly #interactionTimeoutMs: number;
  readonly #maxPendingPermissionBytes: number;
  readonly #nativeSessionId: string;
  #pendingUpdateBytes = 0;
  #pendingUpdates = 0;
  readonly #openingPermissions = new Map<string, OpeningPermission>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #pendingTerminalExits = new Map<string, PendingTerminalExit>();
  #mutationTail: Promise<void> = Promise.resolve();
  readonly #projection: ContractProjection;
  #receivedAt: string | null = null;
  readonly #truncatedTerminals = new Set<string>();
  readonly #textEncoder = new TextEncoder();
  #pendingPermissionBytes = 0;
  #unknownPermission: UnknownPermission | undefined;
  #unknownSessionUpdate: UnknownSessionUpdate | undefined;
  #unknownTerminal: UnknownTerminal | undefined;
  #updateFailure: Error | null = null;

  constructor(options: AcpV1ContractAdapterOptions) {
    this.#createId = options.createId ?? createDriverId;
    this.#interactionTimeoutMs = options.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
    this.#maxPendingPermissionBytes =
      options.maxPendingPermissionBytes ?? DEFAULT_MAX_PENDING_PERMISSION_BYTES;
    this.#nativeSessionId = options.nativeSessionId;
    this.#projection = new ContractProjection(options);

    if (this.#nativeSessionId.trim().length === 0) {
      throw new Error("ACP v1 adapter requires a native session ID.");
    }

    if (
      [this.#interactionTimeoutMs, this.#maxPendingPermissionBytes].some(
        (value) => !Number.isSafeInteger(value) || value < 1,
      )
    ) {
      throw new RangeError("ACP v1 adapter limits must be finite and positive.");
    }
  }

  attachRun(run: Run): void {
    this.#assertActive();
    this.#projection.attachRun(run);
  }

  async handleSessionUpdate(
    runId: string,
    notification: SessionNotification,
  ): Promise<SessionUpdate | null> {
    this.#assertActive();
    if (this.#updateFailure !== null) {
      throw this.#updateFailure;
    }

    const snapshot = structuredClone(notification);
    const unknownAtAdmission = this.#unknownSessionUpdate;
    const exactRetry =
      unknownAtAdmission !== undefined &&
      unknownAtAdmission.runId === runId &&
      isDeepStrictEqual(unknownAtAdmission.notification, snapshot)
        ? unknownAtAdmission
        : undefined;

    if (exactRetry?.retry !== undefined) {
      return exactRetry.retry;
    }

    const bytes = this.#textEncoder.encode(JSON.stringify(snapshot)).byteLength;

    if (
      this.#pendingUpdates >= MAX_PENDING_UPDATES ||
      bytes > MAX_PENDING_UPDATE_BYTES - this.#pendingUpdateBytes
    ) {
      throw (this.#updateFailure = new Error("ACP v1 session update queue limit exceeded."));
    }

    const receivedAt = this.#projection.now().toISOString();
    this.#pendingUpdateBytes += bytes;
    this.#pendingUpdates += 1;
    const update = this.#enqueueMutation(async () => {
      if (this.#updateFailure !== null) {
        throw this.#updateFailure;
      }

      const unknown = this.#unknownSessionUpdate;
      const retrying =
        unknown !== undefined &&
        unknownAtAdmission === unknown &&
        unknown.runId === runId &&
        isDeepStrictEqual(unknown.notification, snapshot);

      try {
        if (unknown !== undefined && unknownAtAdmission !== unknown) {
          throw unknown.error;
        }

        const result = await this.#withReceipt(
          retrying ? unknown.receivedAt : receivedAt,
          () => this.#applySessionUpdate(runId, snapshot),
        );

        if (retrying) {
          this.#unknownSessionUpdate = undefined;
        }

        return result;
      } catch (cause) {
        if (cause instanceof AuthorityOutcomeUnknownError) {
          this.#unknownSessionUpdate ??= {
            error: cause,
            notification: snapshot,
            receivedAt,
            runId,
          };
          throw cause;
        }

        if (retrying) {
          this.#unknownSessionUpdate = undefined;
        }

        this.#updateFailure ??=
          cause instanceof Error ? cause : new Error("ACP v1 session update failed.", { cause });
        throw this.#updateFailure;
      }
    }).finally(() => {
      this.#pendingUpdateBytes -= bytes;
      this.#pendingUpdates -= 1;
    });

    if (exactRetry !== undefined) {
      const retry = update.finally(() => {
        if (exactRetry.retry === retry) {
          delete exactRetry.retry;
        }
      });
      exactRetry.retry = retry;
      return retry;
    }

    return update;
  }

  async #applySessionUpdate(
    runId: string,
    notification: SessionNotification,
  ): Promise<SessionUpdate | null> {
    this.#assertSession(notification.sessionId);

    const update = notification.update;

    switch (update.sessionUpdate) {
      case "available_commands_update":
      case "config_option_update":
      case "current_mode_update":
      case "session_info_update":
      case "usage_update":
        return update;
    }

    if (this.#projection.run(runId)?.status !== "active") {
      return null;
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        await this.#putMessageChunk(runId, update, "message");
        return null;
      case "agent_thought_chunk":
        await this.#putMessageChunk(runId, update, "reasoning");
        return null;
      case "user_message_chunk":
        return null;
      case "tool_call":
      case "tool_call_update":
        await this.#putTool(runId, update, `session/${update.sessionUpdate}`);
        return null;
      case "plan":
        await this.#putPlan(runId, "current", update.entries, "session/plan");
        return null;
      default:
        return null;
    }
  }

  async completePrompt(runId: string, response: PromptResponse): Promise<void> {
    this.#assertActive();
    return this.#enqueueMutation(() => this.#completePrompt(runId, response));
  }

  async #completePrompt(runId: string, response: PromptResponse): Promise<void> {
    if (this.#updateFailure !== null) {
      throw this.#updateFailure;
    }

    if (this.#projection.run(runId)?.status !== "active") {
      return;
    }

    await this.#flushTerminalExits(runId);

    const event = `prompt/${response.stopReason}`;
    const cause = providerCause(event, runId);

    if (response.usage !== undefined && response.usage !== null) {
      const current = this.#projection.run(runId)?.usage;
      const usage = toUsage(response.usage, current);

      if (Object.keys(usage).length > 0 && !isDeepStrictEqual(usage, current)) {
        await this.#projection.updateUsage(runId, event, cause, usage);
      }
    }

    if (response.stopReason === "cancelled") {
      await this.#projection.finishRun({ cause, event, runId, status: "cancelled" });
    } else {
      await this.#projection.finishRun({
        cause,
        event,
        finishReason:
          response.stopReason === "refusal"
            ? "refusal"
            : response.stopReason === "max_tokens" || response.stopReason === "max_turn_requests"
              ? "limit"
              : "success",
        runId,
        status: "completed",
      });
    }

    this.#releaseRun(runId);
  }

  async openPermission(runId: string, request: RequestPermissionRequest): Promise<string> {
    this.#assertActive();
    const snapshot = structuredClone(request);
    const unknownAtAdmission = this.#unknownPermission;
    const exactRetry =
      unknownAtAdmission !== undefined &&
      unknownAtAdmission.intent.runId === runId &&
      isDeepStrictEqual(unknownAtAdmission.intent.request, snapshot)
        ? unknownAtAdmission
        : undefined;

    if (unknownAtAdmission !== undefined && exactRetry === undefined) {
      throw unknownAtAdmission.error;
    }

    if (exactRetry?.retry !== undefined) {
      return exactRetry.retry;
    }

    const toolCallId = snapshot.toolCall.toolCallId;
    const openingAtAdmission = this.#openingPermissions.get(toolCallId);

    if (openingAtAdmission !== undefined) {
      if (
        openingAtAdmission.intent.runId !== runId ||
        !isDeepStrictEqual(openingAtAdmission.intent.request, snapshot)
      ) {
        throw new Error(`ACP v1 permission request ${toolCallId} changed identity or content.`);
      }

      return openingAtAdmission.promise;
    }

    const existing = [...this.#pendingPermissions].find(
      ([, candidate]) => candidate.toolCallId === toolCallId,
    );

    if (existing !== undefined) {
      const [interactionId, pending] = existing;

      if (
        pending.intent.runId !== runId ||
        !isDeepStrictEqual(pending.intent.request, snapshot)
      ) {
        throw new Error(`ACP v1 permission request ${toolCallId} changed identity or content.`);
      }

      if (pending.opened) {
        return interactionId;
      }
    }

    let intent = exactRetry?.intent;

    if (intent === undefined) {
      const bytes = this.#textEncoder.encode(JSON.stringify(snapshot)).byteLength;

      if (bytes > this.#maxPendingPermissionBytes - this.#pendingPermissionBytes) {
        throw new RangeError("ACP v1 pending permission budget is exhausted.");
      }

      this.#pendingPermissionBytes += bytes;
      intent = {
        bytes,
        receivedAt: this.#projection.now().toISOString(),
        released: false,
        request: snapshot,
        runId,
      };
    }

    const stableIntent = intent;
    const opening = this.#enqueueMutation(async () => {
      try {
        const unknown = this.#unknownPermission;

        if (unknown !== undefined && unknown !== unknownAtAdmission) {
          throw unknown.error;
        }

        const interactionId = await this.#withReceipt(stableIntent.receivedAt, () =>
          this.#openPermission(stableIntent),
        );

        if (this.#unknownPermission === unknownAtAdmission) {
          this.#unknownPermission = undefined;
        }

        return interactionId;
      } catch (error) {
        if (error instanceof AuthorityOutcomeUnknownError) {
          this.#unknownPermission ??= { error, intent: stableIntent };
        } else if (this.#unknownPermission?.intent === stableIntent) {
          this.#unknownPermission = undefined;
        }

        throw error;
      } finally {
        if (!this.#permissionRetained(stableIntent)) {
          this.#releasePermissionIntent(stableIntent);
        }
      }
    });

    const tracked = opening.finally(() => {
      if (this.#openingPermissions.get(toolCallId)?.promise === tracked) {
        this.#openingPermissions.delete(toolCallId);
      }

      if (exactRetry !== undefined && exactRetry.retry === tracked) {
        delete exactRetry.retry;
      }
    });
    this.#openingPermissions.set(toolCallId, { intent: stableIntent, promise: tracked });
    if (exactRetry !== undefined) {
      exactRetry.retry = tracked;
    }

    return tracked;
  }

  async #openPermission(intent: PermissionIntent): Promise<string> {
    const { request, runId } = intent;
    let pending: PendingPermission | undefined;

    try {
      this.#assertActive();
      this.#assertSession(request.sessionId);

      const existing = [...this.#pendingPermissions].find(
        ([, candidate]) => candidate.toolCallId === request.toolCall.toolCallId,
      );

      if (existing !== undefined) {
        const [interactionId, existingPermission] = existing;

        if (
          existingPermission.intent.runId !== runId ||
          !isDeepStrictEqual(existingPermission.intent.request, request)
        ) {
          throw new Error(
            `ACP v1 permission request ${request.toolCall.toolCallId} changed identity or content.`,
          );
        }

        if (!existingPermission.opened) {
          try {
            await this.#projection.putInteraction(
              runId,
              "permission/requested",
              providerCause("permission/requested", existingPermission.toolCallId),
              existingPermission.interaction,
            );
            existingPermission.opened = true;
          } catch (error) {
            if (!(error instanceof AuthorityOutcomeUnknownError)) {
              this.#dropPermission(interactionId);
            }

            throw error;
          }
        }

        if (existingPermission.response !== undefined) {
          this.#projection.releaseInteraction(interactionId);
          this.#dropPermission(interactionId);
        }

        return interactionId;
      }

      if (request.options.length === 0) {
        throw new Error("ACP v1 permission request must advertise at least one option.");
      }

      const item = await this.#putTool(runId, request.toolCall, "permission/requested.tool");
      const createdAt = this.#timestamp();
      const optionIds = new Map<string, string>();
      const options = request.options.map((option) => {
        const id = this.#id(runId, "permission-option", option.optionId);
        optionIds.set(id, option.optionId);
        return {
          effect: option.kind.startsWith("allow") ? "allow" : "deny",
          id,
          label: nonEmpty(option.name, option.optionId),
          scope: option.kind.endsWith("always") ? "session" : "once",
        };
      });
      const interaction = interactionSchema.parse({
        audience: "participants",
        blocking: true,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + this.#interactionTimeoutMs).toISOString(),
        id: this.#createId(),
        itemId: item.id,
        kind: "permission",
        provenance: provenance("permission/requested", { toolCallId: request.toolCall.toolCallId }),
        request: {
          options,
          subject: { itemId: item.id, type: "item" },
          title: nonEmpty(request.toolCall.title, `Allow ${item.name}?`),
        },
        runId,
        status: "open",
      });
      pending = {
        intent,
        interaction,
        opened: false,
        optionIds,
        toolCallId: request.toolCall.toolCallId,
      };
      this.#pendingPermissions.set(interaction.id, pending);
      await this.#projection.putInteraction(
        runId,
        "permission/requested",
        providerCause("permission/requested", request.toolCall.toolCallId),
        interaction,
      );
      pending.opened = true;
      return interaction.id;
    } catch (error) {
      if (pending !== undefined && !(error instanceof AuthorityOutcomeUnknownError)) {
        this.#dropPermission(pending.interaction.id);
      }
      throw error;
    }
  }

  async resolveInteraction(
    interactionId: string,
    resolution: InteractionResolution,
  ): Promise<RequestPermissionResponse | null> {
    this.#assertActive();
    return this.#enqueueMutation(() => this.#resolveInteraction(interactionId, resolution));
  }

  async #resolveInteraction(
    interactionId: string,
    resolution: InteractionResolution,
  ): Promise<RequestPermissionResponse | null> {
    const pending = this.#pendingPermissions.get(interactionId);

    if (pending === undefined) {
      return null;
    }

    if (resolution.kind !== "permission") {
      throw new Error("ACP v1 permission interaction requires a permission resolution.");
    }

    if (pending.response !== undefined) {
      return pending.response;
    }

    const selected = resolution.value.type === "selected" ? resolution.value.optionId : null;
    const nativeOptionId = selected === null ? undefined : pending.optionIds.get(selected);

    if (selected !== null && nativeOptionId === undefined) {
      throw new Error("ACP v1 permission resolution selected an unavailable option.");
    }

    const response: RequestPermissionResponse = nativeOptionId === undefined
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { optionId: nativeOptionId, outcome: "selected" } };

    this.#projection.releaseInteraction(interactionId);
    if (this.#unknownPermission?.intent === pending.intent) {
      pending.response = response;
    } else {
      this.#dropPermission(interactionId);
    }

    return response;
  }

  async registerTerminal(
    runId: string,
    terminalId: string,
    request?: CreateTerminalRequest,
  ): Promise<string> {
    this.#assertActive();

    const snapshot = request === undefined ? undefined : structuredClone(request);

    if (snapshot !== undefined) {
      this.#assertSession(snapshot.sessionId);
    }

    const unknownAtAdmission = this.#unknownTerminal;
    const exactRetry =
      unknownAtAdmission !== undefined &&
      unknownAtAdmission.intent.runId === runId &&
      unknownAtAdmission.intent.terminalId === terminalId &&
      isDeepStrictEqual(unknownAtAdmission.intent.request, snapshot)
        ? unknownAtAdmission
        : undefined;

    if (unknownAtAdmission !== undefined && exactRetry === undefined) {
      throw unknownAtAdmission.error;
    }

    if (exactRetry?.retry !== undefined) {
      return exactRetry.retry;
    }

    const intent =
      exactRetry?.intent ??
      ({
        receivedAt: this.#projection.now().toISOString(),
        request: snapshot,
        runId,
        terminalId,
      } satisfies TerminalIntent);
    const registration = this.#enqueueMutation(async () => {
      try {
        const unknown = this.#unknownTerminal;

        if (unknown !== undefined && unknown !== unknownAtAdmission) {
          throw unknown.error;
        }

        const id = await this.#withReceipt(intent.receivedAt, () =>
          this.#ensureTerminal(intent.runId, intent.terminalId, intent.request),
        );

        if (this.#unknownTerminal === unknownAtAdmission) {
          this.#unknownTerminal = undefined;
        }

        return id;
      } catch (error) {
        if (error instanceof AuthorityOutcomeUnknownError) {
          this.#unknownTerminal ??= { error, intent };
        } else if (this.#unknownTerminal?.intent === intent) {
          this.#unknownTerminal = undefined;
        }

        throw error;
      }
    });

    if (exactRetry !== undefined) {
      const retry = registration.finally(() => {
        if (exactRetry.retry === retry) {
          delete exactRetry.retry;
        }
      });
      exactRetry.retry = retry;
      return retry;
    }

    return registration;
  }

  async handleTerminalOutput(
    runId: string,
    terminalId: string,
    response: TerminalOutputResponse,
  ): Promise<void> {
    this.#assertActive();
    return this.#enqueueMutation(() => this.#handleTerminalOutput(runId, terminalId, response));
  }

  async #handleTerminalOutput(
    runId: string,
    terminalId: string,
    response: TerminalOutputResponse,
  ): Promise<void> {
    if (this.#projection.run(runId)?.status !== "active") {
      return;
    }

    const id = await this.#ensureTerminal(runId, terminalId);
    const item = this.#projection.item(runId, id);

    if (item?.kind !== "terminal" || item.status !== "active") {
      return;
    }

    const truncationKey = `${runId}\0${terminalId}`;

    if (response.truncated) {
      this.#truncatedTerminals.add(truncationKey);
    }

    const pendingExit = this.#pendingTerminalExits.get(truncationKey);
    const exit = response.exitStatus ?? pendingExit?.exit;

    if (exit === undefined || exit === null) {
      await this.#projection.replacePreview({
        channel: "terminal.stdout",
        itemId: id,
        runId,
        text: response.output,
      });
      return;
    }

    if (pendingExit !== undefined && !isDeepStrictEqual(pendingExit.exit, exit)) {
      throw new Error(`ACP v1 terminal ${terminalId} changed its exit status.`);
    }

    const terminalExit = pendingExit ?? { endedAt: this.#timestamp(), exit };
    this.#pendingTerminalExits.set(truncationKey, terminalExit);

    await this.#finishTerminal(
      runId,
      item,
      response.output,
      terminalExit,
      this.#truncatedTerminals.has(truncationKey),
    );
    this.#pendingTerminalExits.delete(truncationKey);
    this.#truncatedTerminals.delete(truncationKey);
  }

  async handleTerminalExit(
    runId: string,
    terminalId: string,
    response: WaitForTerminalExitResponse,
  ): Promise<void> {
    this.#assertActive();
    return this.#enqueueMutation(() => this.#handleTerminalExit(runId, terminalId, response));
  }

  async #handleTerminalExit(
    runId: string,
    terminalId: string,
    response: WaitForTerminalExitResponse,
  ): Promise<void> {
    if (this.#projection.run(runId)?.status !== "active") {
      return;
    }

    const id = await this.#ensureTerminal(runId, terminalId);
    const truncationKey = `${runId}\0${terminalId}`;
    const item = this.#projection.item(runId, id);

    if (item?.kind === "terminal" && item.status === "active") {
      const pending = this.#pendingTerminalExits.get(truncationKey);

      if (pending !== undefined && !isDeepStrictEqual(pending.exit, response)) {
        throw new Error(`ACP v1 terminal ${terminalId} changed its exit status.`);
      }

      this.#pendingTerminalExits.set(truncationKey, {
        endedAt: pending?.endedAt ?? this.#timestamp(),
        exit: response,
      });
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#ids.clear();
    this.#openingPermissions.clear();
    for (const id of this.#pendingPermissions.keys()) {
      this.#dropPermission(id);
    }
    if (this.#unknownPermission !== undefined) {
      this.#releasePermissionIntent(this.#unknownPermission.intent);
    }
    this.#pendingTerminalExits.clear();
    this.#unknownPermission = undefined;
    this.#unknownSessionUpdate = undefined;
    this.#unknownTerminal = undefined;
    this.#truncatedTerminals.clear();
    this.#projection.dispose();
  }

  async #putMessageChunk(
    runId: string,
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }
    >,
    kind: "message" | "reasoning",
  ): Promise<void> {
    const nativeId = update.messageId ?? `${runId}:anonymous:${kind}`;
    const id = this.#id(runId, kind, nativeId);
    const event = `session/${update.sessionUpdate}`;
    let item = this.#projection.item(runId, id);

    if (item === undefined) {
      const now = this.#timestamp();
      item = await this.#projection.putItem(
        runId,
        event,
        providerCause(event, nativeId),
        itemSchema.parse({
          audience: "participants",
          content: [],
          createdAt: now,
          id,
          kind,
          ...(kind === "message" ? { phase: "final", role: "agent" } : {}),
          provenance: provenance(
            event,
            update.messageId === null || update.messageId === undefined
              ? undefined
              : { messageId: update.messageId },
          ),
          runId,
          status: "active",
          updatedAt: now,
        }),
      );
    }

    if (item.status !== "active" || item.kind !== kind) {
      return;
    }

    const channel = kind === "message" ? "message.text" : "reasoning.text";

    if (update.content.type === "text") {
      await this.#projection.appendText({
        cause: providerCause(event, nativeId),
        channel,
        delta: update.content.text,
        event,
        itemId: id,
        runId,
      });
      return;
    }

    const checkpoint = await this.#projection.checkpointText({
      cause: providerCause(`${event}.checkpoint`, nativeId),
      channel,
      event: `${event}.checkpoint`,
      itemId: id,
      runId,
    });
    const current = checkpoint ?? item;

    if (current.kind !== "message" && current.kind !== "reasoning") {
      throw new Error("ACP v1 message chunk changed item kind while being projected.");
    }

    await this.#projection.putItem(
      runId,
      event,
      providerCause(event, nativeId),
      itemSchema.parse({
        ...current,
        content: [...current.content, ...toContentBlocks(update.content)],
        updatedAt: this.#timestamp(),
      }),
    );
  }

  async #putTool(
    runId: string,
    update: ToolCall | ToolCallUpdate,
    event: string,
  ): Promise<ToolItem> {
    const id = this.#id(runId, "tool", update.toolCallId);
    const existing = this.#projection.item(runId, id);

    if (existing !== undefined && existing.kind !== "tool") {
      throw new Error("ACP v1 tool update collided with a non-tool item.");
    }

    const existingTool = existing?.kind === "tool" ? existing : undefined;
    const now = this.#timestamp();
    const title = nonEmpty(update.title, existingTool?.title ?? existingTool?.name ?? "Tool");
    const nextStatus =
      update.status === undefined || update.status === null
        ? (existingTool?.status ?? "active")
        : itemStatus(update.status);
    const status =
      existingTool === undefined || existingTool.status === "active"
        ? nextStatus
        : existingTool.status;
    const content = update.content ?? undefined;
    const terminalIds =
      content?.flatMap((entry) => (entry.type === "terminal" ? [entry.terminalId] : [])) ?? [];
    const projectedTerminalIds: string[] = [];

    for (const terminalId of terminalIds) {
      projectedTerminalIds.push(await this.#ensureTerminal(runId, terminalId));
    }

    const terminalItemId =
      content === undefined ? existingTool?.terminalItemId : projectedTerminalIds[0];

    const input =
      update.rawInput === undefined || update.rawInput === null
        ? existingTool?.input
        : asJsonValue(update.rawInput);
    const structuredOutput =
      update.rawOutput === undefined || update.rawOutput === null
        ? existingTool?.structuredOutput
        : asJsonValue(update.rawOutput);
    const output = content === undefined ? existingTool?.output : toOutput(content);
    const locations =
      update.locations === undefined || update.locations === null
        ? existingTool?.locations
        : update.locations.flatMap((location) =>
            location.path.trim().length === 0
              ? []
              : [
                  {
                    ...(location.line === undefined ||
                    location.line === null ||
                    !Number.isSafeInteger(location.line) ||
                    location.line < 1
                      ? {}
                      : { line: location.line }),
                    path: location.path,
                  },
                ],
          );
    const item = toolItemSchema.parse({
      audience: "participants",
      category:
        update.kind === undefined || update.kind === null
          ? (existingTool?.category ?? "other")
          : toolCategory(update.kind),
      createdAt: existingTool?.createdAt ?? now,
      ...(status === "active" ? {} : { endedAt: existingTool?.endedAt ?? now }),
      ...(status === "failed" ? { error: existingTool?.error ?? toolError(title) } : {}),
      id,
      ...(input === undefined ? {} : { input }),
      kind: "tool",
      ...(locations === undefined ? {} : { locations }),
      name: existingTool?.name ?? title,
      origin: "provider",
      ...(output === undefined ? {} : { output }),
      provenance: provenance(event, { toolCallId: update.toolCallId }),
      runId,
      status,
      ...(structuredOutput === undefined ? {} : { structuredOutput }),
      ...(terminalItemId === undefined ? {} : { terminalItemId }),
      title,
      updatedAt: now,
    });
    const changed =
      existingTool === undefined ||
      !isDeepStrictEqual(
        { ...existingTool, provenance: item.provenance, updatedAt: item.updatedAt },
        item,
      );

    if (changed) {
      await this.#projection.putItem(runId, event, providerCause(event, update.toolCallId), item);
    }

    await this.#putChanges(
      runId,
      update.toolCallId,
      content === undefined ? undefined : toChanges(content),
      status,
      event,
      now,
    );

    if (changed && item.status === "active") {
      await this.#projection.replacePreview({
        channel: "tool.progress",
        itemId: item.id,
        runId,
        text: item.title ?? item.name,
      });
    }

    return changed ? item : existingTool;
  }

  async #putChanges(
    runId: string,
    toolCallId: string,
    changes: FileChange[] | undefined,
    status: ItemStatus,
    event: string,
    now: string,
  ): Promise<void> {
    const id = this.#id(runId, "change", toolCallId);
    const existing = this.#projection.item(runId, id);

    if (existing !== undefined && existing.kind !== "change") {
      return;
    }

    const nextStatus =
      existing === undefined || existing.status === "active" ? status : existing.status;

    if (
      (changes === undefined && (existing === undefined || existing.status === nextStatus)) ||
      (changes?.length === 0 && existing === undefined)
    ) {
      return;
    }

    const item = itemSchema.parse({
        audience: "participants",
        changes: changes ?? existing?.changes,
        createdAt: existing?.createdAt ?? now,
        ...(nextStatus === "active" ? {} : { endedAt: existing?.endedAt ?? now }),
        ...(nextStatus === "failed"
          ? { error: existing?.error ?? toolError("File change") }
          : {}),
        id,
        kind: "change",
        provenance: provenance(event, { toolCallId }),
        runId,
        status: nextStatus,
        updatedAt: now,
      });

    if (
      existing !== undefined &&
      isDeepStrictEqual(
        { ...existing, provenance: item.provenance, updatedAt: item.updatedAt },
        item,
      )
    ) {
      return;
    }

    await this.#projection.putItem(
      runId,
      `${event}.changes`,
      providerCause(`${event}.changes`, toolCallId),
      item,
    );
  }

  async #putPlan(
    runId: string,
    nativeId: string,
    entries: Extract<SessionUpdate, { sessionUpdate: "plan" }>["entries"],
    event: string,
  ): Promise<void> {
    const id = this.#id(runId, "plan", nativeId);
    const existing = this.#projection.item(runId, id);

    if (existing !== undefined && (existing.kind !== "plan" || existing.status !== "active")) {
      return;
    }

    const now = this.#timestamp();
    await this.#projection.putItem(
      runId,
      event,
      providerCause(event, nativeId),
      itemSchema.parse({
        audience: "participants",
        createdAt: existing?.createdAt ?? now,
        entries: entries.map((entry) => ({
          priority: entry.priority,
          status: entry.status,
          text: entry.content,
        })),
        id,
        kind: "plan",
        provenance: provenance(event, nativeId === "current" ? undefined : { planId: nativeId }),
        runId,
        status: "active",
        updatedAt: now,
      }),
    );
  }

  async #ensureTerminal(
    runId: string,
    terminalId: string,
    request?: CreateTerminalRequest,
  ): Promise<string> {
    const id = this.#id(runId, "terminal", terminalId);
    const existing = this.#projection.item(runId, id);

    if (existing !== undefined) {
      if (existing.kind !== "terminal") {
        throw new Error("ACP v1 terminal ID collided with a non-terminal item.");
      }

      return id;
    }

    const now = this.#timestamp();
    await this.#projection.putItem(
      runId,
      "terminal/created",
      providerCause("terminal/created", terminalId),
      itemSchema.parse({
        audience: "participants",
        ...(request === undefined
          ? {}
          : {
              command: [request.command, ...(request.args ?? [])].join(" "),
              ...(request.cwd === undefined || request.cwd === null ? {} : { cwd: request.cwd }),
            }),
        createdAt: now,
        id,
        kind: "terminal",
        provenance: provenance("terminal/created", { terminalId }),
        runId,
        status: "active",
        stderr: [],
        stdout: [],
        updatedAt: now,
      }),
    );
    return id;
  }

  async #finishTerminal(
    runId: string,
    item: Extract<Item, { kind: "terminal" }>,
    output: string,
    terminalExit: PendingTerminalExit,
    truncated: boolean,
  ): Promise<void> {
    const { endedAt: now, exit } = terminalExit;
    const failed =
      (exit.exitCode !== undefined && exit.exitCode !== null && exit.exitCode !== 0) ||
      (exit.signal !== undefined && exit.signal !== null);
    await this.#projection.putItem(
      runId,
      "terminal/exited",
      providerCause("terminal/exited", item.id),
      itemSchema.parse({
        ...item,
        endedAt: now,
        ...(failed
          ? {
              error: {
                code: "agent_client_protocol.terminal_failed",
                message: "Terminal command failed.",
                retryable: false,
              },
            }
          : {}),
        ...(truncated
          ? { extensions: { ...item.extensions, [TERMINAL_OUTPUT_EXTENSION]: { truncated } } }
          : {}),
        exitCode: exit.exitCode ?? null,
        signal: exit.signal ?? null,
        status: failed ? "failed" : "completed",
        stdout: output.length === 0 ? [] : [{ text: output, type: "text" }],
        updatedAt: now,
      }),
    );
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

  #assertSession(sessionId: string): void {
    if (sessionId !== this.#nativeSessionId) {
      throw new Error("ACP v1 message does not belong to the active native session.");
    }
  }

  #releaseRun(runId: string): void {
    this.#ids.delete(runId);

    for (const key of this.#truncatedTerminals) {
      if (key.startsWith(`${runId}\0`)) {
        this.#truncatedTerminals.delete(key);
      }
    }

    for (const key of this.#pendingTerminalExits.keys()) {
      if (key.startsWith(`${runId}\0`)) {
        this.#pendingTerminalExits.delete(key);
      }
    }

    for (const [id, pending] of this.#pendingPermissions) {
      if (pending.intent.runId === runId) {
        this.#dropPermission(id);
      }
    }
  }

  #dropPermission(interactionId: string): void {
    const pending = this.#pendingPermissions.get(interactionId);

    if (pending !== undefined) {
      this.#pendingPermissions.delete(interactionId);
      this.#releasePermissionIntent(pending.intent);
    }
  }

  #permissionRetained(intent: PermissionIntent): boolean {
    return (
      this.#unknownPermission?.intent === intent ||
      [...this.#pendingPermissions.values()].some((pending) => pending.intent === intent)
    );
  }

  #releasePermissionIntent(intent: PermissionIntent): void {
    if (!intent.released) {
      intent.released = true;
      this.#pendingPermissionBytes -= intent.bytes;
    }
  }

  async #flushTerminalExits(runId: string): Promise<void> {
    for (const [key, pending] of this.#pendingTerminalExits) {
      if (!key.startsWith(`${runId}\0`)) {
        continue;
      }

      const terminalId = key.slice(runId.length + 1);
      const id = this.#id(runId, "terminal", terminalId);
      const item = this.#projection.item(runId, id);

      if (item?.kind === "terminal" && item.status === "active") {
        await this.#finishTerminal(
          runId,
          item,
          this.#projection.materializedText(runId, id, "terminal.stdout"),
          pending,
          this.#truncatedTerminals.has(key),
        );
      }

      this.#pendingTerminalExits.delete(key);
      this.#truncatedTerminals.delete(key);
    }
  }

  #timestamp(): string {
    return this.#receivedAt ?? this.#projection.now().toISOString();
  }

  async #withReceipt<T>(receivedAt: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#receivedAt;
    this.#receivedAt = receivedAt;

    try {
      return await operation();
    } finally {
      this.#receivedAt = previous;
    }
  }

  #enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const mutation = this.#mutationTail.then(operation);
    this.#mutationTail = mutation.then(
      () => {},
      () => {},
    );
    return mutation;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("ACP v1 adapter is disposed.");
    }
  }
}
