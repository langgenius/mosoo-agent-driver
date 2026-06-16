import { describe, expect, test } from "bun:test";

import type {
  AuthorizedDriverBootMcpServer,
  DriverBootMcpServer,
  UnavailableDriverBootMcpServer,
} from "../src/protocol/boot";
import type { CredentialId, McpServerId } from "../src/protocol/boot/host-ids";
import { buildOpenAiMcpServerConfig } from "../src/runtimes/openai/mcp-config";

function authorizedServer(
  overrides: Partial<AuthorizedDriverBootMcpServer> = {},
): AuthorizedDriverBootMcpServer {
  return {
    authType: "oauth",
    authorizationState: "active",
    credentialId: "cred-1" as CredentialId,
    credentialScope: "app",
    credentialStatus: "active",
    name: "Linear",
    proxyGrantId: "grant-token",
    proxyUrl: "https://api.example/driver/mcp/proxy/server-1",
    serverId: "server-1" as McpServerId,
    ...overrides,
  };
}

function unavailableServer(): UnavailableDriverBootMcpServer {
  return {
    authType: "oauth",
    authorizationState: "authorization_required",
    credentialScope: "app",
    credentialStatus: "expired",
    name: "Notion",
    serverId: "server-unavailable" as McpServerId,
  };
}

describe("buildOpenAiMcpServerConfig", () => {
  test("wires authorized servers to the HTTP proxy via a token env var", () => {
    const config = buildOpenAiMcpServerConfig([authorizedServer()]);

    expect(config.mcpServers).toEqual({
      Linear: {
        bearer_token_env_var: "MOSOO_MCP_BEARER_TOKEN_0",
        url: "https://api.example/driver/mcp/proxy/server-1",
      },
    });
    expect(config.env).toEqual({ MOSOO_MCP_BEARER_TOKEN_0: "grant-token" });
  });

  test("skips servers that are not active", () => {
    const servers: DriverBootMcpServer[] = [unavailableServer()];
    const config = buildOpenAiMcpServerConfig(servers);

    expect(config.mcpServers).toEqual({});
    expect(config.env).toEqual({});
  });

  test("dedupes duplicate names and gives each server a distinct token env var", () => {
    const config = buildOpenAiMcpServerConfig([
      authorizedServer({
        name: "Linear",
        proxyGrantId: "grant-a",
        proxyUrl: "https://api.example/driver/mcp/proxy/a",
        serverId: "server-a" as McpServerId,
      }),
      authorizedServer({
        name: "Linear",
        proxyGrantId: "grant-b",
        proxyUrl: "https://api.example/driver/mcp/proxy/b",
        serverId: "server-b" as McpServerId,
      }),
    ]);

    expect(Object.keys(config.mcpServers)).toEqual(["Linear", "Linear-2"]);
    expect(config.mcpServers["Linear"]).toMatchObject({
      bearer_token_env_var: "MOSOO_MCP_BEARER_TOKEN_0",
    });
    expect(config.mcpServers["Linear-2"]).toMatchObject({
      bearer_token_env_var: "MOSOO_MCP_BEARER_TOKEN_1",
    });
    expect(config.env).toEqual({
      MOSOO_MCP_BEARER_TOKEN_0: "grant-a",
      MOSOO_MCP_BEARER_TOKEN_1: "grant-b",
    });
  });

  test("falls back to the server id when the name is blank", () => {
    const config = buildOpenAiMcpServerConfig([
      authorizedServer({ name: "  ", serverId: "server-7" as McpServerId }),
    ]);

    expect(Object.keys(config.mcpServers)).toEqual(["server-7"]);
  });
});
