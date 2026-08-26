import type { CommittedMutation } from "./mutation";
import { committedMutationSchema } from "./mutation";
import { PROTOCOL_VERSION, assertProtocolAdmission, compareTimestamps } from "./common";
import type { SyncPayload } from "./sync";
import { syncPayloadSchema } from "./sync";
import type { SessionSnapshot } from "./state";
import { authorityContent } from "./content-admission";
import {
  assertNotBefore,
  assertRetryTarget,
  assertUnique,
  invariant,
  isTerminalRun,
  itemKey,
} from "./invariant";
import {
  assertSessionTransition,
  putInteraction,
  putItem,
  putRun,
  validateSessionSnapshot,
  validateState,
} from "./state-validation";

export { authorityContent } from "./content-admission";
export { normalizeExecutorMutation, validateExecutorMutation } from "./executor-mutation";
export { ContractInvariantError, type ContractInvariantCode } from "./invariant";
export { validatePreviewBatch } from "./preview-validation";
export { validateSessionSnapshot } from "./state-validation";

function applyMutation(current: SessionSnapshot, mutation: CommittedMutation): SessionSnapshot {
  invariant(
    "session_mismatch",
    mutation.sessionId === current.session.id,
    "Mutation and Session identities do not match.",
  );

  if (mutation.revision <= current.revision) {
    return current;
  }

  invariant(
    "revision_gap",
    mutation.baseRevision === current.revision && mutation.revision === current.revision + 1,
    `Expected mutation revision ${current.revision + 1}.`,
  );
  assertNotBefore(mutation.committedAt, current.capturedAt, "Mutation committedAt");
  const removesRuns = mutation.operations.some((operation) => operation.op === "remove");
  invariant(
    "invalid_transition",
    !removesRuns || mutation.operations.every((operation) => operation.op === "remove"),
    "A compaction Mutation cannot mix remove and put operations.",
  );
  const operationKeys = mutation.operations.map((operation) => {
    if (operation.op === "remove") {
      return `run:${operation.id}`;
    }

    switch (operation.entity) {
      case "session":
        return `session:${operation.value.id}`;
      case "run":
        return `run:${operation.value.id}`;
      case "item":
        return `item:${itemKey(operation.value.runId, operation.value.id)}`;
      case "interaction":
        return `interaction:${operation.value.id}`;
    }
  });
  assertUnique(operationKeys, "Mutation operation target");
  const existingRunIds = new Set(current.runs.map((run) => run.id));
  const writableRunIds = new Set(
    current.runs.filter((run) => run.status === "active").map((run) => run.id),
  );
  for (const operation of mutation.operations) {
    if (
      operation.op === "put" &&
      operation.entity === "run" &&
      !existingRunIds.has(operation.value.id)
    ) {
      writableRunIds.add(operation.value.id);
    }
  }

  for (const operation of mutation.operations) {
    if (operation.op !== "put" || operation.entity !== "item") {
      continue;
    }

    const item = operation.value;
    invariant(
      "invalid_transition",
      writableRunIds.has(item.runId),
      `Item ${item.id} requires a Run that was active before the Mutation.`,
    );
  }

  const newRetries = mutation.operations.flatMap((operation) =>
    operation.op === "put" &&
    operation.entity === "run" &&
    !existingRunIds.has(operation.value.id) &&
    operation.value.retryOf !== undefined
      ? [operation.value]
      : [],
  );

  let session = current.session;
  let runs = [...current.runs];
  let items = [...current.items];
  let interactions = [...current.interactions];

  for (const operation of mutation.operations) {
    if (operation.op === "put") {
      switch (operation.entity) {
        case "session":
          assertSessionTransition(session, operation.value);
          session = operation.value;
          break;
        case "run":
          putRun(runs, operation.value);
          break;
        case "item":
          putItem(items, operation.value);
          break;
        case "interaction":
          putInteraction(interactions, operation.value);
          break;
      }
      continue;
    }

    const root = runs.find((run) => run.id === operation.id);
    invariant("invalid_reference", root !== undefined, `Run ${operation.id} does not exist.`);
    const removedRunIds = new Set([root.id]);
    let added = true;

    while (added) {
      added = false;

      for (const run of runs) {
        if (
          run.parentRunId !== undefined &&
          removedRunIds.has(run.parentRunId) &&
          !removedRunIds.has(run.id)
        ) {
          removedRunIds.add(run.id);
          added = true;
        }
      }
    }

    invariant(
      "invalid_transition",
      runs.filter((run) => removedRunIds.has(run.id)).every(isTerminalRun),
      "An active Run tree cannot be removed.",
    );

    runs = runs.filter((run) => !removedRunIds.has(run.id));
    items = items.filter((item) => !removedRunIds.has(item.runId));
    interactions = interactions.filter((interaction) => !removedRunIds.has(interaction.runId));
  }

  for (const run of newRetries) {
    assertRetryTarget(
      run,
      runs.find((candidate) => candidate.id === run.retryOf),
      true,
    );
  }

  const next: SessionSnapshot = {
    protocolVersion: PROTOCOL_VERSION,
    revision: mutation.revision,
    capturedAt: mutation.committedAt,
    session,
    runs,
    items,
    interactions,
  };
  validateState(next);
  return next;
}

export function applyCommittedMutation(
  currentValue: SessionSnapshot,
  mutationValue: CommittedMutation,
): SessionSnapshot {
  return applyMutation(
    validateSessionSnapshot(currentValue),
    committedMutationSchema.parse(mutationValue),
  );
}

export interface SyncAdmissionLimits {
  readonly maxInlineBytes: number;
  readonly maxMutationBatchCount: number;
  readonly maxMutationBytes: number;
  readonly maxSnapshotBytes: number;
}

export function applySyncPayload(
  currentValue: SessionSnapshot | undefined,
  payloadValue: SyncPayload,
  admissionLimits?: SyncAdmissionLimits,
): SessionSnapshot {
  const payload = syncPayloadSchema.parse(payloadValue);
  const current = currentValue === undefined ? undefined : validateSessionSnapshot(currentValue);

  if (
    admissionLimits !== undefined &&
    Object.values(admissionLimits).some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new RangeError("Sync admission limits must be positive safe integers.");
  }

  if (payload.type === "snapshot") {
    const next = validateSessionSnapshot(
      payload.snapshot,
      admissionLimits === undefined
        ? undefined
        : {
            maxBytes: admissionLimits.maxSnapshotBytes,
            maxInlineBytes: admissionLimits.maxInlineBytes,
          },
    );

    if (current !== undefined) {
      invariant(
        "session_mismatch",
        current.session.id === next.session.id,
        "Snapshot and Session identities do not match.",
      );

      if (
        next.revision < current.revision ||
        (next.revision === current.revision &&
          compareTimestamps(next.capturedAt, current.capturedAt) < 0)
      ) {
        return current;
      }

      assertNotBefore(next.capturedAt, current.capturedAt, "Snapshot capturedAt");
    }

    return next;
  }

  if (admissionLimits !== undefined) {
    if (payload.mutations.length > admissionLimits.maxMutationBatchCount) {
      throw new RangeError("Sync mutation count exceeds its admission limit.");
    }

    for (const mutation of payload.mutations) {
      assertProtocolAdmission(
        mutation,
        {
          maxBytes: admissionLimits.maxMutationBytes,
          maxInlineBytes: admissionLimits.maxInlineBytes,
        },
        authorityContent(mutation.operations),
      );
    }
  }

  invariant(
    "revision_gap",
    current !== undefined && payload.baseRevision <= current.revision,
    `Mutation sync requires base revision ${payload.baseRevision}.`,
  );

  const sessionId = payload.mutations[0]?.sessionId;

  invariant(
    "session_mismatch",
    sessionId === undefined || sessionId === current.session.id,
    "Mutation sync and Session identities do not match.",
  );

  if (payload.throughRevision <= current.revision) {
    return current;
  }

  return payload.mutations
    .filter((mutation) => mutation.revision > current.revision)
    .reduce(applyMutation, current);
}

export type SessionActivity = "closed" | "idle" | "requires_action" | "running";

export function deriveSessionActivity(snapshotValue: SessionSnapshot): SessionActivity {
  const snapshot = validateSessionSnapshot(snapshotValue);

  if (snapshot.session.status === "closed") {
    return "closed";
  }

  if (
    snapshot.interactions.some(
      (interaction) => interaction.status === "open" && interaction.blocking,
    )
  ) {
    return "requires_action";
  }

  if (snapshot.runs.some((run) => run.status === "active" && run.parentRunId === undefined)) {
    return "running";
  }

  return "idle";
}
