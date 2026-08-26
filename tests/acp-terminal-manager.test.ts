import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverId, isDriverId } from "../src/protocol/id";
import { spawnLinuxProcessTreeWatchdog } from "../src/runtimes/child-process";
import { AcpTerminalManager } from "../src/runtimes/acp/acp-terminal-manager";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { driverStartInput } from "./driver-boot-payload-fixture";

function createHarness(
  onPush: ((reason: string, events: DriverEventInput[]) => Promise<void>) | undefined = undefined,
  maxTerminals?: number,
  recordAfterPush = false,
  spawnWatchdog?: typeof spawnLinuxProcessTreeWatchdog,
) {
  const events: DriverEventInput[] = [];
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "acp-terminal-manager-test",
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
  const manager = new AcpTerminalManager({
    allowedRoots: [],
    cwd: process.cwd(),
    env: {},
    maxTerminals,
    push: async (_context, _reason, next) => {
      if (recordAfterPush) {
        await onPush?.(_reason, next);
        events.push(...next);
      } else {
        events.push(...next);
        await onPush?.(_reason, next);
      }
    },
    ...(spawnWatchdog === undefined ? {} : { spawnWatchdog }),
  });

  return { context, events, logger, manager };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

function fakeWatchdog(cleanup: Promise<void>): typeof spawnLinuxProcessTreeWatchdog {
  return () => ({ cleanup, process: {} as ChildProcess });
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

describe("ACP terminal manager", () => {
  test("retains a valid UTF-8 suffix and exposes exit only after output closes", async () => {
    const harness = createHarness();

    try {
      const { terminalId } = await harness.manager.create(harness.context, {
        args: ["-e", 'process.stdout.write("a😀bc")'],
        command: process.execPath,
        outputByteLimit: 5,
      });
      const exit = await harness.manager.waitForExit({ terminalId });
      const output = harness.manager.output({ terminalId });

      expect(isDriverId(terminalId)).toBe(true);
      expect(exit).toEqual({ exitCode: 0, signal: null });
      expect(output).toEqual({
        exitStatus: exit,
        output: "bc",
        truncated: true,
      });
      await harness.manager.release(harness.context, { terminalId });
    } finally {
      await harness.logger.destroy();
    }
  });

  test("keeps terminal exit behind the watchdog cleanup barrier", async () => {
    const cleanup = Promise.withResolvers<void>();
    const harness = createHarness(undefined, undefined, false, fakeWatchdog(cleanup.promise));

    try {
      const terminal = await harness.manager.create(harness.context, {
        args: ["-e", 'process.stdout.write("ready");setInterval(() => {}, 1000)'],
        command: process.execPath,
      });
      while (harness.manager.output(terminal).output !== "ready") {
        await Bun.sleep(10);
      }
      const killed = harness.manager.kill(harness.context, terminal);
      let settled = false;
      void killed.then(() => {
        settled = true;
      });
      await Bun.sleep(100);

      expect(settled).toBe(false);
      expect(harness.events.some((event) => event.kind === "terminal.exited")).toBe(false);
      expect(harness.events.some((event) => event.kind === "terminal.killed")).toBe(false);

      cleanup.resolve();
      await expect(killed).resolves.toEqual({});
      expect(harness.events.map((event) => event.kind).slice(-2)).toEqual([
        "terminal.exited",
        "terminal.killed",
      ]);
      await harness.manager.release(harness.context, terminal);
    } finally {
      cleanup.resolve();
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  });

  test("keeps terminal release behind the watchdog cleanup barrier", async () => {
    const cleanup = Promise.withResolvers<void>();
    const harness = createHarness(undefined, undefined, false, fakeWatchdog(cleanup.promise));

    try {
      const terminal = await harness.manager.create(harness.context, {
        args: ["-e", 'process.stdout.write("ready");setInterval(() => {}, 1000)'],
        command: process.execPath,
      });
      while (harness.manager.output(terminal).output !== "ready") {
        await Bun.sleep(10);
      }
      const released = harness.manager.release(harness.context, terminal);
      const pending = await settlePromiseWithTimeout(released, {
        label: "terminal release cleanup barrier",
        timeoutMs: 100,
      });

      expect(pending.status).toBe("timed_out");
      expect(harness.events.some((event) => event.kind === "terminal.exited")).toBe(false);
      expect(harness.events.some((event) => event.kind === "terminal.released")).toBe(false);

      cleanup.resolve();
      await expect(released).resolves.toEqual({});
      expect(harness.events.map((event) => event.kind).slice(-2)).toEqual([
        "terminal.exited",
        "terminal.released",
      ]);
    } finally {
      cleanup.resolve();
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  });

  test("publishes terminal exit before release after cleanup takeover", async () => {
    const exitPublishing = Promise.withResolvers<void>();
    const allowExit = Promise.withResolvers<void>();
    const harness = createHarness(async (reason) => {
      if (reason === "driver.acp.terminal.exited") {
        exitPublishing.resolve();
        await allowExit.promise;
      }
    });

    try {
      const terminal = await harness.manager.create(harness.context, {
        args: ["-e", "process.stdout.write(String(process.pid));setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      while (harness.manager.output(terminal).output === "") {
        await Bun.sleep(10);
      }
      const exited = harness.manager.waitForExit(terminal);
      void exited.catch(() => {});
      process.kill(Number.parseInt(harness.manager.output(terminal).output, 10), "SIGTERM");
      await exitPublishing.promise;
      const released = harness.manager.release(harness.context, terminal);

      await expect(
        settlePromiseWithTimeout(released, {
          label: "terminal release exit publication",
          timeoutMs: 1_100,
        }),
      ).resolves.toMatchObject({ status: "timed_out" });
      expect(harness.events.some((event) => event.kind === "terminal.released")).toBe(false);

      allowExit.resolve();
      await expect(Promise.all([exited, released])).resolves.toEqual([
        { exitCode: null, signal: "SIGTERM" },
        {},
      ]);
      expect(harness.events.map((event) => event.kind).slice(-2)).toEqual([
        "terminal.exited",
        "terminal.released",
      ]);
    } finally {
      allowExit.resolve();
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  });

  test.each(["completed", "failed"] as const)(
    "fails closed when the watchdog %s while the terminal root is active",
    async (outcome) => {
      const directory = await mkdtemp(join(tmpdir(), "mosoo-acp-watchdog-"));
      const pidPath = join(directory, "terminal.pid");
      const cleanup = Promise.withResolvers<void>();
      const harness = createHarness(undefined, undefined, false, fakeWatchdog(cleanup.promise));
      let pid = 0;

      try {
        const terminal = await harness.manager.create(harness.context, {
          args: [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));process.stdout.write("ready");setInterval(() => {}, 1000);`,
          ],
          command: process.execPath,
        });
        while (harness.manager.output(terminal).output !== "ready") {
          await Bun.sleep(10);
        }
        pid = await waitForPidFile(pidPath);

        if (outcome === "completed") {
          cleanup.resolve();
        } else {
          cleanup.reject(new Error("test watchdog failure"));
        }

        await expect(harness.manager.waitForExit(terminal)).rejects.toThrow("watchdog");
        expect(isProcessRunning(pid)).toBe(false);
        expect(harness.events.some((event) => event.kind === "terminal.exited")).toBe(false);
      } finally {
        cleanup.resolve();
        await harness.manager.stopAll(harness.context).catch(() => {});
        if (pid > 0 && isProcessRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
        await harness.logger.destroy();
        await rm(directory, { force: true, recursive: true });
      }
    },
  );

  test.each(["release", "stopAll"] as const)(
    "%s retries cleanup after the watchdog lease rejects",
    async (action) => {
      const cleanup = Promise.withResolvers<void>();
      const harness = createHarness(undefined, undefined, false, fakeWatchdog(cleanup.promise));

      try {
        const terminal = await harness.manager.create(harness.context, {
          args: ["-e", 'process.stdout.write("ready");setInterval(() => {}, 1000)'],
          command: process.execPath,
        });
        while (harness.manager.output(terminal).output !== "ready") {
          await Bun.sleep(10);
        }

        cleanup.reject(new Error("test watchdog cleanup failed"));
        await expect(harness.manager.waitForExit(terminal)).rejects.toThrow("watchdog failed");
        expect(harness.events.some((event) => event.kind === "terminal.exited")).toBe(false);

        await expect(
          action === "release"
            ? harness.manager.release(harness.context, terminal).then(() => {})
            : harness.manager.stopAll(harness.context),
        ).resolves.toBeUndefined();
        expect(harness.events.map((event) => event.kind).slice(-2)).toEqual([
          "terminal.exited",
          "terminal.released",
        ]);
        expect(() => harness.manager.output(terminal)).toThrow("does not exist");
      } finally {
        await harness.manager.stopAll(harness.context).catch(() => {});
        await harness.logger.destroy();
      }
    },
  );

  test("cleans the marked tree when watchdog creation throws and allows a later create", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mosoo-acp-watchdog-create-"));
    const shellPidPath = join(directory, "shell.pid");
    const workerPidPath = join(directory, "worker.pid");
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    let factoryCalls = 0;
    let rootPid = 0;
    let shellPid = 0;
    let workerPid = 0;
    const harness = createHarness(undefined, undefined, false, (pid, marker) => {
      if (factoryCalls++ === 0) {
        rootPid = pid;
        const deadline = Date.now() + 3_000;
        while (!existsSync(workerPidPath) && Date.now() < deadline) {
          Atomics.wait(sleeper, 0, 0, 10);
        }
        throw new Error("test watchdog creation failed");
      }

      const watchdog = spawnLinuxProcessTreeWatchdog(pid, marker);
      if (watchdog === null) {
        throw new Error("Test process supervision could not start.");
      }
      return watchdog;
    });
    const nested = `echo $$ > ${shellPidPath}; sleep 30 & echo $! > ${workerPidPath}; wait`;
    const source = `
const { spawn } = require("node:child_process");
spawn("/usr/bin/setsid", ["/bin/sh", "-c", ${JSON.stringify(nested)}], { stdio: "ignore" });
setInterval(() => {}, 1_000);
`;

    try {
      await expect(
        harness.manager.create(harness.context, {
          args: ["-e", source],
          command: process.execPath,
        }),
      ).rejects.toThrow("test watchdog creation failed");
      [shellPid, workerPid] = await Promise.all([
        waitForPidFile(shellPidPath),
        waitForPidFile(workerPidPath),
      ]);
      await Promise.all([rootPid, shellPid, workerPid].map(waitForProcessExit));
      expect(harness.events.some((event) => event.kind === "terminal.created")).toBe(false);
      expect(harness.events.some((event) => event.kind === "terminal.exited")).toBe(false);

      const terminal = await harness.manager.create(harness.context, {
        args: ["-e", "process.exit(0)"],
        command: process.execPath,
      });
      await expect(harness.manager.waitForExit(terminal)).resolves.toEqual({
        exitCode: 0,
        signal: null,
      });
      await expect(harness.manager.release(harness.context, terminal)).resolves.toEqual({});
    } finally {
      await harness.manager.stopAll(harness.context).catch(() => {});
      for (const pid of [rootPid, shellPid, workerPid]) {
        if (pid > 0 && isProcessRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      await harness.logger.destroy();
      await rm(directory, { force: true, recursive: true });
    }
  }, 7_000);

  test("cleans a nested session when the terminal root exits immediately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mosoo-acp-fast-terminal-"));
    const shellPidPath = join(directory, "shell.pid");
    const workerPidPath = join(directory, "worker.pid");
    const nested = `echo $$ > ${shellPidPath}; sleep 30 & echo $! > ${workerPidPath}; wait`;
    const source = `
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const child = spawn("/usr/bin/setsid", ["/bin/sh", "-c", ${JSON.stringify(nested)}], { stdio: "ignore" });
child.unref();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(workerPidPath)})) Atomics.wait(sleeper, 0, 0, 10);
`;
    const harness = createHarness();
    let shellPid = 0;
    let workerPid = 0;

    try {
      const terminal = await harness.manager.create(harness.context, {
        args: ["-e", source],
        command: process.execPath,
      });
      [shellPid, workerPid] = await Promise.all([
        waitForPidFile(shellPidPath),
        waitForPidFile(workerPidPath),
      ]);

      await expect(harness.manager.waitForExit(terminal)).resolves.toEqual({
        exitCode: 0,
        signal: null,
      });
      expect(isProcessRunning(shellPid)).toBe(false);
      expect(isProcessRunning(workerPid)).toBe(false);
      await harness.manager.release(harness.context, terminal);
    } finally {
      await harness.manager.stopAll(harness.context).catch(() => {});
      for (const pid of [shellPid, workerPid]) {
        if (pid > 0 && isProcessRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      await harness.logger.destroy();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("reuses one supervisor for concurrent terminals", async () => {
    const supervisors = new Set<ChildProcess>();
    const harness = createHarness(undefined, 2, false, (pid, marker) => {
      const lease = spawnLinuxProcessTreeWatchdog(pid, marker);
      if (lease === null) {
        throw new Error("Test process supervision could not start.");
      }
      supervisors.add(lease.process);
      return lease;
    });

    try {
      await Promise.all(
        Array.from({ length: 2 }, () =>
          harness.manager.create(harness.context, {
            args: ["-e", "setInterval(() => {}, 1_000)"],
            command: process.execPath,
          }),
        ),
      );
      expect(supervisors.size).toBe(1);
    } finally {
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  });

  test("rejects terminal buffers above the deployment hard limit", async () => {
    const harness = createHarness();

    try {
      await expect(
        harness.manager.create(harness.context, {
          command: process.execPath,
          outputByteLimit: 1_024 * 1_024 + 1,
        }),
      ).rejects.toThrow("exceeds 1048576 bytes");
    } finally {
      await harness.logger.destroy();
    }
  });

  test("bounds retained terminals and restores capacity after release", async () => {
    const harness = createHarness(undefined, 1);

    try {
      const first = await harness.manager.create(harness.context, {
        args: ["-e", "setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      await expect(
        harness.manager.create(harness.context, { command: process.execPath }),
      ).rejects.toThrow("limit of 1 is exhausted");

      await harness.manager.release(harness.context, first);
      const second = await harness.manager.create(harness.context, {
        args: ["-e", "process.exit(0)"],
        command: process.execPath,
      });
      await harness.manager.waitForExit(second);
      await harness.manager.release(harness.context, second);
    } finally {
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });

  test("reserves capacity before concurrent terminal creation can yield", async () => {
    const harness = createHarness(undefined, 1);

    try {
      const creations = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          harness.manager.create(harness.context, {
            args: ["-e", "setInterval(() => {}, 1000)"],
            command: process.execPath,
          }),
        ),
      );
      const created = creations.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );

      expect(created).toHaveLength(1);
      expect(creations.filter((result) => result.status === "rejected")).toHaveLength(7);
      expect(harness.events.filter((event) => event.kind === "terminal.created")).toHaveLength(1);

      await harness.manager.release(harness.context, created[0]);
      const next = await harness.manager.create(harness.context, {
        args: ["-e", "process.exit(0)"],
        command: process.execPath,
      });
      await harness.manager.waitForExit(next);
      await harness.manager.release(harness.context, next);
    } finally {
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });

  test("stops only one turn and accepts terminals in the next turn", async () => {
    const harness = createHarness(undefined, 1);

    try {
      const firstTurn = harness.manager.beginTurn();
      const first = await harness.manager.create(harness.context, {
        args: ["-e", 'process.stdout.write("ready");setInterval(() => {}, 1000)'],
        command: process.execPath,
      });
      while (harness.manager.output(first).output !== "ready") {
        await Bun.sleep(10);
      }

      await harness.manager.stopTurn(harness.context, firstTurn);
      expect(() => harness.manager.output(first)).toThrow("does not exist");

      const secondTurn = harness.manager.beginTurn();
      const second = await harness.manager.create(harness.context, {
        args: ["-e", "process.exit(0)"],
        command: process.execPath,
      });
      await harness.manager.waitForExit(second);
      await harness.manager.stopTurn(harness.context, secondTurn);
      expect(() => harness.manager.output(second)).toThrow("does not exist");
    } finally {
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });

  test.each([0, Number.POSITIVE_INFINITY, 1.5])("rejects invalid terminal limit %p", (value) => {
    expect(() => createHarness(undefined, value)).toThrow("positive safe integer");
  });

  test("rejects a failed spawn without retaining terminal capacity", async () => {
    const harness = createHarness(undefined, 1);

    try {
      await expect(
        harness.manager.create(harness.context, {
          command: `/definitely-missing-acp-command-${createDriverId()}`,
        }),
      ).rejects.toThrow();
      const terminal = await harness.manager.create(harness.context, {
        args: ["-e", "process.exit(0)"],
        command: process.execPath,
      });
      await harness.manager.waitForExit(terminal);
      await harness.manager.release(harness.context, terminal);
    } finally {
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });

  test("rejects terminal creation after shutdown starts", async () => {
    const harness = createHarness();

    try {
      await harness.manager.stopAll(harness.context);
      await expect(
        harness.manager.create(harness.context, {
          args: ["-e", "process.exit(0)"],
          command: process.execPath,
        }),
      ).rejects.toThrow("stopping");
    } finally {
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });

  test("keeps a terminal private until its creation event commits", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let terminalId: string | undefined;
    const harness = createHarness(async (reason, events) => {
      if (reason === "driver.acp.terminal.created") {
        terminalId = (events[0]?.payload as Record<string, unknown> | undefined)?.[
          "terminalId"
        ] as string;
        entered.resolve();
        await release.promise;
      }
    });

    try {
      const creation = harness.manager.create(harness.context, {
        args: ["-e", "setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      await entered.promise;

      expect(() => harness.manager.output({ terminalId })).toThrow("does not exist");
      release.resolve();
      await expect(creation).resolves.toEqual({ terminalId });
      expect(() => harness.manager.output({ terminalId })).not.toThrow();
    } finally {
      release.resolve();
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });

  test("waits for an entered create publication before stopping the terminal", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = createHarness(
      async (reason) => {
        if (reason === "driver.acp.terminal.created") {
          entered.resolve();
          await release.promise;
        }
      },
      undefined,
      true,
    );

    try {
      const creation = harness.manager.create(harness.context, {
        args: ["-e", "setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      void creation.catch(() => {});
      await entered.promise;
      const stop = harness.manager.stopAll(harness.context);
      let stopped = false;
      void stop.then(() => {
        stopped = true;
      });
      await Promise.resolve();

      expect(stopped).toBe(false);
      expect(harness.events).toHaveLength(0);
      release.resolve();
      await expect(creation).rejects.toThrow("stopping");
      await expect(stop).resolves.toBeUndefined();
      expect(harness.events.map((event) => event.kind)).toEqual([
        "terminal.created",
        "terminal.exited",
        "terminal.released",
      ]);
    } finally {
      release.resolve();
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  });

  test("does not fail create before an entered publication settles on abort", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = createHarness(
      async (reason) => {
        if (reason === "driver.acp.terminal.created") {
          entered.resolve();
          await release.promise;
        }
      },
      undefined,
      true,
    );
    const controller = new AbortController();

    try {
      const creation = harness.manager.create(
        harness.context,
        {
          args: ["-e", "setInterval(() => {}, 1000)"],
          command: process.execPath,
        },
        controller.signal,
      );
      void creation.catch(() => {});
      await entered.promise;
      controller.abort();
      let settled = false;
      void creation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(harness.events).toHaveLength(0);
      release.resolve();
      await expect(creation).rejects.toBeInstanceOf(DOMException);
      expect(harness.events.map((event) => event.kind)).toEqual([
        "terminal.created",
        "terminal.exited",
        "terminal.released",
      ]);
    } finally {
      release.resolve();
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  });

  test("retains and reports a stopped creation whose release publication fails", async () => {
    const entered = Promise.withResolvers<void>();
    const releaseCreated = Promise.withResolvers<void>();
    let failRelease = true;
    let terminalId: string | undefined;
    const harness = createHarness(
      async (reason, events) => {
        if (reason === "driver.acp.terminal.created") {
          terminalId = (events[0]?.payload as Record<string, unknown> | undefined)?.[
            "terminalId"
          ] as string;
          entered.resolve();
          await releaseCreated.promise;
        }

        if (failRelease && reason === "driver.acp.terminal.released") {
          throw new Error("release publication failed");
        }
      },
      undefined,
      true,
    );

    try {
      const creation = harness.manager.create(harness.context, {
        args: ["-e", "setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      void creation.catch(() => {});
      await entered.promise;
      const stop = harness.manager.stopAll(harness.context);
      void stop.catch(() => {});
      releaseCreated.resolve();

      await expect(creation).rejects.toThrow("cleanup failed");
      await expect(stop).rejects.toBeInstanceOf(AggregateError);
      expect(harness.events.map((event) => event.kind)).toEqual([
        "terminal.created",
        "terminal.exited",
      ]);
      expect(() => harness.manager.output({ terminalId })).not.toThrow();

      failRelease = false;
      await expect(harness.manager.stopAll(harness.context)).resolves.toBeUndefined();
      expect(harness.events.map((event) => event.kind)).toEqual([
        "terminal.created",
        "terminal.exited",
        "terminal.released",
      ]);
      expect(() => harness.manager.output({ terminalId })).toThrow("does not exist");
    } finally {
      failRelease = false;
      releaseCreated.resolve();
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  });

  test("keeps a killed terminal readable until release, then invalidates every operation", async () => {
    const harness = createHarness();

    try {
      const { terminalId } = await harness.manager.create(harness.context, {
        args: ["-e", "setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      await harness.manager.kill(harness.context, { terminalId });
      await expect(harness.manager.waitForExit({ terminalId })).resolves.toMatchObject({
        exitCode: null,
      });
      expect(harness.manager.output({ terminalId }).exitStatus).not.toBeNull();
      await harness.manager.release(harness.context, { terminalId });

      expect(() => harness.manager.output({ terminalId })).toThrow("does not exist");

      for (const operation of [
        () => harness.manager.waitForExit({ terminalId }),
        () => harness.manager.kill(harness.context, { terminalId }),
        () => harness.manager.release(harness.context, { terminalId }),
      ]) {
        await expect(operation()).rejects.toThrow("does not exist");
      }
    } finally {
      await harness.logger.destroy();
    }
  });

  test("aborts an SDK terminal wait without abandoning the terminal", async () => {
    const harness = createHarness();

    try {
      const terminal = await harness.manager.create(harness.context, {
        args: ["-e", "setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      const controller = new AbortController();
      const exit = harness.manager.waitForExit(terminal, controller.signal);
      controller.abort();

      await expect(exit).rejects.toBeInstanceOf(DOMException);
      expect(() => harness.manager.output(terminal)).not.toThrow();
      await harness.manager.release(harness.context, terminal);
    } finally {
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });

  test.each([
    ["cooperative", "", "SIGTERM"],
    ["TERM-resistant", 'process.on("SIGTERM", () => {});', "SIGKILL"],
  ] as const)(
    "bounds release of a %s terminal and observes its final exit",
    async (_name, signalHandler, expectedSignal) => {
      const harness = createHarness();

      try {
        const terminal = await harness.manager.create(harness.context, {
          args: [
            "-e",
            `${signalHandler}process.stdout.write("ready");setInterval(() => {}, 1000);`,
          ],
          command: process.execPath,
        });

        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (harness.manager.output(terminal).output === "ready") {
            break;
          }

          await Bun.sleep(10);
        }

        expect(harness.manager.output(terminal).output).toBe("ready");
        const exit = harness.manager.waitForExit(terminal);
        const release = await settlePromiseWithTimeout(
          harness.manager.release(harness.context, terminal),
          {
            label: "ACP terminal release",
            timeoutMs: 4_000,
          },
        );

        expect(release.status).toBe("completed");
        await expect(exit).resolves.toMatchObject({ signal: expectedSignal });
        expect(() => harness.manager.output(terminal)).toThrow("does not exist");
      } finally {
        await harness.manager.stopAll(harness.context);
        await harness.logger.destroy();
      }
    },
  );

  test("retains only the failed release for a later shutdown retry", async () => {
    let releasePushes = 0;
    const harness = createHarness(async (reason) => {
      if (reason === "driver.acp.terminal.released" && releasePushes++ === 0) {
        throw new Error("release event failed");
      }
    });

    try {
      const terminalIds = await Promise.all(
        ["first", "second"].map(async (value) => {
          const created = await harness.manager.create(harness.context, {
            args: ["-e", `process.stdout.write(${JSON.stringify(value)})`],
            command: process.execPath,
          });
          await harness.manager.waitForExit(created);
          return created.terminalId;
        }),
      );

      await expect(harness.manager.stopAll(harness.context)).rejects.toBeInstanceOf(AggregateError);

      expect(
        terminalIds.filter((terminalId) => {
          try {
            harness.manager.output({ terminalId });
            return true;
          } catch {
            return false;
          }
        }),
      ).toHaveLength(1);

      await expect(harness.manager.stopAll(harness.context)).resolves.toBeUndefined();
      terminalIds.forEach((terminalId) => {
        expect(() => harness.manager.output({ terminalId })).toThrow("does not exist");
      });
    } finally {
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  });

  test("retains a terminal for shutdown retry when failed creation cleanup cannot confirm exit", async () => {
    const cleanup = Promise.withResolvers<void>();
    const harness = createHarness(
      async (reason) => {
        if (reason === "driver.acp.terminal.created") {
          throw new Error("event sink unavailable");
        }
      },
      undefined,
      false,
      fakeWatchdog(cleanup.promise),
    );

    try {
      await expect(
        harness.manager.create(harness.context, {
          args: ["-e", "setInterval(() => {}, 1000);"],
          command: process.execPath,
        }),
      ).rejects.toThrow();
      const terminalId = (
        harness.events.find((event) => event.kind === "terminal.created")?.payload as
          | Record<string, unknown>
          | undefined
      )?.["terminalId"];

      expect(terminalId).toBeString();
      expect(() => harness.manager.output({ terminalId })).not.toThrow();

      await expect(harness.manager.stopAll(harness.context)).resolves.toBeUndefined();
      expect(() => harness.manager.output({ terminalId })).toThrow("does not exist");
    } finally {
      cleanup.resolve();
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  }, 5_000);

  test("stopAll joins an in-progress release and emits it once", async () => {
    const releasePublishing = Promise.withResolvers<void>();
    const allowRelease = Promise.withResolvers<void>();
    let releasePushes = 0;
    const harness = createHarness(async (reason) => {
      if (reason === "driver.acp.terminal.released") {
        releasePushes += 1;
        releasePublishing.resolve();
        await allowRelease.promise;
      }
    });

    try {
      const terminal = await harness.manager.create(harness.context, {
        args: ["-e", "process.exit(0)"],
        command: process.execPath,
      });
      await harness.manager.waitForExit(terminal);
      const release = harness.manager.release(harness.context, terminal);
      await releasePublishing.promise;
      const stops = Promise.all([
        harness.manager.stopAll(harness.context),
        harness.manager.stopAll(harness.context),
      ]);
      let stopsSettled = false;
      void stops.then(() => {
        stopsSettled = true;
      });
      await Bun.sleep(0);

      expect(stopsSettled).toBe(false);
      allowRelease.resolve();
      await expect(Promise.all([release, stops])).resolves.toEqual([{}, [undefined, undefined]]);
      expect(releasePushes).toBe(1);
      expect(() => harness.manager.output(terminal)).toThrow("does not exist");
    } finally {
      allowRelease.resolve();
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });
});
