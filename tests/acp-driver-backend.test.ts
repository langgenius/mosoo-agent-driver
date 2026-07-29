import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverBootPayload } from "../src/protocol/boot";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverHostIntegrationSnapshotFromBootExecution } from "../src/protocol/host-integration";
import type { RunId } from "../src/protocol/id";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { AcpDriverBackend } from "../src/runtimes/acp/acp-driver-backend";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { driverBootPayload, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

const FAKE_AGENT = String.raw`
const { appendFileSync, existsSync } = require("node:fs");
const logPath = process.env.TEST_LOG_PATH;
const openCodeConfigPath = process.env.TEST_OPENCODE_CONFIG_PATH;
const responsePath = process.env.TEST_RESPONSE_PATH;
const triggerPath = process.env.TEST_TRIGGER_PATH;
if (openCodeConfigPath) {
  appendFileSync(openCodeConfigPath, process.env.OPENCODE_CONFIG_CONTENT || "");
}
let buffer = "";
let sessionReady = false;
let updateSent = false;
let pendingPromptId = null;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const requestClient = (message) => {
  appendFileSync(logPath, message.method + "\n");
  send(message);
};
const handle = (message) => {
  if (!("method" in message)) {
    if (message.id === "nested-create") {
      if (message.result?.terminalId) {
        requestClient({
          id: "nested-wait",
          jsonrpc: "2.0",
          method: "terminal/wait_for_exit",
          params: {
            sessionId: "native-session-1",
            terminalId: message.result.terminalId,
          },
        });
      } else {
        appendFileSync(responsePath, JSON.stringify(message) + "\n");
      }
    } else if (message.id === "nested-wait") {
      appendFileSync(responsePath, JSON.stringify(message) + "\n");
    }
    return;
  }

  appendFileSync(logPath, message.method + "\n");
  if (message.method === "session/cancel" && pendingPromptId !== null) {
    send({ id: pendingPromptId, jsonrpc: "2.0", result: { stopReason: "cancelled" } });
    pendingPromptId = null;
    return;
  }
  if (!("id" in message)) return;
  let result;
  switch (message.method) {
    case "initialize":
      result = {
        agentCapabilities: { sessionCapabilities: { close: {} } },
        authMethods: [],
        protocolVersion: 1,
      };
      break;
    case "session/new":
      sessionReady = true;
      result = { sessionId: "native-session-1" };
      break;
    case "session/prompt":
      if (message.params.prompt[0]?.text === "hang") {
        pendingPromptId = message.id;
        return;
      }
      if (message.params.prompt[0]?.text === "nested-cancel") {
        pendingPromptId = message.id;
        requestClient({
          id: "nested-create",
          jsonrpc: "2.0",
          method: "terminal/create",
          params: {
            args: ["-e", "setInterval(() => {}, 1000)"],
            command: process.execPath,
            sessionId: "native-session-1",
          },
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native-session-1",
          update: {
            content: { text: "done", type: "text" },
            messageId: "assistant-1",
            sessionUpdate: "agent_message_chunk",
          },
        },
      });
      result = { stopReason: "end_turn" };
      break;
    case "session/close":
      if (process.env.TEST_HANG_CLOSE === "1") return;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native-session-1",
          update: { sessionUpdate: "usage_update", size: 20, used: 2 },
        },
      });
      result = {};
      break;
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
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {
  if (!sessionReady || updateSent || !existsSync(triggerPath)) return;
  updateSent = true;
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "native-session-1",
      update: { sessionUpdate: "usage_update", size: 10, used: 1 },
    },
  });
}, 5);
`;

async function createHarness(
  options: { readonly hangClose?: boolean; readonly openCodeInstructions?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "driver-acp-backend-"));
  const logPath = join(root, "methods.log");
  const openCodeConfigPath = join(root, "opencode-config.json");
  const responsePath = join(root, "responses.log");
  const triggerPath = join(root, "send-update");
  const command = options.openCodeInstructions ? join(root, "opencode") : process.execPath;

  if (options.openCodeInstructions) {
    await symlink(process.execPath, command);
  }

  const boot = {
    ...driverBootPayload,
    execution: {
      ...driverBootPayload.execution,
      environment: {
        variables: {
          ...(options.openCodeInstructions ? { OPENCODE_CONFIG_CONTENT: "{}" } : {}),
          TEST_LOG_PATH: logPath,
          TEST_OPENCODE_CONFIG_PATH: openCodeConfigPath,
          TEST_RESPONSE_PATH: responsePath,
          TEST_TRIGGER_PATH: triggerPath,
          TEST_HANG_CLOSE: options.hangClose ? "1" : "0",
        },
      },
      profilePrompt: options.openCodeInstructions ? "Always answer concisely." : "",
      session: {
        ...driverBootPayload.execution.session,
        context: {
          ...driverBootPayload.execution.session.context,
          homePath: join(root, "home"),
          sessionOrganizationPath: root,
        },
        cwd: root,
      },
    },
    runtime: "acp-fallback",
    runtimeTransport: "acp-fallback",
  } satisfies DriverBootPayload;
  const payload = createDriverStartInputFromBootPayload(boot);
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "acp-driver-backend-test",
    sink: async () => {},
  });
  let acceptedSeq = 0;
  const publishedEvents: DriverEventInput[] = [];
  let block: {
    readonly entered: ReturnType<typeof Promise.withResolvers<void>>;
    readonly kind: string;
    readonly release: ReturnType<typeof Promise.withResolvers<void>>;
  } | null = null;
  let failKind: string | null = null;
  const context = createAgentDriverContext({
    eventSink: {
      pushEvents: async ({ events }) => {
        if (failKind !== null && events.some((event) => event.kind === failKind)) {
          failKind = null;
          throw new Error("event sink unavailable");
        }

        const current = block;

        if (current !== null && events.some((event) => event.kind === current.kind)) {
          block = null;
          current.entered.resolve();
          await current.release.promise;
        }

        publishedEvents.push(...events);

        return {
          accepted: events.map((event) => ({ seq: ++acceptedSeq, type: event.kind })),
        };
      },
    },
    logger,
    payload,
    permission: { request: async () => "reject_once" },
    ports: {
      hostIntegration: {
        snapshot: async () => createDriverHostIntegrationSnapshotFromBootExecution(boot.execution),
      },
      skill: { materialize: async () => [] },
    },
  });
  const backend = new AcpDriverBackend(payload);
  const previousCommand = process.env["MOSOO_ACP_FALLBACK_COMMAND"];
  const previousArgs = process.env["MOSOO_ACP_FALLBACK_ARGS"];
  process.env["MOSOO_ACP_FALLBACK_COMMAND"] = command;
  process.env["MOSOO_ACP_FALLBACK_ARGS"] = JSON.stringify(["-e", FAKE_AGENT]);

  try {
    await backend.start(context, new AbortController().signal);
  } finally {
    if (previousCommand === undefined) {
      delete process.env["MOSOO_ACP_FALLBACK_COMMAND"];
    } else {
      process.env["MOSOO_ACP_FALLBACK_COMMAND"] = previousCommand;
    }

    if (previousArgs === undefined) {
      delete process.env["MOSOO_ACP_FALLBACK_ARGS"];
    } else {
      process.env["MOSOO_ACP_FALLBACK_ARGS"] = previousArgs;
    }
  }

  return {
    backend,
    blockNext(kind: string) {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      block = { entered, kind, release };
      return { entered: entered.promise, release: release.resolve };
    },
    context,
    async destroy() {
      block?.release.reject(new Error("test cleanup"));
      await backend.stop(context, "test cleanup", new AbortController().signal).catch(() => {});
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    },
    failNext(kind: string) {
      failKind = kind;
    },
    events: publishedEvents,
    async methods() {
      return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
    },
    async openCodeConfig() {
      return JSON.parse(await readFile(openCodeConfigPath, "utf8")) as {
        instructions?: unknown;
      };
    },
    async responses() {
      return (await readFile(responsePath, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    triggerPath,
  };
}

describe("ACP driver backend lifecycle", () => {
  test("uses OpenCode native instructions without a hidden bootstrap prompt", async () => {
    const harness = await createHarness({ openCodeInstructions: true });

    try {
      expect(await harness.methods()).not.toContain("session/prompt");
      const config = await harness.openCodeConfig();
      expect(config.instructions).toEqual([expect.any(String)]);
      const [instructionPath] = config.instructions as [string];
      expect(await readFile(instructionPath, "utf8")).toContain("Always answer concisely.");
    } finally {
      await harness.destroy();
    }
  });

  test("clears turn state when prompt-start publication fails", async () => {
    const harness = await createHarness();

    try {
      harness.failNext("run.started");
      await expect(
        harness.backend.handleInput(
          harness.context,
          { text: "first" },
          DRIVER_TEST_IDS.runId as RunId,
        ),
      ).rejects.toThrow("event sink unavailable");
      await expect(
        harness.backend.handleInput(
          harness.context,
          { text: "second" },
          DRIVER_TEST_IDS.secondRunId as RunId,
        ),
      ).resolves.toBeUndefined();
      expect(
        (await harness.methods()).filter((method) => method === "session/prompt"),
      ).toHaveLength(1);
    } finally {
      await harness.destroy();
    }
  });

  test("does not send a prompt after cancellation crosses the start boundary", async () => {
    const harness = await createHarness();

    try {
      const gate = harness.blockNext("run.started");
      const input = harness.backend.handleInput(
        harness.context,
        { text: "cancel me" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      await gate.entered;
      const cancel = harness.backend.cancelActiveTurn(harness.context, "test cancellation");
      gate.release();
      const settled = await Promise.allSettled([input, cancel]);

      expect(settled.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
      expect(await harness.methods()).not.toContain("session/prompt");
    } finally {
      await harness.destroy();
    }
  });

  test("sends provider cancellation while its observation event is blocked", async () => {
    const harness = await createHarness();

    try {
      const input = harness.backend.handleInput(
        harness.context,
        { text: "hang" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await harness.methods()).includes("session/prompt")) {
          break;
        }
        await Bun.sleep(5);
      }
      const gate = harness.blockNext("run.cancel.requested");
      const cancel = harness.backend.cancelActiveTurn(harness.context, "test cancellation");
      await gate.entered;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await harness.methods()).includes("session/cancel")) {
          break;
        }
        await Bun.sleep(5);
      }

      expect(await harness.methods()).toContain("session/cancel");
      gate.release();
      await expect(cancel).resolves.toBeUndefined();
      await expect(input).rejects.toThrow("cancelled");
    } finally {
      await harness.destroy();
    }
  });

  test("returns ACP request-cancelled for a nested terminal RPC when the turn is cancelled", async () => {
    const harness = await createHarness();

    try {
      const input = harness.backend.handleInput(
        harness.context,
        { text: "nested-cancel" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await harness.methods()).includes("terminal/wait_for_exit")) {
          break;
        }
        await Bun.sleep(5);
      }

      expect(await harness.methods()).toContain("terminal/wait_for_exit");
      await harness.backend.cancelActiveTurn(harness.context, "test cancellation");
      await expect(input).rejects.toThrow("cancelled");

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await harness.responses()).length > 0) {
          break;
        }
        await Bun.sleep(5);
      }

      expect(await harness.responses()).toContainEqual(
        expect.objectContaining({
          error: expect.objectContaining({ code: -32_800 }),
          id: "nested-wait",
        }),
      );
    } finally {
      await harness.destroy();
    }
  });

  test("waits for accepted session updates before stop completes", async () => {
    const harness = await createHarness();

    try {
      const gate = harness.blockNext("usage.updated");
      await writeFile(harness.triggerPath, "send");
      await gate.entered;
      const stop = harness.backend.stop(harness.context, "test stop", new AbortController().signal);
      const beforeRelease = await settlePromiseWithTimeout(stop, {
        label: "blocked ACP stop",
        timeoutMs: 100,
      });

      gate.release();
      await stop;
      expect(beforeRelease.status).toBe("timed_out");
    } finally {
      await harness.destroy();
    }
  });

  test("accepts the final session update sent before the close response", async () => {
    const harness = await createHarness();

    try {
      await harness.backend.stop(harness.context, "test stop", new AbortController().signal);
      expect(harness.events).toContainEqual(
        expect.objectContaining({
          kind: "usage.updated",
          payload: expect.objectContaining({ size: 20, used: 2 }),
        }),
      );
    } finally {
      await harness.destroy();
    }
  });

  test("shares one bounded stop budget across a stuck close and update drain", async () => {
    const harness = await createHarness({ hangClose: true });

    try {
      const gate = harness.blockNext("usage.updated");
      await writeFile(harness.triggerPath, "send");
      await gate.entered;
      const startedAt = Date.now();

      await expect(
        harness.backend.stop(harness.context, "test stop budget", new AbortController().signal),
      ).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(4_500);
      gate.release();
    } finally {
      await harness.destroy();
    }
  }, 10_000);
});
