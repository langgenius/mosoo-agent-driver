import { createHash } from "node:crypto";

import type { DriverTurnCancelledError } from "../../core/driver-runtime-state";
import type { RunId } from "../../protocol/id";

interface ActiveOpenAiTurn {
  cancellationSignal: AbortSignal | null;
  completionClosuresCommitted: boolean;
  nativeTurnId: string;
  promise: Promise<void>;
  reject(error: Error): void;
  resolve(): void;
  runId: RunId;
}

type OpenAiTurnTerminalOutcome =
  | { kind: "completed" }
  | { error: DriverTurnCancelledError | Error; kind: "failed" };

type TerminalOpenAiTurn = OpenAiTurnTerminalOutcome & { runId: RunId | null };

export interface OpenAiTurnAdmission {
  readonly token: symbol;
}

interface PendingOpenAiTurn {
  readonly admission: OpenAiTurnAdmission;
  armed: boolean;
  readonly boundTurnId: Promise<string | null>;
  readonly cancellationSignal: AbortSignal | null;
  completionClosuresCommitted: boolean;
  nativeTurnId: string | null;
  readonly resolveBoundTurnId: (turnId: string | null) => void;
  readonly runId: RunId;
  selectionReleased: boolean;
}

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
  readonly #ignoredTurnIds = new Map<string, true>();
  #pendingRootTurn: PendingOpenAiTurn | null = null;
  #rootAdmissionsEnforced = false;
  readonly #settlingTurnIds = new Set<string>();
  readonly #terminalTurns = new Map<string, TerminalOpenAiTurn>();
  readonly #startedTurnIds = new Map<string, true>();

  activeRunId(turnId: string): RunId | null {
    if (this.hasTerminal(turnId)) {
      return null;
    }

    return this.#activeTurns.get(retainedOpenAiTurnKey(turnId))?.runId ?? null;
  }

  admitRootTurn(runId: RunId, signal?: AbortSignal): OpenAiTurnAdmission {
    if (this.#pendingRootTurn !== null) {
      throw new Error("OpenAI root turn admission is already pending.");
    }

    this.#rootAdmissionsEnforced = true;
    const admission = { token: Symbol("openai-root-turn") };
    const boundTurnId = Promise.withResolvers<string | null>();
    this.#pendingRootTurn = {
      admission,
      armed: false,
      boundTurnId: boundTurnId.promise,
      cancellationSignal: signal ?? null,
      completionClosuresCommitted: false,
      nativeTurnId: null,
      resolveBoundTurnId: boundTurnId.resolve,
      runId,
      selectionReleased: false,
    };
    return admission;
  }

  armRootTurn(admission: OpenAiTurnAdmission): void {
    const pending = this.#pendingRootTurn;
    if (pending?.admission !== admission || pending.selectionReleased) {
      throw new Error("OpenAI root turn admission is no longer active.");
    }
    pending.armed = true;
  }

  bindRootTurn(admission: OpenAiTurnAdmission, turnId: string): void {
    const pending = this.#pendingRootTurn;
    if (pending?.admission !== admission) {
      throw new Error("OpenAI root turn admission is no longer active.");
    }
    if (!pending.armed || pending.selectionReleased) {
      throw new Error("OpenAI root turn admission is not awaiting a response.");
    }
    if (pending.nativeTurnId !== null && pending.nativeTurnId !== turnId) {
      throw new Error("OpenAI root turn admission received a different native turn.");
    }
    if (pending.nativeTurnId === turnId) {
      return;
    }

    pending.nativeTurnId = turnId;
    this.#ignoredTurnIds.delete(retainedOpenAiTurnKey(turnId));
    pending.resolveBoundTurnId(turnId);
  }

  async awaitRootTurnAdmission(turnId: string): Promise<boolean> {
    const pending = this.#pendingRootTurn;
    if (pending === null) {
      return !this.#ignoredTurnIds.has(retainedOpenAiTurnKey(turnId));
    }
    if (!pending.armed) {
      rememberBounded(this.#ignoredTurnIds, turnId, true);
      return false;
    }

    const boundTurnId = await pending.boundTurnId;
    if (boundTurnId === null) {
      return false;
    }
    if (boundTurnId === turnId) {
      return true;
    }
    rememberBounded(this.#ignoredTurnIds, turnId, true);
    return false;
  }

  pendingTurnContext(
    turnId: string,
  ): { cancellationSignal: AbortSignal | null; runId: RunId } | null {
    const pending = this.#pendingRootTurn;
    return pending?.nativeTurnId === turnId
      ? { cancellationSignal: pending.cancellationSignal, runId: pending.runId }
      : null;
  }

  hasPendingRootTurn(): boolean {
    return this.#pendingRootTurn !== null;
  }

  admittedTurnId(admission: OpenAiTurnAdmission): string | null {
    const pending = this.#pendingRootTurn;
    return pending?.admission === admission ? pending.nativeTurnId : null;
  }

  hasAdmittedTerminalTurn(): boolean {
    const turnId = this.#pendingRootTurn?.nativeTurnId;
    return turnId !== null && turnId !== undefined && this.hasTerminal(turnId);
  }

  acceptsRootTurn(turnId: string): boolean {
    if (!this.#rootAdmissionsEnforced) {
      return true;
    }

    const key = retainedOpenAiTurnKey(turnId);
    return (
      this.#pendingRootTurn?.nativeTurnId === turnId ||
      this.#activeTurns.has(key) ||
      this.#settlingTurnIds.has(key) ||
      this.#terminalTurns.has(key)
    );
  }

  claimRootTurn(
    admission: OpenAiTurnAdmission,
    turnId: string,
    runId: RunId,
    signal?: AbortSignal,
  ): Promise<void> {
    const pending = this.#pendingRootTurn;
    if (pending?.admission !== admission) {
      throw new Error("OpenAI root turn admission is no longer active.");
    }
    if (pending.runId !== runId || pending.cancellationSignal !== (signal ?? null)) {
      throw new Error("OpenAI root turn admission context changed before its response.");
    }
    if (pending.nativeTurnId !== turnId) {
      throw new Error("OpenAI turn/start response was not bound to its admission.");
    }

    this.#pendingRootTurn = null;
    const tracked = this.#track(turnId, runId, signal);
    const activeTurn = this.#activeTurns.get(retainedOpenAiTurnKey(turnId));
    if (activeTurn !== undefined) {
      activeTurn.completionClosuresCommitted = pending.completionClosuresCommitted;
    }
    return tracked;
  }

  releaseRootTurn(admission: OpenAiTurnAdmission): void {
    const pending = this.#pendingRootTurn;
    if (pending?.admission === admission) {
      pending.resolveBoundTurnId(null);
      this.#pendingRootTurn = null;
    }
  }

  releaseRootTurnSelection(admission: OpenAiTurnAdmission): void {
    const pending = this.#pendingRootTurn;
    if (
      pending?.admission === admission &&
      pending.nativeTurnId === null &&
      !pending.selectionReleased
    ) {
      pending.selectionReleased = true;
      pending.resolveBoundTurnId(null);
    }
  }

  cancellationSignal(turnId: string): AbortSignal | null {
    return this.#activeTurns.get(retainedOpenAiTurnKey(turnId))?.cancellationSignal ?? null;
  }

  completionClosuresCommitted(turnId: string): boolean {
    return (
      this.#activeTurns.get(retainedOpenAiTurnKey(turnId))?.completionClosuresCommitted ??
      (this.#pendingRootTurn?.nativeTurnId === turnId
        ? this.#pendingRootTurn.completionClosuresCommitted
        : false)
    );
  }

  markCompletionClosuresCommitted(turnId: string): void {
    const turn = this.#activeTurns.get(retainedOpenAiTurnKey(turnId));
    if (turn !== undefined) {
      turn.completionClosuresCommitted = true;
      return;
    }
    if (this.#pendingRootTurn?.nativeTurnId === turnId) {
      this.#pendingRootTurn.completionClosuresCommitted = true;
    }
  }

  activeTurnIds(): string[] {
    return [...this.#activeTurns.values()].map(({ nativeTurnId }) => nativeTurnId);
  }

  clearActiveTurns(): void {
    this.#pendingRootTurn?.resolveBoundTurnId(null);
    this.#pendingRootTurn = null;
    this.#activeTurns.clear();
    this.#ignoredTurnIds.clear();
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

  finishSettlement(turnId: string, terminalTurn: OpenAiTurnTerminalOutcome): boolean {
    const key = retainedOpenAiTurnKey(turnId);
    if (!this.#settlingTurnIds.delete(key) || this.#terminalTurns.has(key)) {
      return false;
    }

    this.#recordTerminal(turnId, terminalTurn);
    return true;
  }

  settle(turnId: string, terminalTurn: OpenAiTurnTerminalOutcome): boolean {
    if (this.hasTerminal(turnId)) {
      return false;
    }

    this.#recordTerminal(turnId, terminalTurn);
    return true;
  }

  #recordTerminal(turnId: string, terminalTurn: OpenAiTurnTerminalOutcome): void {
    const key = retainedOpenAiTurnKey(turnId);
    this.#startedTurnIds.delete(key);
    const activeTurn = this.#activeTurns.get(key);
    rememberBounded(this.#terminalTurns, turnId, {
      ...terminalTurn,
      runId: activeTurn?.runId ?? this.pendingTurnContext(turnId)?.runId ?? null,
    });

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

  track(turnId: string, runId: RunId, signal?: AbortSignal): Promise<void> {
    try {
      return this.#track(turnId, runId, signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #track(turnId: string, runId: RunId, signal?: AbortSignal): Promise<void> {
    const key = retainedOpenAiTurnKey(turnId);
    const terminalTurn = this.#terminalTurns.get(key);

    if (terminalTurn?.kind === "completed") {
      if (terminalTurn.runId !== null && terminalTurn.runId !== runId) {
        throw new Error("OpenAI terminal turn belongs to another run.");
      }
      return Promise.resolve();
    }

    if (terminalTurn?.kind === "failed") {
      if (terminalTurn.runId !== null && terminalTurn.runId !== runId) {
        throw new Error("OpenAI terminal turn belongs to another run.");
      }
      return Promise.reject(terminalTurn.error);
    }

    const activeTurn = this.#activeTurns.get(key);

    if (activeTurn !== undefined) {
      if (activeTurn.runId !== runId) {
        throw new Error("OpenAI turn is already tracked by another run.");
      }
      if (activeTurn.cancellationSignal !== (signal ?? null)) {
        throw new Error("OpenAI turn cancellation signal changed while it was active.");
      }

      return activeTurn.promise;
    }

    const turn = Promise.withResolvers<void>();
    this.#activeTurns.set(key, {
      cancellationSignal: signal ?? null,
      completionClosuresCommitted: false,
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
