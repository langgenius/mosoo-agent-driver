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

export type TerminalCommandUpdate =
  | { readonly status: "cancelled" }
  | {
      readonly result?: Exclude<RuntimeCommandResult, null> | undefined;
      readonly status: "completed";
    }
  | { readonly error: RunError; readonly status: "failed" };

export type RunTerminalUpdate =
  | {
      status: "completed";
    }
  | {
      error: RunError;
      status: "failed";
    };

export interface TrackedCommand {
  readonly identity: unknown;
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
  update: { readonly status: "accepted" } | TerminalCommandUpdate,
  signal: AbortSignal,
): Promise<void> {
  const delivery = structuredClone({ commandId: command.commandId, ...update });
  await raceWithAbort(runtimeContext.ports.eventSink.commandUpdate(delivery, signal), signal);

  runtimeContext.logger.debug("driver.runtime.command.status.sent", {
    command: summarizeRuntimeCommand(command),
    ...(update.status === "failed" ? { error: update.error } : {}),
    result:
      update.status === "completed" && update.result !== undefined
        ? summarizeRuntimeCommandResult(update.result)
        : null,
    status: update.status,
  });
}

export class DriverCommandDelivery {
  readonly #shutdownSignal: AbortSignal;
  readonly #trackedCommands = new Map<string, TrackedCommand>();

  constructor(shutdownSignal: AbortSignal) {
    this.#shutdownSignal = shutdownSignal;
  }

  receive(command: RuntimeCommand, identity: unknown = command): CommandReceipt {
    const replay = this.replay(command, identity);

    if (replay !== null) {
      return replay;
    }

    if (this.#trackedCommands.size >= MAX_TRACKED_COMMANDS) {
      throw new Error(`Driver command history capacity is ${MAX_TRACKED_COMMANDS}.`);
    }

    const added: TrackedCommand = {
      delivery: Promise.resolve(),
      identity: structuredClone(identity),
    };
    this.#trackedCommands.set(command.commandId, added);
    return { replay: false, tracked: added };
  }

  replay(command: RuntimeCommand, identity: unknown = command): CommandReceipt | null {
    const tracked = this.#trackedCommands.get(command.commandId);

    if (tracked !== undefined) {
      if (!isDeepStrictEqual(tracked.identity, identity)) {
        throw new Error(
          `Driver command ${command.commandId} was replayed with changed identity or content.`,
        );
      }
      return { replay: true, tracked };
    }
    return null;
  }

  hasTerminal(commandId: string): boolean {
    return this.#trackedCommands.get(commandId)?.terminal !== undefined;
  }

  reject(
    runtimeContext: AgentDriverContext,
    command: RuntimeCommand,
    update: TerminalCommandUpdate,
  ): Promise<void> {
    return this.#deliverTerminal(runtimeContext, command, structuredClone(update));
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
