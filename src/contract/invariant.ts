import { compareTimestamps } from "./common";
import type { Interaction, Item, Run, Session } from "./state";

export type ContractInvariantCode =
  | "duplicate_entity"
  | "immutable_entity"
  | "invalid_reference"
  | "invalid_transition"
  | "revision_gap"
  | "session_mismatch"
  | "stale_revision"
  | "unsupported";

export class ContractInvariantError extends Error {
  readonly code: ContractInvariantCode;

  constructor(code: ContractInvariantCode, message: string) {
    super(message);
    this.name = "ContractInvariantError";
    this.code = code;
  }
}

export function invariant(
  code: ContractInvariantCode,
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new ContractInvariantError(code, message);
  }
}

export function assertUnique(values: readonly string[], label: string): void {
  invariant(
    "duplicate_entity",
    new Set(values).size === values.length,
    `${label} identities must be unique.`,
  );
}

export function itemKey(runId: string, itemId: string): string {
  return `${runId}\u0000${itemId}`;
}

export function assertNotBefore(
  value: string | undefined,
  lowerBound: string,
  label: string,
): void {
  invariant(
    "invalid_transition",
    value === undefined || compareTimestamps(value, lowerBound) >= 0,
    `${label} cannot be earlier than ${lowerBound}.`,
  );
}

export function assertNotAfter(value: string | undefined, upperBound: string, label: string): void {
  invariant(
    "invalid_transition",
    value === undefined || compareTimestamps(value, upperBound) <= 0,
    `${label} cannot be later than ${upperBound}.`,
  );
}

export type StatusTransitionTable<Status extends string> = {
  readonly [Current in Status]: readonly Status[];
};

export const SESSION_STATUS_TRANSITIONS = {
  closed: [],
  open: ["open", "closed"],
} as const satisfies StatusTransitionTable<Session["status"]>;

export const RUN_STATUS_TRANSITIONS = {
  active: ["active", "completed", "failed", "cancelled"],
  cancelled: [],
  completed: [],
  failed: [],
} as const satisfies StatusTransitionTable<Run["status"]>;

export const ITEM_STATUS_TRANSITIONS = {
  active: ["active", "completed", "failed", "cancelled"],
  cancelled: [],
  completed: [],
  failed: [],
} as const satisfies StatusTransitionTable<Item["status"]>;

export const INTERACTION_STATUS_TRANSITIONS = {
  expired: [],
  open: ["open", "resolved", "expired"],
  resolved: [],
} as const satisfies StatusTransitionTable<Interaction["status"]>;

export function assertStatusTransition<Status extends string>(
  previous: Status,
  next: Status,
  transitions: StatusTransitionTable<Status>,
  label: string,
): void {
  invariant(
    "invalid_transition",
    transitions[previous].includes(next),
    `${label} cannot transition from ${previous} to ${next}.`,
  );
}

export function isTerminalRun(run: Run) {
  return run.status !== "active";
}

export function isTerminalInteraction(
  interaction: Interaction,
): interaction is Interaction & { status: "resolved" | "expired"; endedAt: string } {
  return interaction.status !== "open" && interaction.endedAt !== undefined;
}

export function assertRetryTarget(
  run: Run,
  previousAttempt: Run | undefined,
  required: boolean,
): void {
  invariant(
    "invalid_reference",
    !required || previousAttempt !== undefined,
    `Run ${run.id} has no retry target.`,
  );

  if (previousAttempt === undefined) {
    return;
  }

  invariant(
    "invalid_transition",
    isTerminalRun(previousAttempt),
    `Run ${run.id} can only retry a terminal Run.`,
  );
  assertNotBefore(run.startedAt, previousAttempt.endedAt, `Run ${run.id} startedAt`);
}
