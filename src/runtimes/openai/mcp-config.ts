import type { AuthorizedDriverBootMcpServer, DriverBootMcpServer } from "../../protocol/boot";
import type { JsonValue } from "../../protocol/json";

export interface OpenAiMcpServerConfig {
  /**
   * Bearer-token environment variables to inject into the app-server child
   * process. Referenced from config.toml via `bearer_token_env_var` so the
   * short-lived proxy grant never lands on disk.
   */
  readonly env: Record<string, string>;
  /**
   * `[mcp_servers.<name>]` tables to merge into the generated config.toml. Each
   * entry points the OpenAI runtime at the host MCP proxy over streamable HTTP.
   */
  readonly mcpServers: Record<string, JsonValue>;
}

function isAuthorized(server: DriverBootMcpServer): server is AuthorizedDriverBootMcpServer {
  return server.authorizationState === "active";
}

function toMcpServerKey(server: DriverBootMcpServer, usedNames: Set<string>): string {
  const baseName = server.name.trim() || server.serverId;
  let candidate = baseName;
  let suffix = 2;

  while (usedNames.has(candidate)) {
    candidate = `${baseName}-${suffix}`;
    suffix += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function toBearerTokenEnvName(index: number): string {
  return `MOSOO_MCP_BEARER_TOKEN_${index}`;
}

/**
 * Translate authorized boot MCP servers into the OpenAI runtime (Codex)
 * `config.toml` shape. Only `authorizationState === "active"` servers are
 * wired; unavailable servers are skipped, mirroring the Claude and ACP
 * backends. The proxy grant is passed through a dedicated environment variable
 * rather than inlined into config.toml.
 */
export function buildOpenAiMcpServerConfig(
  servers: readonly DriverBootMcpServer[],
): OpenAiMcpServerConfig {
  const usedNames = new Set<string>();
  const mcpServers: Record<string, JsonValue> = {};
  const env: Record<string, string> = {};
  let index = 0;

  for (const server of servers) {
    if (!isAuthorized(server)) {
      continue;
    }

    const key = toMcpServerKey(server, usedNames);
    const bearerTokenEnvName = toBearerTokenEnvName(index);
    index += 1;

    env[bearerTokenEnvName] = server.proxyGrantId;
    mcpServers[key] = {
      bearer_token_env_var: bearerTokenEnvName,
      url: server.proxyUrl,
    };
  }

  return { env, mcpServers };
}
