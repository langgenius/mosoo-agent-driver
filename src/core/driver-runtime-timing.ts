import type { DriverEventInput } from "../protocol/events";
import type { RunId } from "../protocol/id";
import type { RuntimeTimingPayload, RuntimeTimingPhase } from "../runtime-events";

type DriverRuntimeTimingPath = RuntimeTimingPayload["path"];
type DriverRuntimeTimingStage = RuntimeTimingPayload["stage"];

interface TimingEventInput {
  readonly completedAt?: string;
  readonly native?: DriverEventInput["native"] | undefined;
  readonly path: DriverRuntimeTimingPath;
  readonly phases: readonly RuntimeTimingPhase[];
  readonly runId: RunId | null;
  readonly sessionId: string;
  readonly sourceEventId?: string | undefined;
  readonly stage: DriverRuntimeTimingStage;
  readonly startedAt: string;
  readonly traceId?: string | null;
}

export function toDurationMs(startedAtMs: number, completedAtMs: number = Date.now()): number {
  const durationMs = completedAtMs - startedAtMs;

  if (!Number.isFinite(durationMs)) {
    throw new Error("Driver runtime timing duration must be finite.");
  }

  return Math.max(0, Math.round(durationMs));
}

export function createTimingPhase(name: string, durationMs: number): RuntimeTimingPhase {
  if (!Number.isFinite(durationMs)) {
    throw new Error("Driver runtime timing phase duration must be finite.");
  }

  return {
    durationMs: Math.max(0, Math.round(durationMs)),
    name,
  };
}

export function createTimingEvent(input: TimingEventInput): DriverEventInput {
  const completedAt = input.completedAt ?? new Date().toISOString();
  const completedAtMs = Date.parse(completedAt);
  const startedAtMs = Date.parse(input.startedAt);

  return {
    kind: "runtime.timing.recorded",
    ...(input.native === undefined ? {} : { native: input.native }),
    occurredAt: completedAt,
    payload: {
      completedAt,
      path: input.path,
      phases: input.phases.map((phase) => createTimingPhase(phase.name, phase.durationMs)),
      runId: input.runId,
      sessionId: input.sessionId,
      source: "driver",
      stage: input.stage,
      startedAt: input.startedAt,
      totalMs: toDurationMs(startedAtMs, completedAtMs),
      traceId: input.traceId ?? null,
    },
    ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
    visibility: "owner_debug",
  };
}
