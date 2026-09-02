import { describe, expect, test } from "bun:test";

import type { DriverBootMcpServer } from "../src/protocol/boot";
import type { CredentialId, McpServerId } from "../src/protocol/boot/host-ids";
import { toMcpServerKey } from "../src/runtimes/mcp/server-key";

function server(name: string): DriverBootMcpServer {
  return {
    authorizationState: "active",
    authType: "bearer",
    credentialId: "01J00000000000000000000000" as CredentialId,
    credentialScope: "mcp",
    credentialStatus: "active",
    name,
    proxyGrantId: "grant",
    proxyUrl: "https://mcp.test",
    serverId: "01J00000000000000000000001" as McpServerId,
  };
}

describe("toMcpServerKey", () => {
  test.each(["__proto__", "constructor", "prototype"])(
    "uses the stable server id for unsafe object key %s",
    (name) => {
      expect(toMcpServerKey(server(name), new Set())).toBe("01J00000000000000000000001");
    },
  );
});
