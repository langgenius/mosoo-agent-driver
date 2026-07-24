import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

import { summarizePath } from "../../observability/driver-debug";
import type { DriverStartInput } from "../../protocol/start";
import { raceWithAbort, settlePromiseWithTimeout } from "../../utils/async";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import {
  bindSpawnedProcess,
  createProcessTreeEnvironment,
  hasBoundProcessRootExited,
  releaseLinuxProcessMarker,
  signalBoundProcessTree,
  signalLinuxProcessMarker,
  spawnLinuxProcessTreeWatchdog,
  waitForLinuxProcessMarkerExit,
} from "../child-process";
import type { BoundSpawnedProcess, LinuxProcessTreeWatchdog } from "../child-process";
import { readFallbackArgs, readFallbackCommand } from "./acp-configuration";

export type AcpAgentProcess = ChildProcessByStdio<Writable, Readable, Readable>;

const ACP_AGENT_EXIT_TIMEOUT_MS = 1_500;
const ACP_AGENT_FORCE_KILL_TIMEOUT_MS = 500;
const agentProcessCloseTasks = new WeakMap<AcpAgentProcess, Promise<void>>();
const agentProcessSupervision = new WeakMap<AcpAgentProcess, AcpAgentProcessSupervision>();

interface AcpAgentProcessSupervision {
  cleanupFailureReported: boolean;
  failure: Error | null;
  readonly marker: string;
  readonly target: BoundSpawnedProcess;
  watchdog: LinuxProcessTreeWatchdog | null;
}

interface AcpAgentProcessSupervisionOptions {
  readonly args?: readonly string[];
  readonly command?: string;
  readonly spawnWatchdog?: typeof spawnLinuxProcessTreeWatchdog;
}

export async function startAcpAgentProcess(
  context: AgentDriverContext,
  payload: DriverStartInput,
  env: Record<string, string>,
  signal: AbortSignal,
  supervisionOptions: AcpAgentProcessSupervisionOptions = {},
): Promise<AcpAgentProcess> {
  const command = supervisionOptions.command ?? readFallbackCommand();
  const args = supervisionOptions.args ?? readFallbackArgs();

  await raceWithAbort(
    Promise.all([
      mkdir(payload.execution.session.homePath, { recursive: true }),
      mkdir(env["MOSOO_ACP_HOME"] ?? payload.execution.session.homePath, { recursive: true }),
    ]),
    signal,
  );
  signal.throwIfAborted();

  context.logger.info("driver.acp.agent.spawning", {
    args,
    command,
  });
  context.logger.debug("driver.acp.agent.spawn.prepared", {
    cwd: summarizePath(payload.execution.session.cwd),
    envVarCount: Object.keys(env).length,
  });

  const processTree = createProcessTreeEnvironment(env);
  const agentProcess = spawn(command, args, {
    cwd: payload.execution.session.cwd,
    detached: true,
    env: processTree.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const target = bindSpawnedProcess(agentProcess, process.platform, processTree);
  const supervision: AcpAgentProcessSupervision = {
    cleanupFailureReported: false,
    failure: null,
    marker: processTree.marker,
    target,
    watchdog: null,
  };
  agentProcessSupervision.set(agentProcess, supervision);
  const onAbort = () => signalAcpAgentProcess(agentProcess, "SIGKILL");
  signal.addEventListener("abort", onAbort, { once: true });
  agentProcessCloseTasks.set(
    agentProcess,
    new Promise<void>((resolve) =>
      agentProcess.once("close", () => {
        signalLinuxProcessMarker(supervision.marker, "SIGKILL");
        signal.removeEventListener("abort", onAbort);
        resolve();
      }),
    ),
  );

  agentProcess.stderr.setEncoding("utf8");
  agentProcess.stderr.on("data", (chunk: string) => {
    const trimmed = chunk.trim();

    if (trimmed.length === 0) {
      return;
    }

    context.logger.warn("driver.acp.agent.stderr", {
      chunk: trimmed,
    });
  });
  agentProcess.on("error", (error) => {
    context.logger.error("driver.acp.agent.spawn.error", error, {
      command,
    });
  });
  agentProcess.on("exit", (code, signal) => {
    context.logger.info("driver.acp.agent.exited", {
      code,
      signal,
    });
  });

  try {
    supervision.watchdog =
      agentProcess.pid === undefined
        ? null
        : (supervisionOptions.spawnWatchdog ?? spawnLinuxProcessTreeWatchdog)(
            agentProcess.pid,
            processTree.marker,
          );
    if (supervision.watchdog !== null) {
      void supervision.watchdog.cleanup.then(
        () => {
          if (!hasBoundProcessRootExited(supervision.target)) {
            failAcpAgentSupervision(
              context,
              agentProcess,
              supervision,
              new Error("ACP agent process-tree watchdog exited before the agent process."),
            );
          }
        },
        (error: unknown) => {
          failAcpAgentSupervision(
            context,
            agentProcess,
            supervision,
            new Error("ACP agent process-tree watchdog failed.", { cause: error }),
          );
        },
      );
    }
    await once(agentProcess, "spawn", { signal });
    signal.throwIfAborted();
    if (process.platform === "linux" && supervision.watchdog === null) {
      throw new Error("ACP agent process supervision could not start.");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (supervision.failure !== null) {
      throw supervision.failure;
    }
    signal.throwIfAborted();
  } catch (error) {
    signalAcpAgentProcess(agentProcess, "SIGKILL");
    try {
      await stopAcpAgentProcess(
        context,
        agentProcess,
        "startup.failed",
        Date.now() + ACP_AGENT_EXIT_TIMEOUT_MS + ACP_AGENT_FORCE_KILL_TIMEOUT_MS,
        signal,
      );
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "ACP agent process startup cleanup failed.");
    }
    throw error;
  }

  return agentProcess;
}

export async function stopAcpAgentProcess(
  context: AgentDriverContext,
  agentProcess: AcpAgentProcess,
  reason: string,
  deadline = Date.now() + ACP_AGENT_EXIT_TIMEOUT_MS + ACP_AGENT_FORCE_KILL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  const onAbort = () => signalAcpAgentProcess(agentProcess, "SIGKILL");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }

  try {
    if (!signal?.aborted) {
      signalAcpAgentProcess(agentProcess, "SIGTERM");
    }
    const exitTimeoutMs = Math.min(ACP_AGENT_EXIT_TIMEOUT_MS, remainingMs(deadline));
    const exited = await waitForChildProcessExit(agentProcess, exitTimeoutMs);

    if (!exited) {
      context.logger.warn("driver.acp.agent.exit.timed_out", {
        reason,
        timeoutMs: exitTimeoutMs,
      });
      signalAcpAgentProcess(agentProcess, "SIGKILL");
      const forceKillTimeoutMs = Math.min(ACP_AGENT_FORCE_KILL_TIMEOUT_MS, remainingMs(deadline));
      const forceExited = await waitForChildProcessExit(agentProcess, forceKillTimeoutMs);

      if (!forceExited) {
        context.logger.warn("driver.acp.agent.force_exit.timed_out", {
          reason,
          timeoutMs: forceKillTimeoutMs,
        });
        throw new Error("ACP agent process did not exit after force kill.");
      }
    }
    signalAcpAgentMarker(agentProcess, "SIGKILL");
    await waitForAcpAgentCleanup(agentProcess, deadline);
    releaseAcpAgentProcessSupervision(agentProcess);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function releaseAcpAgentProcessSupervision(agentProcess: AcpAgentProcess): void {
  const supervision = agentProcessSupervision.get(agentProcess);
  if (supervision === undefined) {
    return;
  }
  releaseLinuxProcessMarker(supervision.marker);
  agentProcessCloseTasks.delete(agentProcess);
  agentProcessSupervision.delete(agentProcess);
}

function signalAcpAgentProcess(agentProcess: AcpAgentProcess, signal: NodeJS.Signals): boolean {
  const supervision = agentProcessSupervision.get(agentProcess);
  return supervision === undefined
    ? false
    : signalBoundProcessTree(supervision.target, supervision.marker, signal);
}

function signalAcpAgentMarker(agentProcess: AcpAgentProcess, signal: NodeJS.Signals): boolean {
  const marker = agentProcessSupervision.get(agentProcess)?.marker;
  return marker === undefined ? false : signalLinuxProcessMarker(marker, signal);
}

function failAcpAgentSupervision(
  context: AgentDriverContext,
  agentProcess: AcpAgentProcess,
  supervision: AcpAgentProcessSupervision,
  error: Error,
): void {
  if (supervision.failure !== null) {
    return;
  }
  supervision.failure = error;
  context.logger.error("driver.acp.agent.supervision.failed", error, {});
  signalAcpAgentProcess(agentProcess, "SIGKILL");
}

async function waitForAcpAgentCleanup(
  agentProcess: AcpAgentProcess,
  deadline: number,
): Promise<void> {
  const supervision = agentProcessSupervision.get(agentProcess);
  if (supervision === undefined) {
    return;
  }

  if (supervision.cleanupFailureReported) {
    await waitForLinuxProcessMarkerExit(supervision.marker, remainingMs(deadline));
    return;
  }

  const watchdogResult =
    supervision.watchdog === null
      ? null
      : await settlePromiseWithTimeout(supervision.watchdog.cleanup, {
          label: "ACP agent process-tree cleanup",
          timeoutMs: remainingMs(deadline),
        });
  let markerFailure: unknown = null;
  try {
    await waitForLinuxProcessMarkerExit(supervision.marker, remainingMs(deadline));
  } catch (error) {
    markerFailure = error;
  }

  if (watchdogResult?.status === "failed") {
    supervision.cleanupFailureReported = true;
    throw watchdogResult.error;
  }
  if (watchdogResult?.status === "timed_out") {
    supervision.cleanupFailureReported = true;
    throw new Error("ACP agent process-tree cleanup timed out.");
  }
  if (markerFailure !== null) {
    supervision.cleanupFailureReported = true;
    throw markerFailure;
  }
  if (supervision.failure !== null) {
    supervision.cleanupFailureReported = true;
    throw supervision.failure;
  }
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function waitForChildProcessExit(
  process: AcpAgentProcess,
  timeoutMs: number,
): Promise<boolean> {
  const closed = agentProcessCloseTasks.get(process);

  if (closed === undefined) {
    return process.exitCode !== null || process.signalCode !== null;
  }

  const result = await settlePromiseWithTimeout(closed, {
    label: "ACP agent process exit",
    timeoutMs,
  });

  if (result.status === "completed") {
    return true;
  }

  if (result.status === "timed_out") {
    return false;
  }

  throw result.error;
}
