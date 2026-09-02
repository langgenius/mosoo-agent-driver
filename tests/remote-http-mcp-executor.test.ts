import { expect, spyOn, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";

import type { CredentialId, McpServerId } from "../src/protocol/boot";
import type { DriverStartInput } from "../src/protocol/start";
import type { McpExecuteCommand } from "../src/runtime-command";
import { createDisabledLogger } from "../src/observability";
import { prepareRemoteHttpMcpCommand } from "../src/runtimes/mcp/remote-http-mcp-executor";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { DRIVER_TEST_IDS, driverStartInput } from "./driver-boot-payload-fixture";

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
    runId: DRIVER_TEST_IDS.runId,
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
    createDisabledLogger(),
  );
  const result = await prepared.execute({
    attempt: 1,
    effectId: `effect-${requestId}`,
    idempotencyKey: `key-${requestId}`,
    kind: "claimed",
  });
  return result;
}

function sessionServer(
  onDelete: (request: Request, attempt: number) => Response | Promise<Response>,
) {
  let deleteRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "DELETE") {
        deleteRequests += 1;
        return onDelete(request, deleteRequests);
      }
      if (request.method === "GET") {
        return new Response(null, { status: 405 });
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
          { headers: { "mcp-session-id": "cleanup-session" } },
        );
      }
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "tools/call") {
        return Response.json({
          id: message.id,
          jsonrpc: "2.0",
          result: { content: [{ text: "ok", type: "text" }] },
        });
      }
      return new Response("unexpected request", { status: 400 });
    },
  });

  return {
    deleteRequests: () => deleteRequests,
    server,
    url: `http://${server.hostname}:${server.port}/mcp`,
  };
}

function prepareSession(proxyUrl: string, requestId: string, logger = createDisabledLogger()) {
  return prepareRemoteHttpMcpCommand(
    payload(proxyUrl),
    command(requestId),
    new AbortController().signal,
    logger,
  );
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
  const idempotencyKeys: unknown[] = [];
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
        params?: {
          _meta?: Record<string, unknown>;
          protocolVersion?: string;
        };
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
        idempotencyKeys.push(message.params?._meta?.["io.mosoo/idempotency-key"]);
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
    expect(idempotencyKeys).toEqual([
      "key-modern",
      "key-legacy",
      "key-mixed",
      "key-annotated",
      "key-scope",
    ]);
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

test.each(["malformed-json", "oversized-content-length"] as const)(
  "terminates a session exactly once after an initialize %s failure",
  async (mode) => {
    const deletes: Array<{
      authorization: string | null;
      protocolVersion: string | null;
      sessionId: string | null;
      toolCallId: string | null;
    }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "DELETE") {
          deletes.push({
            authorization: request.headers.get("authorization"),
            protocolVersion: request.headers.get("mcp-protocol-version"),
            sessionId: request.headers.get("mcp-session-id"),
            toolCallId: request.headers.get("x-mosoo-tool-call-id"),
          });
          return new Response(null, { status: 200 });
        }
        if (request.method === "GET") {
          return new Response(null, { status: 405 });
        }

        const message = (await request.json()) as { method?: string };
        if (message.method === "server/discover") {
          return new Response("not found", { status: 404 });
        }
        if (message.method === "initialize") {
          return new Response(
            mode === "malformed-json" ? "{" : new Uint8Array(8 * 1_024 * 1_024 + 1),
            {
              headers: {
                "content-type": "application/json",
                "mcp-session-id": `${mode}-session`,
              },
              status: 200,
            },
          );
        }
        return new Response(null, { status: 202 });
      },
    });

    try {
      await expect(
        prepareSession(`http://${server.hostname}:${server.port}/mcp`, mode),
      ).rejects.toThrow(
        mode === "malformed-json" ? "JSON Parse error" : "MCP response exceeds 8388608 bytes",
      );
      expect(deletes).toEqual([
        {
          authorization: "Bearer test-grant",
          protocolVersion: LATEST_PROTOCOL_VERSION,
          sessionId: `${mode}-session`,
          toolCallId: `tool-${mode}`,
        },
      ]);
    } finally {
      await server.stop(true);
    }
  },
);

test("does not interrupt a committed MCP call when the prepare signal is cancelled", async () => {
  const callStarted = Promise.withResolvers<void>();
  const releaseCall = Promise.withResolvers<void>();
  const sessionDeleted = Promise.withResolvers<string | null>();
  let cancellationNotifications = 0;
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
        cancellationNotifications += 1;
        return new Response(null, { status: 202 });
      }

      if (message.method === "tools/call") {
        callStarted.resolve();
        await releaseCall.promise;
        return Response.json({
          id: message.id,
          jsonrpc: "2.0",
          result: { content: [{ text: "committed", type: "text" }] },
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
    releaseCall.resolve();

    await expect(execution).resolves.toMatchObject({ outputText: "committed" });
    expect(await sessionDeleted.promise).toBe("cancelled-session");
    expect(cancellationNotifications).toBe(0);
  } finally {
    releaseCall.resolve();
    await server.stop(true);
  }
});

test("retries a settled MCP session termination failure once", async () => {
  const harness = sessionServer(
    (_request, attempt) => new Response(null, { status: attempt === 1 ? 503 : 200 }),
  );

  try {
    const prepared = await prepareSession(harness.url, "cleanup-retry");
    await prepared[Symbol.asyncDispose]();
    expect(harness.deleteRequests()).toBe(2);
  } finally {
    await harness.server.stop(true);
  }
});

test("closes locally and reports an exhausted MCP session termination", async () => {
  const harness = sessionServer(() => new Response(null, { status: 503 }));
  const logger = createDisabledLogger();
  const warn = spyOn(logger, "warn");

  try {
    const prepared = await prepareSession(harness.url, "cleanup-failed", logger);
    await expect(prepared[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(harness.deleteRequests()).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      "driver.mcp.session-termination.failed",
      expect.objectContaining({ status: "failed" }),
    );
  } finally {
    warn.mockRestore();
    await harness.server.stop(true);
  }
});

test("does not overlap MCP session termination after its deadline", async () => {
  const releaseDelete = Promise.withResolvers<void>();
  const harness = sessionServer(async () => {
    await releaseDelete.promise;
    return new Response(null, { status: 200 });
  });

  try {
    const prepared = await prepareSession(harness.url, "cleanup-timeout");
    const startedAt = performance.now();
    await prepared[Symbol.asyncDispose]();
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1_900);
    expect(harness.deleteRequests()).toBe(1);
  } finally {
    releaseDelete.resolve();
    await harness.server.stop(true);
  }
}, 10_000);

test("joins concurrent MCP disposal into one cleanup transaction", async () => {
  const harness = sessionServer(() => new Response(null, { status: 200 }));

  try {
    const prepared = await prepareSession(harness.url, "cleanup-joined");
    await Promise.all([
      prepared[Symbol.asyncDispose](),
      prepared[Symbol.asyncDispose](),
      prepared[Symbol.asyncDispose](),
    ]);
    expect(harness.deleteRequests()).toBe(1);
    await expect(
      prepared.execute({
        attempt: 1,
        effectId: "late-effect",
        idempotencyKey: "late-key",
        kind: "claimed",
      }),
    ).rejects.toThrow("can only be executed once");
  } finally {
    await harness.server.stop(true);
  }
});

test.each(["content-length", "stream"] as const)(
  "rejects an oversized MCP %s response before SDK parsing",
  async (mode) => {
    const responseBytes = 8 * 1_024 * 1_024 + 1;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const message = (await request.json()) as { id?: unknown; method?: string };
        if (message.method === "server/discover") {
          return Response.json({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              supportedVersions: ["2026-07-28"],
            },
          });
        }
        if (message.method === "tools/call") {
          if (mode === "content-length") {
            return new Response(new Uint8Array(responseBytes), {
              headers: {
                "content-length": String(responseBytes),
                "content-type": "application/json",
              },
            });
          }

          let remaining = responseBytes;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (remaining === 0) {
                  controller.close();
                  return;
                }
                const chunk = new Uint8Array(Math.min(1_024 * 1_024, remaining));
                remaining -= chunk.byteLength;
                controller.enqueue(chunk);
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("unexpected request", { status: 400 });
      },
    });

    try {
      await expect(
        execute(`http://${server.hostname}:${server.port}/oversized`, `oversized-${mode}`),
      ).rejects.toThrow("MCP response exceeds 8388608 bytes");
    } finally {
      await server.stop(true);
    }
  },
  10_000,
);

test("does not await cancellation of an oversized Content-Length body", async () => {
  let cancelCalled = false;
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        cancel() {
          cancelCalled = true;
          return new Promise<void>(() => {});
        },
      }),
      {
        headers: {
          "content-length": String(8 * 1_024 * 1_024 + 1),
          "content-type": "application/json",
        },
      },
    ),
  );

  try {
    const outcome = await settlePromiseWithTimeout(
      prepareSession("https://mcp.invalid/oversized", "oversized-cancel"),
      {
        label: "oversized MCP Content-Length rejection",
        timeoutMs: 1_000,
      },
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toContain("MCP response exceeds 8388608 bytes");
    }
    expect(cancelCalled).toBe(true);
  } finally {
    fetch.mockRestore();
  }
});
