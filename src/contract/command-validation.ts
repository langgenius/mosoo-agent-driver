import type { Command, InputResolution } from "./command";
import { commandSchema } from "./command";
import {
  assertProtocolAdmission,
  compareTimestamps,
  timestampSchema,
  type Capabilities,
  type ProtocolAdmissionLimits,
} from "./common";
import { contentExtensionNames, hasBlobRef, type ContentBlock } from "./content";
import {
  ContractInvariantError,
  type ContractInvariantCode,
  validateSessionSnapshot,
} from "./reducer";
import type { ConfigOption, InputInteraction, Interaction } from "./state";

function invariant(
  code: ContractInvariantCode,
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new ContractInvariantError(code, message);
  }
}

function assertConfigValue(option: ConfigOption, value: unknown): void {
  switch (option.type) {
    case "boolean":
      invariant(
        "invalid_transition",
        typeof value === "boolean",
        `Config ${option.id} requires a boolean.`,
      );
      return;
    case "string":
      invariant(
        "invalid_transition",
        typeof value === "string",
        `Config ${option.id} requires a string.`,
      );
      return;
    case "number":
      invariant(
        "invalid_transition",
        typeof value === "number" &&
          Number.isFinite(value) &&
          (option.min === undefined || value >= option.min) &&
          (option.max === undefined || value <= option.max),
        `Config ${option.id} requires a number in its declared range.`,
      );
      return;
    case "select":
      invariant(
        "invalid_reference",
        typeof value === "string" && option.choices.some((choice) => choice.id === value),
        `Config ${option.id} requires an advertised choice.`,
      );
  }
}

function assertInputResolution(interaction: InputInteraction, resolution: InputResolution): void {
  if (resolution.type === "cancelled") {
    return;
  }

  const answers = resolution.answers;
  const questions = new Map(
    interaction.request.questions.map((question) => [question.id, question]),
  );

  for (const questionId of Object.keys(answers)) {
    invariant(
      "invalid_reference",
      questions.has(questionId),
      `Input answer references unknown question ${questionId}.`,
    );
  }

  for (const question of interaction.request.questions) {
    const values = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;

    if (values === undefined) {
      invariant(
        "invalid_transition",
        !question.required,
        `Input answer is missing required question ${question.id}.`,
      );
      continue;
    }

    if (question.type === "multi_select") {
      invariant(
        "invalid_transition",
        new Set(values).size === values.length,
        `Input answer for ${question.id} contains duplicate choices.`,
      );
    } else {
      invariant(
        "invalid_transition",
        values.length === 1,
        `Input answer for ${question.id} requires exactly one value.`,
      );
    }

    if (question.type === "confirm") {
      invariant(
        "invalid_transition",
        values[0] === "true" || values[0] === "false",
        `Input answer for ${question.id} must be true or false.`,
      );
    }

    if (question.type === "single_select" || question.type === "multi_select") {
      const optionIds = new Set(question.options.map((option) => option.id));
      invariant(
        "invalid_reference",
        values.every((value) => question.allowOther === true || optionIds.has(value)),
        `Input answer for ${question.id} contains an unknown choice.`,
      );
    }
  }
}

function assertResolution(interaction: Interaction, command: Command): void {
  invariant(
    "invalid_transition",
    command.kind === "interaction.resolve",
    "Expected an Interaction resolution Command.",
  );
  invariant(
    "invalid_transition",
    command.resolution.kind === interaction.kind,
    "Interaction resolution kind does not match the request.",
  );

  switch (interaction.kind) {
    case "permission": {
      invariant(
        "invalid_transition",
        command.resolution.kind === "permission",
        "Expected a permission resolution.",
      );
      const resolution = command.resolution.value;

      if (resolution.type === "selected") {
        invariant(
          "invalid_reference",
          interaction.request.options.some((option) => option.id === resolution.optionId),
          "Permission resolution selected an unknown option.",
        );
      }
      return;
    }
    case "input":
      invariant(
        "invalid_transition",
        command.resolution.kind === "input",
        "Expected an input resolution.",
      );
      assertInputResolution(interaction, command.resolution.value);
      return;
    case "tool":
      invariant(
        "invalid_transition",
        command.resolution.kind === "tool",
        "Expected a tool resolution.",
      );
      return;
    case "extension":
      invariant(
        "invalid_transition",
        command.resolution.kind === "extension" && command.resolution.name === interaction.name,
        "Extension resolution name does not match the request.",
      );
  }
}

function commandContent(command: Command): readonly ContentBlock[] {
  if (command.kind === "run.start" || command.kind === "run.steer") {
    return command.input;
  }

  return command.kind === "interaction.resolve" &&
    command.resolution.kind === "tool" &&
    command.resolution.value.type === "completed"
    ? command.resolution.value.output
    : [];
}

function assertContentCapabilities(
  blocks: readonly ContentBlock[],
  capabilities: Capabilities,
): void {
  for (const name of contentExtensionNames(blocks)) {
    invariant(
      "unsupported",
      capabilities[name] !== undefined,
      `Content extension ${name} was not negotiated.`,
    );
  }
}

export function validateCommand(
  snapshotValue: unknown,
  commandValue: unknown,
  nowValue: string,
  admissionLimits?: ProtocolAdmissionLimits,
): Command {
  const snapshot = validateSessionSnapshot(snapshotValue);
  const command = commandSchema.parse(commandValue);
  const now = timestampSchema.parse(nowValue);
  const content = commandContent(command);

  if (admissionLimits !== undefined) {
    assertProtocolAdmission(command, admissionLimits, content);
  }

  invariant(
    "session_mismatch",
    command.sessionId === snapshot.session.id,
    "Command and Session identities do not match.",
  );
  invariant(
    "stale_revision",
    command.expectedRevision === undefined || command.expectedRevision === snapshot.revision,
    `Command expected revision ${command.expectedRevision}, but current revision is ${snapshot.revision}.`,
  );
  invariant(
    "invalid_transition",
    compareTimestamps(now, snapshot.capturedAt) >= 0,
    "Command acceptance time cannot precede the current snapshot.",
  );
  invariant(
    "unsupported",
    !hasBlobRef(content) || snapshot.session.capabilities["blob"] !== undefined,
    "Blob references require the blob capability.",
  );
  assertContentCapabilities(content, snapshot.session.capabilities);

  if (command.kind === "session.close") {
    return command;
  }

  if (snapshot.session.status === "closed" && command.kind === "run.cancel") {
    const run = snapshot.runs.find((candidate) => candidate.id === command.runId);
    invariant("invalid_reference", run !== undefined, `Run ${command.runId} does not exist.`);
    invariant("invalid_transition", run.status !== "active", "Closed Session has an active Run.");
    return command;
  }

  invariant("invalid_transition", snapshot.session.status === "open", "Session is closed.");

  switch (command.kind) {
    case "run.start": {
      invariant(
        "invalid_reference",
        !snapshot.runs.some((run) => run.id === command.runId),
        `Run ${command.runId} already exists.`,
      );

      if (command.parentRunId === undefined) {
        invariant(
          "invalid_transition",
          !snapshot.runs.some((run) => run.status === "active" && run.parentRunId === undefined),
          "Session already has an active top-level Run.",
        );
      } else {
        invariant(
          "unsupported",
          snapshot.session.capabilities["run.child"] !== undefined,
          "Session does not support child Runs.",
        );
        const parent = snapshot.runs.find((run) => run.id === command.parentRunId);
        invariant("invalid_reference", parent !== undefined, "Parent Run does not exist.");
        invariant("invalid_transition", parent.status === "active", "Parent Run is not active.");
      }

      if (command.retryOf !== undefined) {
        const previous = snapshot.runs.find((run) => run.id === command.retryOf);
        invariant("invalid_reference", previous !== undefined, "Retry target does not exist.");
        invariant(
          "invalid_transition",
          previous.status !== "active",
          "Retry target is not terminal.",
        );
      }
      return command;
    }
    case "run.steer": {
      const run = snapshot.runs.find((candidate) => candidate.id === command.runId);
      invariant("invalid_reference", run !== undefined, `Run ${command.runId} does not exist.`);
      invariant(
        "invalid_transition",
        run.status === "active" && run.parentRunId === undefined,
        "Only the active top-level Run can be steered.",
      );
      invariant(
        "unsupported",
        snapshot.session.capabilities["run.steer"] !== undefined,
        "Session does not support steering.",
      );
      invariant(
        "duplicate_entity",
        !snapshot.items.some(
          (item) => item.runId === command.runId && item.id === command.commandId,
        ),
        `Steer Item ${command.commandId} already exists.`,
      );
      return command;
    }
    case "run.cancel": {
      const run = snapshot.runs.find((candidate) => candidate.id === command.runId);
      invariant("invalid_reference", run !== undefined, `Run ${command.runId} does not exist.`);
      return command;
    }
    case "session.configure": {
      const active = snapshot.runs.some(
        (run) => run.status === "active" && run.parentRunId === undefined,
      );
      const capability = snapshot.session.capabilities["session.configure"];
      invariant("unsupported", capability !== undefined, "Session does not support configuration.");
      invariant(
        "unsupported",
        !active || capability?.["whileRunning"] === true,
        "Session configuration cannot change while a Run is active.",
      );

      for (const change of command.changes) {
        const option = snapshot.session.config.find(
          (candidate) => candidate.id === change.configId,
        );
        invariant(
          "invalid_reference",
          option !== undefined,
          `Config ${change.configId} does not exist.`,
        );
        assertConfigValue(option, change.value);
      }
      return command;
    }
    case "interaction.resolve": {
      const interaction = snapshot.interactions.find(
        (candidate) => candidate.id === command.interactionId,
      );
      invariant(
        "invalid_reference",
        interaction !== undefined,
        `Interaction ${command.interactionId} does not exist.`,
      );
      invariant("invalid_transition", interaction.status === "open", "Interaction is terminal.");
      invariant(
        "invalid_transition",
        compareTimestamps(now, interaction.expiresAt) < 0,
        "Interaction has expired.",
      );
      assertResolution(interaction, command);
      return command;
    }
  }
}
