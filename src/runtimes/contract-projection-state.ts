import { isDeepStrictEqual } from "node:util";

import { runSchema } from "../contract";
import type { AuthorityOperation, Interaction, Item, Run } from "../contract";
import { itemKey, latestTimestamp } from "./contract-projection-preview";

export interface ContractProjectionStateCallbacks {
  readonly activeItem: (item: Item) => void;
  readonly clearItem: (runId: string, itemId: string) => void;
  readonly releaseRun: (runId: string) => void;
}

export class ContractProjectionState {
  readonly #childEndedAt = new Map<string, string>();
  readonly #interactions = new Map<string, Interaction>();
  readonly #items = new Map<string, Item>();
  readonly #runs = new Map<string, Run>();

  run(runId: string): Run | undefined {
    return this.#runs.get(runId);
  }

  item(runId: string, id: string): Item | undefined {
    return this.#items.get(itemKey(runId, id));
  }

  interaction(id: string): Interaction | undefined {
    return this.#interactions.get(id);
  }

  releaseInteraction(id: string): void {
    this.#interactions.delete(id);
  }

  items(runId: string): Item[] {
    return [...this.#items.values()].filter((item) => item.runId === runId);
  }

  interactions(runId: string): Interaction[] {
    return [...this.#interactions.values()].filter((interaction) => interaction.runId === runId);
  }

  attachRun(value: Run): void {
    const run = runSchema.parse(value);

    if (run.status !== "active") {
      throw new Error(`Contract projection can only attach an active run ${run.id}.`);
    }

    const existing = this.#runs.get(run.id);

    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, run)) {
        throw new Error(
          `Contract projection run ${run.id} is already attached with different state.`,
        );
      }

      return;
    }

    this.#runs.set(run.id, run);
  }

  latestChildEnd(runId: string): string | undefined {
    return this.#childEndedAt.get(runId);
  }

  requireRun(runId: string): Run {
    const run = this.#runs.get(runId);

    if (run === undefined) {
      throw new Error(`Contract projection references unknown run ${runId}.`);
    }

    return run;
  }

  apply(
    operations: readonly AuthorityOperation[],
    callbacks: ContractProjectionStateCallbacks,
  ): void {
    const terminalRuns: string[] = [];

    for (const operation of operations) {
      if (operation.op === "remove") {
        terminalRuns.push(operation.id);
        continue;
      }

      switch (operation.entity) {
        case "session":
          break;
        case "run":
          this.#runs.set(operation.value.id, operation.value);
          if (operation.value.status !== "active") {
            terminalRuns.push(operation.value.id);
          }
          break;
        case "item": {
          const item = operation.value;
          this.#items.set(itemKey(item.runId, item.id), item);
          if (item.status === "active") {
            callbacks.activeItem(item);
          } else {
            callbacks.clearItem(item.runId, item.id);
          }
          break;
        }
        case "interaction":
          this.#interactions.set(operation.value.id, operation.value);
          break;
      }
    }

    for (const runId of terminalRuns) {
      this.#releaseRun(runId);
      callbacks.releaseRun(runId);
    }
  }

  clear(): void {
    this.#childEndedAt.clear();
    this.#interactions.clear();
    this.#items.clear();
    this.#runs.clear();
  }

  #releaseRun(runId: string): void {
    const run = this.#runs.get(runId);

    if (run !== undefined && run.status !== "active" && run.parentRunId !== undefined) {
      const parent = this.#runs.get(run.parentRunId);

      if (parent?.status === "active") {
        const previous = this.#childEndedAt.get(parent.id);
        this.#childEndedAt.set(
          parent.id,
          previous === undefined ? run.endedAt : latestTimestamp(previous, run.endedAt),
        );
      }
    }

    this.#childEndedAt.delete(runId);
    this.#runs.delete(runId);

    for (const key of this.#items.keys()) {
      if (key.startsWith(`${runId}\u0000`)) {
        this.#items.delete(key);
      }
    }

    for (const [id, interaction] of this.#interactions) {
      if (interaction.runId === runId) {
        this.#interactions.delete(id);
      }
    }
  }
}
