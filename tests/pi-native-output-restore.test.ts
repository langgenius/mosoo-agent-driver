import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createBufferedSinkLogger } from "../src/observability";
import type { CredentialId, McpServerId } from "../src/protocol/boot";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import { isJsonObject, type JsonObject } from "../src/protocol/json";
import { parseNativeCheckpoint } from "../src/protocol/native-checkpoint";
import type { DriverStartInput } from "../src/protocol/start";
import { readNativeCheckpoint } from "../src/runtimes/native-checkpoint";
import { preparePiLaunch } from "../src/runtimes/pi/pi-configuration";
import { PiDriverBackend } from "../src/runtimes/pi/pi-driver-backend";
import { driverStartInput, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

const cli =
  process.env["MOSOO_PI_TEST_CLI"] ??
  join(
    dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
    "bundle",
    "cli.js",
  );
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

function harness(payload: DriverStartInput) {
  const events: DriverEventInput[] = [];
  let seq = 0;
  let currentRunId: RunId | null = null;
  const context = createAgentDriverContext({
    payload,
    logger: createBufferedSinkLogger({ level: "error", service: "pi-test", sink: async () => {} }),
    eventSink: {
      currentRunId: () => currentRunId,
      pushEvents: async ({ events: batch }) => {
        events.push(...batch);
        return {
          accepted: batch.map((event) => ({
            eventId: event.sourceEventId!,
            seq: ++seq,
            type: event.kind,
          })),
        };
      },
    },
    permission: { request: async () => "allow_once" },
    ports: { skill: { materialize: async () => [] } },
  });
  const backend = new PiDriverBackend(payload, {
    prepare: async (input, skills, signal) => {
      const config = await preparePiLaunch(input, skills, signal);
      return { ...config, command: "node", args: [cli, ...config.args] };
    },
  });
  const stop = () => backend.stop(context, "test.cleanup", AbortSignal.timeout(10_000));
  cleanup.push(stop);
  return {
    events,
    start: () => backend.start(context, AbortSignal.timeout(20_000)),
    stop,
    run: async (runId: RunId) => {
      currentRunId = runId;
      try {
        await backend.handleInput(context, { text: "Read the complete tool output." }, runId);
      } finally {
        currentRunId = null;
      }
    },
  };
}

function response(delta: JsonObject, finish = "stop"): Response {
  const chunk = (value: JsonObject, stop: string | null) =>
    `data: ${JSON.stringify({
      id: "pi-output-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "pi-test",
      choices: [{ index: 0, delta: value, finish_reason: stop }],
    })}\n\n`;
  return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function toolCall(id: string, name: string, input: JsonObject): Response {
  return response(
    {
      role: "assistant",
      tool_calls: [
        { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } },
      ],
    },
    "tool_calls",
  );
}

test.each(["bash", "mcp"] as const)(
  "restores real Pi %s full output using only the committed checkpoint",
  async (source) => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-pi-output-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const marker = `${source}-output-line`;
    const repetitions = source === "bash" ? 80_000 : 4_000;
    const fullOutput = `${marker}\n`.repeat(repetitions);
    const binaryOutput = Buffer.from([0, 255, 1, 128, 2, 127]);
    let mcpCalls = 0;
    const mcp = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        expect(request.headers.get("authorization")).toBe("Bearer pi-mcp-grant");
        const rpc = (await request.json()) as { id?: string; method: string };
        if (rpc.id === undefined) return new Response(null, { status: 202 });
        const result =
          rpc.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "pi-test", version: "1" },
              }
            : rpc.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "output",
                      description: "Return a large output.",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                }
              : {
                  content: [
                    { type: "text", text: fullOutput },
                    {
                      type: "resource",
                      resource: {
                        uri: "mosoo://output/blob.bin",
                        mimeType: "application/octet-stream",
                        blob: binaryOutput.toString("base64"),
                      },
                    },
                  ],
                };
        if (rpc.method === "tools/call") mcpCalls++;
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
      },
    });
    cleanup.push(async () => {
      await mcp.stop(true);
    });
    let calls = 0;
    let outputPath = "";
    let restoredToolResult: unknown;
    const model = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as {
          tools: { function: { name: string } }[];
          messages: { role: string; content: unknown }[];
        };
        calls++;
        if (calls === 1) {
          if (source === "bash") {
            return toolCall("large-output", "bash", {
              command: `node -e 'process.stdout.write("${marker}\\n".repeat(${repetitions}))'`,
            });
          }
          const tool = body.tools.find((entry) => entry.function.name.endsWith("__output"));
          expect(tool).toBeDefined();
          return toolCall("large-output", tool!.function.name, {});
        }
        if (calls === 3) {
          expect(JSON.stringify(body.messages)).toContain(outputPath);
          return toolCall("restored-output", "read", {
            path: outputPath,
            offset: repetitions / 2,
            limit: 1,
          });
        }
        if (calls === 4) {
          restoredToolResult = body.messages.findLast((message) => message.role === "tool");
        }
        return response({ role: "assistant", content: "The complete output is readable." });
      },
    });
    cleanup.push(async () => {
      await model.stop(true);
    });
    const payload: DriverStartInput = {
      ...driverStartInput,
      runtime: "pi",
      runtimeTransport: "pi-rpc",
      execution: {
        ...driverStartInput.execution,
        model: "pi-test",
        provider: "deepseek",
        environment: {
          variables: {
            MOSOO_PI_PROXY_GRANT: "test-proxy-grant",
            MOSOO_PI_CONFIG_CONTENT: JSON.stringify({
              providers: {
                deepseek: {
                  api: "openai-completions",
                  baseUrl: `http://127.0.0.1:${model.port}/v1`,
                  apiKey: "${MOSOO_PI_PROXY_GRANT}",
                  models: [{ id: "pi-test", contextWindow: 32768, maxTokens: 4096 }],
                },
              },
            }),
          },
        },
        session: {
          ...driverStartInput.execution.session,
          homePath: root,
          cwd: root,
          sharedRootPath: root,
          mcpServers:
            source === "mcp"
              ? [
                  {
                    serverId: "01J00000000000000000000020" as McpServerId,
                    name: "output",
                    authorizationState: "active",
                    authType: "bearer",
                    credentialId: "01J00000000000000000000021" as CredentialId,
                    credentialScope: "session",
                    credentialStatus: "active",
                    proxyGrantId: "pi-mcp-grant",
                    proxyUrl: `http://127.0.0.1:${mcp.port}/mcp`,
                  },
                ]
              : [],
        },
      },
    };
    const first = harness(payload);
    await first.start();
    const home = join(root, "pi");
    await writeFile(join(home, "tmp", "secret.json"), "test-private-data");
    await first.run(DRIVER_TEST_IDS.runId);
    const completed = first.events.findLast((event) => event.kind === "run.completed");
    expect(first.events.filter((event) => event.kind === "run.completed")).toHaveLength(1);
    expect(first.events.some((event) => event.kind === "run.failed")).toBe(false);
    if (!completed || !isJsonObject(completed.payload)) throw new Error("Pi run did not complete.");
    const checkpoint = parseNativeCheckpoint(completed.payload["checkpoint"]);
    const bundle = await readNativeCheckpoint({ cwd: root, checkpoint });
    const transcript = (await bundle.readFile("session.jsonl")).toString();
    for (const line of transcript.trim().split("\n")) {
      const entry: unknown = JSON.parse(line);
      if (!isJsonObject(entry) || !isJsonObject(entry["message"])) continue;
      const message = entry["message"];
      if (message["role"] !== "toolResult" || !isJsonObject(message["details"])) continue;
      const path = message["details"]["fullOutputPath"];
      if (typeof path === "string") outputPath = path;
    }
    expect(dirname(outputPath)).toBe(join(home, "tmp"));
    expect(basename(outputPath)).toMatch(
      source === "bash" ? /^pi-bash-[0-9a-f]{16}\.log$/u : /^pi-mcp-[0-9a-f]{16}\.txt$/u,
    );
    const relativeOutput = `tmp/${basename(outputPath)}`;
    const originalOutput = await readFile(outputPath);
    const expectedFiles = ["native-home.json", "session.jsonl", relativeOutput];
    let binaryPath: string | undefined;
    if (source === "mcp") {
      binaryPath = /^\[Binary resource .+ saved to (.+)\]$/mu.exec(originalOutput.toString())?.[1];
      expect(binaryPath).toBeDefined();
      expect(dirname(binaryPath!)).toBe(join(home, "tmp"));
      expect(basename(binaryPath!)).toMatch(/^pi-mcp-[0-9a-f]{16}\.bin$/u);
      const relativeBinary = `tmp/${basename(binaryPath!)}`;
      expectedFiles.push(relativeBinary);
      expect(await bundle.readFile(relativeBinary)).toEqual(binaryOutput);
    }
    expect(bundle.manifest.files.map((file) => file.path).sort()).toEqual(expectedFiles.sort());
    expect(JSON.parse((await bundle.readFile("native-home.json")).toString())).toEqual({ home });
    expect(await bundle.readFile(relativeOutput)).toEqual(originalOutput);
    expect(originalOutput.toString()).toContain(fullOutput);
    expect(originalOutput.byteLength).toBeGreaterThan(source === "bash" ? 1024 * 1024 : 20 * 1024);
    await first.stop();
    await rm(home, { recursive: true, force: true });
    const second = harness({
      ...payload,
      execution: {
        ...payload.execution,
        session: {
          ...payload.execution.session,
          nativeResumeRef: checkpoint.nativeRef,
          nativeCheckpoint: checkpoint,
        },
      },
    });
    await second.start();
    expect(await readFile(outputPath)).toEqual(originalOutput);
    if (binaryPath !== undefined) expect(await readFile(binaryPath)).toEqual(binaryOutput);
    await second.run(DRIVER_TEST_IDS.secondRunId);
    expect(calls).toBe(4);
    expect(mcpCalls).toBe(source === "mcp" ? 1 : 0);
    expect(JSON.stringify(restoredToolResult)).toContain(marker);
    expect(JSON.stringify(restoredToolResult)).not.toContain("ENOENT");
    expect(second.events.filter((event) => event.kind === "run.completed")).toHaveLength(1);
    expect(second.events.some((event) => event.kind === "run.failed")).toBe(false);
  },
  60_000,
);
