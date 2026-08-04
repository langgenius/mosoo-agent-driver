import type { SessionNotification } from "@agentclientprotocol/sdk";

import type { AgentDriverContext } from "../../core/agent-driver-backend";

const MAX_PENDING_UPDATE_BYTES = 32 * 1_024 * 1_024;
const MAX_PENDING_UPDATES = 1_024;

export interface AcpSessionUpdateScope {
  readonly replaying: boolean;
  readonly suppressed: boolean;
}

export interface AcpSessionUpdateInboxOptions {
  readonly apply: (
    context: AgentDriverContext,
    notification: SessionNotification,
    scope: AcpSessionUpdateScope,
  ) => Promise<void>;
  readonly onFailure: (error: Error) => void;
}

export class AcpSessionUpdateInbox {
  readonly #apply: AcpSessionUpdateInboxOptions["apply"];
  #closed = false;
  readonly #deliveries = new Set<Promise<void>>();
  #failure: Error | null = null;
  readonly #onFailure: AcpSessionUpdateInboxOptions["onFailure"];
  #pendingBytes = 0;
  #pendingCount = 0;
  #replaying = false;
  #suppressed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: AcpSessionUpdateInboxOptions) {
    this.#apply = options.apply;
    this.#onFailure = options.onFailure;
  }

  isSuppressed(): boolean {
    return this.#suppressed;
  }

  enqueue(context: AgentDriverContext, notification: SessionNotification): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("ACP session update ingress is closed."));
    }

    if (this.#failure !== null) {
      return Promise.reject(this.#failure);
    }

    const bytes = Buffer.byteLength(JSON.stringify(notification), "utf8");

    if (
      this.#pendingCount >= MAX_PENDING_UPDATES ||
      bytes > MAX_PENDING_UPDATE_BYTES - this.#pendingBytes
    ) {
      const error = new Error("ACP session update queue limit exceeded.");
      this.#fail(error);
      return Promise.reject(error);
    }

    this.#pendingBytes += bytes;
    this.#pendingCount += 1;
    const scope = { replaying: this.#replaying, suppressed: this.#suppressed };
    let delivery = Promise.resolve();
    const admission = this.#tail
      .then(() => {
        if (this.#failure !== null) {
          throw this.#failure;
        }

        delivery = this.#apply(context, notification, scope);
        this.#deliveries.add(delivery);
        void delivery
          .catch((error: unknown) => this.#fail(error))
          .finally(() => this.#deliveries.delete(delivery));
      })
      .finally(() => {
        this.#pendingBytes -= bytes;
        this.#pendingCount -= 1;
      });
    this.#tail = admission.catch((error: unknown) => this.#fail(error));
    return admission.then(() => delivery);
  }

  async drain(): Promise<void> {
    for (;;) {
      const tail = this.#tail;
      await tail;
      await Promise.allSettled(this.#deliveries);
      await Promise.resolve();

      if (tail !== this.#tail || this.#deliveries.size > 0) {
        continue;
      }

      if (this.#failure !== null) {
        throw this.#failure;
      }

      return;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.drain();
  }

  async withReplay<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#replaying;
    this.#replaying = true;

    try {
      return await operation();
    } finally {
      try {
        await this.drain();
      } finally {
        this.#replaying = previous;
      }
    }
  }

  async suppress<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#suppressed;
    this.#suppressed = true;

    try {
      return await operation();
    } finally {
      try {
        await this.drain();
      } finally {
        this.#suppressed = previous;
      }
    }
  }

  #fail(cause: unknown): void {
    if (this.#failure !== null) {
      return;
    }

    const error =
      cause instanceof Error ? cause : new Error("ACP session update handling failed.", { cause });
    this.#failure = error;
    this.#onFailure(error);
  }
}
