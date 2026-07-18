import {
  assertDriverEventReceiptPrefix,
  DRIVER_EVENT_DELIVERY_TIMEOUT_MS,
  DriverEventRejectedError,
  pushLosslessEvents,
  withSourceEventIds,
} from "../core/driver-runtime-io";
import { summarizeDriverEventBatch } from "../infrastructure/logging/driver-debug";
import type { DriverEventInput } from "../protocol/events";
import type { RunId } from "../protocol/id";
import type { DriverEventReceipt } from "../protocol/orpc";
import type { DriverRuntime } from "../protocol/runtime";
import type { AgentDriverContext } from "./agent-driver-backend";

const MAX_PENDING_DRIVER_EVENTS = 1_024;
const MAX_PENDING_DRIVER_EVENT_BYTES = 32 * 1_024 * 1_024;
const MAX_RUN_TERMINAL_BATCH_EVENTS = 64;
const MAX_RUN_TERMINAL_BATCH_BYTES = 1_024 * 1_024;

interface QueuedEvent {
  readonly bytes: number;
  readonly event: DriverEventInput;
  readonly owner: symbol | null;
  readonly terminalLane: boolean;
}

interface QueuedPush {
  readonly awaitPending: boolean;
  readonly context: AgentDriverContext;
  readonly eventBytes: number;
  readonly eventCount: number;
  readonly events: QueuedEvent[];
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

function batchBytes(bytes: number, count: number): number {
  return count === 0 ? 0 : bytes + count + 1;
}

function isLossless(event: DriverEventInput): boolean {
  return event.delivery !== "best_effort";
}

function isRunTerminal(event: DriverEventInput): boolean {
  return (
    event.kind === "run.cancelled" || event.kind === "run.completed" || event.kind === "run.failed"
  );
}

function scopeEvent(event: DriverEventInput, activeRunId: RunId | null): DriverEventInput {
  const { runId, sourceEventId, ...content } = event;
  const frozenRunId = runId === undefined ? activeRunId : runId;
  const explicitSourceId =
    typeof sourceEventId === "string" && sourceEventId.length > 0 ? sourceEventId : null;

  return {
    ...content,
    ...(explicitSourceId === null ? {} : { sourceEventId: explicitSourceId }),
    ...(frozenRunId === null ? {} : { runId: frozenRunId }),
  } as DriverEventInput;
}

function terminalRetryKey(
  events: readonly DriverEventInput[],
  activeRunId: RunId | null,
): string | null {
  const losslessEvents = events.filter(isLossless);

  if (
    losslessEvents.length === 0 ||
    losslessEvents.length > MAX_RUN_TERMINAL_BATCH_EVENTS ||
    losslessEvents.filter(isRunTerminal).length !== 1 ||
    !isRunTerminal(losslessEvents.at(-1)!)
  ) {
    return null;
  }

  const key = JSON.stringify(losslessEvents.map((event) => scopeEvent(event, activeRunId)));
  return Buffer.byteLength(key, "utf8") <= MAX_RUN_TERMINAL_BATCH_BYTES ? key : null;
}

export class DriverEventPublisher {
  readonly #getSessionRef: () => string | null;
  readonly #runtime: DriverRuntime;
  #drainTask: Promise<void> | null = null;
  #lastAcceptedSeq = 0;
  #pendingEvents: QueuedEvent[] = [];
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
        terminalRetryKey(events, activeRunId) === this.#pendingTerminalKey
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
      return entry.promise;
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
    const losslessEvents = events.filter(isLossless);
    const runTerminals = losslessEvents.filter(isRunTerminal);
    const terminalBatch = runTerminals.length > 0;

    if (runTerminals.length > 1) {
      throw new Error("Driver event run terminal slot is full.");
    }

    if (terminalBatch) {
      if (this.#pendingTerminalBatch || this.#queuedTerminalBatches > 0) {
        throw new Error("Driver event run terminal slot is full.");
      }

      if (losslessEvents.length > MAX_RUN_TERMINAL_BATCH_EVENTS) {
        throw new Error(
          `Driver event run terminal batch exceeds ${MAX_RUN_TERMINAL_BATCH_EVENTS} events.`,
        );
      }

      if (!isRunTerminal(losslessEvents.at(-1)!)) {
        throw new Error("Driver event run terminal must be the final lossless event.");
      }
    }

    const losslessCount = terminalBatch ? 0 : losslessEvents.length;

    if (
      this.#pendingLosslessCount + this.#queuedLosslessCount + losslessCount >
      MAX_PENDING_DRIVER_EVENTS
    ) {
      throw new Error(`Driver event queue exceeds ${MAX_PENDING_DRIVER_EVENTS} events.`);
    }

    let admittedEvents: readonly DriverEventInput[];

    if (terminalBatch) {
      admittedEvents = losslessEvents;
    } else if (losslessEvents.length === 0) {
      const capacity =
        MAX_PENDING_DRIVER_EVENTS - this.#pendingLosslessCount - this.#queuedEventCount;

      if (capacity <= 0) {
        return null;
      }

      admittedEvents = events.slice(0, capacity);
    } else {
      const bestEffortCount = events.length - losslessEvents.length;
      const includeBestEffort =
        this.#pendingLosslessCount + this.#queuedEventCount + losslessCount + bestEffortCount <=
        MAX_PENDING_DRIVER_EVENTS;
      admittedEvents = includeBestEffort ? events : losslessEvents;
    }

    const frozenEvents = admittedEvents.map((event) => scopeEvent(event, activeRunId));
    const terminalKey = terminalBatch ? JSON.stringify(frozenEvents) : null;
    const stampedEvents = withSourceEventIds(frozenEvents);
    const serialized: (string | undefined)[] = [];
    const serializedBytes: (number | undefined)[] = [];
    let losslessByteSum = 0;
    let serializedLosslessCount = 0;
    let terminalByteSum = 0;
    let terminalCount = 0;

    for (const [index, event] of stampedEvents.entries()) {
      if (!isLossless(event)) {
        continue;
      }

      const json = JSON.stringify(event);
      const bytes = Buffer.byteLength(json, "utf8");

      if (terminalBatch) {
        terminalByteSum += bytes;
        terminalCount += 1;

        if (batchBytes(terminalByteSum, terminalCount) > MAX_RUN_TERMINAL_BATCH_BYTES) {
          throw new Error(
            `Driver event run terminal batch exceeds ${MAX_RUN_TERMINAL_BATCH_BYTES} UTF-8 bytes.`,
          );
        }
      } else {
        losslessByteSum += bytes;
        serializedLosslessCount += 1;

        if (
          this.#pendingLosslessBytes +
            this.#queuedLosslessBytes +
            batchBytes(losslessByteSum, serializedLosslessCount) >
          MAX_PENDING_DRIVER_EVENT_BYTES
        ) {
          throw new Error(
            `Driver event queue exceeds ${MAX_PENDING_DRIVER_EVENT_BYTES} UTF-8 bytes.`,
          );
        }
      }

      serialized[index] = json;
      serializedBytes[index] = bytes;
    }

    let eventByteSum = losslessByteSum;
    let eventCount = serializedLosslessCount;
    let includeBestEffort = admittedEvents.length > losslessEvents.length;

    if (includeBestEffort) {
      for (const [index, event] of stampedEvents.entries()) {
        if (isLossless(event)) {
          continue;
        }

        const json = JSON.stringify(event);
        const bytes = Buffer.byteLength(json, "utf8");
        const nextBytes = batchBytes(eventByteSum + bytes, eventCount + 1);

        if (
          this.#pendingLosslessBytes + this.#queuedEventBytes + nextBytes >
          MAX_PENDING_DRIVER_EVENT_BYTES
        ) {
          includeBestEffort = false;
          break;
        }

        serialized[index] = json;
        serializedBytes[index] = bytes;
        eventByteSum += bytes;
        eventCount += 1;
      }
    }

    if (!includeBestEffort && losslessEvents.length === 0) {
      return null;
    }

    if (!includeBestEffort) {
      eventByteSum = losslessByteSum;
      eventCount = serializedLosslessCount;
    }

    const id = Symbol(reason);
    const deferred = Promise.withResolvers<void>();
    const queuedEvents: QueuedEvent[] = [];

    for (const [index, event] of stampedEvents.entries()) {
      if (!includeBestEffort && !isLossless(event)) {
        continue;
      }

      queuedEvents.push({
        bytes: serializedBytes[index]!,
        event: JSON.parse(serialized[index]!) as DriverEventInput,
        owner: id,
        terminalLane: terminalBatch && isLossless(event),
      });
    }

    return {
      awaitPending: false,
      context,
      eventBytes: batchBytes(eventByteSum, eventCount),
      eventCount,
      events: queuedEvents,
      id,
      losslessBytes: batchBytes(losslessByteSum, serializedLosslessCount),
      losslessCount: serializedLosslessCount,
      promise: deferred.promise,
      reason,
      reject: deferred.reject,
      resolve: deferred.resolve,
      terminalBatch,
      terminalKey,
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
    const remainingLossless = queuedEvents.filter(({ event }) => isLossless(event));
    const ownerErrors = new Map<symbol, unknown>();
    const deadline = AbortSignal.timeout(DRIVER_EVENT_DELIVERY_TIMEOUT_MS);
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
        const lossless = isLossless(queuedEvents[index]!.event);
        let end = index + 1;

        while (end < queuedEvents.length && isLossless(queuedEvents[end]!.event) === lossless) {
          end += 1;
        }

        const sameDelivery = queuedEvents.slice(index, end);

        if (lossless) {
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

  #setPending(events: readonly QueuedEvent[], terminalKey: string | null): void {
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

    this.#pendingLosslessBytes = batchBytes(losslessByteSum, losslessCount);
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
