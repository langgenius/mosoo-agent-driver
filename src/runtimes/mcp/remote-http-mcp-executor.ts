import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { AuthProvider, CallToolResult } from "@modelcontextprotocol/client";

import { AGENT_DRIVER_VERSION } from "../../core/version";
import type { DriverStartInput } from "../../protocol/start";
import type { McpExecuteCommand } from "../../runtime-command";
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
): { outputText: string; requestId: string; serverId: string; toolName: string } {
  const textContent = result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .map((text) => text.trim())
    .filter((text) => text.length > 0);

  const outputText =
    textContent.length > 0
      ? textContent.join("\n\n")
      : result.structuredContent !== undefined
        ? JSON.stringify(result.structuredContent, null, 2)
        : result.content.length > 0
          ? JSON.stringify(result.content, null, 2)
          : result.isError === true
            ? `MCP tool ${command.toolName} reported an error without textual details.`
            : "";

  return {
    outputText,
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
  if (error instanceof SdkError) {
    switch (error.code) {
      case SdkErrorCode.ClientHttpAuthentication: {
        return new Error(
          `MCP authorization for ${server.name} is no longer valid. Refresh or reconnect the credential and retry.`,
        );
      }
      case SdkErrorCode.ClientHttpForbidden: {
        return new Error(
          `MCP server ${server.name} rejected the credential for ${command.toolName}. Access may have been revoked.`,
        );
      }
      case SdkErrorCode.RequestTimeout: {
        return new Error(`Timed out while calling MCP tool ${command.toolName} on ${server.name}.`);
      }
      case SdkErrorCode.ConnectionClosed:
      case SdkErrorCode.SendFailed:
      case SdkErrorCode.ClientHttpFailedToOpenStream:
      case SdkErrorCode.ClientHttpUnexpectedContent:
      case SdkErrorCode.NotConnected: {
        return new Error(`Failed to reach MCP server ${server.name}: ${error.message}`);
      }
      case SdkErrorCode.CapabilityNotSupported: {
        return new Error(
          `MCP server ${server.name} does not support the requested capability for ${command.toolName}.`,
        );
      }
      case SdkErrorCode.ClientHttpNotImplemented: {
        return new Error(`MCP server ${server.name} does not support HTTP tool execution.`);
      }
      case SdkErrorCode.AlreadyConnected:
      case SdkErrorCode.NotInitialized:
      case SdkErrorCode.ClientHttpFailedToTerminateSession: {
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
    const lowered = error.message.toLowerCase();

    if (lowered.includes("unauthorized") || lowered.includes("401")) {
      return new Error(
        `MCP authorization for ${server.name} is no longer valid. Refresh or reconnect the credential and retry.`,
      );
    }

    if (lowered.includes("forbidden") || lowered.includes("403")) {
      return new Error(
        `MCP server ${server.name} rejected the credential for ${command.toolName}. Access may have been revoked.`,
      );
    }

    return new Error(
      `Failed to execute MCP tool ${command.toolName} on ${server.name}: ${error.message}`,
    );
  }

  return new Error(`Failed to execute MCP tool ${command.toolName} on ${server.name}.`);
}

export async function executeRemoteHttpMcpCommand(
  payload: DriverStartInput,
  command: McpExecuteCommand,
  signal: AbortSignal,
): Promise<{ outputText: string; requestId: string; serverId: string; toolName: string }> {
  signal.throwIfAborted();
  const server = resolveActiveMcpServer(payload, command);
  const argumentsObject = parseToolArguments(command);
  const authProvider: AuthProvider = {
    token: async () => server.proxyGrantId,
  };
  const client = new Client({
    name: "mosoo-driver",
    version: AGENT_DRIVER_VERSION,
  });
  const transport = new StreamableHTTPClientTransport(new URL(server.proxyUrl), {
    authProvider,
    requestInit: {
      headers: { [MOSOO_TOOL_CALL_ID_HEADER]: command.toolCallId },
    },
  });
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS)]);

  try {
    await client.connect(transport, {
      signal: requestSignal,
      timeout: MCP_REQUEST_TIMEOUT_MS,
    });
    const result = await client.callTool(
      {
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
  } finally {
    if (!requestSignal.aborted) {
      await settlePromiseWithTimeout(transport.terminateSession(), {
        label: "MCP session termination",
        timeoutMs: MCP_CLEANUP_TIMEOUT_MS,
      });
    }

    await settlePromiseWithTimeout(client.close(), {
      label: "MCP client close",
      timeoutMs: MCP_CLEANUP_TIMEOUT_MS,
    });
  }
}
