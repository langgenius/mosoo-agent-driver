import {
  assertDriverEventReceiptPrefix,
  DRIVER_EVENT_DELIVERY_TIMEOUT_MS,
  DriverEventRejectedError,
  pushLosslessEvents,
  withSourceEventIds,
} from "../core/driver-runtime-io";
import { createHash } from "node:crypto";
import { summarizeDriverEventBatch } from "../observability/driver-debug";
import type { DriverEventInput } from "../protocol/events";
import type { RunId } from "../protocol/id";
import type { DriverEventReceipt } from "../protocol/orpc";
import type { DriverRuntime } from "../protocol/runtime";
import { raceWithAbort } from "../utils/async";
import type { AgentDriverContext } from "../core/agent-driver-backend";
import {
  admitDriverEventPush,
  driverEventBatchBytes,
  isLosslessDriverEvent,
  isRunTerminalDriverEvent,
  losslessDriverEventRetryKey,
  preflightDriverEventPush,
  scopeDriverEvent,
  terminalDriverEventRetryKey,
  type QueuedDriverEvent,
} from "./driver-event-admission";
interface TerminalSettlement {
  readonly acceptedSourceEventIds: Set<string>;
  readonly activeRunId: RunId;
  readonly events: readonly DriverEventInput[];
  readonly key: string;
  signal: AbortSignal;
  nextIndex: number;
  rejection: unknown | null;
  task: Promise<void> | null;
}

function terminalSettlementKey(events: readonly DriverEventInput[]): string {
  const hash = createHash("sha256");

  for (const event of events) {
    const json = JSON.stringify(event);
    hash.update(String(Buffer.byteLength(json, "utf8")));
    hash.update(":");
    hash.update(json);
  }

  return hash.digest("hex");
}

interface QueuedPush {
  readonly awaitPending: boolean;
  readonly context: AgentDriverContext;
  readonly deliverySignal: AbortSignal | null;
  readonly eventBytes: number;
  readonly eventCount: number;
  readonly events: QueuedDriverEvent[];
  readonly id: symbol;
  readonly losslessBytes: number;
  readonly losslessCount: number;
  readonly promise: Promise<void>;
  readonly retrySourceEventIds: readonly string[];
  readonly reason: string;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: () => void;
  readonly terminalBatch: boolean;
  readonly terminalKey: string | null;
}

interface PendingAdoption {
  readonly events: DriverEventInput[];
  readonly sourceEventIds: string[];
}

interface EventSettlement {
  readonly promise: Promise<void>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: () => void;
}

class QueuedPushDeliveryError extends Error {
  readonly deliveryCause: unknown;
  readonly retainedSourceEventIds: readonly string[];

  constructor(cause: unknown, retainedSourceEventIds: readonly string[]) {
    super(cause instanceof Error ? cause.message : "Driver event delivery failed.", { cause });
    this.deliveryCause = cause;
    this.name = "QueuedPushDeliveryError";
    this.retainedSourceEventIds = retainedSourceEventIds;
  }
}

function deliveryCause(error: unknown): unknown {
  return error instanceof QueuedPushDeliveryError ? error.deliveryCause : error;
}

export class DriverEventPublisher {
  readonly #getSessionRef: () => string | null;
  readonly #runtime: DriverRuntime;
  #acceptedInFlightSourceEventIds = new Set<string>();
  #drainTask: Promise<void> | null = null;
  #eventSettlements = new Map<string, EventSettlement>();
  #inFlightEvents: readonly QueuedDriverEvent[] | null = null;
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
  #rejectedInFlight = new Map<string, unknown>();
  #terminalSettlement: TerminalSettlement | null = null;

  constructor(runtime: DriverRuntime, getSessionRef: () => string | null) {
    this.#getSessionRef = getSessionRef;
    this.#runtime = runtime;
  }

  async push(
    context: AgentDriverContext,
    reason: string,
    events: readonly DriverEventInput[],
  ): Promise<void> {
    if (events.some(isRunTerminalDriverEvent)) {
      throw new Error("Driver run terminals must use pushTerminal().");
    }

    try {
      return this.#submit(context, reason, events).catch((error: unknown) => {
        throw deliveryCause(error);
      });
    } catch (error) {
      this.#requestPendingDrain(context, reason);
      throw deliveryCause(error);
    }
  }

  async pushSession(
    context: AgentDriverContext,
    reason: string,
    events: readonly DriverEventInput[],
  ): Promise<void> {
    if (events.some((event) => event.runId !== undefined)) {
      throw new Error("Driver session events cannot target a run.");
    }
    if (events.some(isRunTerminalDriverEvent)) {
      throw new Error("Driver run terminals must use pushTerminal().");
    }

    await this.#terminalSettlement?.task;

    const settlement = this.#terminalSettlement;
    if (settlement !== null && settlement.nextIndex < settlement.events.length) {
      throw new Error("Driver event run terminal settlement slot is full.");
    }

    const sessionEvents = events.map((event): DriverEventInput => ({ ...event, runId: null }));
    try {
      return this.#submit(context, reason, sessionEvents, undefined, true).catch(
        (error: unknown) => {
          throw deliveryCause(error);
        },
      );
    } catch (error) {
      this.#requestPendingDrain(context, reason);
      throw deliveryCause(error);
    }
  }

  #submit(
    context: AgentDriverContext,
    reason: string,
    events: readonly DriverEventInput[],
    terminalSettlement?: TerminalSettlement,
    sessionScoped = false,
  ): Promise<void> {
    if (events.length === 0) {
      this.#requestPendingDrain(context, reason);
      return Promise.resolve();
    }

    const currentRunId = context.ports.eventSink.currentRunId();
    const activeRunId = sessionScoped ? null : currentRunId;
    const explicitRunIds = new Set(
      events.flatMap((event) =>
        event.runId === undefined || event.runId === null ? [] : [event.runId],
      ),
    );

    if (
      terminalSettlement === undefined &&
      [...explicitRunIds].some((runId) => runId !== activeRunId)
    ) {
      if (events.some(isLosslessDriverEvent)) {
        throw new Error("Driver event must target the active run.");
      }

      return Promise.resolve();
    }

    const settlement = this.#terminalSettlement;

    if (
      settlement !== null &&
      settlement !== terminalSettlement &&
      settlement.nextIndex >= settlement.events.length &&
      currentRunId !== settlement.activeRunId
    ) {
      this.#terminalSettlement = null;
    }

    const reserved = this.#terminalSettlement;

    if (reserved !== null && reserved !== terminalSettlement && !sessionScoped) {
      if (events.some(isLosslessDriverEvent)) {
        throw new Error(
          `Driver event run terminal settlement slot is full (active=${String(activeRunId)}, reserved=${String(reserved.activeRunId)}, task=${reserved.task === null ? "idle" : "set"}).`,
        );
      }

      return Promise.resolve();
    }

    if (
      this.#pendingTerminalKey !== null &&
      terminalDriverEventRetryKey(events, activeRunId) === this.#pendingTerminalKey
    ) {
      const retry = this.#createPendingRetry(
        context,
        reason,
        undefined,
        terminalSettlement?.signal,
      );
      this.#enqueue(retry);
      return retry.promise;
    }

    if (this.#pendingTerminalBatch || this.#queuedTerminalBatches > 0) {
      if (events.some(isLosslessDriverEvent)) {
        throw new Error("Driver event run terminal slot is full.");
      }

      this.#requestPendingDrain(context, reason);
      return Promise.resolve();
    }

    const candidates = [
      ...(this.#inFlightEvents ?? this.#pendingEvents),
      ...this.#queue.flatMap((queued) => queued.events),
    ];
    const adoption =
      terminalSettlement === undefined
        ? this.#adoptPending(events, activeRunId, candidates)
        : { events: [...events], sourceEventIds: [] };
    const entry =
      adoption.events.length === 0
        ? null
        : this.#admit(context, reason, adoption.events, activeRunId, terminalSettlement?.signal);

    if (entry === null && adoption.sourceEventIds.length === 0) {
      this.#requestPendingDrain(context, reason);
      return Promise.resolve();
    }

    if (entry !== null && terminalSettlement === undefined) {
      const unresolvedSourceEventIds = new Set(candidates.map(({ event }) => event.sourceEventId));

      if (entry.events.some(({ event }) => unresolvedSourceEventIds.has(event.sourceEventId))) {
        throw new Error("Driver source event ID conflicts with a pending event.");
      }
    }

    const deliveries: Promise<void>[] = [];

    if (entry !== null) {
      this.#enqueue(entry);
      if (entry.losslessCount > 0 || entry.terminalBatch) {
        deliveries.push(entry.promise);
      }
    }

    if (adoption.sourceEventIds.length > 0) {
      const acknowledged = Promise.all(
        adoption.sourceEventIds.map((sourceEventId) => {
          const settlement = this.#eventSettlements.get(sourceEventId);
          if (settlement === undefined) {
            throw new Error("Driver pending event settlement is missing.");
          }
          return settlement.promise;
        }),
      ).then(() => undefined);
      const retry = this.#createPendingRetry(
        context,
        reason,
        adoption.sourceEventIds,
        terminalSettlement?.signal,
      );
      this.#enqueue(retry);
      deliveries.push(Promise.race([acknowledged, retry.promise.then(() => acknowledged)]));
    }

    return deliveries.length === 0
      ? Promise.resolve()
      : Promise.all(deliveries).then(() => undefined);
  }

  #adoptPending(
    events: readonly DriverEventInput[],
    activeRunId: RunId | null,
    candidates: readonly QueuedDriverEvent[],
  ): PendingAdoption {
    const adopted = new Set<number>();
    const fresh: DriverEventInput[] = [];
    const sourceEventIds: string[] = [];

    for (const event of events) {
      if (!isLosslessDriverEvent(event)) {
        fresh.push(event);
        continue;
      }

      const explicitSourceEventId =
        typeof event.sourceEventId === "string" && event.sourceEventId.length > 0
          ? event.sourceEventId
          : undefined;
      if (explicitSourceEventId === undefined) {
        fresh.push(event);
        continue;
      }
      const candidateIndex = candidates.findIndex(
        ({ event: candidate }) => candidate.sourceEventId === explicitSourceEventId,
      );

      if (candidateIndex < 0) {
        fresh.push(event);
        continue;
      }

      const retryKey = losslessDriverEventRetryKey(event, activeRunId)!;
      if (adopted.has(candidateIndex)) {
        throw new Error("Driver event push requires unique source event IDs.");
      }

      const candidate = candidates[candidateIndex]!.event;
      if (losslessDriverEventRetryKey(candidate, activeRunId) !== retryKey) {
        throw new Error("Driver source event ID conflicts with a pending event.");
      }

      adopted.add(candidateIndex);
      sourceEventIds.push(candidate.sourceEventId!);
    }

    return { events: fresh, sourceEventIds };
  }

  async #retryPending(
    context: AgentDriverContext,
    reason: string,
    sourceEventIds: readonly string[],
    deliverySignal?: AbortSignal,
  ): Promise<void> {
    const retry = this.#createPendingRetry(context, reason, sourceEventIds, deliverySignal);
    this.#enqueue(retry);
    try {
      await retry.promise;
    } catch (error) {
      throw deliveryCause(error);
    }
  }

  pushTerminal(
    context: AgentDriverContext,
    reason: string,
    closures: readonly DriverEventInput[],
    terminal: DriverEventInput,
  ): Promise<void> {
    if (!isRunTerminalDriverEvent(terminal)) {
      throw new Error("Driver terminal push requires a run terminal event.");
    }

    if (!isLosslessDriverEvent(terminal)) {
      throw new Error("Driver terminal push requires lossless events.");
    }

    for (const closure of closures) {
      if (!isLosslessDriverEvent(closure)) {
        throw new Error("Driver terminal push requires lossless events.");
      }

      if (isRunTerminalDriverEvent(closure)) {
        throw new Error("Driver terminal closures cannot contain a run terminal event.");
      }
    }

    const activeRunId = context.ports.eventSink.currentRunId();

    if (activeRunId === null) {
      throw new Error("Driver terminal push requires an active run.");
    }

    if (terminal.runId !== undefined && terminal.runId !== activeRunId) {
      throw new Error("Driver terminal push must target the active run.");
    }

    const targetRunId = activeRunId;
    const settlementEvents = [...closures, terminal];

    if (
      settlementEvents.some((event) => event.runId !== undefined && event.runId !== targetRunId)
    ) {
      throw new Error("Driver terminal push requires every event to target the same run.");
    }

    preflightDriverEventPush(settlementEvents, targetRunId);
    const scopedEvents = settlementEvents.map((event) => scopeDriverEvent(event, targetRunId));
    const key = terminalSettlementKey(scopedEvents);
    const current = this.#terminalSettlement;

    if (current !== null) {
      if (current.key === key && current.task !== null) {
        return current.task;
      }

      if (current.key === key) {
        current.signal = AbortSignal.timeout(DRIVER_EVENT_DELIVERY_TIMEOUT_MS);
        return this.#startTerminalSettlement(context, reason, current);
      }

      const settled = current.nextIndex >= current.events.length;
      const activeRunChanged = activeRunId !== current.activeRunId;
      if (!settled || !activeRunChanged) {
        throw new Error("Driver event run terminal settlement slot is full.");
      }

      this.#terminalSettlement = null;
    }

    const retryCandidates = [
      ...(this.#inFlightEvents ?? this.#pendingEvents),
      ...this.#queue.flatMap((entry) => entry.events),
    ].filter(
      ({ event }, index, candidates) =>
        candidates.findIndex(
          ({ event: candidate }) => candidate.sourceEventId === event.sourceEventId,
        ) === index,
    );
    const adoptedPending = new Set<number>();
    const frozenClosures = scopedEvents.slice(0, -1).map((event) => {
      if (event.sourceEventId !== undefined) {
        return event;
      }

      const retryKey = losslessDriverEventRetryKey(event, targetRunId);
      const pendingIndex = retryCandidates.findIndex(
        ({ event: pending }, index) =>
          !adoptedPending.has(index) &&
          losslessDriverEventRetryKey(pending, targetRunId) === retryKey,
      );

      if (pendingIndex < 0) {
        return event;
      }

      adoptedPending.add(pendingIndex);
      return {
        ...event,
        sourceEventId: retryCandidates[pendingIndex]!.event.sourceEventId,
      };
    });
    const events = structuredClone(withSourceEventIds([...frozenClosures, scopedEvents.at(-1)!]));

    if (new Set(events.map((event) => event.sourceEventId)).size !== events.length) {
      throw new Error("Driver terminal push requires unique source event IDs.");
    }

    for (const [index, event] of events.entries()) {
      const candidate = retryCandidates.find(
        ({ event: pending }) => pending.sourceEventId === event.sourceEventId,
      );

      if (
        candidate !== undefined &&
        (index === events.length - 1 ||
          losslessDriverEventRetryKey(candidate.event, targetRunId) !==
            losslessDriverEventRetryKey(event, targetRunId))
      ) {
        throw new Error("Driver terminal source event ID conflicts with a pending event.");
      }
    }

    if (this.#terminalSettlement !== null) {
      if (this.#terminalSettlement.key !== key) {
        throw new Error("Driver event run terminal settlement slot is full.");
      }
    }

    const rejectedSourceEventId = events.find(
      ({ sourceEventId }) =>
        sourceEventId !== undefined && this.#rejectedInFlight.has(sourceEventId),
    )?.sourceEventId;
    const settlement: TerminalSettlement = {
      acceptedSourceEventIds: new Set(
        events
          .map((event) => event.sourceEventId!)
          .filter((sourceEventId) => this.#acceptedInFlightSourceEventIds.has(sourceEventId)),
      ),
      activeRunId,
      events,
      key,
      nextIndex: 0,
      rejection:
        rejectedSourceEventId === undefined
          ? null
          : this.#rejectedInFlight.get(rejectedSourceEventId)!,
      signal: AbortSignal.timeout(DRIVER_EVENT_DELIVERY_TIMEOUT_MS),
      task: null,
    };
    this.#terminalSettlement = settlement;
    return this.#startTerminalSettlement(context, reason, settlement);
  }

  #startTerminalSettlement(
    context: AgentDriverContext,
    reason: string,
    settlement: TerminalSettlement,
  ): Promise<void> {
    const task = this.#deliverTerminalSettlement(context, reason, settlement).catch(
      (error: unknown) => {
        if (settlement.task === task) {
          settlement.task = null;
        }

        throw error;
      },
    );
    settlement.task = task;
    return task;
  }

  async #deliverTerminalSettlement(
    context: AgentDriverContext,
    reason: string,
    settlement: TerminalSettlement,
  ): Promise<void> {
    const priorDrain = this.#drainTask;

    if (priorDrain !== null) {
      await raceWithAbort(priorDrain, settlement.signal);
    }

    if (settlement.rejection !== null) {
      throw settlement.rejection;
    }

    this.#advanceTerminalSettlement(settlement);

    while (settlement.nextIndex < settlement.events.length) {
      const terminal = settlement.nextIndex === settlement.events.length - 1;
      const event = settlement.events[settlement.nextIndex]!;
      const deliveryReason = terminal ? reason : `${reason}.items`;
      const retryReason = `${deliveryReason}.retry`;
      let delivery: Promise<void>;

      try {
        const retained = terminal
          ? undefined
          : this.#pendingEvents.find(
              ({ event: pending }) => pending.sourceEventId === event.sourceEventId,
            );
        delivery =
          retained === undefined
            ? this.#submit(context, deliveryReason, [event], settlement)
            : this.#retryPending(
                context,
                retryReason,
                [retained.event.sourceEventId!],
                settlement.signal,
              );
      } catch (error) {
        this.#requestPendingDrain(context, deliveryReason);
        throw error;
      }

      try {
        await delivery;
      } catch (error) {
        if (
          !(error instanceof QueuedPushDeliveryError) ||
          error.retainedSourceEventIds.length === 0
        ) {
          throw deliveryCause(error);
        }

        await this.#retryPending(
          context,
          retryReason,
          error.retainedSourceEventIds,
          settlement.signal,
        );
      }
    }
  }

  #enqueue(entry: QueuedPush): void {
    for (const { event } of entry.events) {
      const sourceEventId = event.sourceEventId;
      if (
        !isLosslessDriverEvent(event) ||
        sourceEventId === undefined ||
        this.#eventSettlements.has(sourceEventId)
      ) {
        continue;
      }

      const settlement = Promise.withResolvers<void>();
      void settlement.promise.catch(() => {});
      this.#eventSettlements.set(sourceEventId, settlement);
    }

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

  #createPendingRetry(
    context: AgentDriverContext,
    reason: string,
    sourceEventIds: readonly string[] = this.#pendingEvents.map(
      ({ event }) => event.sourceEventId!,
    ),
    deliverySignal?: AbortSignal,
  ): QueuedPush {
    const deferred = Promise.withResolvers<void>();

    return {
      awaitPending: true,
      context,
      deliverySignal: deliverySignal ?? null,
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
      retrySourceEventIds: sourceEventIds,
      terminalBatch: false,
      terminalKey: null,
    };
  }

  #admit(
    context: AgentDriverContext,
    reason: string,
    events: readonly DriverEventInput[],
    activeRunId: RunId | null,
    deliverySignal?: AbortSignal,
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
      deliverySignal: deliverySignal ?? null,
      id,
      promise: deferred.promise,
      reason,
      reject: deferred.reject,
      resolve: deferred.resolve,
      retrySourceEventIds: [],
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
    const retryDeliverySignals = new Map<string, AbortSignal>();
    const deliverySignalsByOwner = new Map<symbol, AbortSignal>();

    for (const entry of entries) {
      if (entry.deliverySignal === null) {
        continue;
      }

      deliverySignalsByOwner.set(entry.id, entry.deliverySignal);

      if (entry.awaitPending) {
        for (const sourceEventId of entry.retrySourceEventIds) {
          retryDeliverySignals.set(sourceEventId, entry.deliverySignal);
        }
      }
    }

    const queuedEvents = [...this.#pendingEvents, ...entries.flatMap((entry) => entry.events)];
    this.#inFlightEvents = queuedEvents;
    this.#acceptedInFlightSourceEventIds = new Set();
    this.#rejectedInFlight = new Map();
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
        const deliverySignal = sameDelivery
          .map(({ event, owner }) =>
            owner === null
              ? retryDeliverySignals.get(event.sourceEventId!)
              : deliverySignalsByOwner.get(owner),
          )
          .find((signal) => signal !== undefined);

        if (lossless) {
          const deadline = deliverySignal ?? AbortSignal.timeout(DRIVER_EVENT_DELIVERY_TIMEOUT_MS);
          let remaining = sameDelivery;

          while (remaining.length > 0) {
            let acceptedInAttempt = 0;

            try {
              await pushLosslessEvents(
                context.ports.eventSink,
                remaining.map(({ event }) => event),
                (receipts) => {
                  const acceptedEvents = remaining
                    .slice(acceptedInAttempt, acceptedInAttempt + receipts.length)
                    .map(({ event }) => event);
                  acceptedInAttempt += receipts.length;
                  acceptedEventCount += receipts.length;
                  this.#rememberAcceptedReceipts(receipts, acceptedEvents);
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
              this.#rejectedInFlight.set(error.sourceEventId, error);
              this.#eventSettlements.get(error.sourceEventId)?.reject(error);

              const settlement = this.#terminalSettlement;

              if (
                settlement !== null &&
                settlement.events.some(
                  (event) => event.sourceEventId === rejected!.event.sourceEventId,
                )
              ) {
                settlement.rejection ??= error;
              }

              for (const entry of entries) {
                if (
                  entry.awaitPending &&
                  entry.retrySourceEventIds.includes(error.sourceEventId) &&
                  !ownerErrors.has(entry.id)
                ) {
                  ownerErrors.set(entry.id, error);
                }
              }

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
            this.#rememberAcceptedReceipts(
              result.accepted,
              events.slice(0, result.accepted.length),
            );
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
    const pendingSourceEventIds = new Set(
      this.#pendingEvents.map(({ event }) => event.sourceEventId),
    );

    for (const { event } of queuedEvents) {
      const sourceEventId = event.sourceEventId;
      if (sourceEventId !== undefined && !pendingSourceEventIds.has(sourceEventId)) {
        this.#eventSettlements.delete(sourceEventId);
      }
    }

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
      const retainedSourceEventIds = remainingLossless
        .filter(
          ({ event, owner }) =>
            owner === entry.id ||
            (entry.awaitPending && entry.retrySourceEventIds.includes(event.sourceEventId!)),
        )
        .map(({ event }) => event.sourceEventId!);
      const error =
        ownerErrors.get(entry.id) ??
        (retainedSourceEventIds.length > 0
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
        entry.reject(new QueuedPushDeliveryError(error, retainedSourceEventIds));
      }
    }

    this.#inFlightEvents = null;
    this.#acceptedInFlightSourceEventIds.clear();
    this.#rejectedInFlight.clear();
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

  #rememberAcceptedReceipts(
    receipts: readonly DriverEventReceipt[],
    events: readonly DriverEventInput[],
  ): void {
    for (const receipt of receipts) {
      this.#lastAcceptedSeq = Math.max(this.#lastAcceptedSeq, receipt.seq);
    }

    for (const event of events) {
      if (event.sourceEventId !== undefined) {
        this.#acceptedInFlightSourceEventIds.add(event.sourceEventId);
        this.#eventSettlements.get(event.sourceEventId)?.resolve();
      }
    }

    const settlement = this.#terminalSettlement;

    if (settlement === null) {
      return;
    }

    for (const event of events) {
      const sourceEventId = event.sourceEventId;

      if (
        sourceEventId !== undefined &&
        settlement.events.some((candidate) => candidate.sourceEventId === sourceEventId)
      ) {
        settlement.acceptedSourceEventIds.add(sourceEventId);
      }
    }

    this.#advanceTerminalSettlement(settlement);
  }

  #advanceTerminalSettlement(settlement: TerminalSettlement): void {
    while (
      settlement.acceptedSourceEventIds.delete(
        settlement.events[settlement.nextIndex]?.sourceEventId ?? "",
      )
    ) {
      settlement.nextIndex += 1;
    }
  }
}
