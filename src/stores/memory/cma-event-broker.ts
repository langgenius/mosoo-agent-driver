import type { CmaSessionEventRecord } from "../cma-store";
import {
  CMA_MAX_EVENT_BYTES,
  CMA_MAX_REPLAY_BYTES,
  CMA_MAX_STREAMS,
  CmaStoreNotFoundError,
  encodeCmaSseRecord,
} from "../cma-store";

const MAX_PENDING_SUBSCRIBER_EVENTS = 64;

interface CmaMemorySubscriber {
  push(record: CmaSessionEventRecord): void;
}

function isTerminalEvent(record: CmaSessionEventRecord): boolean {
  return "sessionStatus" in record.event && record.event.sessionStatus === "terminated";
}

export class CmaMemoryEventBroker {
  readonly #eventsBySessionId = new Map<string, CmaSessionEventRecord[]>();
  readonly #subscribersBySessionId = new Map<string, Set<CmaMemorySubscriber>>();
  #subscriberCount = 0;

  assertFrame(record: CmaSessionEventRecord): number {
    return encodeCmaSseRecord(record).byteLength;
  }

  persist(record: CmaSessionEventRecord): void {
    this.assertFrame(record);
    const events = this.#eventsBySessionId.get(record.sessionId) ?? [];
    events.push(record);
    this.#eventsBySessionId.set(record.sessionId, events);
  }

  replace(sessionId: string, previousId: string, updated: CmaSessionEventRecord): void {
    this.assertFrame(updated);
    const events = this.#eventsBySessionId.get(sessionId) ?? [];
    const index = events.findIndex((event) => event.id === previousId);

    if (index < 0) {
      throw new CmaStoreNotFoundError("event", previousId);
    }

    events.splice(index, 1);
    events.push(updated);
  }

  list(sessionId: string, afterCursor?: string): CmaSessionEventRecord[] {
    const replay: CmaSessionEventRecord[] = [];
    let bytes = 0;

    for (const event of this.#eventsBySessionId.get(sessionId) ?? []) {
      if (afterCursor !== undefined && event.cursor <= afterCursor) {
        continue;
      }

      const eventBytes = this.assertFrame(event);

      if (eventBytes > CMA_MAX_REPLAY_BYTES - bytes) {
        throw new RangeError(`CMA replay exceeds ${CMA_MAX_REPLAY_BYTES} UTF-8 bytes.`);
      }

      bytes += eventBytes;
      replay.push(event);
    }

    return replay;
  }

  publish(record: CmaSessionEventRecord): void {
    for (const subscriber of this.#subscribersBySessionId.get(record.sessionId) ?? []) {
      subscriber.push(record);
    }
  }

  stream(
    sessionId: string,
    afterCursor: string | undefined,
    acceptingInitially: () => boolean,
  ): AsyncIterable<CmaSessionEventRecord> {
    return {
      [Symbol.asyncIterator]: () => {
        const replay = this.list(sessionId, afterCursor);
        const replayCount = replay.length;
        const pending: { readonly bytes: number; readonly record: CmaSessionEventRecord }[] = [];
        const subscribers = this.#subscribersBySessionId.get(sessionId) ?? new Set();
        let accepting = acceptingInitially();
        let closed = false;
        let controller: ReadableStreamDefaultController<CmaSessionEventRecord>;
        let demanded = false;
        let pendingBytes = 0;
        let replayIndex = 0;
        let registered = true;
        let subscribed = false;

        if (this.#subscriberCount >= CMA_MAX_STREAMS) {
          throw new RangeError(`CMA subscription limit of ${CMA_MAX_STREAMS} was exceeded.`);
        }
        this.#subscriberCount += 1;

        const unsubscribe = () => {
          if (!subscribed) {
            return;
          }

          subscribed = false;
          subscribers.delete(subscriber);

          if (subscribers.size === 0) {
            this.#subscribersBySessionId.delete(sessionId);
          }
        };
        const release = () => {
          if (!registered) {
            return;
          }

          registered = false;
          unsubscribe();
          this.#subscriberCount -= 1;
        };
        const drain = () => {
          if (closed || !demanded) {
            return;
          }

          let record: CmaSessionEventRecord | undefined;

          if (replayIndex < replayCount) {
            record = replay[replayIndex++];
          } else {
            const next = pending.shift();

            if (next) {
              pendingBytes -= next.bytes;
              record = next.record;
            }
          }

          if (record) {
            demanded = false;
            controller.enqueue(structuredClone(record));
          }

          if (!closed && replayIndex >= replayCount && pending.length === 0 && !accepting) {
            closed = true;
            controller.close();
            release();
          }
        };
        const subscriber: CmaMemorySubscriber = {
          push: (record) => {
            if (!accepting) {
              return;
            }

            const bytes = this.assertFrame(record);

            if (
              pending.length >= MAX_PENDING_SUBSCRIBER_EVENTS ||
              bytes > CMA_MAX_EVENT_BYTES - pendingBytes
            ) {
              accepting = false;
              closed = true;
              release();
              controller.error(
                new Error(
                  bytes > CMA_MAX_EVENT_BYTES - pendingBytes
                    ? "CMA subscriber byte limit exceeded."
                    : "CMA event stream slow consumer limit exceeded.",
                ),
              );
              return;
            }

            pending.push({ bytes, record });
            pendingBytes += bytes;

            if (isTerminalEvent(record)) {
              accepting = false;
              unsubscribe();
            }

            drain();
          },
        };
        const stream = new ReadableStream<CmaSessionEventRecord>(
          {
            start: (value) => {
              controller = value;

              if (accepting) {
                subscribers.add(subscriber);
                this.#subscribersBySessionId.set(sessionId, subscribers);
                subscribed = true;
              }
            },
            pull() {
              demanded = true;
              drain();
            },
            cancel() {
              accepting = false;
              closed = true;
              release();
            },
          },
          { highWaterMark: 0 },
        );
        const reader = stream.getReader();

        return {
          async next(): Promise<IteratorResult<CmaSessionEventRecord>> {
            const result = await reader.read();
            return result.done
              ? { done: true, value: undefined }
              : { done: false, value: result.value };
          },
          async return() {
            await reader.cancel();
            return { done: true, value: undefined };
          },
          async throw(error?: unknown) {
            await reader.cancel(error);
            throw error;
          },
        };
      },
    };
  }
}
