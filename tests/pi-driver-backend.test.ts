import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createBufferedSinkLogger } from "../src/observability";
import type { CredentialId, McpServerId } from "../src/protocol/boot";
import type { DriverEventInput } from "../src/protocol/events";
import { isJsonObject } from "../src/protocol/json";
import type { JsonObject } from "../src/protocol/json";
import type { DriverStartInput } from "../src/protocol/start";
import { preparePiLaunch, resolvePiSessionPath } from "../src/runtimes/pi/pi-configuration";
import { PiDriverBackend } from "../src/runtimes/pi/pi-driver-backend";
import { PiEventTranslator } from "../src/runtimes/pi/pi-event-translator";
import { driverStartInput as bootPayload, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

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

function harness(payload: DriverStartInput, decide: "allow_once" | "reject_once" = "allow_once") {
  const events: DriverEventInput[] = [];
  const permissions: string[] = [];
  let seq = 0;
  const context = createAgentDriverContext({
    payload,
    logger: createBufferedSinkLogger({ level: "error", service: "pi-test", sink: async () => {} }),
    eventSink: {
      pushEvents: async ({ events: batch }) => {
        events.push(...batch);
        return { accepted: batch.map((event) => ({ seq: ++seq, type: event.kind })) };
      },
    },
    permission: {
      request: async (request) => {
        permissions.push(request.title);
        return decide;
      },
    },
    ports: { skill: { materialize: async () => [] } },
  });
  const backend = new PiDriverBackend(payload, {
    prepare: async (input) => {
      const config = await preparePiLaunch(input);
      return { ...config, command: "node", args: [cli, ...config.args] };
    },
  });
  cleanup.push(() => backend.stop(context, "test.cleanup", AbortSignal.timeout(10_000)));
  return { backend, context, events, permissions };
}

async function payloadFor(baseUrl: string, api = "openai-completions"): Promise<DriverStartInput> {
  const root = await mkdtemp(join(tmpdir(), "mosoo-pi-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return {
    ...bootPayload,
    runtime: "pi",
    runtimeTransport: "pi-rpc",
    execution: {
      ...bootPayload.execution,
      model: "pi-test",
      provider: "deepseek",
      systemPrompt: "mosoo-pi-test-instructions",
      environment: {
        variables: {
          MOSOO_PI_PROXY_GRANT: "test-proxy-grant",
          MOSOO_PI_CONFIG_CONTENT: JSON.stringify({
            providers: {
              mosoo: {
                api,
                baseUrl,
                apiKey: "${MOSOO_PI_PROXY_GRANT}",
                models: [{ id: "pi-test", contextWindow: 32768, maxTokens: 4096 }],
              },
            },
          }),
        },
      },
      session: {
        ...bootPayload.execution.session,
        homePath: root,
        cwd: root,
        sharedRootPath: root,
      },
    },
  };
}

function response(delta: JsonObject, finish = "stop"): Response {
  const event = (content: JsonObject) => `data: ${JSON.stringify(content)}\n\n`;
  const chunk = (value: JsonObject, stop: string | null) => ({
    id: "pi-mock",
    object: "chat.completion.chunk",
    created: 1,
    model: "pi-test",
    choices: [{ index: 0, delta: value, finish_reason: stop }],
  });
  return new Response(event(chunk(delta, null)) + event(chunk({}, finish)) + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("Pi runtime", () => {
  test("fails a truncated model response instead of reporting successful completion", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => response({ role: "assistant", content: "Incomplete answer" }, "length"),
    });
    cleanup.push(async () => {
      await server.stop(true);
    });
    const run = harness(await payloadFor(`http://127.0.0.1:${server.port}/v1`));
    await run.backend.start(run.context, AbortSignal.timeout(20_000));
    await expect(
      run.backend.handleInput(run.context, { text: "Respond." }, DRIVER_TEST_IDS.runId),
    ).rejects.toThrow("length");
    expect(run.events.some((event) => event.kind === "run.completed")).toBe(false);
    expect(run.events.filter((event) => event.kind === "run.failed")).toHaveLength(1);
  }, 30_000);

  test.each([
    "truncated JSON",
    "missing entry fields",
    "dangling parent",
    "duplicate entry ID",
    "self parent",
    "missing message",
    "different workspace",
    "missing compaction payload",
    "missing compaction retained entry",
    "compaction retains another branch",
    "unknown entry type",
    "unknown message role",
    "missing message content",
    "invalid content block",
    "missing branch summary",
    "missing custom message content",
    "context edit loses content",
    "missing context edit target",
    "context edit targets another branch",
  ])(
    "rejects a native transcript with %s instead of silently omitting saved history",
    async (damage) => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => response({ role: "assistant", content: "Remember this answer." }),
      });
      cleanup.push(async () => {
        await server.stop(true);
      });
      const input = await payloadFor(`http://127.0.0.1:${server.port}/v1`);
      const payload = {
        ...input,
        execution: {
          ...input.execution,
          session: { ...input.execution.session, cwd: await realpath(input.execution.session.cwd) },
        },
      };
      const first = harness(payload);
      await first.backend.start(first.context, AbortSignal.timeout(20_000));
      await first.backend.handleInput(first.context, { text: "Respond." }, DRIVER_TEST_IDS.runId);
      const resume = first.events.findLast((event) => event.kind === "runtime.resume.updated")!;
      if (!isJsonObject(resume.payload) || typeof resume.payload["resumePointer"] !== "string")
        throw new Error("No Pi resume pointer.");
      const pointer = resume.payload["resumePointer"];
      await first.backend.stop(first.context, "cold", AbortSignal.timeout(10_000));
      const path = join(payload.execution.session.homePath, "pi", pointer);
      const records = (await readFile(path, "utf8")).trim().split("\n");
      const last: unknown = JSON.parse(records.at(-1)!);
      if (!isJsonObject(last) || typeof last["id"] !== "string") throw new Error("No Pi leaf.");
      const entry = {
        type: "session_info",
        id: "corrupted-entry",
        parentId: last["id"],
        timestamp: new Date().toISOString(),
      };
      const corruptions: Record<string, string> = {
        "truncated JSON": '{"type":"message"',
        "missing entry fields": JSON.stringify({ unexpected: "valid-json" }),
        "dangling parent": JSON.stringify({ ...entry, parentId: "missing-parent" }),
        "duplicate entry ID": JSON.stringify({ ...entry, id: last["id"] }),
        "self parent": JSON.stringify({ ...entry, parentId: entry.id }),
        "missing message": JSON.stringify({ ...entry, type: "message" }),
        "unknown entry type": JSON.stringify({ ...entry, type: "messgae" }),
        "unknown message role": JSON.stringify({
          ...entry,
          type: "message",
          message: { role: "usre", content: "Saved content.", timestamp: Date.now() },
        }),
        "missing message content": JSON.stringify({
          ...entry,
          type: "message",
          message: { role: "user", timestamp: Date.now() },
        }),
        "invalid content block": JSON.stringify({
          ...entry,
          type: "message",
          message: {
            role: "user",
            content: [{ type: "txet", text: "Saved content." }],
            timestamp: Date.now(),
          },
        }),
        "missing branch summary": JSON.stringify({
          ...entry,
          type: "branch_summary",
          fromId: "old-branch",
        }),
        "missing custom message content": JSON.stringify({
          ...entry,
          type: "custom_message",
          customType: "test",
          display: false,
        }),
        "context edit loses content": JSON.stringify({
          ...entry,
          type: "context_edit",
          targetId: last["id"],
          replacement: {},
        }),
        "missing context edit target": JSON.stringify({
          ...entry,
          type: "context_edit",
          targetId: "missing-entry",
          replacement: null,
        }),
        "context edit targets another branch": [
          JSON.stringify({
            ...entry,
            type: "custom_message",
            id: "other-branch",
            parentId: null,
            content: "Saved content.",
            customType: "test",
            display: false,
          }),
          JSON.stringify({
            ...entry,
            type: "context_edit",
            targetId: "other-branch",
            replacement: null,
          }),
        ].join("\n"),
        "missing compaction payload": JSON.stringify({ ...entry, type: "compaction" }),
        "missing compaction retained entry": JSON.stringify({
          ...entry,
          type: "compaction",
          summary: "Saved summary.",
          tokensBefore: 10,
          firstKeptEntryId: "missing-entry",
        }),
        "compaction retains another branch": [
          JSON.stringify({ ...entry, id: "other-branch", parentId: null }),
          JSON.stringify({
            ...entry,
            type: "compaction",
            summary: "Saved summary.",
            tokensBefore: 10,
            firstKeptEntryId: "other-branch",
          }),
        ].join("\n"),
      };
      if (damage === "different workspace") {
        const other = await mkdtemp(join(tmpdir(), "mosoo-pi-other-"));
        cleanup.push(() => rm(other, { recursive: true, force: true }));
        const header: unknown = JSON.parse(records[0]!);
        if (!isJsonObject(header)) throw new Error("No Pi header.");
        records[0] = JSON.stringify({ ...header, cwd: other });
        await writeFile(path, `${records.join("\n")}\n`);
      } else {
        await appendFile(path, `${corruptions[damage]}\n`);
      }
      const restored = harness({
        ...payload,
        execution: {
          ...payload.execution,
          session: {
            ...payload.execution.session,
            nativeResumeRef: { kind: "pi_session_path", runtimeId: "pi", value: pointer },
            nativeResumeRequired: true,
          },
        },
      });
      await expect(
        restored.backend.start(restored.context, AbortSignal.timeout(20_000)),
      ).rejects.toThrow(damage === "truncated JSON" ? SyntaxError : "Pi restored session");
      expect(restored.events.some((event) => event.kind === "runtime.resume.updated")).toBe(false);
    },
    30_000,
  );

  test("uses the native Anthropic request path and proxy grant", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        expect(new URL(request.url).pathname).toBe("/proxy/v1/messages");
        expect(request.headers.get("x-api-key")).toBe("test-proxy-grant");
        const body = (await request.json()) as { model: string };
        expect(body.model).toBe("pi-test");
        const records = [
          {
            type: "message_start",
            message: {
              id: "msg_test",
              type: "message",
              role: "assistant",
              model: "pi-test",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Anthropic route." },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 3 },
          },
          { type: "message_stop" },
        ];
        return new Response(
          records
            .map((record) => `event: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    cleanup.push(async () => {
      await server.stop(true);
    });
    const run = harness(
      await payloadFor(`http://127.0.0.1:${server.port}/proxy`, "anthropic-messages"),
    );
    await run.backend.start(run.context, AbortSignal.timeout(20_000));
    await run.backend.handleInput(run.context, { text: "Respond." }, DRIVER_TEST_IDS.runId);
    expect(run.events.find((event) => event.kind === "run.completed")?.payload).toMatchObject({
      finalMessageText: "Anthropic route.",
    });
  }, 30_000);

  test("uses the native OpenAI Responses request path and proxy grant", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        expect(new URL(request.url).pathname).toBe("/proxy/responses");
        expect(request.headers.get("authorization")).toBe("Bearer test-proxy-grant");
        const body = (await request.json()) as { model: string };
        expect(body.model).toBe("pi-test");
        const item = {
          type: "message",
          id: "msg_test",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Responses route.", annotations: [] }],
        };
        const records = [
          {
            type: "response.created",
            response: { id: "resp_test", status: "in_progress", output: [] },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", content: [] },
          },
          {
            type: "response.content_part.added",
            output_index: 0,
            content_index: 0,
            item_id: "msg_test",
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            item_id: "msg_test",
            delta: "Responses route.",
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_test",
              status: "completed",
              output: [item],
              usage: {
                input_tokens: 3,
                output_tokens: 3,
                total_tokens: 6,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          },
        ];
        return new Response(
          records
            .map((record) => `event: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    cleanup.push(async () => {
      await server.stop(true);
    });
    const run = harness(
      await payloadFor(`http://127.0.0.1:${server.port}/proxy`, "openai-responses"),
    );
    await run.backend.start(run.context, AbortSignal.timeout(20_000));
    await run.backend.handleInput(run.context, { text: "Respond." }, DRIVER_TEST_IDS.runId);
    expect(run.events.find((event) => event.kind === "run.completed")?.payload).toMatchObject({
      finalMessageText: "Responses route.",
    });
  }, 30_000);

  test.each(["command", "signal"] as const)(
    "cancels an active native stream through $0 and accepts the next turn",
    async (mode) => {
      const started = Promise.withResolvers<void>();
      let calls = 0;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => {
          if (++calls > 1)
            return response({ role: "assistant", content: "Continued after cancellation." });
          started.resolve();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"id":"wait","choices":[{"index":0,"delta":{"role":"assistant","content":"waiting"},"finish_reason":null}]}\n\n',
                  ),
                );
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      });
      cleanup.push(async () => {
        await server.stop(true);
      });
      const run = harness(await payloadFor(`http://127.0.0.1:${server.port}/v1`));
      await run.backend.start(run.context, AbortSignal.timeout(20_000));
      const controller = new AbortController();
      const active = run.backend.handleInput(
        run.context,
        { text: "Wait." },
        DRIVER_TEST_IDS.runId,
        controller.signal,
      );
      const outcome = active.then(
        () => null,
        (error: unknown) => error,
      );
      await started.promise;
      if (mode === "command") await run.backend.cancelActiveTurn(run.context, "test.cancel");
      else controller.abort();
      expect(await outcome).toMatchObject({ name: "DriverTurnCancelledError" });
      expect(run.events.filter((event) => event.kind === "run.cancelled")).toHaveLength(1);
      expect(run.events.some((event) => event.kind === "run.completed")).toBe(false);
      await run.backend.handleInput(
        run.context,
        { text: "Continue." },
        DRIVER_TEST_IDS.secondRunId,
      );
      expect(run.events.find((event) => event.kind === "run.completed")?.payload).toMatchObject({
        finalMessageText: "Continued after cancellation.",
      });
    },
    45_000,
  );

  test.skipIf(process.platform !== "linux")(
    "cancellation kills a native Bash tool tree before terminal delivery",
    async () => {
      let calls = 0;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          ++calls === 1
            ? response(
                {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "sleep-tool",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({
                          command: "echo $$ > shell.pid; sleep 3; echo escaped > escaped.txt",
                        }),
                      },
                    },
                  ],
                },
                "tool_calls",
              )
            : response({ role: "assistant", content: "Continued." }),
      });
      cleanup.push(async () => {
        await server.stop(true);
      });
      const payload = await payloadFor(`http://127.0.0.1:${server.port}/v1`);
      const run = harness(payload);
      await run.backend.start(run.context, AbortSignal.timeout(20_000));
      const outcome = run.backend
        .handleInput(run.context, { text: "Run the shell tool." }, DRIVER_TEST_IDS.runId)
        .then(
          () => null,
          (error: unknown) => error,
        );
      const pidFile = join(payload.execution.session.cwd, "shell.pid");
      const deadline = Date.now() + 10_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(20);
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      await run.backend.cancelActiveTurn(run.context, "test.bash.cancel");
      expect(await outcome).toMatchObject({ name: "DriverTurnCancelledError" });
      expect(existsSync(`/proc/${pid}`)).toBe(false);
      await Bun.sleep(3200);
      expect(existsSync(join(payload.execution.session.cwd, "escaped.txt"))).toBe(false);
      await run.backend.handleInput(
        run.context,
        { text: "Continue." },
        DRIVER_TEST_IDS.secondRunId,
      );
      expect(run.events.find((event) => event.kind === "run.completed")?.payload).toMatchObject({
        finalMessageText: "Continued.",
      });
    },
    45_000,
  );

  test("cancels a pending permission before execution and accepts the next turn", async () => {
    const permissionRequested = Promise.withResolvers<void>();
    let calls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        ++calls === 1
          ? response(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "pending-write",
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({ path: "cancelled.txt", content: "no" }),
                    },
                  },
                ],
              },
              "tool_calls",
            )
          : response({ role: "assistant", content: "Continued after permission cancellation." }),
    });
    cleanup.push(async () => {
      await server.stop(true);
    });
    const payload = await payloadFor(`http://127.0.0.1:${server.port}/v1`);
    const run = harness(payload);
    let permissionAborted = false;
    const context = {
      ...run.context,
      ports: {
        ...run.context.ports,
        permission: {
          request: async (_request: unknown, signal?: AbortSignal): Promise<"allow_once"> => {
            if (!signal) throw new Error("Permission must be cancellable.");
            permissionRequested.resolve();
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  permissionAborted = true;
                  reject(signal.reason);
                },
                { once: true },
              );
            });
          },
        },
      },
    };
    await run.backend.start(context, AbortSignal.timeout(20_000));
    const outcome = run.backend
      .handleInput(context, { text: "Write cancelled.txt." }, DRIVER_TEST_IDS.runId)
      .catch((error: unknown) => error);
    await permissionRequested.promise;
    await run.backend.cancelActiveTurn(context, "test.permission.cancel");
    expect(await outcome).toMatchObject({ name: "DriverTurnCancelledError" });
    expect(permissionAborted).toBe(true);
    expect(existsSync(join(payload.execution.session.cwd, "cancelled.txt"))).toBe(false);
    expect(run.events.filter((event) => event.kind === "run.cancelled")).toHaveLength(1);
    await run.backend.handleInput(context, { text: "Continue." }, DRIVER_TEST_IDS.secondRunId);
    expect(run.events.find((event) => event.kind === "run.completed")?.payload).toMatchObject({
      finalMessageText: "Continued after permission cancellation.",
    });
  }, 30_000);

  test("discovers and calls a real authenticated native MCP tool", async () => {
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
                      name: "ping",
                      description: "Return a marker.",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                }
              : { content: [{ type: "text", text: "mcp-marker" }] };
        if (rpc.method === "tools/call") mcpCalls++;
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
      },
    });
    cleanup.push(async () => {
      await mcp.stop(true);
    });
    let modelCalls = 0;
    const model = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as {
          tools: { function: { name: string } }[];
          messages: object[];
        };
        if (++modelCalls > 1) {
          expect(JSON.stringify(body.messages)).toContain("mcp-marker");
          return response({ role: "assistant", content: "MCP succeeded." });
        }
        const tool = body.tools.find((entry) => entry.function.name.endsWith("__ping"));
        expect(tool).toBeDefined();
        return response(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "mcp-ping",
                type: "function",
                function: { name: tool!.function.name, arguments: "{}" },
              },
            ],
          },
          "tool_calls",
        );
      },
    });
    cleanup.push(async () => {
      await model.stop(true);
    });
    const payload = await payloadFor(`http://127.0.0.1:${model.port}/v1`);
    const run = harness({
      ...payload,
      execution: {
        ...payload.execution,
        session: {
          ...payload.execution.session,
          mcpServers: [
            {
              serverId: "01J00000000000000000000020" as McpServerId,
              name: "marker",
              authorizationState: "active",
              authType: "bearer",
              credentialId: "01J00000000000000000000021" as CredentialId,
              credentialScope: "session",
              credentialStatus: "active",
              proxyGrantId: "pi-mcp-grant",
              proxyUrl: `http://127.0.0.1:${mcp.port}/mcp`,
            },
          ],
        },
      },
    });
    await run.backend.start(run.context, AbortSignal.timeout(20_000));
    await run.backend.handleInput(
      run.context,
      { text: "Call the MCP marker." },
      DRIVER_TEST_IDS.runId,
    );
    expect(mcpCalls).toBe(1);
    expect(run.permissions).toEqual(["mcp__01J00000000000000000000020__ping"]);
    const persisted = await readFile(
      join(payload.execution.session.homePath, "pi", "mcp.json"),
      "utf8",
    );
    expect(persisted).not.toContain("pi-mcp-grant");
  }, 45_000);

  test.each(["ancestor", "summary-only"])(
    "runs real Pi tools and cold-resumes through a workspace symlink after %s compaction",
    async (boundary) => {
      const requests: JsonObject[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          expect(request.headers.get("authorization")).toBe("Bearer test-proxy-grant");
          const body: unknown = await request.json();
          if (!isJsonObject(body)) throw new Error("Invalid mock model request.");
          requests.push(body);
          expect(JSON.stringify(body["messages"])).toContain("mosoo-pi-test-instructions");
          if (requests.length === 1)
            return response(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "write-proof",
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({ path: "proof.txt", content: "pi-proof" }),
                    },
                  },
                ],
              },
              "tool_calls",
            );
          return response({
            role: "assistant",
            content:
              requests.length === 2 ? "File created.\u2028Complete." : "Remembered pi-proof.",
          });
        },
      });
      cleanup.push(async () => {
        await server.stop(true);
      });
      const input = await payloadFor(`http://127.0.0.1:${server.port}/v1`);
      const alias = `${input.execution.session.cwd}-alias`;
      await symlink(input.execution.session.cwd, alias, "dir");
      cleanup.push(() => rm(alias));
      const payload = {
        ...input,
        execution: {
          ...input.execution,
          session: { ...input.execution.session, cwd: alias },
        },
      };
      const first = harness(payload);
      await first.backend.start(first.context, AbortSignal.timeout(20_000));
      await first.backend.handleInput(
        first.context,
        { text: "Write proof.txt." },
        DRIVER_TEST_IDS.runId,
      );
      expect(await readFile(join(payload.execution.session.cwd, "proof.txt"), "utf8")).toBe(
        "pi-proof",
      );
      expect(first.permissions).toEqual(["write"]);
      expect(first.events.some((event) => event.kind === "file.change.updated")).toBe(true);
      expect(first.events.filter((event) => event.kind === "run.completed")).toHaveLength(1);
      const completed = first.events.find((event) => event.kind === "run.completed")!;
      expect(completed.payload).toMatchObject({ finalMessageText: "File created.\u2028Complete." });
      const resume = first.events.findLast((event) => event.kind === "runtime.resume.updated")!;
      if (!isJsonObject(resume.payload) || typeof resume.payload["resumePointer"] !== "string")
        throw new Error("No Pi resume pointer.");
      const pointer = resume.payload["resumePointer"];
      await first.backend.stop(first.context, "cold", AbortSignal.timeout(10_000));
      const transcript = join(payload.execution.session.homePath, "pi", pointer);
      const transcriptRecords = (await readFile(transcript, "utf8")).trim().split("\n");
      const firstEntry: unknown = JSON.parse(transcriptRecords[1]!);
      const leaf: unknown = JSON.parse(transcriptRecords.at(-1)!);
      if (!isJsonObject(firstEntry)) throw new Error("No Pi root entry.");
      if (!isJsonObject(leaf)) throw new Error("No Pi leaf.");
      // Native metadata and a fork from an earlier entry remain valid: ancestry
      // is a tree, not a requirement that every entry follows the preceding line.
      for (const entry of [
        { type: "custom", id: "unused-branch", customType: "test.marker", data: { proof: true } },
        { type: "session_info", id: "active-branch", name: "Restored branch" },
      ]) {
        await appendFile(
          transcript,
          `${JSON.stringify({ ...entry, parentId: leaf["id"], timestamp: new Date().toISOString() })}\n`,
        );
      }
      await appendFile(
        transcript,
        `${JSON.stringify({
          type: "compaction",
          id: "compacted",
          parentId: "active-branch",
          timestamp: new Date().toISOString(),
          summary: "We wrote proof.txt containing pi-proof.",
          tokensBefore: 123,
          firstKeptEntryId: boundary === "ancestor" ? firstEntry["id"] : "compacted",
        })}\n`,
      );
      const continuationEntries = [
        {
          type: "branch_summary",
          id: "branch-summary",
          parentId: "compacted",
          fromId: "historical-branch",
          summary: "kept-branch-context",
        },
        {
          type: "custom_message",
          id: "custom-context",
          parentId: "branch-summary",
          customType: "test",
          content: "kept-custom-context",
          display: false,
        },
        {
          type: "message",
          id: "editable",
          parentId: "custom-context",
          message: { role: "user", content: "obsolete-context", timestamp: Date.now() },
        },
        {
          type: "context_edit",
          id: "replacement",
          parentId: "editable",
          targetId: "editable",
          replacement: { content: "edited-context" },
        },
        {
          type: "custom_message",
          id: "deletable",
          parentId: "replacement",
          customType: "test",
          content: "removed-context",
          display: false,
        },
        {
          type: "context_edit",
          id: "removal",
          parentId: "deletable",
          targetId: "deletable",
          replacement: null,
        },
      ];
      for (const entry of continuationEntries) {
        await appendFile(
          transcript,
          `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`,
        );
      }
      const second = harness({
        ...payload,
        execution: {
          ...payload.execution,
          session: {
            ...payload.execution.session,
            nativeResumeRef: { kind: "pi_session_path", runtimeId: "pi", value: pointer },
            nativeResumeRequired: true,
          },
        },
      });
      await second.backend.start(second.context, AbortSignal.timeout(20_000));
      await second.backend.handleInput(
        second.context,
        { text: "What did you write?" },
        DRIVER_TEST_IDS.secondRunId,
      );
      expect(JSON.stringify(requests.at(-1))).toContain("pi-proof");
      expect(JSON.stringify(requests.at(-1))).toContain("kept-branch-context");
      expect(JSON.stringify(requests.at(-1))).toContain("kept-custom-context");
      expect(JSON.stringify(requests.at(-1))).toContain("edited-context");
      expect(JSON.stringify(requests.at(-1))).not.toContain("obsolete-context");
      expect(JSON.stringify(requests.at(-1))).not.toContain("removed-context");
      expect(
        second.events.find((event) => event.kind === "runtime.resume.updated")?.payload,
      ).toMatchObject({ resumePointer: pointer });
    },
    60_000,
  );

  test("rejects a tool through the mosoo permission port before it changes a file", async () => {
    let calls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        ++calls === 1
          ? response(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "blocked-write",
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({ path: "blocked.txt", content: "no" }),
                    },
                  },
                ],
              },
              "tool_calls",
            )
          : response({ role: "assistant", content: "Permission rejected." }),
    });
    cleanup.push(async () => {
      await server.stop(true);
    });
    const payload = await payloadFor(`http://127.0.0.1:${server.port}/v1`);
    const run = harness(payload, "reject_once");
    await run.backend.start(run.context, AbortSignal.timeout(20_000));
    await run.backend.handleInput(
      run.context,
      { text: "Write blocked.txt." },
      DRIVER_TEST_IDS.runId,
    );
    expect(readFile(join(payload.execution.session.cwd, "blocked.txt"))).rejects.toThrow();
    expect(run.permissions).toEqual(["write"]);
  }, 45_000);

  test("fails restored startup for a missing native session instead of creating a new conversation", async () => {
    const payload = await payloadFor("http://127.0.0.1:1/v1");
    const run = harness({
      ...payload,
      execution: {
        ...payload.execution,
        session: {
          ...payload.execution.session,
          nativeResumeRef: {
            kind: "pi_session_path",
            runtimeId: "pi",
            value: "sessions/missing.jsonl",
          },
        },
      },
    });
    expect(run.backend.start(run.context, AbortSignal.timeout(10_000))).rejects.toThrow();
    expect(run.events.some((event) => event.kind === "runtime.resume.updated")).toBe(false);
    expect(() => resolvePiSessionPath("/home/session/pi", "../other/session.jsonl")).toThrow();
  });

  test("keeps final message content authoritative and exposes model errors", () => {
    const translator = new PiEventTranslator();
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    translator.translate({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "partial" },
    });
    const events = translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        stopReason: "error",
        errorMessage: "Provider unavailable.",
      },
    });
    expect(translator.finalMessage?.text).toBe("final");
    expect(translator.failure).toBe("Provider unavailable.");
    expect(events.find((event) => event.kind === "message.added")?.payload).toMatchObject({
      content: [{ type: "text", text: "final" }],
    });
  });
});
