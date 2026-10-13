import { isDeepStrictEqual } from "node:util";

import { DriverEventRejectedError } from "../../core/driver-runtime-io";
import type { DriverBootPayload } from "../../protocol/boot";
import type { DriverEventEnvelope, DriverEventInput } from "../../protocol/events";
import { createDriverId, parseDriverId, parseRunId } from "../../protocol/id";
import type { DriverInstanceId, EventId, SessionId, RunId } from "../../protocol/id";
import { isRuntimeEventEnvelope, toRuntimeEventInput } from "../../runtime-events";

function readExplicitSourceEventId(event: DriverEventInput): string | undefined {
  return typeof event.sourceEventId === "string" && event.sourceEventId.length > 0
    ? event.sourceEventId
    : undefined;
}

function readEventRunId(event: DriverEventInput, activeRunId: RunId | null): RunId | undefined {
  const { runId: eventRunId } = event;

  return eventRunId === null
    ? undefined
    : eventRunId === undefined
      ? (activeRunId ?? undefined)
      : parseRunId(eventRunId);
}

export function toDriverEventEnvelopes(
  payload: DriverBootPayload,
  event: DriverEventInput,
  activeRunId: RunId | null,
  retained?: DriverEventEnvelope,
): DriverEventEnvelope[] {
  const sourceEventId = readExplicitSourceEventId(event) ?? createDriverId();

  try {
    if (isRuntimeEventEnvelope(event)) {
      throw new Error("Driver event uplink accepts drafts only.");
    }

    const occurredAt = event.occurredAt ?? retained?.event.occurredAt ?? new Date().toISOString();
    const runId = readEventRunId(event, activeRunId);

    return toRuntimeEventInput(
      {
        createId: () => retained?.event.id ?? (createDriverId() as EventId),
        draftRunIdPolicy: "ignore",
        driverInstanceId: parseDriverId(
          payload.driverInstanceId,
          "Driver instance ID",
        ) as DriverInstanceId,
        occurredAt,
        runId,
        runtimeId: payload.runtime,
        sessionId: parseDriverId(
          payload.execution.configRevision.sessionId,
          "Session ID",
        ) as SessionId,
        sourceEventId,
      },
      event,
    ).map((canonicalEvent): DriverEventEnvelope => {
      if (retained !== undefined) {
        if (!isDeepStrictEqual(canonicalEvent, retained.event)) {
          throw new Error("Driver source event ID conflicts with a retained event.");
        }
        return retained;
      }
      return {
        event: canonicalEvent,
        eventId: canonicalEvent.sourceEventId ?? canonicalEvent.id,
        occurredAt: canonicalEvent.occurredAt,
      };
    });
  } catch (error) {
    throw new DriverEventRejectedError(sourceEventId, error);
  }
}
