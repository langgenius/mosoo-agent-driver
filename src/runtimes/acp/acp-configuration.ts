import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { AgentCapabilities, ClientCapabilities, McpServer } from "@agentclientprotocol/sdk";

import type { DriverExecutionSessionContext } from "../../protocol/boot";
import type { DriverStartInput } from "../../protocol/start";
import { buildRuntimeChildProcessEnv } from "../child-process-env";
import type { JsonObject } from "./acp-types";

type AcpHttpMcpServer = Extract<McpServer, { type: "http" }>;

export const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;
const ACP_RUNTIME_HOME_DIR = "acp-fallback";
const ACP_DEFAULT_COMMAND = "acp-agent";
const ACP_INHERITED_PROCESS_ENV_KEYS = [
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_USE_ENV_PROXY",
  "NO_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export function readFallbackCommand(): string {
  const command = process.env["MOSOO_ACP_FALLBACK_COMMAND"];
  return typeof command === "string" && command.trim().length > 0
    ? command.trim()
    : ACP_DEFAULT_COMMAND;
}

export function readFallbackArgs(): string[] {
  const rawArgs = process.env["MOSOO_ACP_FALLBACK_ARGS"];

  if (typeof rawArgs !== "string" || rawArgs.trim().length === 0) {
    return [];
  }

  const parsed: unknown = JSON.parse(rawArgs);

  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("MOSOO_ACP_FALLBACK_ARGS must be a JSON string array.");
  }

  return parsed;
}

function buildInheritedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const inherited: Record<string, string> = {};

  for (const key of ACP_INHERITED_PROCESS_ENV_KEYS) {
    const value = env[key];

    if (typeof value === "string" && value.trim().length > 0) {
      inherited[key] = value;
    }
  }

  return inherited;
}

export function buildChildEnv(
  payload: DriverStartInput,
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const { homePath } = payload.execution.session;

  return buildRuntimeChildProcessEnv(payload.execution.environment.paths, {
    ...buildInheritedEnv(processEnv),
    ...payload.execution.environment.variables,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
    MOSOO_ACP_HOME: `${homePath}/${ACP_RUNTIME_HOME_DIR}`,
    HOME: homePath,
    IS_SANDBOX: "1",
    PATH: processEnv["PATH"] ?? "",
    PWD: payload.execution.session.cwd,
  });
}

export function buildClientCapabilities(): ClientCapabilities {
  return {
    fs: {
      readTextFile: true,
      writeTextFile: true,
    },
    session: {
      configOptions: {
        boolean: {},
      },
    },
    terminal: true,
  };
}

export function buildMcpServers(payload: DriverStartInput): AcpHttpMcpServer[] {
  return payload.execution.session.mcpServers.flatMap((server): AcpHttpMcpServer[] => {
    if (server.authorizationState !== "active") {
      return [];
    }

    return [
      {
        _meta: {
          "mosoo.ai/credentialId": server.credentialId,
          "mosoo.ai/credentialScope": server.credentialScope,
          "mosoo.ai/serverId": server.serverId,
        },
        headers: [
          {
            name: "Authorization",
            value: `Bearer ${server.proxyGrantId}`,
          },
        ],
        name: server.name,
        type: "http",
        url: server.proxyUrl,
      },
    ];
  });
}

export function assertMcpSupport(
  agentCapabilities: AgentCapabilities | null,
  servers: AcpHttpMcpServer[],
): void {
  if (servers.length === 0) {
    return;
  }

  if (agentCapabilities?.mcpCapabilities?.http === true) {
    return;
  }

  throw new Error("ACP agent does not advertise HTTP MCP support.");
}

export function assertProtocolVersion(result: { readonly protocolVersion: unknown }): void {
  if (result.protocolVersion === ACP_PROTOCOL_VERSION) {
    return;
  }

  throw new Error(
    `ACP agent returned unsupported protocol version: ${String(result.protocolVersion ?? "missing")}.`,
  );
}

export function readResumeId(payload: DriverStartInput): string | null {
  const ref = payload.execution.session.nativeResumeRef;

  if (ref === null) {
    return null;
  }

  if (ref.runtimeId !== "acp-fallback" || ref.kind !== "acp_session_id") {
    throw new Error("ACP fallback received an incompatible native resume ref.");
  }

  if (ref.value.trim().length === 0) {
    throw new Error("ACP fallback received an empty native session ID.");
  }

  return ref.value;
}

export function resolveAuthMethod(
  authMethods: readonly { readonly id: string }[],
  env: Record<string, string>,
): string | null {
  const requestedMethodId = env["MOSOO_ACP_AUTH_METHOD_ID"]?.trim();

  if (typeof requestedMethodId !== "string" || requestedMethodId.length === 0) {
    return null;
  }

  if (authMethods.some((method) => method.id === requestedMethodId)) {
    return requestedMethodId;
  }

  throw new Error(`Configured ACP auth method is not advertised: ${requestedMethodId}.`);
}

export function toRequestMeta(input: {
  sessionContext: DriverExecutionSessionContext;
}): JsonObject {
  const context = input.sessionContext;

  return {
    "mosoo.ai/origin": context.origin,
    "mosoo.ai/sessionContext": context,
  };
}

export function supportsSessionClose(agentCapabilities: AgentCapabilities | null): boolean {
  return agentCapabilities?.sessionCapabilities?.close != null;
}

export function supportsAdditionalDirs(agentCapabilities: AgentCapabilities | null): boolean {
  return agentCapabilities?.sessionCapabilities?.additionalDirectories != null;
}

export function supportsSessionLoad(agentCapabilities: AgentCapabilities | null): boolean {
  return agentCapabilities?.loadSession === true;
}

export function supportsSessionResume(agentCapabilities: AgentCapabilities | null): boolean {
  return agentCapabilities?.sessionCapabilities?.resume != null;
}
