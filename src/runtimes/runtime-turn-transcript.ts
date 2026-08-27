import { createDriverId } from "../protocol/id";
import type { MessageId } from "../protocol/id";

export class RuntimeAssistantMessageIdIndex<TKey extends string> {
  readonly #messageIds = new Map<TKey, MessageId>();

  getOrCreate(key: TKey): MessageId {
    const existing = this.#messageIds.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const messageId = createDriverId() as MessageId;
    this.#messageIds.set(key, messageId);
    return messageId;
  }

  reset(): void {
    this.#messageIds.clear();
  }
}
