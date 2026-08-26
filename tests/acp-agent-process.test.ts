import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBufferedSinkLogger } from "../src/observability";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import {
  startAcpAgentProcess,
  stopAcpAgentProcess,
  type AcpAgentProcess,
} from "../src/runtimes/acp/acp-agent-process";
import { buildChildEnv } from "../src/runtimes/acp/acp-configuration";
import { spawnLinuxProcessTreeWatchdog } from "../src/runtimes/child-process";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { driverBootPayload, driverStartInput } from "./driver-boot-payload-fixture";

function createHarness() {
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "acp-agent-process-test",
    sink: async () => {},
  });
  const context = createAgentDriverContext({
    eventSink: {
      currentRunId: () => null,
      pushEvents: async () => ({ accepted: [] }),
    },
    logger,
    payload: driverStartInput,
    permission: { request: async () => "reject_once" },
  });

  return { context, logger };
}

function createPayload(root: string) {
  return createDriverStartInputFromBootPayload({
    ...driverBootPayload,
    execution: {
      ...driverBootPayload.execution,
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
  });
}

async function startTestAgentProcess(
  harness: ReturnType<typeof createHarness>,
  source: string,
  spawnWatchdog?: typeof spawnLinuxProcessTreeWatchdog,
): Promise<{
  child: AcpAgentProcess;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "driver-acp-stop-"));
  const payload = createPayload(root);
  const readyPath = join(root, "ready");

  try {
    const child = await startAcpAgentProcess(
      harness.context,
      payload,
      buildChildEnv(payload),
      new AbortController().signal,
      {
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, "ready");${source}`,
        ],
        command: process.execPath,
        ...(spawnWatchdog === undefined ? {} : { spawnWatchdog }),
      },
    );
    while (!(await Bun.file(readyPath).exists())) {
      await Bun.sleep(5);
    }
    return {
      child,
      dispose: async () => {
        if (child.exitCode === null && child.signalCode === null) {
          await stopAcpAgentProcess(harness.context, child, "test.cleanup").catch(() => {});
        }
        await rm(root, { force: true, recursive: true });
      },
    };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

function fakeWatchdog(cleanup: Promise<void>): typeof spawnLinuxProcessTreeWatchdog {
  return () => ({ cleanup, process: {} as ChildProcess });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

async function waitForPidFile(path: string): Promise<number> {
  const deadline = Date.now() + 3_000;

  for (;;) {
    try {
      return Number.parseInt(await Bun.file(path).text(), 10);
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${path}.`);
      }
      await Bun.sleep(20);
    }
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;

  while (isProcessRunning(pid) && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  expect(isProcessRunning(pid)).toBe(false);
}

describe("ACP agent process lifecycle", () => {
  test.each(["SIGTERM", "SIGKILL"] as const)("observes exit after %s", async (exitSignal) => {
    const harness = createHarness();
    const process = await startTestAgentProcess(
      harness,
      `${exitSignal === "SIGKILL" ? 'process.on("SIGTERM", () => {});' : ""}setInterval(() => {}, 1000);`,
    );

    try {
      await expect(
        stopAcpAgentProcess(harness.context, process.child, "test.stop"),
      ).resolves.toBeUndefined();
      expect(process.child.signalCode).toBe(exitSignal);
    } finally {
      await process.dispose();
      await harness.logger.destroy();
    }
  });

  test("fails closed on cleanup timeout and lets a later stop retry", async () => {
    const harness = createHarness();
    const cleanup = Promise.withResolvers<void>();
    const process = await startTestAgentProcess(
      harness,
      'process.on("SIGTERM", () => {});setInterval(() => {}, 1000);',
      fakeWatchdog(cleanup.promise),
    );

    try {
      await expect(
        stopAcpAgentProcess(harness.context, process.child, "first.stop"),
      ).rejects.toThrow("process-tree cleanup timed out");
      expect(process.child.signalCode).toBe("SIGKILL");
      cleanup.resolve();
      await expect(
        stopAcpAgentProcess(harness.context, process.child, "retry.stop"),
      ).resolves.toBeUndefined();
    } finally {
      cleanup.resolve();
      await process.dispose();
      await harness.logger.destroy();
    }
  });

  test.each(["completed", "failed"] as const)(
    "fails closed once and retries cleanup when the watchdog %s while the agent root is active",
    async (outcome) => {
      const harness = createHarness();
      const root = await mkdtemp(join(tmpdir(), "driver-acp-watchdog-"));
      const payload = createPayload(root);
      const readyPath = join(root, "ready");
      const cleanup = Promise.withResolvers<void>();
      let child: AcpAgentProcess | undefined;

      try {
        child = await startAcpAgentProcess(
          harness.context,
          payload,
          buildChildEnv(payload),
          new AbortController().signal,
          {
            args: [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, "ready");setInterval(() => {}, 1000);`,
            ],
            command: process.execPath,
            spawnWatchdog: fakeWatchdog(cleanup.promise),
          },
        );
        while (!(await Bun.file(readyPath).exists())) {
          await Bun.sleep(10);
        }
        const closed = once(child, "close");

        if (outcome === "completed") {
          cleanup.resolve();
        } else {
          cleanup.reject(new Error("test watchdog failure"));
        }

        await closed;
        await expect(stopAcpAgentProcess(harness.context, child, "test.stop")).rejects.toThrow();
        await expect(
          stopAcpAgentProcess(harness.context, child, "test.stop.retry"),
        ).resolves.toBeUndefined();
      } finally {
        cleanup.resolve();
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await rm(root, { force: true, recursive: true });
        await harness.logger.destroy();
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "accepts watchdog cleanup after the bound root exits when child exit metadata lags",
    async () => {
      const harness = createHarness();
      const cleanup = Promise.withResolvers<void>();
      const agent = await startTestAgentProcess(
        harness,
        "setInterval(() => {}, 1000);",
        fakeWatchdog(cleanup.promise),
      );
      const closed = once(agent.child, "close");
      const pid = agent.child.pid;

      try {
        expect(pid).toBeDefined();
        process.kill(pid!, "SIGKILL");
        await closed;
        const exitCode = agent.child.exitCode;
        const signalCode = agent.child.signalCode;
        Reflect.set(agent.child, "exitCode", null);
        Reflect.set(agent.child, "signalCode", null);

        try {
          cleanup.resolve();
          await new Promise<void>((resolve) => setImmediate(resolve));
          await expect(
            stopAcpAgentProcess(harness.context, agent.child, "test.stop"),
          ).resolves.toBeUndefined();
        } finally {
          Reflect.set(agent.child, "exitCode", exitCode);
          Reflect.set(agent.child, "signalCode", signalCode);
        }
      } finally {
        cleanup.resolve();
        await agent.dispose();
        await harness.logger.destroy();
      }
    },
  );

  test("cleans the marked tree when watchdog creation throws and allows a later start", async () => {
    const harness = createHarness();
    const root = await mkdtemp(join(tmpdir(), "driver-acp-watchdog-create-"));
    const payload = createPayload(root);
    const shellPidPath = join(root, "shell.pid");
    const workerPidPath = join(root, "worker.pid");
    const previousCommand = process.env["MOSOO_ACP_FALLBACK_COMMAND"];
    const previousArgs = process.env["MOSOO_ACP_FALLBACK_ARGS"];
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const nested = `echo $$ > ${shellPidPath}; sleep 30 & echo $! > ${workerPidPath}; wait`;
    const script = `
const { spawn } = require("node:child_process");
spawn("/usr/bin/setsid", ["/bin/sh", "-c", ${JSON.stringify(nested)}], { stdio: "ignore" });
setInterval(() => {}, 1_000);
`;
    let rootPid = 0;
    let shellPid = 0;
    let workerPid = 0;
    let retryChild: AcpAgentProcess | undefined;
    process.env["MOSOO_ACP_FALLBACK_COMMAND"] = process.execPath;
    process.env["MOSOO_ACP_FALLBACK_ARGS"] = JSON.stringify(["-e", script]);

    try {
      await expect(
        startAcpAgentProcess(
          harness.context,
          payload,
          buildChildEnv(payload),
          new AbortController().signal,
          {
            spawnWatchdog: (pid) => {
              rootPid = pid;
              const deadline = Date.now() + 3_000;
              while (!existsSync(workerPidPath) && Date.now() < deadline) {
                Atomics.wait(sleeper, 0, 0, 10);
              }
              throw new Error("test watchdog creation failed");
            },
          },
        ),
      ).rejects.toThrow("test watchdog creation failed");
      [shellPid, workerPid] = await Promise.all([
        waitForPidFile(shellPidPath),
        waitForPidFile(workerPidPath),
      ]);
      await Promise.all([rootPid, shellPid, workerPid].map(waitForProcessExit));

      process.env["MOSOO_ACP_FALLBACK_ARGS"] = JSON.stringify([
        "-e",
        "setInterval(() => {}, 1_000)",
      ]);
      retryChild = await startAcpAgentProcess(
        harness.context,
        payload,
        buildChildEnv(payload),
        new AbortController().signal,
      );
      await expect(
        stopAcpAgentProcess(harness.context, retryChild, "test.retry"),
      ).resolves.toBeUndefined();
    } finally {
      if (
        retryChild !== undefined &&
        retryChild.exitCode === null &&
        retryChild.signalCode === null
      ) {
        retryChild.kill("SIGKILL");
      }
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
      for (const pid of [rootPid, shellPid, workerPid]) {
        if (pid > 0 && isProcessRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      await rm(root, { force: true, recursive: true });
      await harness.logger.destroy();
    }
  }, 7_000);

  test("waits for and propagates rejected cleanup when startup aborts", async () => {
    const harness = createHarness();
    const root = await mkdtemp(join(tmpdir(), "driver-acp-startup-abort-"));
    const payload = createPayload(root);
    const shellPidPath = join(root, "shell.pid");
    const workerPidPath = join(root, "worker.pid");
    const nested = `echo $$ > ${shellPidPath}; sleep 30 & echo $! > ${workerPidPath}; wait`;
    const script = `
const { spawn } = require("node:child_process");
spawn("/usr/bin/setsid", ["/bin/sh", "-c", ${JSON.stringify(nested)}], { stdio: "ignore" });
setInterval(() => {}, 1_000);
`;
    const controller = new AbortController();
    const cleanup = Promise.withResolvers<void>();
    void cleanup.promise.catch(() => {});
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    let rootPid = 0;
    let shellPid = 0;
    let workerPid = 0;

    const starting = startAcpAgentProcess(
      harness.context,
      payload,
      buildChildEnv(payload),
      controller.signal,
      {
        args: ["-e", script],
        command: process.execPath,
        spawnWatchdog: (pid, marker) => {
          rootPid = pid;
          const deadline = Date.now() + 3_000;
          while (!existsSync(workerPidPath) && Date.now() < deadline) {
            Atomics.wait(sleeper, 0, 0, 10);
          }
          controller.abort();
          const watchdog = spawnLinuxProcessTreeWatchdog(pid, marker);
          if (watchdog === null) {
            throw new Error("Test process supervision could not start.");
          }
          return {
            cleanup: watchdog.cleanup.then(() => cleanup.promise),
            process: watchdog.process,
          };
        },
      },
    );
    let settled = false;
    void starting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    try {
      [shellPid, workerPid] = await Promise.all([
        waitForPidFile(shellPidPath),
        waitForPidFile(workerPidPath),
      ]);
      await Promise.all(
        [rootPid, shellPid, workerPid].filter((pid) => pid > 0).map(waitForProcessExit),
      );
      expect(settled).toBe(false);

      cleanup.reject(new Error("test startup cleanup rejected"));
      const error = await starting.then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect(
        (error as AggregateError).errors.some(
          (entry) => entry instanceof Error && entry.message === "test startup cleanup rejected",
        ),
      ).toBe(true);
    } finally {
      cleanup.resolve();
      for (const pid of [rootPid, shellPid, workerPid]) {
        if (pid > 0 && isProcessRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      await rm(root, { force: true, recursive: true });
      await harness.logger.destroy();
    }
  }, 7_000);

  test("waits for marker cleanup when a fast-exiting agent leaves a nested session", async () => {
    const harness = createHarness();
    const root = await mkdtemp(join(tmpdir(), "driver-acp-process-"));
    const payload = createPayload(root);
    const shellPidPath = join(root, "shell.pid");
    const workerPidPath = join(root, "worker.pid");
    const nested = `echo $$ > ${shellPidPath}; sleep 30 & echo $! > ${workerPidPath}; wait`;
    const script = [
      'const { spawn } = require("node:child_process");',
      'const { existsSync } = require("node:fs");',
      `const child = spawn("/usr/bin/setsid", ["/bin/sh", "-c", ${JSON.stringify(nested)}],`,
      '  { stdio: "ignore" });',
      "child.unref();",
      "const sleeper = new Int32Array(new SharedArrayBuffer(4));",
      `while (!existsSync(${JSON.stringify(workerPidPath)})) Atomics.wait(sleeper, 0, 0, 10);`,
    ].join("\n");
    let child: AcpAgentProcess | undefined;
    let shellPid = 0;
    let workerPid = 0;

    try {
      child = await startAcpAgentProcess(
        harness.context,
        payload,
        buildChildEnv(payload),
        new AbortController().signal,
        { args: ["-e", script], command: process.execPath },
      );
      [shellPid, workerPid] = await Promise.all([
        waitForPidFile(shellPidPath),
        waitForPidFile(workerPidPath),
      ]);
      await stopAcpAgentProcess(
        harness.context,
        child,
        "test.stop",
        Date.now() + 2_000,
        new AbortController().signal,
      );
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(isProcessRunning(shellPid)).toBe(false);
      expect(isProcessRunning(workerPid)).toBe(false);
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        await stopAcpAgentProcess(
          harness.context,
          child,
          "test.cleanup",
          Date.now() + 2_000,
          new AbortController().signal,
        ).catch(() => {});
      }
      for (const pid of [shellPid, workerPid]) {
        if (pid > 0 && isProcessRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      await rm(root, { force: true, recursive: true });
      await harness.logger.destroy();
    }
  }, 5_000);
});
