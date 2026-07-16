import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

import { summarizePath } from "../../infrastructure/logging/driver-debug";
import type { DriverStartInput } from "../../protocol/start";
import { raceWithAbort, settlePromiseWithTimeout } from "../../utils/async";
import type { AgentDriverContext } from "../agent-driver-backend";
import { killProcessGroup } from "../child-process";
import { readFallbackArgs, readFallbackCommand } from "./acp-configuration";

export type AcpAgentProcess = ChildProcessByStdio<Writable, Readable, Readable>;

const ACP_AGENT_EXIT_TIMEOUT_MS = 1_500;
const ACP_AGENT_FORCE_KILL_TIMEOUT_MS = 500;
const agentProcessCloseTasks = new WeakMap<AcpAgentProcess, Promise<void>>();

export async function startAcpAgentProcess(
  context: AgentDriverContext,
  payload: DriverStartInput,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<AcpAgentProcess> {
  const command = readFallbackCommand();
  const args = readFallbackArgs();

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

  const agentProcess = spawn(command, args, {
    cwd: payload.execution.session.cwd,
    detached: true,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const onAbort = () => killProcessGroup(agentProcess, "SIGKILL");
  signal.addEventListener("abort", onAbort, { once: true });
  agentProcessCloseTasks.set(
    agentProcess,
    new Promise<void>((resolve) =>
      agentProcess.once("close", () => {
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

  await once(agentProcess, "spawn", { signal });
  signal.throwIfAborted();

  return agentProcess;
}

export async function stopAcpAgentProcess(
  context: AgentDriverContext,
  agentProcess: AcpAgentProcess,
  reason: string,
  deadline = Date.now() + ACP_AGENT_EXIT_TIMEOUT_MS + ACP_AGENT_FORCE_KILL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  const onAbort = () => killProcessGroup(agentProcess, "SIGKILL");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }

  try {
    killProcessGroup(agentProcess, "SIGTERM");
    const exitTimeoutMs = Math.min(ACP_AGENT_EXIT_TIMEOUT_MS, remainingMs(deadline));
    const exited = await waitForChildProcessExit(agentProcess, exitTimeoutMs, signal);

    if (exited) {
      killProcessGroup(agentProcess, "SIGKILL");
      return;
    }

    context.logger.warn("driver.acp.agent.exit.timed_out", {
      reason,
      timeoutMs: exitTimeoutMs,
    });
    killProcessGroup(agentProcess, "SIGKILL");
    const forceKillTimeoutMs = Math.min(ACP_AGENT_FORCE_KILL_TIMEOUT_MS, remainingMs(deadline));
    const forceExited = await waitForChildProcessExit(agentProcess, forceKillTimeoutMs, signal);

    if (!forceExited) {
      context.logger.warn("driver.acp.agent.force_exit.timed_out", {
        reason,
        timeoutMs: forceKillTimeoutMs,
      });
      throw new Error("ACP agent process did not exit after force kill.");
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function waitForChildProcessExit(
  process: AcpAgentProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const closed = agentProcessCloseTasks.get(process);

  if (closed === undefined) {
    return process.exitCode !== null || process.signalCode !== null;
  }

  const result = await settlePromiseWithTimeout(closed, {
    label: "ACP agent process exit",
    ...(signal === undefined ? {} : { signal }),
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
