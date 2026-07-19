import { isDeepStrictEqual } from "node:util";

import {
  assertProtocolAdmission,
  AuthorityOutcomeUnknownError,
  authorityContent,
} from "../contract";
import type { AuthorityOperation, MutationCause, ProtocolAdmissionLimits } from "../contract";
import { createDriverId } from "../protocol/id";

export const MAX_PENDING_MUTATION_BYTES = 32 * 1_024 * 1_024;
export const MAX_PENDING_MUTATIONS = 1_024;

export interface ContractAuthorityUpdate {
  readonly cause: MutationCause;
  readonly event: string;
  readonly mutationId: string;
  readonly operations: readonly AuthorityOperation[];
  readonly runId: string;
  readonly sessionId: string;
}

export interface AuthorityWrite {
  readonly intent: unknown;
  readonly key: string;
  readonly mutationId: string;
  readonly update: Omit<ContractAuthorityUpdate, "mutationId">;
}

export interface UnknownAuthorityWrite extends AuthorityWrite {
  readonly error: AuthorityOutcomeUnknownError;
}

export interface QueuedMutation {
  readonly bytes: number;
  readonly reject: (reason: unknown) => void;
  readonly run: () => Promise<void>;
}

export function authorityKey(runId: string, event: string, cause: MutationCause): string {
  const causeId =
    cause.type === "command"
      ? cause.commandId
      : cause.type === "provider"
        ? cause.providerEventId
        : cause.type === "alarm"
          ? cause.alarm
          : cause.name;
  return JSON.stringify([runId, event, cause.type, causeId]);
}

export interface ContractProjectionAuthorityOptions {
  readonly active: () => boolean;
  readonly admissionLimits?: ProtocolAdmissionLimits | undefined;
  readonly apply: (operations: readonly AuthorityOperation[]) => void;
  readonly authority: (update: ContractAuthorityUpdate) => Promise<void>;
  readonly sessionId: string;
}

export class ContractProjectionAuthority {
  readonly #active: () => boolean;
  readonly #admissionLimits: ProtocolAdmissionLimits | undefined;
  readonly #apply: (operations: readonly AuthorityOperation[]) => void;
  readonly #authority: (update: ContractAuthorityUpdate) => Promise<void>;
  readonly #sessionId: string;
  #unknown: UnknownAuthorityWrite | undefined;

  constructor(options: ContractProjectionAuthorityOptions) {
    this.#active = options.active;
    this.#admissionLimits = options.admissionLimits;
    this.#apply = options.apply;
    this.#authority = options.authority;
    this.#sessionId = options.sessionId;
  }

  get unknown(): UnknownAuthorityWrite | undefined {
    return this.#unknown;
  }

  clear(): void {
    this.#unknown = undefined;
  }

  assertRetry(
    key: string,
    intent: unknown,
    unknownAtEnqueue: UnknownAuthorityWrite | undefined,
  ): void {
    const unknown = this.#unknown;

    if (unknown === undefined) {
      return;
    }

    if (unknownAtEnqueue !== unknown || unknown.key !== key) {
      throw unknown.error;
    }

    if (!isDeepStrictEqual(unknown.intent, intent)) {
      throw new AuthorityOutcomeUnknownError(
        "Authority retry changed while its outcome was unknown.",
      );
    }
  }

  async commit(
    runId: string,
    event: string,
    cause: MutationCause,
    operations: readonly AuthorityOperation[],
    intent: unknown,
    reuseDerived = false,
  ): Promise<readonly AuthorityOperation[]> {
    if (operations.length === 0) {
      return operations;
    }

    const update = { cause, event, operations, runId, sessionId: this.#sessionId };
    const key = authorityKey(runId, event, cause);
    let pending: AuthorityWrite;

    if (this.#unknown === undefined) {
      pending = {
        intent: structuredClone(intent),
        key,
        mutationId: createDriverId(),
        update,
      };
    } else if (this.#unknown.key !== key) {
      throw this.#unknown.error;
    } else if (
      !isDeepStrictEqual(this.#unknown.intent, intent) ||
      (!reuseDerived && !isDeepStrictEqual(this.#unknown.update, update))
    ) {
      throw new AuthorityOutcomeUnknownError(
        `Authority write ${event} changed while its outcome was unknown.`,
      );
    } else {
      pending = this.#unknown;
    }

    const submission = structuredClone({ ...pending.update, mutationId: pending.mutationId });

    if (this.#admissionLimits !== undefined) {
      assertProtocolAdmission(
        submission,
        this.#admissionLimits,
        authorityContent(submission.operations),
      );
    }

    try {
      await this.#authority(submission);
    } catch (error) {
      if (error instanceof AuthorityOutcomeUnknownError && this.#active()) {
        this.#unknown = { ...pending, error };
      } else {
        this.#unknown = undefined;
      }
      throw error;
    }

    if (!this.#active()) {
      return pending.update.operations;
    }

    try {
      this.#apply(pending.update.operations);
    } catch (error) {
      const unknown = new AuthorityOutcomeUnknownError(
        `Authority write ${event} committed but local apply failed.`,
        { cause: error },
      );
      this.#unknown = { ...pending, error: unknown };
      throw unknown;
    }

    this.#unknown = undefined;
    return pending.update.operations;
  }
}
