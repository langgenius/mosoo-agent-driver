import {
  assertDriverEventReceiptPrefix,
  DRIVER_EVENT_DELIVERY_TIMEOUT_MS,
  DriverEventRejectedError,
  pushLosslessEvents,
} from "../core/driver-runtime-io";
import { summarizeDriverEventBatch } from "../observability/driver-debug";
import type { DriverEventInput } from "../protocol/events";
import type { RunId } from "../protocol/id";
import type { DriverEventReceipt } from "../protocol/orpc";
import type { DriverRuntime } from "../protocol/runtime";
import type { AgentDriverContext } from "../core/agent-driver-backend";
import {
  admitDriverEventPush,
  driverEventBatchBytes,
  isLosslessDriverEvent,
  terminalDriverEventRetryKey,
  type QueuedDriverEvent,
} from "./driver-event-admission";

interface QueuedPush {
  readonly awaitPending: boolean;
  readonly context: AgentDriverContext;
  readonly eventBytes: number;
  readonly eventCount: number;
  readonly events: QueuedDriverEvent[];
  readonly id: symbol;
  readonly losslessBytes: number;
  readonly losslessCount: number;
  readonly promise: Promise<void>;
  readonly reason: string;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: () => void;
  readonly terminalBatch: boolean;
  readonly terminalKey: string | null;
}

export class DriverEventPublisher {
  readonly #getSessionRef: () => string | null;
  readonly #runtime: DriverRuntime;
  #drainTask: Promise<void> | null = null;
  #lastAcceptedSeq = 0;
  #pendingEvents: QueuedDriverEvent[] = [];
  #pendingLosslessBytes = 0;
  #pendingLosslessCount = 0;
  #pendingTerminalBatch = false;
  #pendingTerminalKey: string | null = null;
  #pendingWake: { context: AgentDriverContext; reason: string } | null = null;
  #queue: QueuedPush[] = [];
  #queuedEventBytes = 0;
  #queuedEventCount = 0;
  #queuedLosslessBytes = 0;
  #queuedLosslessCount = 0;
  #queuedTerminalBatches = 0;

  constructor(runtime: DriverRuntime, getSessionRef: () => string | null) {
    this.#getSessionRef = getSessionRef;
    this.#runtime = runtime;
  }

  async push(
    context: AgentDriverContext,
    reason: string,
    events: readonly DriverEventInput[],
  ): Promise<void> {
    if (events.length === 0) {
      this.#requestPendingDrain(context, reason);
      return;
    }

    try {
      const activeRunId = context.ports.eventSink.currentRunId?.() ?? null;

      if (
        this.#pendingTerminalKey !== null &&
        terminalDriverEventRetryKey(events, activeRunId) === this.#pendingTerminalKey
      ) {
        const retry = this.#createPendingRetry(context, reason);
        this.#enqueue(retry);
        return retry.promise;
      }

      const entry = this.#admit(context, reason, events, activeRunId);

      if (entry === null) {
        this.#requestPendingDrain(context, reason);
        return;
      }

      this.#enqueue(entry);
      return entry.losslessCount === 0 && !entry.terminalBatch ? undefined : entry.promise;
    } catch (error) {
      this.#requestPendingDrain(context, reason);
      throw error;
    }
  }

  #enqueue(entry: QueuedPush): void {
    this.#queue.push(entry);
    this.#queuedEventBytes += entry.eventBytes;
    this.#queuedEventCount += entry.eventCount;
    this.#queuedLosslessBytes += entry.losslessBytes;
    this.#queuedLosslessCount += entry.losslessCount;
    this.#queuedTerminalBatches += Number(entry.terminalBatch);
    this.#scheduleDrain();
  }

  lastAcceptedSeq(): number {
    return this.#lastAcceptedSeq;
  }

  #createPendingRetry(context: AgentDriverContext, reason: string): QueuedPush {
    const deferred = Promise.withResolvers<void>();

    return {
      awaitPending: true,
      context,
      eventBytes: 0,
      eventCount: 0,
      events: [],
      id: Symbol(reason),
      losslessBytes: 0,
      losslessCount: 0,
      promise: deferred.promise,
      reason,
      reject: deferred.reject,
      resolve: deferred.resolve,
      terminalBatch: false,
      terminalKey: null,
    };
  }

  #admit(
    context: AgentDriverContext,
    reason: string,
    events: readonly DriverEventInput[],
    activeRunId: RunId | null,
  ): QueuedPush | null {
    const id = Symbol(reason);
    const admission = admitDriverEventPush(events, activeRunId, id, {
      pendingLosslessBytes: this.#pendingLosslessBytes,
      pendingLosslessCount: this.#pendingLosslessCount,
      pendingTerminalBatch: this.#pendingTerminalBatch,
      queuedEventBytes: this.#queuedEventBytes,
      queuedEventCount: this.#queuedEventCount,
      queuedLosslessBytes: this.#queuedLosslessBytes,
      queuedLosslessCount: this.#queuedLosslessCount,
      queuedTerminalBatches: this.#queuedTerminalBatches,
    });

    if (admission === null) {
      return null;
    }

    const deferred = Promise.withResolvers<void>();
    return {
      ...admission,
      awaitPending: false,
      context,
      id,
      promise: deferred.promise,
      reason,
      reject: deferred.reject,
      resolve: deferred.resolve,
    };
  }

  #requestPendingDrain(context: AgentDriverContext, reason: string): void {
    if (this.#pendingEvents.length === 0 && this.#queue.length === 0 && this.#drainTask === null) {
      return;
    }

    this.#pendingWake ??= { context, reason };
    this.#scheduleDrain();
  }

  #scheduleDrain(): void {
    if (this.#drainTask !== null) {
      return;
    }

    this.#drainTask = Promise.resolve()
      .then(() => this.#drain())
      .finally(() => {
        this.#drainTask = null;

        if (this.#queue.length > 0 || this.#pendingWake !== null) {
          this.#scheduleDrain();
        }
      });
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0 || this.#pendingWake !== null) {
      const entries = this.#queue.splice(0);
      const wake = this.#pendingWake;
      this.#pendingWake = null;

      if (entries.length === 0 && this.#pendingEvents.length === 0) {
        continue;
      }

      const context = entries[0]?.context ?? wake?.context;

      if (context === undefined) {
        return;
      }

      await this.#deliver(entries, context, wake?.reason);
    }
  }

  async #deliver(
    entries: readonly QueuedPush[],
    context: AgentDriverContext,
    wakeReason?: string,
  ): Promise<void> {
    const queuedEvents = [...this.#pendingEvents, ...entries.flatMap((entry) => entry.events)];
    const remainingLossless = queuedEvents.filter(({ event }) => isLosslessDriverEvent(event));
    const ownerErrors = new Map<symbol, unknown>();
    const reason =
      entries.length === 0
        ? `driver.events.pending.${wakeReason ?? "retry"}`
        : entries.length === 1
          ? entries[0]!.reason
          : "driver.events.coalesced";
    const terminalKey =
      this.#pendingTerminalKey ??
      entries.find((entry) => entry.terminalKey !== null)?.terminalKey ??
      null;
    let acceptedEventCount = 0;
    let deliveryError: unknown = null;

    context.logger.debug("driver.runtime.events.sending", {
      pendingEventCount: this.#pendingEvents.length,
      reason,
      runtime: this.#runtime,
      sessionRef: this.#getSessionRef(),
      ...summarizeDriverEventBatch(queuedEvents.map(({ event }) => event)),
    });

    try {
      for (let index = 0; index < queuedEvents.length;) {
        const lossless = isLosslessDriverEvent(queuedEvents[index]!.event);
        let end = index + 1;

        while (
          end < queuedEvents.length &&
          isLosslessDriverEvent(queuedEvents[end]!.event) === lossless
        ) {
          end += 1;
        }

        const sameDelivery = queuedEvents.slice(index, end);

        if (lossless) {
          const deadline = AbortSignal.timeout(DRIVER_EVENT_DELIVERY_TIMEOUT_MS);
          let remaining = sameDelivery;

          while (remaining.length > 0) {
            let acceptedInAttempt = 0;

            try {
              await pushLosslessEvents(
                context.ports.eventSink,
                remaining.map(({ event }) => event),
                (receipts) => {
                  acceptedInAttempt += receipts.length;
                  acceptedEventCount += receipts.length;
                  this.#rememberAcceptedReceipts(receipts);
                  remainingLossless.splice(0, receipts.length);
                },
                deadline,
              );
              break;
            } catch (error) {
              remaining = remaining.slice(acceptedInAttempt);

              if (!(error instanceof DriverEventRejectedError)) {
                throw error;
              }

              const rejectedIndex = remaining.findIndex(
                ({ event }) => event.sourceEventId === error.sourceEventId,
              );

              if (rejectedIndex < 0) {
                throw error;
              }

              const [rejected] = remaining.splice(rejectedIndex, 1);
              const retainedIndex = remainingLossless.indexOf(rejected!);

              if (retainedIndex < 0) {
                throw error;
              }

              remainingLossless.splice(retainedIndex, 1);

              if (rejected!.owner !== null && !ownerErrors.has(rejected!.owner)) {
                ownerErrors.set(rejected!.owner, error);
              }
            }
          }
        } else {
          const deadline = AbortSignal.timeout(DRIVER_EVENT_DELIVERY_TIMEOUT_MS);
          try {
            const events = sameDelivery.map(({ event }) => event);
            const result = await context.ports.eventSink.pushEvents({
              events,
              signal: deadline,
            });
            assertDriverEventReceiptPrefix(events, result.accepted);
            acceptedEventCount += result.accepted.length;
            this.#rememberAcceptedReceipts(result.accepted);
          } catch {
            // Best-effort events are intentionally dropped on transport or receipt failure.
          }
        }

        index = end;
      }
    } catch (error) {
      deliveryError = error;
    }

    this.#setPending(remainingLossless, terminalKey);

    context.logger.debug("driver.runtime.events.sent", {
      acceptedEventCount,
      eventCount: queuedEvents.length,
      lastAcceptedSeq: this.#lastAcceptedSeq,
      pendingEventCount: this.#pendingEvents.length,
      reason,
      runtime: this.#runtime,
      sessionRef: this.#getSessionRef(),
    });

    for (const entry of entries) {
      const error =
        ownerErrors.get(entry.id) ??
        (remainingLossless.some(({ owner }) => owner === entry.id) ||
        (entry.awaitPending && remainingLossless.some(({ owner }) => owner === null))
          ? (deliveryError ?? new Error("Driver event delivery did not settle."))
          : null);

      this.#queuedEventBytes -= entry.eventBytes;
      this.#queuedEventCount -= entry.eventCount;
      this.#queuedLosslessBytes -= entry.losslessBytes;
      this.#queuedLosslessCount -= entry.losslessCount;
      this.#queuedTerminalBatches -= Number(entry.terminalBatch);

      if (error === null) {
        entry.resolve();
      } else {
        entry.reject(error);
      }
    }
  }

  #setPending(events: readonly QueuedDriverEvent[], terminalKey: string | null): void {
    this.#pendingEvents = events.map((event) => ({ ...event, owner: null }));
    let losslessByteSum = 0;
    let losslessCount = 0;
    let terminalBatch = false;

    for (const event of events) {
      if (event.terminalLane) {
        terminalBatch = true;
      } else {
        losslessByteSum += event.bytes;
        losslessCount += 1;
      }
    }

    this.#pendingLosslessBytes = driverEventBatchBytes(losslessByteSum, losslessCount);
    this.#pendingLosslessCount = losslessCount;
    this.#pendingTerminalBatch = terminalBatch;
    this.#pendingTerminalKey = terminalBatch ? terminalKey : null;
  }

  #rememberAcceptedReceipts(receipts: readonly DriverEventReceipt[]): void {
    for (const receipt of receipts) {
      this.#lastAcceptedSeq = Math.max(this.#lastAcceptedSeq, receipt.seq);
    }
  }
}
