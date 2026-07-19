import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  JsonRpcId,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import type { DriverEventInput } from "../../protocol/events";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { shouldIgnoreReplay } from "./acp-event-translator";
import type { AcpPermissionOption, AcpTurnEventState } from "./acp-event-translator";
import { AcpFileSystem } from "./acp-file-system";
import { AcpPathScope } from "./acp-path-scope";
import { AcpSessionUpdateInbox, type AcpSessionUpdateScope } from "./acp-session-update-inbox";
import { AcpTerminalManager } from "./acp-terminal-manager";
import { isRecord, raceWithAbort, readNonEmptyString, stringifyForDisplay } from "./acp-types";

interface AcpClientRequestHandlerOptions {
  readonly allowedRoots: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  isCancelling(): boolean;
  nativeSessionId(): string | null;
  onUpdateFailure(error: Error): void;
  push(context: AgentDriverContext, reason: string, events: DriverEventInput[]): Promise<void>;
  readonly turnEvents: AcpTurnEventState;
}

export class AcpClientRequestHandler {
  readonly #fileSystem: AcpFileSystem;
  readonly #isCancelling: () => boolean;
  readonly #nativeSessionId: () => string | null;
  readonly #push: AcpClientRequestHandlerOptions["push"];
  #stopping = false;
  readonly #updateInbox: AcpSessionUpdateInbox;
  readonly #terminalManager: AcpTerminalManager;
  readonly #turnEvents: AcpTurnEventState;

  constructor(options: AcpClientRequestHandlerOptions) {
    this.#isCancelling = options.isCancelling;
    this.#nativeSessionId = options.nativeSessionId;
    this.#push = options.push;
    this.#turnEvents = options.turnEvents;
    const pathScope = new AcpPathScope({
      allowedRoots: options.allowedRoots,
      cwd: options.cwd,
    });
    this.#fileSystem = new AcpFileSystem({
      allowedRoots: options.allowedRoots,
      cwd: options.cwd,
      pathScope,
    });
    this.#terminalManager = new AcpTerminalManager({
      allowedRoots: options.allowedRoots,
      cwd: options.cwd,
      env: options.env,
      pathScope,
      push: options.push,
    });
    this.#updateInbox = new AcpSessionUpdateInbox({
      apply: (context, notification, scope) => this.#applyUpdate(context, notification, scope),
      onFailure: options.onUpdateFailure,
    });
  }

  enqueueUpdate(context: AgentDriverContext, notification: SessionNotification): Promise<void> {
    return this.#updateInbox.enqueue(context, notification);
  }

  async readTextFile(
    params: ReadTextFileRequest,
    signal?: AbortSignal,
  ): Promise<ReadTextFileResponse> {
    this.#assertSession("fs/read_text_file", params);
    return this.#fileSystem.readTextFile(params, signal);
  }

  async writeTextFile(
    context: AgentDriverContext,
    params: WriteTextFileRequest,
    signal?: AbortSignal,
  ): Promise<WriteTextFileResponse> {
    this.#assertSession("fs/write_text_file", params);
    return this.#fileSystem.writeTextFile(context, params, signal);
  }

  async requestPermission(
    context: AgentDriverContext,
    requestId: JsonRpcId,
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    this.#assertSession("session/request_permission", params);

    if (this.#stopping || this.#isCancelling() || signal?.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }

    try {
      if (!this.#updateInbox.isSuppressed()) {
        await raceWithAbort(this.drainUpdates(), signal);
      }

      if (this.#stopping || this.#isCancelling() || signal?.aborted) {
        return { outcome: { outcome: "cancelled" } };
      }

      return await this.#requestPermission(context, this.#requestKey(requestId), params, signal);
    } catch (error) {
      if (signal?.aborted) {
        return { outcome: { outcome: "cancelled" } };
      }

      throw error;
    }
  }

  async createTerminal(
    context: AgentDriverContext,
    params: CreateTerminalRequest,
    signal?: AbortSignal,
  ): Promise<CreateTerminalResponse> {
    this.#assertSession("terminal/create", params);
    return this.#terminalManager.create(context, params, signal);
  }

  async killTerminal(
    context: AgentDriverContext,
    params: KillTerminalRequest,
    signal?: AbortSignal,
  ): Promise<KillTerminalResponse> {
    this.#assertSession("terminal/kill", params);
    return this.#terminalManager.kill(context, params, signal);
  }

  terminalOutput(params: TerminalOutputRequest, signal?: AbortSignal): TerminalOutputResponse {
    this.#assertSession("terminal/output", params);
    return this.#terminalManager.output(params, signal);
  }

  async releaseTerminal(
    context: AgentDriverContext,
    params: ReleaseTerminalRequest,
    signal?: AbortSignal,
  ): Promise<ReleaseTerminalResponse> {
    this.#assertSession("terminal/release", params);
    return this.#terminalManager.release(context, params, signal);
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
    signal?: AbortSignal,
  ): Promise<WaitForTerminalExitResponse> {
    this.#assertSession("terminal/wait_for_exit", params);
    return this.#terminalManager.waitForExit(params, signal);
  }

  async stopTerminals(context: AgentDriverContext): Promise<void> {
    this.#stopping = true;
    await this.#terminalManager.stopAll(context);
  }

  async closeUpdates(): Promise<void> {
    this.#stopping = true;
    await this.#updateInbox.close();
  }

  async drainUpdates(): Promise<void> {
    await this.#updateInbox.drain();
  }

  async withSessionReplay<T>(operation: () => Promise<T>): Promise<T> {
    return this.#updateInbox.withReplay(operation);
  }

  async suppressUpdates<T>(operation: () => Promise<T>): Promise<T> {
    return this.#updateInbox.suppress(operation);
  }

  async #requestPermission(
    context: AgentDriverContext,
    requestId: string,
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (this.#updateInbox.isSuppressed()) {
      return { outcome: { outcome: "cancelled" } };
    }

    const translation = this.#turnEvents.translatePermission({
      params,
      requestId,
    });
    const toolEvents = translation.events.filter((event) => event.kind !== "permission.requested");

    if (toolEvents.length > 0) {
      await raceWithAbort(this.#push(context, "driver.acp.permission.tool", toolEvents), signal);
    }

    const chosen =
      this.#isCancelling() || signal?.aborted
        ? null
        : await raceWithAbort(
            this.#resolvePermission(context, requestId, translation.options, params, signal),
            signal,
          );
    const resolvedOption = this.#isCancelling() || signal?.aborted ? null : chosen;

    if (resolvedOption === null) {
      return { outcome: { outcome: "cancelled" } };
    }

    return {
      outcome: {
        optionId: resolvedOption.optionId,
        outcome: "selected",
      },
    };
  }

  async #applyUpdate(
    context: AgentDriverContext,
    params: SessionNotification,
    scope: AcpSessionUpdateScope,
  ): Promise<void> {
    this.#assertSession("session/update", params);

    if (scope.suppressed && shouldIgnoreReplay(params)) {
      return;
    }

    if (
      (scope.replaying || this.#turnEvents.activeRunId() === null) &&
      shouldIgnoreReplay(params)
    ) {
      return;
    }

    const events = this.#turnEvents.translateUpdate(params);

    if (events.length === 0) {
      return;
    }

    await this.#push(context, "driver.acp.session.update", events);
  }

  #assertSession(method: string, params: unknown): void {
    const expectedSessionId = this.#requireSessionId();
    const record = isRecord(params) ? params : null;
    const actualSessionId = readNonEmptyString(record, "sessionId");

    if (actualSessionId === null) {
      throw new Error(`ACP ${method} requires sessionId.`);
    }

    if (actualSessionId !== expectedSessionId) {
      throw new Error(`ACP ${method} sessionId does not match the active session.`);
    }
  }

  async #resolvePermission(
    context: AgentDriverContext,
    requestId: string,
    options: readonly AcpPermissionOption[],
    params: unknown,
    signal?: AbortSignal,
  ): Promise<AcpPermissionOption | null> {
    const allow = options.find((option) => option.kind === "allow_once") ?? null;
    const reject = options.find((option) => option.kind === "reject_once") ?? null;

    if (allow === null && reject === null) {
      return null;
    }

    const record = isRecord(params) ? params : {};
    const toolCall = isRecord(record["toolCall"]) ? record["toolCall"] : {};
    const decision = await context.ports.permission.request(
      {
        rawInput: stringifyForDisplay(toolCall["rawInput"]),
        requestId,
        title:
          readNonEmptyString(toolCall, "title") ??
          readNonEmptyString(toolCall, "kind") ??
          "Allow tool call?",
        toolCallId: readNonEmptyString(toolCall, "toolCallId"),
        toolKind: readNonEmptyString(toolCall, "kind"),
      },
      signal,
    );

    return decision === "allow_once" ? allow : reject;
  }

  #requireSessionId(): string {
    const sessionId = this.#nativeSessionId();

    if (sessionId === null) {
      throw new Error("ACP driver backend session is not initialized.");
    }

    return sessionId;
  }

  #requestKey(requestId: JsonRpcId): string {
    return requestId === null ? "null" : `${typeof requestId}:${requestId}`;
  }
}
