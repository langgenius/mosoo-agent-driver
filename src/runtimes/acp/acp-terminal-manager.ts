import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { isAbsolute, resolve } from "node:path";

import type { DriverEventInput } from "../../protocol/events";
import { createDriverId } from "../../protocol/id";
import { settlePromiseWithTimeout } from "../../utils/async";
import type { AgentDriverContext } from "../agent-driver-backend";
import { killProcessGroup } from "../child-process";
import {
  isRecord,
  raceWithAbort,
  readArray,
  readNonEmptyString,
  readNumber,
  readString,
} from "./acp-types";
import type { JsonObject } from "./acp-types";

interface AcpTerminalState {
  committed: boolean;
  readonly exited: Promise<AcpTerminalExitStatus>;
  exitEventTask: Promise<void> | null;
  exitStatus: AcpTerminalExitStatus | null;
  readonly id: string;
  orphaned: boolean;
  output: string;
  readonly outputByteLimit: number;
  readonly process: ChildProcessWithoutNullStreams;
  releaseTask: Promise<void> | null;
  truncated: boolean;
}

interface AcpTerminalExitStatus {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

interface AcpTerminalManagerOptions {
  readonly allowedRoots: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly maxTerminals?: number | undefined;
  push(context: AgentDriverContext, reason: string, events: DriverEventInput[]): Promise<void>;
}

const DEFAULT_MAX_TERMINALS = 32;
const DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT = 1024 * 1024;
const TERMINAL_EXIT_TIMEOUT_MS = 2_000;
const TERMINAL_FORCE_KILL_TIMEOUT_MS = 1_000;

class AcpTerminalCleanupError extends Error {
  override readonly name = "AcpTerminalCleanupError";

  constructor(terminalId: string, cause: unknown) {
    super(`ACP terminal ${terminalId} creation cleanup failed.`, { cause });
  }
}

export class AcpTerminalManager {
  readonly #allowedRoots: readonly string[];
  readonly #cwd: string;
  readonly #env: Readonly<Record<string, string>>;
  readonly #maxTerminals: number;
  readonly #push: AcpTerminalManagerOptions["push"];
  readonly #createTasks = new Set<Promise<unknown>>();
  #stopping = false;
  readonly #terminals = new Map<string, AcpTerminalState>();

  constructor(options: AcpTerminalManagerOptions) {
    this.#allowedRoots = [options.cwd, ...options.allowedRoots].map((root) =>
      resolve(options.cwd, root),
    );
    this.#cwd = resolve(options.cwd);
    this.#env = options.env;
    this.#maxTerminals = options.maxTerminals ?? DEFAULT_MAX_TERMINALS;
    this.#push = options.push;

    if (!Number.isSafeInteger(this.#maxTerminals) || this.#maxTerminals < 1) {
      throw new RangeError("ACP terminal limit must be a positive safe integer.");
    }
  }

  async create(
    context: AgentDriverContext,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ terminalId: string }> {
    signal?.throwIfAborted();
    if (this.#stopping) {
      throw new Error("ACP terminal manager is stopping.");
    }

    const creation = this.#create(context, params, signal);
    this.#createTasks.add(creation);

    try {
      return await creation;
    } finally {
      this.#createTasks.delete(creation);
    }
  }

  async #create(
    context: AgentDriverContext,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ terminalId: string }> {
    signal?.throwIfAborted();

    if (this.#stopping) {
      throw new Error("ACP terminal manager is stopping.");
    }

    const record = isRecord(params) ? params : {};
    const command = readNonEmptyString(record, "command");

    if (command === null) {
      throw new Error("ACP terminal/create requires a command.");
    }

    if (this.#terminals.size >= this.#maxTerminals) {
      throw new Error(`ACP terminal limit of ${this.#maxTerminals} is exhausted.`);
    }

    const args = readArray(record, "args").filter(
      (entry): entry is string => typeof entry === "string",
    );
    const cwd = this.#resolveAllowedCwd(readNonEmptyString(record, "cwd") ?? this.#cwd);
    const requestedOutputByteLimit = readNumber(record, "outputByteLimit");
    const outputByteLimit = normalizeByteLimit(requestedOutputByteLimit);
    const env = this.#readTerminalEnv(record);
    const terminalId = createDriverId();
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: {
        ...this.#env,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const spawned = once(child, "spawn");
    const { promise: exited, resolve: resolveExit } =
      Promise.withResolvers<AcpTerminalExitStatus>();
    const terminal: AcpTerminalState = {
      committed: false,
      exited,
      exitEventTask: null,
      exitStatus: null,
      id: terminalId,
      orphaned: false,
      output: "",
      outputByteLimit,
      process: child,
      releaseTask: null,
      truncated: false,
    };

    this.#terminals.set(terminalId, terminal);
    child.once("close", (exitCode, signal) => {
      killProcessGroup(child, "SIGKILL");
      const status = { exitCode: exitCode ?? null, signal: signal ?? null };
      terminal.exitStatus = status;
      resolveExit(status);
      void this.#publishExit(context, terminal);
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#appendOutput(context, terminal, "stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.#appendOutput(context, terminal, "stderr", chunk);
    });
    child.on("error", (error) => {
      void this.#pushBestEffort(context, "driver.acp.terminal.failed", [
        {
          kind: "diagnostic.reported",
          payload: {
            message: error.message,
            phase: "terminal",
            severity: "error",
            terminalId,
          },
          visibility: "owner_debug",
        },
      ]);
    });

    try {
      await raceWithAbort(spawned, signal);

      if (this.#stopping) {
        throw new Error("ACP terminal manager is stopping.");
      }

      signal?.throwIfAborted();
      if (this.#terminals.get(terminalId) !== terminal) {
        throw new Error(`ACP terminal ${terminalId} lost ownership during creation.`);
      }

      await this.#push(context, "driver.acp.terminal.created", [
        {
          kind: "terminal.created",
          payload: {
            command,
            cwd,
            outputByteLimit,
            terminalId,
          },
        },
      ]);

      if (this.#terminals.get(terminalId) !== terminal) {
        throw new Error(`ACP terminal ${terminalId} lost ownership during creation.`);
      }

      terminal.committed = true;
      await this.#publishExit(context, terminal);
      signal?.throwIfAborted();

      if (this.#stopping) {
        throw new Error("ACP terminal manager is stopping.");
      }
    } catch (error) {
      if (terminal.committed) {
        try {
          await this.#releaseTerminal(context, terminal);
        } catch (cleanupError) {
          throw new AcpTerminalCleanupError(terminalId, cleanupError);
        }

        throw error;
      }

      if (terminal.exitStatus === null) {
        killProcessGroup(child, "SIGKILL");
        const exited = await this.#waitForExit(terminal, TERMINAL_FORCE_KILL_TIMEOUT_MS);

        if (!exited) {
          terminal.orphaned = true;
          throw new AcpTerminalCleanupError(terminalId, error);
        }
      }

      this.#terminals.delete(terminalId);
      throw error;
    }

    return { terminalId };
  }

  async kill(
    context: AgentDriverContext,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, never>> {
    signal?.throwIfAborted();
    const terminal = this.#requireTerminal(params);

    if (terminal.exitStatus === null) {
      killProcessGroup(terminal.process, "SIGKILL");
    }
    await raceWithAbort(
      this.#push(context, "driver.acp.terminal.killed", [
        {
          kind: "terminal.killed",
          payload: {
            terminalId: terminal.id,
          },
        },
      ]),
      signal,
    );

    return {};
  }

  output(
    params: unknown,
    signal?: AbortSignal,
  ): {
    exitStatus: AcpTerminalExitStatus | null;
    output: string;
    truncated: boolean;
  } {
    signal?.throwIfAborted();
    const terminal = this.#requireTerminal(params);
    return {
      exitStatus: terminal.exitStatus,
      output: terminal.output,
      truncated: terminal.truncated,
    };
  }

  async release(
    context: AgentDriverContext,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, never>> {
    signal?.throwIfAborted();
    const terminal = this.#requireTerminal(params);
    await raceWithAbort(this.#releaseTerminal(context, terminal), signal);

    return {};
  }

  async waitForExit(params: unknown, signal?: AbortSignal): Promise<AcpTerminalExitStatus> {
    signal?.throwIfAborted();
    const terminal = this.#requireTerminal(params);

    if (terminal.exitStatus !== null) {
      return terminal.exitStatus;
    }

    return raceWithAbort(terminal.exited, signal);
  }

  async stopAll(context: AgentDriverContext): Promise<void> {
    this.#stopping = true;
    const creations = await Promise.allSettled(this.#createTasks);
    const releases = await Promise.allSettled(
      [...this.#terminals.values()].map((terminal) => this.#releaseTerminal(context, terminal)),
    );
    const failures = [
      ...creations.flatMap((result) =>
        result.status === "rejected" && result.reason instanceof AcpTerminalCleanupError
          ? [result.reason]
          : [],
      ),
      ...releases.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ];

    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more ACP terminals failed to release.");
    }
  }

  #releaseTerminal(context: AgentDriverContext, terminal: AcpTerminalState): Promise<void> {
    return (terminal.releaseTask ??= this.#runRelease(context, terminal).catch((error: unknown) => {
      if (this.#terminals.get(terminal.id) === terminal) {
        terminal.releaseTask = null;
      }
      throw error;
    }));
  }

  async #runRelease(context: AgentDriverContext, terminal: AcpTerminalState): Promise<void> {
    const wasRunning = terminal.exitStatus === null;

    if (wasRunning) {
      killProcessGroup(terminal.process, "SIGTERM");
      const exited = await this.#waitForExit(terminal, TERMINAL_EXIT_TIMEOUT_MS);

      if (!exited) {
        context.logger.warn("driver.acp.terminal.exit.timed_out", {
          terminalId: terminal.id,
          timeoutMs: TERMINAL_EXIT_TIMEOUT_MS,
        });
        killProcessGroup(terminal.process, "SIGKILL");
        const forceExited = await this.#waitForExit(terminal, TERMINAL_FORCE_KILL_TIMEOUT_MS);

        if (!forceExited) {
          context.logger.warn("driver.acp.terminal.force_exit.timed_out", {
            terminalId: terminal.id,
            timeoutMs: TERMINAL_FORCE_KILL_TIMEOUT_MS,
          });
          throw new Error(`ACP terminal ${terminal.id} did not exit after force kill.`);
        }
      }
    }

    if (terminal.committed) {
      await this.#publishExit(context, terminal);
      await this.#push(context, "driver.acp.terminal.released", [
        {
          kind: "terminal.released",
          payload: {
            terminalId: terminal.id,
          },
        },
      ]);
    }

    if (this.#terminals.get(terminal.id) === terminal) {
      this.#terminals.delete(terminal.id);
    }
  }

  #appendOutput(
    context: AgentDriverContext,
    terminal: AcpTerminalState,
    stream: "stderr" | "stdout",
    chunk: string,
  ): void {
    const appended = appendBoundedOutput(terminal.output, chunk, terminal.outputByteLimit);
    terminal.output = appended.output;
    terminal.truncated ||= appended.truncated;

    if (!terminal.committed) {
      return;
    }

    void this.#pushBestEffort(context, "driver.acp.terminal.output", [
      {
        delivery: "best_effort",
        kind: "terminal.output.delta",
        payload: {
          data: chunk,
          stream,
          terminalId: terminal.id,
          truncated: terminal.truncated,
        },
      },
    ]);
  }

  async #waitForExit(terminal: AcpTerminalState, timeoutMs: number): Promise<boolean> {
    const result = await settlePromiseWithTimeout(terminal.exited, {
      label: "ACP terminal exit",
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

  #readTerminalEnv(record: JsonObject): Record<string, string> {
    const env: Record<string, string> = {};

    for (const entry of readArray(record, "env")) {
      if (!isRecord(entry)) {
        continue;
      }

      const name = readNonEmptyString(entry, "name");
      const value = readString(entry, "value");

      if (name !== null && value !== null) {
        env[name] = value;
      }
    }

    return env;
  }

  #pushBestEffort(
    context: AgentDriverContext,
    reason: string,
    events: DriverEventInput[],
  ): Promise<void> {
    return this.#push(context, reason, events).catch((error: unknown) => {
      context.logger.warn("driver.acp.terminal.event_push.failed", {
        message: error instanceof Error ? error.message : "terminal event push failed",
        reason,
      });
    });
  }

  #publishExit(context: AgentDriverContext, terminal: AcpTerminalState): Promise<void> {
    if (!terminal.committed || terminal.exitStatus === null) {
      return Promise.resolve();
    }

    return (terminal.exitEventTask ??= this.#pushBestEffort(
      context,
      "driver.acp.terminal.exited",
      [
        {
          kind: "terminal.exited",
          payload: {
            exitCode: terminal.exitStatus.exitCode,
            signal: terminal.exitStatus.signal,
            terminalId: terminal.id,
          },
        },
      ],
    ));
  }

  #resolveAllowedCwd(cwd: string): string {
    if (!isAbsolute(cwd)) {
      throw new Error(`ACP terminal cwd must be absolute: ${cwd}.`);
    }

    const resolvedPath = resolve(this.#cwd, cwd);

    if (
      this.#allowedRoots.some(
        (root) => resolvedPath === root || resolvedPath.startsWith(`${root}/`),
      )
    ) {
      return resolvedPath;
    }

    throw new Error(`ACP terminal cwd is outside the allowed roots: ${cwd}.`);
  }

  #requireTerminal(params: unknown): AcpTerminalState {
    const terminalId = readNonEmptyString(isRecord(params) ? params : null, "terminalId");

    if (terminalId === null) {
      throw new Error("ACP terminal method requires a terminalId.");
    }

    const terminal = this.#terminals.get(terminalId);

    if (!terminal || (!terminal.committed && !terminal.orphaned)) {
      throw new Error(`ACP terminal does not exist: ${terminalId}.`);
    }

    return terminal;
  }
}

function normalizeByteLimit(value: number | null): number {
  if (value === null) {
    return DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("ACP terminal outputByteLimit must be a non-negative safe integer.");
  }

  if (value > DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT) {
    throw new Error(
      `ACP terminal outputByteLimit exceeds ${DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT} bytes.`,
    );
  }

  return value;
}

function appendBoundedOutput(
  output: string,
  chunk: string,
  byteLimit: number,
): { output: string; truncated: boolean } {
  const bytes = Buffer.from(output + chunk);

  if (bytes.byteLength <= byteLimit) {
    return { output: bytes.toString(), truncated: false };
  }

  let start = bytes.byteLength - byteLimit;

  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
    start += 1;
  }

  return { output: bytes.subarray(start).toString(), truncated: true };
}
