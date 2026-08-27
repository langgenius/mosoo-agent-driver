import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bindSpawnedProcess,
  createProcessTreeEnvironment,
  PROCESS_TREE_MARKER_ENV,
  PROCESS_TREE_OWNER_ENV,
  releaseLinuxProcessMarker,
  signalBoundProcessTree,
  signalLinuxProcessMarker,
  spawnLinuxProcessTreeWatchdog,
  waitForLinuxProcessMarkerExit,
} from "../src/runtimes/child-process";

const directories = new Set<string>();
const processIds = new Set<number>();
const NON_DUMPABLE_PROCESS_SOURCE = String.raw`
import { dlopen, FFIType } from "bun:ffi";
const libc = dlopen("libc.so.6", {
  prctl: {
    args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.i32,
  },
});
if (libc.symbols.prctl(4, 0, 0, 0, 0) !== 0) process.exit(1);
process.stdout.write("ready\n");
setInterval(() => {}, 1_000);
`;

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

async function spawnNonDumpableProcess() {
  const child = spawn(process.execPath, ["-e", NON_DUMPABLE_PROCESS_SOURCE], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  expect(child.pid).toBeDefined();
  processIds.add(child.pid!);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`Non-dumpable process exited with code ${code}.`));
    });
    child.stdout!.once("data", () => {
      resolve();
    });
  });
  return child;
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
  bindSpawnedProcess(child, process.platform, processTree);
  return { child, marker: processTree.marker };
}

describe.skipIf(process.platform !== "linux")("Linux process-tree watchdog", () => {
  test.skipIf(process.getuid?.() === 0)(
    "ignores an older non-dumpable process outside the marked tree",
    async () => {
      const unrelated = await spawnNonDumpableProcess();
      expect(() => readFileSync(`/proc/${unrelated.pid}/environ`)).toThrow();
      await Bun.sleep(25);
      const { child, marker } = spawnMarkedRoot("setInterval(() => {}, 1_000);");
      const watchdog = spawnLinuxProcessTreeWatchdog(child.pid!, marker);
      expect(watchdog).not.toBeNull();

      process.kill(child.pid!, "SIGKILL");
      await watchdog!.cleanup;
      await expectExited(child.pid!);
      process.kill(unrelated.pid!, "SIGKILL");
      await expectExited(unrelated.pid!);
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "keeps a newer unreadable process indeterminate",
    async () => {
      const processTree = createProcessTreeEnvironment(process.env);
      const root = spawn("sleep", ["30"], { env: processTree.env });
      expect(root.pid).toBeDefined();
      processIds.add(root.pid!);
      bindSpawnedProcess(root, process.platform, processTree);
      root.kill("SIGKILL");
      await expectExited(root.pid!);
      const unreadable = await spawnNonDumpableProcess();
      expect(() => readFileSync(`/proc/${unreadable.pid}/environ`)).toThrow();

      await expect(waitForLinuxProcessMarkerExit(processTree.marker, 100)).rejects.toThrow(
        "Supervised process tree did not exit",
      );
      process.kill(unreadable.pid!, "SIGKILL");
      await expectExited(unreadable.pid!);
      await expect(waitForLinuxProcessMarkerExit(processTree.marker)).resolves.toBeUndefined();
      releaseLinuxProcessMarker(processTree.marker);
    },
  );

  test("does not reserve process state until a root is bound", async () => {
    const processTrees = Array.from({ length: 64 }, () =>
      createProcessTreeEnvironment(process.env),
    );

    for (const processTree of processTrees) {
      expect(spawnLinuxProcessTreeWatchdog(process.pid, processTree.marker)).toBeNull();
      await expect(waitForLinuxProcessMarkerExit(processTree.marker, 1)).resolves.toBeUndefined();
    }
  });

  test("keeps a confirmed process after it clears the marker environment", async () => {
    const processTree = createProcessTreeEnvironment(process.env);
    const child = spawn("/bin/sh", ["-c", "kill -STOP $$; exec env -i /bin/sleep 30"], {
      detached: true,
      env: processTree.env,
      stdio: "ignore",
    });
    expect(child.pid).toBeDefined();
    processIds.add(child.pid!);
    bindSpawnedProcess(child, process.platform, processTree);
    const stoppedDeadline = Date.now() + 3_000;
    let stopped = false;
    while (Date.now() < stoppedDeadline) {
      const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
      stopped = stat.slice(stat.lastIndexOf(")") + 2).startsWith("T ");
      if (stopped) break;
      await Bun.sleep(20);
    }
    expect(stopped).toBe(true);
    expect(signalLinuxProcessMarker(processTree.marker, 0)).toBe(true);

    process.kill(child.pid!, "SIGCONT");
    const clearedDeadline = Date.now() + 3_000;
    let markerPresent = true;
    while (markerPresent && Date.now() < clearedDeadline) {
      markerPresent = readFileSync(`/proc/${child.pid}/environ`, "utf8")
        .split("\0")
        .includes(`${PROCESS_TREE_MARKER_ENV}=${processTree.marker}`);
      if (markerPresent) await Bun.sleep(20);
    }
    expect(markerPresent).toBe(false);
    expect(signalLinuxProcessMarker(processTree.marker, "SIGKILL")).toBe(true);
    await waitForLinuxProcessMarkerExit(processTree.marker);
    await expectExited(child.pid!);
    releaseLinuxProcessMarker(processTree.marker);
  });

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

  test("does not supervise a root before marker ownership is bound", async () => {
    const marker = createProcessTreeEnvironment(process.env).marker;
    const child = spawn("sleep", ["30"]);
    expect(child.pid).toBeDefined();
    processIds.add(child.pid!);
    const watchdog = spawnLinuxProcessTreeWatchdog(child.pid!, marker);

    expect(watchdog).toBeNull();
    expect(signalLinuxProcessMarker(marker, 0)).toBe(false);
    expect(isRunning(child.pid!)).toBe(true);
    child.kill("SIGKILL");
    await expectExited(child.pid!);
  });

  test("keeps marker state until its watchdog lease ends", async () => {
    const { child, marker } = spawnMarkedRoot("setInterval(() => {}, 1_000);");
    const watchdog = spawnLinuxProcessTreeWatchdog(child.pid!, marker);
    expect(watchdog).not.toBeNull();

    releaseLinuxProcessMarker(marker);
    await expect(waitForLinuxProcessMarkerExit(marker, 100)).rejects.toThrow(
      "Supervised process tree did not exit",
    );

    child.kill("SIGKILL");
    await watchdog!.cleanup;
    await expectExited(child.pid!);
    await expect(waitForLinuxProcessMarkerExit(marker, 100)).resolves.toBeUndefined();
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
    bindSpawnedProcess(first, process.platform, firstTree);
    bindSpawnedProcess(second, process.platform, secondTree);
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

  test("cleans an unmarked process-group member after its root exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "process-watchdog-unmarked-child-"));
    directories.add(directory);
    const workerPidPath = join(directory, "worker.pid");
    const source = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn("sleep", ["30"], { env: {}, stdio: "ignore" });
writeFileSync(${JSON.stringify(workerPidPath)}, String(child.pid));
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
