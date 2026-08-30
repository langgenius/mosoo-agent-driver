import { createHash, randomUUID } from "node:crypto";

import { AGENT_DRIVER_MCP_EXECUTE_TIMEOUT_MS } from "../host-ports";
import { createScopedWideEvent, emitWideEvent } from "../observability";
import type { Logger } from "../observability";
import { summarizeRuntimeCommand } from "../observability/driver-debug";
import type { DriverEventInput } from "../protocol/events";
import { parseRunId } from "../protocol/id";
import type { RunId } from "../protocol/id";
import type {
  McpExecuteCommandResult,
  McpExternalToolEffectSettlement,
  McpExternalToolEffectState,
  RunError,
  RuntimeCommand,
} from "../runtime-command";
import {
  createMcpUnknownEffectRunError,
  createMcpUnsettledEffectRunError,
  normalizeDurableRunError,
  parseRuntimeCommand,
} from "../runtime-command";
import { promiseWithTimeout, raceWithAbort, sleepPromise } from "../utils/async";
import type { AgentDriverBackend, AgentDriverContext } from "./agent-driver-backend";
import {
  type CommandReceipt,
  deliverRunTerminal,
  DriverCommandDelivery,
  TerminalCommandDeliveryError,
} from "./driver-command-delivery";
import { pushDriverDiagnosticEvent } from "./driver-diagnostics";
import type { DriverPermissionBroker } from "./driver-permission-broker";
import {
  createDurableMcpSucceededSettlement,
  requireDurableMcpResultIdentity,
} from "./external-tool-effect-settlement";
import {
  DRIVER_EVENT_DELIVERY_TIMEOUT_MS,
  pushLosslessEvents,
  type DriverRuntimeIo,
} from "./driver-runtime-io";
import type { DriverRuntimeStateMachine } from "./driver-runtime-state";
import { isDriverTurnCancelledError } from "./driver-runtime-state";
import type { DriverInputOutcome, DriverRunTicket } from "./driver-terminal-state";

interface DriverCommandDispatcherOptions {
  backend: AgentDriverBackend;
  driverInstanceId: string;
  isShuttingDown(): boolean;
  permissionRequests: DriverPermissionBroker;
  rememberRunFailure(error: RunError): void;
  runtimeContextFactory(socket: DriverRuntimeIo, logger: Logger): AgentDriverContext;
  runtimeState: DriverRuntimeStateMachine;
  sandboxId: string;
  shutdownSignal: AbortSignal;
  shutdown(socket: DriverRuntimeIo, reason: string): Promise<void>;
}

const COMMAND_POLL_INTERVAL_MS = 250;
export const ACTIVE_TURN_CANCEL_GRACE_MS = 2_000;
const ACTIVE_INPUT_SETTLE_GRACE_MS = ACTIVE_TURN_CANCEL_GRACE_MS + DRIVER_EVENT_DELIVERY_TIMEOUT_MS;
const EXTERNAL_TOOL_EFFECT_FENCE_TIMEOUT_MS = 2_000;
export const ACTIVE_MCP_COMMIT_GRACE_MS = AGENT_DRIVER_MCP_EXECUTE_TIMEOUT_MS + 30_000;
const MAX_ACTIVE_MCP_COMMANDS = 32;

interface ActiveMcpCommand {
  readonly controller: AbortController;
  readonly runId: RunId;
  readonly task: Promise<void>;
}

interface ActiveMcpAdmission {
  readonly runId: RunId;
  readonly settled: Promise<void>;
  settle(): void;
}

interface RunTerminalEvent {
  readonly kind: "run.cancelled" | "run.completed" | "run.failed";
  readonly runId: RunId;
}

function isFatalCommand(command: RuntimeCommand): boolean {
  return command.kind === "input.start" || command.kind === "turn.cancel";
}

function toCommandFailure(command: RuntimeCommand, error: unknown): RunError {
  if (error instanceof ExternalToolEffectUnknownError) {
    return normalizeDurableRunError(error.failure);
  }

  return normalizeDurableRunError({
    code: `driver.command_failed.${command.kind}`,
    details: {
      commandId: command.commandId,
      commandKind: command.kind,
    },
    message: error instanceof Error ? error.message : `Driver command ${command.kind} failed.`,
    retryable: false,
  });
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

class ExternalToolEffectUnknownError extends Error {
  readonly failure: RunError;

  constructor(command: Extract<RuntimeCommand, { kind: "mcp.execute" }>, effectId: string) {
    const failure = createMcpUnknownEffectRunError(command, effectId);
    super(failure.message);
    this.name = "ExternalToolEffectUnknownError";
    this.failure = failure;
  }
}

class ExternalToolEffectUnsettledError extends Error {
  readonly failure: RunError;

  constructor(
    command: Extract<RuntimeCommand, { kind: "mcp.execute" }>,
    effectId: string,
    cause?: unknown,
  ) {
    const failure = createMcpUnsettledEffectRunError(command, effectId);
    super(failure.message, cause === undefined ? undefined : { cause });
    this.name = "ExternalToolEffectUnsettledError";
    this.failure = failure;
  }
}

async function retryOnce<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch {
    return operation();
  }
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
  readonly #rememberRunFailure: (error: RunError) => void;
  readonly #runtimeContextFactory: (socket: DriverRuntimeIo, logger: Logger) => AgentDriverContext;
  readonly #runtimeState: DriverRuntimeStateMachine;
  readonly #sandboxId: string;
  readonly #shutdownSignal: AbortSignal;
  readonly #shutdown: (socket: DriverRuntimeIo, reason: string) => Promise<void>;
  readonly #commandDelivery: DriverCommandDelivery;
  #activeWorkFailure: { error: unknown } | null = null;
  #activeRunTicket: DriverRunTicket | null = null;
  readonly #activeMcpAdmissions = new Set<ActiveMcpAdmission>();
  readonly #activeMcpCommands = new Map<string, ActiveMcpCommand>();
  readonly #mcpRunFailures = new Map<RunId, { error: unknown }>();
  readonly #terminalRunFences = new Set<RunId>();
  #activeRunGeneration = 0;
  #activeRunTask: Promise<void> | null = null;
  #shutdownCompleted = false;
  #shutdownPermissionTask: Promise<void> | null = null;

  constructor(options: DriverCommandDispatcherOptions) {
    this.#backend = options.backend;
    this.#driverInstanceId = options.driverInstanceId;
    this.#isShuttingDown = options.isShuttingDown;
    this.#permissionRequests = options.permissionRequests;
    this.#rememberRunFailure = options.rememberRunFailure;
    this.#runtimeContextFactory = options.runtimeContextFactory;
    this.#runtimeState = options.runtimeState;
    this.#sandboxId = options.sandboxId;
    this.#shutdownSignal = options.shutdownSignal;
    this.#shutdown = options.shutdown;
    this.#commandDelivery = new DriverCommandDelivery(options.shutdownSignal);
  }

  async run(socket: DriverRuntimeIo, logger: Logger): Promise<void> {
    const runtimeContext = this.#runtimeContextFactory(socket, logger);
    const unregisterRunTerminalBarrier = socket.registerRunTerminalBarrier((events) =>
      this.#waitForRunTerminal(socket, events),
    );
    let joiningActiveWork = false;
    const onShutdown = () => {
      this.#shutdownPermissionTask = this.#permissionRequests.rejectAllAndWait();
      void this.#shutdownPermissionTask.catch(() => {});
      this.#abortActiveWork(
        socket,
        toErrorMessage(this.#shutdownSignal.reason, "driver.command_loop.stopped"),
        "shutdown",
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
          let commandIdentity: unknown;

          try {
            const candidate = await raceWithAbort(
              runtimeContext.ports.commandSource.nextCommand(this.#shutdownSignal),
              this.#shutdownSignal,
            );
            command = candidate === null ? null : parseRuntimeCommand(candidate);
            commandIdentity = candidate;
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

          await this.#handleCommand(runtimeContext, socket, command, commandIdentity);

          if (this.#isShuttingDown()) {
            return;
          }
        }
      });
      if (this.#shutdownSignal.aborted || this.#runtimeState.isShuttingDown()) {
        this.#abortActiveWork(socket, "driver.command_loop.stopped", "shutdown");
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
        socket,
        shuttingDown ? "driver.command_loop.stopped" : "driver.command_loop.failed",
        "shutdown",
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
      const runFailure = {
        code: "driver.command_loop_failed",
        details: {},
        message: toErrorMessage(failure, "Command loop failed."),
        retryable: false,
      } satisfies RunError;
      this.#rememberRunFailure(runFailure);

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
      } catch {
        /* Ignore runtime error propagation failures */
      }

      try {
        await this.#shutdown(socket, "driver.command_loop_failed");
        this.#shutdownCompleted = true;
      } catch (shutdownError) {
        logger.error("driver.runtime.shutdown.failed", shutdownError, {
          driverInstanceId: this.#driverInstanceId,
        });
      }
      try {
        await this.#joinActiveWork();
      } catch (settleError) {
        logger.warn("driver.runtime.active-work.settle-failed", {
          message: toErrorMessage(settleError, "Active driver work did not settle."),
        });
      }

      throw failure;
    } finally {
      this.#shutdownSignal.removeEventListener("abort", onShutdown);
      unregisterRunTerminalBarrier();
    }
  }

  #waitForRunTerminal(
    socket: DriverRuntimeIo,
    events: readonly DriverEventInput[],
  ): Promise<void> | void {
    const terminal = this.#readRunTerminal(socket, events);

    if (terminal === null) {
      return;
    }

    this.#terminalRunFences.add(terminal.runId);
    const permissions = this.#permissionRequests.rejectRunAndWait(terminal.runId);
    const hasWork =
      [...this.#activeMcpAdmissions].some((admission) => admission.runId === terminal.runId) ||
      [...this.#activeMcpCommands.values()].some((command) => command.runId === terminal.runId);

    if (hasWork) {
      return permissions === undefined
        ? this.#joinRunMcpWork(terminal)
        : Promise.all([permissions, this.#joinRunMcpWork(terminal)]).then(() => undefined);
    }

    const failure = this.#mcpRunFailures.get(terminal.runId);
    if (permissions === undefined) {
      if (failure !== undefined && terminal.kind !== "run.failed") {
        throw failure.error;
      }
      return;
    }
    return permissions.then(() => {
      if (failure !== undefined && terminal.kind !== "run.failed") {
        throw failure.error;
      }
    });
  }

  #readRunTerminal(
    socket: DriverRuntimeIo,
    events: readonly DriverEventInput[],
  ): RunTerminalEvent | null {
    let terminal: RunTerminalEvent | null = null;
    let terminalIndex = -1;

    for (const [index, event] of events.entries()) {
      if (
        event.kind !== "run.cancelled" &&
        event.kind !== "run.completed" &&
        event.kind !== "run.failed"
      ) {
        continue;
      }
      if (terminal !== null) {
        throw new Error("Driver event batch cannot contain multiple run terminals.");
      }

      const runId = event.runId === undefined ? socket.currentRunId() : event.runId;
      if (runId === null) {
        throw new Error("Driver run terminal requires an active run.");
      }

      terminal = { kind: event.kind, runId: parseRunId(runId) };
      terminalIndex = index;
    }

    if (terminalIndex >= 0 && terminalIndex !== events.length - 1) {
      throw new Error("Driver run terminal must be the final event in its batch.");
    }

    return terminal;
  }

  #beginMcpAdmission(runId: RunId): ActiveMcpAdmission | null {
    if (this.#terminalRunFences.has(runId)) {
      return null;
    }

    const settlement = Promise.withResolvers<void>();
    const admission: ActiveMcpAdmission = {
      runId,
      settle: () => settlement.resolve(),
      settled: settlement.promise,
    };
    this.#activeMcpAdmissions.add(admission);
    return admission;
  }

  async #joinRunMcpWork(terminal: RunTerminalEvent): Promise<void> {
    while (true) {
      const admissions = [...this.#activeMcpAdmissions]
        .filter((admission) => admission.runId === terminal.runId)
        .map((admission) => admission.settled);
      const commands = [...this.#activeMcpCommands.values()]
        .filter((command) => command.runId === terminal.runId)
        .map((command) => command.task);
      const work = [...admissions, ...commands];

      if (work.length === 0) {
        break;
      }

      await promiseWithTimeout(Promise.allSettled(work), {
        label: `Driver MCP commands for run ${terminal.runId}`,
        timeoutMs: ACTIVE_MCP_COMMIT_GRACE_MS,
      });
    }

    const failure = this.#mcpRunFailures.get(terminal.runId);
    if (failure !== undefined && terminal.kind !== "run.failed") {
      throw failure.error;
    }
  }

  #clearRunMcpState(socket: DriverRuntimeIo, runId: RunId): void {
    if (
      socket.currentRunId() === runId ||
      [...this.#activeMcpAdmissions].some((admission) => admission.runId === runId) ||
      [...this.#activeMcpCommands.values()].some((command) => command.runId === runId)
    ) {
      return;
    }

    this.#mcpRunFailures.delete(runId);
    this.#terminalRunFences.delete(runId);
  }

  async #handleCommand(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: RuntimeCommand,
    commandIdentity: unknown,
  ): Promise<void> {
    const commandSummary = summarizeRuntimeCommand(command);
    const replay = this.#commandDelivery.replay(command, commandIdentity);
    const mcpAdmission =
      command.kind === "mcp.execute" && replay === null
        ? this.#beginMcpAdmission(parseRunId(command.runId))
        : undefined;

    try {
      await this.#handleAdmittedCommand(
        runtimeContext,
        socket,
        command,
        commandIdentity,
        commandSummary,
        replay,
        mcpAdmission !== null,
      );
    } catch (error) {
      if (mcpAdmission !== undefined && mcpAdmission !== null) {
        this.#mcpRunFailures.set(mcpAdmission.runId, { error });
        this.#terminalRunFences.add(mcpAdmission.runId);
      }
      throw error;
    } finally {
      if (mcpAdmission !== undefined && mcpAdmission !== null) {
        this.#activeMcpAdmissions.delete(mcpAdmission);
        mcpAdmission.settle();
      }
    }
  }

  async #handleAdmittedCommand(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: RuntimeCommand,
    commandIdentity: unknown,
    commandSummary: ReturnType<typeof summarizeRuntimeCommand>,
    replay: CommandReceipt | null,
    mcpAdmissionGranted: boolean,
  ): Promise<void> {
    const replayMode =
      replay === null ? null : replay.tracked.terminal === undefined ? "active" : "terminal";

    try {
      if (command.kind === "mcp.execute" && replay === null && !mcpAdmissionGranted) {
        throw new Error(`Run ${command.runId} is already publishing its terminal event.`);
      }
      if (replay === null && command.kind === "input.start" && this.#activeRunTask !== null) {
        await settleInput(this.#activeRunTask);
      }
      this.#assertCommandRunOwnership(socket, command, replayMode);
    } catch (error) {
      await this.#commandDelivery.reject(runtimeContext, command, {
        error: toCommandFailure(command, error),
        status: "failed",
      });
      runtimeContext.logger.warn("driver.runtime.command.run-rejected", {
        commandId: command.commandId,
        commandKind: command.kind,
        message: toErrorMessage(error, "Driver command does not target the active run."),
      });
      return;
    }

    runtimeContext.logger.debug("driver.runtime.command.received", commandSummary);
    const receipt = replay ?? this.#commandDelivery.receive(command, commandIdentity);

    if (receipt.replay) {
      if (receipt.tracked.terminal) {
        await this.#commandDelivery.finish(runtimeContext, command, receipt.tracked.terminal, true);
      } else {
        await this.#commandDelivery.accept(runtimeContext, command, receipt.tracked);
      }
      return;
    }

    const eagerCancellation =
      command.kind === "turn.cancel"
        ? this.#cancelActiveWork(
            runtimeContext,
            socket,
            command.reason ?? "turn.cancelled",
            "turn.cancel",
          )
        : null;
    void eagerCancellation?.catch(() => {});
    await this.#commandDelivery.accept(runtimeContext, command, receipt.tracked);

    try {
      if (command.kind === "permission.resolve") {
        this.#assertCommandRunOwnership(socket, command);
        this.#permissionRequests.resolve(command.requestId, command.decision);
        await this.#commandDelivery.finish(runtimeContext, command, {
          status: "completed",
        });
        return;
      }

      if (command.kind === "input.start") {
        this.#activeRunGeneration += 1;
        this.#runtimeState.beginRun(this.#activeRunGeneration);
        const runId = parseRunId(command.runId);
        const ticket = socket.beginRun(runId);
        this.#activeRunTicket = ticket;
        let activeRunTask!: Promise<void>;
        activeRunTask = this.#runInputTask(
          runtimeContext,
          socket,
          command,
          this.#activeRunGeneration,
          ticket,
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
              this.#activeRunTicket = null;
            }
          });
        this.#activeRunTask = activeRunTask;
        return;
      }

      if (command.kind === "mcp.execute") {
        this.#assertCommandRunOwnership(socket, command);
        this.#startMcpCommand(runtimeContext, socket, command);
        return;
      }

      if (command.kind === "turn.cancel") {
        await eagerCancellation;
        await this.#commandDelivery.finish(runtimeContext, command, {
          status: "completed",
        });
        return;
      }

      if (command.kind === "session.stop") {
        const reason = command.reason;
        this.#runtimeState.enter("stopping");
        await this.#cancelActiveWork(
          runtimeContext,
          socket,
          reason,
          "session.stop",
          this.#permissionRequests.rejectAllAndWait(),
        );

        await this.#shutdown(socket, reason);
        this.#shutdownCompleted = true;

        runtimeContext.logger.debug("driver.runtime.run.completing", {
          commandId: command.commandId,
          reason,
        });
        await deliverRunTerminal(socket, { status: "completed" });
        runtimeContext.logger.debug("driver.runtime.run.completed", {
          commandId: command.commandId,
          reason,
        });

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

  #assertCommandRunOwnership(
    socket: DriverRuntimeIo,
    command: RuntimeCommand,
    replay: "active" | "terminal" | null = null,
  ): void {
    if (command.kind === "session.stop") {
      return;
    }

    const runId = parseRunId(command.runId);
    const currentRunId = socket.currentRunId();

    if (command.kind === "input.start") {
      if (
        replay === "terminal"
          ? currentRunId !== null && currentRunId !== runId
          : replay === "active"
            ? currentRunId !== runId
            : this.#activeRunTask !== null || currentRunId !== null
      ) {
        throw new Error(`Input command ${command.commandId} cannot replace the active run.`);
      }
      if (replay === null && this.#runtimeState.status() !== "ready") {
        throw new Error(`Driver is not ready for input: ${this.#runtimeState.status()}.`);
      }
      return;
    }

    if (currentRunId !== runId && !(replay === "terminal" && currentRunId === null)) {
      throw new Error(`Command ${command.commandId} does not target the active run.`);
    }
  }

  #abortMcpCommands(reason: string): void {
    for (const { controller } of this.#activeMcpCommands.values()) {
      controller.abort(new Error(reason));
    }
  }

  #abortActiveWork(
    socket: DriverRuntimeIo,
    reason: string,
    source: "session.stop" | "shutdown" | "turn.cancel",
  ): "already_claimed" | "claimed" | "idle" | "terminal_selected" {
    const ticket = this.#activeRunTicket;
    const cancellation =
      ticket === null || socket.runSnapshot(ticket.runId) === null
        ? "idle"
        : socket.claimRunCancellation(ticket, reason);

    if (source !== "turn.cancel" || cancellation !== "terminal_selected") {
      this.#permissionRequests.rejectAll();
      this.#abortMcpCommands(reason);
    }
    if (cancellation === "idle") {
      this.#activeRunTicket = null;
    }
    return cancellation;
  }

  async #cancelActiveWork(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    reason: string,
    source: "session.stop" | "shutdown" | "turn.cancel",
    permissionCancellation?: Promise<void>,
  ): Promise<void> {
    const cancellation = this.#abortActiveWork(socket, reason, source);
    let permissionFailure: { error: unknown } | null = null;

    if (permissionCancellation !== undefined) {
      try {
        await permissionCancellation;
      } catch (error) {
        permissionFailure = { error };
      }
    }

    const tasks = [this.#joinActiveWork()];
    if (source !== "turn.cancel" || cancellation !== "terminal_selected") {
      tasks.push(
        promiseWithTimeout(this.#backend.cancelActiveTurn(runtimeContext, reason), {
          label: "Active driver turn cancellation",
          timeoutMs: ACTIVE_TURN_CANCEL_GRACE_MS,
        }),
      );
    }
    const results = await Promise.allSettled(tasks);
    const failure = results.find((result) => result.status === "rejected");

    if (permissionFailure !== null) {
      throw permissionFailure.error;
    }
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
    if (this.#activeWorkFailure !== null) {
      throw this.#activeWorkFailure.error;
    }
  }

  async #joinActiveWork(): Promise<void> {
    let permissionFailure: { error: unknown } | null = null;

    if (this.#shutdownPermissionTask !== null) {
      try {
        await this.#shutdownPermissionTask;
      } catch (error) {
        permissionFailure = { error };
      }
    }
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
            timeoutMs: ACTIVE_MCP_COMMIT_GRACE_MS,
          },
        ),
      );
    }

    const results = await Promise.allSettled(tasks);
    const failure = results.find((result) => result.status === "rejected");

    if (permissionFailure !== null) {
      throw permissionFailure.error;
    }
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

    const runId = parseRunId(command.runId);
    const controller = new AbortController();
    const task = this.#runMcpCommand(runtimeContext, socket, command, controller)
      .catch((error: unknown) => {
        this.#activeWorkFailure ??= { error };
        if (!this.#mcpRunFailures.has(runId)) {
          this.#mcpRunFailures.set(runId, { error });
        }
        this.#rememberRunFailure({
          code: "driver.mcp_task_failed",
          details: { commandId: command.commandId },
          message: toErrorMessage(error, "Driver MCP task failed."),
          retryable: false,
        });
        runtimeContext.logger.error("driver.runtime.mcp-command.failed", error, {
          commandId: command.commandId,
          driverInstanceId: this.#driverInstanceId,
        });
        throw error;
      })
      .finally(() => {
        if (this.#activeMcpCommands.get(command.commandId)?.task === task) {
          this.#activeMcpCommands.delete(command.commandId);
        }
        this.#clearRunMcpState(socket, runId);
      });
    this.#activeMcpCommands.set(command.commandId, { controller, runId, task });
    void task.catch(async () => {
      await this.#shutdown(socket, "driver.mcp_task_failed").catch((shutdownError: unknown) => {
        runtimeContext.logger.error("driver.runtime.shutdown.failed", shutdownError, {
          commandId: command.commandId,
        });
      });
    });
  }

  async #runMcpCommand(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: Extract<RuntimeCommand, { kind: "mcp.execute" }>,
    controller: AbortController,
  ): Promise<void> {
    let durableResult: McpExecuteCommandResult | null = null;
    const effectLedger = runtimeContext.ports.eventSink;

    try {
      await pushLosslessEvents(socket, [
        {
          correlationId: command.commandId,
          kind: "tool.call.updated",
          payload: {
            kind: "mcp",
            rawInput: command.argumentsJson,
            status: "running",
            title: command.toolName,
            toolCallId: command.toolCallId,
          },
          runId: parseRunId(command.runId),
          sourceEventId: `mcp.execute.running:${command.commandId}`,
        },
      ]);
      controller.signal.throwIfAborted();
      const observeExternalToolEffect = effectLedger.observeExternalToolEffect;
      if (
        observeExternalToolEffect === undefined ||
        effectLedger.claimExternalToolEffect === undefined ||
        effectLedger.settleExternalToolEffect === undefined
      ) {
        throw new Error("Driver external tool effect ledger is not configured.");
      }
      const observed = await observeExternalToolEffect.call(
        effectLedger,
        { commandId: command.commandId },
        controller.signal,
      );
      const result =
        observed.kind === "intent"
          ? await this.#executeMcpIntent(runtimeContext, command, controller, observed.effectId)
          : this.#resolveExternalToolEffectState(command, observed, observed.effectId);
      durableResult = result;

      await pushLosslessEvents(socket, [
        {
          correlationId: command.commandId,
          kind: "tool.call.updated",
          payload: {
            kind: "mcp",
            rawInput: command.argumentsJson,
            rawOutput: result.outputText,
            status: "completed",
            title: command.toolName,
            toolCallId: command.toolCallId,
          },
          runId: parseRunId(command.runId),
          sourceEventId: `mcp.execute.completed:${command.commandId}`,
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
      if (durableResult !== null) {
        throw error;
      }

      if (error instanceof ExternalToolEffectUnsettledError) {
        throw error;
      }

      if (this.#commandDelivery.hasTerminal(command.commandId)) {
        throw error;
      }

      if (controller.signal.aborted && !(error instanceof ExternalToolEffectUnknownError)) {
        await pushLosslessEvents(socket, [
          {
            correlationId: command.commandId,
            kind: "tool.call.updated",
            payload: {
              kind: "mcp",
              rawInput: command.argumentsJson,
              status: "cancelled",
              title: command.toolName,
              toolCallId: command.toolCallId,
            },
            runId: parseRunId(command.runId),
            sourceEventId: `mcp.execute.cancelled:${command.commandId}`,
          },
        ]);
        await this.#commandDelivery.finish(runtimeContext, command, {
          status: "cancelled",
        });
        return;
      }

      const commandFailure = toCommandFailure(command, error);
      const failedPayload = {
        kind: "mcp",
        rawInput: command.argumentsJson,
        rawOutput: commandFailure.message,
        status: "failed",
        title: command.toolName,
        toolCallId: command.toolCallId,
      } as const;
      const failedSourceEventId = `mcp.execute.failed:${createHash("sha256")
        .update(JSON.stringify([command.commandId, failedPayload]))
        .digest("hex")}`;

      await pushLosslessEvents(socket, [
        {
          correlationId: command.commandId,
          kind: "tool.call.updated",
          payload: failedPayload,
          runId: parseRunId(command.runId),
          sourceEventId: failedSourceEventId,
        },
      ]);

      await this.#failCommand(runtimeContext, socket, command, error, commandFailure);
    }
  }

  async #executeMcpIntent(
    runtimeContext: AgentDriverContext,
    command: Extract<RuntimeCommand, { kind: "mcp.execute" }>,
    controller: AbortController,
    effectId: string,
  ): Promise<McpExecuteCommandResult> {
    this.#assertActiveMcpRun(runtimeContext, command);
    const durableResultIdentity = requireDurableMcpResultIdentity(command);
    const prepared = await runtimeContext.ports.mcp.prepare(command, controller.signal);

    try {
      controller.signal.throwIfAborted();
      this.#assertActiveMcpRun(runtimeContext, command);
      const claimToken = randomUUID();
      const claimInput = { claimToken, commandId: command.commandId } as const;
      const claimExternalToolEffect = runtimeContext.ports.eventSink.claimExternalToolEffect;
      let claim: McpExternalToolEffectState;

      if (claimExternalToolEffect === undefined) {
        throw new Error("Driver external tool effect ledger is not configured.");
      }

      try {
        claim = await retryOnce(() =>
          claimExternalToolEffect.call(
            runtimeContext.ports.eventSink,
            claimInput,
            AbortSignal.timeout(EXTERNAL_TOOL_EFFECT_FENCE_TIMEOUT_MS),
          ),
        );
      } catch (error) {
        runtimeContext.logger.warn("driver.runtime.mcp.claim.outcome-unknown", {
          commandId: command.commandId,
          effectId,
          message: toErrorMessage(error, "External effect claim failed."),
        });
        throw new ExternalToolEffectUnsettledError(command, effectId, error);
      }

      if (claim.kind !== "claimed") {
        return this.#resolveExternalToolEffectState(command, claim, effectId);
      }
      if (claim.effectId !== effectId) {
        throw new ExternalToolEffectUnsettledError(
          command,
          effectId,
          new Error(`External effect claim returned mismatched effect ID ${claim.effectId}.`),
        );
      }

      runtimeContext.logger.info("driver.runtime.mcp.execute.started", {
        effectAttempt: claim.attempt,
        serverId: command.serverId,
        toolName: command.toolName,
      });
      let execution: Awaited<ReturnType<typeof prepared.execute>>;

      try {
        execution = await prepared.execute(claim);
      } catch (error) {
        runtimeContext.logger.warn("driver.runtime.mcp.execute.outcome-unknown", {
          commandId: command.commandId,
          effectId,
          message: toErrorMessage(error, "MCP execution outcome is unknown."),
        });
        const settled = await this.#settleExternalToolEffect(
          runtimeContext,
          command,
          claimToken,
          effectId,
          { kind: "unknown" },
        );
        return this.#resolveExternalToolEffectState(command, settled, effectId);
      }

      const settled = await this.#settleExternalToolEffect(
        runtimeContext,
        command,
        claimToken,
        effectId,
        createDurableMcpSucceededSettlement(execution, durableResultIdentity),
      );
      return this.#resolveExternalToolEffectState(command, settled, effectId);
    } finally {
      await Promise.resolve(prepared[Symbol.asyncDispose]()).catch((error: unknown) => {
        runtimeContext.logger.warn("driver.runtime.mcp.cleanup.failed", {
          commandId: command.commandId,
          message: toErrorMessage(error, "MCP cleanup failed."),
        });
      });
    }
  }

  #assertActiveMcpRun(
    runtimeContext: AgentDriverContext,
    command: Extract<RuntimeCommand, { kind: "mcp.execute" }>,
  ): void {
    if (runtimeContext.ports.eventSink.currentRunId() !== parseRunId(command.runId)) {
      throw new Error(`Command ${command.commandId} does not target the active run.`);
    }
  }

  #resolveExternalToolEffectState(
    command: Extract<RuntimeCommand, { kind: "mcp.execute" }>,
    state: McpExternalToolEffectState,
    effectId: string,
  ): McpExecuteCommandResult {
    if (state.effectId !== effectId) {
      throw new ExternalToolEffectUnsettledError(
        command,
        effectId,
        new Error(`External effect state returned mismatched effect ID ${state.effectId}.`),
      );
    }
    if (state.kind === "succeeded") {
      if (
        state.result.requestId !== command.requestId ||
        state.result.serverId !== command.serverId ||
        state.result.toolName !== command.toolName
      ) {
        throw new ExternalToolEffectUnsettledError(
          command,
          effectId,
          new Error("External effect result does not match the current MCP command."),
        );
      }
      return state.result;
    }
    if (state.kind === "unknown") {
      throw new ExternalToolEffectUnknownError(command, effectId);
    }

    throw new ExternalToolEffectUnsettledError(command, effectId);
  }

  async #settleExternalToolEffect(
    runtimeContext: AgentDriverContext,
    command: Extract<RuntimeCommand, { kind: "mcp.execute" }>,
    claimToken: string,
    effectId: string,
    settlement: McpExternalToolEffectSettlement,
  ): Promise<McpExternalToolEffectState> {
    const input = { claimToken, commandId: command.commandId, effectId, settlement } as const;
    const settleExternalToolEffect = runtimeContext.ports.eventSink.settleExternalToolEffect;

    if (settleExternalToolEffect === undefined) {
      throw new Error("Driver external tool effect ledger is not configured.");
    }

    try {
      return await retryOnce(() =>
        settleExternalToolEffect.call(
          runtimeContext.ports.eventSink,
          input,
          AbortSignal.timeout(EXTERNAL_TOOL_EFFECT_FENCE_TIMEOUT_MS),
        ),
      );
    } catch (error) {
      throw new ExternalToolEffectUnsettledError(command, effectId, error);
    }
  }

  async #failCommand(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: RuntimeCommand,
    error: unknown,
    commandFailure = toCommandFailure(command, error),
  ): Promise<void> {
    if (command.kind === "session.stop") {
      if (this.#runtimeState.status() === "stopping") {
        this.#runtimeState.enter("failed");
      }

      if (!this.#shutdownCompleted) {
        await this.#shutdown(socket, command.reason).then(
          () => {
            this.#shutdownCompleted = true;
          },
          (shutdownError: unknown) => {
            runtimeContext.logger.error("driver.runtime.shutdown.failed", shutdownError, {
              commandId: command.commandId,
            });
          },
        );
      }
      this.#rememberRunFailure(commandFailure);
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
    ticket: DriverRunTicket,
  ): Promise<"command_acked" | "driver_failing"> {
    let outcome: DriverInputOutcome;
    try {
      ticket.signal.throwIfAborted();
      await this.#backend.handleInput(
        runtimeContext,
        { text: command.input.text },
        ticket.runId,
        ticket.signal,
      );
      outcome = { status: "resolved" };
    } catch (error) {
      outcome = isDriverTurnCancelledError(error)
        ? { error, status: "cancelled" }
        : { error, status: "rejected" };
    }

    const settlement = socket.settleRunInput(ticket, outcome);
    if (settlement.status === "resolved") {
      await this.#commandDelivery.finish(runtimeContext, command, {
        result: {
          requestId: command.requestId,
        },
        status: "completed",
      });
      return "command_acked";
    }
    if (settlement.status === "cancelled") {
      await this.#commandDelivery.finish(runtimeContext, command, {
        status: "cancelled",
      });
      runtimeContext.logger.info("driver.runtime.input.cancelled", {
        commandId: command.commandId,
        commandKind: command.kind,
        driverInstanceId: this.#driverInstanceId,
      });
      return "command_acked";
    }

    const commandFailure = toCommandFailure(command, settlement.failure);
    this.#runtimeState.enter("failed");
    await this.#commandDelivery.finish(runtimeContext, command, {
      error: commandFailure,
      status: "failed",
    });
    if (socket.runSnapshot(ticket.runId)?.terminal === null) {
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
    }
    runtimeContext.logger.error("driver.runtime.command.failed", settlement.failure, {
      commandId: command.commandId,
      commandKind: command.kind,
      driverInstanceId: this.#driverInstanceId,
      fatal: true,
    });
    this.#rememberRunFailure(commandFailure);
    await this.#shutdown(socket, commandFailure.code);
    this.#shutdownCompleted = true;
    return "driver_failing";
  }

  async #runInputTask(
    runtimeContext: AgentDriverContext,
    socket: DriverRuntimeIo,
    command: Extract<RuntimeCommand, { kind: "input.start" }>,
    generation: number,
    ticket: DriverRunTicket,
  ): Promise<void> {
    let releaseReason: "command_acked" | "driver_failing" = "driver_failing";
    try {
      releaseReason = await this.#runInputCommand(runtimeContext, socket, command, ticket);
    } finally {
      socket.releaseRun(ticket, releaseReason);
      this.#clearRunMcpState(socket, ticket.runId);
      if (this.#activeRunTicket === ticket) {
        this.#activeRunTicket = null;
      }
      this.#runtimeState.endRun(generation);
    }
  }
}
