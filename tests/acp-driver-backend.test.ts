import { describe, expect, spyOn, test } from "bun:test";
import type { ClientContext } from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DriverPermissionBroker,
  PermissionEventDeliveryError,
} from "../src/core/driver-permission-broker";
import type { DriverRuntimeEventPort } from "../src/core/driver-runtime-io";
import { createDisabledLogger } from "../src/observability";
import type { AgentDriverPermissionPort } from "../src/host-ports";
import type { DriverBootPayload } from "../src/protocol/boot";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { AcpDriverBackend } from "../src/runtimes/acp/acp-driver-backend";
import * as acpAgentProcess from "../src/runtimes/acp/acp-agent-process";
import { AcpClientRequestHandler } from "../src/runtimes/acp/acp-client-request-handler";
import { AcpTurnController } from "../src/runtimes/acp/acp-turn-controller";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { waitForAcpTestCondition } from "./acp-test-helpers";
import { driverBootPayload, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

const FAKE_AGENT = String.raw`
const { appendFileSync, existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const logPath = process.env.TEST_LOG_PATH;
const latePidPath = process.env.TEST_LATE_PID_PATH;
const openCodeConfigPath = process.env.TEST_OPENCODE_CONFIG_PATH;
const responsePath = process.env.TEST_RESPONSE_PATH;
const resumeGatePath = process.env.TEST_RESUME_GATE_PATH;
const triggerPath = process.env.TEST_TRIGGER_PATH;
if (openCodeConfigPath) {
  appendFileSync(openCodeConfigPath, process.env.OPENCODE_CONFIG_CONTENT || "");
}
let buffer = "";
let sessionReady = false;
let updateSent = false;
let pendingPromptId = null;
let pendingProviderCancelPromptId = null;
let pendingEndTurnPromptId = null;
let resumeMetadataSent = false;
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
    if (latePidPath && process.env.TEST_SPAWN_LATE_CHILD === "1") {
      const child = spawn("/usr/bin/setsid", [process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      appendFileSync(latePidPath, String(child.pid) + "\n");
      child.unref();
    }
    send({ id: pendingPromptId, jsonrpc: "2.0", result: { stopReason: "cancelled" } });
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
      if (process.env.TEST_UPDATE_BEFORE_SESSION_RESPONSE === "1") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "native-session-1",
            update: {
              availableCommands: [{ description: "Early command", name: "early" }],
              sessionUpdate: "available_commands_update",
            },
          },
        });
      }
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
      if (process.env.TEST_METADATA_ON_RESUME === "1" && !resumeMetadataSent) {
        resumeMetadataSent = true;
        for (const update of [
          {
            availableCommands: [{ description: "Resume command", name: "resume" }],
            sessionUpdate: "available_commands_update",
          },
          {
            configOptions: [{ currentValue: true, id: "resume-config", type: "boolean" }],
            sessionUpdate: "config_option_update",
          },
          {
            availableModes: [{ id: "resume-mode", name: "Resume mode" }],
            currentModeId: "resume-mode",
            sessionUpdate: "current_mode_update",
          },
          { sessionUpdate: "session_info_update", title: "Resumed session" },
        ]) {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "native-session-1", update },
          });
        }
      }
      sessionReady = true;
      result = {};
      break;
    case "session/prompt":
      if (message.params.prompt[0]?.text === "eof-before-response") {
        process.exit(0);
        return;
      }
      if (message.params.prompt[0]?.text === "response-then-eof") {
        const update = {
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
        };
        const response = { id: message.id, jsonrpc: "2.0", result: { stopReason: "end_turn" } };
        process.stdout.write(
          JSON.stringify(update) + "\n" + JSON.stringify(response) + "\n",
          () => process.exit(0),
        );
        return;
      }
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
      if (message.params.prompt[0]?.text === "many-tools") {
        for (let index = 0; index < 32; index += 1) {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "native-session-1",
              update: {
                kind: "execute",
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Tool " + index,
                toolCallId: "tool-" + index,
              },
            },
          });
        }
        result = { stopReason: "end_turn" };
        break;
      }
      if (message.params.prompt[0]?.text === "invalid-stop-reason") {
        for (let index = 0; index < 509; index += 1) {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "native-session-1",
              update: {
                kind: "execute",
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Tool " + index,
                toolCallId: "tool-" + index,
              },
            },
          });
        }
        result = { stopReason: "s".repeat(1_000) };
        break;
      }
      if (message.params.prompt[0]?.text === "sticky-update-failure") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "native-session-1",
            update: {
              kind: "execute",
              sessionUpdate: "tool_call",
              status: "in_progress",
              title: "Fail delivery",
              toolCallId: "tool-sticky",
            },
          },
        });
        result = { stopReason: "end_turn" };
        break;
      }
      if (message.params.prompt[0]?.text === "thought-only") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "native-session-1",
            update: {
              content: { text: "final from thought", type: "text" },
              messageId: "assistant-thought",
              sessionUpdate: "agent_thought_chunk",
            },
          },
        });
        result = { stopReason: "end_turn" };
        break;
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
    readonly metadataOnResume?: boolean;
    readonly openCodeInstructions?: boolean;
    onEvents?(events: readonly DriverEventInput[]): void;
    readonly permission?: AgentDriverPermissionPort["request"];
    readonly spawnLateChild?: boolean;
    readonly updateBeforeSessionResponse?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "driver-acp-backend-"));
  const logPath = join(root, "methods.log");
  const latePidPath = join(root, "late.pid");
  const openCodeConfigPath = join(root, "opencode-config.json");
  const responsePath = join(root, "responses.log");
  const resumeGatePath = join(root, "resume-gate");
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
          TEST_LATE_PID_PATH: latePidPath,
          TEST_OPENCODE_CONFIG_PATH: openCodeConfigPath,
          TEST_RESPONSE_PATH: responsePath,
          TEST_RESUME_GATE_PATH: resumeGatePath,
          TEST_TRIGGER_PATH: triggerPath,
          TEST_BLOCK_RESUME: options.blockResume ? "1" : "0",
          TEST_FAIL_RESUME: options.failResume ? "1" : "0",
          TEST_HANG_CLOSE: options.hangClose ? "1" : "0",
          TEST_METADATA_ON_RESUME: options.metadataOnResume ? "1" : "0",
          TEST_SPAWN_LATE_CHILD: options.spawnLateChild ? "1" : "0",
          TEST_UPDATE_BEFORE_SESSION_RESPONSE: options.updateBeforeSessionResponse ? "1" : "0",
          ...(options.authenticate ? { MOSOO_ACP_AUTH_METHOD_ID: "test-auth" } : {}),
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
  const logger = createDisabledLogger();
  let acceptedSeq = 0;
  const lifecycleFailures: Error[] = [];
  const lifecycleFailure = Promise.withResolvers<Error>();
  const publishedEvents: DriverEventInput[] = [];
  let block: {
    readonly entered: ReturnType<typeof Promise.withResolvers<void>>;
    readonly kind: string;
    readonly release: ReturnType<typeof Promise.withResolvers<void>>;
  } | null = null;
  let activeRunId: RunId | null = null;
  let failKind: string | null = null;
  const context = createAgentDriverContext({
    eventSink: {
      currentRunId: () => activeRunId,
      pushEvents: async ({ events }) => {
        const runStarted = events.find((event) => event.kind === "run.started");
        if (runStarted !== undefined) {
          activeRunId = runStarted.runId ?? null;
        }

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
        for (const event of events) {
          if (
            event.kind === "run.cancelled" ||
            event.kind === "run.completed" ||
            event.kind === "run.failed"
          ) {
            activeRunId = null;
          }
        }
        options.onEvents?.(events);

        return {
          accepted: events.map((event) => ({ seq: ++acceptedSeq, type: event.kind })),
        };
      },
    },
    logger,
    lifecycle: {
      fail: (error) => {
        lifecycleFailures.push(error);
        lifecycleFailure.resolve(error);
      },
    },
    payload,
    permission: { request: options.permission ?? (async () => "reject_once") },
    ports: {
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
      await rm(root, { force: true, recursive: true });
    },
    failNext(kind: string) {
      failKind = kind;
    },
    events: publishedEvents,
    latePidPath,
    lifecycleFailure: lifecycleFailure.promise,
    lifecycleFailures,
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
    resumeGatePath,
    triggerPath,
  };
}

describe("ACP driver backend lifecycle", () => {
  test("fails before provider setup when a configured root cannot be acquired", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-acp-root-init-failure-"));
    const missing = join(root, "missing");
    const boot = {
      ...driverBootPayload,
      execution: {
        ...driverBootPayload.execution,
        session: {
          ...driverBootPayload.execution.session,
          additionalDirectories: [missing],
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
    const logger = createDisabledLogger();
    let materializations = 0;
    const context = createAgentDriverContext({
      eventSink: {
        currentRunId: () => null,
        pushEvents: async () => ({ accepted: [] }),
      },
      logger,
      payload,
      permission: { request: async () => "reject_once" },
      ports: {
        skill: {
          materialize: async () => {
            materializations += 1;
            return [];
          },
        },
      },
    });
    const backend = new AcpDriverBackend(payload);

    try {
      await expect(backend.start(context, new AbortController().signal)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(materializations).toBe(0);
      await expect(
        Promise.all([
          backend.stop(context, "retry cleanup", new AbortController().signal),
          backend.stop(context, "retry cleanup", new AbortController().signal),
        ]),
      ).resolves.toEqual([undefined, undefined]);
    } finally {
      await backend.stop(context, "test cleanup", new AbortController().signal).catch(() => {});
      await rm(root, { force: true, recursive: true });
    }
  });

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

  test("buffers an update sent before the new-session response", async () => {
    const harness = await createHarness({ updateBeforeSessionResponse: true });

    try {
      expect(harness.lifecycleFailures).toEqual([]);
      expect(harness.events).toContainEqual(
        expect.objectContaining({
          kind: "session.commands.updated",
          payload: {
            commands: [
              {
                description: "Early command",
                input: null,
                name: "early",
              },
            ],
          },
        }),
      );
    } finally {
      await harness.destroy();
    }
  });

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

  test("commits a complete prompt response before a same-tick transport EOF", async () => {
    const originalStop = acpAgentProcess.stopAcpAgentProcess;
    let cleanupFailed = false;
    const cleanupRejected = Promise.withResolvers<void>();
    let failedProcess: Parameters<typeof originalStop>[1] | null = null;
    let retriedOwnedProcess = false;
    const stopSpy = spyOn(acpAgentProcess, "stopAcpAgentProcess").mockImplementation(
      async (context, process, reason, deadline, signal) => {
        if (reason === "connection.failed" && !cleanupFailed) {
          cleanupFailed = true;
          failedProcess = process;
          cleanupRejected.resolve();
          throw new Error("test connection cleanup failed");
        }
        if (failedProcess !== null && process === failedProcess) {
          retriedOwnedProcess = true;
        }
        await originalStop(context, process, reason, deadline, signal);
      },
    );
    let harness: Awaited<ReturnType<typeof createHarness>> | null = null;

    try {
      harness = await createHarness();
      const terminal = harness.blockNext("run.completed");
      const input = harness.backend.handleInput(
        harness.context,
        { text: "response-then-eof" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});

      await Promise.all([terminal.entered, cleanupRejected.promise]);
      try {
        await expect(
          harness.backend.handleInput(
            harness.context,
            { text: "unreachable" },
            DRIVER_TEST_IDS.secondRunId,
          ),
        ).rejects.toThrow("ACP driver backend connection is not initialized");
        await Promise.resolve();
        expect(harness.lifecycleFailures).toEqual([]);
      } finally {
        terminal.release();
      }
      await expect(input).resolves.toBeUndefined();
      await harness.lifecycleFailure;

      expect(harness.events.filter((event) => event.kind === "run.completed")).toHaveLength(1);
      expect(harness.events.some((event) => event.kind === "run.failed")).toBe(false);
      expect(harness.lifecycleFailures).toHaveLength(1);
      expect(harness.lifecycleFailures[0]).toBeInstanceOf(AggregateError);
      await expect(
        harness.backend.stop(harness.context, "test retry cleanup", new AbortController().signal),
      ).resolves.toBeUndefined();
      expect(retriedOwnedProcess).toBe(true);
    } finally {
      await harness?.destroy();
      stopSpy.mockRestore();
    }
  });

  test("lets a transport EOF before the prompt response fail the active turn", async () => {
    const harness = await createHarness();

    try {
      await expect(
        harness.backend.handleInput(
          harness.context,
          { text: "eof-before-response" },
          DRIVER_TEST_IDS.runId as RunId,
        ),
      ).rejects.toThrow();

      expect(harness.events.filter((event) => event.kind === "run.failed")).toHaveLength(1);
      expect(harness.events.some((event) => event.kind === "run.completed")).toBe(false);
      expect(harness.lifecycleFailures).toEqual([]);
    } finally {
      await harness.destroy();
    }
  });

  test("publishes a thought-only fallback through lossless terminal closures", async () => {
    const harness = await createHarness();

    try {
      await harness.backend.handleInput(
        harness.context,
        { text: "thought-only" },
        DRIVER_TEST_IDS.runId as RunId,
      );

      expect(
        harness.events.find(
          (event) =>
            event.kind === "message.added" &&
            (event.payload as Record<string, unknown>)["role"] === "agent",
        )?.payload,
      ).toMatchObject({ content: "final from thought" });
      expect(harness.events.filter((event) => event.kind === "run.completed")).toHaveLength(1);
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

  test("fails a pre-admission cancelled turn when backend stop cleanup fails", async () => {
    const originalStop = acpAgentProcess.stopAcpAgentProcess;
    let failedProcess: Parameters<typeof originalStop>[1] | null = null;
    let retriedOwnedProcess = false;
    const stopSpy = spyOn(acpAgentProcess, "stopAcpAgentProcess").mockImplementation(
      async (context, process, reason, deadline, signal) => {
        if (reason === "test pre-admission stop" && failedProcess === null) {
          failedProcess = process;
          throw new Error("test pre-admission cleanup failed");
        }
        if (failedProcess !== null && process === failedProcess) {
          retriedOwnedProcess = true;
        }
        await originalStop(context, process, reason, deadline, signal);
      },
    );
    let harness: Awaited<ReturnType<typeof createHarness>> | null = null;

    try {
      harness = await createHarness();
      const gate = harness.blockNext("run.started");
      const input = harness.backend.handleInput(
        harness.context,
        { text: "must not run" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});
      await gate.entered;

      await expect(
        harness.backend.stop(
          harness.context,
          "test pre-admission stop",
          new AbortController().signal,
        ),
      ).rejects.toThrow("test pre-admission cleanup failed");
      gate.release();

      await expect(input).rejects.toThrow("cancelled turn process recycle failed");
      expect(await harness.methods()).not.toContain("session/prompt");
      expect(
        harness.events
          .filter(
            (event) =>
              event.kind === "run.cancelled" ||
              event.kind === "run.completed" ||
              event.kind === "run.failed",
          )
          .map((event) => event.kind),
      ).toEqual(["run.failed"]);
      await expect(
        harness.backend.stop(
          harness.context,
          "test pre-admission retry",
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined();
      expect(retriedOwnedProcess).toBe(true);
    } finally {
      await harness?.destroy();
      stopSpy.mockRestore();
    }
  });

  test("fails a prompt response with an invalid stop reason before terminal projection", async () => {
    const harness = await createHarness();

    try {
      await expect(
        harness.backend.handleInput(
          harness.context,
          { text: "invalid-stop-reason" },
          DRIVER_TEST_IDS.runId as RunId,
        ),
      ).rejects.toThrow("ACP prompt response contains an invalid stop reason");

      expect(
        harness.events
          .filter(
            (event) =>
              event.kind === "run.cancelled" ||
              event.kind === "run.completed" ||
              event.kind === "run.failed",
          )
          .map((event) => event.kind),
      ).toEqual(["run.failed"]);
      expect(harness.events.filter((event) => event.kind === "item.completed")).toHaveLength(509);
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
      await waitForAcpTestCondition(
        async () => (await harness.methods()).includes("session/prompt"),
        "ACP session/prompt request",
      );
      const gate = harness.blockNext("run.cancel.requested");
      const cancel = harness.backend.cancelActiveTurn(harness.context, "test cancellation");
      await gate.entered;
      await waitForAcpTestCondition(
        async () => (await harness.methods()).includes("session/cancel"),
        "ACP session/cancel request",
      );

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
        await waitForAcpTestCondition(
          async () => (await harness.methods()).includes("session/prompt"),
          "ACP session/prompt request",
        );

        await expect(
          harness.backend.cancelActiveTurn(harness.context, "test cancellation"),
        ).resolves.toBeUndefined();
        await waitForAcpTestCondition(
          async () => (await harness.methods()).includes("session/resume"),
          "ACP session/resume request",
        );

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
      await waitForAcpTestCondition(
        async () => (await harness.methods()).includes("session/prompt"),
        "ACP session/prompt request",
      );

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

  test("keeps session metadata admitted while cancelled-turn transcript replay is closed", async () => {
    const harness = await createHarness({ metadataOnResume: true });

    try {
      const eventOffset = harness.events.length;
      const input = harness.backend.handleInput(
        harness.context,
        { text: "hang" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});
      await waitForAcpTestCondition(
        async () => (await harness.methods()).includes("session/prompt"),
        "ACP session/prompt request",
      );

      await harness.backend.cancelActiveTurn(harness.context, "test cancellation");
      await expect(input).rejects.toThrow("cancelled");

      expect(harness.events.slice(eventOffset).map((event) => event.kind)).toEqual(
        expect.arrayContaining([
          "session.commands.updated",
          "session.config.updated",
          "session.mode.updated",
          "session.info.updated",
          "run.cancelled",
        ]),
      );
    } finally {
      await harness.destroy();
    }
  });

  test("publishes a failed terminal even when fatal provider cleanup rejects", async () => {
    const harness = await createHarness();
    const promptRequested = Promise.withResolvers<void>();
    const prompt = Promise.withResolvers<{ stopReason: "end_turn" }>();
    const events: DriverEventInput[] = [];
    const turn = new AcpTurnController(async (_context, _reason, pushed) => {
      events.push(...pushed);
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
      notify: async () => {},
      request: async () => {
        promptRequested.resolve();
        return prompt.promise;
      },
    } as unknown as ClientContext;
    const providerError = new Error("provider transport failed");
    const cleanupError = new Error("provider cleanup failed");

    try {
      const input = turn.handleInput(
        harness.context,
        { text: "fail" },
        DRIVER_TEST_IDS.runId as RunId,
        connection,
        "native-session-1",
        clientRequests,
      );
      void input.catch(() => {});
      await promptRequested.promise;
      expect(turn.routeFatal(providerError, Promise.reject(cleanupError))).toBeNull();
      prompt.reject(providerError);

      await expect(input).rejects.toThrow("ACP provider failure cleanup failed");
      expect(events.filter((event) => event.kind === "run.failed")).toHaveLength(1);
      expect(events.some((event) => event.kind === "run.cancelled")).toBe(false);
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

  test("restores an explicitly rejected terminal settlement for authoritative replay", async () => {
    const harness = await createHarness();
    let rejectedSettlement: DriverEventInput[] | null = null;
    const turn = new AcpTurnController(
      async () => {},
      async () => {},
      async (_context, _reason, closures, terminal) => {
        rejectedSettlement = structuredClone([...closures, terminal]);
        throw new Error("terminal settlement rejected");
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
      notify: async () => {},
      request: async () => {
        await clientRequests.enqueueUpdate(harness.context, {
          sessionId: "native-session-1",
          update: {
            content: { text: "authoritative answer", type: "text" },
            messageId: "native-final",
            sessionUpdate: "agent_message_chunk",
          },
        });
        return { stopReason: "end_turn" };
      },
    } as unknown as ClientContext;

    try {
      await expect(
        turn.handleInput(
          harness.context,
          { text: "complete" },
          DRIVER_TEST_IDS.runId as RunId,
          connection,
          "native-session-1",
          clientRequests,
        ),
      ).rejects.toThrow("terminal settlement rejected");

      expect(turn.events.activeRunId()).toBe(DRIVER_TEST_IDS.runId);
      expect(turn.events.completePrompt("end_turn", null)).toEqual(rejectedSettlement);
    } finally {
      turn.events.clear();
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
      await waitForAcpTestCondition(
        async () => (await harness.responses()).length > 0,
        "ACP nested permission response",
      );
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

  test("closes 32 open tools before publishing the run terminal", async () => {
    const order: DriverEventInput[] = [];
    const harness = await createHarness({ onEvents: (events) => order.push(...events) });

    try {
      await expect(
        harness.backend.handleInput(
          harness.context,
          { text: "many-tools" },
          DRIVER_TEST_IDS.runId as RunId,
        ),
      ).resolves.toBeUndefined();

      const completedTools = order.filter(
        (event) =>
          event.kind === "tool.call.updated" &&
          (event.payload as { readonly status?: unknown }).status === "completed",
      );
      const completedItems = order.filter(
        (event) =>
          event.kind === "item.completed" &&
          (event.payload as { readonly status?: unknown }).status === "completed",
      );
      const terminalIndex = order.findIndex((event) => event.kind === "run.completed");

      expect(completedTools).toHaveLength(32);
      expect(completedItems).toHaveLength(32);
      expect(terminalIndex).toBe(order.length - 1);
      expect(harness.lifecycleFailures).toEqual([]);
    } finally {
      await harness.destroy();
    }
  });

  test("publishes one failed terminal after a sticky update inbox failure", async () => {
    const harness = await createHarness();

    try {
      harness.failNext("item.started");
      await expect(
        harness.backend.handleInput(
          harness.context,
          { text: "sticky-update-failure" },
          DRIVER_TEST_IDS.runId as RunId,
        ),
      ).rejects.toThrow("event sink unavailable");

      const terminals = harness.events.filter(
        (event) =>
          event.kind === "run.cancelled" ||
          event.kind === "run.completed" ||
          event.kind === "run.failed",
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.kind).toBe("run.failed");
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

      await waitForAcpTestCondition(
        async () => (await harness.methods()).includes("terminal/wait_for_exit"),
        "ACP terminal/wait_for_exit request",
      );

      expect(await harness.methods()).toContain("terminal/wait_for_exit");
      await harness.backend.cancelActiveTurn(harness.context, "test cancellation");
      await expect(input).rejects.toThrow("cancelled");

      await waitForAcpTestCondition(
        async () => (await harness.responses()).length > 0,
        "ACP nested terminal response",
      );

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

      await waitForAcpTestCondition(
        async () => (await harness.methods()).includes("session/prompt"),
        "ACP session/prompt request",
      );

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
        { kind: "tool.call.updated", status: "cancelled" },
        { kind: "item.completed", status: "cancelled" },
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

  test("fails an active turn after stop cleanup rejects and lets a later stop retry", async () => {
    const harness = await createHarness();

    try {
      const input = harness.backend.handleInput(
        harness.context,
        { text: "hang" },
        DRIVER_TEST_IDS.runId as RunId,
      );
      void input.catch(() => {});
      await waitForAcpTestCondition(
        async () => (await harness.methods()).includes("session/prompt"),
        "ACP session/prompt request",
      );

      const gate = harness.blockNext("usage.updated");
      const stop = harness.backend.stop(
        harness.context,
        "test failed stop",
        new AbortController().signal,
      );
      await gate.entered;
      await expect(stop).rejects.toThrow("ACP update drain");
      expect(
        harness.events.some(
          (event) =>
            event.kind === "run.cancelled" ||
            event.kind === "run.completed" ||
            event.kind === "run.failed",
        ),
      ).toBe(false);

      const retryStop = harness.backend.stop(
        harness.context,
        "test retry stop",
        new AbortController().signal,
      );
      gate.release();
      await expect(input).rejects.toThrow("cancelled turn process recycle failed");
      expect(
        harness.events
          .filter(
            (event) =>
              event.kind === "run.cancelled" ||
              event.kind === "run.completed" ||
              event.kind === "run.failed",
          )
          .map((event) => event.kind),
      ).toEqual(["run.failed"]);
      await expect(retryStop).resolves.toBeUndefined();
    } finally {
      await harness.destroy();
    }
  }, 10_000);

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
