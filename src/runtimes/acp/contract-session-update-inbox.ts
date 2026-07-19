import { isDeepStrictEqual } from "node:util";

import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";

import { AuthorityOutcomeUnknownError } from "../contract-projection";

const MAX_PENDING_UPDATE_BYTES = 32 * 1_024 * 1_024;
const MAX_PENDING_UPDATES = 1_024;

interface UnknownSessionUpdate {
  readonly error: AuthorityOutcomeUnknownError;
  readonly notification: SessionNotification;
  readonly receivedAt: string;
  retry?: Promise<SessionUpdate | null>;
  readonly runId: string;
}

export interface AcpContractSessionUpdateInboxOptions {
  readonly apply: (
    runId: string,
    notification: SessionNotification,
    receivedAt: string,
  ) => Promise<SessionUpdate | null>;
  readonly now: () => Date;
}

export class AcpContractSessionUpdateInbox {
  readonly #apply: AcpContractSessionUpdateInboxOptions["apply"];
  #closed = false;
  #failure: Error | null = null;
  #mutationTail: Promise<void> = Promise.resolve();
  readonly #now: () => Date;
  #pendingBytes = 0;
  #pendingCount = 0;
  readonly #textEncoder = new TextEncoder();
  #unknown: UnknownSessionUpdate | undefined;

  constructor(options: AcpContractSessionUpdateInboxOptions) {
    this.#apply = options.apply;
    this.#now = options.now;
  }

  async handle(runId: string, notification: SessionNotification): Promise<SessionUpdate | null> {
    this.#assertOpen();
    this.throwIfFailed();

    const snapshot = structuredClone(notification);
    const unknownAtAdmission = this.#unknown;
    const exactRetry =
      unknownAtAdmission !== undefined &&
      unknownAtAdmission.runId === runId &&
      isDeepStrictEqual(unknownAtAdmission.notification, snapshot)
        ? unknownAtAdmission
        : undefined;

    if (exactRetry?.retry !== undefined) {
      return exactRetry.retry;
    }

    const bytes = this.#textEncoder.encode(JSON.stringify(snapshot)).byteLength;
    if (
      this.#pendingCount >= MAX_PENDING_UPDATES ||
      bytes > MAX_PENDING_UPDATE_BYTES - this.#pendingBytes
    ) {
      throw (this.#failure = new Error("ACP v1 session update queue limit exceeded."));
    }

    const receivedAt = this.#now().toISOString();
    this.#pendingBytes += bytes;
    this.#pendingCount += 1;
    const update = this.enqueue(async () => {
      this.throwIfFailed();
      const unknown = this.#unknown;
      const retrying =
        unknown !== undefined &&
        unknownAtAdmission === unknown &&
        unknown.runId === runId &&
        isDeepStrictEqual(unknown.notification, snapshot);

      try {
        if (unknown !== undefined && unknownAtAdmission !== unknown) {
          throw unknown.error;
        }

        const result = await this.#apply(
          runId,
          snapshot,
          retrying ? unknown.receivedAt : receivedAt,
        );
        if (retrying) {
          this.#unknown = undefined;
        }
        return result;
      } catch (cause) {
        if (cause instanceof AuthorityOutcomeUnknownError) {
          this.#unknown ??= {
            error: cause,
            notification: snapshot,
            receivedAt,
            runId,
          };
          throw cause;
        }

        if (retrying) {
          this.#unknown = undefined;
        }
        this.#failure ??=
          cause instanceof Error ? cause : new Error("ACP v1 session update failed.", { cause });
        throw this.#failure;
      }
    }).finally(() => {
      this.#pendingBytes -= bytes;
      this.#pendingCount -= 1;
    });

    if (exactRetry === undefined) {
      return update;
    }

    const retry = update.finally(() => {
      if (exactRetry.retry === retry) {
        delete exactRetry.retry;
      }
    });
    exactRetry.retry = retry;
    return retry;
  }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const mutation = this.#mutationTail.then(operation);
    this.#mutationTail = mutation.then(
      () => {},
      () => {},
    );
    return mutation;
  }

  throwIfFailed(): void {
    if (this.#failure !== null) {
      throw this.#failure;
    }
  }

  close(): void {
    this.#closed = true;
    this.#unknown = undefined;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("ACP v1 session update inbox is closed.");
    }
  }
}
