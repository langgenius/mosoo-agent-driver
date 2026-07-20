import { AuthorityOutcomeUnknownError } from "../../contract";
import type { JsonRpcId } from "./app-server-json";
import type { PendingServerRequest } from "./contract-interactions";
import { OpenAiPrivateCitationStreamFilter } from "./private-citation-filter";
import type { ContractProjection } from "../contract-projection";

export class OpenAiContractAdapterState {
  readonly #interactions = new Map<string, PendingServerRequest>();
  readonly #maxPendingServerRequestBytes: number;
  readonly #messageFilters = new Map<string, OpenAiPrivateCitationStreamFilter>();
  #pendingServerRequestBytes = 0;
  readonly #receiptTimes = new Map<string, string>();
  readonly #textEncoder = new TextEncoder();
  #unknownReceiptEventId: string | undefined;

  constructor(maxPendingServerRequestBytes: number) {
    this.#maxPendingServerRequestBytes = maxPendingServerRequestBytes;
  }

  findInteraction(requestId: JsonRpcId): PendingServerRequest | undefined {
    return [...this.#interactions.values()].find((pending) => pending.requestId === requestId);
  }

  interaction(interactionId: string): PendingServerRequest | undefined {
    return this.#interactions.get(interactionId);
  }

  reserveInteraction(pending: Omit<PendingServerRequest, "bytes">): PendingServerRequest {
    const bytes = this.#textEncoder.encode(JSON.stringify(pending)).byteLength;

    if (bytes > this.#maxPendingServerRequestBytes - this.#pendingServerRequestBytes) {
      throw new RangeError("OpenAI app-server pending request budget is exhausted.");
    }

    const tracked = { ...pending, bytes };
    this.#interactions.set(pending.interaction.id, tracked);
    this.#pendingServerRequestBytes += bytes;
    return tracked;
  }

  async commitInteraction(
    pending: PendingServerRequest,
    projection: ContractProjection,
  ): Promise<void> {
    if (projection.interaction(pending.interaction.id) !== undefined) {
      return;
    }

    pending.commit ??= projection
      .putInteraction(
        pending.interaction.runId,
        pending.method,
        {
          providerEventId: `${pending.method}:${String(pending.requestId)}`.slice(0, 256),
          type: "provider",
        },
        pending.interaction,
      )
      .then(() => {})
      .finally(() => {
        pending.commit = undefined;
      });
    await pending.commit;
  }

  dropInteraction(interactionId: string): PendingServerRequest | undefined {
    const pending = this.#interactions.get(interactionId);

    if (pending !== undefined) {
      this.#pendingServerRequestBytes -= pending.bytes;
      this.#interactions.delete(interactionId);
    }

    return pending;
  }

  releaseTurn(turnId: string): PendingServerRequest[] {
    const dropped: PendingServerRequest[] = [];

    for (const [id, pending] of this.#interactions) {
      if (pending.turnId === turnId) {
        this.dropInteraction(id);
        dropped.push(pending);
      }
    }

    const prefix = `${turnId}\u0000`;
    for (const key of this.#messageFilters.keys()) {
      if (key.startsWith(prefix)) {
        this.#messageFilters.delete(key);
      }
    }

    return dropped;
  }

  messageFilter(turnId: string, itemId: string): OpenAiPrivateCitationStreamFilter {
    const key = `${turnId}\u0000${itemId}`;
    let filter = this.#messageFilters.get(key);

    if (filter === undefined) {
      filter = new OpenAiPrivateCitationStreamFilter();
      this.#messageFilters.set(key, filter);
    }

    return filter;
  }

  deleteMessageFilter(turnId: string, itemId: string): void {
    this.#messageFilters.delete(`${turnId}\u0000${itemId}`);
  }

  async withReceiptTime<T>(
    eventId: string,
    now: () => string,
    operation: (occurredAt: string) => Promise<T>,
  ): Promise<T> {
    const occurredAt = this.#receiptTimes.get(eventId) ?? now();
    this.#receiptTimes.set(eventId, occurredAt);

    try {
      const result = await operation(occurredAt);
      this.#receiptTimes.delete(eventId);
      if (this.#unknownReceiptEventId === eventId) {
        this.#unknownReceiptEventId = undefined;
      }
      return result;
    } catch (error) {
      if (error instanceof AuthorityOutcomeUnknownError) {
        this.#unknownReceiptEventId ??= eventId;

        if (this.#unknownReceiptEventId !== eventId) {
          this.#receiptTimes.delete(eventId);
        }
      } else {
        this.#receiptTimes.delete(eventId);
        if (this.#unknownReceiptEventId === eventId) {
          this.#unknownReceiptEventId = undefined;
        }
      }
      throw error;
    }
  }

  clear(): void {
    this.#interactions.clear();
    this.#messageFilters.clear();
    this.#pendingServerRequestBytes = 0;
    this.#receiptTimes.clear();
    this.#unknownReceiptEventId = undefined;
  }
}
