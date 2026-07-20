import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { isRecord, readRecord, readString, stringifyForDisplay } from "./app-server-json";
import type { JsonObject } from "./app-server-json";
import type {
  CommandExecutionRequestApprovalResponse,
  CurrentTimeReadResponse,
  FileChangeRequestApprovalResponse,
  PermissionsRequestApprovalResponse,
  RequestId,
  ServerRequestMethod,
} from "./generated/app-server-protocol";

interface OpenAiAppServerRequestHandlerOptions {
  readonly context: AgentDriverContext;
  readonly handleError: (error: Error, method: ServerRequestMethod) => Promise<void>;
  readonly isStopped: () => boolean;
  readonly respond: (id: RequestId, result: unknown) => void;
  readonly respondError: (id: RequestId, message: string) => void;
}

function toApprovalDecision(
  decision: "allow_once" | "reject_once",
): CommandExecutionRequestApprovalResponse["decision"] {
  return decision === "allow_once" ? "accept" : "decline";
}

function toPermissionProfileGrant(params: JsonObject): PermissionsRequestApprovalResponse {
  const permissions = readRecord(params, "permissions");

  return {
    permissions: permissions === null ? {} : { ...permissions },
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
  readonly #pending = new Map<RequestId, AbortController>();
  readonly #respond: OpenAiAppServerRequestHandlerOptions["respond"];
  readonly #respondError: OpenAiAppServerRequestHandlerOptions["respondError"];

  constructor(options: OpenAiAppServerRequestHandlerOptions) {
    this.#context = options.context;
    this.#handleError = options.handleError;
    this.#isStopped = options.isStopped;
    this.#respond = options.respond;
    this.#respondError = options.respondError;
  }

  dispatch(method: ServerRequestMethod, id: RequestId, params: unknown): void {
    if (this.#pending.has(id)) {
      throw new Error(`OpenAi app-server request ${String(id)} is already pending.`);
    }

    const controller = new AbortController();
    this.#pending.set(id, controller);
    void this.#handle(method, id, params, controller.signal).catch(async (error: unknown) => {
      if (controller.signal.aborted) {
        return;
      }

      const failure =
        error instanceof Error ? error : new Error("OpenAi app-server request failed.");
      this.#context.logger.error("driver.openai.server_request.failed", failure, { method });
      await this.#handleError(failure, method);
      this.#replyError(id, failure.message);
    });
  }

  resolveElsewhere(id: RequestId): void {
    this.#pending.get(id)?.abort(new Error("OpenAi app-server request was resolved elsewhere."));
    this.#pending.delete(id);
  }

  abortAll(reason: Error): void {
    for (const request of this.#pending.values()) {
      request.abort(reason);
    }
    this.#pending.clear();
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
            rawInput: stringifyForDisplay(payload["command"] ?? payload["reason"] ?? payload),
            requestId,
            title:
              method === "item/fileChange/requestApproval"
                ? "Approve file changes"
                : "Approve command execution",
            toolCallId: readString(payload, "itemId"),
            toolKind: method,
          },
          signal,
        );
        const response:
          | CommandExecutionRequestApprovalResponse
          | FileChangeRequestApprovalResponse = {
          decision: toApprovalDecision(decision),
        };
        this.#reply(id, response);
        return;
      }
      case "item/permissions/requestApproval": {
        const decision = await this.#context.ports.permission.request(
          {
            rawInput: stringifyForDisplay(payload["permissions"] ?? payload),
            requestId,
            title: "Approve runtime permissions",
            toolCallId: readString(payload, "itemId"),
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
      case "account/chatgptAuthTokens/refresh":
      case "attestation/generate":
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

  #replyError(id: RequestId, message: string): void {
    if (this.#pending.delete(id) && !this.#isStopped()) {
      this.#respondError(id, message);
    }
  }
}
