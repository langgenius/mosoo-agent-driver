export class DriverTurnCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DriverTurnCancelledError";
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
