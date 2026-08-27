import {
  Client,
  InsufficientScopeError,
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
import type { AgentDriverMcpExecution } from "../../host-ports";
import type { DriverStartInput } from "../../protocol/start";
import type { McpExecuteCommand, McpExternalToolExecutionResult } from "../../runtime-command";
import { settlePromiseWithTimeout } from "../../utils/async";

type SessionMcpServer = DriverStartInput["execution"]["session"]["mcpServers"][number];
type ActiveMcpServer = Extract<SessionMcpServer, { authorizationState: "active" }>;

const MCP_REQUEST_TIMEOUT_MS = 60_000;
const MCP_CLEANUP_TIMEOUT_MS = 2_000;
const MOSOO_TOOL_CALL_ID_HEADER = "X-Mosoo-Tool-Call-Id";

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
  const textContent = result.content.flatMap((block) =>
    block.type === "text" ? [block.text] : [],
  );
  const plainText =
    result.content.length === 1 &&
    result.content[0]?.type === "text" &&
    Object.keys(result.content[0]).every((key) => key === "type" || key === "text");
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
    : textContent.length > 0
      ? textContent.join("\n\n")
      : result.isError === true
        ? `MCP tool ${command.toolName} reported an error without textual details.`
        : "";

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

async function closeMcpConnection(
  client: Client,
  transport: StreamableHTTPClientTransport,
): Promise<void> {
  await settlePromiseWithTimeout(
    Promise.resolve().then(() => transport.terminateSession()),
    {
      label: "MCP session termination",
      timeoutMs: MCP_CLEANUP_TIMEOUT_MS,
    },
  );
  await settlePromiseWithTimeout(
    Promise.resolve().then(() => client.close()),
    {
      label: "MCP client close",
      timeoutMs: MCP_CLEANUP_TIMEOUT_MS,
    },
  );
}

export async function prepareRemoteHttpMcpCommand(
  payload: DriverStartInput,
  command: McpExecuteCommand,
  signal: AbortSignal,
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
  const transport = new StreamableHTTPClientTransport(proxyUrl, {
    authProvider,
    requestInit: {
      headers: { [MOSOO_TOOL_CALL_ID_HEADER]: command.toolCallId },
    },
  });
  const connectSignal = AbortSignal.any([signal, AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS)]);

  try {
    await client.connect(transport, {
      signal: connectSignal,
      timeout: MCP_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    await closeMcpConnection(client, transport);
    throw mapMcpExecutionError(command, server, error);
  }

  let disposed = false;
  let executed = false;

  return {
    async execute(effect): Promise<McpExternalToolExecutionResult> {
      if (disposed || executed) {
        throw new Error(`Prepared MCP command ${command.commandId} can only be executed once.`);
      }
      executed = true;
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS)]);

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
            timeout: MCP_REQUEST_TIMEOUT_MS,
          },
        );

        return normalizeCallToolResult(result, command);
      } catch (error) {
        throw mapMcpExecutionError(command, server, error);
      }
    },
    async [Symbol.asyncDispose](): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      await closeMcpConnection(client, transport);
    },
  };
}
