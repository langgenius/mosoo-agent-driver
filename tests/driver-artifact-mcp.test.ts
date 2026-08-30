import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  DriverArtifactTestController,
  expectedDriverCapabilities,
  type DriverArtifactBootPayload,
  type DriverArtifactTestCommand,
} from "./driver-artifact-test-controller";
import { driverBootPayload } from "./driver-boot-payload-fixture";
import type { McpExecuteCommand } from "../src/runtime-command";

const MCP_SERVER_ID = "01J00000000000000000000020";
const MCP_GRANT = "artifact-mcp-grant";
const RECOVERY_RUN_ID = "01J00000000000000000000030";
const TEST_TIMEOUT_MS = 45_000;

const FAKE_ACP_AGENT = String.raw`
let buffer = "";
let pendingPromptId;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const mcpRequest = async (server, message) => {
  const response = await fetch(server.url, {
    body: JSON.stringify(message),
    headers: {
      ...Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
      ...(server.sessionId === undefined ? {} : {
        "MCP-Protocol-Version": server.protocolVersion,
        "MCP-Session-Id": server.sessionId,
      }),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) throw new Error("MCP request failed: " + response.status);
  if (message.method === "initialize") {
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId === null) throw new Error("MCP initialize response omitted its session ID.");
    server.protocolVersion = message.params.protocolVersion;
    server.sessionId = sessionId;
  }
  return message.id === undefined ? undefined : response.json();
};
const handle = async (message) => {
  if (!("method" in message)) return;
  if (message.method === "session/cancel") {
    if (pendingPromptId !== undefined) {
      send({ id: pendingPromptId, jsonrpc: "2.0", result: { stopReason: "cancelled" } });
      pendingPromptId = undefined;
    }
    return;
  }
  if (!("id" in message)) return;
  let result;
  switch (message.method) {
    case "initialize":
      result = {
        agentCapabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: { close: {}, resume: {} },
        },
        authMethods: [],
        protocolVersion: 1,
      };
      break;
    case "session/new": {
      const server = message.params.mcpServers[0];
      const initialize = await mcpRequest(server, {
        id: "initialize",
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "artifact-fake-acp", version: "1" },
          protocolVersion: "2025-11-25",
        },
      });
      await mcpRequest(server, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      const tools = await mcpRequest(server, {
        id: "list",
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      });
      if (initialize.result.serverInfo.name !== "artifact-mcp" || tools.result.tools.length === 0) {
        throw new Error("MCP discovery failed.");
      }
      result = { sessionId: "artifact-acp-session" };
      break;
    }
    case "session/close":
    case "session/resume":
      result = {};
      break;
    case "session/prompt":
      pendingPromptId = message.id;
      return;
    default:
      result = {};
  }
  send({ id: message.id, jsonrpc: "2.0", result });
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let newline; (newline = buffer.indexOf("\n")) >= 0; ) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) void handle(JSON.parse(line)).catch((error) => {
      send({
        error: { code: -32603, message: error.message },
        id: JSON.parse(line).id,
        jsonrpc: "2.0",
      });
    });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function mcpCommand(
  commandId: string,
  toolName: string,
  argumentsJson = "{}",
  runId: string = driverBootPayload.execution.configRevision.runId,
): DriverArtifactTestCommand {
  return {
    argumentsJson,
    commandId,
    kind: "mcp.execute",
    requestId: `request-${commandId}`,
    runId,
    serverId: MCP_SERVER_ID,
    toolCallId: `tool-call-${commandId}`,
    toolName,
  } satisfies McpExecuteCommand;
}

function jsonResponse(id: unknown, result: unknown, headers?: HeadersInit): Response {
  return Response.json(
    { id, jsonrpc: "2.0", result },
    headers === undefined ? undefined : { headers },
  );
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(5_000).then(() => {
      throw new Error(`Timed out waiting for ${label}.`);
    }),
  ]);
}

const artifactTest = process.env["AGENT_DRIVER_LIVE"] === "1" ? test : test.skip;

artifactTest(
  "executes stateful MCP through the packed artifact with replay, recovery, and cancellation",
  async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "mosoo-driver-artifact-mcp-"));
    const homePath = join(rootPath, "home");
    const workspacePath = join(rootPath, "workspace");
    await Promise.all([
      mkdir(homePath, { recursive: true }),
      mkdir(workspacePath, { recursive: true }),
    ]);

    const methods: string[] = [];
    const sessions = new Map<string, string>();
    const toolCalls = new Map<string, number>();
    let deleteRequests = 0;
    let cancellationNotifications = 0;
    let invalidSessionHeaders = 0;
    let unauthorizedRequests = 0;
    const hangStarted = Promise.withResolvers<void>();
    const hangReleased = Promise.withResolvers<void>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("authorization") !== `Bearer ${MCP_GRANT}`) {
          unauthorizedRequests += 1;
          return new Response("Unauthorized", { status: 401 });
        }
        const hasValidSessionHeaders = () => {
          const sessionId = request.headers.get("mcp-session-id");
          return (
            sessionId !== null &&
            sessions.get(sessionId) === request.headers.get("mcp-protocol-version")
          );
        };
        if (request.method === "DELETE") {
          deleteRequests += 1;
          if (!hasValidSessionHeaders()) {
            invalidSessionHeaders += 1;
            return new Response("Invalid MCP session headers.", { status: 400 });
          }
          return new Response(null, { status: 405 });
        }
        if (request.method === "GET") {
          if (!hasValidSessionHeaders()) {
            invalidSessionHeaders += 1;
            return new Response("Invalid MCP session headers.", { status: 400 });
          }
          return new Response(null, { status: 405 });
        }

        const message = (await request.json()) as {
          readonly id?: unknown;
          readonly method: string;
          readonly params?: {
            readonly arguments?: Record<string, unknown>;
            readonly name?: string;
            readonly protocolVersion?: string;
            readonly requestId?: unknown;
          };
        };
        methods.push(message.method);

        if (message.method === "server/discover") {
          return Response.json({
            error: { code: -32601, message: "Method not found" },
            id: message.id,
            jsonrpc: "2.0",
          });
        }
        if (message.method !== "initialize" && !hasValidSessionHeaders()) {
          invalidSessionHeaders += 1;
          return new Response("Invalid MCP session headers.", { status: 400 });
        }
        if (message.method === "notifications/cancelled") {
          cancellationNotifications += 1;
          return new Response(null, { status: 202 });
        }
        if (message.method === "notifications/initialized" || message.id === undefined) {
          return new Response(null, { status: 202 });
        }
        if (message.method === "initialize") {
          const protocolVersion = message.params?.protocolVersion;
          if (typeof protocolVersion !== "string") {
            return new Response("Missing MCP protocol version.", { status: 400 });
          }
          const sessionId = crypto.randomUUID();
          sessions.set(sessionId, protocolVersion);
          return jsonResponse(
            message.id,
            {
              capabilities: { tools: {} },
              protocolVersion,
              serverInfo: { name: "artifact-mcp", version: "1" },
            },
            { "MCP-Session-Id": sessionId },
          );
        }
        if (message.method === "tools/list") {
          return jsonResponse(message.id, {
            tools: [
              {
                description: "Increment a side-effect counter.",
                inputSchema: { additionalProperties: false, type: "object" },
                name: "counter",
              },
              {
                description: "Echo one string.",
                inputSchema: {
                  additionalProperties: false,
                  properties: { value: { type: "string" } },
                  required: ["value"],
                  type: "object",
                },
                name: "echo",
              },
              {
                description: "Wait until cancelled.",
                inputSchema: { additionalProperties: false, type: "object" },
                name: "hang",
              },
              {
                description: "Return a recoverable tool execution error.",
                inputSchema: { additionalProperties: false, type: "object" },
                name: "tool-error",
              },
              {
                description: "Return structured content without text blocks.",
                inputSchema: { additionalProperties: false, type: "object" },
                name: "structured",
              },
            ],
          });
        }
        if (message.method !== "tools/call") {
          return Response.json(
            {
              error: { code: -32601, message: `Unknown method: ${message.method}` },
              id: message.id,
              jsonrpc: "2.0",
            },
            { status: 200 },
          );
        }

        const toolName = message.params?.name ?? "";
        toolCalls.set(toolName, (toolCalls.get(toolName) ?? 0) + 1);

        if (toolName === "counter") {
          return jsonResponse(message.id, {
            content: [{ text: `counter:${toolCalls.get(toolName)}`, type: "text" }],
            isError: false,
          });
        }
        if (toolName === "echo") {
          return jsonResponse(message.id, {
            content: [
              {
                text: `echo:${String(message.params?.arguments?.["value"] ?? "")}`,
                type: "text",
              },
            ],
          });
        }
        if (toolName === "hang") {
          hangStarted.resolve();
          await hangReleased.promise;
          return jsonResponse(message.id, {
            content: [{ text: "committed after cancellation", type: "text" }],
          });
        }
        if (toolName === "tool-error") {
          return jsonResponse(message.id, {
            content: [{ text: "retry with corrected input", type: "text" }],
            isError: true,
          });
        }
        if (toolName === "structured") {
          return jsonResponse(message.id, {
            content: [],
            structuredContent: { count: 1, status: "ok" },
          });
        }

        return Response.json({
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
          id: message.id,
          jsonrpc: "2.0",
        });
      },
    });

    let controller: DriverArtifactTestController | null = null;

    try {
      const artifactValue = process.env["AGENT_DRIVER_LIVE_ARTIFACT"] ?? "dist/driver.mjs";
      const artifactPath = isAbsolute(artifactValue)
        ? artifactValue
        : resolve(process.cwd(), artifactValue);
      expect(existsSync(artifactPath)).toBe(true);

      const bootPayload = {
        ...driverBootPayload,
        execution: {
          ...driverBootPayload.execution,
          environment: { variables: {} },
          session: {
            ...driverBootPayload.execution.session,
            context: {
              ...driverBootPayload.execution.session.context,
              homePath,
              sessionOrganizationPath: workspacePath,
            },
            cwd: workspacePath,
            mcpServers: [
              {
                authType: "bearer",
                authorizationState: "active",
                credentialId: "01J00000000000000000000021",
                credentialScope: "session",
                credentialStatus: "active",
                name: "Artifact MCP",
                proxyGrantId: MCP_GRANT,
                proxyUrl: `http://${server.hostname}:${server.port}/mcp`,
                serverId: MCP_SERVER_ID,
              },
            ],
          },
        },
        runtime: "acp-fallback",
        runtimeTransport: "acp-fallback",
      } satisfies DriverArtifactBootPayload;
      controller = await DriverArtifactTestController.start({
        artifactPath,
        bootPayload,
        env: {
          MOSOO_ACP_FALLBACK_ARGS: JSON.stringify(["-e", FAKE_ACP_AGENT]),
          MOSOO_ACP_FALLBACK_COMMAND: process.execPath,
        },
        expectedCapabilities: expectedDriverCapabilities(bootPayload.runtime),
        organizationPath: workspacePath,
        rootPath,
        forbiddenSecrets: [MCP_GRANT],
        startTimeoutMs: 10_000,
      });

      expect(methods.slice(0, 3)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
      expect(unauthorizedRequests).toBe(0);

      const initialRunEventIndex = controller.events.length;
      controller.enqueue({
        commandId: "input-mcp-run",
        input: { text: "hold MCP run open" },
        kind: "input.start",
        requestId: "request-input-mcp-run",
        runId: driverBootPayload.execution.configRevision.runId,
      });
      await controller.waitForEvent(
        (event) =>
          event.kind === "run.started" &&
          event.runId === driverBootPayload.execution.configRevision.runId,
        initialRunEventIndex,
        10_000,
        "initial MCP run start",
      );

      const counterCommand = mcpCommand("mcp-counter", "counter");
      controller.enqueue(counterCommand);
      const counter = await controller.waitForCommandTerminal("mcp-counter", 10_000);
      expect(counter).toEqual({
        commandId: "mcp-counter",
        result: {
          isError: false,
          outputText: "counter:1",
          requestId: "request-mcp-counter",
          serverId: MCP_SERVER_ID,
          toolName: "counter",
        },
        status: "completed",
      });

      const replayIndex = controller.commandUpdates.length;
      controller.enqueue(counterCommand);
      expect(await controller.waitForCommandTerminal("mcp-counter", 10_000, replayIndex)).toEqual(
        counter,
      );
      expect(toolCalls.get("counter")).toBe(1);

      controller.enqueue(mcpCommand("mcp-missing", "missing"));
      expect((await controller.waitForCommandTerminal("mcp-missing", 10_000)).status).toBe(
        "failed",
      );

      controller.enqueue(mcpCommand("mcp-invalid-arguments", "echo", "[]"));
      expect(
        (await controller.waitForCommandTerminal("mcp-invalid-arguments", 10_000)).status,
      ).toBe("failed");
      expect(toolCalls.has("echo")).toBe(false);

      controller.enqueue(mcpCommand("mcp-tool-error", "tool-error"));
      expect(await controller.waitForCommandTerminal("mcp-tool-error", 10_000)).toMatchObject({
        result: {
          isError: true,
          outputText: "retry with corrected input",
        },
        status: "completed",
      });

      controller.enqueue(mcpCommand("mcp-recovery", "echo", '{"value":"alive"}'));
      expect(await controller.waitForCommandTerminal("mcp-recovery", 10_000)).toMatchObject({
        result: { outputText: "echo:alive" },
        status: "completed",
      });

      controller.enqueue(mcpCommand("mcp-structured", "structured"));
      expect(await controller.waitForCommandTerminal("mcp-structured", 10_000)).toMatchObject({
        result: {
          outputText: JSON.stringify(
            {
              content: [],
              structuredContent: { count: 1, status: "ok" },
            },
            null,
            2,
          ),
        },
        status: "completed",
      });

      controller.enqueue(mcpCommand("mcp-hang", "hang"));
      await withTimeout(hangStarted.promise, "hanging MCP call");
      controller.enqueue({
        commandId: "cancel-mcp-hang",
        kind: "turn.cancel",
        reason: "artifact.mcp.test.cancel",
        runId: driverBootPayload.execution.configRevision.runId,
      });
      hangReleased.resolve();
      const [hangUpdate, cancelUpdate, initialRunUpdate] = await Promise.all([
        controller.waitForCommandTerminal("mcp-hang", 10_000),
        controller.waitForCommandTerminal("cancel-mcp-hang", 10_000),
        controller.waitForCommandTerminal("input-mcp-run", 10_000),
      ]);
      controller.assertHealthy("committed MCP cancellation");
      expect(hangUpdate).toMatchObject({
        result: { outputText: "committed after cancellation" },
        status: "completed",
      });
      expect(cancelUpdate.status).toBe("completed");
      expect(initialRunUpdate.status).toBe("cancelled");
      expect(cancellationNotifications).toBe(0);

      const recoveryRunEventIndex = controller.events.length;
      controller.enqueue({
        commandId: "input-mcp-recovery-run",
        input: { text: "hold recovery MCP run open" },
        kind: "input.start",
        requestId: "request-input-mcp-recovery-run",
        runId: RECOVERY_RUN_ID,
      });
      await controller.waitForEvent(
        (event) => event.kind === "run.started" && event.runId === RECOVERY_RUN_ID,
        recoveryRunEventIndex,
        10_000,
        "recovery MCP run start",
      );

      controller.enqueue(
        mcpCommand("mcp-after-cancel", "echo", '{"value":"recovered"}', RECOVERY_RUN_ID),
      );
      expect(await controller.waitForCommandTerminal("mcp-after-cancel", 10_000)).toMatchObject({
        result: { outputText: "echo:recovered" },
        status: "completed",
      });

      controller.enqueue({
        commandId: "changed-replay",
        kind: "turn.cancel",
        reason: "first reason",
        runId: RECOVERY_RUN_ID,
      });
      expect((await controller.waitForCommandTerminal("changed-replay", 10_000)).status).toBe(
        "completed",
      );
      controller.enqueue({
        commandId: "changed-replay",
        kind: "turn.cancel",
        reason: "changed reason",
        runId: RECOVERY_RUN_ID,
      });
      const replayFailure = await controller.waitForRunTerminal(10_000);
      expect(replayFailure.status).toBe("failed");
      expect(JSON.stringify(replayFailure.error)).toContain(
        "replayed with changed identity or content",
      );
      expect(await controller.waitForExit(10_000)).toMatchObject({ code: 1, signal: null });
      expect(deleteRequests).toBeGreaterThan(0);
      expect(invalidSessionHeaders).toBe(0);
      expect(sessions.size).toBeGreaterThan(1);
      expect(unauthorizedRequests).toBe(0);
    } finally {
      hangReleased.resolve();
      await controller?.dispose();
      await server.stop(true);
      await rm(rootPath, { force: true, recursive: true });
    }
  },
  TEST_TIMEOUT_MS,
);
