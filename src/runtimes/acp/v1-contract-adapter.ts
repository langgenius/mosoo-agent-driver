import { isDeepStrictEqual } from "node:util";

import type {
  CreateTerminalRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";

import type { InteractionResolution, Run } from "../../contract";
import { createDriverId } from "../../protocol/id";
import {
  createProviderMeta,
  ContractProjection,
  type ContractProjectionOptions,
} from "../contract-projection";
import { AcpContractSessionUpdateInbox } from "./contract-session-update-inbox";
import { AcpContractItemProjector } from "./contract-item-projector";
import { AcpContractPermissionController } from "./contract-permission-controller";
import { AcpContractTerminalProjector } from "./contract-terminal-projector";
import { toUsage } from "./contract-mapping";

export { toConfigOptions } from "./contract-mapping";

const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_PENDING_PERMISSION_BYTES = 8 * 1_024 * 1_024;
const PROVIDER = "agent-client-protocol";
const { cause: providerCause } = createProviderMeta(PROVIDER);

export interface AcpV1ContractAdapterOptions extends ContractProjectionOptions {
  readonly createId?: (() => string) | undefined;
  readonly interactionTimeoutMs?: number | undefined;
  readonly maxPendingPermissionBytes?: number | undefined;
  readonly nativeSessionId: string;
}

export class AcpV1ContractAdapter {
  readonly #createId: () => string;
  #disposed = false;
  readonly #ids = new Map<string, Map<string, string>>();
  readonly #inbox: AcpContractSessionUpdateInbox;
  readonly #items: AcpContractItemProjector;
  readonly #nativeSessionId: string;
  readonly #permissions: AcpContractPermissionController;
  readonly #projection: ContractProjection;
  #receivedAt: string | null = null;
  readonly #terminals: AcpContractTerminalProjector;

  constructor(options: AcpV1ContractAdapterOptions) {
    this.#createId = options.createId ?? createDriverId;
    const interactionTimeoutMs = options.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
    const maxPendingPermissionBytes =
      options.maxPendingPermissionBytes ?? DEFAULT_MAX_PENDING_PERMISSION_BYTES;
    this.#nativeSessionId = options.nativeSessionId;
    this.#projection = new ContractProjection(options);
    this.#inbox = new AcpContractSessionUpdateInbox({
      apply: (runId, notification, receivedAt) =>
        this.#withReceipt(receivedAt, () => this.#applySessionUpdate(runId, notification)),
      now: () => this.#projection.now(),
    });
    this.#terminals = new AcpContractTerminalProjector({
      assertNativeSession: (sessionId) => this.#assertSession(sessionId),
      inbox: this.#inbox,
      now: () => this.#timestamp(),
      projection: this.#projection,
      resolveId: (runId, kind, nativeId) => this.#id(runId, kind, nativeId),
      withReceiptTime: (receivedAt, operation) => this.#withReceipt(receivedAt, operation),
    });
    this.#items = new AcpContractItemProjector({
      now: () => this.#timestamp(),
      projection: this.#projection,
      resolveId: (runId, kind, nativeId) => this.#id(runId, kind, nativeId),
      terminals: this.#terminals,
    });
    this.#permissions = new AcpContractPermissionController({
      assertNativeSession: (sessionId) => this.#assertSession(sessionId),
      createId: this.#createId,
      inbox: this.#inbox,
      interactionTimeoutMs,
      items: this.#items,
      maxPendingPermissionBytes,
      now: () => this.#timestamp(),
      projection: this.#projection,
      resolveId: (runId, kind, nativeId) => this.#id(runId, kind, nativeId),
      withReceiptTime: (receivedAt, operation) => this.#withReceipt(receivedAt, operation),
    });

    if (this.#nativeSessionId.trim().length === 0) {
      throw new Error("ACP v1 adapter requires a native session ID.");
    }

    if (
      [interactionTimeoutMs, maxPendingPermissionBytes].some(
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
    return this.#inbox.handle(runId, notification);
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
        await this.#items.putMessageChunk(runId, update, "message");
        return null;
      case "agent_thought_chunk":
        await this.#items.putMessageChunk(runId, update, "reasoning");
        return null;
      case "user_message_chunk":
        return null;
      case "tool_call":
      case "tool_call_update":
        await this.#items.putTool(runId, update, `session/${update.sessionUpdate}`);
        return null;
      case "plan":
        await this.#items.putPlan(runId, "current", update.entries, "session/plan");
        return null;
      default:
        return null;
    }
  }

  async completePrompt(runId: string, response: PromptResponse): Promise<void> {
    this.#assertActive();
    return this.#inbox.enqueue(() => this.#completePrompt(runId, response));
  }

  async #completePrompt(runId: string, response: PromptResponse): Promise<void> {
    this.#inbox.throwIfFailed();

    if (this.#projection.run(runId)?.status !== "active") {
      return;
    }

    await this.#terminals.flushTerminalExits(runId);

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

  openPermission(runId: string, request: RequestPermissionRequest): Promise<string> {
    this.#assertActive();
    return this.#permissions.openPermission(runId, request);
  }

  resolveInteraction(
    interactionId: string,
    resolution: InteractionResolution,
  ): Promise<RequestPermissionResponse | null> {
    this.#assertActive();
    return this.#permissions.resolveInteraction(interactionId, resolution);
  }

  registerTerminal(
    runId: string,
    terminalId: string,
    request?: CreateTerminalRequest,
  ): Promise<string> {
    this.#assertActive();
    return this.#terminals.registerTerminal(runId, terminalId, request);
  }

  handleTerminalOutput(
    runId: string,
    terminalId: string,
    response: TerminalOutputResponse,
  ): Promise<void> {
    this.#assertActive();
    return this.#terminals.handleTerminalOutput(runId, terminalId, response);
  }

  handleTerminalExit(
    runId: string,
    terminalId: string,
    response: WaitForTerminalExitResponse,
  ): Promise<void> {
    this.#assertActive();
    return this.#terminals.handleTerminalExit(runId, terminalId, response);
  }

  dispose(): void {
    this.#disposed = true;
    this.#ids.clear();
    this.#permissions.dispose();
    this.#inbox.close();
    this.#terminals.dispose();
    this.#projection.dispose();
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
    this.#permissions.releaseRun(runId);
    this.#terminals.releaseRun(runId);
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

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("ACP v1 adapter is disposed.");
    }
  }
}
