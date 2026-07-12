import type { SessionEvent, SessionEventKind, SessionEventPayloadMap } from "./event";

/**
 * Contract-level coalescing so any transport boundary (oRPC batch, DO →
 * WebSocket fan-out, SSE replay) can buffer high-frequency events safely.
 *
 * Rules (normative):
 * - Only ADJACENT events merge; coalescing never reorders across keys.
 * - A merged event keeps the LAST member's id/seq/at (ack high-water mark
 *   stays correct); only payloads combine.
 * - item.delta  (same itemId+stream+index): deltas concatenate.
 * - item.updated (same itemId): patches merge, later fields win.
 * - usage.updated (same turnId): payloads are cumulative; keep the last.
 * - Everything else is a barrier.
 */
export function isCoalescibleKind(kind: SessionEventKind): boolean {
  return kind === "item.delta" || kind === "item.updated" || kind === "usage.updated";
}

function mergeAdjacent(previous: SessionEvent, next: SessionEvent): SessionEvent | null {
  if (
    previous.kind !== next.kind ||
    previous.sessionId !== next.sessionId ||
    previous.turnId !== next.turnId
  ) {
    return null;
  }

  if (previous.kind === "item.delta" && next.kind === "item.delta") {
    const before = previous.payload as SessionEventPayloadMap["item.delta"];
    const after = next.payload as SessionEventPayloadMap["item.delta"];

    if (
      before.itemId !== after.itemId ||
      before.stream !== after.stream ||
      before.index !== after.index
    ) {
      return null;
    }

    return { ...next, payload: { ...after, delta: before.delta + after.delta } };
  }

  if (previous.kind === "item.updated" && next.kind === "item.updated") {
    const before = previous.payload as SessionEventPayloadMap["item.updated"];
    const after = next.payload as SessionEventPayloadMap["item.updated"];

    if (before.itemId !== after.itemId || before.kind !== after.kind) {
      return null;
    }

    return { ...next, payload: { ...after, patch: { ...before.patch, ...after.patch } } };
  }

  if (previous.kind === "usage.updated" && next.kind === "usage.updated") {
    return next;
  }

  return null;
}

/** Single-pass adjacent-run coalescing; relative order is preserved. */
export function coalesceSessionEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const out: SessionEvent[] = [];

  for (const event of events) {
    const previous = out[out.length - 1];
    const merged = previous === undefined ? null : mergeAdjacent(previous, event);

    if (merged === null) {
      out.push(event);
    } else {
      out[out.length - 1] = merged;
    }
  }

  return out;
}

export interface SessionEventBufferOptions {
  /** Flush callback; batches are already coalesced and in order. */
  readonly flush: (events: SessionEvent[]) => void | Promise<void>;
  /** Coalescible events buffered at most this long. Default 25ms. */
  readonly maxDelayMs?: number | undefined;
  /** Buffer flushes when it holds this many events. Default 64. */
  readonly maxCount?: number | undefined;
  /** Receives flush errors from timer-driven flushes. Default: rethrow async. */
  readonly onError?: ((error: unknown, events: SessionEvent[]) => void) | undefined;
}

export interface SessionEventBuffer {
  push(event: SessionEvent): void;
  /** Flush buffered events now; resolves after the flush callback settles. */
  flush(): Promise<void>;
  readonly size: () => number;
}

/**
 * Reference buffer: coalescible kinds accumulate up to maxDelayMs/maxCount;
 * barrier kinds flush the whole buffer (in order) immediately. Flushes are
 * serialized — a flush never starts before the previous one settled.
 */
export function createSessionEventBuffer(options: SessionEventBufferOptions): SessionEventBuffer {
  const maxDelayMs = options.maxDelayMs ?? 25;
  const maxCount = options.maxCount ?? 64;
  const onError =
    options.onError ??
    ((error: unknown) => {
      queueMicrotask(() => {
        throw error;
      });
    });

  let buffered: SessionEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sendGate: Promise<void> = Promise.resolve();

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flushNow(background: boolean): Promise<void> {
    clearTimer();

    if (buffered.length === 0) {
      return sendGate;
    }

    const events = coalesceSessionEvents(buffered);
    buffered = [];
    const task = sendGate.then(() => options.flush(events));
    sendGate = task.catch(() => {});

    if (background) {
      task.catch((error: unknown) => {
        onError(error, events);
      });
    }

    return task;
  }

  return {
    push(event) {
      buffered.push(event);

      if (!isCoalescibleKind(event.kind) || buffered.length >= maxCount) {
        void flushNow(true);
        return;
      }

      timer ??= setTimeout(() => {
        timer = null;
        void flushNow(true);
      }, maxDelayMs);
    },
    flush: () => flushNow(false),
    size: () => buffered.length,
  };
}
