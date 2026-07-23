import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bindSpawnedProcess,
  createProcessTreeEnvironment,
  PROCESS_TREE_OWNER_ENV,
  signalBoundProcessTree,
  spawnLinuxProcessTreeWatchdog,
} from "../src/runtimes/child-process";

const directories = new Set<string>();
const processIds = new Set<number>();

afterEach(async () => {
  for (const pid of processIds) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  processIds.clear();
  await Promise.all(
    [...directories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  directories.clear();
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  let pid = Number.NaN;

  while (Date.now() < deadline) {
    if (existsSync(path)) {
      pid = Number.parseInt(await readFile(path, "utf8"), 10);
      if (Number.isSafeInteger(pid) && pid > 1) {
        break;
      }
    }
    await Bun.sleep(20);
  }

  expect(pid).toBeGreaterThan(1);
  processIds.add(pid);
  return pid;
}

async function expectExited(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;

  while (isRunning(pid) && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  expect(isRunning(pid)).toBe(false);
  processIds.delete(pid);
}

function spawnMarkedRoot(source: string) {
  const processTree = createProcessTreeEnvironment(process.env);
  const child = spawn(process.execPath, ["-e", source], {
    detached: true,
    env: processTree.env,
    stdio: "ignore",
  });
  expect(child.pid).toBeDefined();
  processIds.add(child.pid!);
  return { child, marker: processTree.marker };
}

describe.skipIf(process.platform !== "linux")("Linux process-tree watchdog", () => {
  test("rejects raw signals after the bound root identity changes", async () => {
    const child = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
    });
    expect(child.pid).toBeDefined();
    processIds.add(child.pid!);
    const target = bindSpawnedProcess(child);
    expect(target.linuxIdentity).not.toBeNull();
    const staleTarget = {
      ...target,
      linuxIdentity: {
        ...target.linuxIdentity!,
        startTime: `${target.linuxIdentity!.startTime}0`,
      },
    };

    expect(signalBoundProcessTree(staleTarget, "", "SIGKILL")).toBe(false);
    expect(isRunning(child.pid!)).toBe(true);

    expect(signalBoundProcessTree(target, "", "SIGKILL")).toBe(true);
    await expectExited(child.pid!);
  });

  test("reuses one crash supervisor for independent process trees", async () => {
    const firstTree = createProcessTreeEnvironment(process.env);
    const secondTree = createProcessTreeEnvironment(process.env);
    const first = spawn("sleep", ["30"], { env: firstTree.env });
    const second = spawn("sleep", ["30"], { env: secondTree.env });
    expect(first.pid).toBeDefined();
    expect(second.pid).toBeDefined();
    processIds.add(first.pid!);
    processIds.add(second.pid!);
    const firstLease = spawnLinuxProcessTreeWatchdog(first.pid!, firstTree.marker);
    const secondLease = spawnLinuxProcessTreeWatchdog(second.pid!, secondTree.marker);

    expect(firstTree.marker).not.toBe(secondTree.marker);
    expect(firstTree.env[PROCESS_TREE_OWNER_ENV]).toBe(secondTree.env[PROCESS_TREE_OWNER_ENV]);
    expect(firstLease?.process).toBe(secondLease?.process);

    first.kill("SIGKILL");
    second.kill("SIGKILL");
    await Promise.all([firstLease!.cleanup, secondLease!.cleanup]);
    await Promise.all([expectExited(first.pid!), expectExited(second.pid!)]);
  });

  test("cleans a marked nested session when its root exits before the first snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "process-watchdog-fast-exit-"));
    directories.add(directory);
    const workerPidPath = join(directory, "worker.pid");
    const source = `
const { spawn } = require("node:child_process");
const child = spawn("/usr/bin/setsid", [
  "/bin/sh",
  "-c",
  ${JSON.stringify(`echo $$ > ${workerPidPath}; exec sleep 30`)},
], {
  env: process.env,
  stdio: "ignore",
});
child.unref();
`;
    const { child, marker } = spawnMarkedRoot(source);
    const watchdog = spawnLinuxProcessTreeWatchdog(child.pid!, marker);
    expect(watchdog).not.toBeNull();
    const workerPid = await waitForPid(workerPidPath);

    await watchdog!.cleanup;
    await Promise.all([expectExited(child.pid!), expectExited(workerPid)]);
  });

  test("does not release its cleanup lease while the marked root is alive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "process-watchdog-lease-"));
    directories.add(directory);
    const workerPidPath = join(directory, "worker.pid");
    const source = `
const { spawn } = require("node:child_process");
spawn("/usr/bin/setsid", [
  "/bin/sh",
  "-c",
  ${JSON.stringify(`echo $$ > ${workerPidPath}; exec sleep 30`)},
], {
  env: process.env,
  stdio: "ignore",
});
setInterval(() => {}, 1_000);
`;
    const { child, marker } = spawnMarkedRoot(source);
    const watchdog = spawnLinuxProcessTreeWatchdog(child.pid!, marker);
    expect(watchdog).not.toBeNull();
    const workerPid = await waitForPid(workerPidPath);
    let cleaned = false;
    void watchdog!.cleanup.then(() => {
      cleaned = true;
    });

    await Bun.sleep(150);
    expect(cleaned).toBe(false);
    process.kill(child.pid!, "SIGKILL");
    await watchdog!.cleanup;
    expect(cleaned).toBe(true);
    await Promise.all([expectExited(child.pid!), expectExited(workerPid)]);
  });
});
