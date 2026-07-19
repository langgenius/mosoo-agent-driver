import {
  assertProtocolAdmission,
  compareTimestamps,
  timestampSchema,
  type ProtocolAdmissionLimits,
} from "./common";
import type { AuthorityOperation, ProposedMutation } from "./mutation";
import { proposedMutationSchema } from "./mutation";
import type { SessionSnapshot } from "./state";
import { interactionSchema, itemSchema, runSchema } from "./state";
import { authorityContent } from "./content-admission";
import { invariant, itemKey } from "./invariant";
import { validateSessionSnapshot } from "./state-validation";

function parseExecutorMutation(
  snapshot: SessionSnapshot,
  mutationValue: unknown,
  admissionLimits?: ProtocolAdmissionLimits,
): ProposedMutation {
  const mutation = proposedMutationSchema.parse(mutationValue);

  if (admissionLimits !== undefined) {
    assertProtocolAdmission(mutation, admissionLimits, authorityContent(mutation.operations));
  }

  invariant(
    "session_mismatch",
    mutation.sessionId === snapshot.session.id,
    "Mutation and Session identities do not match.",
  );
  invariant(
    "stale_revision",
    mutation.baseRevision === snapshot.revision,
    `Mutation base revision ${mutation.baseRevision} does not match ${snapshot.revision}.`,
  );
  const runs = new Set(snapshot.runs.map((run) => run.id));
  for (const operation of mutation.operations) {
    invariant(
      "unsupported",
      operation.op === "put",
      "Executor Mutations cannot remove authority state.",
    );

    switch (operation.entity) {
      case "session":
        invariant("unsupported", false, "Executor Mutations cannot modify the Session.");
      case "run":
        invariant(
          "unsupported",
          runs.has(operation.value.id) || operation.value.origin !== "user",
          "Only the Coordinator can create a user-originated Run.",
        );
        break;
      case "item":
        invariant(
          "unsupported",
          operation.value.kind !== "message" || operation.value.role !== "user",
          "Only the Coordinator can write a user Message Item.",
        );
        break;
      case "interaction":
        invariant(
          "unsupported",
          operation.value.status !== "resolved",
          "Only the Coordinator can resolve an Interaction.",
        );
        break;
    }
  }

  return mutation;
}

export function validateExecutorMutation(
  snapshotValue: unknown,
  mutationValue: unknown,
  admissionLimits?: ProtocolAdmissionLimits,
): ProposedMutation {
  return parseExecutorMutation(
    validateSessionSnapshot(snapshotValue),
    mutationValue,
    admissionLimits,
  );
}

export function normalizeExecutorMutation(
  snapshotValue: unknown,
  mutationValue: unknown,
  acceptedAtValue: string,
  maxInteractionTtlMs: number,
  admissionLimits?: ProtocolAdmissionLimits,
): ProposedMutation {
  const snapshot = validateSessionSnapshot(snapshotValue);
  const mutation = parseExecutorMutation(snapshot, mutationValue, admissionLimits);
  const acceptedAt = timestampSchema.parse(acceptedAtValue);

  if (!Number.isSafeInteger(maxInteractionTtlMs) || maxInteractionTtlMs < 1) {
    throw new RangeError("Interaction TTL limit must be finite and positive.");
  }

  invariant(
    "invalid_transition",
    compareTimestamps(acceptedAt, snapshot.capturedAt) >= 0,
    "Coordinator acceptance time cannot precede the current snapshot.",
  );
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  const items = new Map(snapshot.items.map((item) => [itemKey(item.runId, item.id), item]));
  const interactions = new Map(
    snapshot.interactions.map((interaction) => [interaction.id, interaction]),
  );
  const operations: AuthorityOperation[] = mutation.operations.map((operation) => {
    invariant(
      "unsupported",
      operation.op === "put",
      "Executor cannot normalize remove operations.",
    );

    switch (operation.entity) {
      case "session":
        invariant("unsupported", false, "Executor cannot normalize Session operations.");
      case "run": {
        const previous = runs.get(operation.value.id);
        const value = {
          ...operation.value,
          startedAt: previous?.startedAt ?? acceptedAt,
          ...(operation.value.status === "active" ? {} : { endedAt: acceptedAt }),
        };
        return { entity: "run", op: "put", value: runSchema.parse(value) };
      }
      case "item": {
        const previous = items.get(itemKey(operation.value.runId, operation.value.id));
        const value = {
          ...operation.value,
          createdAt: previous?.createdAt ?? acceptedAt,
          updatedAt: acceptedAt,
          ...(operation.value.status === "active"
            ? {}
            : {
                endedAt:
                  previous === undefined || previous.status === "active"
                    ? acceptedAt
                    : (previous.endedAt ?? acceptedAt),
              }),
        };
        return { entity: "item", op: "put", value: itemSchema.parse(value) };
      }
      case "interaction": {
        const previous = interactions.get(operation.value.id);
        let expiresAt = previous?.expiresAt;

        if (expiresAt === undefined) {
          const requestedTtlMs = Math.max(
            1,
            Date.parse(operation.value.expiresAt) - Date.parse(operation.value.createdAt),
          );
          invariant(
            "invalid_transition",
            Number.isSafeInteger(requestedTtlMs) &&
              compareTimestamps(operation.value.expiresAt, operation.value.createdAt) > 0,
            "Interaction requested TTL must be finite and positive.",
          );
          const deadline = new Date(
            Date.parse(acceptedAt) + Math.min(requestedTtlMs, maxInteractionTtlMs),
          );
          invariant(
            "invalid_transition",
            !Number.isNaN(deadline.getTime()),
            "Interaction deadline exceeds the supported timestamp range.",
          );
          expiresAt = deadline.toISOString();
        }

        const value = {
          ...operation.value,
          createdAt: previous?.createdAt ?? acceptedAt,
          expiresAt,
          ...(operation.value.status === "open" ? {} : { endedAt: acceptedAt }),
        };
        return {
          entity: "interaction",
          op: "put",
          value: interactionSchema.parse(value),
        };
      }
    }
  });

  const normalized = { ...mutation, operations };

  if (admissionLimits !== undefined) {
    assertProtocolAdmission(normalized, admissionLimits, authorityContent(operations));
  }

  return normalized;
}
