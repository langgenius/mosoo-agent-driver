import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentDriverContext,
  type AgentDriverContext,
} from "../src/core/agent-driver-backend";
import { DriverTurnCancelledError } from "../src/core/driver-runtime-state";
import { createDisabledLogger } from "../src/observability";
import type { AgentDriverMaterializedSkill } from "../src/host-ports";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import type { DriverStartInput } from "../src/protocol/start";
import * as acpProcess from "../src/runtimes/acp/acp-agent-process";
import { AcpDriverBackend } from "../src/runtimes/acp/acp-driver-backend";
import { isRecord } from "../src/runtimes/acp/acp-types";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import { createBootstrapFixture } from "./fixtures/pi-acp/bootstrap";
import { adapter, waitFor } from "./fixtures/pi-acp/contract";
import { piInput } from "./fixtures/pi-acp/input";

const FAKE_PI = String.raw`
let buffer = "";
let pending = null;
let model = "other/default";
let thinking = "medium";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const configOptions = () => [
  { type: "select", id: "model", category: "model", name: "Model", currentValue: model,
    options: [{ value: "mosoo/model-1", name: "Model" }] },
  { type: "select", id: "thought_level", category: "thought_level", name: "Thinking", currentValue: thinking,
    options: [{ value: "off", name: "Off" }, { value: "high", name: "High" }] },
];
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    let result = {};
    if (message.method === "initialize") result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    if (message.method === "session/new" || message.method === "session/load") {
      if (message.method === "session/load") send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "pi-native-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAY-MUST-BE-SUPPRESSED" } },
      } });
      result = { sessionId: "pi-native-session", configOptions: configOptions() };
    }
    if (message.method === "session/set_config_option") {
      if (message.params.configId === "model") model = message.params.value;
      if (message.params.configId === "thought_level") thinking = message.params.value;
      result = { configOptions: configOptions() };
    }
    if (message.method === "session/prompt") {
      if (model !== "mosoo/model-1" || thinking !== "off") throw new Error("unconfigured prompt");
      if (message.params.prompt[0]?.text === "wait") {
        pending = message.id;
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "pi-native-session", update: { sessionUpdate: "session_info_update", title: "waiting-for-cancel" },
        } });
        continue;
      }
      if (["provider-error", "max-tokens"].includes(message.params.prompt[0]?.text)) {
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "pi-native-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PI_PARTIAL_OUTPUT" } },
        } });
        if (message.params.prompt[0]?.text === "provider-error") {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Provider HTTP 500 after successful tool", data: { reason: "provider_error" } } });
        } else send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "max_tokens" } });
        continue;
      }
      if (message.params.prompt[0]?.text !== "hello") throw new Error("synthetic bootstrap prompt");
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "pi-native-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello response" } },
      } });
      result = { stopReason: "end_turn" };
    }
    if (message.method === "session/cancel" && pending !== null) {
      send({ jsonrpc: "2.0", id: pending, result: { stopReason: "cancelled" } });
      pending = null;
    }
    if ("id" in message) send({ jsonrpc: "2.0", id: message.id, result });
  }
});
`;

function createContextHarness({
  skills = [],
  clearOnTerminal = false,
}: {
  skills?: readonly AgentDriverMaterializedSkill[];
  clearOnTerminal?: boolean;
} = {}) {
  const events: DriverEventInput[] = [];
  let seq = 0;
  let activeRunId: RunId | null = null;
  return {
    events,
    contextFor: (payload: DriverStartInput) =>
      createAgentDriverContext({
        payload,
        logger: createDisabledLogger(),
        permission: { request: async () => "reject_once" },
        ports: { skill: { materialize: async () => skills } },
        eventSink: {
          currentRunId: () => activeRunId,
          pushEvents: async ({ events: batch }) => {
            events.push(...batch);
            if (
              clearOnTerminal &&
              batch.some((event) =>
                ["run.completed", "run.cancelled", "run.failed"].includes(event.kind),
              )
            )
              activeRunId = null;
            return {
              accepted: batch.map((event) => ({
                eventId: event.sourceEventId ?? event.id!,
                seq: ++seq,
                type: event.kind,
              })),
            };
          },
        },
      }),
    run(
      backend: AcpDriverBackend,
      context: AgentDriverContext,
      text: string,
      runId: RunId = DRIVER_TEST_IDS.runId,
      attachmentIds?: readonly string[],
    ) {
      activeRunId = runId;
      return backend.handleInput(context, { text, attachmentIds }, runId);
    },
  };
}

async function createHarness(options: { clearOnTerminal?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-acp-driver-"));
  const input = piInput({
    model: "model-1",
    session: { cwd: root, homePath: join(root, "home"), sharedRootPath: root },
  });
  const payload: DriverStartInput = {
    ...input,
    execution: {
      ...input.execution,
      systemPrompt: "Native instructions only; never send a bootstrap prompt.",
      builtInTools: [],
      providerOptions: { pi: { thinkingLevel: "off" } },
    },
  };
  const state = createContextHarness(options);
  const context = state.contextFor(payload);
  const launches: Array<{
    command?: string;
    args?: readonly string[];
    env: Record<string, string>;
  }> = [];
  const backend = new AcpDriverBackend(payload);
  const originalStart = acpProcess.startAcpAgentProcess;
  const spawn = spyOn(acpProcess, "startAcpAgentProcess").mockImplementation(
    async (context, payload, env, signal, options) => {
      launches.push({ ...options, env });
      return originalStart(context, payload, env, signal, {
        command: process.execPath,
        args: ["-e", FAKE_PI],
      });
    },
  );
  return {
    backend,
    context,
    events: state.events,
    launches,
    root,
    run(text: string, attachmentIds?: readonly string[]) {
      return state.run(backend, context, text, DRIVER_TEST_IDS.runId, attachmentIds);
    },
    async destroy() {
      try {
        await backend.stop(context, "test cleanup", new AbortController().signal);
      } finally {
        spawn.mockRestore();
        await rm(root, { force: true, recursive: true });
      }
    },
  };
}

// The shared ACP filesystem boundary intentionally requires Linux /proc.
describe.skipIf(process.platform !== "linux")(
  "Pi shared ACP backend (Linux /proc required)",
  () => {
    test("Given hostile fallback launch settings, when Pi starts, then its identity and fixed launcher stay isolated and native bootstrap adds no prompt", async () => {
      const previousCommand = process.env["MOSOO_ACP_FALLBACK_COMMAND"];
      const previousArgs = process.env["MOSOO_ACP_FALLBACK_ARGS"];
      process.env["MOSOO_ACP_FALLBACK_COMMAND"] = "opencode";
      process.env["MOSOO_ACP_FALLBACK_ARGS"] = "invalid JSON ignored by Pi";
      const harness = await createHarness();
      try {
        expect(harness.backend.runtime).toBe("pi-acp");
        await harness.backend.start(harness.context, new AbortController().signal);
        expect(harness.launches[0]).toMatchObject({
          command: "/usr/local/bin/pi-acp",
          args: [],
          env: {
            HOME: join(harness.root, "home/pi-acp"),
            PI_CODING_AGENT_DIR: join(harness.root, "home/pi-acp/.pi/agent"),
            PI_ACP_PI_COMMAND: "/usr/local/bin/mosoo-pi",
          },
        });
        expect(harness.launches[0]?.env["OPENCODE_CONFIG_CONTENT"]).toBeUndefined();
        await harness.run("hello");
        expect(harness.events.some((event) => event.kind === "run.completed")).toBe(true);
      } finally {
        if (previousCommand === undefined) delete process.env["MOSOO_ACP_FALLBACK_COMMAND"];
        else process.env["MOSOO_ACP_FALLBACK_COMMAND"] = previousCommand;
        if (previousArgs === undefined) delete process.env["MOSOO_ACP_FALLBACK_ARGS"];
        else process.env["MOSOO_ACP_FALLBACK_ARGS"] = previousArgs;
        await harness.destroy();
      }
    });

    for (const outcome of ["provider-error", "max-tokens"] as const) {
      test(`Given partial Pi output and ${outcome}, When the authoritative sink clears the run on terminal, Then one failed terminal retains its classification`, async () => {
        const harness = await createHarness({ clearOnTerminal: true });
        try {
          await harness.backend.start(harness.context, new AbortController().signal);
          const rejection = await harness.run(outcome).then(
            () => null,
            (error: unknown) => error,
          );
          const terminals = harness.events.filter((event) =>
            ["run.completed", "run.cancelled", "run.failed"].includes(event.kind),
          );
          expect(terminals.map((event) => event.kind)).toEqual(["run.failed"]);
          expect(terminals[0]?.runId).toBe(DRIVER_TEST_IDS.runId);
          expect(JSON.stringify(terminals[0]?.payload)).toMatch(
            outcome === "provider-error"
              ? /provider|HTTP 500|ACPRequestError/i
              : /max_tokens|token|truncat/i,
          );
          expect(rejection).toBeInstanceOf(Error);
          expect(JSON.stringify(harness.events)).toContain("PI_PARTIAL_OUTPUT");
        } finally {
          await harness.destroy();
        }
      });
    }

    test("Given Pi text-only capabilities, When input references an image attachment, Then reject before prompting the provider", async () => {
      const harness = await createHarness();
      try {
        await harness.backend.start(harness.context, new AbortController().signal);
        await expect(harness.run("hello", ["image-fixture"])).rejects.toThrow("text-only");
        expect(harness.events.some((event) => event.kind === "run.completed")).toBe(false);
      } finally {
        await harness.destroy();
      }
    });

    test("Given a Pi adapter with load but no resume, when an admitted turn is cancelled, then recycle loads and reconfigures without replaying history", async () => {
      const harness = await createHarness();
      try {
        await harness.backend.start(harness.context, new AbortController().signal);
        const turn = harness.run("wait").then(
          () => null,
          (error: unknown) => error,
        );
        await waitFor(
          () => JSON.stringify(harness.events).includes("waiting-for-cancel"),
          "Pi prompt admission",
          2_000,
        );
        expect(JSON.stringify(harness.events)).toContain("waiting-for-cancel");
        await harness.backend.cancelActiveTurn(harness.context, "test cancel");
        expect(await turn).toBeInstanceOf(DriverTurnCancelledError);
        expect(harness.launches).toHaveLength(2);
        expect(harness.events.some((event) => event.kind === "run.cancelled")).toBe(true);
        expect(JSON.stringify(harness.events)).not.toContain("REPLAY-MUST-BE-SUPPRESSED");
      } finally {
        await harness.destroy();
      }
    });
  },
);

test.skipIf(process.platform !== "linux" || process.env["PI_ACP_PINNED_CONTRACT"] !== "1")(
  "Given the real pinned Pi adapter, When Driver starts then cold restores a turn with native bash, Then Linux bootstrap, native ToolCall lifecycle, and anonymous final output survive without replay",
  async () => {
    const fixture = await createBootstrapFixture();
    const state = createContextHarness({
      skills: [fixture.materializedSkill],
      clearOnTerminal: true,
    });
    const { events, contextFor } = state;
    let payload: DriverStartInput = {
      ...fixture.payload,
      execution: {
        ...fixture.payload.execution,
        systemPrompt: "PI_DRIVER_FIRST_INSTRUCTIONS",
        skillCatalog: [
          {
            frontmatter: { author: null, description: "Use bootstrap-skill", version: null },
            mountPath: fixture.materializedSkill.mountPath,
            resolutionMode: "explicit",
            skillId: fixture.materializedSkill
              .skillId as DriverStartInput["execution"]["skillCatalog"][number]["skillId"],
            skillName: fixture.materializedSkill.skillName,
          },
        ],
      },
    };
    let context = contextFor(payload);
    let backend = new AcpDriverBackend(payload);
    const originalStart = acpProcess.startAcpAgentProcess;
    const launch = spyOn(acpProcess, "startAcpAgentProcess").mockImplementation(
      (context, payload, env, signal, options) => {
        expect(options).toEqual({ command: "/usr/local/bin/pi-acp", args: [] });
        // Replace only executable resolution and test isolation paths. Bootstrap,
        // model selection, translation and process supervision use the real Driver.
        return originalStart(
          context,
          payload,
          {
            ...env,
            PATH: fixture.env["PATH"]!,
            TMPDIR: fixture.env["TMPDIR"]!,
            PI_ACP_PI_COMMAND: fixture.env["PI_ACP_PI_COMMAND"]!,
            NODE_OPTIONS: fixture.env["NODE_OPTIONS"]!,
            PI_CONTRACT_NETWORK_LOG: fixture.networkLog,
          },
          signal,
          { command: join(fixture.bin, "node"), args: [adapter] },
        );
      },
    );
    try {
      await fixture.materialize("FIRST");
      await backend.start(context, new AbortController().signal);
      expect((await stat(join(fixture.agentDir, "models.json"))).mode & 0o777).toBe(0o600);
      expect(fixture.requests).toHaveLength(0);
      fixture.steps.push(
        { tools: [{ name: "bash", arguments: { command: "printf PI_DRIVER_NATIVE_TOOL" } }] },
        { text: "PI_DRIVER_FIRST_DONE" },
      );
      await state.run(backend, context, "First text-only turn");
      expect(events.filter((event) => event.kind === "run.completed")).toHaveLength(1);
      expect(JSON.stringify(events)).toContain("PI_DRIVER_FIRST_DONE");
      const toolUpdates = events.filter((event) => event.kind === "tool.call.updated");
      expect(
        toolUpdates.some(
          (event) => isRecord(event.payload) && event.payload["status"] === "running",
        ),
      ).toBe(true);
      const completedTool = toolUpdates.find(
        (event) => isRecord(event.payload) && event.payload["status"] === "completed",
      );
      expect(completedTool?.runId).toBe(DRIVER_TEST_IDS.runId);
      expect(completedTool?.payload).toMatchObject({ kind: "execute" });
      expect(JSON.stringify(toolUpdates)).toContain("PI_DRIVER_NATIVE_TOOL");
      const toolCallId = isRecord(completedTool?.payload)
        ? completedTool.payload["toolCallId"]
        : undefined;
      expect(typeof toolCallId).toBe("string");
      expect(
        events.some(
          (event) =>
            event.kind === "item.completed" &&
            isRecord(event.payload) &&
            event.payload["itemId"] === toolCallId &&
            event.payload["itemType"] === "tool_call" &&
            isRecord(event.payload) &&
            event.payload["status"] === "completed",
        ),
      ).toBe(true);

      expect(
        events.filter((event) => event.kind === "usage.updated").at(-1)?.payload,
      ).toMatchObject({
        used: 18,
        size: 128_000,
        source: "session_update",
      });
      const pointerPayload = events.find(
        (event) => event.kind === "runtime.resume.updated",
      )?.payload;
      const pointer = isRecord(pointerPayload) ? pointerPayload["resumePointer"] : undefined;
      if (typeof pointer !== "string") throw new Error("Missing Pi native session pointer");
      await backend.stop(context, "cold continuation", new AbortController().signal);
      await fixture.materialize("COLD");
      payload = {
        ...payload,
        execution: {
          ...payload.execution,
          systemPrompt: "PI_DRIVER_COLD_INSTRUCTIONS",
          session: {
            ...payload.execution.session,
            nativeResumeRef: { runtimeId: "pi-acp", kind: "acp_session_id", value: pointer },
          },
        },
      };
      context = contextFor(payload);
      backend = new AcpDriverBackend(payload);
      const beforeRestore = events.length;
      await backend.start(context, new AbortController().signal);
      expect(JSON.stringify(events.slice(beforeRestore))).not.toContain("PI_DRIVER_FIRST_DONE");
      fixture.steps.push({ text: "PI_DRIVER_COLD_DONE" });
      await state.run(backend, context, "Cold text-only turn", DRIVER_TEST_IDS.secondRunId);
      expect(events.filter((event) => event.kind === "run.completed")).toHaveLength(2);
      expect(fixture.requests).toHaveLength(3);
      expect(JSON.stringify(fixture.requests[0]?.messages)).toContain(
        "PI_DRIVER_FIRST_INSTRUCTIONS",
      );
      expect(JSON.stringify(fixture.requests[2]?.messages)).toContain(
        "PI_DRIVER_COLD_INSTRUCTIONS",
      );
      expect(JSON.stringify(fixture.requests[2]?.messages)).toContain("PI_DRIVER_FIRST_DONE");
      expect(fixture.errors).toEqual([]);
    } finally {
      try {
        await backend.stop(context, "test cleanup", new AbortController().signal);
      } finally {
        launch.mockRestore();
        await fixture.cleanup();
      }
    }
  },
  60_000,
);
