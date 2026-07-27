import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";

export const PROCESS_TREE_MARKER_ENV = "MOSOO_PROCESS_TREE_ID";
export const PROCESS_TREE_OWNER_ENV = "MOSOO_PROCESS_TREE_OWNER_ID";

const PROCESS_TREE_SUPERVISOR_SOURCE = String.raw`
const { readdirSync, readFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const ownerEntry = "MOSOO_PROCESS_TREE_OWNER_ID=" + process.argv[1];
const ownerUid = Number(process.argv[2]);
const tracked = new Map();
const readStat = (pid) => {
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { parentPid: Number(fields[1]), startTime: fields[19], state: fields[0] };
  } catch {
    return null;
  }
};
const supervisorStartTime = readStat(process.pid)?.startTime;
const readUid = (pid, startTime) => {
  try {
    const status = readFileSync("/proc/" + pid + "/status", "utf8");
    if (/^Kthread:\s+1$/m.test(status)) return false;
    const match = /^Uid:\s+(\d+)/m.exec(status);
    return match === null ? null : Number(match[1]);
  } catch {
    return readStat(pid)?.startTime === startTime ? null : false;
  }
};
const hasOwner = (pid, startTime) => {
  if (tracked.get(pid) === startTime) return true;
  try {
    const matches = readFileSync("/proc/" + pid + "/environ", "utf8")
      .split("\0")
      .includes(ownerEntry);
    if (matches) tracked.set(pid, startTime);
    return matches;
  } catch {
    return readStat(pid)?.startTime === startTime ? null : false;
  }
};
const snapshot = () => {
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }

  const processes = new Map();
  const targets = new Set();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readStat(entry);
    if (stat === null) {
      try {
        readFileSync("/proc/" + entry + "/status", "utf8");
        return null;
      } catch {
        continue;
      }
    }
    if (stat.state === "Z" || stat.state === "X") continue;
    if (
      supervisorStartTime !== undefined &&
      Number(stat.startTime) < Number(supervisorStartTime)
    ) continue;
    const uid = readUid(entry, stat.startTime);
    if (uid === null) return null;
    if (uid === false || uid !== ownerUid) continue;
    const pid = Number(entry);
    processes.set(pid, stat);
    if (tracked.get(pid) === stat.startTime) targets.add(pid);
  }
  const includeDescendants = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, stat] of processes) {
        if (!targets.has(pid) && targets.has(stat.parentPid)) {
          targets.add(pid);
          changed = true;
        }
      }
    }
  };
  includeDescendants();
  for (const [pid, stat] of processes) {
    if (targets.has(pid)) continue;
    const matches = hasOwner(pid, stat.startTime);
    if (matches === null) return null;
    if (matches) targets.add(pid);
  }
  includeDescendants();
  const depth = (pid) => {
    let value = 0;
    let current = processes.get(pid);
    const seen = new Set();
    while (current !== undefined && targets.has(current.parentPid) && !seen.has(current.parentPid)) {
      seen.add(current.parentPid);
      value += 1;
      current = processes.get(current.parentPid);
    }
    return value;
  };
  return [...targets]
    .sort((left, right) => depth(right) - depth(left))
    .map((pid) => [pid, processes.get(pid).startTime]);
};
let cleaning = false;
const beginCleanup = () => {
  if (cleaning) return;
  cleaning = true;
  let emptyTicks = 0;
  const timer = setInterval(() => {
    const owned = snapshot();
    if (owned === null) {
      emptyTicks = 0;
    } else {
      for (const [pid, startTime] of owned) {
        if (readStat(pid)?.startTime !== startTime) continue;
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      emptyTicks = owned.length === 0 ? emptyTicks + 1 : 0;
      if (emptyTicks >= 2) {
        clearInterval(timer);
        process.exit(0);
      }
    }
  }, 50);
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const match = /^(\d+) (\d+)$/.exec(line);
  if (match === null) return;
  const pid = Number(match[1]);
  const stat = readStat(pid);
  if (Number.isSafeInteger(pid) && pid > 1 && stat?.startTime === match[2]) {
    tracked.set(pid, stat.startTime);
  }
});
process.stdin.once("end", beginCleanup);
process.stdin.once("close", beginCleanup);
process.stdin.once("error", beginCleanup);
`;

interface LinuxProcessTreeSupervisor {
  readonly failure: Promise<never>;
  readonly ownerId: string;
  readonly process: ChildProcess;
  readonly startTime: string;
}

interface LinuxMarkedProcessState {
  cutoff: number | null;
  leases: number;
  readonly processes: Map<number, string>;
  released: boolean;
}

let linuxProcessTreeSupervisor: LinuxProcessTreeSupervisor | null = null;
const linuxMarkedProcessStates = new Map<string, LinuxMarkedProcessState>();

export interface LinuxProcessTreeWatchdog {
  readonly cleanup: Promise<void>;
  readonly process: ChildProcess;
}

export interface BoundSpawnedProcess {
  readonly killRoot: (signal: NodeJS.Signals | number) => boolean;
  readonly linuxIdentity: {
    readonly pid: number;
    readonly startTime: string;
  } | null;
  readonly pid: number | undefined;
  readonly platform: NodeJS.Platform;
}

export interface ProcessTreeEnvironment {
  readonly env: NodeJS.ProcessEnv;
  readonly marker: string;
}

interface LinuxProcessStat {
  readonly parentPid: number;
  readonly sessionId: number;
  readonly state: string;
  readonly startTime: string;
}

function readLinuxProcessStat(pid: number): LinuxProcessStat | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const parentPid = Number(fields[1]);
    const sessionId = Number(fields[3]);
    const state = fields[0];
    const startTime = fields[19];

    return Number.isSafeInteger(parentPid) &&
      parentPid >= 0 &&
      Number.isSafeInteger(sessionId) &&
      sessionId >= 0 &&
      state !== undefined &&
      state.length === 1 &&
      startTime !== undefined
      ? { parentPid, sessionId, startTime, state }
      : null;
  } catch {
    return null;
  }
}

function linuxProcessIdentityState(
  pid: number,
  startTime: string,
): "exited" | "indeterminate" | "running" {
  const stat = readLinuxProcessStat(pid);
  if (stat === null) {
    return existsSync(`/proc/${pid}`) ? "indeterminate" : "exited";
  }
  return stat.startTime === startTime && stat.state !== "Z" && stat.state !== "X"
    ? "running"
    : "exited";
}

function ensureLinuxProcessTreeSupervisor(): LinuxProcessTreeSupervisor | null {
  if (process.platform !== "linux") {
    return null;
  }
  if (linuxProcessTreeSupervisor !== null) {
    return linuxProcessTreeSupervisor;
  }

  const ownerUid = process.getuid?.();
  if (ownerUid === undefined) {
    throw new Error("Process-tree supervision requires a POSIX user ID.");
  }
  const ownerId = randomUUID();
  const runtimeArgs =
    process.versions["bun"] === undefined
      ? ["-e", PROCESS_TREE_SUPERVISOR_SOURCE]
      : ["--smol", "-e", PROCESS_TREE_SUPERVISOR_SOURCE];
  const supervisorProcess = spawn(process.execPath, [...runtimeArgs, ownerId, String(ownerUid)], {
    cwd: "/",
    detached: true,
    env: {},
    stdio: ["pipe", "ignore", "ignore"],
  });
  const failure = new Promise<never>((_resolve, reject) => {
    supervisorProcess.once("error", reject);
    supervisorProcess.stdin?.once("error", reject);
    supervisorProcess.once("exit", (code, signal) => {
      reject(
        new Error(
          `Process-tree supervisor exited with ${
            code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`
          }.`,
        ),
      );
    });
  });
  void failure.catch(() => {});

  if (supervisorProcess.pid === undefined || supervisorProcess.stdin === null) {
    supervisorProcess.kill("SIGKILL");
    throw new Error("Process-tree supervisor failed to start.");
  }
  const startTime = readLinuxProcessStat(supervisorProcess.pid)?.startTime;
  if (startTime === undefined) {
    supervisorProcess.kill("SIGKILL");
    throw new Error("Process-tree supervisor identity is unavailable.");
  }

  supervisorProcess.unref();
  (
    supervisorProcess.stdin as typeof supervisorProcess.stdin & {
      unref?: () => void;
    }
  ).unref?.();
  linuxProcessTreeSupervisor = {
    failure,
    ownerId,
    process: supervisorProcess,
    startTime,
  };
  return linuxProcessTreeSupervisor;
}

function readLinuxProcessSnapshot(): Map<number, LinuxProcessStat> | null {
  const processes = new Map<number, LinuxProcessStat>();

  try {
    for (const entry of readdirSync("/proc")) {
      const pid = Number(entry);
      if (!Number.isSafeInteger(pid) || pid < 1) {
        continue;
      }

      const stat = readLinuxProcessStat(pid);
      if (stat !== null) {
        processes.set(pid, stat);
      } else if (existsSync(`/proc/${pid}`)) {
        return null;
      }
    }
  } catch {
    return null;
  }

  return processes;
}

function processMatchesCurrentUid(pid: number, startTime: string): boolean | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    if (/^Kthread:\s+1$/m.test(status)) {
      return false;
    }
    const match = /^Uid:\s+(\d+)/m.exec(status);
    const currentUid = process.getuid?.();
    return match === null || currentUid === undefined ? null : Number(match[1]) === currentUid;
  } catch {
    return readLinuxProcessStat(pid)?.startTime === startTime ? null : false;
  }
}

function linuxMarkedProcessState(marker: string): LinuxMarkedProcessState {
  let state = linuxMarkedProcessStates.get(marker);
  if (state === undefined) {
    state = {
      cutoff: null,
      leases: 0,
      processes: new Map(),
      released: false,
    };
    linuxMarkedProcessStates.set(marker, state);
  }
  return state;
}

function processHasMarker(
  pid: number,
  marker: string,
  startTime: string,
  state: LinuxMarkedProcessState,
): boolean | null {
  if (state.processes.get(pid) === startTime) {
    return true;
  }

  try {
    const matches = readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .includes(`${PROCESS_TREE_MARKER_ENV}=${marker}`);
    if (matches) {
      state.processes.set(pid, startTime);
    }
    return matches;
  } catch {
    return readLinuxProcessStat(pid)?.startTime === startTime ? null : false;
  }
}

function readLinuxMarkedProcessSnapshot(
  marker: string,
): ReadonlyMap<number, LinuxProcessStat> | null {
  const state = linuxMarkedProcessStates.get(marker);
  if (state === undefined) {
    return new Map();
  }
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }

  const processes = new Map<number, LinuxProcessStat>();
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid < 1) {
      continue;
    }

    const stat = readLinuxProcessStat(pid);
    if (stat === null) {
      if (existsSync(`/proc/${pid}`)) {
        return null;
      }
      continue;
    }
    if (stat.state === "Z" || stat.state === "X") {
      continue;
    }
    if (state.cutoff !== null && Number(stat.startTime) < state.cutoff) {
      continue;
    }
    const matchesUid = processMatchesCurrentUid(pid, stat.startTime);
    if (matchesUid === null) {
      return null;
    }
    if (!matchesUid) {
      continue;
    }

    const matchesMarker = processHasMarker(pid, marker, stat.startTime, state);
    if (matchesMarker === null) {
      return null;
    }
    if (matchesMarker) {
      processes.set(pid, stat);
    }
  }

  return processes;
}

export function createProcessTreeEnvironment(
  env: Readonly<NodeJS.ProcessEnv>,
): ProcessTreeEnvironment {
  const supervisor = ensureLinuxProcessTreeSupervisor();
  const marker = randomUUID();
  if (supervisor !== null) {
    linuxMarkedProcessState(marker).cutoff = Number(supervisor.startTime);
  }
  return {
    env: {
      ...env,
      [PROCESS_TREE_MARKER_ENV]: marker,
      ...(supervisor === null ? {} : { [PROCESS_TREE_OWNER_ENV]: supervisor.ownerId }),
    },
    marker,
  };
}

function collectLinuxProcessTree(
  processes: ReadonlyMap<number, LinuxProcessStat>,
  rootPid: number,
): Set<number> {
  const root = processes.get(rootPid);
  if (root === undefined) {
    return new Set();
  }

  const descendants = new Set([rootPid]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const [pid, stat] of processes) {
      if (!descendants.has(pid) && descendants.has(stat.parentPid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }

  return descendants;
}

function processDepth(
  processes: ReadonlyMap<number, LinuxProcessStat>,
  tree: ReadonlySet<number>,
  pid: number,
): number {
  let depth = 0;
  let current = processes.get(pid);
  const seen = new Set<number>();

  while (current !== undefined && tree.has(current.parentPid) && !seen.has(current.parentPid)) {
    seen.add(current.parentPid);
    depth += 1;
    current = processes.get(current.parentPid);
  }

  return depth;
}

export function bindSpawnedProcess(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  processTree?: ProcessTreeEnvironment,
): BoundSpawnedProcess {
  const pid = child.pid;
  const stat = platform === "linux" && pid !== undefined ? readLinuxProcessStat(pid) : null;
  if (pid !== undefined && stat !== null && processTree !== undefined) {
    const state = linuxMarkedProcessStates.get(processTree.marker);
    const stdin = linuxProcessTreeSupervisor?.process.stdin;
    if (state !== undefined) {
      state.cutoff = Number(stat.startTime);
      state.processes.set(pid, stat.startTime);
    }
    if (
      state === undefined ||
      stdin === null ||
      stdin === undefined ||
      stdin.destroyed ||
      stdin.writableEnded
    ) {
      child.kill("SIGKILL");
    } else {
      try {
        stdin.write(`${pid} ${stat.startTime}\n`);
      } catch {
        child.kill("SIGKILL");
      }
    }
  }

  return {
    killRoot: child.kill.bind(child),
    linuxIdentity:
      pid === undefined || stat === null
        ? null
        : {
            pid,
            startTime: stat.startTime,
          },
    pid,
    platform,
  };
}

export function hasBoundProcessRootExited(target: BoundSpawnedProcess): boolean {
  const identity = target.linuxIdentity;
  return (
    target.platform === "linux" &&
    identity !== null &&
    linuxProcessIdentityState(identity.pid, identity.startTime) === "exited"
  );
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals | number,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32" || !Number.isSafeInteger(processGroupId) || processGroupId < 2) {
    return false;
  }

  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch {
    return false;
  }
}

function signalBoundLinuxProcessSession(
  identity: NonNullable<BoundSpawnedProcess["linuxIdentity"]>,
  signal: NodeJS.Signals | number,
): boolean {
  if (
    process.platform !== "linux" ||
    linuxProcessIdentityState(identity.pid, identity.startTime) !== "running"
  ) {
    return false;
  }

  const processes = readLinuxProcessSnapshot();
  if (processes === null) {
    return false;
  }
  let signalled = false;

  for (const [pid, stat] of processes) {
    if (
      pid !== identity.pid &&
      stat.sessionId === identity.pid &&
      linuxProcessIdentityState(identity.pid, identity.startTime) === "running" &&
      readLinuxProcessStat(pid)?.startTime === stat.startTime
    ) {
      try {
        process.kill(pid, signal);
        signalled = true;
      } catch {}
    }
  }

  return signalled;
}

function signalBoundProcessGroup(
  identity: NonNullable<BoundSpawnedProcess["linuxIdentity"]>,
  signal: NodeJS.Signals | number,
): boolean {
  return linuxProcessIdentityState(identity.pid, identity.startTime) === "running"
    ? signalProcessGroup(identity.pid, signal, "linux")
    : false;
}

function signalBoundProcessRoot(
  target: BoundSpawnedProcess,
  identity: NonNullable<BoundSpawnedProcess["linuxIdentity"]>,
  signal: NodeJS.Signals | number,
): boolean {
  return linuxProcessIdentityState(identity.pid, identity.startTime) === "running"
    ? target.killRoot(signal)
    : false;
}

export function signalLinuxProcessMarker(marker: string, signal: NodeJS.Signals | number): boolean {
  if (process.platform !== "linux" || marker.length === 0) {
    return false;
  }

  const snapshot = readLinuxMarkedProcessSnapshot(marker);
  if (snapshot === null) {
    return false;
  }

  const tree = new Set(snapshot.keys());
  const targets = [...snapshot.keys()];
  targets.sort(
    (leftPid, rightPid) =>
      processDepth(snapshot, tree, rightPid) - processDepth(snapshot, tree, leftPid),
  );
  let signalled = false;

  for (const pid of targets) {
    const startTime = snapshot.get(pid)?.startTime;
    if (startTime === undefined || readLinuxProcessStat(pid)?.startTime !== startTime) {
      continue;
    }
    try {
      process.kill(pid, signal);
      signalled = true;
    } catch {}
  }

  return signalled;
}

export async function waitForLinuxProcessMarkerExit(
  marker: string,
  timeoutMs = 2_000,
): Promise<void> {
  if (process.platform !== "linux" || marker.length === 0) {
    return;
  }

  const state = linuxMarkedProcessStates.get(marker);
  if (state === undefined) {
    return;
  }
  state.leases += 1;
  const deadline = Date.now() + timeoutMs;
  let emptySnapshots = 0;

  try {
    for (;;) {
      const snapshot = readLinuxMarkedProcessSnapshot(marker);
      emptySnapshots = snapshot !== null && snapshot.size === 0 ? emptySnapshots + 1 : 0;
      if (emptySnapshots >= 2) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Supervised process tree did not exit within ${timeoutMs}ms.`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    state.leases -= 1;
    if (state.released && state.leases === 0) {
      linuxMarkedProcessStates.delete(marker);
    }
  }
}

export function releaseLinuxProcessMarker(marker: string): void {
  const state = linuxMarkedProcessStates.get(marker);
  if (state === undefined) {
    return;
  }
  state.released = true;
  if (state.leases === 0) {
    linuxMarkedProcessStates.delete(marker);
  }
}

function signalLinuxProcessTreeMembers(
  identity: NonNullable<BoundSpawnedProcess["linuxIdentity"]>,
  signal: NodeJS.Signals | number,
  includeRoot: boolean,
): boolean {
  if (
    process.platform !== "linux" ||
    linuxProcessIdentityState(identity.pid, identity.startTime) !== "running"
  ) {
    return false;
  }

  const processes = readLinuxProcessSnapshot();
  if (processes === null) {
    return false;
  }
  if (processes.get(identity.pid)?.startTime !== identity.startTime) {
    return false;
  }
  const tree = collectLinuxProcessTree(processes, identity.pid);
  const targets = [...tree]
    .filter((pid) => includeRoot || pid !== identity.pid)
    .sort((left, right) => {
      if (left === identity.pid) return 1;
      if (right === identity.pid) return -1;
      return processDepth(processes, tree, right) - processDepth(processes, tree, left);
    });
  let signalled = false;

  for (const pid of targets) {
    const startTime = processes.get(pid)?.startTime;
    if (
      startTime === undefined ||
      linuxProcessIdentityState(identity.pid, identity.startTime) !== "running" ||
      readLinuxProcessStat(pid)?.startTime !== startTime
    ) {
      continue;
    }
    try {
      process.kill(pid, signal);
      signalled = true;
    } catch {}
  }

  return signalled;
}

export function signalBoundProcessTree(
  target: BoundSpawnedProcess,
  marker: string,
  signal: NodeJS.Signals | number,
): boolean {
  if (target.platform !== "linux") {
    return (
      (target.pid !== undefined && signalProcessGroup(target.pid, signal, target.platform)) ||
      target.killRoot(signal)
    );
  }

  const identity = target.linuxIdentity;
  const descendantsSignalled =
    identity !== null && signalLinuxProcessTreeMembers(identity, signal, false);
  const sessionSignalled = identity !== null && signalBoundLinuxProcessSession(identity, signal);
  const rootSignalled = identity !== null && signalBoundProcessRoot(target, identity, signal);
  const processGroupSignalled = identity !== null && signalBoundProcessGroup(identity, signal);
  const markerSignalled = signalLinuxProcessMarker(marker, signal);

  return (
    descendantsSignalled ||
    sessionSignalled ||
    rootSignalled ||
    markerSignalled ||
    processGroupSignalled
  );
}

export function spawnLinuxProcessTreeWatchdog(
  rootPid: number,
  marker = "",
): LinuxProcessTreeWatchdog | null {
  if (process.platform !== "linux" || !Number.isSafeInteger(rootPid) || rootPid < 2) {
    return null;
  }

  const supervisor = ensureLinuxProcessTreeSupervisor();
  if (supervisor === null) {
    return null;
  }
  const rootStartTime = readLinuxProcessStat(rootPid)?.startTime ?? "";
  if (rootStartTime === "" && marker === "") {
    return null;
  }
  const markerState = marker === "" ? undefined : linuxMarkedProcessStates.get(marker);
  if (marker !== "" && markerState === undefined) {
    return null;
  }
  if (markerState !== undefined) {
    markerState.leases += 1;
  }
  const localCleanup = (async () => {
    try {
      while (
        rootStartTime !== "" &&
        linuxProcessIdentityState(rootPid, rootStartTime) !== "exited"
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      if (marker !== "") {
        const retry = setInterval(() => {
          signalLinuxProcessMarker(marker, "SIGKILL");
        }, 50);
        try {
          signalProcessGroup(rootPid, "SIGKILL", "linux");
          signalLinuxProcessMarker(marker, "SIGKILL");
          await waitForLinuxProcessMarkerExit(marker);
        } finally {
          clearInterval(retry);
        }
      }
    } finally {
      if (markerState !== undefined) {
        markerState.leases -= 1;
        if (markerState.released && markerState.leases === 0) {
          linuxMarkedProcessStates.delete(marker);
        }
      }
    }
  })();
  const cleanup = Promise.race([localCleanup, supervisor.failure]);
  void cleanup.catch(() => {});
  return { cleanup, process: supervisor.process };
}
