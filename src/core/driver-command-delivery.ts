import { isDeepStrictEqual } from "node:util";

import {
  summarizeRuntimeCommand,
  summarizeRuntimeCommandResult,
} from "../observability/driver-debug";
import type { RunError, RuntimeCommand, RuntimeCommandResult } from "../runtime-command";
import { raceWithAbort, settlePromiseWithTimeout, sleepPromise } from "../utils/async";
import type { AgentDriverContext } from "./agent-driver-backend";
import type { DriverRuntimeIo } from "./driver-runtime-io";

const MAX_TRACKED_COMMANDS = 1_024;
const COMMAND_UPDATE_TIMEOUT_MS = 1_000;
const RUN_TERMINAL_UPDATE_ATTEMPT_TIMEOUT_MS = 250;
const TERMINAL_UPDATE_MAX_ATTEMPTS = 3;

export interface TerminalCommandUpdate {
  error?: RunError;
  result?: RuntimeCommandResult;
  status: "cancelled" | "completed" | "failed";
}

export type RunTerminalUpdate =
  | {
      status: "completed";
    }
  | {
      error: RunError;
      status: "failed";
    };

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

export interface TrackedCommand {
  readonly command: RuntimeCommand;
  delivery: Promise<void>;
  terminal?: TerminalCommandUpdate;
  terminalTask?: Promise<void>;
}

export interface CommandReceipt {
  readonly replay: boolean;
  readonly tracked: TrackedCommand;
}

export class TerminalCommandDeliveryError extends Error {
  constructor(command: RuntimeCommand, cause: unknown) {
    super(`Driver command ${command.commandId} terminal status could not be delivered.`, {
      cause,
    });
    this.name = "TerminalCommandDeliveryError";
  }
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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
  await raceWithAbort(runtimeContext.ports.eventSink.commandUpdate(delivery, signal), signal);

  runtimeContext.logger.debug("driver.runtime.command.status.sent", {
    command: summarizeRuntimeCommand(command),
    ...(update.error ? { error: update.error } : {}),
    result: update.result ? summarizeRuntimeCommandResult(update.result) : null,
    status: update.status,
  });
}

export class DriverCommandDelivery {
  readonly #shutdownSignal: AbortSignal;
  readonly #trackedCommands = new Map<string, TrackedCommand>();
  #runTerminal: RunTerminalDelivery | null = null;

  constructor(shutdownSignal: AbortSignal) {
    this.#shutdownSignal = shutdownSignal;
  }

  receive(command: RuntimeCommand): CommandReceipt {
    const tracked = this.#trackedCommands.get(command.commandId);

    if (tracked !== undefined) {
      if (!isDeepStrictEqual(tracked.command, command)) {
        throw new Error(
          `Driver command ${command.commandId} was replayed with changed identity or content.`,
        );
      }
      return { replay: true, tracked };
    }

    if (this.#trackedCommands.size >= MAX_TRACKED_COMMANDS) {
      throw new Error(`Driver command history capacity is ${MAX_TRACKED_COMMANDS}.`);
    }

    const added: TrackedCommand = {
      command: structuredClone(command),
      delivery: Promise.resolve(),
    };
    this.#trackedCommands.set(command.commandId, added);
    return { replay: false, tracked: added };
  }

  hasTerminal(commandId: string): boolean {
    return this.#trackedCommands.get(commandId)?.terminal !== undefined;
  }

  resetRunTerminal(): void {
    this.#runTerminal = null;
  }

  accept(
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

  async finish(
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
        await this.finish(runtimeContext, command, terminal);
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

  claimRunTerminal(
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

    const task = deliverRunTerminal(socket, terminal);
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

      const controller = new AbortController();
      const delivery = await settlePromiseWithTimeout(
        sendCommandUpdate(runtimeContext, command, terminal, controller.signal),
        {
          label: `Driver command ${command.commandId} terminal status delivery`,
          timeoutMs: remainingMs,
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
}

export async function deliverRunTerminal(
  socket: DriverRuntimeIo,
  terminal: RunTerminalUpdate,
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
        timeoutMs: Math.min(remainingMs, RUN_TERMINAL_UPDATE_ATTEMPT_TIMEOUT_MS),
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
