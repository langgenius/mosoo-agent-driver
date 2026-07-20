import { afterEach, describe, expect, test } from "bun:test";
import {
  client as createAcpClient,
  methods as acpMethods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { ClientConnection } from "@agentclientprotocol/sdk";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  ACP_PROTOCOL_VERSION,
  buildClientCapabilities,
  assertProtocolVersion,
} from "../src/runtimes/acp/acp-configuration";
import { limitAcpInput } from "../src/runtimes/acp/acp-driver-backend";
import { settlePromiseWithTimeout } from "../src/utils/async";

interface OpenCodeAcpClient {
  readonly connection: ClientConnection;
  stop(): Promise<void>;
}

const OPENCODE_COMMAND_ENV = "AGENT_DRIVER_LIVE_OPENCODE_COMMAND";
const REQUEST_TIMEOUT_MS = 10_000;

const clients: OpenCodeAcpClient[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));

  for (const root of tempRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

function readOpenCodeCommand(): string {
  return process.env[OPENCODE_COMMAND_ENV]?.trim() || "opencode";
}

function hasOpenCodeAcpCommand(command: string): boolean {
  return spawnSync(command, ["acp", "--help"], { stdio: "ignore" }).status === 0;
}

async function createOpenCodeAcpPaths(): Promise<{ cwd: string; homePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agent-driver-opencode-acp-contract-"));
  const cwd = join(root, "workspace");
  const homePath = join(root, "home");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(homePath, { recursive: true })]);
  tempRoots.push(root);
  return { cwd, homePath };
}

function createOpenCodeAcpClient(input: {
  command: string;
  cwd: string;
  homePath: string;
}): OpenCodeAcpClient {
  const child = spawn(input.command, ["acp", "--pure"], {
    cwd: input.cwd,
    env: { ...process.env, HOME: input.homePath },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const inputStream = limitAcpInput(
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );
  const connection = createAcpClient({ name: "mosoo-driver-contract-test" }).connect(
    ndJsonStream(output, inputStream),
  );

  child.stderr.resume();

  return {
    connection,
    async stop() {
      connection.close(new Error("OpenCode ACP contract test stopped."));

      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      const stopped = await settlePromiseWithTimeout(closed, {
        label: "OpenCode ACP contract process exit",
        timeoutMs: 2_000,
      });

      if (stopped.status === "timed_out") {
        child.kill("SIGKILL");
        await settlePromiseWithTimeout(closed, {
          label: "OpenCode ACP contract process force exit",
          timeoutMs: 1_000,
        });
      }
    },
  };
}

async function requestWithTimeout<T>(
  connection: ClientConnection,
  label: string,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const result = await settlePromiseWithTimeout(request(controller.signal), {
    label,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  if (result.status === "completed") {
    return result.value;
  }

  controller.abort(result.error);

  if (result.status === "timed_out") {
    connection.close(result.error);
  }

  throw result.error;
}

const openCodeCommand = readOpenCodeCommand();
const contractTest = hasOpenCodeAcpCommand(openCodeCommand) ? test : test.skip;

describe("OpenCode ACP contract", () => {
  contractTest("initializes and creates a session through the official V1 SDK", async () => {
    const paths = await createOpenCodeAcpPaths();
    const client = createOpenCodeAcpClient({
      command: openCodeCommand,
      cwd: paths.cwd,
      homePath: paths.homePath,
    });
    clients.push(client);
    const initialize = await requestWithTimeout(
      client.connection,
      "OpenCode ACP initialize",
      (cancellationSignal) =>
        client.connection.agent.request(
          acpMethods.agent.initialize,
          {
            clientCapabilities: buildClientCapabilities(),
            clientInfo: {
              name: "mosoo-driver-contract-test",
              title: "mosoo Driver Contract Test",
              version: "0.1.0",
            },
            protocolVersion: ACP_PROTOCOL_VERSION,
          },
          { cancellationSignal },
        ),
    );
    assertProtocolVersion(initialize);

    expect(initialize.agentCapabilities?.mcpCapabilities?.http).toBe(true);
    expect(
      initialize.agentCapabilities?.loadSession === true ||
        initialize.agentCapabilities?.sessionCapabilities?.resume != null,
    ).toBe(true);
    expect((initialize.authMethods ?? []).map((method) => method.id)).toContain("opencode-login");

    const setup = await requestWithTimeout(
      client.connection,
      "OpenCode ACP session/new",
      (cancellationSignal) =>
        client.connection.agent.request(
          acpMethods.agent.session.new,
          {
            _meta: {
              "mosoo.ai/appAccessSnapshot": { entries: [] },
              "mosoo.ai/origin": { entrypoint: "test", type: "agent" },
              "mosoo.ai/sessionContext": {
                appAccessSnapshot: { entries: [] },
                homePath: paths.homePath,
                origin: { entrypoint: "test", type: "agent" },
                sandboxId: "sandbox-opencode-contract-test",
                sandboxKind: "cattle",
                sandboxSessionId: "sandbox-session-opencode-contract-test",
                sandboxSubjectId: "session-opencode-contract-test",
                sandboxSubjectKind: "session",
                sessionOrganizationPath: paths.cwd,
                spaceAliases: [],
              },
            },
            additionalDirectories: [],
            cwd: paths.cwd,
            mcpServers: [],
          },
          { cancellationSignal },
        ),
    );

    expect(setup.sessionId.trim().length).toBeGreaterThan(0);
  });
});
