import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import type { DriverEventInput } from "../../protocol/events";
import { createDriverId } from "../../protocol/id";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { DriverEventRejectedError } from "../../core/driver-runtime-io";
import { settlePromiseWithTimeout } from "../../utils/async";
import {
  bindSpawnedProcess,
  createProcessTreeEnvironment,
  releaseLinuxProcessMarker,
  signalBoundProcessTree,
  signalLinuxProcessMarker,
  spawnLinuxProcessTreeWatchdog,
  waitForLinuxProcessMarkerExit,
} from "../child-process";
import type { BoundSpawnedProcess, LinuxProcessTreeWatchdog } from "../child-process";
import {
  isRecord,
  raceWithAbort,
  readArray,
  readNonEmptyString,
  readNumber,
  readString,
} from "./acp-types";
import type { JsonObject } from "./acp-types";
import { AcpPathScope } from "./acp-path-scope";

interface AcpTerminalState {
  readonly closed: Promise<void>;
  closedStatus: AcpTerminalExitStatus | null;
  createEvent: DriverEventInput | null;
  createEventTask: Promise<void> | null;
  cleanupTakenOver: boolean;
  completionTask: Promise<void> | null;
  readonly exited: Promise<AcpTerminalExitStatus>;
  exitEvent: DriverEventInput | null;
  exitEventTask: Promise<void> | null;
  exitStatus: AcpTerminalExitStatus | null;
  readonly id: string;
  killEvent: DriverEventInput | null;
  killTask: Promise<void> | null;
  readonly marker: string;
  hostMayOwn: boolean;
  orphaned: boolean;
  output: string;
  readonly outputByteLimit: number;
  readonly process: ChildProcessWithoutNullStreams;
  readonly rejectExit: (reason?: unknown) => void;
  readonly reservation: AcpTerminalReservation;
  releaseEvent: DriverEventInput | null;
  releaseTask: Promise<void> | null;
  readonly resolveExit: (status: AcpTerminalExitStatus) => void;
  supervisionFailure: Error | null;
  readonly target: BoundSpawnedProcess;
  truncated: boolean;
  watchdog: LinuxProcessTreeWatchdog | null;
}

interface AcpTerminalReservation {
  active: boolean;
  claimed: boolean;
  readonly turn: number;
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
  readonly pathScope?: AcpPathScope | undefined;
  push(context: AgentDriverContext, reason: string, events: DriverEventInput[]): Promise<void>;
  readonly spawnWatchdog?: typeof spawnLinuxProcessTreeWatchdog;
}

const DEFAULT_MAX_TERMINALS = 32;
const DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT = 1024 * 1024;
const TERMINAL_EXIT_TIMEOUT_MS = 2_000;
const TERMINAL_FORCE_KILL_TIMEOUT_MS = 1_000;
const TERMINAL_KILL_WAIT_TIMEOUT_MS = TERMINAL_EXIT_TIMEOUT_MS + TERMINAL_FORCE_KILL_TIMEOUT_MS * 2;

class AcpTerminalCleanupError extends Error {
  override readonly name = "AcpTerminalCleanupError";

  constructor(terminalId: string, cause: unknown) {
    super(`ACP terminal ${terminalId} creation cleanup failed.`, { cause });
  }
}

export class AcpTerminalManager {
  readonly #env: Readonly<Record<string, string>>;
  readonly #maxTerminals: number;
  readonly #pathScope: AcpPathScope;
  readonly #push: AcpTerminalManagerOptions["push"];
  readonly #createTasks = new Map<Promise<unknown>, number>();
  readonly #spawnWatchdog: typeof spawnLinuxProcessTreeWatchdog;
  #currentTurn = 0;
  #stopping = false;
  #terminalReservations = 0;
  readonly #terminals = new Map<string, AcpTerminalState>();

  constructor(options: AcpTerminalManagerOptions) {
    this.#env = options.env;
    this.#maxTerminals = options.maxTerminals ?? DEFAULT_MAX_TERMINALS;
    this.#pathScope = options.pathScope ?? new AcpPathScope(options);
    this.#push = options.push;
    this.#spawnWatchdog = options.spawnWatchdog ?? spawnLinuxProcessTreeWatchdog;

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
    if (this.#terminalReservations >= this.#maxTerminals) {
      throw new Error(`ACP terminal limit of ${this.#maxTerminals} is exhausted.`);
    }

    const reservation: AcpTerminalReservation = {
      active: true,
      claimed: false,
      turn: this.#currentTurn,
    };
    this.#terminalReservations += 1;
    const creation = this.#create(context, params, reservation, signal);
    this.#createTasks.set(creation, reservation.turn);

    try {
      return await creation;
    } finally {
      this.#createTasks.delete(creation);
      if (!reservation.claimed) {
        this.#releaseReservation(reservation);
      }
    }
  }

  beginTurn(): number {
    if (this.#stopping) {
      throw new Error("ACP terminal manager is stopping.");
    }

    return ++this.#currentTurn;
  }

  async #create(
    context: AgentDriverContext,
    params: unknown,
    reservation: AcpTerminalReservation,
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

    const args = readArray(record, "args").filter(
      (entry): entry is string => typeof entry === "string",
    );
    const requestedCwd = readNonEmptyString(record, "cwd") ?? this.#pathScope.cwd();
    const requestedOutputByteLimit = readNumber(record, "outputByteLimit");
    const outputByteLimit = normalizeByteLimit(requestedOutputByteLimit);
    const env = this.#readTerminalEnv(record);
    const terminalId = createDriverId();
    const cwd = await this.#pathScope.openDirectory(requestedCwd, "ACP terminal cwd");
    let processTree: ReturnType<typeof createProcessTreeEnvironment>;
    let child: ChildProcessWithoutNullStreams;
    let cwdPath: string;

    try {
      signal?.throwIfAborted();
      processTree = createProcessTreeEnvironment({
        ...this.#env,
        ...env,
      });
      child = spawn(command, args, {
        cwd: cwd.procPath,
        detached: true,
        env: processTree.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      await cwd.file.close().catch(() => {});
      throw error;
    }
    const target = bindSpawnedProcess(child, process.platform, processTree);
    const spawned = once(child, "spawn");
    void spawned.catch(() => {});
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
    const {
      promise: exited,
      reject: rejectExit,
      resolve: resolveExit,
    } = Promise.withResolvers<AcpTerminalExitStatus>();
    void exited.catch(() => {});
    const terminal: AcpTerminalState = {
      closed,
      closedStatus: null,
      createEvent: null,
      createEventTask: null,
      cleanupTakenOver: false,
      completionTask: null,
      exited,
      exitEvent: null,
      exitEventTask: null,
      exitStatus: null,
      id: terminalId,
      killEvent: null,
      killTask: null,
      marker: processTree.marker,
      hostMayOwn: false,
      orphaned: false,
      output: "",
      outputByteLimit,
      process: child,
      rejectExit,
      reservation,
      releaseEvent: null,
      releaseTask: null,
      resolveExit,
      supervisionFailure: null,
      target,
      truncated: false,
      watchdog: null,
    };

    reservation.claimed = true;
    this.#terminals.set(terminalId, terminal);
    child.once("close", (exitCode, signal) => {
      const status = { exitCode: exitCode ?? null, signal: signal ?? null };
      terminal.closedStatus = status;
      signalLinuxProcessMarker(terminal.marker, "SIGKILL");
      terminal.completionTask = this.#completeExit(context, terminal, status);
      resolveClosed();
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
      terminal.watchdog =
        child.pid === undefined ? null : this.#spawnWatchdog(child.pid, processTree.marker);
      if (terminal.watchdog !== null) {
        void terminal.watchdog.cleanup.then(
          async () => {
            if (terminal.process.exitCode === null && terminal.process.signalCode === null) {
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
            if (terminal.process.exitCode === null && terminal.process.signalCode === null) {
              this.#failSupervision(
                context,
                terminal,
                new Error(
                  `ACP terminal ${terminal.id} process-tree watchdog exited before the terminal.`,
                ),
              );
            }
          },
          (error: unknown) => {
            this.#failSupervision(
              context,
              terminal,
              new Error(`ACP terminal ${terminal.id} process-tree watchdog failed.`, {
                cause: error,
              }),
            );
          },
        );
      }
      await raceWithAbort(spawned, signal);
      cwdPath = await this.#pathScope.identify(cwd);
      await cwd.file.close();
      if (process.platform === "linux" && terminal.watchdog === null) {
        throw new Error(`ACP terminal ${terminalId} supervision could not start.`);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (terminal.supervisionFailure !== null) {
        throw terminal.supervisionFailure;
      }

      if (this.#stopping) {
        throw new Error("ACP terminal manager is stopping.");
      }

      signal?.throwIfAborted();
      if (this.#terminals.get(terminalId) !== terminal) {
        throw new Error(`ACP terminal ${terminalId} lost ownership during creation.`);
      }

      terminal.createEvent = {
        kind: "terminal.created",
        payload: {
          command,
          cwd: cwdPath,
          outputByteLimit,
          terminalId,
        },
        sourceEventId: `acp.terminal.created:${terminalId}`,
      };
      await this.#publishCreated(context, terminal);

      if (this.#terminals.get(terminalId) !== terminal) {
        throw new Error(`ACP terminal ${terminalId} lost ownership during creation.`);
      }

      terminal.hostMayOwn = true;
      await this.#publishExit(context, terminal);
      signal?.throwIfAborted();

      if (this.#stopping) {
        throw new Error("ACP terminal manager is stopping.");
      }
    } catch (error) {
      if (
        !terminal.hostMayOwn &&
        terminal.createEvent !== null &&
        !(
          error instanceof DriverEventRejectedError &&
          error.sourceEventId === terminal.createEvent.sourceEventId
        )
      ) {
        terminal.hostMayOwn = true;
      }

      if (terminal.hostMayOwn) {
        try {
          await this.#releaseTerminal(context, terminal);
        } catch (cleanupError) {
          throw new AcpTerminalCleanupError(terminalId, cleanupError);
        }

        throw error;
      }

      if (terminal.exitStatus === null) {
        signalAcpTerminalProcess(terminal, "SIGKILL");
        let exited = false;
        try {
          exited = await this.#waitForExit(terminal, TERMINAL_FORCE_KILL_TIMEOUT_MS);
        } catch (cleanupError) {
          terminal.orphaned = true;
          throw new AcpTerminalCleanupError(terminalId, cleanupError);
        }

        if (!exited) {
          terminal.orphaned = true;
          throw new AcpTerminalCleanupError(terminalId, error);
        }
      }

      releaseLinuxProcessMarker(terminal.marker);
      this.#removeTerminal(terminal);
      throw error;
    } finally {
      await cwd.file.close().catch(() => {});
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
    await raceWithAbort(this.#killTerminal(context, terminal), signal);

    return {};
  }

  #killTerminal(context: AgentDriverContext, terminal: AcpTerminalState): Promise<void> {
    if (terminal.killTask !== null) {
      return terminal.killTask;
    }

    terminal.killEvent ??= {
      kind: "terminal.killed",
      payload: {
        terminalId: terminal.id,
      },
      sourceEventId: `acp.terminal.killed:${terminal.id}`,
    };
    const operation = this.#runKill(context, terminal);
    let task: Promise<void>;
    task = operation.catch((error: unknown) => {
      if (terminal.killTask === task) {
        terminal.killTask = null;
      }
      throw error;
    });
    terminal.killTask = task;
    return task;
  }

  async #runKill(context: AgentDriverContext, terminal: AcpTerminalState): Promise<void> {
    if (terminal.exitStatus === null) {
      signalAcpTerminalProcess(terminal, "SIGKILL");
      const exited = await this.#waitForExit(terminal, TERMINAL_KILL_WAIT_TIMEOUT_MS);
      if (!exited) {
        throw new Error(
          `ACP terminal ${terminal.id} cleanup did not finish within ${TERMINAL_KILL_WAIT_TIMEOUT_MS}ms after force kill.`,
        );
      }
    }
    await this.#publishExit(context, terminal);
    await this.#push(context, "driver.acp.terminal.killed", [terminal.killEvent!]);
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
    await this.#releaseTerminal(context, terminal);

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
    try {
      await this.#stop(context);
    } finally {
      await this.#pathScope.close();
    }
  }

  async stopTurn(context: AgentDriverContext, turn: number): Promise<void> {
    await this.#stop(context, turn);
  }

  async #stop(context: AgentDriverContext, turn?: number): Promise<void> {
    const ownsTurn = (ownedTurn: number): boolean => turn === undefined || ownedTurn === turn;
    const admittedKills = new Map(
      [...this.#terminals.values()].flatMap((terminal) =>
        ownsTurn(terminal.reservation.turn) ? [[terminal, terminal.killTask] as const] : [],
      ),
    );
    const creations = await Promise.allSettled(
      [...this.#createTasks].flatMap(([creation, ownedTurn]) =>
        ownsTurn(ownedTurn) ? [creation] : [],
      ),
    );
    const releases = await Promise.allSettled(
      [...this.#terminals.values()].flatMap((terminal) =>
        ownsTurn(terminal.reservation.turn)
          ? [
              this.#releaseTerminal(
                context,
                terminal,
                admittedKills.get(terminal) ?? terminal.killTask,
              ),
            ]
          : [],
      ),
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

  #releaseTerminal(
    context: AgentDriverContext,
    terminal: AcpTerminalState,
    admittedKill: Promise<void> | null = terminal.killTask,
  ): Promise<void> {
    return (terminal.releaseTask ??= this.#runRelease(context, terminal, admittedKill).catch(
      (error: unknown) => {
        if (this.#terminals.get(terminal.id) === terminal) {
          terminal.releaseTask = null;
        }
        throw error;
      },
    ));
  }

  async #runRelease(
    context: AgentDriverContext,
    terminal: AcpTerminalState,
    admittedKill: Promise<void> | null,
  ): Promise<void> {
    const wasRunning = terminal.closedStatus === null;

    if (wasRunning) {
      signalAcpTerminalProcess(terminal, "SIGTERM");
      const exited = await this.#waitForClose(terminal, TERMINAL_EXIT_TIMEOUT_MS);

      if (!exited) {
        context.logger.warn("driver.acp.terminal.exit.timed_out", {
          terminalId: terminal.id,
          timeoutMs: TERMINAL_EXIT_TIMEOUT_MS,
        });
        signalAcpTerminalProcess(terminal, "SIGKILL");
        const forceExited = await this.#waitForClose(terminal, TERMINAL_FORCE_KILL_TIMEOUT_MS);

        if (!forceExited) {
          context.logger.warn("driver.acp.terminal.force_exit.timed_out", {
            terminalId: terminal.id,
            timeoutMs: TERMINAL_FORCE_KILL_TIMEOUT_MS,
          });
          throw new Error(`ACP terminal ${terminal.id} did not exit after force kill.`);
        }
      }
    }

    if (terminal.completionTask !== null) {
      const completion = await settlePromiseWithTimeout(terminal.completionTask, {
        label: "ACP terminal process-tree cleanup",
        timeoutMs: TERMINAL_FORCE_KILL_TIMEOUT_MS,
      });
      if (completion.status === "failed") {
        throw completion.error;
      }
      if (completion.status === "timed_out") {
        if (terminal.exitStatus === null) {
          terminal.cleanupTakenOver = true;
        } else {
          await terminal.completionTask;
        }
      }
    }
    if (terminal.exitStatus === null) {
      signalAcpTerminalProcess(terminal, "SIGKILL");
      await waitForLinuxProcessMarkerExit(
        terminal.marker,
        TERMINAL_EXIT_TIMEOUT_MS + TERMINAL_FORCE_KILL_TIMEOUT_MS,
      );
      if (terminal.closedStatus === null) {
        throw new Error(`ACP terminal ${terminal.id} exit status is unavailable.`);
      }
      terminal.exitStatus = terminal.closedStatus;
    }
    if (terminal.hostMayOwn) {
      await this.#publishCreated(context, terminal);
    }
    await this.#publishExit(context, terminal);
    terminal.resolveExit(terminal.exitStatus);

    if (admittedKill !== null) {
      await admittedKill;
    } else if (terminal.killEvent !== null) {
      await this.#killTerminal(context, terminal);
    }

    if (terminal.hostMayOwn) {
      terminal.releaseEvent ??= {
        kind: "terminal.released",
        payload: {
          terminalId: terminal.id,
        },
        sourceEventId: `acp.terminal.released:${terminal.id}`,
      };
      await this.#push(context, "driver.acp.terminal.released", [terminal.releaseEvent]);
    }

    if (this.#terminals.get(terminal.id) === terminal) {
      releaseLinuxProcessMarker(terminal.marker);
      this.#removeTerminal(terminal);
    }
  }

  #removeTerminal(terminal: AcpTerminalState): void {
    if (this.#terminals.get(terminal.id) !== terminal) {
      return;
    }

    this.#terminals.delete(terminal.id);
    this.#releaseReservation(terminal.reservation);
  }

  #releaseReservation(reservation: AcpTerminalReservation): void {
    if (!reservation.active) {
      return;
    }

    reservation.active = false;
    this.#terminalReservations -= 1;
  }

  async #completeExit(
    context: AgentDriverContext,
    terminal: AcpTerminalState,
    status: AcpTerminalExitStatus,
  ): Promise<void> {
    const cleanupResults = await Promise.allSettled([
      ...(terminal.watchdog === null ? [] : [terminal.watchdog.cleanup]),
      waitForLinuxProcessMarkerExit(
        terminal.marker,
        TERMINAL_EXIT_TIMEOUT_MS + TERMINAL_FORCE_KILL_TIMEOUT_MS,
      ),
    ]);
    const cleanupFailure = cleanupResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )?.reason;

    if (terminal.cleanupTakenOver) {
      return;
    }
    const failure = terminal.supervisionFailure ?? cleanupFailure ?? null;
    if (failure !== null) {
      const error =
        failure instanceof Error
          ? failure
          : new Error(`ACP terminal ${terminal.id} process-tree cleanup failed.`);
      terminal.rejectExit(error);
      await this.#pushBestEffort(context, "driver.acp.terminal.supervision.failed", [
        {
          kind: "diagnostic.reported",
          payload: {
            message: error.message,
            phase: "terminal",
            severity: "error",
            terminalId: terminal.id,
          },
          visibility: "owner_debug",
        },
      ]);
      return;
    }

    terminal.exitStatus = status;
    const publication = this.#publishExit(context, terminal);
    terminal.resolveExit(status);
    void publication.catch((error: unknown) => {
      this.#warnPushFailure(context, "driver.acp.terminal.exited", error);
    });
  }

  #failSupervision(context: AgentDriverContext, terminal: AcpTerminalState, error: Error): void {
    if (terminal.supervisionFailure !== null) {
      return;
    }
    terminal.supervisionFailure = error;
    context.logger.error("driver.acp.terminal.supervision.failed", error, {
      terminalId: terminal.id,
    });
    signalAcpTerminalProcess(terminal, "SIGKILL");
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

    if (!terminal.hostMayOwn) {
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

    if (result.status === "failed") {
      throw result.error;
    }

    return result.status === "completed";
  }

  async #waitForClose(terminal: AcpTerminalState, timeoutMs: number): Promise<boolean> {
    const result = await settlePromiseWithTimeout(terminal.closed, {
      label: "ACP terminal process close",
      timeoutMs,
    });

    if (result.status === "failed") {
      throw result.error;
    }

    return result.status === "completed";
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
      this.#warnPushFailure(context, reason, error);
    });
  }

  #warnPushFailure(context: AgentDriverContext, reason: string, error: unknown): void {
    context.logger.warn("driver.acp.terminal.event_push.failed", {
      message: error instanceof Error ? error.message : "terminal event push failed",
      reason,
    });
  }

  #publishExit(context: AgentDriverContext, terminal: AcpTerminalState): Promise<void> {
    if (!terminal.hostMayOwn || terminal.exitStatus === null) {
      return Promise.resolve();
    }

    terminal.exitEvent ??= {
      kind: "terminal.exited",
      payload: {
        exitCode: terminal.exitStatus.exitCode,
        signal: terminal.exitStatus.signal,
        terminalId: terminal.id,
      },
      sourceEventId: `acp.terminal.exited:${terminal.id}`,
    };
    if (terminal.exitEventTask !== null) {
      return terminal.exitEventTask;
    }

    const operation = this.#push(context, "driver.acp.terminal.exited", [terminal.exitEvent]);
    let task: Promise<void>;
    task = operation.catch((error: unknown) => {
      if (terminal.exitEventTask === task) {
        terminal.exitEventTask = null;
      }
      throw error;
    });
    terminal.exitEventTask = task;
    return task;
  }

  #publishCreated(context: AgentDriverContext, terminal: AcpTerminalState): Promise<void> {
    if (terminal.createEvent === null) {
      return Promise.resolve();
    }
    if (terminal.createEventTask !== null) {
      return terminal.createEventTask;
    }

    const operation = this.#push(context, "driver.acp.terminal.created", [terminal.createEvent]);
    let task: Promise<void>;
    task = operation.catch((error: unknown) => {
      if (terminal.createEventTask === task) {
        terminal.createEventTask = null;
      }
      throw error;
    });
    terminal.createEventTask = task;
    return task;
  }

  #requireTerminal(params: unknown): AcpTerminalState {
    const terminalId = readNonEmptyString(isRecord(params) ? params : null, "terminalId");

    if (terminalId === null) {
      throw new Error("ACP terminal method requires a terminalId.");
    }

    const terminal = this.#terminals.get(terminalId);

    if (
      !terminal ||
      terminal.releaseTask !== null ||
      (!terminal.hostMayOwn && !terminal.orphaned)
    ) {
      throw new Error(`ACP terminal does not exist: ${terminalId}.`);
    }

    return terminal;
  }
}

function signalAcpTerminalProcess(terminal: AcpTerminalState, signal: NodeJS.Signals): boolean {
  return signalBoundProcessTree(terminal.target, terminal.marker, signal);
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
