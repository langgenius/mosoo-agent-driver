import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { AgentDriverPermissionPort } from "../src/host-ports";
import { createDisabledLogger } from "../src/observability";
import type { DriverExecutionEnvironment } from "../src/protocol/boot";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { PermissionEventDeliveryError } from "../src/core/driver-permission-broker";
import * as childProcessHelpers from "../src/runtimes/child-process";
import { OpenAiAppServerClient, limitNdjsonLines } from "../src/runtimes/openai/app-server-client";
import * as openAiAuthState from "../src/runtimes/openai/auth-state";
import type { ServerNotificationMethod } from "../src/runtimes/openai/app-server-protocol";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { driverBootPayload } from "./driver-boot-payload-fixture";

const originalExecutable = process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"];
const temporaryDirectories: string[] = [];
const initializeResult = {
  codexHome: "/tmp/openai-home",
  platformFamily: "unix",
  platformOs: "linux",
  userAgent: "test-app-server/0.152.0",
} as const;
const initializeResultJson = JSON.stringify(initializeResult);
const nativeResumeResultJson = JSON.stringify({
  activePermissionProfile: null,
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  cwd: "/workspace",
  instructionSources: [],
  model: "gpt-5.6",
  modelProvider: "openai",
  multiAgentMode: "explicitRequestOnly",
  reasoningEffort: "high",
  runtimeWorkspaceRoots: ["/workspace"],
  sandbox: {
    excludeSlashTmp: false,
    excludeTmpdirEnvVar: false,
    networkAccess: false,
    type: "workspaceWrite",
    writableRoots: ["/workspace"],
  },
  serviceTier: null,
  thread: {
    agentNickname: null,
    agentRole: null,
    canAcceptDirectInput: true,
    cliVersion: "0.152.0",
    createdAt: 1,
    cwd: "/workspace",
    ephemeral: false,
    extra: null,
    forkedFromId: null,
    gitInfo: null,
    historyMode: "paginated",
    id: "thread-1",
    modelProvider: "openai",
    name: null,
    parentThreadId: null,
    path: null,
    preview: "retained",
    projectId: null,
    recencyAt: null,
    section: null,
    sectionEnteredAt: null,
    sessionId: "thread-1",
    source: "appServer",
    status: { type: "idle" },
    threadSource: null,
    turns: [],
    updatedAt: 2,
  },
});

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return (
      process.platform !== "linux" ||
      !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    );
  } catch {
    return false;
  }
}

async function expectProcessExited(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (isProcessRunning(pid) && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  expect(isProcessRunning(pid)).toBe(false);
}

async function createClientHarness(
  script: (directory: string) => string,
  handleNotification: (method: ServerNotificationMethod) => Promise<void> = async () => {},
  requestPermission: AgentDriverPermissionPort["request"] = async () => "allow_once",
  interpreter = "bun",
  environment: DriverExecutionEnvironment = driverBootPayload.execution.environment,
  runtimeOptions: { driverGeneration?: number; homePath?: string } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "mosoo-openai-client-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "fake-app-server");
  await Bun.write(executable, `#!/usr/bin/env ${interpreter}\n${script(directory)}`);
  await chmod(executable, 0o755);
  process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"] = executable;

  const payload = createDriverStartInputFromBootPayload({
    ...driverBootPayload,
    driverGeneration: runtimeOptions.driverGeneration ?? driverBootPayload.driverGeneration,
    execution: {
      ...driverBootPayload.execution,
      environment,
      session: {
        ...driverBootPayload.execution.session,
        context: {
          ...driverBootPayload.execution.session.context,
          homePath: runtimeOptions.homePath ?? join(directory, "home"),
          sessionOrganizationPath: directory,
        },
        cwd: directory,
      },
    },
  });
  const context = createAgentDriverContext({
    eventSink: {
      currentRunId: () => null,
      pushEvents: async () => ({ accepted: [] }),
    },
    logger: createDisabledLogger(),
    payload,
    permission: { request: requestPermission },
  });
  const protocolErrors: Error[] = [];
  const protocolError = Promise.withResolvers<Error>();
  const client = new OpenAiAppServerClient(payload, {
    ...context,
    handleNotification,
    handleProtocolError: async (error) => {
      protocolErrors.push(error);
      protocolError.resolve(error);
    },
    mapToolCallId: (toolCallId) => toolCallId,
  });

  return { client, directory, protocolError: protocolError.promise, protocolErrors };
}

afterEach(async () => {
  if (originalExecutable === undefined) {
    delete process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"];
  } else {
    process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"] = originalExecutable;
  }

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("OpenAi app-server client", () => {
  test("keeps transient API-key auth for the fake app-server lifetime", async () => {
    const harness = await createClientHarness(
      (directory) => `
await Bun.write(${JSON.stringify(join(directory, "runtime-env.json"))}, JSON.stringify({
  codexHome: process.env.CODEX_HOME,
  sqliteHome: process.env.CODEX_SQLITE_HOME,
}));
await Bun.write(process.env.CODEX_SQLITE_HOME + "/state.sqlite", "sqlite-state");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
      undefined,
      undefined,
      "bun",
      {
        ...driverBootPayload.execution.environment,
        variables: { OPENAI_API_KEY: "client-lifetime-key" },
      },
    );

    try {
      await harness.client.start();
      const runtimeEnv = JSON.parse(
        await readFile(join(harness.directory, "runtime-env.json"), "utf8"),
      ) as { codexHome: string; sqliteHome: string };
      const authJsonPath = join(runtimeEnv.codexHome, "auth.json");

      expect(runtimeEnv.codexHome).not.toBe(join(harness.directory, "home"));
      expect(runtimeEnv.sqliteHome).toBe(join(harness.directory, "home"));
      expect((await lstat(authJsonPath)).isFile()).toBe(true);
      expect((await lstat(authJsonPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(authJsonPath, "utf8"))).toMatchObject({
        OPENAI_API_KEY: "client-lifetime-key",
      });
      await expect(harness.client.start()).rejects.toThrow("cannot be started more than once");
      expect(await readFile(authJsonPath, "utf8")).toContain("client-lifetime-key");
      await harness.client.stop();
      await expect(lstat(runtimeEnv.codexHome)).rejects.toThrow();
      expect((await lstat(join(runtimeEnv.sqliteHome, "sessions"))).isDirectory()).toBe(true);
      expect(await readFile(join(runtimeEnv.sqliteHome, "state.sqlite"), "utf8")).toBe(
        "sqlite-state",
      );
      await expect(lstat(join(runtimeEnv.sqliteHome, "auth.json"))).rejects.toThrow();
    } finally {
      await harness.client.stop().catch(() => {});
    }
  });

  test("cleans transient API-key auth when fake app-server startup fails", async () => {
    const harness = await createClientHarness(
      (directory) => `
await Bun.write(${JSON.stringify(join(directory, "failed-runtime-home"))}, process.env.CODEX_HOME);
process.stdin.once("data", (chunk) => {
  const request = JSON.parse(String(chunk).trim());
  process.stdout.write(JSON.stringify({
    error: { code: -32000, message: "initialize rejected" },
    id: request.id,
  }) + "\\n");
});
setInterval(() => {}, 1000);
`,
      undefined,
      undefined,
      "bun",
      {
        ...driverBootPayload.execution.environment,
        variables: { OPENAI_API_KEY: "failed-start-key" },
      },
    );

    try {
      await expect(harness.client.start()).rejects.toThrow("initialize rejected");
      const runtimeHome = await readFile(join(harness.directory, "failed-runtime-home"), "utf8");
      await expect(lstat(runtimeHome)).rejects.toThrow();
      await expect(lstat(join(harness.directory, "home", "auth.json"))).rejects.toThrow();
    } finally {
      await harness.client.stop().catch(() => {});
    }
  });

  test("lists and resumes persistent native state across Driver generations", async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), "mosoo-openai-native-state-"));
    temporaryDirectories.push(sharedRoot);
    const persistentRuntimeHome = join(sharedRoot, "home");
    const environment = {
      ...driverBootPayload.execution.environment,
      variables: { OPENAI_API_KEY: "native-state-key" },
    };
    const first = await createClientHarness(
      (directory) => `
await Bun.write(process.env.CODEX_HOME + "/sessions/thread-1.jsonl", "rollout");
await Bun.write(process.env.CODEX_SQLITE_HOME + "/state.sqlite", "sqlite");
await Bun.write(${JSON.stringify(join(directory, "runtime-home"))}, process.env.CODEX_HOME);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.id !== undefined) {
      process.stdout.write(JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
      undefined,
      undefined,
      "bun",
      environment,
      { driverGeneration: 1, homePath: persistentRuntimeHome },
    );

    let firstRuntimeHome = "";
    try {
      await first.client.start();
      firstRuntimeHome = await readFile(join(first.directory, "runtime-home"), "utf8");
    } finally {
      await first.client.stop().catch(() => {});
    }
    await expect(lstat(firstRuntimeHome)).rejects.toThrow();
    expect(await readFile(join(persistentRuntimeHome, "sessions", "thread-1.jsonl"), "utf8")).toBe(
      "rollout",
    );
    expect(await readFile(join(persistentRuntimeHome, "state.sqlite"), "utf8")).toBe("sqlite");

    const successor = await createClientHarness(
      (directory) => `
import { readdirSync, readFileSync } from "node:fs";
await Bun.write(${JSON.stringify(join(directory, "observation.json"))}, JSON.stringify({
  codexHome: process.env.CODEX_HOME,
  sessions: readdirSync(process.env.CODEX_HOME + "/sessions"),
  sqlite: readFileSync(process.env.CODEX_SQLITE_HOME + "/state.sqlite", "utf8"),
}));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.id === undefined) continue;
    const result = request.method === "thread/resume"
      ? ${nativeResumeResultJson}
      : ${initializeResultJson};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
      undefined,
      undefined,
      "bun",
      environment,
      { driverGeneration: 2, homePath: persistentRuntimeHome },
    );

    try {
      await successor.client.start();
      const observation = JSON.parse(
        await readFile(join(successor.directory, "observation.json"), "utf8"),
      ) as { codexHome: string; sessions: string[]; sqlite: string };
      expect(observation.codexHome).not.toBe(firstRuntimeHome);
      expect(observation.sessions).toContain("thread-1.jsonl");
      expect(observation.sqlite).toBe("sqlite");
      await expect(
        successor.client.request("thread/resume", { threadId: "thread-1" }),
      ).resolves.toMatchObject({ thread: { id: "thread-1" } });
      await successor.client.stop();
      await expect(lstat(observation.codexHome)).rejects.toThrow();
    } finally {
      await successor.client.stop().catch(() => {});
    }
  });

  test("declares only initialized server-request capabilities it handles", async () => {
    const harness = await createClientHarness(
      (directory) => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.method === "initialize") {
      await Bun.write(${JSON.stringify(join(directory, "initialize.json"))}, JSON.stringify(request));
      process.stdout.write(JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n");
    } else if (request.method === "initialized") {
      await Bun.write(${JSON.stringify(join(directory, "initialized.json"))}, JSON.stringify(request));
    }
  }
});
setInterval(() => {}, 1000);
`,
    );

    try {
      await harness.client.start();
      const request = JSON.parse(
        await Bun.file(join(harness.directory, "initialize.json")).text(),
      ) as { params: { capabilities: unknown } };

      expect(request.params.capabilities).toEqual({
        experimentalApi: true,
        requestAttestation: false,
      });
      for (
        let attempt = 0;
        attempt < 50 && !(await Bun.file(join(harness.directory, "initialized.json")).exists());
        attempt += 1
      ) {
        await Bun.sleep(5);
      }
      expect(
        JSON.parse(await Bun.file(join(harness.directory, "initialized.json")).text()),
      ).toEqual({ method: "initialized" });
    } finally {
      await harness.client.stop();
    }
  });

  test("rejects a malformed approval before requesting host permission", async () => {
    let permissionRequests = 0;
    const harness = await createClientHarness(
      () => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: ${initializeResultJson} }) + "\\n");
    } else if (message.method === "initialized") {
      process.stdout.write(JSON.stringify({
        id: 41,
        method: "item/commandExecution/requestApproval",
        params: {},
      }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
      undefined,
      async () => {
        permissionRequests += 1;
        return "allow_once";
      },
    );

    try {
      await harness.client.start();

      for (let attempt = 0; attempt < 50 && harness.protocolErrors.length === 0; attempt += 1) {
        await Bun.sleep(5);
      }

      expect(permissionRequests).toBe(0);
      expect(harness.protocolErrors).toHaveLength(1);
    } finally {
      await harness.client.stop();
    }
  });

  test("rejects an oversized stdout message across chunk boundaries", async () => {
    const output = Readable.from([Buffer.from("123"), Buffer.from("45")]).pipe(limitNdjsonLines(4));

    await expect(Array.fromAsync(output)).rejects.toThrow("exceeds 4 bytes");
  });

  test("resets the stdout message limit at newlines across chunk boundaries", async () => {
    const output = Readable.from([Buffer.from("1234\n12"), Buffer.from("34\n")]).pipe(
      limitNdjsonLines(4),
    );

    expect(Buffer.concat(await Array.fromAsync(output)).toString()).toBe("1234\n1234\n");
  });

  test("rejects an oversized stdout message ending at a newline", async () => {
    const output = Readable.from([Buffer.from("12345\n")]).pipe(limitNdjsonLines(4));

    await expect(Array.fromAsync(output)).rejects.toThrow("exceeds 4 bytes");
  });

  test.each([
    ["non-JSON", "not-json", "stdout is not valid JSON"],
    ["non-object", "[]", "protocol message must be an object"],
    ["unframed object", "{}", "requires a valid method or id"],
  ] as const)("fails the protocol for %s stdout", async (_label, line, message) => {
    const harness = await createClientHarness(
      () => `
process.stdin.once("data", () => {
  process.stdout.write(${JSON.stringify(`${line}\n`)});
});
setInterval(() => {}, 1000);
`,
    );

    try {
      await expect(harness.client.start()).rejects.toThrow(message);
      expect(harness.protocolErrors).toHaveLength(1);
      expect(harness.protocolErrors[0]?.message).toContain(message);
    } finally {
      await harness.client.stop();
    }
  });

  test("handles an admitted notification before a later malformed frame", async () => {
    const notificationEntered = Promise.withResolvers<void>();
    const notificationGate = Promise.withResolvers<void>();
    let notificationCompleted = false;
    const harness = await createClientHarness(
      () => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n");
    } else if (request.method === "initialized") {
      process.stdout.write(
        JSON.stringify({ method: "skills/changed", params: {} }) + "\\nnot-json\\n",
      );
    }
  }
});
setInterval(() => {}, 1000);
`,
      async () => {
        notificationEntered.resolve();
        await notificationGate.promise;
        notificationCompleted = true;
      },
    );

    try {
      await harness.client.start();
      await notificationEntered.promise;
      expect(harness.protocolErrors).toEqual([]);

      notificationGate.resolve();
      expect((await harness.protocolError).message).toContain("stdout is not valid JSON");
      expect(notificationCompleted).toBe(true);
    } finally {
      notificationGate.resolve();
      await harness.client.stop();
    }
  });

  test.each([
    [
      "both result and error",
      { error: { code: -32_000, message: "failed" }, id: 1, result: initializeResult },
    ],
    ["neither result nor error", { id: 1 }],
    ["primitive error", { error: "failed", id: 1 }],
    ["non-integer error code", { error: { code: "-32000", message: "failed" }, id: 1 }],
    ["non-string error message", { error: { code: -32_000, message: 7 }, id: 1 }],
  ] as const)("fails the protocol for a response with %s", async (_label, response) => {
    const harness = await createClientHarness(
      () => `
process.stdin.once("data", () => {
  process.stdout.write(${JSON.stringify(`${JSON.stringify(response)}\n`)});
});
setInterval(() => {}, 1000);
`,
    );

    try {
      await expect(harness.client.start()).rejects.toThrow("response envelope is invalid");
      expect(harness.protocolErrors).toHaveLength(1);
      expect(harness.protocolErrors[0]?.message).toContain("response envelope is invalid");
    } finally {
      await harness.client.stop();
    }
  });

  test("rejects a response that also claims to be a server message", async () => {
    const harness = await createClientHarness(
      () => `
process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({
    id: 1,
    method: "warning",
    params: { message: "not a response", threadId: null },
    result: ${initializeResultJson},
  }) + "\\n");
});
setInterval(() => {}, 1000);
`,
    );

    try {
      await expect(harness.client.start()).rejects.toThrow("response envelope is invalid");
      expect(harness.protocolErrors).toHaveLength(1);
    } finally {
      await harness.client.stop();
    }
  });

  test("stops after a malformed known notification", async () => {
    const handled: ServerNotificationMethod[] = [];
    const harness = await createClientHarness(
      () => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: ${initializeResultJson} }) + "\\n");
    } else if (message.method === "initialized") {
      process.stdout.write(JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "inProgress" } },
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        method: "warning",
        params: { message: "must not be handled", threadId: null },
      }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
      async (method) => {
        handled.push(method);
      },
    );

    try {
      await harness.client.start();
      for (let attempt = 0; attempt < 50 && harness.protocolErrors.length === 0; attempt += 1) {
        await Bun.sleep(5);
      }

      expect(harness.protocolErrors).toHaveLength(1);
      expect(handled).toEqual([]);
    } finally {
      await harness.client.stop();
    }
  });

  test("fails the protocol for a duplicate pending server-request id", async () => {
    const permissionStarted = Promise.withResolvers<void>();
    const permissionAborted = Promise.withResolvers<void>();
    let permissionRequests = 0;
    const harness = await createClientHarness(
      () => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: ${initializeResultJson} }) + "\\n");
    } else if (message.method === "initialized") {
      const request = {
        id: 41,
        method: "item/commandExecution/requestApproval",
        params: { environmentId: null, itemId: "item-1", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" },
      };
      process.stdout.write(JSON.stringify(request) + "\\n");
      process.stdout.write(JSON.stringify(request) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
      undefined,
      async (_input, signal) => {
        permissionRequests += 1;
        permissionStarted.resolve();
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        permissionAborted.resolve();
        return "reject_once";
      },
    );

    try {
      await harness.client.start();
      await permissionStarted.promise;
      for (let attempt = 0; attempt < 50 && harness.protocolErrors.length === 0; attempt += 1) {
        await Bun.sleep(5);
      }

      expect(harness.protocolErrors).toHaveLength(1);
      expect(harness.protocolErrors[0]?.message).toContain("already pending");
      expect(permissionRequests).toBe(1);
      await permissionAborted.promise;
    } finally {
      await harness.client.stop();
    }
  });

  test("keeps a valid JSON-RPC error scoped to its request", async () => {
    const harness = await createClientHarness(
      () => `
process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({
    error: { code: -32600, data: { reason: "test" }, message: "initialize denied" },
    id: 1,
  }) + "\\n");
});
setInterval(() => {}, 1000);
`,
    );

    try {
      await expect(harness.client.start()).rejects.toThrow("initialize denied");
      expect(harness.protocolErrors).toEqual([]);
    } finally {
      await harness.client.stop();
    }
  });

  test("fails the protocol when initialize returns an invalid result", async () => {
    const harness = await createClientHarness(
      () => `
process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
});
setInterval(() => {}, 1000);
`,
    );

    try {
      await expect(harness.client.start()).rejects.toThrow("codexHome");
      expect(harness.protocolErrors).toHaveLength(1);
      await expect(
        harness.client.request("initialize", {
          capabilities: { experimentalApi: true, requestAttestation: false },
          clientInfo: { name: "test", title: null, version: "1" },
        }),
      ).rejects.toThrow("stopping");
    } finally {
      await harness.client.stop();
    }
  });

  test("fails the protocol when turn/start returns contradictory status and error", async () => {
    const harness = await createClientHarness(
      () => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n");
    } else if (request.method === "turn/start") {
      process.stdout.write(JSON.stringify({
        id: request.id,
        result: { turn: { error: null, id: "turn-1", items: [], status: "failed" } },
      }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
    );

    try {
      await harness.client.start();
      await expect(
        harness.client.request("turn/start", { input: [], threadId: "thread-1" }),
      ).rejects.toThrow("turn.error must be present exactly when the turn failed");
      expect(harness.protocolErrors).toHaveLength(1);
    } finally {
      await harness.client.stop();
    }
  });

  test.each(["asynchronous", "synchronous"] as const)(
    "rejects a child process %s spawn failure without retaining ownership",
    async (failure) => {
      const harness = await createClientHarness(() => "");
      process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"] =
        failure === "asynchronous" ? join(harness.directory, "missing") : "invalid\0executable";

      try {
        await expect(harness.client.start()).rejects.toThrow();
        await expect(harness.client.stop()).resolves.toBeUndefined();
        await expect(harness.client.stop()).resolves.toBeUndefined();
      } finally {
        await harness.client.stop();
      }
    },
  );

  test.each(["unavailable", "error"] as const)(
    "fails closed when the process-tree watchdog is %s",
    async (failure) => {
      const watchdogProcess = new EventEmitter() as ChildProcess;
      const watchdogCleanup = Promise.withResolvers<void>();
      const watchdogCreated = Promise.withResolvers<void>();
      let childPid = 0;
      const watchdogSpy = spyOn(
        childProcessHelpers,
        "spawnLinuxProcessTreeWatchdog",
      ).mockImplementation((rootPid) => {
        childPid = rootPid;
        watchdogCreated.resolve();
        return failure === "unavailable"
          ? null
          : { cleanup: watchdogCleanup.promise, process: watchdogProcess };
      });
      const harness = await createClientHarness(
        () => `
process.stdin.resume();
setInterval(() => {}, 1000);
`,
      );

      try {
        const start = harness.client.start();
        void start.catch(() => {});
        await watchdogCreated.promise;
        if (failure === "error") {
          watchdogCleanup.reject(new Error("watchdog lease failed"));
        }

        await expect(start).rejects.toThrow("process-tree watchdog");
        await expectProcessExited(childPid, 250);
        expect(harness.protocolErrors.some((error) => error.message.includes("watchdog"))).toBe(
          true,
        );
      } finally {
        watchdogSpy.mockRestore();
        if (childPid > 0) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {}
        }
        await harness.client.stop().catch(() => {});
      }
    },
  );

  test("does not spawn after stop wins a startup race", async () => {
    const harness = await createClientHarness(
      (directory) => `
await Bun.write(${JSON.stringify(join(directory, "spawned"))}, "spawned");
setInterval(() => {}, 1000);
`,
    );

    try {
      const start = harness.client.start();
      void start.catch(() => {});
      const stop = harness.client.stop();

      await expect(stop).resolves.toBeUndefined();
      await expect(start).rejects.toThrow("stopped during startup");
      expect(await Bun.file(join(harness.directory, "spawned")).exists()).toBe(false);
    } finally {
      await harness.client.stop();
    }
  });

  test.each(["home", "auth"] as const)(
    "waits for in-flight %s setup before cleaning the private runtime home",
    async (phase) => {
      const entered = Promise.withResolvers<string>();
      const release = Promise.withResolvers<void>();
      const nativeCreate = openAiAuthState.createOpenAiRuntimeHome;
      const nativeAuth = openAiAuthState.materializeOpenAiAuthState;
      const createSpy = spyOn(openAiAuthState, "createOpenAiRuntimeHome");
      const authSpy = spyOn(openAiAuthState, "materializeOpenAiAuthState");

      if (phase === "home") {
        createSpy.mockImplementation(async (input) => {
          const state = await nativeCreate(input);
          entered.resolve(state.runtimeHome);
          await release.promise;
          return state;
        });
      } else {
        authSpy.mockImplementation(async (input) => {
          entered.resolve(input.runtimeHome);
          await release.promise;
          return nativeAuth(input);
        });
      }

      const harness = await createClientHarness(
        (directory) => `
await Bun.write(${JSON.stringify(join(directory, "setup-race-spawned"))}, "spawned");
setInterval(() => {}, 1000);
`,
        undefined,
        undefined,
        "bun",
        {
          ...driverBootPayload.execution.environment,
          variables: { OPENAI_API_KEY: "setup-race-key" },
        },
      );

      try {
        const start = harness.client.start();
        void start.catch(() => {});
        const runtimeHome = await entered.promise;
        const stop = harness.client.stop();

        await expect(
          settlePromiseWithTimeout(stop, {
            label: "OpenAI setup-barrier stop",
            timeoutMs: 25,
          }),
        ).resolves.toMatchObject({ status: "timed_out" });
        expect((await lstat(runtimeHome)).isDirectory()).toBe(true);

        release.resolve();
        await expect(stop).resolves.toBeUndefined();
        await expect(start).rejects.toThrow("stopped during startup");
        await expect(lstat(runtimeHome)).rejects.toThrow();
        expect(await Bun.file(join(harness.directory, "setup-race-spawned")).exists()).toBe(false);
      } finally {
        release.resolve();
        createSpy.mockRestore();
        authSpy.mockRestore();
        await harness.client.stop().catch(() => {});
      }
    },
  );

  test("cleans its private runtime home when startup is aborted", async () => {
    const harness = await createClientHarness(
      (directory) => `
await Bun.write(${JSON.stringify(join(directory, "aborted-runtime-home"))}, process.env.CODEX_HOME);
process.stdin.resume();
setInterval(() => {}, 1000);
`,
      undefined,
      undefined,
      "bun",
      {
        ...driverBootPayload.execution.environment,
        variables: { OPENAI_API_KEY: "aborted-start-key" },
      },
    );
    const controller = new AbortController();

    try {
      const start = harness.client.start(controller.signal);
      void start.catch(() => {});
      const runtimeHomeFile = Bun.file(join(harness.directory, "aborted-runtime-home"));
      for (let attempt = 0; attempt < 100 && !(await runtimeHomeFile.exists()); attempt += 1) {
        await Bun.sleep(5);
      }
      const runtimeHome = await runtimeHomeFile.text();
      controller.abort(new Error("startup aborted"));

      await expect(start).rejects.toThrow("startup aborted");
      await expect(lstat(runtimeHome)).rejects.toThrow();
      await expect(lstat(join(harness.directory, "home", "auth.json"))).rejects.toThrow();
    } finally {
      controller.abort();
      await harness.client.stop().catch(() => {});
    }
  });

  test("admits only one concurrent start", async () => {
    const harness = await createClientHarness(
      (directory) => `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(directory, "pids"))}, String(process.pid) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.id !== undefined) {
      process.stdout.write(
        JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n",
      );
    }
  }
});
setTimeout(() => process.exit(0), 500);
`,
    );

    try {
      const outcomes = await Promise.allSettled([harness.client.start(), harness.client.start()]);

      expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
        reason: { message: "OpenAi app-server client cannot be started more than once." },
      });
      expect(
        (await Bun.file(join(harness.directory, "pids")).text()).trim().split("\n"),
      ).toHaveLength(1);
    } finally {
      await harness.client.stop();
    }
  });

  test("rejects a pending client request when the process stops", async () => {
    const harness = await createClientHarness(
      () => `
let buffer = "";
let requests = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    requests += 1;
    if (requests === 1) {
      process.stdout.write(
        JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n",
      );
    }
  }
});
setInterval(() => {}, 1000);
`,
    );

    try {
      await harness.client.start();
      const request = harness.client.request("initialize", {
        capabilities: { experimentalApi: true, requestAttestation: false },
        clientInfo: { name: "test", title: null, version: "1" },
      });
      const stop = harness.client.stop();

      await expect(request).rejects.toThrow("app-server stopped");
      await expect(stop).resolves.toBeUndefined();
    } finally {
      await harness.client.stop();
    }
  });

  test("injects artifact paths and reports process exit after queued server messages", async () => {
    const runtimePath = process.env["PATH"] ?? "";
    const harness = await createClientHarness(
      (directory) => `
await Bun.write(${JSON.stringify(join(directory, "environment-path"))}, process.env.PATH ?? "");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  process.stdout.write(JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n");
  setTimeout(() => process.exit(17), 25);
});
`,
      undefined,
      undefined,
      undefined,
      {
        paths: { executable: ["/artifact/bin"], node: [], python: [] },
        variables: { PATH: runtimePath },
      },
    );

    try {
      await harness.client.start();

      expect(await Bun.file(join(harness.directory, "environment-path")).text()).toBe(
        `/artifact/bin:${runtimePath}`,
      );

      for (let attempt = 0; attempt < 50 && harness.protocolErrors.length === 0; attempt += 1) {
        await Bun.sleep(10);
      }

      expect(harness.protocolErrors).toHaveLength(1);
      expect(harness.protocolErrors[0]?.message).toBe("OpenAi app-server exited with code 17.");
    } finally {
      await harness.client.stop();
    }
  });

  test("drains a resolved approval before accepting the following terminal", async () => {
    const permissionAborted = Promise.withResolvers<void>();
    const permissionGate = Promise.withResolvers<void>();
    const terminal = Promise.withResolvers<void>();
    const harness = await createClientHarness(
      () => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: ${initializeResultJson} }) + "\\n");
    } else if (message.method === "initialized") {
      process.stdout.write(JSON.stringify({
        id: 41,
        method: "item/commandExecution/requestApproval",
        params: { environmentId: null, itemId: "item-1", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" },
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        method: "serverRequest/resolved",
        params: { requestId: 41, threadId: "thread-1" },
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "completed" } },
      }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
      async (method) => {
        if (method === "turn/completed") {
          terminal.resolve();
        }
      },
      async (_input, signal) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }

          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        permissionAborted.resolve();
        await permissionGate.promise;
        return "reject_once";
      },
    );

    try {
      await harness.client.start();
      await permissionAborted.promise;
      await expect(
        settlePromiseWithTimeout(terminal.promise, {
          label: "terminal before permission resolution delivery",
          timeoutMs: 50,
        }),
      ).resolves.toMatchObject({ status: "timed_out" });

      permissionGate.resolve();
      await expect(
        settlePromiseWithTimeout(terminal.promise, {
          label: "terminal after permission resolution delivery",
          timeoutMs: 250,
        }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(harness.protocolErrors).toEqual([]);
    } finally {
      permissionGate.resolve();
      await harness.client.stop();
    }
  });

  test("fails closed when resolved approval event delivery rejects", async () => {
    const permissionAborted = Promise.withResolvers<void>();
    const permissionGate = Promise.withResolvers<void>();
    const terminal = Promise.withResolvers<void>();
    const harness = await createClientHarness(
      () => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: ${initializeResultJson} }) + "\\n");
    } else if (message.method === "initialized") {
      process.stdout.write(JSON.stringify({
        id: 41,
        method: "item/commandExecution/requestApproval",
        params: { environmentId: null, itemId: "item-1", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" },
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        method: "serverRequest/resolved",
        params: { requestId: 41, threadId: "thread-1" },
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "completed" } },
      }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
      async (method) => {
        if (method === "turn/completed") {
          terminal.resolve();
        }
      },
      async (_input, signal) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }

          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        permissionAborted.resolve();
        await permissionGate.promise;
        throw new PermissionEventDeliveryError(
          "item/commandExecution/requestApproval:number:41",
          "resolved",
          new Error("event sink unavailable"),
        );
      },
    );

    try {
      await harness.client.start();
      await permissionAborted.promise;
      await expect(
        settlePromiseWithTimeout(terminal.promise, {
          label: "terminal before failed permission resolution delivery",
          timeoutMs: 50,
        }),
      ).resolves.toMatchObject({ status: "timed_out" });

      permissionGate.resolve();
      for (let attempt = 0; attempt < 50 && harness.protocolErrors.length === 0; attempt += 1) {
        await Bun.sleep(5);
      }

      expect(harness.protocolErrors).toHaveLength(1);
      expect(harness.protocolErrors[0]).toBeInstanceOf(PermissionEventDeliveryError);
      await expect(
        settlePromiseWithTimeout(terminal.promise, {
          label: "terminal after failed permission resolution delivery",
          timeoutMs: 100,
        }),
      ).resolves.toMatchObject({ status: "timed_out" });
    } finally {
      permissionGate.resolve();
      await harness.client.stop().catch(() => {});
    }
  });

  test("does not let a pending approval block process close", async () => {
    const permissionAborted = Promise.withResolvers<void>();
    const harness = await createClientHarness(
      () => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: ${initializeResultJson} }) + "\\n");
    } else if (message.method === "initialized") {
      process.stdout.write(JSON.stringify({
        id: 41,
        method: "item/commandExecution/requestApproval",
        params: { environmentId: null, itemId: "item-1", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" },
      }) + "\\n");
      setTimeout(() => process.exit(17), 10);
    }
  }
});
setInterval(() => {}, 1000);
`,
      undefined,
      async (_input, signal) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }

          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        permissionAborted.resolve();
        return "reject_once";
      },
    );

    try {
      await harness.client.start();
      const [protocolError] = await Promise.all([harness.protocolError, permissionAborted.promise]);

      expect(protocolError.message).toContain("code 17");
    } finally {
      await harness.client.stop();
    }
  });

  test("aborts pending server requests without sending a late response", async () => {
    const permissionStarted = Promise.withResolvers<void>();
    const permissionAborted = Promise.withResolvers<void>();
    const permissionGate = Promise.withResolvers<void>();
    const harness = await createClientHarness(
      (directory) => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: ${initializeResultJson} }) + "\\n");
    } else if (message.method === "initialized") {
      process.stdout.write(JSON.stringify({
        id: 41,
        method: "item/commandExecution/requestApproval",
        params: { environmentId: null, itemId: "item-1", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" },
      }) + "\\n");
    } else if (message.id === 41) {
      await Bun.write(${JSON.stringify(join(directory, "late-response.json"))}, JSON.stringify(message));
    }
  }
});
setInterval(() => {}, 1000);
`,
      async () => {},
      async (_input, signal) => {
        permissionStarted.resolve();
        signal?.addEventListener("abort", () => permissionAborted.resolve(), { once: true });
        await permissionGate.promise;
        return "allow_once";
      },
    );

    try {
      await harness.client.start();
      await permissionStarted.promise;
      const abort = harness.client.abortServerRequests(new Error("turn cancelled"));
      await permissionAborted.promise;
      permissionGate.resolve();
      await abort;

      expect(await Bun.file(join(harness.directory, "late-response.json")).exists()).toBe(false);
    } finally {
      permissionGate.resolve();
      await harness.client.stop();
    }
  });

  test("drains an accepted terminal notification before reporting child exit", async () => {
    const terminalEntered = Promise.withResolvers<void>();
    const terminalGate = Promise.withResolvers<void>();
    const harness = await createClientHarness(
      () => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: ${initializeResultJson} }) + "\\n");
    } else if (message.method === "initialized") {
      process.stdout.write(JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "completed" } },
      }) + "\\n", () => process.exit(17));
    }
  }
});
`,
      async (method) => {
        if (method === "turn/completed") {
          terminalEntered.resolve();
          await terminalGate.promise;
        }
      },
    );

    try {
      await harness.client.start();
      await terminalEntered.promise;
      await Bun.sleep(650);
      expect(harness.protocolErrors).toEqual([]);

      terminalGate.resolve();
      for (let attempt = 0; attempt < 50 && harness.protocolErrors.length === 0; attempt += 1) {
        await Bun.sleep(5);
      }
      expect(harness.protocolErrors).toHaveLength(1);
      expect(harness.protocolErrors[0]?.message).toContain("code 17");
    } finally {
      terminalGate.resolve();
      await harness.client.stop();
    }
  });

  test.each(["delayed", "failed"] as const)(
    "%s watchdog cleanup after leader close remains a stop barrier",
    async (outcome) => {
      const watchdogProcess = new EventEmitter() as ChildProcess;
      const watchdogCleanup = Promise.withResolvers<void>();
      const watchdogSpy = spyOn(
        childProcessHelpers,
        "spawnLinuxProcessTreeWatchdog",
      ).mockImplementation(() => ({
        cleanup: watchdogCleanup.promise,
        process: watchdogProcess,
      }));
      const harness = await createClientHarness(
        (directory) => `
import { writeFileSync } from "node:fs";
process.on("exit", () => writeFileSync(${JSON.stringify(join(directory, "leader-exited"))}, "exited"));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: ${initializeResultJson} }) + "\\n");
    } else if (message.method === "initialized") {
      setTimeout(() => process.exit(0), 5);
    }
  }
});
`,
      );

      try {
        await harness.client.start();
        while (!(await Bun.file(join(harness.directory, "leader-exited")).exists())) {
          await Bun.sleep(5);
        }

        const stop = harness.client.stop();
        void stop.catch(() => {});
        if (outcome === "delayed") {
          await expect(
            settlePromiseWithTimeout(stop, {
              label: "leader-closed process-tree cleanup",
              timeoutMs: 100,
            }),
          ).resolves.toMatchObject({ status: "timed_out" });
          watchdogCleanup.resolve();
          await expect(stop).resolves.toBeUndefined();
        } else {
          watchdogCleanup.reject(new Error("watchdog cleanup failed"));
          await expect(stop).rejects.toThrow("watchdog cleanup failed");
          await expect(harness.client.stop()).resolves.toBeUndefined();
        }
      } finally {
        watchdogCleanup.resolve();
        watchdogSpy.mockRestore();
        await harness.client.stop().catch(() => {});
      }
    },
  );

  test("turns stdin EPIPE into a bounded protocol failure", async () => {
    const closedInput = Promise.withResolvers<void>();
    const harness = await createClientHarness(
      () => `
IFS= read -r _
printf '%s\n' '${JSON.stringify({ id: 1, result: initializeResult })}'
IFS= read -r _
exec 0<&-
printf '%s\n' '{"method":"warning","params":{"message":"stdin closed","threadId":null}}'
sleep 10
`,
      async () => closedInput.resolve(),
      async () => "allow_once",
      "sh",
    );

    try {
      await harness.client.start();
      await closedInput.promise;
      const request = harness.client.request("initialize", {
        capabilities: { experimentalApi: true, requestAttestation: false },
        clientInfo: { name: "x".repeat(1024 * 1024), title: null, version: "1" },
      });
      const settled = await settlePromiseWithTimeout(request, {
        label: "stdin EPIPE",
        timeoutMs: 500,
      });

      expect(settled.status).toBe("failed");
      expect(harness.protocolErrors[0]?.message).toContain("EPIPE");
    } finally {
      await harness.client.stop();
    }
  });

  test.each([
    ["exit code", "process.exit(23);", "code 23"],
    ["signal", 'process.kill(process.pid, "SIGTERM");', "signal SIGTERM"],
  ] as const)(
    "rejects a pending request after an unexpected %s",
    async (_exitKind, terminate, expectedExit) => {
      const harness = await createClientHarness(
        () => `
let buffer = "";
let requests = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    requests += 1;
    if (requests === 1) {
      process.stdout.write(
        JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n",
      );
    } else {
      ${terminate}
    }
  }
});
setInterval(() => {}, 1000);
`,
      );

      try {
        await harness.client.start();
        const request = harness.client.request("initialize", {
          capabilities: { experimentalApi: true, requestAttestation: false },
          clientInfo: { name: "crash-test", title: null, version: "1" },
        });

        await expect(request).rejects.toThrow(`app-server exited with ${expectedExit}`);
        await expect(harness.client.drainServerMessages()).rejects.toThrow(expectedExit);
        expect(harness.protocolErrors).toHaveLength(1);
        expect(harness.protocolErrors[0]?.message).toContain(expectedExit);
      } finally {
        await harness.client.stop();
      }
    },
  );

  test("drains notifications already accepted by the message queue", async () => {
    const firstNotification = Promise.withResolvers<void>();
    const notificationGate = Promise.withResolvers<void>();
    const secondNotification = Promise.withResolvers<void>();
    const secondNotificationGate = Promise.withResolvers<void>();
    const handled: string[] = [];
    const harness = await createClientHarness(
      () => `
let buffer = "";
let requests = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.id === undefined) continue;
    requests += 1;
    if (requests === 1) {
      process.stdout.write(
        JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n",
      );
      process.stdout.write(JSON.stringify({ method: "warning", params: { message: "first", threadId: null } }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ method: "warning", params: { message: "second", threadId: null } }) + "\\n");
      process.stdout.write(
        JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n",
      );
    }
  }
});
setInterval(() => {}, 1000);
`,
      async () => {
        handled.push(`notification-${handled.length + 1}`);
        if (handled.length === 1) {
          firstNotification.resolve();
          await notificationGate.promise;
        } else {
          secondNotification.resolve();
          await secondNotificationGate.promise;
        }
      },
    );

    try {
      await harness.client.start();
      await firstNotification.promise;
      let drained = false;
      const drain = harness.client.drainServerMessages().then(() => {
        drained = true;
      });
      await harness.client.request("initialize", {
        capabilities: { experimentalApi: true, requestAttestation: false },
        clientInfo: { name: "drain-test", title: null, version: "1" },
      });
      expect(drained).toBe(false);

      notificationGate.resolve();
      await secondNotification.promise;
      expect(drained).toBe(false);
      secondNotificationGate.resolve();
      await drain;
      expect(handled).toEqual(["notification-1", "notification-2"]);
    } finally {
      notificationGate.resolve();
      secondNotificationGate.resolve();
      await harness.client.stop();
    }
  });

  test("waits for process close and shares concurrent stop calls", async () => {
    const harness = await createClientHarness(
      (directory) => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  process.stdout.write(JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n");
});
process.on("SIGTERM", async () => {
  await Bun.write(${JSON.stringify(join(directory, "stopped"))}, "stopped");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
    );

    try {
      await harness.client.start();
      await expect(Promise.all([harness.client.stop(), harness.client.stop()])).resolves.toEqual([
        undefined,
        undefined,
      ]);

      expect(await Bun.file(join(harness.directory, "stopped")).exists()).toBe(true);
      expect(harness.protocolErrors).toEqual([]);
      await expect(harness.client.start()).rejects.toThrow("cannot be started more than once");
    } finally {
      await harness.client.stop();
    }
  });

  test("force kills the process group after the leader exits with inherited stdio open", async () => {
    const harness = await createClientHarness((directory) => {
      const descendantReadyPath = join(directory, "descendant-ready");
      const descendantScript = `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(descendantReadyPath)}, "ready");
setInterval(() => {}, 1000);
`;

      return `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
  stdio: ["ignore", "inherit", "inherit"],
});
await Bun.write(${JSON.stringify(join(directory, "descendant-pid"))}, String(descendant.pid));
while (!(await Bun.file(${JSON.stringify(descendantReadyPath)}).exists())) {
  await Bun.sleep(5);
}
process.on("exit", () => writeFileSync(${JSON.stringify(join(directory, "leader-exited"))}, "exited"));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  process.stdout.write(JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n", () => process.exit(0));
});
`;
    });
    let descendantPid = 0;

    try {
      await harness.client.start();
      descendantPid = Number(await Bun.file(join(harness.directory, "descendant-pid")).text());
      while (!(await Bun.file(join(harness.directory, "leader-exited")).exists())) {
        await Bun.sleep(5);
      }

      await expect(harness.client.stop()).resolves.toBeUndefined();
      await expectProcessExited(descendantPid);
      descendantPid = 0;
    } finally {
      if (descendantPid > 0) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }

      await harness.client.stop().catch(() => {});
    }
  }, 10_000);

  test("signals app-server session members outside the leader process group", async () => {
    if (process.platform !== "linux") {
      return;
    }

    const harness = await createClientHarness((directory) => {
      const descendantPath = join(directory, "descendant.ts");
      const descendantScript = `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(directory, "descendant-ready"))}, "ready");
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(join(directory, "descendant-term"))}, "term"));
setInterval(() => {}, 1000);
`;
      const shellCommand = `set -m; ${JSON.stringify(process.execPath)} ${JSON.stringify(descendantPath)} & echo $! > ${JSON.stringify(join(directory, "descendant-pid"))}; wait`;

      return `
import { spawn } from "node:child_process";
await Bun.write(${JSON.stringify(descendantPath)}, ${JSON.stringify(descendantScript)});
spawn("/bin/bash", ["-c", ${JSON.stringify(shellCommand)}], {
  stdio: ["ignore", "ignore", "ignore"],
});
await Bun.write(${JSON.stringify(join(directory, "leader-pid"))}, String(process.pid));
while (!(await Bun.file(${JSON.stringify(join(directory, "descendant-ready"))}).exists())) {
  await Bun.sleep(5);
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  process.stdout.write(JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n");
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;
    });
    let descendantPid = 0;

    try {
      await harness.client.start();
      const leaderPid = Number(await Bun.file(join(harness.directory, "leader-pid")).text());
      descendantPid = Number(await Bun.file(join(harness.directory, "descendant-pid")).text());
      const stat = await Bun.file(`/proc/${descendantPid}/stat`).text();
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      expect(Number(fields[2])).not.toBe(leaderPid);
      expect(Number(fields[3])).toBe(leaderPid);

      await harness.client.stop();
      expect(await Bun.file(join(harness.directory, "descendant-term")).exists()).toBe(true);
    } finally {
      if (descendantPid > 0) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }

      await harness.client.stop().catch(() => {});
    }
  }, 10_000);

  test("waits for stubborn nested setsid descendants before resolving stop", async () => {
    if (process.platform !== "linux") {
      return;
    }

    const harness = await createClientHarness((directory) => {
      const descendantPath = join(directory, "nested-descendant.ts");
      const descendantScript = `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(directory, "nested-ready"))}, "ready");
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(join(directory, "nested-term"))}, "ignored");
});
setInterval(() => {}, 1000);
`;
      const shellCommand = `setsid ${JSON.stringify(process.execPath)} ${JSON.stringify(descendantPath)} & echo $! > ${JSON.stringify(join(directory, "nested-pid"))}; wait`;

      return `
import { spawn } from "node:child_process";
await Bun.write(${JSON.stringify(descendantPath)}, ${JSON.stringify(descendantScript)});
spawn("/bin/bash", ["-c", ${JSON.stringify(shellCommand)}], {
  stdio: ["ignore", "ignore", "ignore"],
});
await Bun.write(${JSON.stringify(join(directory, "leader-pid"))}, String(process.pid));
while (!(await Bun.file(${JSON.stringify(join(directory, "nested-ready"))}).exists())) {
  await Bun.sleep(5);
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  process.stdout.write(JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n");
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;
    });
    let descendantPid = 0;

    try {
      await harness.client.start();
      const leaderPid = Number(await Bun.file(join(harness.directory, "leader-pid")).text());
      descendantPid = Number(await Bun.file(join(harness.directory, "nested-pid")).text());
      const stat = await Bun.file(`/proc/${descendantPid}/stat`).text();
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      expect(Number(fields[3])).toBe(descendantPid);
      expect(Number(fields[3])).not.toBe(leaderPid);

      await harness.client.stop();
      expect(await Bun.file(join(harness.directory, "nested-term")).exists()).toBe(true);
      await expectProcessExited(descendantPid, 250);
    } finally {
      if (descendantPid > 0) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }

      await harness.client.stop().catch(() => {});
    }
  }, 10_000);

  test("retries process cleanup after a failed force kill", async () => {
    const harness = await createClientHarness(
      (directory) => `
import { spawn } from "node:child_process";
await Bun.write(${JSON.stringify(join(directory, "runtime-home"))}, process.env.CODEX_HOME);
const descendant = spawn("/usr/bin/setsid", [
  process.execPath,
  "-e",
  "setInterval(() => {}, 1000)",
], {
  stdio: "ignore",
});
await Bun.write(${JSON.stringify(join(directory, "descendant-pid"))}, String(descendant.pid));
await Bun.write(${JSON.stringify(join(directory, "pid"))}, String(process.pid));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  process.stdout.write(JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n");
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      undefined,
      undefined,
      "bun",
      {
        ...driverBootPayload.execution.environment,
        variables: { OPENAI_API_KEY: "retry-stop-key" },
      },
    );
    const nativeKill = process.kill;
    let childPid = 0;
    let descendantPid = 0;
    let suppressKill = true;

    try {
      await harness.client.start();
      const runtimeHome = await Bun.file(join(harness.directory, "runtime-home")).text();
      childPid = Number(await Bun.file(join(harness.directory, "pid")).text());
      descendantPid = Number(await Bun.file(join(harness.directory, "descendant-pid")).text());
      process.kill = ((pid, signal) => {
        if (suppressKill && Math.abs(Number(pid)) === descendantPid) {
          return true;
        }

        return nativeKill(pid, signal);
      }) as typeof process.kill;

      await expect(harness.client.stop()).rejects.toThrow("process tree did not exit");
      expect(await readFile(join(runtimeHome, "auth.json"), "utf8")).toContain("retry-stop-key");
      suppressKill = false;
      await expect(harness.client.stop()).resolves.toBeUndefined();
      await expect(lstat(runtimeHome)).rejects.toThrow();
      expect((await lstat(join(harness.directory, "home", "sessions"))).isDirectory()).toBe(true);
    } finally {
      process.kill = nativeKill;

      if (childPid > 0) {
        try {
          nativeKill(-childPid, "SIGKILL");
        } catch {}
      }
      if (descendantPid > 0) {
        try {
          nativeKill(descendantPid, "SIGKILL");
        } catch {}
      }
    }
  }, 10_000);

  test("rejects a request started after shutdown instead of leaving it pending", async () => {
    const harness = await createClientHarness(
      () => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    process.stdout.write(
      JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n",
    );
  }
});
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 200));
setInterval(() => {}, 1000);
`,
    );

    try {
      await harness.client.start();
      const stop = harness.client.stop();
      const request = harness.client.request("initialize", {
        capabilities: { experimentalApi: true, requestAttestation: false },
        clientInfo: { name: "shutdown-race", title: null, version: "1" },
      });
      const outcome = await settlePromiseWithTimeout(request, {
        label: "request after client shutdown",
        timeoutMs: 100,
      });

      await stop;
      expect(outcome).toMatchObject({
        error: { message: "OpenAi app-server client is stopping." },
        status: "failed",
      });
    } finally {
      await harness.client.stop();
    }
  });

  test.each([
    ["backpressures below", 900, false],
    ["rejects above", 1_025, true],
  ] as const)("%s the 1024-message queue limit", async (_label, messageCount, rejected) => {
    const firstNotification = Promise.withResolvers<void>();
    const notificationGate = Promise.withResolvers<void>();
    let handled = 0;
    const harness = await createClientHarness(
      (directory) => `
import { writeFileSync } from "node:fs";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: request.id, result: ${initializeResultJson} }) + "\\n");
    } else if (request.method === "initialized") {
      const notification = JSON.stringify({
        method: "warning",
        params: { message: "x".repeat(${rejected ? "1" : "4096"}), threadId: null },
      });
      process.stdout.write(
        Array.from({ length: ${String(messageCount)} }, () => notification).join("\\n") + "\\n",
        () => writeFileSync(${JSON.stringify(join(directory, "burst-flushed"))}, "flushed"),
      );
    }
  }
});
setInterval(() => {}, 1000);
`,
      async () => {
        handled += 1;
        if (handled === 1) {
          firstNotification.resolve();
          await notificationGate.promise;
        }
      },
    );

    try {
      await harness.client.start();
      await firstNotification.promise;
      expect(handled).toBe(1);
      expect(harness.protocolErrors).toEqual([]);
      if (!rejected) {
        expect(await Bun.file(join(harness.directory, "burst-flushed")).exists()).toBe(false);
      }

      notificationGate.resolve();
      const drain = harness.client.drainServerMessages();
      if (rejected) {
        await expect(drain).rejects.toThrow("message queue limit exceeded");
      } else {
        await drain;
        expect(await Bun.file(join(harness.directory, "burst-flushed")).exists()).toBe(true);
      }
      expect(handled).toBe(Math.min(messageCount, 1_024));
      if (rejected) {
        expect((await harness.protocolError).message).toContain("message queue limit exceeded");
        expect(harness.protocolErrors).toHaveLength(1);
      } else {
        expect(harness.protocolErrors).toEqual([]);
      }
    } finally {
      notificationGate.resolve();
      await harness.client.stop();
    }
  });
});
