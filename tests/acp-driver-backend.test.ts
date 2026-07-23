import { describe, expect, test } from "bun:test";
import type { ClientContext } from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DriverPermissionBroker,
  PermissionEventDeliveryError,
} from "../src/core/driver-permission-broker";
import type { DriverRuntimeEventPort } from "../src/core/driver-runtime-io";
import { createBufferedSinkLogger } from "../src/observability";
import type { AgentDriverPermissionPort } from "../src/host-ports";
import type { DriverBootPayload } from "../src/protocol/boot";
import { createDriverHostIntegrationSnapshotFromBootExecution } from "../src/protocol/host-integration";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { AcpDriverBackend } from "../src/runtimes/acp/acp-driver-backend";
import { AcpClientRequestHandler } from "../src/runtimes/acp/acp-client-request-handler";
import { AcpTurnController } from "../src/runtimes/acp/acp-turn-controller";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { driverBootPayload, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

const FAKE_AGENT = String.raw`
const { appendFileSync, existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const logPath = process.env.TEST_LOG_PATH;
const latePidPath = process.env.TEST_LATE_PID_PATH;
const responsePath = process.env.TEST_RESPONSE_PATH;
const resumeGatePath = process.env.TEST_RESUME_GATE_PATH;
const triggerPath = process.env.TEST_TRIGGER_PATH;
let buffer = "";
let sessionReady = false;
let updateSent = false;
let pendingPromptId = null;
let pendingProviderCancelPromptId = null;
let pendingEndTurnPromptId = null;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const requestClient = (message) => {
  appendFileSync(logPath, message.method + "\n");
  send(message);
};
const handle = (message) => {
  if (!("method" in message)) {
    if (message.id === "nested-permission") {
      appendFileSync(responsePath, JSON.stringify(message) + "\n");
    } else if (message.id === "nested-create") {
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
    if (latePidPath && process.env.TEST_SPAWN_LATE_CHILD === "1") {
      const child = spawn("/usr/bin/setsid", [process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      appendFileSync(latePidPath, String(child.pid) + "\n");
      child.unref();
    }
    pendingPromptId = null;
    return;
  }
  if (!("id" in message)) return;
  let result;
  switch (message.method) {
    case "initialize":
      result = {
        agentCapabilities: { sessionCapabilities: { close: {}, resume: {} } },
        authMethods: process.env.MOSOO_ACP_AUTH_METHOD_ID
          ? [{ id: process.env.MOSOO_ACP_AUTH_METHOD_ID, name: "Test auth" }]
          : [],
        protocolVersion: 1,
      };
      break;
    case "authenticate":
      result = {};
      break;
    case "session/new":
      sessionReady = true;
      result = { sessionId: "native-session-1" };
      break;
    case "session/resume":
      if (process.env.TEST_FAIL_RESUME === "1") {
        send({
          error: { code: -32002, message: "test resume failed" },
          id: message.id,
          jsonrpc: "2.0",
        });
        return;
      }
      if (
        process.env.TEST_BLOCK_RESUME === "1" &&
        resumeGatePath &&
        !existsSync(resumeGatePath)
      ) {
        const timer = setInterval(() => {
          if (!existsSync(resumeGatePath)) return;
          clearInterval(timer);
          sessionReady = true;
          send({ id: message.id, jsonrpc: "2.0", result: {} });
        }, 5);
        return;
      }
      sessionReady = true;
      result = {};
      break;
    case "session/prompt":
      if (message.params.prompt[0]?.text === "crash") {
        process.exit(17);
      }
      if (
        message.params.prompt[0]?.text === "permission-cancel" ||
        message.params.prompt[0]?.text === "permission-drain-then-cancel" ||
        message.params.prompt[0]?.text === "permission-provider-cancel"
      ) {
        const completePromptBeforePermission =
          message.params.prompt[0]?.text !== "permission-cancel";
        const providerCancelled =
          message.params.prompt[0]?.text === "permission-provider-cancel";
        pendingPromptId = completePromptBeforePermission ? null : message.id;
        requestClient({
          id: "nested-permission",
          jsonrpc: "2.0",
          method: "session/request_permission",
          params: {
            options: [
              { kind: "allow_once", name: "Allow", optionId: "allow" },
              { kind: "reject_once", name: "Reject", optionId: "reject" },
            ],
            sessionId: "native-session-1",
            toolCall: {
              kind: "execute",
              status: "pending",
              title: "Run command",
              toolCallId: "tool-permission",
            },
          },
        });
        if (completePromptBeforePermission) {
          if (providerCancelled) {
            pendingProviderCancelPromptId = message.id;
            return;
          }
          if (message.params.prompt[0]?.text === "permission-drain-then-cancel") {
            pendingEndTurnPromptId = message.id;
            return;
          }
          send({
            id: message.id,
            jsonrpc: "2.0",
            result: { stopReason: "end_turn" },
          });
        }
        return;
      }
      if (message.params.prompt[0]?.text === "hang") {
        pendingPromptId = message.id;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "native-session-1",
            update: {
              kind: "execute",
              sessionUpdate: "tool_call",
              status: "in_progress",
              title: "Long command",
              toolCallId: "tool-1",
            },
          },
        });
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
      const chunks =
        message.params.prompt[0]?.text === "burst" ? ["one", "two", "three"] : ["done"];
      for (const text of chunks) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "native-session-1",
            update: {
              content: { text, type: "text" },
              messageId: "assistant-1",
              sessionUpdate: "agent_message_chunk",
            },
          },
        });
      }
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
  if (!sessionReady || !existsSync(triggerPath)) return;
  if (pendingProviderCancelPromptId !== null) {
    const promptId = pendingProviderCancelPromptId;
    pendingProviderCancelPromptId = null;
    send({
      jsonrpc: "2.0",
      method: "$/cancel_request",
      params: { requestId: "nested-permission" },
    });
    send({
      id: promptId,
      jsonrpc: "2.0",
      result: { stopReason: "cancelled" },
    });
    return;
  }
  if (pendingEndTurnPromptId !== null) {
    const promptId = pendingEndTurnPromptId;
    pendingEndTurnPromptId = null;
    send({
      id: promptId,
      jsonrpc: "2.0",
      result: { stopReason: "end_turn" },
    });
    return;
  }
  if (updateSent) return;
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

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

async function createHarness(
  options: {
    readonly authenticate?: boolean;
    readonly blockResume?: boolean;
    readonly failResume?: boolean;
    readonly hangClose?: boolean;
    onEvents?(events: readonly DriverEventInput[]): void;
    readonly permission?: AgentDriverPermissionPort["request"];
    readonly spawnLateChild?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "driver-acp-backend-"));
  const logPath = join(root, "methods.log");
  const latePidPath = join(root, "late.pid");
  const responsePath = join(root, "responses.log");
  const resumeGatePath = join(root, "resume-gate");
  const triggerPath = join(root, "send-update");
  const boot = {
    ...driverBootPayload,
    execution: {
      ...driverBootPayload.execution,
      environment: {
        variables: {
          TEST_LOG_PATH: logPath,
          TEST_LATE_PID_PATH: latePidPath,
          TEST_RESPONSE_PATH: responsePath,
          TEST_RESUME_GATE_PATH: resumeGatePath,
          TEST_TRIGGER_PATH: triggerPath,
          TEST_BLOCK_RESUME: options.blockResume ? "1" : "0",
          TEST_FAIL_RESUME: options.failResume ? "1" : "0",
          TEST_HANG_CLOSE: options.hangClose ? "1" : "0",
          TEST_SPAWN_LATE_CHILD: options.spawnLateChild ? "1" : "0",
          ...(options.authenticate ? { MOSOO_ACP_AUTH_METHOD_ID: "test-auth" } : {}),
        },
      },
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
  const lifecycleFailures: Error[] = [];
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
        options.onEvents?.(events);

        return {
          accepted: events.map((event) => ({ seq: ++acceptedSeq, type: event.kind })),
        };
      },
    },
    logger,
    lifecycle: {
      fail: (error) => lifecycleFailures.push(error),
    },
    payload,
    permission: { request: options.permission ?? (async () => "reject_once") },
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
  process.env["MOSOO_ACP_FALLBACK_COMMAND"] = process.execPath;
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
    latePidPath,
    lifecycleFailures,
    async methods() {
      return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
    },
    async responses() {
      return (await readFile(responsePath, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    resumeGatePath,
    triggerPath,
  };
}

describe("ACP driver backend lifecycle", () => {
  test("projects an active transport loss as a failed turn", async () => {
    const harness = await createHarness();

    try {
      await expect(
        harness.backend.handleInput(
          harness.context,
          { text: "crash" },
          DRIVER_TEST_IDS.runId as RunId,
        ),
      ).rejects.toThrow();
      expect(harness.events.filter((event) => event.kind === "run.failed")).toHaveLength(1);
      expect(harness.events.some((event) => event.kind === "run.cancelled")).toBe(false);
      expect(harness.lifecycleFailures).toEqual([]);
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
      expect(await harness.methods()).not.toContain("session/cancel");
    } finally {
      await harness.destroy();
    }
  });

  test("does not admit a prompt after dispatcher cancellation wins before backend admission", async () => {
    const harness = await createHarness();
    const cancellation = new AbortController();
    cancellation.abort(new Error("test admission cancellation"));

    try {
      await expect(
        harness.backend.handleInput(
          harness.context,
          { text: "must not run" },
          DRIVER_TEST_IDS.runId as RunId,
          cancellation.signal,
        ),
      ).rejects.toThrow("cancelled");

      expect(await harness.methods()).not.toContain("session/prompt");
      expect(
        harness.events
          .filter((event) => event.runId === DRIVER_TEST_IDS.runId)
          .map((event) => event.kind),
      ).toEqual([
        "message.added",
        "run.dispatched",
        "run.started",
        "run.cancel.requested",
        "run.cancelled",
      ]);
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
      expect(
        await settlePromiseWithTimeout(input, {
          label: "ACP cancellation request publication",
          timeoutMs: 50,
        }),
      ).toMatchObject({ status: "timed_out" });
      expect(harness.events).not.toContainEqual(expect.objectContaining({ kind: "run.cancelled" }));
      gate.release();
      await expect(cancel).resolves.toBeUndefined();
      await expect(input).rejects.toThrow("cancelled");
    } finally {
      await harness.destroy();
    }
  });

  test.skipIf(process.platform !== "linux")(
    "recycles a cancelled provider tree before terminal delivery and resumes the session",
    async () => {
      const harness = await createHarness({
        authenticate: true,
        blockResume: true,
        spawnLateChild: true,
      });

      try {
        const eventOffset = harness.events.length;
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

        await expect(
          harness.backend.cancelActiveTurn(harness.context, "test cancellation"),
        ).resolves.toBeUndefined();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((await harness.methods()).includes("session/resume")) {
            break;
          }
          await Bun.sleep(5);
        }

        expect(await harness.methods()).toContain("session/resume");
        expect(harness.events).not.toContainEqual(
          expect.objectContaining({ kind: "run.cancelled" }),
        );
        const latePid = Number.parseInt((await readFile(harness.latePidPath, "utf8")).trim(), 10);
        expect(isRunning(latePid)).toBe(false);

        await writeFile(harness.resumeGatePath, "resume");
        await expect(input).rejects.toThrow("cancelled");
        expect(
          (await harness.methods()).filter((method) => method === "session/resume"),
        ).toHaveLength(2);
        expect(
          (await harness.methods()).filter((method) => method === "authenticate"),
        ).toHaveLength(2);
        expect(
          harness.events
            .slice(eventOffset)
            .map((event) => event.kind)
            .filter((kind) =>
              [
                "auth.methods.updated",
                "auth.session.updated",
                "runtime.capabilities.updated",
                "runtime.resume.updated",
                "session.created",
                "session.resumed",
              ].includes(kind),
            ),
        ).toEqual([]);
        expect(harness.lifecycleFailures).toEqual([]);

        await expect(
          harness.backend.handleInput(
            harness.context,
            { text: "after recycle" },
            DRIVER_TEST_IDS.secondRunId as RunId,
          ),
        ).resolves.toBeUndefined();
      } finally {
        await writeFile(harness.resumeGatePath, "cleanup").catch(() => {});
        await harness.destroy();
      }
    },
  );

  test("fails the cancelled turn before terminal delivery when session recycle fails", async () => {
    const harness = await createHarness({ failResume: true });

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

      await expect(
        harness.backend.cancelActiveTurn(harness.context, "test cancellation"),
      ).resolves.toBeUndefined();
      await expect(input).rejects.toThrow("process recycle failed");
      expect(harness.events).toContainEqual(expect.objectContaining({ kind: "run.failed" }));
      expect(harness.events).not.toContainEqual(expect.objectContaining({ kind: "run.cancelled" }));
      expect(harness.lifecycleFailures).toEqual([]);
    } finally {
      await harness.destroy();
    }
  });

  test("accepts a notification close after the cancelled terminal is delivered", async () => {
    const harness = await createHarness();
    const promptRequested = Promise.withResolvers<void>();
    const terminalDelivered = Promise.withResolvers<void>();
    const prompt = Promise.withResolvers<{ stopReason: "cancelled" }>();
    const turn = new AcpTurnController(async (_context, _reason, events) => {
      if (events.some((event) => event.kind === "run.cancelled")) {
        terminalDelivered.resolve();
      }
    });
    const clientRequests = new AcpClientRequestHandler({
      allowedRoots: [process.cwd()],
      cwd: process.cwd(),
      env: {},
      isCancelling: () => turn.isCancelling(),
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async () => {},
      turnEvents: turn.events,
    });
    const connection = {
      notify: async () => {
        prompt.resolve({ stopReason: "cancelled" });
        await terminalDelivered.promise;
        throw new Error("ACP transport closed");
      },
      request: async () => {
        promptRequested.resolve();
        return prompt.promise;
      },
    } as unknown as ClientContext;

    try {
      const input = turn.handleInput(
        harness.context,
        { text: "cancel me" },
        DRIVER_TEST_IDS.runId as RunId,
        connection,
        "native-session-1",
        createDriverHostIntegrationSnapshotFromBootExecution(driverBootPayload.execution),
        clientRequests,
      );
      void input.catch(() => {});
      await promptRequested.promise;
      const cancel = turn.cancel(
        harness.context,
        "test cancellation",
        connection,
        "native-session-1",
      );

      await expect(cancel).resolves.toBeUndefined();
      await expect(input).rejects.toThrow("cancelled");
    } finally {
      await harness.destroy();
    }
  });

  test("does not hold cancellation acknowledgement behind provider recycle", async () => {
    const harness = await createHarness();
    const promptRequested = Promise.withResolvers<void>();
    const prompt = Promise.withResolvers<{ stopReason: "cancelled" }>();
    const barrierEntered = Promise.withResolvers<void>();
    const releaseBarrier = Promise.withResolvers<void>();
    const turn = new AcpTurnController(
      async () => {},
      async () => {
        barrierEntered.resolve();
        await releaseBarrier.promise;
      },
    );
    const clientRequests = new AcpClientRequestHandler({
      allowedRoots: [process.cwd()],
      cwd: process.cwd(),
      env: {},
      isCancelling: () => turn.isCancelling(),
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async () => {},
      turnEvents: turn.events,
    });
    const connection = {
      notify: async () => {
        prompt.resolve({ stopReason: "cancelled" });
        throw new Error("ACP transport closed");
      },
      request: async () => {
        promptRequested.resolve();
        return prompt.promise;
      },
    } as unknown as ClientContext;

    try {
      const input = turn.handleInput(
        harness.context,
        { text: "cancel me" },
        DRIVER_TEST_IDS.runId as RunId,
        connection,
        "native-session-1",
        createDriverHostIntegrationSnapshotFromBootExecution(driverBootPayload.execution),
        clientRequests,
      );
      void input.catch(() => {});
      await promptRequested.promise;
      await expect(
        turn.cancel(harness.context, "test cancellation", connection, "native-session-1"),
      ).resolves.toBeUndefined();
      await barrierEntered.promise;
      expect(
        await settlePromiseWithTimeout(input, {
          label: "blocked ACP provider recycle",
          timeoutMs: 50,
        }),
      ).toMatchObject({ status: "timed_out" });

      releaseBarrier.resolve();
      await expect(input).rejects.toThrow("cancelled");
    } finally {
      releaseBarrier.resolve();
      await harness.destroy();
    }
  });

  test("keeps the terminal behind a permission tool publication past the cancel grace", async () => {
    let permissionRequests = 0;
    const harness = await createHarness({
      permission: async () => {
        permissionRequests += 1;
        return "allow_once";
      },
    });

    try {
      const gate = harness.blockNext("tool.call.updated");
      const input = harness.backend.handleInput(
        harness.context,
        { text: "permission-cancel" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});
      await gate.entered;
      const cancel = harness.backend.cancelActiveTurn(harness.context, "test cancellation");
      await Bun.sleep(2_100);

      expect(
        await settlePromiseWithTimeout(input, {
          label: "blocked ACP permission tool publication",
          timeoutMs: 50,
        }),
      ).toMatchObject({ status: "timed_out" });
      expect(harness.events).not.toContainEqual(expect.objectContaining({ kind: "run.cancelled" }));

      gate.release();
      await expect(input).rejects.toThrow("cancelled");
      await expect(cancel).resolves.toBeUndefined();
      expect(permissionRequests).toBe(0);
      const ordered = harness.events
        .map((event) => event.kind)
        .filter((kind) => kind === "tool.call.updated" || kind === "run.cancelled");
      expect(ordered.at(-1)).toBe("run.cancelled");
      expect(ordered).toContain("tool.call.updated");
    } finally {
      await harness.destroy();
    }
  }, 7_000);

  test("drains queued updates before a cancellation terminal after the cancel grace", async () => {
    const harness = await createHarness();

    try {
      const gate = harness.blockNext("message.delta");
      const input = harness.backend.handleInput(
        harness.context,
        { text: "burst" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});
      await gate.entered;
      await Bun.sleep(20);
      const cancel = harness.backend.cancelActiveTurn(harness.context, "test cancellation");
      await Bun.sleep(2_100);

      expect(
        await settlePromiseWithTimeout(input, {
          label: "blocked ACP update drain",
          timeoutMs: 50,
        }),
      ).toMatchObject({ status: "timed_out" });
      expect(harness.events).not.toContainEqual(expect.objectContaining({ kind: "run.cancelled" }));

      gate.release();
      await expect(input).rejects.toThrow("cancelled");
      await expect(cancel).resolves.toBeUndefined();
      const runEvents = harness.events.filter(
        (event) =>
          event.runId === DRIVER_TEST_IDS.runId &&
          (event.kind === "message.delta" || event.kind === "run.cancelled"),
      );
      expect(
        runEvents
          .filter((event) => event.kind === "message.delta")
          .map((event) => (event.payload as { readonly contentDelta: unknown }).contentDelta),
      ).toEqual(["one", "two", "three"]);
      expect(runEvents.at(-1)?.kind).toBe("run.cancelled");
    } finally {
      await harness.destroy();
    }
  }, 7_000);

  test("delivers a cancelled permission resolution before the run terminal", async () => {
    const permissionEntered = Promise.withResolvers<void>();
    const releasePermission = Promise.withResolvers<void>();
    const order: string[] = [];
    const harness = await createHarness({
      onEvents: (events) => order.push(...events.map((event) => event.kind)),
      permission: async () => {
        permissionEntered.resolve();
        await releasePermission.promise;
        order.push("permission.resolved");
        return "reject_once";
      },
    });

    try {
      const input = harness.backend.handleInput(
        harness.context,
        { text: "permission-cancel" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});
      await permissionEntered.promise;
      await harness.backend.cancelActiveTurn(harness.context, "test cancellation");

      expect(
        await settlePromiseWithTimeout(input, {
          label: "cancelled ACP permission drain",
          timeoutMs: 100,
        }),
      ).toMatchObject({ status: "timed_out" });
      expect(harness.events).not.toContainEqual(expect.objectContaining({ kind: "run.cancelled" }));

      releasePermission.resolve();
      await expect(input).rejects.toThrow("cancelled");
      expect(
        order.filter((kind) => kind === "permission.resolved" || kind === "run.cancelled"),
      ).toEqual(["permission.resolved", "run.cancelled"]);
    } finally {
      await harness.destroy();
    }
  });

  test("fails closed when cancelled permission resolution delivery recovers after its budget", async () => {
    const requestedDelivered = Promise.withResolvers<void>();
    const resolutionPublishing = Promise.withResolvers<void>();
    const recoverTransport = Promise.withResolvers<void>();
    const attemptedKinds: string[] = [];
    const acceptedKinds: string[] = [];
    const broker = new DriverPermissionBroker(() => null, {
      eventDeliveryTimeoutMs: 5_000,
    });
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => DRIVER_TEST_IDS.runId as RunId,
      pushEvents: async ({ events, signal }) => {
        attemptedKinds.push(...events.map((event) => event.kind));

        if (events.some((event) => event.kind === "permission.resolved")) {
          resolutionPublishing.resolve();
          await Promise.race([
            recoverTransport.promise,
            new Promise<never>((_resolve, reject) => {
              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
          ]);
        }

        acceptedKinds.push(...events.map((event) => event.kind));
        if (events.some((event) => event.kind === "permission.requested")) {
          requestedDelivered.resolve();
        }
        return {
          accepted: events.map((event, index) => ({
            seq: index + 1,
            type: event.kind,
          })),
        };
      },
    };
    const harness = await createHarness({
      permission: (input, signal) => broker.request(socket, input, signal),
    });

    try {
      const input = harness.backend.handleInput(
        harness.context,
        { text: "permission-cancel" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});
      await requestedDelivered.promise;
      const cancel = harness.backend.cancelActiveTurn(harness.context, "test cancellation");
      await resolutionPublishing.promise;

      const failure = await input.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PermissionEventDeliveryError);
      expect(failure).toMatchObject({
        phase: "resolved",
        requestId: "string:nested-permission",
      });
      recoverTransport.resolve();
      await expect(cancel).resolves.toBeUndefined();
      await Bun.sleep(10);

      expect(attemptedKinds).toContain("permission.resolved");
      expect(acceptedKinds).toEqual(["permission.requested"]);
      expect(harness.events).not.toContainEqual(expect.objectContaining({ kind: "run.cancelled" }));
    } finally {
      recoverTransport.resolve();
      await harness.destroy();
    }
  }, 7_000);

  test("fails closed when a permission delivery rejection settles before cancellation drain", async () => {
    const requestedDelivered = Promise.withResolvers<string>();
    const permissionSettled = Promise.withResolvers<void>();
    const acceptedKinds: string[] = [];
    const broker = new DriverPermissionBroker(() => null);
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => DRIVER_TEST_IDS.runId as RunId,
      pushEvents: async ({ events }) => {
        const requested = events.find((event) => event.kind === "permission.requested");
        if (requested !== undefined) {
          requestedDelivered.resolve(
            (requested.payload as { readonly requestId: string }).requestId,
          );
        }
        if (events.some((event) => event.kind === "permission.resolved")) {
          throw new Error("permission transport unavailable");
        }

        acceptedKinds.push(...events.map((event) => event.kind));
        return {
          accepted: events.map((event, index) => ({
            seq: index + 1,
            type: event.kind,
          })),
        };
      },
    };
    const harness = await createHarness({
      permission: async (input, signal) => {
        try {
          return await broker.request(socket, input, signal);
        } finally {
          permissionSettled.resolve();
        }
      },
    });

    try {
      const input = harness.backend.handleInput(
        harness.context,
        { text: "permission-cancel" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});
      const requestId = await requestedDelivered.promise;
      expect(broker.resolve(requestId, "allow_once")).toBe(true);
      await permissionSettled.promise;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await harness.responses()).length > 0) {
          break;
        }
        await Bun.sleep(5);
      }
      expect(await harness.responses()).toHaveLength(1);

      const cancel = harness.backend.cancelActiveTurn(harness.context, "test cancellation");
      const failure = await input.catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PermissionEventDeliveryError);
      expect(failure).toMatchObject({ phase: "resolved", requestId });
      await expect(cancel).resolves.toBeUndefined();
      expect(acceptedKinds).toEqual(["permission.requested"]);
      expect(harness.events).not.toContainEqual(expect.objectContaining({ kind: "run.cancelled" }));
    } finally {
      await harness.destroy();
    }
  });

  test("keeps a cancellation terminal behind a non-compliant permission drain", async () => {
    const permissionEntered = Promise.withResolvers<void>();
    const releasePermission = Promise.withResolvers<void>();
    const order: string[] = [];
    const harness = await createHarness({
      onEvents: (events) => order.push(...events.map((event) => event.kind)),
      permission: async () => {
        permissionEntered.resolve();
        await releasePermission.promise;
        order.push("permission.resolved");
        return "reject_once";
      },
    });

    try {
      const input = harness.backend.handleInput(
        harness.context,
        { text: "permission-drain-then-cancel" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});
      await permissionEntered.promise;
      await writeFile(harness.triggerPath, "end turn");
      await Bun.sleep(20);

      const cancel = harness.backend.cancelActiveTurn(harness.context, "test cancellation");
      await Bun.sleep(2_100);
      expect(
        await settlePromiseWithTimeout(input, {
          label: "non-compliant ACP permission drain",
          timeoutMs: 50,
        }),
      ).toMatchObject({ status: "timed_out" });
      expect(harness.events).not.toContainEqual(expect.objectContaining({ kind: "run.cancelled" }));

      releasePermission.resolve();
      await expect(Promise.all([input, cancel])).rejects.toThrow("cancelled");
      expect(
        order.filter((kind) => kind === "permission.resolved" || kind === "run.cancelled"),
      ).toEqual(["permission.resolved", "run.cancelled"]);
    } finally {
      releasePermission.resolve();
      await harness.destroy();
    }
  }, 7_000);

  test("cancels a stuck permission when the provider ends the turn as cancelled", async () => {
    const permissionEntered = Promise.withResolvers<void>();
    const releasePermission = Promise.withResolvers<void>();
    let permissionSignal: AbortSignal | undefined;
    let providerCancelTriggerPath = "";
    const harness = await createHarness({
      permission: async (_input, signal) => {
        permissionSignal = signal;
        permissionEntered.resolve();
        await writeFile(providerCancelTriggerPath, "cancel");
        await releasePermission.promise;
        return "reject_once";
      },
    });
    providerCancelTriggerPath = harness.triggerPath;

    try {
      const input = harness.backend.handleInput(
        harness.context,
        { text: "permission-provider-cancel" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});
      await permissionEntered.promise;
      await Bun.sleep(2_100);
      expect(
        await settlePromiseWithTimeout(input, {
          label: "provider-cancelled ACP permission",
          timeoutMs: 50,
        }),
      ).toMatchObject({ status: "timed_out" });
      expect(permissionSignal?.aborted).toBe(true);
      expect(harness.events).not.toContainEqual(expect.objectContaining({ kind: "run.cancelled" }));

      releasePermission.resolve();
      await expect(input).rejects.toThrow("cancelled");
      expect(harness.events).toContainEqual(expect.objectContaining({ kind: "run.cancelled" }));
      expect(harness.events).not.toContainEqual(expect.objectContaining({ kind: "run.failed" }));
    } finally {
      releasePermission.resolve();
      await harness.destroy();
    }
  }, 7_000);

  test("keeps one completion when cancellation arrives during terminal publication", async () => {
    const harness = await createHarness();

    try {
      const gate = harness.blockNext("run.completed");
      const input = harness.backend.handleInput(
        harness.context,
        { text: "complete" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      await gate.entered;
      const cancel = harness.backend.cancelActiveTurn(harness.context, "late cancellation");
      gate.release();

      await expect(Promise.all([input, cancel])).resolves.toEqual([undefined, undefined]);
      expect(harness.events.map((event) => event.kind)).not.toContain("run.cancel.requested");
      expect(
        harness.events
          .map((event) => event.kind)
          .filter(
            (kind) => kind === "run.cancelled" || kind === "run.completed" || kind === "run.failed",
          ),
      ).toEqual(["run.completed"]);
    } finally {
      await harness.destroy();
    }
  });

  test("drains burst updates sent immediately before the prompt response", async () => {
    const harness = await createHarness();

    try {
      await harness.backend.handleInput(
        harness.context,
        { text: "burst" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      const runEvents = harness.events.filter((event) => event.runId === DRIVER_TEST_IDS.runId);
      const deltas = runEvents
        .filter((event) => event.kind === "message.delta")
        .map((event) => (event.payload as { readonly contentDelta: unknown }).contentDelta);

      expect(deltas).toEqual(["one", "two", "three"]);
      expect(runEvents.at(-1)?.kind).toBe("run.completed");
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

  test("publishes cancellation when stop aborts an active prompt", async () => {
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

      expect(await harness.methods()).toContain("session/prompt");
      await expect(
        harness.backend.stop(harness.context, "test stop", new AbortController().signal),
      ).resolves.toBeUndefined();
      await expect(input).rejects.toThrow("cancelled");
      expect(
        harness.events
          .filter(
            (event) =>
              event.kind === "tool.call.updated" ||
              event.kind === "item.completed" ||
              event.kind === "run.cancelled" ||
              event.kind === "run.failed",
          )
          .map((event) => ({
            kind: event.kind,
            status: (event.payload as { readonly status?: unknown }).status,
          })),
      ).toEqual([
        { kind: "tool.call.updated", status: "running" },
        { kind: "tool.call.updated", status: "failed" },
        { kind: "item.completed", status: "failed" },
        { kind: "run.cancelled", status: undefined },
      ]);
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
