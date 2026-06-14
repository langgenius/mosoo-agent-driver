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
import { sleepPromise } from "../utils/async";
import { DriverActiveInputCancellation } from "./driver-active-input-cancellation";
import { pushDriverDiagnosticEvent } from "./driver-diagnostics";
import type { DriverPermissionBroker } from "./driver-permission-broker";
import type { DriverRuntimeIo } from "./driver-runtime-io";
import type { DriverRuntimeStateMachine } from "./driver-runtime-state";
import { isDriverTurnCancelledError } from "./driver-runtime-state";

interface DriverCommandDispatcherOptions {
  backend: AgentDriverBackend;
  driverInstanceId: string;
  isShuttingDown(): boolean;
  permissionRequests: DriverPermissionBroker;
  runtimeContextFactory(socket: DriverRuntimeIo, logger: Logger): AgentDriverContext;
  runtimeState: DriverRuntimeStateMachine;
  sandboxId: string;
  shutdown(socket: DriverRuntimeIo, reason: string): Promise<void>;
}

const COMMAND_POLL_INTERVAL_MS = 250;
const ACTIVE_INPUT_SETTLE_GRACE_MS = 2_000;

function isCommandFailureFatal(command: RuntimeCommand): boolean {
  return command.kind === "input.start";
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
): Promise<void> {
  await runtimeContext.ports.eventSink.commandUpdate({
    commandId: command.commandId,
    ...(update.error ? { error: update.error } : {}),
    ...(update.result ? { result: update.result } : {}),
    status: update.status,
  });

  runtimeContext.logger.debug("driver.runtime.command.status.sent", {
    command: summarizeRuntimeCommand(command),
    ...(update.error ? { error: update.error } : {}),
    result: update.result ? summarizeRuntimeCommandResult(update.result) : null,
    status: update.status,
  });
}

async function waitForActiveInputSettle(activeRunTask: Promise<void>): Promise<void> {
  await Promise.race([
    activeRunTask,
    sleepPromise(ACTIVE_INPUT_SETTLE_GRACE_MS).then(() => {
      throw new Error(
        `Previous driver run input did not settle within ${ACTIVE_INPUT_SETTLE_GRACE_MS}ms.`,
      );
    }),
  ]);
}

export class DriverCommandDispatcher {
  readonly #backend: AgentDriverBackend;
  readonly #driverInstanceId: string;
  readonly #isShuttingDown: () => boolean;
  readonly #permissionRequests: DriverPermissionBroker;
  readonly #runtimeContextFactory: (socket: DriverRuntimeIo, logger: Logger) => AgentDriverContext;
  readonly #runtimeState: DriverRuntimeStateMachine;
  readonly #sandboxId: string;
  readonly #shutdown: (socket: DriverRuntimeIo, reason: string) => Promise<void>;
  #activeInputCancellation: DriverActiveInputCancellation | null = null;
  #activeRunGeneration = 0;
  #activeRunTask: Promise<void> | null = null;

  constructor(options: DriverCommandDispatcherOptions) {
    this.#backend = options.backend;
    this.#driverInstanceId = options.driverInstanceId;
    this.#isShuttingDown = () => options.isShuttingDown();
    this.#permissionRequests = options.permissionRequests;
    this.#runtimeContextFactory = (socket, logger) => options.runtimeContextFactory(socket, logger);
    this.#runtimeState = options.runtimeState;
    this.#sandboxId = options.sandboxId;
    this.#shutdown = options.shutdown;
  }

  async run(socket: DriverRuntimeIo, logger: Logger): Promise<void> {
    const runtimeContext = this.#runtimeContextFactory(socket, logger);

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
          const command = await runtimeContext.ports.commandSource.nextCommand();

          if (command === null) {
            if (this.#isShuttingDown()) {
              return;
            }

            await sleepPromise(COMMAND_POLL_INTERVAL_MS);
            continue;
          }

          await this.#handleCommand(runtimeContext, socket, command);

          if (this.#isShuttingDown()) {
            return;
          }
        }
      });
      emitWideEvent(logger, commandLoopEvent, {
        status: "success",
      });
    } catch (error) {
      commandLoopEvent.setError(error, {
        driverInstanceId: this.#driverInstanceId,
      });
      emitWideEvent(logger, commandLoopEvent, {
        ...(error instanceof Error ? { error } : {}),
        status: "error",
      });
      logger.error("driver.runtime.command-loop-failed", error, {
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
            message: toErrorMessage(error, "Command loop failed."),
            severity: "error",
            source: "core",
          },
          logger,
        );
        await socket.failRun({
          code: "driver.command_loop_failed",
          details: {},
          message: toErrorMessage(error, "Command loop failed."),
          retryable: false,
        });
        logger.debug("driver.runtime.run.failed", {
          code: "driver.command_loop_failed",
          driverInstanceId: this.#driverInstanceId,
        });
      } catch {
        /* Ignore runtime error propagation failures */
      }

      throw error;
    }
  }

  async #handleCommand(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: RuntimeCommand,
  ): Promise<void> {
    const commandSummary = summarizeRuntimeCommand(command);
    runtimeContext.logger.debug("driver.runtime.command.received", commandSummary);
    await sendCommandUpdate(runtimeContext, command, {
      status: "accepted",
    });

    try {
      if (command.kind === "permission.resolve") {
        this.#permissionRequests.resolve(command.requestId, command.decision);
        await sendCommandUpdate(runtimeContext, command, {
          status: "completed",
        });
        return;
      }

      if (command.kind === "access.refresh") {
        await runtimeContext.ports.access.refresh(command.appAccessSnapshot);
        await this.#backend.refreshAppAccess(runtimeContext, command.appAccessSnapshot);
        await sendCommandUpdate(runtimeContext, command, {
          result: {
            entryCount: command.appAccessSnapshot.entries.length,
          },
          status: "completed",
        });
        return;
      }

      if (command.kind === "input.start") {
        if (this.#activeRunTask) {
          await waitForActiveInputSettle(this.#activeRunTask);
        }
        if (this.#activeRunTask) {
          throw new Error("Driver run input is already in progress.");
        }
        if (this.#runtimeState.status() !== "ready") {
          throw new Error(`Driver is not ready for input: ${this.#runtimeState.status()}.`);
        }

        this.#runtimeState.enter("running");
        this.#activeRunGeneration += 1;
        const cancellation = new DriverActiveInputCancellation();
        const runId = parseRunId(command.runId);
        this.#activeInputCancellation = cancellation;
        socket.beginRun(runId);
        const activeRunTask = this.#runInputCommandAndClear(
          runtimeContext,
          socket,
          command,
          cancellation,
          this.#activeRunGeneration,
          runId,
        );
        this.#activeRunTask = activeRunTask;
        return;
      }

      if (command.kind === "mcp.execute") {
        const result = await this.#backend.handleMcpExecute(runtimeContext, command);
        await sendCommandUpdate(runtimeContext, command, {
          result,
          status: "completed",
        });
        return;
      }

      if (command.kind === "turn.cancel") {
        const reason = command.reason ?? "turn.cancelled";
        this.#permissionRequests.rejectAll();
        this.#activeInputCancellation?.cancel(reason);
        await this.#backend.cancelActiveTurn(runtimeContext, reason);
        await sendCommandUpdate(runtimeContext, command, {
          status: "completed",
        });
        return;
      }

      if (command.kind === "session.stop") {
        this.#permissionRequests.rejectAll();
        if (this.#runtimeState.status() !== "failed" && this.#runtimeState.status() !== "stopped") {
          this.#runtimeState.enter("stopped");
        }
        await sendCommandUpdate(runtimeContext, command, {
          status: "completed",
        });
        runtimeContext.logger.debug("driver.runtime.run.completing", {
          commandId: command.commandId,
          reason: command.reason,
        });
        await socket.completeRun();
        runtimeContext.logger.debug("driver.runtime.run.completed", {
          commandId: command.commandId,
          reason: command.reason,
        });
        await this.#shutdown(socket, command.reason);
        return;
      }
    } catch (error) {
      const commandFailure = toCommandFailure(command, error);

      await sendCommandUpdate(runtimeContext, command, {
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
        fatal: isCommandFailureFatal(command),
      });

      if (isCommandFailureFatal(command)) {
        throw error;
      }
    }
  }

  async #runInputCommand(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: Extract<RuntimeCommand, { kind: "input.start" }>,
    cancellation: DriverActiveInputCancellation,
    runId: RunId,
  ): Promise<void> {
    try {
      cancellation.throwIfCancelled();

      if (command.appAccessSnapshot) {
        await runtimeContext.ports.access.refresh(command.appAccessSnapshot);
        await this.#backend.refreshAppAccess(runtimeContext, command.appAccessSnapshot);
      }

      cancellation.throwIfCancelled();
      await this.#backend.handleInput(runtimeContext, command.input, runId);
      cancellation.throwIfCancelled();
      await sendCommandUpdate(runtimeContext, command, {
        result: {
          requestId: command.requestId,
        },
        status: "completed",
      });
      if (this.#runtimeState.status() === "running") {
        this.#runtimeState.enter("ready");
      }
    } catch (error) {
      if (isDriverTurnCancelledError(error)) {
        await sendCommandUpdate(runtimeContext, command, {
          status: "cancelled",
        });
        runtimeContext.logger.info("driver.runtime.input.cancelled", {
          commandId: command.commandId,
          commandKind: command.kind,
          driverInstanceId: this.#driverInstanceId,
        });

        if (this.#runtimeState.status() === "running") {
          this.#runtimeState.enter("ready");
        }
        return;
      }

      const commandFailure = toCommandFailure(command, error);

      this.#runtimeState.enter("failed");
      await sendCommandUpdate(runtimeContext, command, {
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
        await socket.failRun(commandFailure);
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

  async #runInputCommandAndClear(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: Extract<RuntimeCommand, { kind: "input.start" }>,
    cancellation: DriverActiveInputCancellation,
    generation: number,
    runId: RunId,
  ): Promise<void> {
    try {
      await this.#runInputCommand(runtimeContext, socket, command, cancellation, runId);
    } finally {
      socket.endRun(runId);
      if (this.#activeRunGeneration === generation) {
        this.#activeRunTask = null;
        this.#activeInputCancellation = null;
      }
    }
  }
}
