import { isDeepStrictEqual } from "node:util";

import type { AuthorityOperation, CommittedMutation, ProposedMutation } from "./mutation";
import { committedMutationSchema, proposedMutationSchema } from "./mutation";
import {
  assertProtocolAdmission,
  compareTimestamps,
  timestampSchema,
  type ProtocolAdmissionLimits,
} from "./common";
import { contentExtensionNames, hasBlobRef, type ContentBlock } from "./content";
import type { PreviewBatch } from "./preview";
import { previewBatchSchema } from "./preview";
import type { SyncPayload } from "./sync";
import { syncPayloadSchema } from "./sync";
import type { Interaction, Item, Run, Session, SessionSnapshot } from "./state";
import { interactionSchema, itemSchema, runSchema, sessionSnapshotSchema } from "./state";

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

function invariant(
  code: ContractInvariantCode,
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new ContractInvariantError(code, message);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  invariant(
    "duplicate_entity",
    new Set(values).size === values.length,
    `${label} identities must be unique.`,
  );
}

function itemKey(runId: string, itemId: string): string {
  return `${runId}\u0000${itemId}`;
}

function assertNotBefore(value: string | undefined, lowerBound: string, label: string): void {
  invariant(
    "invalid_transition",
    value === undefined || compareTimestamps(value, lowerBound) >= 0,
    `${label} cannot be earlier than ${lowerBound}.`,
  );
}

function assertNotAfter(value: string | undefined, upperBound: string, label: string): void {
  invariant(
    "invalid_transition",
    value === undefined || compareTimestamps(value, upperBound) <= 0,
    `${label} cannot be later than ${upperBound}.`,
  );
}

type StatusTransitionTable<Status extends string> = {
  readonly [Current in Status]: readonly Status[];
};

const SESSION_STATUS_TRANSITIONS = {
  closed: [],
  open: ["open", "closed"],
} as const satisfies StatusTransitionTable<Session["status"]>;

const RUN_STATUS_TRANSITIONS = {
  active: ["active", "completed", "failed", "cancelled"],
  cancelled: [],
  completed: [],
  failed: [],
} as const satisfies StatusTransitionTable<Run["status"]>;

const ITEM_STATUS_TRANSITIONS = {
  active: ["active", "completed", "failed", "cancelled"],
  cancelled: [],
  completed: [],
  failed: [],
} as const satisfies StatusTransitionTable<Item["status"]>;

const INTERACTION_STATUS_TRANSITIONS = {
  expired: [],
  open: ["open", "resolved", "expired"],
  resolved: [],
} as const satisfies StatusTransitionTable<Interaction["status"]>;

function assertStatusTransition<Status extends string>(
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

function isTerminalRun(run: Run) {
  return run.status !== "active";
}

function isTerminalInteraction(
  interaction: Interaction,
): interaction is Interaction & { status: "resolved" | "expired"; endedAt: string } {
  return interaction.status !== "open" && interaction.endedAt !== undefined;
}

function assertRetryTarget(run: Run, previousAttempt: Run | undefined, required: boolean): void {
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

function itemContent(item: Item): readonly ContentBlock[] {
  switch (item.kind) {
    case "message":
    case "reasoning":
    case "artifact":
      return item.content;
    case "tool":
      return item.output ?? [];
    case "terminal":
      return [...item.stdout, ...item.stderr];
    case "change":
      return item.changes.flatMap((change) => (change.diff === undefined ? [] : [change.diff]));
    case "extension":
    case "plan":
      return [];
  }
}

function interactionContent(interaction: Interaction): readonly ContentBlock[] {
  return interaction.kind === "tool" && interaction.resolution?.type === "completed"
    ? interaction.resolution.output
    : [];
}

function stateContent(
  runs: readonly Run[],
  items: readonly Item[],
  interactions: readonly Interaction[],
): ContentBlock[] {
  return [
    ...runs.flatMap((run) => run.input),
    ...items.flatMap(itemContent),
    ...interactions.flatMap(interactionContent),
  ];
}

function operationContent(
  operation: ProposedMutation["operations"][number],
): readonly ContentBlock[] {
  if (operation.op !== "put") {
    return [];
  }

  switch (operation.entity) {
    case "run":
      return operation.value.input;
    case "item":
      return itemContent(operation.value);
    case "interaction":
      return interactionContent(operation.value);
    case "session":
      return [];
  }
}

export function authorityContent(operations: readonly AuthorityOperation[]): ContentBlock[] {
  return operations.flatMap(operationContent);
}

function assertAcyclicRunRelation(
  runs: readonly Run[],
  runsById: ReadonlyMap<string, Run>,
  relation: "parentRunId" | "retryOf",
  label: string,
): void {
  const complete = new Set<string>();

  for (const root of runs) {
    if (complete.has(root.id)) {
      continue;
    }

    const path: string[] = [];
    const visiting = new Set<string>();
    let current: Run | undefined = root;

    while (current !== undefined && !complete.has(current.id)) {
      invariant(
        "invalid_transition",
        !visiting.has(current.id),
        `Run ${root.id} has a cyclic ${label} chain.`,
      );
      visiting.add(current.id);
      path.push(current.id);
      const nextId: string | undefined = current[relation];
      current = nextId === undefined ? undefined : runsById.get(nextId);
    }

    for (const id of path) {
      complete.add(id);
    }
  }
}

function assertConfig(session: Session): void {
  assertUnique(
    session.config.map((option) => option.id),
    "Config option",
  );

  for (const option of session.config) {
    if (option.type === "select") {
      assertUnique(
        option.choices.map((choice) => choice.id),
        `Choices for config option ${option.id}`,
      );
      invariant(
        "invalid_reference",
        option.choices.some((choice) => choice.id === option.value),
        `Config option ${option.id} selects an unknown choice.`,
      );
    }

    if (option.type === "number") {
      invariant(
        "invalid_transition",
        option.min === undefined || option.max === undefined || option.min <= option.max,
        `Config option ${option.id} has an inverted range.`,
      );
      invariant(
        "invalid_transition",
        option.min === undefined || option.value >= option.min,
        `Config option ${option.id} is below its minimum.`,
      );
      invariant(
        "invalid_transition",
        option.max === undefined || option.value <= option.max,
        `Config option ${option.id} is above its maximum.`,
      );
    }
  }
}

function assertSessionTransition(previous: Session, next: Session): void {
  invariant("immutable_entity", previous.id === next.id, "Session identity cannot change.");
  invariant(
    "immutable_entity",
    previous.createdAt === next.createdAt && isDeepStrictEqual(previous.parent, next.parent),
    "Session origin fields cannot change.",
  );
  assertNotBefore(next.updatedAt, previous.updatedAt, "Session updatedAt");
  invariant(
    "immutable_entity",
    Object.entries(previous.capabilities).every(([name, detail]) =>
      isDeepStrictEqual(detail, next.capabilities[name]),
    ),
    "Advertised Session capabilities cannot be removed or changed.",
  );
  assertStatusTransition(
    previous.status,
    next.status,
    SESSION_STATUS_TRANSITIONS,
    "Session status",
  );
}

function assertRunTransition(previous: Run | undefined, next: Run): void {
  if (previous === undefined) {
    invariant("invalid_transition", next.status === "active", "A Run must start active.");
    return;
  }

  invariant("immutable_entity", previous.id === next.id, "Run identity cannot change.");
  invariant(
    "immutable_entity",
    previous.startedAt === next.startedAt &&
      previous.origin === next.origin &&
      previous.parentRunId === next.parentRunId &&
      previous.retryOf === next.retryOf &&
      isDeepStrictEqual(previous.input, next.input),
    "Run origin fields cannot change.",
  );

  for (const key of ["cachedInput", "input", "output", "reasoning", "total"] as const) {
    const prior = previous.usage?.[key];

    if (prior === undefined) {
      continue;
    }

    invariant(
      "invalid_transition",
      next.usage?.[key] !== undefined && next.usage[key] >= prior,
      `Run usage ${key} cannot be removed or decrease.`,
    );
  }

  if (previous.usage?.cost !== undefined) {
    invariant(
      "invalid_transition",
      next.usage?.cost !== undefined &&
        next.usage.cost.currency === previous.usage.cost.currency &&
        next.usage.cost.amount >= previous.usage.cost.amount,
      "Run usage cost cannot be removed, change currency, or decrease.",
    );
  }

  assertStatusTransition(previous.status, next.status, RUN_STATUS_TRANSITIONS, "Run status");
}

function assertItemTransition(previous: Item | undefined, next: Item): void {
  if (previous === undefined) {
    if (next.status !== "active") {
      assertNotBefore(next.endedAt, next.updatedAt, `Item ${next.id} endedAt`);
    }
    return;
  }

  invariant(
    "immutable_entity",
    previous.id === next.id &&
      previous.runId === next.runId &&
      previous.kind === next.kind &&
      previous.createdAt === next.createdAt &&
      previous.audience === next.audience &&
      (previous.kind !== "message" || (next.kind === "message" && previous.role === next.role)) &&
      (previous.kind !== "tool" || (next.kind === "tool" && previous.origin === next.origin)) &&
      (previous.kind !== "extension" || (next.kind === "extension" && previous.name === next.name)),
    "Item identity fields cannot change.",
  );
  assertNotBefore(next.updatedAt, previous.updatedAt, `Item ${next.id} updatedAt`);

  if (previous.status !== "active") {
    invariant(
      "invalid_transition",
      next.status === previous.status,
      `Item status cannot transition from ${previous.status} to ${next.status}.`,
    );
    invariant(
      "immutable_entity",
      previous.endedAt === next.endedAt && isDeepStrictEqual(previous.error, next.error),
      `Item ${next.id} terminal outcome fields cannot change.`,
    );
    assertNotBefore(
      next.updatedAt,
      previous.endedAt ?? previous.updatedAt,
      `Item ${next.id} updatedAt`,
    );
    const {
      provenance: _previousProvenance,
      updatedAt: _previousUpdatedAt,
      ...previousContent
    } = previous;
    const { provenance: _nextProvenance, updatedAt: _nextUpdatedAt, ...nextContent } = next;
    invariant(
      "invalid_transition",
      !isDeepStrictEqual(previousContent, nextContent),
      `Terminal Item ${next.id} Upsert must enrich content.`,
    );
    return;
  }

  assertStatusTransition(previous.status, next.status, ITEM_STATUS_TRANSITIONS, "Item status");

  if (next.status !== "active") {
    assertNotBefore(next.endedAt, next.updatedAt, `Item ${next.id} endedAt`);
  }
}

function assertInteractionContent(interaction: Interaction): void {
  if (interaction.kind === "permission") {
    assertUnique(
      interaction.request.options.map((option) => option.id),
      `Permission options for Interaction ${interaction.id}`,
    );

    if (interaction.request.subject.type === "resource") {
      assertUnique(
        interaction.request.subject.targets,
        `Permission targets for Interaction ${interaction.id}`,
      );
    }

    if (interaction.status === "resolved") {
      const resolution = interaction.resolution;
      invariant(
        "invalid_transition",
        resolution !== undefined,
        "A resolved permission Interaction requires a resolution.",
      );

      if (resolution.type === "selected") {
        invariant(
          "invalid_reference",
          interaction.request.options.some((option) => option.id === resolution.optionId),
          "A permission resolution must select an advertised option.",
        );
      }
    }
  }

  if (interaction.kind !== "input") {
    return;
  }

  assertUnique(
    interaction.request.questions.map((question) => question.id),
    `Questions for Interaction ${interaction.id}`,
  );

  for (const question of interaction.request.questions) {
    if (question.type === "single_select" || question.type === "multi_select") {
      assertUnique(
        question.options.map((option) => option.id),
        `Options for question ${question.id}`,
      );
    }
  }

  if (interaction.status === "resolved" && interaction.resolution?.type === "answered") {
    const answered = interaction.resolution.answeredQuestionIds;
    assertUnique(answered, "Answered question");
    invariant(
      "invalid_reference",
      answered.every((id) => interaction.request.questions.some((question) => question.id === id)),
      "An input resolution references an unknown question.",
    );
    invariant(
      "invalid_transition",
      interaction.request.questions
        .filter((question) => question.required)
        .every((question) => answered.includes(question.id)),
      "An input resolution must answer every required question.",
    );
  }
}

function assertInteractionTransition(previous: Interaction | undefined, next: Interaction): void {
  assertInteractionContent(next);

  if (previous === undefined) {
    invariant("invalid_transition", next.status === "open", "An Interaction must start open.");
    return;
  }

  invariant(
    "immutable_entity",
    previous.id === next.id &&
      previous.runId === next.runId &&
      previous.itemId === next.itemId &&
      previous.kind === next.kind &&
      previous.createdAt === next.createdAt &&
      previous.blocking === next.blocking &&
      previous.audience === next.audience &&
      isDeepStrictEqual(previous.request, next.request),
    "Interaction identity fields cannot change.",
  );
  invariant(
    "immutable_entity",
    previous.kind !== "extension" || next.kind !== "extension" || previous.name === next.name,
    "Extension Interaction name cannot change.",
  );
  invariant(
    "immutable_entity",
    next.expiresAt === previous.expiresAt,
    "Interaction expiration cannot change.",
  );
  assertStatusTransition(
    previous.status,
    next.status,
    INTERACTION_STATUS_TRANSITIONS,
    "Interaction status",
  );
}

function putRun(runs: Run[], next: Run): void {
  const index = runs.findIndex((run) => run.id === next.id);
  const previous = index < 0 ? undefined : runs[index];
  assertRunTransition(previous, next);

  if (index < 0) {
    runs.push(next);
  } else {
    runs[index] = next;
  }
}

function putItem(items: Item[], next: Item): void {
  const index = items.findIndex((item) => item.runId === next.runId && item.id === next.id);
  const previous = index < 0 ? undefined : items[index];
  assertItemTransition(previous, next);

  if (index < 0) {
    items.push(next);
  } else {
    items[index] = next;
  }
}

function putInteraction(interactions: Interaction[], next: Interaction): void {
  const index = interactions.findIndex((interaction) => interaction.id === next.id);
  const previous = index < 0 ? undefined : interactions[index];
  assertInteractionTransition(previous, next);

  if (index < 0) {
    interactions.push(next);
  } else {
    interactions[index] = next;
  }
}

function validateState(snapshot: SessionSnapshot): void {
  const { capturedAt, session, runs, items, interactions } = snapshot;
  assertConfig(session);
  assertNotBefore(session.updatedAt, session.createdAt, "Session updatedAt");
  assertNotBefore(session.closedAt, session.createdAt, "Session closedAt");
  assertNotBefore(session.closedAt, session.updatedAt, "Session closedAt");
  assertNotAfter(session.createdAt, capturedAt, "Session createdAt");
  assertNotAfter(session.updatedAt, capturedAt, "Session updatedAt");
  assertNotAfter(session.closedAt, capturedAt, "Session closedAt");
  invariant(
    "invalid_transition",
    (session.status === "closed") === (session.closedAt !== undefined),
    "closedAt must be present exactly when a Session is closed.",
  );
  invariant(
    "invalid_reference",
    session.parent?.sessionId !== session.id,
    "A Session cannot name itself as its parent.",
  );
  assertUnique(
    runs.map((run) => run.id),
    "Run",
  );
  assertUnique(
    items.map((item) => itemKey(item.runId, item.id)),
    "Item",
  );
  assertUnique(
    interactions.map((interaction) => interaction.id),
    "Interaction",
  );
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const itemsById = new Map(items.map((item) => [itemKey(item.runId, item.id), item]));
  const content = stateContent(runs, items, interactions);
  invariant(
    "unsupported",
    !hasBlobRef(content) || session.capabilities["blob"] !== undefined,
    "Blob references require the blob capability.",
  );

  for (const name of contentExtensionNames(content)) {
    invariant(
      "unsupported",
      session.capabilities[name] !== undefined,
      `Content extension ${name} was not negotiated.`,
    );
  }

  const activeTopLevelRuns = runs.filter(
    (run) => run.status === "active" && run.parentRunId === undefined,
  );
  invariant(
    "invalid_transition",
    activeTopLevelRuns.length <= 1,
    "A Session may have at most one active top-level Run.",
  );

  for (const run of runs) {
    assertNotBefore(run.startedAt, session.createdAt, `Run ${run.id} startedAt`);
    assertNotAfter(run.startedAt, capturedAt, `Run ${run.id} startedAt`);
    assertNotBefore(
      "endedAt" in run ? run.endedAt : undefined,
      run.startedAt,
      `Run ${run.id} endedAt`,
    );
    assertNotAfter("endedAt" in run ? run.endedAt : undefined, capturedAt, `Run ${run.id} endedAt`);
    invariant(
      "invalid_transition",
      run.origin !== "user" || run.input.length > 0,
      `User-originated Run ${run.id} requires input.`,
    );
    invariant(
      "unsupported",
      run.origin !== "agent" || session.capabilities["run.agent_initiated"] !== undefined,
      `Agent-initiated Run ${run.id} was not negotiated.`,
    );

    if (run.parentRunId !== undefined) {
      invariant(
        "unsupported",
        session.capabilities["run.child"] !== undefined,
        `Child Run ${run.id} was not negotiated.`,
      );
      const parent = runsById.get(run.parentRunId);
      invariant("invalid_reference", parent !== undefined, `Run ${run.id} has no parent.`);
      assertNotBefore(run.startedAt, parent.startedAt, `Run ${run.id} startedAt`);
      invariant(
        "invalid_transition",
        run.status !== "active" || parent.status === "active",
        `Active child Run ${run.id} requires an active parent.`,
      );

      if (isTerminalRun(run) && isTerminalRun(parent)) {
        assertNotBefore(parent.endedAt, run.endedAt, `Parent Run ${parent.id} endedAt`);
      }
    }

    if (run.retryOf !== undefined) {
      assertRetryTarget(run, runsById.get(run.retryOf), false);
    }
  }

  assertAcyclicRunRelation(runs, runsById, "parentRunId", "parent");
  assertAcyclicRunRelation(runs, runsById, "retryOf", "retry");

  for (const item of items) {
    assertNotBefore(item.updatedAt, item.createdAt, `Item ${item.id} updatedAt`);
    assertNotBefore(item.endedAt, item.createdAt, `Item ${item.id} endedAt`);
    assertNotAfter(item.createdAt, capturedAt, `Item ${item.id} createdAt`);
    assertNotAfter(item.updatedAt, capturedAt, `Item ${item.id} updatedAt`);
    assertNotAfter(item.endedAt, capturedAt, `Item ${item.id} endedAt`);
    const run = runsById.get(item.runId);
    invariant("invalid_reference", run !== undefined, `Item ${item.id} has no Run.`);
    assertNotBefore(item.createdAt, run.startedAt, `Item ${item.id} createdAt`);
    invariant(
      "invalid_transition",
      item.status !== "active" || run.status === "active",
      `Active Item ${item.id} requires an active Run.`,
    );

    if (isTerminalRun(run)) {
      assertNotBefore(run.endedAt, item.updatedAt, `Run ${run.id} endedAt`);
      if (item.endedAt !== undefined) {
        assertNotBefore(run.endedAt, item.endedAt, `Run ${run.id} endedAt`);
      }
    }

    const requiredCapability =
      item.kind === "extension"
        ? item.name
        : item.kind === "artifact" ||
            item.kind === "change" ||
            item.kind === "plan" ||
            item.kind === "reasoning" ||
            item.kind === "terminal"
          ? `item.${item.kind}`
          : undefined;
    invariant(
      "unsupported",
      requiredCapability === undefined || session.capabilities[requiredCapability] !== undefined,
      `Item capability ${requiredCapability} was not negotiated.`,
    );

    if (item.kind === "message") {
      invariant(
        "invalid_transition",
        item.role === "agent" || item.phase === undefined,
        `User message Item ${item.id} cannot declare an Agent output phase.`,
      );
    }

    if (item.kind === "plan") {
      assertUnique(
        item.entries.flatMap((entry) => (entry.id === undefined ? [] : [entry.id])),
        `Plan entry for Item ${item.id}`,
      );
    }

    if (item.kind === "tool" && item.terminalItemId !== undefined) {
      invariant(
        "invalid_reference",
        itemsById.get(itemKey(item.runId, item.terminalItemId))?.kind === "terminal",
        `Tool Item ${item.id} references an unknown terminal Item.`,
      );
    }
  }

  for (const interaction of interactions) {
    assertInteractionContent(interaction);
    const requiredCapability =
      interaction.kind === "extension" ? interaction.name : `interaction.${interaction.kind}`;
    invariant(
      "unsupported",
      session.capabilities[requiredCapability] !== undefined,
      `Interaction capability ${requiredCapability} was not negotiated.`,
    );
    invariant(
      "invalid_transition",
      compareTimestamps(interaction.expiresAt, interaction.createdAt) > 0,
      `Interaction ${interaction.id} expiresAt must be later than createdAt.`,
    );
    invariant(
      "invalid_transition",
      interaction.status !== "open" || compareTimestamps(interaction.expiresAt, capturedAt) > 0,
      `Open Interaction ${interaction.id} must expire after capturedAt.`,
    );
    assertNotBefore(
      interaction.endedAt,
      interaction.createdAt,
      `Interaction ${interaction.id} endedAt`,
    );
    assertNotAfter(interaction.createdAt, capturedAt, `Interaction ${interaction.id} createdAt`);
    assertNotAfter(interaction.endedAt, capturedAt, `Interaction ${interaction.id} endedAt`);
    if (interaction.status === "resolved") {
      invariant(
        "invalid_transition",
        interaction.endedAt !== undefined &&
          compareTimestamps(interaction.endedAt, interaction.expiresAt) < 0,
        `Interaction ${interaction.id} must resolve before expiresAt.`,
      );
    }

    const run = runsById.get(interaction.runId);
    invariant("invalid_reference", run !== undefined, `Interaction ${interaction.id} has no Run.`);
    assertNotBefore(
      interaction.createdAt,
      run.startedAt,
      `Interaction ${interaction.id} createdAt`,
    );
    invariant(
      "invalid_transition",
      interaction.status !== "open" || run.status === "active",
      `Open Interaction ${interaction.id} requires an active Run.`,
    );

    if (isTerminalRun(run)) {
      assertNotBefore(
        run.endedAt,
        interaction.endedAt ?? interaction.createdAt,
        `Run ${run.id} endedAt`,
      );
    }

    if (interaction.itemId !== undefined) {
      invariant(
        "invalid_reference",
        itemsById.has(itemKey(interaction.runId, interaction.itemId)),
        `Interaction ${interaction.id} references an unknown Item.`,
      );
    }

    if (interaction.kind === "permission" && interaction.request.subject.type === "item") {
      invariant(
        "invalid_reference",
        itemsById.has(itemKey(interaction.runId, interaction.request.subject.itemId)),
        `Permission Interaction ${interaction.id} references an unknown subject Item.`,
      );
    }

    if (interaction.kind === "permission" && interaction.request.subject.type === "extension") {
      invariant(
        "unsupported",
        session.capabilities[interaction.request.subject.name] !== undefined,
        `Permission subject ${interaction.request.subject.name} was not negotiated.`,
      );
    }
  }

  if (session.status === "closed") {
    invariant(
      "invalid_transition",
      runs.every(isTerminalRun) && interactions.every(isTerminalInteraction),
      "A closed Session cannot retain active Runs or open Interactions.",
    );
    const closedAt = session.closedAt;
    invariant("invalid_transition", closedAt !== undefined, "A closed Session requires closedAt.");

    for (const run of runs) {
      if (isTerminalRun(run)) {
        assertNotBefore(closedAt, run.endedAt, "Session closedAt");
      }
    }

    for (const item of items) {
      assertNotBefore(closedAt, item.endedAt ?? item.updatedAt, "Session closedAt");
    }

    for (const interaction of interactions) {
      if (isTerminalInteraction(interaction)) {
        assertNotBefore(closedAt, interaction.endedAt, "Session closedAt");
      }
    }
  }
}

export function validateSessionSnapshot(
  value: unknown,
  admissionLimits?: ProtocolAdmissionLimits,
): SessionSnapshot {
  const snapshot = sessionSnapshotSchema.parse(value);

  if (admissionLimits !== undefined) {
    assertProtocolAdmission(
      snapshot,
      admissionLimits,
      stateContent(snapshot.runs, snapshot.items, snapshot.interactions),
    );
  }

  validateState(snapshot);
  return snapshot;
}

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
    protocolVersion: 2,
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

function previewItemKind(
  channel: PreviewBatch["updates"][number]["channel"],
): Item["kind"] | undefined {
  switch (channel) {
    case "message.text":
      return "message";
    case "reasoning.text":
      return "reasoning";
    case "terminal.stderr":
    case "terminal.stdout":
      return "terminal";
    case "tool.progress":
      return "tool";
    default:
      return undefined;
  }
}

export function validatePreviewBatch(
  snapshotValue: SessionSnapshot,
  batchValue: PreviewBatch,
  admissionLimits?: ProtocolAdmissionLimits,
): PreviewBatch {
  const snapshot = validateSessionSnapshot(snapshotValue);
  const batch = previewBatchSchema.parse(batchValue);

  if (admissionLimits !== undefined) {
    assertProtocolAdmission(batch, admissionLimits, []);
  }

  invariant(
    "session_mismatch",
    batch.sessionId === snapshot.session.id,
    "Preview batch and Session identities do not match.",
  );
  const run = snapshot.runs.find((candidate) => candidate.id === batch.runId);
  invariant("invalid_reference", run !== undefined, `Preview Run ${batch.runId} does not exist.`);
  invariant("invalid_transition", run.status === "active", "Preview requires an active Run.");
  const items = new Map(snapshot.items.map((item) => [itemKey(item.runId, item.id), item]));

  for (const update of batch.updates) {
    const item = items.get(itemKey(batch.runId, update.itemId));
    invariant(
      "invalid_reference",
      item !== undefined,
      `Preview Item ${update.itemId} does not exist in Run ${batch.runId}.`,
    );
    invariant("invalid_transition", item.status === "active", "Preview requires an active Item.");
    const expectedKind = previewItemKind(update.channel);
    invariant(
      "unsupported",
      expectedKind !== undefined || snapshot.session.capabilities[update.channel] !== undefined,
      `Preview channel ${update.channel} was not negotiated.`,
    );
    invariant(
      "invalid_reference",
      expectedKind === undefined || item.kind === expectedKind,
      `Preview channel ${update.channel} cannot target an Item of kind ${item.kind}.`,
    );
  }

  return batch;
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
