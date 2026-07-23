import { spawn } from "node:child_process";

import type {
  SpawnedProcess as ClaudeSpawnedProcess,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

import {
  bindSpawnedProcess,
  createProcessTreeEnvironment,
  signalBoundProcessTree,
  signalLinuxProcessMarker,
  spawnLinuxProcessTreeWatchdog,
  waitForLinuxProcessMarkerExit,
} from "../child-process";
import { registerClaudeTaskRetry } from "./agent-sdk-tasks";

export function spawnClaudeCodeProcess(
  options: ClaudeSpawnOptions,
  onStderr: (chunk: string) => void,
  immediateAbortSignal: AbortSignal,
  processTasks: Set<Promise<void>> = new Set(),
  supervision: {
    readonly runtimePlatform?: NodeJS.Platform;
    readonly spawnWatchdog?: typeof spawnLinuxProcessTreeWatchdog;
    readonly waitForMarkerExit?: typeof waitForLinuxProcessMarkerExit;
  } = {},
): ClaudeSpawnedProcess {
  const runtimePlatform = supervision.runtimePlatform ?? process.platform;
  const processTree =
    runtimePlatform === "linux"
      ? createProcessTreeEnvironment(options.env)
      : { env: options.env, marker: "" };
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    detached: true,
    env: processTree.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const target = bindSpawnedProcess(child, runtimePlatform);
  let killRequested = child.killed;
  const spawnedProcess = {
    get exitCode() {
      return child.exitCode;
    },
    get killed() {
      return killRequested || child.killed;
    },
    get pid() {
      return child.pid;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill(signal: NodeJS.Signals) {
      const signalled = signalBoundProcessTree(target, processTree.marker, signal);
      killRequested ||= signalled;
      return signalled;
    },
    off: child.off.bind(child),
    on: child.on.bind(child),
    once: child.once.bind(child),
    stdin: child.stdin,
    stdout: child.stdout,
  } satisfies ClaudeSpawnedProcess & { readonly pid: number | undefined };
  const sessionId = child.pid;

  if (sessionId === undefined) {
    return spawnedProcess;
  }

  const exited = Promise.withResolvers<void>();
  const watchdogReady = Promise.withResolvers<ReturnType<typeof spawnLinuxProcessTreeWatchdog>>();
  if (runtimePlatform !== "linux") {
    watchdogReady.resolve(null);
  }
  const releaseProcess = () => {
    exited.resolve();
  };
  child.once("exit", releaseProcess);
  child.once("error", () => {
    watchdogReady.resolve(null);
    releaseProcess();
  });

  const retryMarkerCleanup = async () => {
    await exited.promise;
    signalLinuxProcessMarker(processTree.marker, "SIGKILL");
    await (supervision.waitForMarkerExit ?? waitForLinuxProcessMarkerExit)(processTree.marker);
  };
  const processTask = (async () => {
    await exited.promise;
    const watchdog = await watchdogReady.promise;
    if (runtimePlatform === "linux") {
      signalLinuxProcessMarker(processTree.marker, "SIGKILL");
      const cleanupResults = await Promise.allSettled([
        ...(watchdog === null ? [] : [watchdog.cleanup]),
        (supervision.waitForMarkerExit ?? waitForLinuxProcessMarkerExit)(processTree.marker),
      ]);
      const failure = cleanupResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure !== undefined) {
        throw failure.reason;
      }
    }
  })();
  processTasks.add(processTask);
  if (runtimePlatform === "linux") {
    registerClaudeTaskRetry(processTask, retryMarkerCleanup);
  }
  void processTask.catch(() => {});

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", onStderr);

  const onGracefulAbort = () => spawnedProcess.kill("SIGTERM");
  const onImmediateAbort = () => spawnedProcess.kill("SIGKILL");
  options.signal.addEventListener("abort", onGracefulAbort, { once: true });
  immediateAbortSignal.addEventListener("abort", onImmediateAbort, { once: true });
  if (options.signal.aborted) {
    onGracefulAbort();
  }
  if (immediateAbortSignal.aborted) {
    onImmediateAbort();
  }
  child.once("exit", () => {
    options.signal.removeEventListener("abort", onGracefulAbort);
    immediateAbortSignal.removeEventListener("abort", onImmediateAbort);
  });

  child.once("spawn", () => {
    if (runtimePlatform !== "linux") {
      return;
    }

    let watchdog: ReturnType<typeof spawnLinuxProcessTreeWatchdog>;
    try {
      watchdog = (supervision.spawnWatchdog ?? spawnLinuxProcessTreeWatchdog)(
        sessionId,
        processTree.marker,
      );
    } catch {
      watchdogReady.resolve(null);
      spawnedProcess.kill("SIGKILL");
      return;
    }
    watchdogReady.resolve(watchdog);
    if (watchdog === null) {
      spawnedProcess.kill("SIGKILL");
      return;
    }
    const failClosed = () => {
      if (child.exitCode === null && child.signalCode === null) {
        spawnedProcess.kill("SIGKILL");
      }
    };
    void watchdog.cleanup.then(failClosed, failClosed);
  });

  return spawnedProcess;
}
