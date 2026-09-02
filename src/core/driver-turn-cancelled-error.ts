export type DriverTurnCancellationSource = "session.stop" | "shutdown" | "turn.cancel";

export class DriverTurnCancelledError extends Error {
  readonly #resumeCancellation = new AbortController();
  readonly resumeSignal = this.#resumeCancellation.signal;

  get resumeAllowed(): boolean {
    return !this.resumeSignal.aborted;
  }

  constructor(reason: string, source: DriverTurnCancellationSource = "turn.cancel") {
    super(reason);
    this.name = "DriverTurnCancelledError";
    if (source !== "turn.cancel") {
      this.#resumeCancellation.abort();
    }
  }

  preventResume(): void {
    this.#resumeCancellation.abort();
  }
}

export class DriverTurnCancellationCleanupError extends Error {
  override readonly name = "DriverTurnCancellationCleanupError";

  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

export function isDriverTurnCancelledError(error: unknown): error is DriverTurnCancelledError {
  return error instanceof DriverTurnCancelledError;
}
