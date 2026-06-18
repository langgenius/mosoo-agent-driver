import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  ACP_PROTOCOL_VERSION,
  enforceAcpProtocolVersion,
} from "../src/runtimes/acp/acp-configuration";
import {
  isRecord,
  parseAcpInitializeResult,
  parseAcpSessionSetupResult,
  readRecord,
} from "../src/runtimes/acp/acp-types";

type OpenCodeAcpProcess = ChildProcessByStdio<Writable, Readable, Readable>;

interface JsonRpcClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<void>;
}

const OPENCODE_COMMAND_ENV = "AGENT_DRIVER_LIVE_OPENCODE_COMMAND";
const REQUEST_TIMEOUT_MS = 10_000;

const clients: JsonRpcClient[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));

  for (const root of tempRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

function readEnvString(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function readOpenCodeCommand(): string {
  return readEnvString(OPENCODE_COMMAND_ENV) ?? "opencode";
}

function hasOpenCodeAcpCommand(command: string): boolean {
  const result = spawnSync(command, ["acp", "--help"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

async function createOpenCodeAcpPaths(): Promise<{
  cwd: string;
  homePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-driver-opencode-acp-contract-"));
  const cwd = join(root, "workspace");
  const homePath = join(root, "home");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(homePath, { recursive: true })]);
  tempRoots.push(root);

  return {
    cwd,
    homePath,
  };
}

async function readResponseLine(input: {
  id: number;
  lineIterator: AsyncIterator<string>;
  method: string;
  stderr: () => string;
}): Promise<unknown> {
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), REQUEST_TIMEOUT_MS);
  });

  while (true) {
    const result = await Promise.race([input.lineIterator.next(), timeout]);

    if (result === "timeout") {
      throw new Error(
        `Timed out waiting for OpenCode ACP ${input.method} response. stderr=${input.stderr()}`,
      );
    }

    if (result.done) {
      throw new Error(
        `OpenCode ACP process closed before ${input.method} response. stderr=${input.stderr()}`,
      );
    }

    const message: unknown = JSON.parse(result.value);

    if (!isRecord(message)) {
      continue;
    }

    if (message["id"] !== input.id) {
      continue;
    }

    if ("error" in message) {
      throw new Error(JSON.stringify(message["error"]));
    }

    return message["result"];
  }
}

function createOpenCodeAcpClient(input: {
  command: string;
  cwd: string;
  homePath: string;
}): JsonRpcClient {
  const child = spawn(input.command, ["acp", "--pure"], {
    cwd: input.cwd,
    env: {
      ...process.env,
      HOME: input.homePath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as OpenCodeAcpProcess;
  const lines: Interface = createInterface({ input: child.stdout });
  const lineIterator = lines[Symbol.asyncIterator]();
  let nextId = 1;
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      child.stdin.write(
        `${JSON.stringify({
          id,
          jsonrpc: "2.0",
          method,
          params,
        })}\n`,
      );
      return readResponseLine({
        id,
        lineIterator,
        method,
        stderr: () => stderr.trim(),
      });
    },
    async stop() {
      lines.close();

      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        };
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          finish();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          finish();
        });
      });
    },
  };
}

const openCodeCommand = readOpenCodeCommand();
const contractTest = hasOpenCodeAcpCommand(openCodeCommand) ? test : test.skip;

describe("OpenCode ACP contract", () => {
  test("JSON-RPC response reader skips notifications until the matching response id", async () => {
    async function* lines(): AsyncGenerator<string> {
      yield* [
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {},
        }),
        JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          result: {
            wrong: true,
          },
        }),
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          result: {
            ok: true,
          },
        }),
      ];
    }

    const lineIterator = lines();

    await expect(
      readResponseLine({
        id: 1,
        lineIterator,
        method: "test/method",
        stderr: () => "",
      }),
    ).resolves.toEqual({ ok: true });
  });

  contractTest("initializes and creates a session with the generic ACP parser", async () => {
    const paths = await createOpenCodeAcpPaths();
    const client = createOpenCodeAcpClient({
      command: openCodeCommand,
      cwd: paths.cwd,
      homePath: paths.homePath,
    });
    clients.push(client);

    const initialize = parseAcpInitializeResult(
      await client.request("initialize", {
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
        clientInfo: {
          name: "mosoo-driver-contract-test",
          title: "Mosoo Driver Contract Test",
          version: "0.1.0",
        },
        protocolVersion: ACP_PROTOCOL_VERSION,
      }),
    );
    enforceAcpProtocolVersion(initialize);

    const agentCapabilities = initialize.agentCapabilities;
    const mcpCapabilities = readRecord(agentCapabilities, "mcpCapabilities");
    const sessionCapabilities = readRecord(agentCapabilities, "sessionCapabilities");

    expect(mcpCapabilities?.["http"]).toBe(true);
    expect(
      agentCapabilities?.["loadSession"] === true || isRecord(sessionCapabilities?.["resume"]),
    ).toBe(true);
    expect(initialize.authMethods.map((method) => method.id)).toContain("opencode-login");

    const setup = parseAcpSessionSetupResult(
      await client.request("session/new", {
        _meta: {
          "mosoo.ai/appAccessSnapshot": {
            entries: [],
          },
          "mosoo.ai/origin": {
            entrypoint: "test",
            type: "agent",
          },
          "mosoo.ai/sessionContext": {
            appAccessSnapshot: {
              entries: [],
            },
            homePath: paths.homePath,
            origin: {
              entrypoint: "test",
              type: "agent",
            },
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
      }),
    );

    expect(typeof setup.sessionId).toBe("string");
    expect(setup.sessionId?.length ?? 0).toBeGreaterThan(0);
  });
});
