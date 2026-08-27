import { expect, test } from "bun:test";

import type { CredentialId, McpServerId } from "../src/protocol/boot";
import type { DriverStartInput } from "../src/protocol/start";
import type { McpExecuteCommand } from "../src/runtime-command";
import { prepareRemoteHttpMcpCommand } from "../src/runtimes/mcp/remote-http-mcp-executor";
import { driverStartInput } from "./driver-boot-payload-fixture";

const MCP_SERVER_ID = "01J00000000000000000000020" as McpServerId;
const MCP_CREDENTIAL_ID = "01J00000000000000000000021" as CredentialId;

function payload(proxyUrl: string): DriverStartInput {
  return {
    ...driverStartInput,
    execution: {
      ...driverStartInput.execution,
      session: {
        ...driverStartInput.execution.session,
        mcpServers: [
          {
            authType: "bearer",
            authorizationState: "active",
            credentialId: MCP_CREDENTIAL_ID,
            credentialScope: "session",
            credentialStatus: "active",
            name: "Test MCP",
            proxyGrantId: "test-grant",
            proxyUrl,
            serverId: MCP_SERVER_ID,
          },
        ],
      },
    },
  };
}

function command(requestId: string): McpExecuteCommand {
  return {
    argumentsJson: "{}",
    commandId: `command-${requestId}`,
    kind: "mcp.execute",
    requestId,
    serverId: MCP_SERVER_ID,
    toolCallId: `tool-${requestId}`,
    toolName: "lookup",
  };
}

async function execute(proxyUrl: string, requestId: string, signal = new AbortController().signal) {
  await using prepared = await prepareRemoteHttpMcpCommand(
    payload(proxyUrl),
    command(requestId),
    signal,
  );
  const result = await prepared.execute({
    effectId: `effect-${requestId}`,
    idempotencyKey: `key-${requestId}`,
  });
  return result;
}

test("classifies typed MCP HTTP failures by status", async () => {
  const unauthorizedHeaders: Array<string | null> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const status = Number(new URL(request.url).pathname.slice(1));
      if (status === 401) {
        unauthorizedHeaders.push(request.headers.get("authorization"));
      }
      return new Response("failed", { status });
    },
  });

  try {
    for (const [status, message] of [
      [400, "rejected the request for lookup (HTTP 400)"],
      [401, "authorization for Test MCP is no longer valid"],
      [403, "rejected the credential for lookup"],
      [404, "HTTP endpoint for Test MCP was not found"],
      [408, "Timed out while calling MCP tool lookup"],
      [409, "reported a conflict while calling lookup"],
      [418, "rejected lookup with HTTP 418"],
      [429, "rate limited lookup"],
      [503, "failed while calling lookup (HTTP 503)"],
    ] as const) {
      await expect(
        execute(`http://${server.hostname}:${server.port}/${status}`, `status-${status}`),
      ).rejects.toThrow(message);
    }
    expect(unauthorizedHeaders).toEqual(["Bearer test-grant"]);
  } finally {
    await server.stop(true);
  }
});

test("auto-negotiates the latest MCP era and falls back to legacy", async () => {
  const methods = new Map<string, string[]>();
  const protocolHeaders: Array<string | null> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") {
        return new Response(null, { status: 405 });
      }

      const route = new URL(request.url).pathname.slice(1);
      const message = (await request.json()) as {
        id?: unknown;
        method?: string;
        params?: { protocolVersion?: string };
      };
      const method = message.method ?? "unknown";
      methods.set(route, [...(methods.get(route) ?? []), method]);

      if (route === "legacy" && method === "server/discover") {
        return new Response("not found", { status: 404 });
      }

      if (method === "server/discover") {
        return Response.json({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            capabilities: { tools: {} },
            supportedVersions: ["2026-07-28"],
          },
        });
      }

      if (method === "initialize") {
        return Response.json({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            capabilities: { tools: {} },
            protocolVersion: message.params?.protocolVersion,
            serverInfo: { name: "test-mcp", version: "1" },
          },
        });
      }

      if (method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }

      if (method === "tools/call") {
        protocolHeaders.push(request.headers.get("mcp-protocol-version"));
        if (route === "scope") {
          return new Response("insufficient scope", {
            headers: {
              "www-authenticate": 'Bearer error="insufficient_scope", scope="tools:call"',
            },
            status: 403,
          });
        }
        if (route === "mixed") {
          return Response.json({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              _meta: { receipt: "private" },
              content: [
                { text: "  exact text  ", type: "text" },
                { data: "aA==", mimeType: "image/png", type: "image" },
              ],
              isError: false,
              resultType: "complete",
              structuredContent: { count: 1 },
            },
          });
        }
        if (route === "annotated") {
          return Response.json({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              content: [
                {
                  _meta: { source: "provider" },
                  annotations: { audience: ["assistant"] },
                  text: "annotated",
                  type: "text",
                },
              ],
              resultType: "complete",
            },
          });
        }
        return Response.json({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            content: [{ text: route, type: "text" }],
            ...(route === "modern" ? { resultType: "complete" } : {}),
          },
        });
      }

      return new Response("unexpected request", { status: 400 });
    },
  });

  try {
    const baseUrl = `http://${server.hostname}:${server.port}`;
    expect(await execute(`${baseUrl}/modern`, "modern")).toMatchObject({ outputText: "modern" });
    expect(await execute(`${baseUrl}/legacy`, "legacy")).toMatchObject({ outputText: "legacy" });
    const mixed = await execute(`${baseUrl}/mixed`, "mixed");
    expect(JSON.parse(mixed.outputText)).toEqual({
      content: [
        { text: "  exact text  ", type: "text" },
        { data: "aA==", mimeType: "image/png", type: "image" },
      ],
      isError: false,
      structuredContent: { count: 1 },
    });
    expect(mixed.providerReceiptJson).toBe('{"receipt":"private"}');
    expect(JSON.parse((await execute(`${baseUrl}/annotated`, "annotated")).outputText)).toEqual({
      content: [
        {
          _meta: { source: "provider" },
          annotations: { audience: ["assistant"] },
          text: "annotated",
          type: "text",
        },
      ],
    });
    await expect(execute(`${baseUrl}/scope`, "scope")).rejects.toThrow(
      "credential for Test MCP lacks the access required for lookup",
    );

    expect(methods.get("modern")).toEqual(["server/discover", "tools/call"]);
    expect(methods.get("mixed")).toEqual(["server/discover", "tools/call"]);
    expect(methods.get("annotated")).toEqual(["server/discover", "tools/call"]);
    expect(methods.get("legacy")).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(methods.get("scope")).toEqual(["server/discover", "tools/call"]);
    expect(protocolHeaders).toEqual([
      "2026-07-28",
      expect.stringMatching(/^2025-/),
      "2026-07-28",
      "2026-07-28",
      "2026-07-28",
    ]);
  } finally {
    await server.stop(true);
  }
});

test("terminates an established MCP session after cancellation", async () => {
  const callStarted = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const sessionDeleted = Promise.withResolvers<string | null>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET") {
        return new Response(null, { status: 405 });
      }

      if (request.method === "DELETE") {
        sessionDeleted.resolve(request.headers.get("mcp-session-id"));
        return new Response(null, { status: 200 });
      }

      const message = (await request.json()) as {
        id?: unknown;
        method?: string;
        params?: { protocolVersion?: string };
      };

      if (message.method === "server/discover") {
        return new Response("not found", { status: 404 });
      }

      if (message.method === "initialize") {
        return Response.json(
          {
            id: message.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: message.params?.protocolVersion,
              serverInfo: { name: "test-mcp", version: "1" },
            },
          },
          { headers: { "mcp-session-id": "cancelled-session" } },
        );
      }

      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }

      if (message.method === "notifications/cancelled") {
        cancelled.resolve();
        return new Response(null, { status: 202 });
      }

      if (message.method === "tools/call") {
        callStarted.resolve();
        if (!request.signal.aborted) {
          await Promise.race([
            cancelled.promise,
            new Promise<void>((resolve) =>
              request.signal.addEventListener("abort", () => resolve(), { once: true }),
            ),
          ]);
        }
        return Response.json({
          id: message.id,
          jsonrpc: "2.0",
          result: { content: [{ text: "cancelled", type: "text" }] },
        });
      }

      return new Response("unexpected request", { status: 400 });
    },
  });

  try {
    const controller = new AbortController();
    const execution = execute(
      `http://${server.hostname}:${server.port}/cancel`,
      "cancel",
      controller.signal,
    );
    await callStarted.promise;
    controller.abort(new Error("cancel requested"));

    await expect(execution).rejects.toThrow();
    expect(await sessionDeleted.promise).toBe("cancelled-session");
  } finally {
    await server.stop(true);
  }
});
