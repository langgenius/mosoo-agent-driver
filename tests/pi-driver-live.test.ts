import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDriverId } from "../src/protocol/id";
import {
  DriverArtifactTestController,
  expectedDriverCapabilities,
} from "./driver-artifact-test-controller";
import type { DriverArtifactTestEvent } from "./driver-artifact-test-controller";
import { driverBootPayload } from "./driver-boot-payload-fixture";

// Explicitly opt in: these tests make billable requests to the first-party API.
// The local forwarder certifies the Driver/Pi wire, not hosted Worker/D1 behavior.
const enabled = process.env["AGENT_DRIVER_PI_LIVE"] === "1";
const liveTest = enabled ? test : test.skip;
const key = process.env["DEEPSEEK_API_KEY"]?.trim() ?? "";
const modelId = process.env["AGENT_DRIVER_PI_LIVE_MODEL"] ?? "deepseek-flash";
const artifactPath =
  process.env["MOSOO_PI_TEST_ARTIFACT"] ??
  fileURLToPath(new URL("../dist/driver.mjs", import.meta.url));
const cli =
  process.env["MOSOO_PI_TEST_CLI"] ??
  join(
    dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
    "bundle",
    "cli.js",
  );
const TURN_TIMEOUT = 120_000;

if (enabled && (!key || !existsSync(artifactPath))) {
  throw new Error("Pi live tests require DEEPSEEK_API_KEY and a built Driver artifact.");
}

async function fixture(policy: "full_access" | "supervised" = "full_access") {
  const root = await mkdtemp(join(tmpdir(), "mosoo-pi-live-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const grant = randomUUID();
  const mcpGrant = randomUUID();
  const mcpProof = `server-proof-${randomUUID()}`;
  const mcpMarker = `marker-${randomUUID()}`;
  const requests: { model: unknown; status: number; messages: unknown }[] = [];
  let mcpCalls = 0;
  let unauthorized = 0;
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/v1/chat/completions" ||
        request.headers.get("authorization") !== `Bearer ${grant}`
      ) {
        unauthorized++;
        return new Response(null, { status: 401 });
      }
      // Keep live acceptance bounded even if the model unexpectedly loops.
      if (requests.length >= 16) return new Response("Live request limit", { status: 429 });
      const body = await request.text();
      const parsed = JSON.parse(body) as { model: unknown; messages: unknown; max_tokens?: number };
      expect(parsed.model).toBe(modelId);
      expect(parsed.max_tokens).toBeLessThanOrEqual(2048);
      const observed = { model: parsed.model, status: 0, messages: parsed.messages };
      requests.push(observed);
      console.log(`Pi live: upstream request ${requests.length}`);
      const upstream = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal: request.signal,
        redirect: "error",
      });
      observed.status = upstream.status;
      console.log(`Pi live: upstream status ${upstream.status}`);
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream" },
      });
    },
  });
  const mcp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("authorization") !== `Bearer ${mcpGrant}`) {
        unauthorized++;
        return new Response(null, { status: 401 });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const rpc = (await request.json()) as {
        id?: string | number;
        method: string;
        params?: { protocolVersion?: string; name?: string; arguments?: { marker?: string } };
      };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      let result: object = {};
      if (rpc.method === "initialize") {
        result = {
          protocolVersion: rpc.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "pi-live-marker", version: "1" },
        };
      } else if (rpc.method === "tools/list") {
        result = {
          tools: [
            {
              name: "record_marker",
              description: "Record a marker and return a server-generated proof.",
              inputSchema: {
                type: "object",
                properties: { marker: { type: "string" } },
                required: ["marker"],
                additionalProperties: false,
              },
            },
          ],
        };
      } else if (rpc.method === "tools/call") {
        expect(rpc.params?.name).toBe("record_marker");
        expect(rpc.params?.arguments).toEqual({ marker: mcpMarker });
        mcpCalls++;
        result = { content: [{ type: "text", text: mcpProof }] };
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    },
  });
  const controllers: DriverArtifactTestController[] = [];
  return {
    root,
    home,
    workspace,
    requests,
    mcpProof,
    mcpMarker,
    get mcpCalls() {
      return mcpCalls;
    },
    async start(pointer: string | null = null) {
      const controller = await DriverArtifactTestController.start({
        artifactPath,
        bootPayload: {
          ...driverBootPayload,
          driverInstanceId: createDriverId(),
          runtime: "pi",
          runtimeTransport: "pi-rpc",
          execution: {
            ...driverBootPayload.execution,
            configRevision: { ...driverBootPayload.execution.configRevision, runId: null },
            provider: "deepseek",
            model: modelId,
            permissionPolicy: policy,
            profilePrompt:
              "Follow the exact requested tool and reply. After a rejected tool, do not retry or use another tool.",
            environment: {
              variables: {
                MOSOO_PI_PROXY_GRANT: grant,
                MOSOO_PI_CONFIG_CONTENT: JSON.stringify({
                  providers: {
                    mosoo: {
                      api: "openai-completions",
                      baseUrl: `http://127.0.0.1:${proxy.port}/v1`,
                      apiKey: "${MOSOO_PI_PROXY_GRANT}",
                      compat: {
                        supportsStore: false,
                        supportsDeveloperRole: false,
                        supportsReasoningEffort: false,
                        maxTokensField: "max_tokens",
                        requiresReasoningContentOnAssistantMessages: true,
                        thinkingFormat: "deepseek",
                      },
                      models: [{ id: modelId, maxTokens: 2048 }],
                    },
                  },
                }),
              },
            },
            session: {
              ...driverBootPayload.execution.session,
              cwd: workspace,
              nativeResumeRef:
                pointer === null
                  ? null
                  : {
                      runtimeId: "pi",
                      kind: "pi_session_path",
                      value: pointer,
                    },
              context: {
                ...driverBootPayload.execution.session.context,
                homePath: home,
                sessionOrganizationPath: workspace,
              },
              mcpServers: [
                {
                  serverId: "01J00000000000000000000020",
                  name: "live_marker",
                  authType: "bearer",
                  authorizationState: "active",
                  credentialId: "01J00000000000000000000021",
                  credentialScope: "session",
                  credentialStatus: "active",
                  proxyGrantId: mcpGrant,
                  proxyUrl: `http://127.0.0.1:${mcp.port}/mcp`,
                },
              ],
            },
          },
        },
        env: {
          DEEPSEEK_API_KEY: "",
          OPENAI_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          OPENROUTER_API_KEY: "",
          MOSOO_PI_EXECUTABLE: "node",
          MOSOO_PI_ARGS: JSON.stringify([cli]),
        },
        expectedCapabilities: expectedDriverCapabilities("pi"),
        organizationPath: workspace,
        rootPath: root,
        forbiddenSecrets: [key, grant, mcpGrant],
        startTimeoutMs: 30_000,
      });
      controllers.push(controller);
      return controller;
    },
    async dispose() {
      for (const controller of controllers) await controller.dispose();
      await proxy.stop(true);
      await mcp.stop(true);
      expect(unauthorized).toBe(0);
      expect(requests.every((request) => request.status === 200)).toBe(true);
      const usage = controllers
        .flatMap((controller) => controller.events)
        .filter((event) => event.kind === "usage.updated")
        .map((event) => payload(event));
      console.log(
        JSON.stringify({
          model: modelId,
          upstreamRequests: requests.length,
          mcpCalls,
          inputTokens: usage.reduce((sum, item) => sum + Number(item["inputTokens"] ?? 0), 0),
          outputTokens: usage.reduce((sum, item) => sum + Number(item["outputTokens"] ?? 0), 0),
          cachedReadTokens: usage.reduce(
            (sum, item) => sum + Number(item["cachedReadTokens"] ?? 0),
            0,
          ),
        }),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

function begin(controller: DriverArtifactTestController, text: string) {
  const turn = {
    commandId: createDriverId(),
    requestId: createDriverId(),
    runId: createDriverId(),
    eventIndex: controller.events.length,
  };
  controller.enqueue({ ...turn, kind: "input.start", input: { text } });
  return turn;
}

async function completed(controller: DriverArtifactTestController, turn: ReturnType<typeof begin>) {
  const [update, terminal] = await Promise.all([
    controller.waitForCommandTerminal(turn.commandId, TURN_TIMEOUT),
    controller.waitForEvent(
      (event) =>
        event.runId === turn.runId && /^run\.(completed|failed|cancelled)$/.test(event.kind),
      turn.eventIndex,
      TURN_TIMEOUT,
      "Pi live turn terminal",
    ),
  ]);
  if (update.status !== "completed" || terminal.kind !== "run.completed") {
    throw new Error(`Pi live turn failed. ${controller.diagnostics()}`);
  }
  const events = controller
    .eventsSince(turn.eventIndex)
    .filter((event) => event.runId === turn.runId);
  expect(
    events.filter((event) => /^run\.(completed|failed|cancelled)$/.test(event.kind)),
  ).toHaveLength(1);
  expect(events.some((event) => event.kind === "message.delta")).toBe(true);
  const usage = events.filter((event) => event.kind === "usage.updated");
  expect(usage.length).toBeGreaterThan(0);
  expect(usage.some((event) => Number(payload(event)["outputTokens"]) > 0)).toBe(true);
  expect(
    usage.some(
      (event) =>
        Number(payload(event)["inputTokens"]) + Number(payload(event)["cachedReadTokens"]) > 0,
    ),
  ).toBe(true);
  expect(payload(terminal)["finalMessageText"]).toBeTruthy();
  return events;
}

function payload(event: DriverArtifactTestEvent | undefined): Record<string, unknown> {
  if (event === undefined) return {};
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new Error(`Invalid ${event.kind} payload.`);
  }
  return event.payload as Record<string, unknown>;
}

function finalText(events: readonly DriverArtifactTestEvent[]): string {
  const text = payload(events.find((event) => event.kind === "run.completed"))["finalMessageText"];
  if (typeof text !== "string") throw new Error("Pi live run has no final text.");
  return text;
}

function processState(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    if (!state || state.length !== 1) throw new Error("Invalid Linux process state.");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function exited(state: string): boolean {
  // An exited zombie cannot execute; container init owns orphan reaping.
  return state === "missing" || state === "Z" || state === "X";
}

liveTest(
  "Pi live artifact: write, streaming/usage, multi-turn memory, native cold restart, authenticated MCP",
  async () => {
    const run = await fixture();
    try {
      const token = `memory-${randomUUID()}`;
      const proof = `file-${randomUUID()}`;
      const first = await run.start();
      const events = await completed(
        first,
        begin(
          first,
          `Remember the conversation-only token ${token}. Do not put it in any file. Use the write tool exactly once to write proof.txt containing exactly ${proof}. Reply only WROTE.`,
        ),
      );
      expect(await readFile(join(run.workspace, "proof.txt"), "utf8")).toBe(proof);
      expect(events.some((event) => event.kind === "file.change.updated")).toBe(true);
      expect(events.some((event) => event.kind === "permission.requested")).toBe(false);
      console.log("Pi live: real file write and streaming usage passed");
      expect(
        finalText(
          await completed(
            first,
            begin(
              first,
              "Without tools, reply only with the conversation-only token I asked you to remember.",
            ),
          ),
        ),
      ).toBe(token);
      const pointer = payload(
        first.events.toReversed().find((event) => event.kind === "runtime.resume.updated"),
      )["resumePointer"];
      expect(typeof pointer).toBe("string");
      console.log("Pi live: same-process memory passed; stopping first Driver");
      await first.stopDriver(createDriverId(), 15_000);
      const resumed = await run.start(String(pointer));
      const restored = await completed(
        resumed,
        begin(
          resumed,
          "Without tools, reply only with the conversation-only token I asked you to remember earlier.",
        ),
      );
      expect(finalText(restored)).toBe(token);
      expect(
        payload(restored.find((event) => event.kind === "runtime.resume.updated"))["resumePointer"],
      ).toBe(pointer);
      console.log("Pi live: multi-turn memory and native cold restart passed");
      const mcpEvents = await completed(
        resumed,
        begin(
          resumed,
          `Call the record_marker tool from the live_marker MCP server exactly once with ${JSON.stringify({ marker: run.mcpMarker })}. Do not use other tools. Reply only with the server's returned text.`,
        ),
      );
      expect(finalText(mcpEvents)).toBe(run.mcpProof);
      expect(run.mcpCalls).toBe(1);
      const config = await readFile(join(run.home, "pi", "models.json"), "utf8");
      expect(config).not.toContain(key);
      expect(config).toContain("${MOSOO_PI_PROXY_GRANT}");
      await resumed.stopDriver(createDriverId(), 15_000);
      console.log("Pi live: authenticated MCP and credential isolation passed");
    } finally {
      await run.dispose();
    }
  },
  600_000,
);

liveTest(
  "Pi live artifact: supervised tool approval and rejection",
  async () => {
    const run = await fixture("supervised");
    try {
      const controller = await run.start();
      for (const decision of ["allow_once", "reject_once"] as const) {
        const filename = `${decision}.txt`;
        const turn = begin(
          controller,
          `Use the write tool exactly once to write ${filename} containing exactly permission-proof. If rejected, do not retry or use other tools. Reply only DONE after success or DENIED after rejection.`,
        );
        const permission = await controller.waitForEvent(
          (event) =>
            event.runId === turn.runId &&
            (event.kind === "permission.requested" || /^run\.(completed|failed)$/.test(event.kind)),
          turn.eventIndex,
          TURN_TIMEOUT,
          "Pi live permission request",
        );
        expect(permission.kind).toBe("permission.requested");
        expect(existsSync(join(run.workspace, filename))).toBe(false);
        const resolveId = createDriverId();
        controller.enqueue({
          commandId: resolveId,
          kind: "permission.resolve",
          requestId: payload(permission)["requestId"],
          decision,
        });
        expect((await controller.waitForCommandTerminal(resolveId, 15_000)).status).toBe(
          "completed",
        );
        const events = await completed(controller, turn);
        expect(events.filter((event) => event.kind === "permission.requested")).toHaveLength(1);
        expect(events.filter((event) => event.kind === "permission.resolved")).toHaveLength(1);
        if (decision === "allow_once") {
          expect(await readFile(join(run.workspace, filename), "utf8")).toBe("permission-proof");
        } else {
          expect(existsSync(join(run.workspace, filename))).toBe(false);
          expect(finalText(events)).toBe("DENIED");
        }
        console.log(`Pi live: supervised ${decision} passed`);
      }
      await controller.stopDriver(createDriverId(), 15_000);
    } finally {
      await run.dispose();
    }
  },
  360_000,
);

test.skipIf(!enabled || process.platform !== "linux")(
  "Pi live artifact: cancel native Bash tree and continue",
  async () => {
    const run = await fixture();
    try {
      await writeFile(
        join(run.workspace, "long-tool.sh"),
        "echo $$ > shell.pid\nsleep 30 &\nworker=$!\necho $worker > worker.pid\nwait $worker && echo escaped > escaped.txt\n",
      );
      const controller = await run.start();
      const turn = begin(
        controller,
        "Use bash to run exactly `sh ./long-tool.sh` now. Wait for the command before replying.",
      );
      const deadline = Date.now() + TURN_TIMEOUT;
      while (!existsSync(join(run.workspace, "worker.pid"))) {
        controller.assertHealthy("live Bash startup");
        if (Date.now() >= deadline) throw new Error("Pi live Bash tool did not start.");
        await Bun.sleep(50);
      }
      const pids = await Promise.all(
        ["shell.pid", "worker.pid"].map(async (name) =>
          Number((await readFile(join(run.workspace, name), "utf8")).trim()),
        ),
      );
      expect(pids.every((pid) => pid > 0 && !exited(processState(pid)))).toBe(true);
      let statesAtTerminal: readonly string[] = [];
      controller.observeEventIngress((event) => {
        if (event.runId === turn.runId && event.kind === "run.cancelled") {
          statesAtTerminal = pids.map(processState);
        }
      });
      const cancelId = createDriverId();
      controller.enqueue({ commandId: cancelId, kind: "turn.cancel", reason: "pi.live.cancel" });
      const [input, cancel] = await Promise.all([
        controller.waitForCommandTerminal(turn.commandId, 15_000),
        controller.waitForCommandTerminal(cancelId, 15_000),
        controller.waitForEvent(
          (event) => event.runId === turn.runId && event.kind === "run.cancelled",
          turn.eventIndex,
          15_000,
          "Pi live cancellation",
        ),
      ]);
      expect(input.status).toBe("cancelled");
      expect(cancel.status).toBe("completed");
      console.log(JSON.stringify({ cancelledToolStates: statesAtTerminal }));
      expect(statesAtTerminal).toHaveLength(pids.length);
      expect(statesAtTerminal.every(exited)).toBe(true);
      expect(pids.every((pid) => exited(processState(pid)))).toBe(true);
      expect(existsSync(join(run.workspace, "escaped.txt"))).toBe(false);
      const events = await completed(
        controller,
        begin(controller, "Do not use tools. Reply only CONTINUED."),
      );
      expect(finalText(events)).toBe("CONTINUED");
      expect(existsSync(join(run.workspace, "escaped.txt"))).toBe(false);
      await controller.stopDriver(createDriverId(), 15_000);
      console.log("Pi live: Bash tree cancellation and continuation passed");
    } finally {
      await run.dispose();
    }
  },
  360_000,
);
