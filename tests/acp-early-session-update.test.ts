import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
import { driverBootPayload, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

// Real-process stub with the OpenClaw Gateway bridge's observed wire order:
// session/update notifications for the newly created session are written
// BEFORE the session/new response. Captured from openclaw acp 2026.7.1-2.
const BRIDGE_AGENT = String.raw`
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const sessionId = "acp-bridge-session-1";
const handle = (message) => {
  if (!("method" in message) || !("id" in message)) return;
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        jsonrpc: "2.0",
        result: {
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { audio: false, embeddedContext: true, image: true },
            sessionCapabilities: { close: {}, list: {} },
          },
          agentInfo: { name: "openclaw-acp-stub", version: "0.0.0" },
          authMethods: [],
          protocolVersion: 1,
        },
      });
      return;
    case "session/new": {
      if (process.env.BRIDGE_STUB_EARLY === "foreign") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "some-other-session",
            update: { sessionUpdate: "session_info_update", title: "foreign" },
          },
        });
      } else {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "session_info_update", title: "acp-bridge:stub" },
          },
        });
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              availableCommands: [{ description: "Show help.", name: "help" }],
              sessionUpdate: "available_commands_update",
            },
          },
        });
      }
      send({ id: message.id, jsonrpc: "2.0", result: { sessionId } });
      return;
    }
    case "session/prompt":
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            content: { text: "OPENCLAW-COPILOT-E2E", type: "text" },
            sessionUpdate: "agent_message_chunk",
          },
        },
      });
      send({ id: message.id, jsonrpc: "2.0", result: { stopReason: "end_turn" } });
      return;
    case "session/close":
      send({ id: message.id, jsonrpc: "2.0", result: {} });
      return;
    default:
      send({
        error: { code: -32601, message: "method not found" },
        id: message.id,
        jsonrpc: "2.0",
      });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) handle(JSON.parse(line));
    index = buffer.indexOf("\n");
  }
});
`;

async function createBridgeHarness(early: "foreign" | "match") {
  const root = await mkdtemp(join(tmpdir(), "driver-acp-early-update-"));
  const boot = {
    ...driverBootPayload,
    execution: {
      ...driverBootPayload.execution,
      environment: {
        variables: { BRIDGE_STUB_EARLY: early },
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
    service: "acp-early-update-test",
    sink: async () => {},
  });
  let acceptedSeq = 0;
  const publishedEvents: DriverEventInput[] = [];
  const context = createAgentDriverContext({
    eventSink: {
      pushEvents: async ({ events }) => {
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
  process.env["MOSOO_ACP_FALLBACK_COMMAND"] = process.execPath;
  process.env["MOSOO_ACP_FALLBACK_ARGS"] = JSON.stringify(["-e", BRIDGE_AGENT]);

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
    context,
    async destroy() {
      await backend.stop(context, "test cleanup", new AbortController().signal).catch(() => {});
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    },
    events: publishedEvents,
  };
}

describe("ACP early session updates", () => {
  test("completes a prompt when the agent notifies before the session/new response", async () => {
    const harness = await createBridgeHarness("match");

    try {
      await expect(
        harness.backend.handleInput(
          harness.context,
          { text: "Reply exactly: OPENCLAW-COPILOT-E2E" },
          DRIVER_TEST_IDS.runId as RunId,
        ),
      ).resolves.toBeUndefined();

      const kinds = harness.events.map((event) => event.kind);
      expect(kinds).toContain("session.created");
      expect(kinds).toContain("run.completed");
      const delta = harness.events.find((event) => event.kind === "message.delta");
      expect((delta?.payload as { contentDelta?: string } | undefined)?.contentDelta).toBe(
        "OPENCLAW-COPILOT-E2E",
      );
      // The deferred pre-registration updates are applied, not lost.
      expect(kinds).toContain("session.info.updated");
      expect(kinds).toContain("session.commands.updated");
    } finally {
      await harness.destroy();
    }
  });

  test("drops a pre-registration update for a foreign session without failing the turn", async () => {
    const harness = await createBridgeHarness("foreign");

    try {
      await expect(
        harness.backend.handleInput(
          harness.context,
          { text: "Reply exactly: OPENCLAW-COPILOT-E2E" },
          DRIVER_TEST_IDS.runId as RunId,
        ),
      ).resolves.toBeUndefined();

      const kinds = harness.events.map((event) => event.kind);
      expect(kinds).toContain("run.completed");
      expect(kinds).not.toContain("session.info.updated");
    } finally {
      await harness.destroy();
    }
  });
});
