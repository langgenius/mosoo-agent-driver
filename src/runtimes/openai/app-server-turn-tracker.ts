import { createHash } from "node:crypto";

import type { DriverTurnCancelledError } from "../../core/driver-runtime-state";
import type { RunId } from "../../protocol/id";

interface ActiveOpenAiTurn {
  nativeTurnId: string;
  promise: Promise<void>;
  reject(error: Error): void;
  resolve(): void;
  runId: RunId;
}

type TerminalOpenAiTurn =
  | { kind: "completed" }
  | { error: DriverTurnCancelledError | Error; kind: "failed" };

const MAX_RETAINED_TURNS = 1_024;
const MAX_RETAINED_NATIVE_TURN_ID_BYTES = 256;

export function retainedOpenAiTurnKey(turnId: string): string {
  return Buffer.byteLength(turnId, "utf8") <= MAX_RETAINED_NATIVE_TURN_ID_BYTES
    ? turnId
    : `sha256:${createHash("sha256").update(turnId).digest("hex")}`;
}

function rememberBounded<T>(map: Map<string, T>, turnId: string, value: T): void {
  const key = retainedOpenAiTurnKey(turnId);
  map.delete(key);
  map.set(key, value);

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

    return this.#activeTurns.get(retainedOpenAiTurnKey(turnId))?.runId ?? null;
  }

  activeTurnIds(): string[] {
    return [...this.#activeTurns.values()].map(({ nativeTurnId }) => nativeTurnId);
  }

  clearActiveTurns(): void {
    this.#activeTurns.clear();
    this.#settlingTurnIds.clear();
    this.#startedTurnIds.clear();
    this.#terminalTurns.clear();
  }

  hasTerminal(turnId: string): boolean {
    const key = retainedOpenAiTurnKey(turnId);
    return this.#settlingTurnIds.has(key) || this.#terminalTurns.has(key);
  }

  markTurnStarted(turnId: string): boolean {
    if (this.#startedTurnIds.has(retainedOpenAiTurnKey(turnId)) || this.hasTerminal(turnId)) {
      return false;
    }

    rememberBounded(this.#startedTurnIds, turnId, true);
    return true;
  }

  hasTurnStarted(turnId: string): boolean {
    return this.#startedTurnIds.has(retainedOpenAiTurnKey(turnId));
  }

  rejectTurn(turnId: string, error: Error): boolean {
    return this.settle(turnId, { error, kind: "failed" });
  }

  rejectActiveTurns(error: Error): void {
    for (const turnId of this.activeTurnIds()) {
      this.#settlingTurnIds.delete(retainedOpenAiTurnKey(turnId));
      this.rejectTurn(turnId, error);
    }
  }

  beginSettlement(turnId: string): boolean {
    if (this.hasTerminal(turnId)) {
      return false;
    }

    this.#settlingTurnIds.add(retainedOpenAiTurnKey(turnId));
    return true;
  }

  cancelSettlement(turnId: string): void {
    this.#settlingTurnIds.delete(retainedOpenAiTurnKey(turnId));
  }

  finishSettlement(turnId: string, terminalTurn: TerminalOpenAiTurn): boolean {
    const key = retainedOpenAiTurnKey(turnId);
    if (!this.#settlingTurnIds.delete(key) || this.#terminalTurns.has(key)) {
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
    const key = retainedOpenAiTurnKey(turnId);
    this.#startedTurnIds.delete(key);
    rememberBounded(this.#terminalTurns, turnId, terminalTurn);
    const activeTurn = this.#activeTurns.get(key);

    if (activeTurn === undefined) {
      return;
    }

    if (terminalTurn.kind === "completed") {
      activeTurn.resolve();
    } else {
      activeTurn.reject(terminalTurn.error);
    }

    this.#activeTurns.delete(key);
  }

  async track(turnId: string, runId: RunId): Promise<void> {
    const key = retainedOpenAiTurnKey(turnId);
    const terminalTurn = this.#terminalTurns.get(key);

    if (terminalTurn?.kind === "completed") {
      return;
    }

    if (terminalTurn?.kind === "failed") {
      throw terminalTurn.error;
    }

    const activeTurn = this.#activeTurns.get(key);

    if (activeTurn !== undefined) {
      if (activeTurn.runId !== runId) {
        throw new Error("OpenAI turn is already tracked by another run.");
      }

      return activeTurn.promise;
    }

    const turn = Promise.withResolvers<void>();
    this.#activeTurns.set(key, {
      nativeTurnId: turnId,
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
