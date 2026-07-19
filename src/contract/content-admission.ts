import type { AuthorityOperation, ProposedMutation } from "./mutation";
import type { ContentBlock } from "./content";
import type { Interaction, Item, Run } from "./state";

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

export function stateContent(
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
