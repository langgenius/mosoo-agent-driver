import { isDeepStrictEqual } from "node:util";

import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import {
  AuthorityOutcomeUnknownError,
  itemSchema,
  permissionInteractionSchema,
} from "../../contract";
import type {
  InteractionResolution,
  PermissionInteraction,
  PermissionOption,
} from "../../contract";
import { createProviderMeta, ContractProjection, nonEmpty } from "../contract-projection";
import { isRecord } from "./agent-sdk-json";
import type { JsonObject } from "./agent-sdk-json";
import { toolCategory } from "./contract-items";
import type { ClaudeContractTranscript } from "./contract-transcript";

const { cause: providerCause, provenance } = createProviderMeta("anthropic");

export type ClaudePermissionOptions = Parameters<CanUseTool>[2];
type PermissionOptions = ClaudePermissionOptions;

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
  readonly sessionSuggestions: ClaudePermissionOptions["suggestions"];
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

function permissionOptions(options: ClaudePermissionOptions): PermissionOption[] {
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

export interface ClaudeContractPermissionsOptions {
  readonly createId: () => string;
  readonly interactionTimeoutMs: number;
  readonly isRunFinishing: (runId: string) => boolean;
  readonly maxPendingPermissionBytes: number;
  readonly projection: ContractProjection;
  readonly transcript: ClaudeContractTranscript;
}

export class ClaudeContractPermissions {
  readonly #createId: () => string;
  #disposed = false;
  readonly #interactionTimeoutMs: number;
  readonly #isRunFinishing: (runId: string) => boolean;
  readonly #maxPendingPermissionBytes: number;
  readonly #openingPermissions = new Map<string, OpeningPermission>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  #pendingPermissionBytes = 0;
  readonly #projection: ContractProjection;
  readonly #textEncoder = new TextEncoder();
  readonly #transcript: ClaudeContractTranscript;

  constructor(options: ClaudeContractPermissionsOptions) {
    this.#createId = options.createId;
    this.#interactionTimeoutMs = options.interactionTimeoutMs;
    this.#isRunFinishing = options.isRunFinishing;
    this.#maxPendingPermissionBytes = options.maxPendingPermissionBytes;
    this.#projection = options.projection;
    this.#transcript = options.transcript;
  }

  async openPermission(
    runId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: PermissionOptions,
  ): Promise<string> {
    this.#assertActive();
    if (this.#isRunFinishing(runId)) {
      throw new Error("Claude permission request outlived its active Run.");
    }
    const projectedInput = this.#transcript.toolInput(input);

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
    const itemId = this.#transcript.id(runId, "tool", options.toolUseID);
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
      this.#transcript.markAuthoritativeToolInput(runId, itemId);
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
    if (this.#isRunFinishing(runId) || this.#projection.run(runId)?.status !== "active") {
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

  #dropPermission(interactionId: string): void {
    const pending = this.#pendingPermissions.get(interactionId);

    if (pending !== undefined) {
      this.#pendingPermissionBytes -= pending.bytes;
      this.#pendingPermissions.delete(interactionId);
      this.#clearSignals(pending.cancellation);
    }
  }

  releaseRun(runId: string): void {
    for (const [requestId, opening] of this.#openingPermissions) {
      if (opening.runId === runId) {
        this.#dropOpening(requestId, opening);
      }
    }
    for (const [id, pending] of this.#pendingPermissions) {
      if (pending.runId === runId) {
        this.#dropPermission(id);
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const [requestId, opening] of this.#openingPermissions) {
      this.#dropOpening(requestId, opening);
    }
    for (const id of this.#pendingPermissions.keys()) {
      this.#dropPermission(id);
    }
    this.#pendingPermissionBytes = 0;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("Claude Contract permissions are disposed.");
    }
  }
}
