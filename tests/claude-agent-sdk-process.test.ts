import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bindSpawnedProcess,
  signalBoundProcessTree,
  waitForLinuxProcessMarkerExit,
} from "../src/runtimes/child-process";
import { spawnClaudeCodeProcess } from "../src/runtimes/claude/agent-sdk-process";
import { drainClaudeTasks, registerClaudeTaskRetry } from "../src/runtimes/claude/agent-sdk-tasks";

const processIds = new Set<number>();
const processStartTimes = new Map<number, string>();
const directories = new Set<string>();

afterEach(async () => {
  for (const pid of processIds) {
    if (isRunning(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  processIds.clear();
  processStartTimes.clear();
  await Promise.all(
    [...directories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  directories.clear();
});

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 3_000;

  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}.`);
    }
    await Bun.sleep(20);
  }

  const pid = Number.parseInt(await readFile(path, "utf8"), 10);
  trackProcess(pid);
  return pid;
}

function readProcessState(pid: number): { startTime: string; state: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { startTime: fields[19]!, state: fields[0]! };
  } catch {
    return null;
  }
}

function trackProcess(pid: number): void {
  const state = readProcessState(pid);
  if (state !== null) {
    processIds.add(pid);
    processStartTimes.set(pid, state.startTime);
  }
}

function isRunning(pid: number): boolean {
  const expectedStartTime = processStartTimes.get(pid);
  const state = readProcessState(pid);
  return (
    expectedStartTime !== undefined &&
    state !== null &&
    state.startTime === expectedStartTime &&
    state.state !== "Z"
  );
}

function readSessionId(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(fields[3]);
}

async function expectExited(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;

  while (isRunning(pid) && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  expect(isRunning(pid)).toBe(false);
  processIds.delete(pid);
  processStartTimes.delete(pid);
}

describe.skipIf(process.platform !== "linux")("Claude Agent SDK process supervision", () => {
  test("does not claim supervision when spawn throws synchronously", async () => {
    const controller = new AbortController();
    const processTasks = new Set<Promise<void>>();

    expect(() =>
      spawnClaudeCodeProcess(
        {
          command: "invalid\0command",
          args: [],
          env: {},
          signal: controller.signal,
        },
        () => {},
        controller.signal,
        processTasks,
      ),
    ).toThrow("null bytes");
    expect(processTasks.size).toBe(0);
    await expect(drainClaudeTasks(processTasks)).resolves.toBeUndefined();
  });

  test("does not retry cleanup before its original attempt fails", async () => {
    const cleanupError = new Error("initial cleanup failed");
    const initialCleanup = Promise.withResolvers<void>();
    const processTasks = new Set([initialCleanup.promise]);
    let retries = 0;
    registerClaudeTaskRetry(initialCleanup.promise, async () => {
      retries += 1;
    });

    const firstDrain = drainClaudeTasks(processTasks);
    const secondDrain = drainClaudeTasks(processTasks);
    await Promise.resolve();
    expect(retries).toBe(0);

    const settled = Promise.allSettled([firstDrain, secondDrain]);
    initialCleanup.reject(cleanupError);
    expect(await settled).toEqual([
      { reason: cleanupError, status: "rejected" },
      { reason: cleanupError, status: "rejected" },
    ]);
    expect(processTasks.size).toBe(1);

    await drainClaudeTasks(processTasks);
    expect(retries).toBe(1);
    expect(processTasks.size).toBe(0);
  });

  test("signals descendants that start a nested session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runtime-process-session-"));
    directories.add(directory);
    const shellPidPath = join(directory, "shell.pid");
    const workerPidPath = join(directory, "worker.pid");
    const nestedCommand = `echo $$ > ${shellPidPath}; sleep 30 & echo $! > ${workerPidPath}; wait`;
    const shell = spawn("sh", ["-c", `setsid sh -c '${nestedCommand}' & wait`], {
      detached: true,
      stdio: "ignore",
    });
    const shellPid = shell.pid;
    expect(shellPid).toBeDefined();
    trackProcess(shellPid!);
    const workerPid = await waitForPid(workerPidPath);
    const nestedShellPid = await waitForPid(shellPidPath);
    expect(readSessionId(nestedShellPid)).toBe(nestedShellPid);
    expect(readSessionId(nestedShellPid)).not.toBe(readSessionId(shellPid!));

    expect(signalBoundProcessTree(bindSpawnedProcess(shell), "", "SIGKILL")).toBe(true);
    await Promise.all([
      expectExited(shellPid!),
      expectExited(nestedShellPid),
      expectExited(workerPid),
    ]);
  });

  test("preserves the SDK killed contract while stopping the process tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-process-kill-"));
    directories.add(directory);
    const shellPidPath = join(directory, "shell.pid");
    const workerPidPath = join(directory, "worker.pid");
    const controller = new AbortController();
    const processTasks = new Set<Promise<void>>();
    const child = spawnClaudeCodeProcess(
      {
        command: "sh",
        args: [
          "-c",
          `setsid sh -c 'echo $$ > ${shellPidPath}; sleep 30 & echo $! > ${workerPidPath}; wait' & wait`,
        ],
        cwd: directory,
        env: {},
        signal: controller.signal,
      },
      () => {},
      controller.signal,
      processTasks,
    );
    const childPid = (child as ChildProcess).pid;
    expect(childPid).toBeDefined();
    trackProcess(childPid!);
    const [shellPid, workerPid] = await Promise.all([
      waitForPid(shellPidPath),
      waitForPid(workerPidPath),
    ]);

    expect(child.killed).toBe(false);
    expect(processTasks.size).toBe(1);
    const cleanupTask = [...processTasks][0]!;
    expect(child.kill("SIGKILL")).toBe(true);
    expect(child.killed).toBe(true);
    await Promise.all([expectExited(childPid!), expectExited(shellPid), expectExited(workerPid)]);
    await cleanupTask;
    expect(processTasks.size).toBe(1);
    await drainClaudeTasks(processTasks);
    expect(processTasks.size).toBe(0);
  });

  test("kills a subprocess when the immediate signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort("test.cancel");
    const child = spawnClaudeCodeProcess(
      {
        command: "sleep",
        args: ["30"],
        env: {},
        signal: new AbortController().signal,
      },
      () => {},
      controller.signal,
    );
    const childPid = (child as ChildProcess).pid;
    expect(childPid).toBeDefined();
    trackProcess(childPid!);

    expect(child.killed).toBe(true);
    await expectExited(childPid!);
  });

  test("kills the detached process group on other POSIX platforms", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-process-posix-"));
    directories.add(directory);
    const shellPidPath = join(directory, "shell.pid");
    const workerPidPath = join(directory, "worker.pid");
    const controller = new AbortController();
    const child = spawnClaudeCodeProcess(
      {
        command: "sh",
        args: ["-c", `echo $$ > ${shellPidPath}; sleep 30 & echo $! > ${workerPidPath}; wait`],
        cwd: directory,
        env: {},
        signal: controller.signal,
      },
      () => {},
      controller.signal,
      new Set(),
      { runtimePlatform: "darwin" },
    );
    const childPid = (child as ChildProcess).pid;
    expect(childPid).toBeDefined();
    trackProcess(childPid!);
    const [shellPid, workerPid] = await Promise.all([
      waitForPid(shellPidPath),
      waitForPid(workerPidPath),
    ]);
    expect(shellPid).toBe(childPid!);

    expect(child.killed).toBe(false);
    expect(isRunning(childPid!)).toBe(true);
    expect(isRunning(workerPid)).toBe(true);
    expect(child.kill("SIGKILL")).toBe(true);
    await Promise.all([expectExited(childPid!), expectExited(workerPid)]);
  });

  test("fails closed when the Linux watchdog exits before the provider", async () => {
    const controller = new AbortController();
    const watchdogCleanup = Promise.withResolvers<void>();
    const watchdogAttached = Promise.withResolvers<void>();
    const processTasks = new Set<Promise<void>>();
    const child = spawnClaudeCodeProcess(
      {
        command: "sleep",
        args: ["30"],
        env: {},
        signal: controller.signal,
      },
      () => {},
      controller.signal,
      processTasks,
      {
        runtimePlatform: "linux",
        spawnWatchdog: () => {
          watchdogAttached.resolve();
          return {
            cleanup: watchdogCleanup.promise,
            process: new EventEmitter() as ChildProcess,
          };
        },
      },
    );
    const childPid = (child as ChildProcess).pid;
    expect(childPid).toBeDefined();
    trackProcess(childPid!);
    await watchdogAttached.promise;

    watchdogCleanup.reject(new Error("watchdog failed"));
    await Promise.resolve();
    expect(child.killed).toBe(true);
    await expectExited(childPid!);
    await expect(drainClaudeTasks(processTasks)).rejects.toThrow("watchdog failed");
    expect(processTasks.size).toBe(1);
    await drainClaudeTasks(processTasks);
    expect(processTasks.size).toBe(0);
  });

  test("ignores the watchdog exit after the provider has exited", async () => {
    const controller = new AbortController();
    const watchdogCleanup = Promise.withResolvers<void>();
    const watchdogAttached = Promise.withResolvers<void>();
    const processTasks = new Set<Promise<void>>();
    const child = spawnClaudeCodeProcess(
      {
        command: "sh",
        args: ["-c", "sleep 0.05"],
        env: {},
        signal: controller.signal,
      },
      () => {},
      controller.signal,
      processTasks,
      {
        runtimePlatform: "linux",
        spawnWatchdog: () => {
          watchdogAttached.resolve();
          return {
            cleanup: watchdogCleanup.promise,
            process: new EventEmitter() as ChildProcess,
          };
        },
      },
    );
    const childProcess = child as ChildProcess;
    const childPid = childProcess.pid;
    expect(childPid).toBeDefined();
    trackProcess(childPid!);
    await watchdogAttached.promise;
    expect(processTasks.size).toBe(1);
    const cleanupTask = [...processTasks][0]!;
    await new Promise<void>((resolve) => childProcess.once("exit", () => resolve()));
    await expectExited(childPid!);
    expect(child.killed).toBe(false);
    expect(processTasks.size).toBe(1);

    watchdogCleanup.resolve();
    await cleanupTask;
    expect(child.killed).toBe(false);
    expect(processTasks.size).toBe(1);
    await drainClaudeTasks(processTasks);
    expect(processTasks.size).toBe(0);
  });

  test("retains marker cleanup for a later retry", async () => {
    const controller = new AbortController();
    const processTasks = new Set<Promise<void>>();
    let markerWaits = 0;
    const child = spawnClaudeCodeProcess(
      {
        command: "sh",
        args: ["-c", "sleep 0.05"],
        env: {},
        signal: controller.signal,
      },
      () => {},
      controller.signal,
      processTasks,
      {
        waitForMarkerExit: async (marker, timeoutMs) => {
          markerWaits += 1;
          if (markerWaits === 1) {
            throw new Error("marker snapshot unavailable");
          }
          await waitForLinuxProcessMarkerExit(marker, timeoutMs);
        },
      },
    );
    const childProcess = child as ChildProcess;
    const childPid = childProcess.pid;
    expect(childPid).toBeDefined();
    trackProcess(childPid!);
    await new Promise<void>((resolve) => childProcess.once("exit", () => resolve()));
    await expectExited(childPid!);

    await expect(drainClaudeTasks(processTasks)).rejects.toThrow("marker snapshot unavailable");
    expect(processTasks.size).toBe(1);
    await drainClaudeTasks(processTasks);
    expect(markerWaits).toBe(2);
    expect(processTasks.size).toBe(0);
  });

  test("cleans a marker-owned nested session after the provider root exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-process-fast-exit-"));
    directories.add(directory);
    const shellPidPath = join(directory, "shell.pid");
    const workerPidPath = join(directory, "worker.pid");
    const nestedCommand = `echo $$ > ${shellPidPath}; sleep 30 & echo $! > ${workerPidPath}; wait`;
    const controller = new AbortController();
    const processTasks = new Set<Promise<void>>();
    const child = spawnClaudeCodeProcess(
      {
        command: "sh",
        args: [
          "-c",
          `setsid sh -c '${nestedCommand}' & while [ ! -s ${workerPidPath} ]; do :; done`,
        ],
        cwd: directory,
        env: {},
        signal: controller.signal,
      },
      () => {},
      controller.signal,
      processTasks,
    );
    const childProcess = child as ChildProcess;
    const childPid = childProcess.pid;
    expect(childPid).toBeDefined();
    trackProcess(childPid!);
    expect(processTasks.size).toBe(1);
    const cleanupTask = [...processTasks][0]!;
    const [shellPid, workerPid] = await Promise.all([
      waitForPid(shellPidPath),
      waitForPid(workerPidPath),
    ]);

    await cleanupTask;
    expect(childProcess.exitCode).toBe(0);
    await Promise.all([expectExited(childPid!), expectExited(shellPid), expectExited(workerPid)]);
    expect(processTasks.size).toBe(1);
    await drainClaudeTasks(processTasks);
    expect(processTasks.size).toBe(0);
  });

  test("kills the isolated Claude session when its driver is SIGKILLed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-process-supervision-"));
    directories.add(directory);
    const shellPidPath = join(directory, "shell.pid");
    const workerPidPath = join(directory, "worker.pid");
    const nestedCommand = `echo $$ > ${shellPidPath}; sleep 30 & echo $! > ${workerPidPath}; wait`;
    const helperSource = String.raw`
import { spawnClaudeCodeProcess } from "./src/runtimes/claude/agent-sdk-process.ts";
const controller = new AbortController();
spawnClaudeCodeProcess({
  command: "sh",
  args: ["-c", ${JSON.stringify(`setsid sh -c '${nestedCommand}' & wait`)}],
  cwd: ${JSON.stringify(directory)},
  env: {},
  signal: controller.signal,
}, () => {}, controller.signal);
setInterval(() => {}, 1_000);
`;
    const helper = spawn(process.execPath, ["-e", helperSource], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    const helperPid = helper.pid;
    expect(helperPid).toBeDefined();
    trackProcess(helperPid!);

    const [shellPid, workerPid] = await Promise.all([
      waitForPid(shellPidPath),
      waitForPid(workerPidPath),
    ]);
    expect(isRunning(shellPid)).toBe(true);
    expect(isRunning(workerPid)).toBe(true);

    process.kill(-helperPid!, "SIGKILL");
    await Promise.all([expectExited(shellPid), expectExited(workerPid)]);
    await expectExited(helperPid!);
  });
});
