import { isDeepStrictEqual } from "node:util";

import type { JsonObject } from "./app-server-json";

const MAX_PENDING_TURN_BYTES = 8 * 1_024 * 1_024;
const MAX_TRACKED_TURNS = 1_024;

interface PendingTurnEnd {
  readonly bytes: number;
  readonly params: JsonObject;
  task?: Promise<void> | undefined;
}

interface PendingTurnNotification {
  readonly bytes: number;
  readonly method: string;
  readonly params: JsonObject;
}

export interface OpenAiContractTurnInboxOptions {
  readonly dispatch: (method: string, params: JsonObject) => Promise<void>;
  readonly replayEnd: (params: JsonObject) => Promise<void>;
}

export class OpenAiContractTurnInbox<TTurn> {
  readonly #dispatch: OpenAiContractTurnInboxOptions["dispatch"];
  readonly #ended = new Map<string, TTurn>();
  readonly #pendingEnds = new Map<string, PendingTurnEnd>();
  readonly #pendingNotifications = new Map<string, PendingTurnNotification[]>();
  readonly #pendingReplays = new Map<string, Promise<void>>();
  readonly #replayEnd: OpenAiContractTurnInboxOptions["replayEnd"];
  readonly #textEncoder = new TextEncoder();
  #disposed = false;
  #pendingEndBytes = 0;
  #pendingNotificationBytes = 0;
  #pendingNotificationCount = 0;

  constructor(options: OpenAiContractTurnInboxOptions) {
    this.#dispatch = options.dispatch;
    this.#replayEnd = options.replayEnd;
  }

  ended(turnId: string): TTurn | undefined {
    return this.#ended.get(turnId);
  }

  hasEnded(turnId: string): boolean {
    return this.#ended.has(turnId);
  }

  shouldBuffer(turnId: string): boolean {
    return (
      this.#pendingNotifications.has(turnId) ||
      this.#pendingEnds.has(turnId) ||
      this.#pendingReplays.has(turnId)
    );
  }

  rememberNotification(turnId: string, method: string, params: JsonObject): void {
    if (this.#pendingEnds.has(turnId)) {
      throw new Error(
        `OpenAI app-server event ${method} arrived after terminal Turn ${turnId} before attachment.`,
      );
    }

    const snapshot = structuredClone(params);
    const bytes = this.#textEncoder.encode(JSON.stringify(snapshot)).byteLength;

    if (
      this.#pendingNotificationCount >= MAX_TRACKED_TURNS ||
      bytes > MAX_PENDING_TURN_BYTES - this.#pendingNotificationBytes
    ) {
      throw new RangeError("OpenAI app-server pending Turn event limit is exhausted.");
    }

    const queue = this.#pendingNotifications.get(turnId) ?? [];
    queue.push({ bytes, method, params: snapshot });
    this.#pendingNotifications.set(turnId, queue);
    this.#pendingNotificationBytes += bytes;
    this.#pendingNotificationCount += 1;
  }

  rememberEnd(turnId: string, params: JsonObject): void {
    const existing = this.#pendingEnds.get(turnId);

    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing.params, params)) {
        throw new Error(`OpenAI terminal Turn ${turnId} changed before attachment.`);
      }
      return;
    }

    const snapshot = structuredClone(params);
    const bytes = this.#textEncoder.encode(JSON.stringify(snapshot)).byteLength;

    if (
      this.#pendingEnds.size >= MAX_TRACKED_TURNS ||
      bytes > MAX_PENDING_TURN_BYTES - this.#pendingEndBytes
    ) {
      throw new RangeError("OpenAI app-server pending terminal Turn limit is exhausted.");
    }

    this.#pendingEnds.set(turnId, { bytes, params: snapshot });
    this.#pendingEndBytes += bytes;
  }

  async replay(turnId: string): Promise<void> {
    const existing = this.#pendingReplays.get(turnId);
    if (existing !== undefined) {
      await existing;
      return;
    }

    const task = this.#drain(turnId).finally(() => {
      if (this.#pendingReplays.get(turnId) === task) {
        this.#pendingReplays.delete(turnId);
      }
    });
    this.#pendingReplays.set(turnId, task);
    await task;
  }

  rememberEnded(turnId: string, turn: TTurn): void {
    this.#ended.delete(turnId);
    this.#ended.set(turnId, turn);

    if (this.#ended.size > MAX_TRACKED_TURNS) {
      const oldest = this.#ended.keys().next().value;
      if (oldest !== undefined) {
        this.#ended.delete(oldest);
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#ended.clear();
    this.#pendingEnds.clear();
    this.#pendingNotifications.clear();
    this.#pendingReplays.clear();
    this.#pendingEndBytes = 0;
    this.#pendingNotificationBytes = 0;
    this.#pendingNotificationCount = 0;
  }

  async #drain(turnId: string): Promise<void> {
    for (;;) {
      const queue = this.#pendingNotifications.get(turnId);
      const pending = queue?.[0];

      if (queue !== undefined && pending !== undefined) {
        await this.#dispatch(pending.method, pending.params);
        if (this.#disposed || this.#pendingNotifications.get(turnId) !== queue) {
          return;
        }

        queue.shift();
        this.#pendingNotificationBytes -= pending.bytes;
        this.#pendingNotificationCount -= 1;
        if (queue.length === 0) {
          this.#pendingNotifications.delete(turnId);
        }
        continue;
      }

      await this.#replayPendingEnd(turnId);
      if (!this.#pendingNotifications.has(turnId) && !this.#pendingEnds.has(turnId)) {
        return;
      }
    }
  }

  async #replayPendingEnd(turnId: string): Promise<void> {
    const pending = this.#pendingEnds.get(turnId);
    if (pending === undefined) {
      return;
    }

    pending.task ??= this.#replayEnd(pending.params)
      .then(() => {
        if (this.#pendingEnds.get(turnId) === pending) {
          this.#pendingEnds.delete(turnId);
          this.#pendingEndBytes -= pending.bytes;
        }
      })
      .finally(() => {
        pending.task = undefined;
      });
    await pending.task;
  }
}
