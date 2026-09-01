import { isDeepStrictEqual } from "node:util";

import type { DriverEventInput } from "../protocol/events";
import type { RunId } from "../protocol/id";
import type { DriverEventReceipt } from "../protocol/orpc";
import type { RunError } from "../runtime-command";
import {
  DriverTurnCancelledError,
  type DriverTurnCancellationSource,
} from "./driver-turn-cancelled-error";

export type DriverRunTerminalStatus = "cancelled" | "completed" | "failed";

export interface DriverRunTicket {
  readonly revision: number;
  readonly runId: RunId;
  readonly signal: AbortSignal;
}

export interface DriverRunTerminalIdentity {
  readonly event: DriverEventInput;
  readonly runId: RunId;
  readonly sourceEventId: string;
  readonly status: DriverRunTerminalStatus;
}

export type DriverRunTerminalState =
  | {
      readonly phase: "selected";
      readonly value: DriverRunTerminalIdentity;
    }
  | {
      readonly phase: "acked";
      readonly receipt: DriverEventReceipt;
      readonly value: DriverRunTerminalIdentity;
    };

export interface DriverRunSnapshot {
  readonly cancellation: {
    readonly reason: string;
  } | null;
  readonly revision: number;
  readonly runId: RunId;
  readonly terminal: DriverRunTerminalState | null;
}

export type DriverInstanceTerminal =
  | { readonly runId: RunId; readonly status: "completed" }
  | { readonly error: RunError; readonly runId: RunId; readonly status: "failed" };

export type DriverInstanceTerminalState =
  | { readonly phase: "open" }
  | { readonly phase: "selected"; readonly terminal: DriverInstanceTerminal }
  | { readonly phase: "acked"; readonly terminal: DriverInstanceTerminal };

export type DriverInputOutcome =
  | { readonly status: "resolved" }
  | { readonly error: DriverTurnCancelledError; readonly status: "cancelled" }
  | { readonly error: unknown; readonly status: "rejected" };

export type DriverInputSettlement =
  | { readonly status: "resolved" }
  | { readonly status: "cancelled" }
  | { readonly failure: unknown; readonly status: "failed" };

interface ActiveRun {
  readonly cancellation: AbortController;
  cancellationClaim: DriverRunSnapshot["cancellation"];
  readonly revision: number;
  readonly runId: RunId;
  terminal: DriverRunTerminalState | null;
}

interface ShutdownState {
  cleanup: "completed" | "pending";
  failure: {
    readonly error: RunError;
    readonly runId: RunId | null;
  } | null;
}

export interface DriverShutdownSnapshot {
  readonly cleanup: "completed" | "pending";
  readonly failure: { readonly error: RunError; readonly runId: RunId | null } | null;
}

export class DriverTerminalStateMachine {
  #activeRun: ActiveRun | null = null;
  #instanceTerminal: DriverInstanceTerminalState = { phase: "open" };
  #lastOwnedRunId: RunId | null = null;
  #lastRunTerminal: { readonly runId: RunId; readonly status: DriverRunTerminalStatus } | null =
    null;
  #revision = 0;
  #shutdown: ShutdownState | null = null;

  beginRun(runId: RunId): DriverRunTicket {
    if (this.#activeRun !== null) {
      throw new Error(`Driver run ${this.#activeRun.runId} is already active.`);
    }
    if (this.#instanceTerminal.phase !== "open") {
      throw new Error("Cannot begin a run after an instance terminal has been selected.");
    }

    const cancellation = new AbortController();
    const revision = ++this.#revision;
    this.#lastOwnedRunId = runId;
    this.#lastRunTerminal = null;
    this.#activeRun = {
      cancellation,
      cancellationClaim: null,
      revision,
      runId,
      terminal: null,
    };
    return { revision, runId, signal: cancellation.signal };
  }

  claimCancellation(
    ticket: DriverRunTicket,
    reason: string,
    source: DriverTurnCancellationSource = "turn.cancel",
  ): "already_claimed" | "claimed" | "terminal_selected" {
    const active = this.#requireRun(ticket);
    if (active.terminal !== null) {
      return "terminal_selected";
    }
    if (active.cancellationClaim !== null) {
      if (
        source !== "turn.cancel" &&
        active.cancellation.signal.reason instanceof DriverTurnCancelledError
      ) {
        active.cancellation.signal.reason.preventResume();
      }
      return "already_claimed";
    }

    active.cancellationClaim = { reason };
    active.cancellation.abort(new DriverTurnCancelledError(reason, source));
    return "claimed";
  }

  currentRunId(): RunId | null {
    return this.#activeRun?.runId ?? null;
  }

  selectRunTerminal(
    ticket: DriverRunTicket,
    terminal: DriverRunTerminalIdentity,
  ): "acked" | "cancelled" | "pending" | "selected" {
    const active = this.#requireRun(ticket);
    if (terminal.runId !== ticket.runId) {
      throw new Error("Driver run terminal must target the active run.");
    }
    if (terminal.sourceEventId.length === 0) {
      throw new Error("Driver run terminal source event ID must be non-empty.");
    }

    const selected = active.terminal;
    if (selected !== null) {
      if (!isDeepStrictEqual(selected.value, terminal)) {
        throw new Error("Driver run terminal conflicts with the selected terminal.");
      }
      return selected.phase === "acked" ? "acked" : "pending";
    }

    if (active.cancellationClaim !== null && terminal.status === "completed") {
      return "cancelled";
    }

    active.terminal = { phase: "selected", value: structuredClone(terminal) };
    return "selected";
  }

  ackRunTerminal(ticket: DriverRunTicket, receipt: DriverEventReceipt): void {
    const active = this.#requireRun(ticket);
    const terminal = active.terminal;
    if (terminal === null) {
      throw new Error("Driver run terminal has not been selected.");
    }
    if (receipt.eventId !== terminal.value.sourceEventId) {
      throw new Error("Driver run terminal receipt does not match the selected source event ID.");
    }
    if (terminal.phase === "acked") {
      if (!isDeepStrictEqual(terminal.receipt, receipt)) {
        throw new Error("Driver run terminal was acknowledged with a different receipt.");
      }
      return;
    }

    active.terminal = {
      phase: "acked",
      receipt: structuredClone(receipt),
      value: terminal.value,
    };
  }

  abandonRunTerminal(ticket: DriverRunTicket, terminal: DriverRunTerminalIdentity): void {
    const active = this.#requireRun(ticket);
    if (
      active.terminal?.phase !== "selected" ||
      !isDeepStrictEqual(active.terminal.value, terminal)
    ) {
      throw new Error("Only the exact unpublished driver run terminal can be abandoned.");
    }
    active.terminal = null;
  }

  acknowledgedRunTerminal(runId?: RunId): DriverRunTerminalStatus | null {
    const active = this.#activeRun;
    if (active?.terminal?.phase === "acked" && (runId === undefined || active.runId === runId)) {
      return active.terminal.value.status;
    }
    return this.#lastRunTerminal !== null &&
      (runId === undefined || this.#lastRunTerminal.runId === runId)
      ? this.#lastRunTerminal.status
      : null;
  }

  snapshotRun(runId?: RunId): DriverRunSnapshot | null {
    const active = this.#activeRun;
    if (active === null || (runId !== undefined && active.runId !== runId)) {
      return null;
    }

    return {
      cancellation: active.cancellationClaim,
      revision: active.revision,
      runId: active.runId,
      terminal: active.terminal,
    };
  }

  settleInput(ticket: DriverRunTicket, outcome: DriverInputOutcome): DriverInputSettlement {
    const active = this.#requireRun(ticket);
    const terminal = active.terminal;

    if (outcome.status === "rejected") {
      return { failure: outcome.error, status: "failed" };
    }
    if (terminal === null || terminal.phase === "selected") {
      return {
        failure: new Error(
          terminal === null
            ? "Driver input settled without a run terminal."
            : "Driver run terminal was selected but not acknowledged.",
        ),
        status: "failed",
      };
    }
    if (outcome.status === "cancelled") {
      if (terminal.value.status === "cancelled") {
        return { status: "cancelled" };
      }
      return {
        failure: new Error(
          `Driver cancellation settled with a ${terminal.value.status} run terminal.`,
        ),
        status: "failed",
      };
    }

    return terminal.value.status === "completed"
      ? { status: "resolved" }
      : {
          failure: new Error(
            `Driver input resolved after a ${terminal.value.status} run terminal.`,
          ),
          status: "failed",
        };
  }

  releaseRun(ticket: DriverRunTicket, reason: "command_acked" | "driver_failing"): void {
    const active = this.#requireRun(ticket);
    if (reason === "command_acked" && active.terminal?.phase !== "acked") {
      throw new Error("Cannot acknowledge a run without an acknowledged terminal.");
    }

    this.#lastRunTerminal =
      active.terminal?.phase === "acked"
        ? { runId: active.runId, status: active.terminal.value.status }
        : null;
    this.#lastOwnedRunId = ticket.runId;
    this.#activeRun = null;
  }

  requestShutdown(): void {
    this.#shutdown ??= { cleanup: "pending", failure: null };
  }

  recordFailure(error: RunError, runId = this.currentRunId()): void {
    this.requestShutdown();
    this.#shutdown!.failure ??= { error: structuredClone(error), runId };
  }

  markCleanupCompleted(): void {
    if (this.#shutdown === null) {
      throw new Error("Driver shutdown has not been requested.");
    }
    this.#shutdown.cleanup = "completed";
  }

  shutdownSnapshot(): DriverShutdownSnapshot | null {
    return this.#shutdown === null ? null : structuredClone(this.#shutdown);
  }

  selectInstanceTerminal(terminal: DriverInstanceTerminal): "acked" | "pending" | "selected" {
    const selected = this.#instanceTerminal;
    if (selected.phase !== "open") {
      if (!isDeepStrictEqual(selected.terminal, terminal)) {
        throw new Error("Driver instance terminal conflicts with the selected terminal.");
      }
      return selected.phase === "acked" ? "acked" : "pending";
    }

    const frozen = structuredClone(terminal);
    this.#instanceTerminal = { phase: "selected", terminal: frozen };
    return "selected";
  }

  ackInstanceTerminal(terminal: DriverInstanceTerminal): void {
    const selected = this.#instanceTerminal;
    if (selected.phase === "open") {
      throw new Error("Driver instance terminal has not been selected.");
    }
    if (!isDeepStrictEqual(selected.terminal, terminal)) {
      throw new Error("Driver instance terminal acknowledgement conflicts with its selection.");
    }
    this.#instanceTerminal = { phase: "acked", terminal: selected.terminal };
  }

  abandonInstanceTerminal(terminal: DriverInstanceTerminal): void {
    const selected = this.#instanceTerminal;
    if (selected.phase !== "selected" || !isDeepStrictEqual(selected.terminal, terminal)) {
      throw new Error("Only the exact unpublished driver instance terminal can be abandoned.");
    }
    this.#instanceTerminal = { phase: "open" };
  }

  snapshotInstance(): DriverInstanceTerminalState {
    return this.#instanceTerminal;
  }

  terminalRunId(fallback: RunId | null = null): RunId | null {
    const instanceTerminal = this.#instanceTerminal;
    if (instanceTerminal.phase !== "open") {
      return instanceTerminal.terminal.runId;
    }

    return (
      this.#shutdown?.failure?.runId ?? this.#activeRun?.runId ?? this.#lastOwnedRunId ?? fallback
    );
  }

  #requireRun(ticket: DriverRunTicket): ActiveRun {
    const active = this.#activeRun;
    if (
      active === null ||
      active.revision !== ticket.revision ||
      active.runId !== ticket.runId ||
      active.cancellation.signal !== ticket.signal
    ) {
      throw new Error("Driver run ticket is stale.");
    }
    return active;
  }
}
