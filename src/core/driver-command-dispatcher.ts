import { createScopedWideEvent, emitWideEvent } from "../observability";
import type { Logger } from "../observability";
import { summarizeRuntimeCommand } from "../observability/driver-debug";
import { parseDriverId } from "../protocol/id";
import type { RunId } from "../protocol/id";
import type { RunError, RuntimeCommand } from "../runtime-command";
import { promiseWithTimeout, raceWithAbort, sleepPromise } from "../utils/async";
import type { AgentDriverBackend, AgentDriverContext } from "./agent-driver-backend";
import { DriverCommandDelivery, TerminalCommandDeliveryError } from "./driver-command-delivery";
import { pushDriverDiagnosticEvent } from "./driver-diagnostics";
import {
  PermissionEventDeliveryError,
  type DriverPermissionBroker,
} from "./driver-permission-broker";
import { pushLosslessEvents } from "./driver-runtime-io";
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

interface ActiveMcpCommand {
  readonly controller: AbortController;
  readonly task: Promise<void>;
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
  readonly #commandDelivery: DriverCommandDelivery;
  #activeWorkFailure: { error: unknown } | null = null;
  #activeInputCancellation: AbortController | null = null;
  readonly #activeMcpCommands = new Map<string, ActiveMcpCommand>();
  #activeRunGeneration = 0;
  #activeRunTask: Promise<void> | null = null;

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
    this.#commandDelivery = new DriverCommandDelivery(options.shutdownSignal);
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
            message: toErrorMessage(settleFailure.error, "Active driver work did not settle."),
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
        await this.#commandDelivery.claimRunTerminal(socket, "failed", {
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

      await this.#shutdown(socket, "driver.command_loop_failed").catch((shutdownError: unknown) => {
        logger.error("driver.runtime.shutdown.failed", shutdownError, {
          driverInstanceId: this.#driverInstanceId,
        });
      });
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
    const receipt = this.#commandDelivery.receive(command);

    if (receipt.replay) {
      if (receipt.tracked.terminal) {
        await this.#commandDelivery.finish(runtimeContext, command, receipt.tracked.terminal, true);
      } else {
        await this.#commandDelivery.accept(runtimeContext, command, receipt.tracked);
      }
      return;
    }

    await this.#commandDelivery.accept(runtimeContext, command, receipt.tracked);

    try {
      if (command.kind === "permission.resolve") {
        this.#permissionRequests.resolve(command.requestId, command.decision);
        await this.#commandDelivery.finish(runtimeContext, command, {
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
        this.#commandDelivery.resetRunTerminal();
        socket.beginRun(runId);
        let activeRunTask!: Promise<void>;
        activeRunTask = this.#runInputTask(
          runtimeContext,
          socket,
          command,
          cancellation,
          this.#activeRunGeneration,
          runId,
        )
          .catch(async (error: unknown) => {
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
          })
          .finally(() => {
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
        await this.#commandDelivery.finish(runtimeContext, command, {
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
        await this.#commandDelivery.claimRunTerminal(socket, "completed");
        runtimeContext.logger.debug("driver.runtime.run.completed", {
          commandId: command.commandId,
          reason,
        });
        await this.#shutdown(socket, reason);

        if (this.#runtimeState.status() === "stopping") {
          this.#runtimeState.enter("stopped");
        }
        await this.#commandDelivery.finish(runtimeContext, command, {
          status: "completed",
        });
        return;
      }
    } catch (error) {
      if (this.#commandDelivery.hasTerminal(command.commandId)) {
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
        await this.#shutdown(socket, "driver.mcp_task_failed").catch((shutdownError: unknown) => {
          runtimeContext.logger.error("driver.runtime.shutdown.failed", shutdownError, {
            commandId: command.commandId,
          });
        });
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
      await pushLosslessEvents(socket, [
        {
          kind: "tool.call.updated",
          payload: {
            kind: "mcp",
            rawInput: command.argumentsJson,
            status: "running",
            title: command.toolName,
            toolCallId: command.toolCallId,
          },
        },
      ]);
      runtimeContext.logger.info("driver.runtime.mcp.execute.started", {
        serverId: command.serverId,
        toolName: command.toolName,
      });
      const result = await runtimeContext.ports.mcp.execute(command, controller.signal);
      controller.signal.throwIfAborted();
      await pushLosslessEvents(socket, [
        {
          kind: "tool.call.updated",
          payload: {
            rawOutput: result.outputText,
            status: "completed",
            toolCallId: command.toolCallId,
          },
        },
      ]);
      await this.#commandDelivery.finish(runtimeContext, command, {
        result,
        status: "completed",
      });
      runtimeContext.logger.info("driver.runtime.mcp.execute.completed", {
        outputLength: result.outputText.length,
        serverId: command.serverId,
        toolName: command.toolName,
      });
    } catch (error) {
      if (this.#commandDelivery.hasTerminal(command.commandId)) {
        throw error;
      }

      if (controller.signal.aborted) {
        await this.#commandDelivery.finish(runtimeContext, command, {
          status: "cancelled",
        });
        return;
      }

      await pushLosslessEvents(socket, [
        {
          kind: "tool.call.updated",
          payload: {
            rawOutput: toErrorMessage(error, "MCP tool execution failed."),
            status: "failed",
            toolCallId: command.toolCallId,
          },
        },
      ]).catch((deliveryError: unknown) => {
        runtimeContext.logger.error("driver.runtime.mcp.failed-event.failed", deliveryError, {
          commandId: command.commandId,
          toolCallId: command.toolCallId,
        });
      });

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

    await this.#commandDelivery.finish(runtimeContext, command, {
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
      await this.#commandDelivery.finish(runtimeContext, command, {
        result: {
          requestId: command.requestId,
        },
        status: "completed",
      });
    } catch (error) {
      if (this.#commandDelivery.hasTerminal(command.commandId)) {
        throw error;
      }

      if (
        isDriverTurnCancelledError(error) ||
        (cancellation.signal.aborted && !(error instanceof PermissionEventDeliveryError))
      ) {
        await this.#commandDelivery.finish(runtimeContext, command, {
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
      await this.#commandDelivery.finish(runtimeContext, command, {
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
        await this.#commandDelivery.claimRunTerminal(socket, "failed", commandFailure);
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
