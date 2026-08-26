import { withSourceEventIds } from "../core/driver-runtime-io";
import type { DriverEventInput } from "../protocol/events";
import type { RunId } from "../protocol/id";

const MAX_PENDING_DRIVER_EVENTS = 1_024;
const MAX_PENDING_DRIVER_EVENT_BYTES = 32 * 1_024 * 1_024;
const MAX_RUN_TERMINAL_BATCH_BYTES = 1_024 * 1_024;

export interface QueuedDriverEvent {
  readonly bytes: number;
  readonly event: DriverEventInput;
  readonly owner: symbol | null;
  readonly terminalLane: boolean;
}

export interface DriverEventAdmissionState {
  readonly pendingLosslessBytes: number;
  readonly pendingLosslessCount: number;
  readonly pendingTerminalBatch: boolean;
  readonly queuedEventBytes: number;
  readonly queuedEventCount: number;
  readonly queuedLosslessBytes: number;
  readonly queuedLosslessCount: number;
  readonly queuedTerminalBatches: number;
}

export interface AdmittedDriverEventPush {
  readonly eventBytes: number;
  readonly eventCount: number;
  readonly events: QueuedDriverEvent[];
  readonly losslessBytes: number;
  readonly losslessCount: number;
  readonly terminalBatch: boolean;
  readonly terminalKey: string | null;
}

const EMPTY_DRIVER_EVENT_ADMISSION_STATE: DriverEventAdmissionState = {
  pendingLosslessBytes: 0,
  pendingLosslessCount: 0,
  pendingTerminalBatch: false,
  queuedEventBytes: 0,
  queuedEventCount: 0,
  queuedLosslessBytes: 0,
  queuedLosslessCount: 0,
  queuedTerminalBatches: 0,
};

export function preflightDriverEventPush(
  events: readonly DriverEventInput[],
  activeRunId: RunId | null,
): void {
  for (const event of events) {
    admitDriverEventPush(
      [event],
      activeRunId,
      Symbol("driver-event-preflight"),
      EMPTY_DRIVER_EVENT_ADMISSION_STATE,
    );
  }
}

export function driverEventBatchBytes(bytes: number, count: number): number {
  return count === 0 ? 0 : bytes + count + 1;
}

export function isLosslessDriverEvent(event: DriverEventInput): boolean {
  return event.delivery !== "best_effort";
}

export function losslessDriverEventRetryKey(
  event: DriverEventInput,
  activeRunId: RunId | null,
): string | null {
  if (!isLosslessDriverEvent(event)) {
    return null;
  }

  const { sourceEventId: _, ...scoped } = scopeDriverEvent(event, activeRunId);
  return JSON.stringify(scoped);
}

export function isRunTerminalDriverEvent(event: DriverEventInput): boolean {
  return (
    event.kind === "run.cancelled" || event.kind === "run.completed" || event.kind === "run.failed"
  );
}

export function scopeDriverEvent(
  event: DriverEventInput,
  activeRunId: RunId | null,
): DriverEventInput {
  const { runId, sourceEventId, ...content } = event;
  const frozenRunId = runId === undefined ? activeRunId : runId;
  const explicitSourceId =
    typeof sourceEventId === "string" && sourceEventId.length > 0 ? sourceEventId : null;

  return {
    ...content,
    ...(explicitSourceId === null ? {} : { sourceEventId: explicitSourceId }),
    ...(runId === null ? { runId: null } : frozenRunId === null ? {} : { runId: frozenRunId }),
  } as DriverEventInput;
}

export function terminalDriverEventRetryKey(
  events: readonly DriverEventInput[],
  activeRunId: RunId | null,
): string | null {
  const losslessEvents = events.filter(isLosslessDriverEvent);

  if (
    losslessEvents.length === 0 ||
    losslessEvents.filter(isRunTerminalDriverEvent).length !== 1 ||
    !isRunTerminalDriverEvent(losslessEvents.at(-1)!)
  ) {
    return null;
  }

  const key = JSON.stringify(losslessEvents.map((event) => scopeDriverEvent(event, activeRunId)));
  return Buffer.byteLength(key, "utf8") <= MAX_RUN_TERMINAL_BATCH_BYTES ? key : null;
}

export function admitDriverEventPush(
  events: readonly DriverEventInput[],
  activeRunId: RunId | null,
  owner: symbol,
  state: DriverEventAdmissionState,
): AdmittedDriverEventPush | null {
  const losslessEvents = events.filter(isLosslessDriverEvent);
  const runTerminals = losslessEvents.filter(isRunTerminalDriverEvent);
  const terminalBatch = runTerminals.length > 0;

  if (runTerminals.length > 1) {
    throw new Error("Driver event run terminal slot is full.");
  }

  if (terminalBatch) {
    if (state.pendingTerminalBatch || state.queuedTerminalBatches > 0) {
      throw new Error("Driver event run terminal slot is full.");
    }

    if (!isRunTerminalDriverEvent(losslessEvents.at(-1)!)) {
      throw new Error("Driver event run terminal must be the final lossless event.");
    }
  }

  const losslessCount = terminalBatch ? 0 : losslessEvents.length;

  if (
    state.pendingLosslessCount + state.queuedLosslessCount + losslessCount >
    MAX_PENDING_DRIVER_EVENTS
  ) {
    throw new Error(`Driver event queue exceeds ${MAX_PENDING_DRIVER_EVENTS} events.`);
  }

  let admittedEvents: readonly DriverEventInput[];

  if (terminalBatch) {
    admittedEvents = losslessEvents;
  } else if (losslessEvents.length === 0) {
    const capacity =
      MAX_PENDING_DRIVER_EVENTS - state.pendingLosslessCount - state.queuedEventCount;

    if (capacity <= 0) {
      return null;
    }

    admittedEvents = events.slice(0, capacity);
  } else {
    const bestEffortCount = events.length - losslessEvents.length;
    const includeBestEffort =
      state.pendingLosslessCount + state.queuedEventCount + losslessCount + bestEffortCount <=
      MAX_PENDING_DRIVER_EVENTS;
    admittedEvents = includeBestEffort ? events : losslessEvents;
  }

  const frozenEvents = admittedEvents.map((event) => scopeDriverEvent(event, activeRunId));
  const terminalKey = terminalBatch ? JSON.stringify(frozenEvents) : null;
  const stampedEvents = withSourceEventIds(frozenEvents);

  if (new Set(stampedEvents.map((event) => event.sourceEventId)).size !== stampedEvents.length) {
    throw new Error("Driver event push requires unique source event IDs.");
  }

  const serialized: (string | undefined)[] = [];
  const serializedBytes: (number | undefined)[] = [];
  let losslessByteSum = 0;
  let serializedLosslessCount = 0;
  let terminalByteSum = 0;
  let terminalCount = 0;

  for (const [index, event] of stampedEvents.entries()) {
    if (!isLosslessDriverEvent(event)) {
      continue;
    }

    const json = JSON.stringify(event);
    const bytes = Buffer.byteLength(json, "utf8");

    if (terminalBatch) {
      terminalByteSum += bytes;
      terminalCount += 1;

      if (driverEventBatchBytes(terminalByteSum, terminalCount) > MAX_RUN_TERMINAL_BATCH_BYTES) {
        throw new Error(
          `Driver event run terminal batch exceeds ${MAX_RUN_TERMINAL_BATCH_BYTES} UTF-8 bytes.`,
        );
      }
    } else {
      losslessByteSum += bytes;
      serializedLosslessCount += 1;

      if (
        state.pendingLosslessBytes +
          state.queuedLosslessBytes +
          driverEventBatchBytes(losslessByteSum, serializedLosslessCount) >
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
      if (isLosslessDriverEvent(event)) {
        continue;
      }

      const json = JSON.stringify(event);
      const bytes = Buffer.byteLength(json, "utf8");
      const nextBytes = driverEventBatchBytes(eventByteSum + bytes, eventCount + 1);

      if (
        state.pendingLosslessBytes + state.queuedEventBytes + nextBytes >
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

  const queuedEvents: QueuedDriverEvent[] = [];

  for (const [index, event] of stampedEvents.entries()) {
    if (!includeBestEffort && !isLosslessDriverEvent(event)) {
      continue;
    }

    queuedEvents.push({
      bytes: serializedBytes[index]!,
      event: JSON.parse(serialized[index]!) as DriverEventInput,
      owner,
      terminalLane: terminalBatch && isLosslessDriverEvent(event),
    });
  }

  return {
    eventBytes: driverEventBatchBytes(eventByteSum, eventCount),
    eventCount,
    events: queuedEvents,
    losslessBytes: driverEventBatchBytes(losslessByteSum, serializedLosslessCount),
    losslessCount: serializedLosslessCount,
    terminalBatch,
    terminalKey,
  };
}
