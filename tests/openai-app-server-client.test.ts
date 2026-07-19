import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { AgentDriverPermissionPort } from "../src/host-ports";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverExecutionEnvironment } from "../src/protocol/boot";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { OpenAiAppServerClient, limitNdjsonLines } from "../src/runtimes/openai/app-server-client";
import type { ServerNotificationMethod } from "../src/runtimes/openai/generated/app-server-protocol";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { driverBootPayload } from "./driver-boot-payload-fixture";

const originalExecutable = process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"];
const temporaryDirectories: string[] = [];

async function createClientHarness(
  script: (directory: string) => string,
  handleNotification: (method: ServerNotificationMethod) => Promise<void> = async () => {},
  requestPermission: AgentDriverPermissionPort["request"] = async () => "allow_once",
  interpreter = "bun",
  environment: DriverExecutionEnvironment = driverBootPayload.execution.environment,
) {
  const directory = await mkdtemp(join(tmpdir(), "mosoo-openai-client-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "fake-app-server");
  await Bun.write(executable, `#!/usr/bin/env ${interpreter}\n${script(directory)}`);
  await chmod(executable, 0o755);
  process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"] = executable;

  const payload = createDriverStartInputFromBootPayload({
    ...driverBootPayload,
    execution: {
      ...driverBootPayload.execution,
      environment,
      session: {
        ...driverBootPayload.execution.session,
        context: {
          ...driverBootPayload.execution.session.context,
          homePath: join(directory, "home"),
          sessionOrganizationPath: directory,
        },
        cwd: directory,
      },
    },
  });
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "openai-app-server-client-test",
    sink: async () => {},
  });
  const context = createAgentDriverContext({
    eventSink: { pushEvents: async () => ({ accepted: [] }) },
    logger,
    payload,
    permission: { request: requestPermission },
  });
  const protocolErrors: Error[] = [];
  const client = new OpenAiAppServerClient(payload, {
    ...context,
    handleNotification,
    handleProtocolError: async (error) => {
      protocolErrors.push(error);
    },
  });

  return { client, directory, logger, protocolErrors };
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
  test("declares only initialized server-request capabilities it handles", async () => {
    const harness = await createClientHarness(
      (directory) => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  await Bun.write(${JSON.stringify(join(directory, "initialize.json"))}, JSON.stringify(request));
  process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
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
        experimentalApi: false,
        requestAttestation: false,
      });
    } finally {
      await harness.client.stop();
      await harness.logger.destroy();
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

  test("rejects a child process spawn failure without an unhandled error", async () => {
    const harness = await createClientHarness(() => "");
    process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"] = join(harness.directory, "missing");

    try {
      await expect(harness.client.start()).rejects.toThrow();
    } finally {
      await harness.client.stop();
      await harness.logger.destroy();
    }
  });

  test("does not spawn after stop wins a startup race", async () => {
    const harness = await createClientHarness(
      (directory) => `
await Bun.write(${JSON.stringify(join(directory, "spawned"))}, "spawned");
setInterval(() => {}, 1000);
`,
    );

    try {
      const start = harness.client.start();
      const stop = harness.client.stop();

      await expect(stop).resolves.toBeUndefined();
      await expect(start).rejects.toThrow("stopped during startup");
      expect(await Bun.file(join(harness.directory, "spawned")).exists()).toBe(false);
    } finally {
      await harness.client.stop();
      await harness.logger.destroy();
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
      process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
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
      await harness.logger.destroy();
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
      process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
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
        clientInfo: { name: "test", version: "1" },
      });
      const stop = harness.client.stop();

      await expect(request).rejects.toThrow("app-server stopped");
      await expect(stop).resolves.toBeUndefined();
    } finally {
      await harness.client.stop();
      await harness.logger.destroy();
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
  process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
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
      await harness.logger.destroy();
    }
  });

  test.each(["resolved terminal", "process close"] as const)(
    "does not let a pending approval block %s",
    async (outcome) => {
      const permissionAborted = Promise.withResolvers<void>();
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
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    } else if (message.method === "initialized") {
      process.stdout.write(JSON.stringify({
        id: 41,
        method: "item/commandExecution/requestApproval",
        params: { itemId: "item-1", threadId: "thread-1", turnId: "turn-1" },
      }) + "\\n");
      if (${JSON.stringify(outcome)} === "resolved terminal") {
        process.stdout.write(JSON.stringify({
          method: "serverRequest/resolved",
          params: { requestId: 41, threadId: "thread-1" },
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        }) + "\\n");
      } else {
        setTimeout(() => process.exit(17), 10);
      }
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
          return "reject_once";
        },
      );

      try {
        await harness.client.start();
        const settled = await settlePromiseWithTimeout(
          outcome === "resolved terminal"
            ? terminal.promise
            : (async () => {
                while (harness.protocolErrors.length === 0) {
                  await Bun.sleep(5);
                }
              })(),
          { label: outcome, timeoutMs: 250 },
        );

        expect(settled.status).toBe("completed");
        await expect(
          settlePromiseWithTimeout(permissionAborted.promise, {
            label: "permission abort",
            timeoutMs: 250,
          }),
        ).resolves.toMatchObject({ status: "completed" });
        if (outcome === "process close") {
          expect(harness.protocolErrors[0]?.message).toContain("code 17");
        }
      } finally {
        await harness.client.stop();
        await harness.logger.destroy();
      }
    },
  );

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
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    } else if (message.method === "initialized") {
      process.stdout.write(JSON.stringify({
        id: 41,
        method: "item/commandExecution/requestApproval",
        params: { itemId: "item-1", threadId: "thread-1", turnId: "turn-1" },
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
      harness.client.abortServerRequests(new Error("turn cancelled"));
      await permissionAborted.promise;
      permissionGate.resolve();
      await Bun.sleep(25);

      expect(await Bun.file(join(harness.directory, "late-response.json")).exists()).toBe(false);
    } finally {
      permissionGate.resolve();
      await harness.client.stop();
      await harness.logger.destroy();
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
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    } else if (message.method === "initialized") {
      process.stdout.write(JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
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
      await Bun.sleep(25);
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
      await harness.logger.destroy();
    }
  });

  test("turns stdin EPIPE into a bounded protocol failure", async () => {
    const closedInput = Promise.withResolvers<void>();
    const harness = await createClientHarness(
      () => `
IFS= read -r _
printf '%s\n' '{"id":1,"result":{}}'
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
        clientInfo: { name: "x".repeat(1024 * 1024), version: "1" },
      });
      const settled = await settlePromiseWithTimeout(request, {
        label: "stdin EPIPE",
        timeoutMs: 500,
      });

      expect(settled.status).toBe("failed");
      expect(harness.protocolErrors[0]?.message).toContain("EPIPE");
    } finally {
      await harness.client.stop();
      await harness.logger.destroy();
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
      process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
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
          clientInfo: { name: "crash-test", version: "1" },
        });

        await expect(request).rejects.toThrow(`app-server exited with ${expectedExit}`);
        await harness.client.drainServerMessages();
        expect(harness.protocolErrors).toHaveLength(1);
        expect(harness.protocolErrors[0]?.message).toContain(expectedExit);
      } finally {
        await harness.client.stop();
        await harness.logger.destroy();
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
      process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "warning", params: { message: "first", threadId: null } }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ method: "warning", params: { message: "second", threadId: null } }) + "\\n");
      process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
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
        clientInfo: { name: "drain-test", version: "1" },
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
      await harness.logger.destroy();
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
  process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
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
      await harness.logger.destroy();
    }
  });

  test("retries process cleanup after a failed force kill", async () => {
    const harness = await createClientHarness(
      (directory) => `
await Bun.write(${JSON.stringify(join(directory, "pid"))}, String(process.pid));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );
    const nativeKill = process.kill;
    let childPid = 0;
    let suppressKill = true;

    try {
      await harness.client.start();
      childPid = Number(await Bun.file(join(harness.directory, "pid")).text());
      process.kill = ((pid, signal) => {
        if (suppressKill && pid === -childPid) {
          return true;
        }

        return nativeKill(pid, signal);
      }) as typeof process.kill;

      await expect(harness.client.stop()).rejects.toThrow("timed out");
      suppressKill = false;
      await expect(harness.client.stop()).resolves.toBeUndefined();
    } finally {
      process.kill = nativeKill;

      if (childPid > 0) {
        try {
          nativeKill(-childPid, "SIGKILL");
        } catch {}
      }

      await harness.logger.destroy();
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
    process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
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
        clientInfo: { name: "shutdown-race", version: "1" },
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
      await harness.logger.destroy();
    }
  });

  test("fails and stops when queued server messages exceed the hard limit", async () => {
    let releaseNotification: (() => void) | null = null;
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const harness = await createClientHarness(
      () => `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  for (let index = 0; index < 1025; index += 1) {
    process.stdout.write(JSON.stringify({ method: "warning", params: { message: String(index), threadId: null } }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`,
      async () => notificationGate,
    );

    try {
      await harness.client.start();

      for (let attempt = 0; attempt < 50 && harness.protocolErrors.length === 0; attempt += 1) {
        await Bun.sleep(10);
      }

      expect(harness.protocolErrors).toHaveLength(1);
      expect(harness.protocolErrors[0]?.message).toBe("App-server message queue limit exceeded.");
    } finally {
      (releaseNotification as (() => void) | null)?.();
      await harness.client.stop();
      await harness.logger.destroy();
    }
  });
});
