import { isDeepStrictEqual } from "node:util";

import { assertProtocolAdmission, compareTimestamps, type ProtocolAdmissionLimits } from "./common";
import { contentExtensionNames, hasBlobRef } from "./content";
import type { Interaction, Item, Run, Session, SessionSnapshot } from "./state";
import { sessionSnapshotSchema } from "./state";
import { stateContent } from "./content-admission";
import {
  assertNotAfter,
  assertNotBefore,
  assertRetryTarget,
  assertStatusTransition,
  assertUnique,
  INTERACTION_STATUS_TRANSITIONS,
  invariant,
  isTerminalInteraction,
  isTerminalRun,
  ITEM_STATUS_TRANSITIONS,
  itemKey,
  RUN_STATUS_TRANSITIONS,
  SESSION_STATUS_TRANSITIONS,
} from "./invariant";

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

export function assertSessionTransition(previous: Session, next: Session): void {
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

export function putRun(runs: Run[], next: Run): void {
  const index = runs.findIndex((run) => run.id === next.id);
  const previous = index < 0 ? undefined : runs[index];
  assertRunTransition(previous, next);

  if (index < 0) {
    runs.push(next);
  } else {
    runs[index] = next;
  }
}

export function putItem(items: Item[], next: Item): void {
  const index = items.findIndex((item) => item.runId === next.runId && item.id === next.id);
  const previous = index < 0 ? undefined : items[index];
  assertItemTransition(previous, next);

  if (index < 0) {
    items.push(next);
  } else {
    items[index] = next;
  }
}

export function putInteraction(interactions: Interaction[], next: Interaction): void {
  const index = interactions.findIndex((interaction) => interaction.id === next.id);
  const previous = index < 0 ? undefined : interactions[index];
  assertInteractionTransition(previous, next);

  if (index < 0) {
    interactions.push(next);
  } else {
    interactions[index] = next;
  }
}

export function validateState(snapshot: SessionSnapshot): void {
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
