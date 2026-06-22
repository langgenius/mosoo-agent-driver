import { summarizeDriverEventBatch } from "../infrastructure/logging/driver-debug";
import type { DriverEventInput } from "../protocol/events";
import type { DriverEventReceipt } from "../protocol/orpc";
import type { DriverRuntime } from "../protocol/runtime";
import type { AgentDriverContext } from "./agent-driver-backend";

async function settleSendGate(task: Promise<void>): Promise<void> {
  try {
    await task;
  } catch {
    // The caller of push observes and stores the real error.
  }
}

export class DriverEventPublisher {
  readonly #getSessionRef: () => string | null;
  readonly #runtime: DriverRuntime;
  #sendGate: Promise<void> = Promise.resolve();
  #lastAcceptedSeq = 0;
  #pendingEvents: DriverEventInput[] = [];

  constructor(runtime: DriverRuntime, getSessionRef: () => string | null) {
    this.#getSessionRef = getSessionRef;
    this.#runtime = runtime;
  }

  async push(
    context: AgentDriverContext,
    reason: string,
    events: DriverEventInput[],
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const task = this.#sendAfterPreviousPush(context, reason, events);
    this.#sendGate = settleSendGate(task);
    await task;
  }

  lastAcceptedSeq(): number {
    return this.#lastAcceptedSeq;
  }

  async #sendAfterPreviousPush(
    context: AgentDriverContext,
    reason: string,
    events: DriverEventInput[],
  ): Promise<void> {
    try {
      await this.#sendGate;
    } catch {
      // Failed batches stay in #pendingEvents; the next push retries them before sending new events.
    }

    const batch = [...this.#pendingEvents, ...events];

    context.logger.debug("driver.runtime.events.sending", {
      pendingEventCount: this.#pendingEvents.length,
      reason,
      runtime: this.#runtime,
      sessionRef: this.#getSessionRef(),
      ...summarizeDriverEventBatch(batch),
    });

    try {
      const result = await context.ports.eventSink.pushEvents({ events: batch });
      this.#rememberAcceptedReceipts(result.accepted);
      this.#pendingEvents = batch.slice(Math.min(result.accepted.length, batch.length));

      context.logger.debug("driver.runtime.events.sent", {
        acceptedEventCount: result.accepted.length,
        eventCount: batch.length,
        lastAcceptedSeq: this.#lastAcceptedSeq,
        pendingEventCount: this.#pendingEvents.length,
        reason,
        runtime: this.#runtime,
        sessionRef: this.#getSessionRef(),
      });
    } catch (error) {
      this.#pendingEvents = batch;
      throw error;
    }
  }

  #rememberAcceptedReceipts(receipts: readonly DriverEventReceipt[]): void {
    for (const receipt of receipts) {
      this.#lastAcceptedSeq = Math.max(this.#lastAcceptedSeq, receipt.seq);
    }
  }
}
