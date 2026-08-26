import { PermissionEventDeliveryError } from "../../core/driver-permission-broker";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import {
  isRecord,
  readRecord,
  readString,
  stringifyForDisplay,
  toGrantedPermissionProfile,
} from "./app-server-json";
import type { JsonObject } from "./app-server-json";
import type {
  CurrentTimeReadResponse,
  PermissionsRequestApprovalResponse,
  RequestId,
  ServerRequestMethod,
} from "./app-server-protocol";

interface OpenAiAppServerRequestHandlerOptions {
  readonly context: AgentDriverContext;
  readonly handleError: (error: Error, method: ServerRequestMethod) => Promise<void>;
  readonly isStopped: () => boolean;
  readonly mapToolCallId: (toolCallId: string) => string;
  readonly respond: (id: RequestId, result: unknown) => void;
  readonly respondError: (id: RequestId, message: string) => void;
}

interface PendingServerRequest {
  readonly controller: AbortController;
  task: Promise<void>;
}

function toApprovalDecision(
  decision: "allow_once" | "reject_once",
  method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval",
  params: JsonObject,
): "accept" | "cancel" | "decline" {
  const explicit = params["availableDecisions"];

  if (
    method === "item/commandExecution/requestApproval" &&
    explicit !== undefined &&
    explicit !== null &&
    !Array.isArray(explicit)
  ) {
    throw new TypeError("OpenAi approval availableDecisions must be an array or null.");
  }

  const available = new Set(
    (method === "item/commandExecution/requestApproval" && Array.isArray(explicit)
      ? explicit
      : method === "item/fileChange/requestApproval"
        ? ["accept", "decline", "cancel"]
        : ["accept", "cancel"]
    ).filter(
      (value): value is "accept" | "cancel" | "decline" =>
        value === "accept" || value === "cancel" || value === "decline",
    ),
  );
  const desired = decision === "allow_once" ? "accept" : "decline";

  if (available.has(desired)) {
    return desired;
  }

  if (available.has("cancel")) {
    return "cancel";
  }

  if (available.has("decline")) {
    return "decline";
  }

  throw new Error(`OpenAi approval decision ${desired} was not offered by app-server.`);
}

function toPermissionProfileGrant(params: JsonObject): PermissionsRequestApprovalResponse {
  const permissions = readRecord(params, "permissions");

  return {
    permissions: toGrantedPermissionProfile(permissions),
    scope: "turn",
  };
}

function assertHandledServerRequest(method: never): never {
  throw new Error(`Unhandled OpenAi app-server request: ${String(method)}.`);
}

export class OpenAiAppServerRequestHandler {
  readonly #context: AgentDriverContext;
  readonly #handleError: OpenAiAppServerRequestHandlerOptions["handleError"];
  readonly #isStopped: () => boolean;
  readonly #mapToolCallId: OpenAiAppServerRequestHandlerOptions["mapToolCallId"];
  readonly #pending = new Map<RequestId, PendingServerRequest>();
  readonly #respond: OpenAiAppServerRequestHandlerOptions["respond"];
  readonly #respondError: OpenAiAppServerRequestHandlerOptions["respondError"];

  constructor(options: OpenAiAppServerRequestHandlerOptions) {
    this.#context = options.context;
    this.#handleError = options.handleError;
    this.#isStopped = options.isStopped;
    this.#mapToolCallId = options.mapToolCallId;
    this.#respond = options.respond;
    this.#respondError = options.respondError;
  }

  isPending(id: RequestId): boolean {
    return this.#pending.has(id);
  }

  dispatch(method: ServerRequestMethod, id: RequestId, params: unknown): void {
    if (this.#pending.has(id)) {
      throw new Error(`OpenAi app-server request ${String(id)} is already pending.`);
    }

    const pending: PendingServerRequest = {
      controller: new AbortController(),
      task: Promise.resolve(),
    };
    this.#pending.set(id, pending);
    pending.task = this.#handle(method, id, params, pending.controller.signal).catch(
      async (error: unknown) => {
        if (pending.controller.signal.aborted && !(error instanceof PermissionEventDeliveryError)) {
          return;
        }

        const failure =
          error instanceof Error ? error : new Error("OpenAi app-server request failed.");
        this.#context.logger.error("driver.openai.server_request.failed", failure, { method });
        await this.#handleError(failure, method);
        this.#replyError(id, failure.message);
        throw failure;
      },
    );
    void pending.task.catch(() => {});
  }

  async resolveElsewhere(id: RequestId): Promise<void> {
    const pending = this.#pending.get(id);

    if (pending === undefined) {
      return;
    }

    this.#pending.delete(id);
    pending.controller.abort(new Error("OpenAi app-server request was resolved elsewhere."));
    await pending.task;
  }

  async abortAll(reason: Error): Promise<void> {
    const pending = [...this.#pending.values()];
    this.#pending.clear();

    for (const request of pending) {
      request.controller.abort(reason);
    }

    const results = await Promise.allSettled(pending.map((request) => request.task));
    const failure = results.find((result) => result.status === "rejected");

    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }

  async #handle(
    method: ServerRequestMethod,
    id: RequestId,
    params: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    const payload = isRecord(params) ? params : {};
    const requestId = `${method}:${String(id)}`;

    switch (method) {
      case "currentTime/read": {
        const response: CurrentTimeReadResponse = {
          currentTimeAt: Math.floor(Date.now() / 1_000),
        };
        this.#reply(id, response);
        return;
      }
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": {
        const decision = await this.#context.ports.permission.request(
          {
            rawInput: stringifyForDisplay(payload),
            requestId,
            title:
              method === "item/fileChange/requestApproval"
                ? "Approve file changes"
                : readString(payload, "kind") === "writeStdin"
                  ? "Approve terminal input"
                  : "Approve command execution",
            toolCallId: this.#publicToolCallId(payload),
            toolKind: method,
          },
          signal,
        );
        const response = {
          decision: toApprovalDecision(decision, method, payload),
        };
        this.#reply(id, response);
        return;
      }
      case "item/permissions/requestApproval": {
        const decision = await this.#context.ports.permission.request(
          {
            rawInput: stringifyForDisplay(payload),
            requestId,
            title: "Approve runtime permissions",
            toolCallId: this.#publicToolCallId(payload),
            toolKind: method,
          },
          signal,
        );
        this.#reply(
          id,
          decision === "allow_once"
            ? toPermissionProfileGrant(payload)
            : { permissions: {}, scope: "turn" },
        );
        return;
      }
      case "applyPatchApproval":
      case "account/chatgptAuthTokens/refresh":
      case "attestation/generate":
      case "execCommandApproval":
      case "item/tool/call":
      case "item/tool/requestUserInput":
      case "mcpServer/elicitation/request":
        this.#replyError(id, `Unsupported OpenAi app-server request: ${method}.`);
        return;
      default:
        assertHandledServerRequest(method);
    }
  }

  #reply(id: RequestId, result: unknown): void {
    if (this.#pending.delete(id) && !this.#isStopped()) {
      this.#respond(id, result);
    }
  }

  #publicToolCallId(payload: JsonObject): string | null {
    const toolCallId = readString(payload, "itemId");
    return toolCallId === null ? null : this.#mapToolCallId(toolCallId);
  }

  #replyError(id: RequestId, message: string): void {
    if (this.#pending.delete(id) && !this.#isStopped()) {
      this.#respondError(id, message);
    }
  }
}
