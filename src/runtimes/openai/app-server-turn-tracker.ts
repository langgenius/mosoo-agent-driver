import type { DriverTurnCancelledError } from "../../core/driver-runtime-state";
import type { RunId } from "../../protocol/id";

interface ActiveOpenAiTurn {
  promise: Promise<void>;
  reject(error: Error): void;
  resolve(): void;
  runId: RunId;
}

type TerminalOpenAiTurn =
  | { kind: "completed" }
  | { error: DriverTurnCancelledError | Error; kind: "failed" };

const MAX_RETAINED_TURNS = 1_024;

function rememberBounded<T>(map: Map<string, T>, turnId: string, value: T): void {
  map.delete(turnId);
  map.set(turnId, value);

  if (map.size > MAX_RETAINED_TURNS) {
    const oldest = map.keys().next().value;

    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
}

export class OpenAiTurnTracker {
  readonly #activeTurns = new Map<string, ActiveOpenAiTurn>();
  readonly #settlingTurnIds = new Set<string>();
  readonly #terminalTurns = new Map<string, TerminalOpenAiTurn>();
  readonly #startedTurnIds = new Map<string, true>();

  activeRunId(turnId: string): RunId | null {
    if (this.hasTerminal(turnId)) {
      return null;
    }

    return this.#activeTurns.get(turnId)?.runId ?? null;
  }

  activeCompletion(turnId: string): Promise<void> | null {
    return this.#activeTurns.get(turnId)?.promise ?? null;
  }

  activeTurnIds(): string[] {
    return [...this.#activeTurns.keys()];
  }

  clearActiveTurns(): void {
    this.#activeTurns.clear();
    this.#settlingTurnIds.clear();
    this.#startedTurnIds.clear();
    this.#terminalTurns.clear();
  }

  hasTerminal(turnId: string): boolean {
    return this.#settlingTurnIds.has(turnId) || this.#terminalTurns.has(turnId);
  }

  markTurnStarted(turnId: string): boolean {
    if (this.#startedTurnIds.has(turnId) || this.hasTerminal(turnId)) {
      return false;
    }

    rememberBounded(this.#startedTurnIds, turnId, true);
    return true;
  }

  rejectTurn(turnId: string, error: Error): boolean {
    return this.settle(turnId, { error, kind: "failed" });
  }

  rejectActiveTurns(error: Error): void {
    for (const turnId of this.activeTurnIds()) {
      this.#settlingTurnIds.delete(turnId);
      this.rejectTurn(turnId, error);
    }
  }

  beginSettlement(turnId: string): boolean {
    if (this.hasTerminal(turnId)) {
      return false;
    }

    this.#settlingTurnIds.add(turnId);
    return true;
  }

  cancelSettlement(turnId: string): void {
    this.#settlingTurnIds.delete(turnId);
  }

  finishSettlement(turnId: string, terminalTurn: TerminalOpenAiTurn): boolean {
    if (!this.#settlingTurnIds.delete(turnId) || this.#terminalTurns.has(turnId)) {
      return false;
    }

    this.#recordTerminal(turnId, terminalTurn);
    return true;
  }

  settle(turnId: string, terminalTurn: TerminalOpenAiTurn): boolean {
    if (this.hasTerminal(turnId)) {
      return false;
    }

    this.#recordTerminal(turnId, terminalTurn);
    return true;
  }

  #recordTerminal(turnId: string, terminalTurn: TerminalOpenAiTurn): void {
    this.#startedTurnIds.delete(turnId);
    rememberBounded(this.#terminalTurns, turnId, terminalTurn);
    const activeTurn = this.#activeTurns.get(turnId);

    if (activeTurn === undefined) {
      return;
    }

    if (terminalTurn.kind === "completed") {
      activeTurn.resolve();
    } else {
      activeTurn.reject(terminalTurn.error);
    }

    this.#activeTurns.delete(turnId);
  }

  async track(turnId: string, runId: RunId): Promise<void> {
    const terminalTurn = this.#terminalTurns.get(turnId);

    if (terminalTurn?.kind === "completed") {
      return;
    }

    if (terminalTurn?.kind === "failed") {
      throw terminalTurn.error;
    }

    const activeTurn = this.#activeTurns.get(turnId);

    if (activeTurn !== undefined) {
      if (activeTurn.runId !== runId) {
        throw new Error(`Turn ${turnId} is already tracked by another run.`);
      }

      return activeTurn.promise;
    }

    const turn = Promise.withResolvers<void>();
    this.#activeTurns.set(turnId, {
      promise: turn.promise,
      reject: turn.reject,
      resolve: () => {
        turn.resolve();
      },
      runId,
    });
    return turn.promise;
  }
}
