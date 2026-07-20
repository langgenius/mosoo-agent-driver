import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { InteractionResolution, Run } from "../../contract";
import { createDriverId } from "../../protocol/id";
import { ContractProjection, type ContractProjectionOptions } from "../contract-projection";
import { isRecord, readString } from "./agent-sdk-json";
import { ClaudeContractPermissions, type ClaudePermissionOptions } from "./contract-permissions";
import { ClaudeContractTranscript } from "./contract-transcript";

const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_PENDING_PERMISSION_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAX_TOOL_INPUT_BYTES = 1_024 * 1_024;

export interface ClaudeContractAdapterOptions extends ContractProjectionOptions {
  readonly createId?: (() => string) | undefined;
  readonly interactionTimeoutMs?: number | undefined;
  readonly maxPendingPermissionBytes?: number | undefined;
  readonly maxToolInputBytes?: number | undefined;
  readonly nativeSessionId?: string | undefined;
}

export class ClaudeContractAdapter {
  #disposed = false;
  readonly #finishingRuns = new Set<string>();
  #nativeSessionId: string | null;
  readonly #permissions: ClaudeContractPermissions;
  readonly #projection: ContractProjection;
  readonly #transcript: ClaudeContractTranscript;

  constructor(options: ClaudeContractAdapterOptions) {
    const createId = options.createId ?? createDriverId;
    const interactionTimeoutMs = options.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
    const maxPendingPermissionBytes =
      options.maxPendingPermissionBytes ?? DEFAULT_MAX_PENDING_PERMISSION_BYTES;
    const maxToolInputBytes = options.maxToolInputBytes ?? DEFAULT_MAX_TOOL_INPUT_BYTES;
    this.#nativeSessionId = options.nativeSessionId ?? null;
    this.#projection = new ContractProjection(options);
    this.#transcript = new ClaudeContractTranscript({
      createId,
      maxToolInputBytes,
      onRunReleased: (runId) => this.#releaseRun(runId),
      projection: this.#projection,
    });
    this.#permissions = new ClaudeContractPermissions({
      createId,
      interactionTimeoutMs,
      isRunFinishing: (runId) => this.#finishingRuns.has(runId),
      maxPendingPermissionBytes,
      projection: this.#projection,
      transcript: this.#transcript,
    });

    if (
      [interactionTimeoutMs, maxPendingPermissionBytes, maxToolInputBytes].some(
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

    if (message.type !== "result") {
      return this.#transcript.handleMessage(message, runId);
    }

    this.#finishingRuns.add(runId);
    try {
      return await this.#transcript.handleMessage(message, runId);
    } catch (error) {
      if (this.#projection.run(runId)?.status === "active") {
        this.#finishingRuns.delete(runId);
      }
      throw error;
    }
  }

  async openPermission(
    runId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: ClaudePermissionOptions,
  ): Promise<string> {
    this.#assertActive();
    return this.#permissions.openPermission(runId, toolName, input, options);
  }

  async resolveInteraction(
    interactionId: string,
    resolution: InteractionResolution,
  ): Promise<PermissionResult | null> {
    this.#assertActive();
    return this.#permissions.resolveInteraction(interactionId, resolution);
  }

  dispose(): void {
    this.#disposed = true;
    this.#finishingRuns.clear();
    this.#permissions.dispose();
    this.#transcript.dispose();
    this.#nativeSessionId = null;
    this.#projection.dispose();
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

  #releaseRun(runId: string): void {
    this.#finishingRuns.delete(runId);
    this.#transcript.releaseRun(runId);
    this.#permissions.releaseRun(runId);
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("Claude Contract adapter is disposed.");
    }
  }
}
