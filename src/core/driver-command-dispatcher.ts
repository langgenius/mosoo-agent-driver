import { isDeepStrictEqual } from "node:util";

import {
  summarizeRuntimeCommand,
  summarizeRuntimeCommandResult,
} from "../infrastructure/logging/driver-debug";
import { createScopedWideEvent, emitWideEvent } from "../observability";
import type { Logger } from "../observability";
import { parseDriverId } from "../protocol/id";
import type { RunId } from "../protocol/id";
import type { RunError, RuntimeCommand, RuntimeCommandResult } from "../runtime-command";
import type { AgentDriverBackend, AgentDriverContext } from "../runtimes/agent-driver-backend";
import {
  promiseWithTimeout,
  raceWithAbort,
  settlePromiseWithTimeout,
  sleepPromise,
} from "../utils/async";
import { pushDriverDiagnosticEvent } from "./driver-diagnostics";
import {
  PermissionEventDeliveryError,
  type DriverPermissionBroker,
} from "./driver-permission-broker";
import type { DriverRuntimeIo } from "./driver-runtime-io";
import type { DriverRuntimeStateMachine } from "./driver-runtime-state";
import { DriverTurnCancelledError, isDriverTurnCancelledError } from "./driver-runtime-state";

interface DriverCommandDispatcherOptions {
  backend: AgentDriverBackend;
  driverInstanceId: string;
  isShuttingDown(): boolean;
  permissionRequests: DriverPermissionBroker;
  runtimeContextFactory(socket: DriverRuntimeIo, logger: Logger): AgentDriverContext;
  runtimeState: DriverRuntimeStateMachine;
  sandboxId: string;
  shutdownSignal: AbortSignal;
  shutdown(socket: DriverRuntimeIo, reason: string): Promise<void>;
}

const COMMAND_POLL_INTERVAL_MS = 250;
const ACTIVE_INPUT_SETTLE_GRACE_MS = 2_000;
const ACTIVE_TURN_CANCEL_GRACE_MS = 2_000;
const MAX_ACTIVE_MCP_COMMANDS = 32;
const MAX_TRACKED_COMMANDS = 1_024;
const COMMAND_UPDATE_TIMEOUT_MS = 1_000;
const TERMINAL_UPDATE_ATTEMPT_TIMEOUT_MS = 250;
const TERMINAL_UPDATE_MAX_ATTEMPTS = 3;

interface TerminalCommandUpdate {
  error?: RunError;
  result?: RuntimeCommandResult;
  status: "cancelled" | "completed" | "failed";
}

type RunTerminalDelivery =
  | {
      delivered: boolean;
      status: "completed";
      task?: Promise<void>;
    }
  | {
      delivered: boolean;
      error: RunError;
      status: "failed";
      task?: Promise<void>;
    };

interface TrackedCommand {
  readonly command: RuntimeCommand;
  delivery: Promise<void>;
  terminal?: TerminalCommandUpdate;
  terminalTask?: Promise<void>;
}

interface ActiveMcpCommand {
  readonly controller: AbortController;
  readonly task: Promise<void>;
}

class TerminalCommandDeliveryError extends Error {
  constructor(command: RuntimeCommand, cause: unknown) {
    super(`Driver command ${command.commandId} terminal status could not be delivered.`, {
      cause,
    });
    this.name = "TerminalCommandDeliveryError";
  }
}

function isFatalCommand(command: RuntimeCommand): boolean {
  return command.kind === "input.start" || command.kind === "turn.cancel";
}

function toCommandFailure(command: RuntimeCommand, error: unknown): RunError {
  return {
    code: `driver.command_failed.${command.kind}`,
    details: {
      commandId: command.commandId,
      commandKind: command.kind,
    },
    message: error instanceof Error ? error.message : `Driver command ${command.kind} failed.`,
    retryable: false,
  };
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function parseRunId(value: string): RunId {
  return parseDriverId(value, "Run ID") as RunId;
}

async function sendCommandUpdate(
  runtimeContext: AgentDriverContext,
  command: RuntimeCommand,
  update: {
    error?: RunError;
    result?: RuntimeCommandResult;
    status: "accepted" | "cancelled" | "completed" | "failed";
  },
  signal: AbortSignal,
): Promise<void> {
  const delivery = structuredClone({
    commandId: command.commandId,
    ...(update.error === undefined ? {} : { error: update.error }),
    ...(update.result === undefined ? {} : { result: update.result }),
    status: update.status,
  });
  await raceWithAbort(
    runtimeContext.ports.eventSink.commandUpdate(delivery, signal),
    signal,
  );

  runtimeContext.logger.debug("driver.runtime.command.status.sent", {
    command: summarizeRuntimeCommand(command),
    ...(update.error ? { error: update.error } : {}),
    result: update.result ? summarizeRuntimeCommandResult(update.result) : null,
    status: update.status,
  });
}

async function settleInput(activeRunTask: Promise<void>): Promise<void> {
  await promiseWithTimeout(activeRunTask, {
    label: "Previous driver run input",
    timeoutMs: ACTIVE_INPUT_SETTLE_GRACE_MS,
  });
}

export class DriverCommandDispatcher {
  readonly #backend: AgentDriverBackend;
  readonly #driverInstanceId: string;
  readonly #isShuttingDown: () => boolean;
  readonly #permissionRequests: DriverPermissionBroker;
  readonly #runtimeContextFactory: (socket: DriverRuntimeIo, logger: Logger) => AgentDriverContext;
  readonly #runtimeState: DriverRuntimeStateMachine;
  readonly #sandboxId: string;
  readonly #shutdownSignal: AbortSignal;
  readonly #shutdown: (socket: DriverRuntimeIo, reason: string) => Promise<void>;
  readonly #trackedCommands = new Map<string, TrackedCommand>();
  #activeWorkFailure: { error: unknown } | null = null;
  #activeInputCancellation: AbortController | null = null;
  readonly #activeMcpCommands = new Map<string, ActiveMcpCommand>();
  #activeRunGeneration = 0;
  #activeRunTask: Promise<void> | null = null;
  #runTerminal: RunTerminalDelivery | null = null;

  constructor(options: DriverCommandDispatcherOptions) {
    this.#backend = options.backend;
    this.#driverInstanceId = options.driverInstanceId;
    this.#isShuttingDown = options.isShuttingDown;
    this.#permissionRequests = options.permissionRequests;
    this.#runtimeContextFactory = options.runtimeContextFactory;
    this.#runtimeState = options.runtimeState;
    this.#sandboxId = options.sandboxId;
    this.#shutdownSignal = options.shutdownSignal;
    this.#shutdown = options.shutdown;
  }

  async run(socket: DriverRuntimeIo, logger: Logger): Promise<void> {
    const runtimeContext = this.#runtimeContextFactory(socket, logger);
    let joiningActiveWork = false;
    const onShutdown = () => {
      this.#abortActiveWork(
        toErrorMessage(this.#shutdownSignal.reason, "driver.command_loop.stopped"),
      );
    };
    this.#shutdownSignal.addEventListener("abort", onShutdown, { once: true });
    if (this.#shutdownSignal.aborted) {
      onShutdown();
    }

    logger.debug("driver.runtime.command.poll.started", {
      driverInstanceId: this.#driverInstanceId,
      intervalMs: COMMAND_POLL_INTERVAL_MS,
    });

    const commandLoopEvent = createScopedWideEvent({
      fields: {
        runtime: {
          driver_instance_id: this.#driverInstanceId,
          sandbox_id: this.#sandboxId,
        },
      },
      type: "driver.command-loop",
    });

    try {
      await logger.span("driver.command-loop", async () => {
        while (!this.#isShuttingDown()) {
          let command: RuntimeCommand | null;

          try {
            command = await raceWithAbort(
              runtimeContext.ports.commandSource.nextCommand(this.#shutdownSignal),
              this.#shutdownSignal,
            );
          } catch (error) {
            if (this.#isShuttingDown()) {
              return;
            }

            throw error;
          }

          if (command === null) {
            if (this.#isShuttingDown()) {
              return;
            }

            await sleepPromise(COMMAND_POLL_INTERVAL_MS, this.#shutdownSignal);
            continue;
          }

          await this.#handleCommand(runtimeContext, socket, command);

          if (this.#isShuttingDown()) {
            return;
          }
        }
      });
      if (this.#runtimeState.isShuttingDown()) {
        this.#abortActiveWork("driver.command_loop.stopped");
        joiningActiveWork = true;
        await this.#joinActiveWork();
        joiningActiveWork = false;
      }
      if (this.#activeWorkFailure !== null) {
        throw this.#activeWorkFailure.error;
      }
      emitWideEvent(logger, commandLoopEvent, {
        status: "success",
      });
    } catch (error) {
      const failure = this.#activeWorkFailure?.error ?? error;
      const shuttingDown =
        !(failure instanceof TerminalCommandDeliveryError) &&
        (this.#shutdownSignal.aborted ||
          this.#isShuttingDown() ||
          this.#runtimeState.isShuttingDown());
      this.#abortActiveWork(
        shuttingDown ? "driver.command_loop.stopped" : "driver.command_loop.failed",
      );

      if (shuttingDown) {
        let settleFailure: { error: unknown } | null = joiningActiveWork
          ? { error: failure }
          : null;

        if (settleFailure === null) {
          try {
            await this.#joinActiveWork();
          } catch (settleError) {
            settleFailure = { error: settleError };
          }
        }

        if (settleFailure !== null) {
          logger.warn("driver.runtime.active-work.settle-failed", {
            message: toErrorMessage(
              settleFailure.error,
              "Active driver work did not settle.",
            ),
          });
          throw settleFailure.error;
        }

        emitWideEvent(logger, commandLoopEvent, {
          status: "success",
        });
        return;
      }

      this.#runtimeState.enter("failed");
      commandLoopEvent.setError(failure, {
        driverInstanceId: this.#driverInstanceId,
      });
      emitWideEvent(logger, commandLoopEvent, {
        ...(failure instanceof Error ? { error: failure } : {}),
        status: "error",
      });
      logger.error("driver.runtime.command-loop-failed", failure, {
        driverInstanceId: this.#driverInstanceId,
      });

      try {
        logger.debug("driver.runtime.run.failing", {
          code: "driver.command_loop_failed",
          driverInstanceId: this.#driverInstanceId,
        });
        await pushDriverDiagnosticEvent(
          socket,
          {
            code: "driver.command_loop_failed",
            details: {
              driverInstanceId: this.#driverInstanceId,
            },
            message: toErrorMessage(failure, "Command loop failed."),
            severity: "error",
            source: "core",
          },
          logger,
        );
        await this.#claimRunTerminal(socket, "failed", {
          code: "driver.command_loop_failed",
          details: {},
          message: toErrorMessage(failure, "Command loop failed."),
          retryable: false,
        });
        logger.debug("driver.runtime.run.failed", {
          code: "driver.command_loop_failed",
          driverInstanceId: this.#driverInstanceId,
        });
      } catch {
        /* Ignore runtime error propagation failures */
      }

      await this.#shutdown(socket, "driver.command_loop_failed").catch(
        (shutdownError: unknown) => {
          logger.error("driver.runtime.shutdown.failed", shutdownError, {
            driverInstanceId: this.#driverInstanceId,
          });
        },
      );
      await this.#joinActiveWork().catch((settleError: unknown) => {
        logger.warn("driver.runtime.active-work.settle-failed", {
          message: toErrorMessage(settleError, "Active driver work did not settle."),
        });
      });

      throw failure;
    } finally {
      this.#shutdownSignal.removeEventListener("abort", onShutdown);
    }
  }

  async #handleCommand(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: RuntimeCommand,
  ): Promise<void> {
    const commandSummary = summarizeRuntimeCommand(command);
    runtimeContext.logger.debug("driver.runtime.command.received", commandSummary);
    const tracked = this.#trackedCommands.get(command.commandId);

    if (tracked) {
      if (!isDeepStrictEqual(tracked.command, command)) {
        throw new Error(
          `Driver command ${command.commandId} was replayed with changed identity or content.`,
        );
      }

      if (tracked.terminal) {
        await this.#finishCommand(runtimeContext, command, tracked.terminal, true);
      } else {
        await this.#acceptCommand(runtimeContext, command, tracked);
      }
      return;
    }

    if (this.#trackedCommands.size >= MAX_TRACKED_COMMANDS) {
      throw new Error(`Driver command history capacity is ${MAX_TRACKED_COMMANDS}.`);
    }

    const added: TrackedCommand = {
      command: structuredClone(command),
      delivery: Promise.resolve(),
    };
    this.#trackedCommands.set(command.commandId, added);
    await this.#acceptCommand(runtimeContext, command, added);

    try {
      if (command.kind === "permission.resolve") {
        this.#permissionRequests.resolve(command.requestId, command.decision);
        await this.#finishCommand(runtimeContext, command, {
          status: "completed",
        });
        return;
      }

      if (command.kind === "input.start") {
        if (this.#activeRunTask) {
          await settleInput(this.#activeRunTask);
        }
        if (this.#activeRunTask) {
          throw new Error("Driver run input is already in progress.");
        }
        if (this.#runtimeState.status() !== "ready") {
          throw new Error(`Driver is not ready for input: ${this.#runtimeState.status()}.`);
        }

        this.#activeRunGeneration += 1;
        this.#runtimeState.beginRun(this.#activeRunGeneration);
        const cancellation = new AbortController();
        const runId = parseRunId(command.runId);
        this.#activeInputCancellation = cancellation;
        this.#runTerminal = null;
        socket.beginRun(runId);
        let activeRunTask!: Promise<void>;
        activeRunTask = this.#runInputTask(
          runtimeContext,
          socket,
          command,
          cancellation,
          this.#activeRunGeneration,
          runId,
        ).catch(async (error: unknown) => {
          this.#activeWorkFailure ??= { error };
          runtimeContext.logger.error("driver.runtime.input-task.failed", error, {
            commandId: command.commandId,
            driverInstanceId: this.#driverInstanceId,
          });
          await this.#shutdown(socket, "driver.input_task_failed").catch(
            (shutdownError: unknown) => {
              runtimeContext.logger.error("driver.runtime.shutdown.failed", shutdownError, {
                commandId: command.commandId,
              });
            },
          );
        }).finally(() => {
          if (this.#activeRunTask === activeRunTask) {
            this.#activeRunTask = null;
            this.#activeInputCancellation = null;
          }
        });
        this.#activeRunTask = activeRunTask;
        return;
      }

      if (command.kind === "mcp.execute") {
        this.#startMcpCommand(runtimeContext, socket, command);
        return;
      }

      if (command.kind === "turn.cancel") {
        const reason = command.reason ?? "turn.cancelled";
        await this.#cancelActiveWork(runtimeContext, reason);
        await this.#finishCommand(runtimeContext, command, {
          status: "completed",
        });
        return;
      }

      if (command.kind === "session.stop") {
        const reason = command.reason;
        this.#runtimeState.enter("stopping");
        await this.#cancelActiveWork(runtimeContext, reason);

        runtimeContext.logger.debug("driver.runtime.run.completing", {
          commandId: command.commandId,
          reason,
        });
        await this.#claimRunTerminal(socket, "completed");
        runtimeContext.logger.debug("driver.runtime.run.completed", {
          commandId: command.commandId,
          reason,
        });
        await this.#shutdown(socket, reason);

        if (this.#runtimeState.status() === "stopping") {
          this.#runtimeState.enter("stopped");
        }
        await this.#finishCommand(runtimeContext, command, {
          status: "completed",
        });
        return;
      }
    } catch (error) {
      if (this.#trackedCommands.get(command.commandId)?.terminal !== undefined) {
        throw error;
      }

      await this.#failCommand(runtimeContext, socket, command, error);

      if (isFatalCommand(command)) {
        throw error;
      }
    }
  }

  #abortMcpCommands(reason: string): void {
    for (const { controller } of this.#activeMcpCommands.values()) {
      controller.abort(new Error(reason));
    }
  }

  #abortActiveWork(reason: string): void {
    this.#permissionRequests.rejectAll();
    this.#activeInputCancellation?.abort(new DriverTurnCancelledError(reason));
    this.#abortMcpCommands(reason);
  }

  async #cancelActiveWork(runtimeContext: AgentDriverContext, reason: string): Promise<void> {
    this.#abortActiveWork(reason);
    const results = await Promise.allSettled([
      promiseWithTimeout(this.#backend.cancelActiveTurn(runtimeContext, reason), {
        label: "Active driver turn cancellation",
        timeoutMs: ACTIVE_TURN_CANCEL_GRACE_MS,
      }),
      this.#joinActiveWork(),
    ]);
    const failure = results.find((result) => result.status === "rejected");

    if (failure?.status === "rejected") {
      throw failure.reason;
    }
    if (this.#activeWorkFailure !== null) {
      throw this.#activeWorkFailure.error;
    }
  }

  async #joinActiveWork(): Promise<void> {
    const tasks: Promise<unknown>[] = [];

    if (this.#activeRunTask !== null) {
      tasks.push(settleInput(this.#activeRunTask));
    }

    if (this.#activeMcpCommands.size > 0) {
      tasks.push(
        promiseWithTimeout(
          Promise.allSettled([...this.#activeMcpCommands.values()].map(({ task }) => task)),
          {
            label: "Active driver MCP commands",
            timeoutMs: ACTIVE_INPUT_SETTLE_GRACE_MS,
          },
        ),
      );
    }

    const results = await Promise.allSettled(tasks);
    const failure = results.find((result) => result.status === "rejected");

    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }

  #startMcpCommand(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: Extract<RuntimeCommand, { kind: "mcp.execute" }>,
  ): void {
    if (this.#activeMcpCommands.size >= MAX_ACTIVE_MCP_COMMANDS) {
      throw new Error(`Driver has ${MAX_ACTIVE_MCP_COMMANDS} active MCP commands.`);
    }

    const controller = new AbortController();
    const task = this.#runMcpCommand(runtimeContext, socket, command, controller)
      .catch(async (error: unknown) => {
        this.#activeWorkFailure ??= { error };
        runtimeContext.logger.error("driver.runtime.mcp-command.failed", error, {
          commandId: command.commandId,
          driverInstanceId: this.#driverInstanceId,
        });
        await this.#shutdown(socket, "driver.mcp_task_failed").catch(
          (shutdownError: unknown) => {
            runtimeContext.logger.error("driver.runtime.shutdown.failed", shutdownError, {
              commandId: command.commandId,
            });
          },
        );
      })
      .finally(() => {
        if (this.#activeMcpCommands.get(command.commandId)?.task === task) {
          this.#activeMcpCommands.delete(command.commandId);
        }
      });
    this.#activeMcpCommands.set(command.commandId, { controller, task });
    void task;
  }

  async #runMcpCommand(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: Extract<RuntimeCommand, { kind: "mcp.execute" }>,
    controller: AbortController,
  ): Promise<void> {
    try {
      runtimeContext.logger.info("driver.runtime.mcp.execute.started", {
        serverId: command.serverId,
        toolName: command.toolName,
      });
      const result = await runtimeContext.ports.mcp.execute(command, controller.signal);
      controller.signal.throwIfAborted();
      await this.#finishCommand(runtimeContext, command, {
        result,
        status: "completed",
      });
      runtimeContext.logger.info("driver.runtime.mcp.execute.completed", {
        outputLength: result.outputText.length,
        serverId: command.serverId,
        toolName: command.toolName,
      });
    } catch (error) {
      if (this.#trackedCommands.get(command.commandId)?.terminal !== undefined) {
        throw error;
      }

      if (controller.signal.aborted) {
        await this.#finishCommand(runtimeContext, command, {
          status: "cancelled",
        });
        return;
      }

      await this.#failCommand(runtimeContext, socket, command, error);
    }
  }

  async #failCommand(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: RuntimeCommand,
    error: unknown,
  ): Promise<void> {
    const commandFailure = toCommandFailure(command, error);

    if (command.kind === "session.stop") {
      if (this.#runtimeState.status() === "stopping") {
        this.#runtimeState.enter("failed");
      }

      await this.#shutdown(socket, command.reason).catch((shutdownError: unknown) => {
        runtimeContext.logger.error("driver.runtime.shutdown.failed", shutdownError, {
          commandId: command.commandId,
        });
      });
    }

    await this.#finishCommand(runtimeContext, command, {
      error: commandFailure,
      status: "failed",
    });
    if (command.kind === "mcp.execute") {
      await pushDriverDiagnosticEvent(
        socket,
        {
          code: "driver.mcp_execute_failed",
          details: {
            commandId: command.commandId,
            requestId: command.requestId,
            serverId: command.serverId,
            toolName: command.toolName,
          },
          message: commandFailure.message,
          severity: "error",
          source: "core",
        },
        runtimeContext.logger,
      );
    }
    runtimeContext.logger.error("driver.runtime.command.failed", error, {
      commandId: command.commandId,
      commandKind: command.kind,
      driverInstanceId: this.#driverInstanceId,
      fatal: isFatalCommand(command),
    });
  }

  async #runInputCommand(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: Extract<RuntimeCommand, { kind: "input.start" }>,
    cancellation: AbortController,
    runId: RunId,
  ): Promise<void> {
    try {
      cancellation.signal.throwIfAborted();
      await this.#backend.handleInput(runtimeContext, command.input, runId);
      cancellation.signal.throwIfAborted();
      await this.#finishCommand(runtimeContext, command, {
        result: {
          requestId: command.requestId,
        },
        status: "completed",
      });
    } catch (error) {
      if (this.#trackedCommands.get(command.commandId)?.terminal !== undefined) {
        throw error;
      }

      if (
        isDriverTurnCancelledError(error) ||
        (cancellation.signal.aborted && !(error instanceof PermissionEventDeliveryError))
      ) {
        await this.#finishCommand(runtimeContext, command, {
          status: "cancelled",
        });
        runtimeContext.logger.info("driver.runtime.input.cancelled", {
          commandId: command.commandId,
          commandKind: command.kind,
          driverInstanceId: this.#driverInstanceId,
        });

        return;
      }

      const commandFailure = toCommandFailure(command, error);

      this.#runtimeState.enter("failed");
      await this.#finishCommand(runtimeContext, command, {
        error: commandFailure,
        status: "failed",
      });
      await pushDriverDiagnosticEvent(
        socket,
        {
          code: "driver.command_failed",
          details: {
            commandId: command.commandId,
            commandKind: command.kind,
          },
          message: commandFailure.message,
          severity: "error",
          source: "core",
        },
        runtimeContext.logger,
      );
      runtimeContext.logger.error("driver.runtime.command.failed", error, {
        commandId: command.commandId,
        commandKind: command.kind,
        driverInstanceId: this.#driverInstanceId,
        fatal: true,
      });

      try {
        runtimeContext.logger.debug("driver.runtime.run.failing", {
          code: commandFailure.code,
          driverInstanceId: this.#driverInstanceId,
        });
        await this.#claimRunTerminal(socket, "failed", commandFailure);
        runtimeContext.logger.debug("driver.runtime.run.failed", {
          code: commandFailure.code,
          driverInstanceId: this.#driverInstanceId,
        });
      } catch {
        /* Ignore runtime error propagation failures */
      }

      await this.#shutdown(socket, commandFailure.code);
    }
  }

  #claimRunTerminal(
    socket: DriverRuntimeIo,
    status: "completed" | "failed",
    error?: RunError,
  ): Promise<void> {
    let terminal = this.#runTerminal;

    if (terminal === null) {
      if (status === "failed" && error === undefined) {
        return Promise.reject(new Error("Failed run terminal requires an error."));
      }

      terminal =
        status === "completed"
          ? { delivered: false, status }
          : { delivered: false, error: structuredClone(error!), status };
      this.#runTerminal = terminal;
    }

    if (terminal.status !== status) {
      return Promise.resolve();
    }
    if (
      terminal.status === "failed" &&
      (error === undefined || !isDeepStrictEqual(terminal.error, error))
    ) {
      return Promise.reject(new Error("Failed run terminal was retried with a different error."));
    }
    if (terminal.delivered) {
      return Promise.resolve();
    }
    if (terminal.task !== undefined) {
      return terminal.task;
    }

    const task = this.#deliverRunTerminal(socket, terminal);
    terminal.task = task;
    void task.then(
      () => {
        if (terminal.task === task) {
          terminal.delivered = true;
          delete terminal.task;
        }
      },
      () => {
        if (terminal.task === task) {
          delete terminal.task;
        }
      },
    );
    return task;
  }

  async #deliverRunTerminal(
    socket: DriverRuntimeIo,
    terminal: RunTerminalDelivery,
  ): Promise<void> {
    const deadline = Date.now() + COMMAND_UPDATE_TIMEOUT_MS;
    let cause: unknown = new Error("Run terminal delivery deadline elapsed.");

    for (let attempt = 1; attempt <= TERMINAL_UPDATE_MAX_ATTEMPTS; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      const controller = new AbortController();
      const delivery = await settlePromiseWithTimeout(
        Promise.resolve().then(() =>
          terminal.status === "completed"
            ? socket.completeRun(controller.signal)
            : socket.failRun(structuredClone(terminal.error), controller.signal),
        ),
        {
          label: `Driver run ${terminal.status} terminal delivery`,
          timeoutMs: Math.min(remainingMs, TERMINAL_UPDATE_ATTEMPT_TIMEOUT_MS),
        },
      );

      if (delivery.status === "completed") {
        return;
      }

      cause = delivery.error;
      controller.abort(delivery.error);
      await sleepPromise(0);
    }

    throw new Error(`Driver run ${terminal.status} terminal could not be delivered.`, {
      cause,
    });
  }

  #acceptCommand(
    runtimeContext: AgentDriverContext,
    command: RuntimeCommand,
    tracked: TrackedCommand,
  ): Promise<void> {
    const task = tracked.delivery.then(async () => {
      const controller = new AbortController();
      const signal = AbortSignal.any([this.#shutdownSignal, controller.signal]);
      const delivery = await settlePromiseWithTimeout(
        sendCommandUpdate(runtimeContext, command, { status: "accepted" }, signal),
        {
          label: `Driver command ${command.commandId} accepted status delivery`,
          signal: this.#shutdownSignal,
          timeoutMs: COMMAND_UPDATE_TIMEOUT_MS,
        },
      );

      if (delivery.status === "completed") {
        return;
      }

      controller.abort(delivery.error);
      throw delivery.error;
    });
    tracked.delivery = task;
    return task;
  }

  async #finishCommand(
    runtimeContext: AgentDriverContext,
    command: RuntimeCommand,
    update: TerminalCommandUpdate,
    replay = false,
  ): Promise<void> {
    const tracked = this.#trackedCommands.get(command.commandId);

    if (!tracked) {
      throw new Error(`Driver command ${command.commandId} is not tracked.`);
    }

    const terminal = (tracked.terminal ??= structuredClone(update));
    if (tracked.terminalTask !== undefined) {
      await tracked.terminalTask;
      if (replay) {
        await this.#finishCommand(runtimeContext, command, terminal);
      }
      return;
    }

    const task = tracked.delivery.then(() =>
      this.#deliverTerminal(runtimeContext, command, terminal),
    );
    tracked.delivery = task;
    tracked.terminalTask = task;
    void task.then(
      () => {
        if (tracked.terminalTask === task) {
          delete tracked.terminalTask;
        }
      },
      () => {},
    );
    await task;
  }

  async #deliverTerminal(
    runtimeContext: AgentDriverContext,
    command: RuntimeCommand,
    terminal: TerminalCommandUpdate,
  ): Promise<void> {
    const deadline = Date.now() + COMMAND_UPDATE_TIMEOUT_MS;
    let cause: unknown = new Error("Terminal command status delivery deadline elapsed.");

    for (let attempt = 1; attempt <= TERMINAL_UPDATE_MAX_ATTEMPTS; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      const timeoutMs = Math.min(remainingMs, TERMINAL_UPDATE_ATTEMPT_TIMEOUT_MS);
      const controller = new AbortController();
      const delivery = await settlePromiseWithTimeout(
        sendCommandUpdate(runtimeContext, command, terminal, controller.signal),
        {
          label: `Driver command ${command.commandId} terminal status delivery`,
          timeoutMs,
        },
      );

      if (delivery.status === "completed") {
        return;
      }

      cause = delivery.error;
      controller.abort(delivery.error);
      runtimeContext.logger.warn("driver.runtime.command.terminal-status.retrying", {
        attempt,
        commandId: command.commandId,
        commandKind: command.kind,
        message: toErrorMessage(delivery.error, "Terminal command status could not be sent."),
        status: terminal.status,
      });
    }

    throw new TerminalCommandDeliveryError(command, cause);
  }

  async #runInputTask(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: Extract<RuntimeCommand, { kind: "input.start" }>,
    cancellation: AbortController,
    generation: number,
    runId: RunId,
  ): Promise<void> {
    try {
      await this.#runInputCommand(runtimeContext, socket, command, cancellation, runId);
    } finally {
      socket.endRun(runId);
      this.#runtimeState.endRun(generation);
    }
  }
}
