import {
  Client,
  InsufficientScopeError,
  LATEST_PROTOCOL_VERSION,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { AuthProvider, CallToolResult } from "@modelcontextprotocol/client";

import { AGENT_DRIVER_VERSION } from "../../core/version";
import { AGENT_DRIVER_MCP_EXECUTE_TIMEOUT_MS } from "../../host-ports";
import type { AgentDriverMcpExecution } from "../../host-ports";
import type { Logger } from "../../observability";
import type { DriverStartInput } from "../../protocol/start";
import type { McpExecuteCommand, McpExternalToolExecutionResult } from "../../runtime-command";
import { settlePromiseWithTimeout } from "../../utils/async";

type SessionMcpServer = DriverStartInput["execution"]["session"]["mcpServers"][number];
type ActiveMcpServer = Extract<SessionMcpServer, { authorizationState: "active" }>;

const MCP_CONNECT_TIMEOUT_MS = 60_000;
const MCP_CLEANUP_TIMEOUT_MS = 2_000;
const MCP_RESPONSE_MAX_BYTES = 8 * 1_024 * 1_024;
const MOSOO_TOOL_CALL_ID_HEADER = "X-Mosoo-Tool-Call-Id";

class McpResponseTooLargeError extends RangeError {
  constructor() {
    super(`MCP response exceeds ${String(MCP_RESPONSE_MAX_BYTES)} bytes.`);
    this.name = "McpResponseTooLargeError";
  }
}

async function boundedMcpFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  const contentLength = response.headers.get("content-length");

  if (contentLength !== null && Number(contentLength) > MCP_RESPONSE_MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    const body =
      response.body === null
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new McpResponseTooLargeError());
            },
          });

    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  if (response.body === null) {
    return response;
  }

  let bytes = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (chunk.byteLength > MCP_RESPONSE_MAX_BYTES - bytes) {
          controller.error(new McpResponseTooLargeError());
          return;
        }

        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function parseToolArguments(command: McpExecuteCommand): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(command.argumentsJson);

    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("MCP tool arguments must be a JSON object.");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid MCP tool arguments for ${command.toolName}: ${
        error instanceof Error ? error.message : "Unknown JSON parsing error."
      }`,
      { cause: error },
    );
  }
}

function resolveActiveMcpServer(
  payload: DriverStartInput,
  command: McpExecuteCommand,
): ActiveMcpServer {
  const server = payload.execution.session.mcpServers.find(
    (candidate) => candidate.serverId === command.serverId,
  );

  if (!server) {
    throw new Error(`MCP server ${command.serverId} is not configured for this session.`);
  }

  switch (server.authorizationState) {
    case "active":
      return server;
    case "authorization_required":
      throw new Error(
        `MCP server ${server.name} requires authorization before tools can be executed.`,
      );
    case "expired":
      throw new Error(
        `MCP authorization for ${server.name} has expired and must be refreshed before use.`,
      );
    case "revoked":
      throw new Error(`MCP authorization for ${server.name} was revoked and must be reconnected.`);
    case "disabled":
      throw new Error(`MCP server ${server.name} is disabled for this session.`);
  }
}

function normalizeCallToolResult(
  result: CallToolResult,
  command: McpExecuteCommand,
): McpExternalToolExecutionResult {
  const content = result.content[0];
  const plainText =
    result.content.length === 1 &&
    content?.type === "text" &&
    Object.keys(content).every((key) => key === "type" || key === "text");
  const hasRichContent = !plainText || result.structuredContent !== undefined;

  const outputText = hasRichContent
    ? JSON.stringify(
        {
          content: result.content,
          ...(result.isError === undefined ? {} : { isError: result.isError }),
          ...(result.structuredContent === undefined
            ? {}
            : { structuredContent: result.structuredContent }),
        },
        null,
        2,
      )
    : content.text;

  return {
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    outputText,
    providerReceiptJson: result._meta === undefined ? null : JSON.stringify(result._meta),
    requestId: command.requestId,
    serverId: command.serverId,
    toolName: command.toolName,
  };
}

function mapMcpExecutionError(
  command: McpExecuteCommand,
  server: ActiveMcpServer,
  error: unknown,
): Error {
  if (error instanceof SdkHttpError) {
    switch (error.status) {
      case 400:
        return new Error(
          `MCP server ${server.name} rejected the request for ${command.toolName} (HTTP 400).`,
        );
      case 401:
        return new Error(
          `MCP authorization for ${server.name} is no longer valid. Refresh or reconnect the credential and retry.`,
        );
      case 403:
        return new Error(
          `MCP server ${server.name} rejected the credential for ${command.toolName}. Access may have been revoked.`,
        );
      case 404:
        return new Error(`MCP HTTP endpoint for ${server.name} was not found.`);
      case 405:
        return new Error(`MCP server ${server.name} does not support HTTP tool execution.`);
      case 408:
        return new Error(`Timed out while calling MCP tool ${command.toolName} on ${server.name}.`);
      case 409:
        return new Error(
          `MCP server ${server.name} reported a conflict while calling ${command.toolName}. Retry the request.`,
        );
      case 429:
        return new Error(
          `MCP server ${server.name} rate limited ${command.toolName}. Retry the request later.`,
        );
      default:
        return error.status >= 500
          ? new Error(
              `MCP server ${server.name} failed while calling ${command.toolName} (HTTP ${error.status}).`,
            )
          : new Error(
              `MCP server ${server.name} rejected ${command.toolName} with HTTP ${error.status}.`,
            );
    }
  }

  if (error instanceof UnauthorizedError) {
    return new Error(
      `MCP authorization for ${server.name} is no longer valid. Refresh or reconnect the credential and retry.`,
    );
  }

  if (error instanceof InsufficientScopeError) {
    return new Error(
      `MCP credential for ${server.name} lacks the access required for ${command.toolName}. Reauthorize the credential and retry.`,
    );
  }

  if (error instanceof SdkError) {
    switch (error.code) {
      case SdkErrorCode.RequestTimeout: {
        return new Error(`Timed out while calling MCP tool ${command.toolName} on ${server.name}.`);
      }
      case SdkErrorCode.ConnectionClosed:
      case SdkErrorCode.SendFailed:
      case SdkErrorCode.NotConnected: {
        return new Error(`Failed to reach MCP server ${server.name}: ${error.message}`);
      }
      case SdkErrorCode.CapabilityNotSupported: {
        return new Error(
          `MCP server ${server.name} does not support the requested capability for ${command.toolName}.`,
        );
      }
      case SdkErrorCode.AlreadyConnected:
      case SdkErrorCode.NotInitialized: {
        return new Error(`MCP client state error for ${server.name}: ${error.message}`);
      }
      default: {
        return new Error(`MCP client failure for ${server.name}: ${error.message}`);
      }
    }
  }

  if (error instanceof ProtocolError) {
    if (error.code === ProtocolErrorCode.MethodNotFound) {
      return new Error(`MCP tool ${command.toolName} is not available on ${server.name}.`);
    }

    if (error.code === ProtocolErrorCode.InvalidParams) {
      return new Error(
        `MCP server ${server.name} rejected the arguments for ${command.toolName}: ${error.message}`,
      );
    }

    return new Error(`MCP protocol error on ${server.name}: ${error.message}`);
  }

  if (error instanceof Error) {
    return new Error(
      `Failed to execute MCP tool ${command.toolName} on ${server.name}: ${error.message}`,
    );
  }

  return new Error(`Failed to execute MCP tool ${command.toolName} on ${server.name}.`);
}

function cleanupFailureMessage(
  result: Awaited<ReturnType<typeof settlePromiseWithTimeout>>,
): string {
  if (result.status === "completed") {
    return "Cleanup completed.";
  }

  return result.error instanceof Error ? result.error.message : "Unknown cleanup failure.";
}

function createMcpTransport(
  proxyUrl: URL,
  authProvider: AuthProvider,
  command: McpExecuteCommand,
  session?: { readonly protocolVersion?: string; readonly sessionId: string },
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(proxyUrl, {
    authProvider,
    fetch: boundedMcpFetch,
    requestInit: {
      headers: { [MOSOO_TOOL_CALL_ID_HEADER]: command.toolCallId },
    },
    ...session,
  });
}

async function closeMcpClient(
  client: Client,
  logger: Logger,
  command: McpExecuteCommand,
): Promise<void> {
  const close = await settlePromiseWithTimeout(
    Promise.resolve().then(() => client.close()),
    {
      label: "MCP client close",
      timeoutMs: MCP_CLEANUP_TIMEOUT_MS,
    },
  );
  if (close.status !== "completed") {
    logger.warn("driver.mcp.client-close.failed", {
      commandId: command.commandId,
      message: cleanupFailureMessage(close),
      serverId: command.serverId,
      status: close.status,
    });
  }
}

async function terminateFailedConnectionSession(
  proxyUrl: URL,
  authProvider: AuthProvider,
  session: { readonly protocolVersion?: string; readonly sessionId: string },
  logger: Logger,
  command: McpExecuteCommand,
): Promise<void> {
  const cleanupTransport = createMcpTransport(proxyUrl, authProvider, command, session);
  const termination = await settlePromiseWithTimeout(
    Promise.resolve().then(async () => {
      await cleanupTransport.start();
      await cleanupTransport.terminateSession();
    }),
    {
      label: "Failed MCP connection session termination",
      timeoutMs: MCP_CLEANUP_TIMEOUT_MS,
    },
  );
  const close = await settlePromiseWithTimeout(
    Promise.resolve().then(() => cleanupTransport.close()),
    {
      label: "Failed MCP connection cleanup transport close",
      timeoutMs: MCP_CLEANUP_TIMEOUT_MS,
    },
  );

  if (termination.status !== "completed") {
    logger.warn("driver.mcp.session-termination.failed", {
      commandId: command.commandId,
      message: cleanupFailureMessage(termination),
      serverId: command.serverId,
      status: termination.status,
    });
  }
  if (close.status !== "completed") {
    logger.warn("driver.mcp.cleanup-transport-close.failed", {
      commandId: command.commandId,
      message: cleanupFailureMessage(close),
      serverId: command.serverId,
      status: close.status,
    });
  }
}

async function closeMcpConnection(
  client: Client,
  transport: StreamableHTTPClientTransport,
  logger: Logger,
  command: McpExecuteCommand,
): Promise<void> {
  let termination = await settlePromiseWithTimeout(
    Promise.resolve().then(() => transport.terminateSession()),
    {
      label: "MCP session termination",
      timeoutMs: MCP_CLEANUP_TIMEOUT_MS,
    },
  );

  if (termination.status === "failed") {
    termination = await settlePromiseWithTimeout(
      Promise.resolve().then(() => transport.terminateSession()),
      {
        label: "MCP session termination retry",
        timeoutMs: MCP_CLEANUP_TIMEOUT_MS,
      },
    );
  }
  if (termination.status !== "completed") {
    logger.warn("driver.mcp.session-termination.failed", {
      commandId: command.commandId,
      message: cleanupFailureMessage(termination),
      serverId: command.serverId,
      status: termination.status,
    });
  }
  await closeMcpClient(client, logger, command);
}

export async function prepareRemoteHttpMcpCommand(
  payload: DriverStartInput,
  command: McpExecuteCommand,
  signal: AbortSignal,
  logger: Logger,
): Promise<AgentDriverMcpExecution> {
  signal.throwIfAborted();
  const server = resolveActiveMcpServer(payload, command);
  const argumentsObject = parseToolArguments(command);
  const proxyUrl = new URL(server.proxyUrl);
  const authProvider: AuthProvider = {
    token: async () => server.proxyGrantId,
  };
  const client = new Client(
    {
      name: "mosoo-driver",
      version: AGENT_DRIVER_VERSION,
    },
    {
      versionNegotiation: { mode: "auto" },
    },
  );
  const transport = createMcpTransport(proxyUrl, authProvider, command);
  const connectSignal = AbortSignal.any([signal, AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS)]);

  try {
    await client.connect(transport, {
      signal: connectSignal,
      timeout: MCP_CONNECT_TIMEOUT_MS,
    });
  } catch (error) {
    const failedSession =
      transport.sessionId === undefined
        ? undefined
        : {
            protocolVersion: transport.protocolVersion ?? LATEST_PROTOCOL_VERSION,
            sessionId: transport.sessionId,
          };

    await closeMcpClient(client, logger, command);
    if (failedSession !== undefined) {
      await terminateFailedConnectionSession(
        proxyUrl,
        authProvider,
        failedSession,
        logger,
        command,
      );
    }
    throw mapMcpExecutionError(command, server, error);
  }

  let disposeTask: Promise<void> | null = null;
  let executed = false;

  return {
    async execute(effect): Promise<McpExternalToolExecutionResult> {
      if (disposeTask !== null || executed) {
        throw new Error(`Prepared MCP command ${command.commandId} can only be executed once.`);
      }
      executed = true;
      const requestSignal = AbortSignal.timeout(AGENT_DRIVER_MCP_EXECUTE_TIMEOUT_MS);

      try {
        const result = await client.callTool(
          {
            _meta: {
              "io.mosoo/idempotency-key": effect.idempotencyKey,
            },
            arguments: argumentsObject,
            name: command.toolName,
          },
          {
            signal: requestSignal,
            timeout: AGENT_DRIVER_MCP_EXECUTE_TIMEOUT_MS,
          },
        );

        return normalizeCallToolResult(result, command);
      } catch (error) {
        throw mapMcpExecutionError(command, server, error);
      }
    },
    async [Symbol.asyncDispose](): Promise<void> {
      return (disposeTask ??= closeMcpConnection(client, transport, logger, command));
    },
  };
}
