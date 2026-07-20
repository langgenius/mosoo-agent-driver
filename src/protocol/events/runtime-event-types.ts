import type { DriverInstanceId, EventId, RunId, SessionId } from "../id";

export const RUNTIME_EVENT_SCHEMA_VERSION = "2026-05-26";

export const RUNTIME_EVENT_KINDS = [
  "account.limits.updated",
  "account.updated",
  "agent.task.updated",
  "auth.methods.updated",
  "auth.session.updated",
  "catalog.updated",
  "context.added",
  "context.compacted",
  "diagnostic.reported",
  "driver.command.updated",
  "driver.connected",
  "driver.disconnected",
  "driver.heartbeat",
  "driver.log.recorded",
  "driver.ready",
  "file.change.updated",
  "file.changed",
  "file.indexed",
  "hook.completed",
  "hook.started",
  "image.updated",
  "item.completed",
  "item.started",
  "item.updated",
  "mcp.oauth.completed",
  "mcp.server.updated",
  "mcp.tool.updated",
  "message.added",
  "message.completed",
  "message.delta",
  "message.started",
  "model.routing.updated",
  "model.verification.updated",
  "oauth.updated",
  "permission.requested",
  "permission.resolved",
  "permission.review.completed",
  "permission.review.started",
  "plan.updated",
  "process.exited",
  "process.output.delta",
  "realtime.audio.delta",
  "realtime.closed",
  "realtime.failed",
  "realtime.sdp.updated",
  "realtime.session.updated",
  "realtime.transcript.completed",
  "realtime.transcript.delta",
  "remote.control.updated",
  "review.updated",
  "run.cancel.requested",
  "run.cancelled",
  "run.completed",
  "run.dispatched",
  "run.failed",
  "run.queued",
  "run.started",
  "run.steered",
  "run.waiting",
  "runtime.capabilities.updated",
  "runtime.config.updated",
  "runtime.driver.updated",
  "runtime.provisioning.updated",
  "runtime.resume.updated",
  "runtime.sandbox.released",
  "runtime.sandbox.updated",
  "runtime.timing.recorded",
  "runtime.transport.updated",
  "search.session.completed",
  "search.session.updated",
  "session.archived",
  "session.capabilities.updated",
  "session.closed",
  "session.commands.updated",
  "session.config.updated",
  "session.created",
  "session.files.updated",
  "session.info.updated",
  "session.lifecycle.updated",
  "session.mode.updated",
  "session.models.updated",
  "session.readiness.updated",
  "session.resumed",
  "session.unarchived",
  "shell.command.updated",
  "terminal.created",
  "terminal.exited",
  "terminal.killed",
  "terminal.output.delta",
  "terminal.released",
  "thought.completed",
  "thought.delta",
  "thought.started",
  "tool.call.updated",
  "tool.dynamic.updated",
  "usage.updated",
  "user.input.requested",
  "user.input.resolved",
  "web.search.updated",
  "workspace.files.changed",
] as const;

export type RuntimeEventKind = (typeof RUNTIME_EVENT_KINDS)[number];
export type RuntimeEventActor = "agent" | "api" | "driver" | "system" | "tool" | "user";
export type RuntimeEventOrigin = "api" | "driver" | "file" | "runtime" | "system" | "viewer";
export type RuntimeEventVisibility = "owner_debug" | "participant" | "public" | "system_internal";
export type RuntimeEventDelivery = "best_effort" | "lossless";
export type RuntimeTimingPath = "cold" | "prewarm" | "unknown" | "warm";
export type RuntimeTimingSource = "api" | "driver";
export type RuntimeTimingStage =
  | "context_hydration"
  | "driver_backend"
  | "driver_turn"
  | "prepare_run"
  | "prewarm";

export type RuntimeEventRecord = Record<string, unknown>;

export interface RuntimeEventNativeRef {
  readonly eventName?: string | undefined;
  readonly itemId?: string | undefined;
  readonly protocolVersion?: string | undefined;
  readonly provider: string;
  readonly requestId?: string | undefined;
  readonly sequence?: number | undefined;
  readonly threadId?: string | undefined;
  readonly turnId?: string | undefined;
}

export interface RuntimeEventEnvelope<TPayload = unknown> {
  readonly actor: RuntimeEventActor;
  readonly correlationId?: string | undefined;
  readonly delivery: RuntimeEventDelivery;
  readonly driverInstanceId?: DriverInstanceId | undefined;
  readonly id: EventId;
  readonly kind: RuntimeEventKind;
  readonly native?: RuntimeEventNativeRef | undefined;
  readonly occurredAt: string;
  readonly origin: RuntimeEventOrigin;
  readonly payload: TPayload;
  readonly receivedAt?: string | undefined;
  readonly runId?: RunId | undefined;
  readonly runtimeId?: string | undefined;
  readonly schemaVersion: typeof RUNTIME_EVENT_SCHEMA_VERSION;
  readonly sessionId: SessionId;
  readonly sourceEventId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly visibility: RuntimeEventVisibility;
}

export interface RuntimeEventInputDraft {
  readonly actor?: RuntimeEventActor | undefined;
  readonly correlationId?: string | undefined;
  readonly delivery?: RuntimeEventDelivery | undefined;
  readonly driverInstanceId?: DriverInstanceId | undefined;
  readonly id?: EventId | undefined;
  readonly kind: RuntimeEventKind;
  readonly native?: RuntimeEventNativeRef | undefined;
  readonly occurredAt?: string | undefined;
  readonly origin?: RuntimeEventOrigin | undefined;
  readonly payload: unknown;
  readonly receivedAt?: string | undefined;
  readonly runId?: RunId | undefined;
  readonly runtimeId?: string | undefined;
  readonly sourceEventId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly visibility?: RuntimeEventVisibility | undefined;
}

export interface RuntimeEventDraft<TPayload = unknown> extends RuntimeEventInputDraft {
  readonly id: EventId;
  readonly occurredAt: string;
  readonly payload: TPayload;
  readonly sessionId: SessionId;
}

export interface RuntimeTimingPhase {
  readonly durationMs: number;
  readonly name: string;
}

export interface RuntimeTimingPayload {
  readonly completedAt: string;
  readonly path: RuntimeTimingPath;
  readonly phases: readonly RuntimeTimingPhase[];
  readonly runId: RunId | null;
  readonly sessionId: SessionId;
  readonly source: RuntimeTimingSource;
  readonly stage: RuntimeTimingStage;
  readonly startedAt: string;
  readonly totalMs: number;
  readonly traceId: string | null;
}

export interface RuntimeEventBuildContext {
  readonly createId: () => EventId;
  readonly draftRunIdPolicy?: "admit" | "ignore" | undefined;
  readonly driverInstanceId?: DriverInstanceId | undefined;
  readonly occurredAt: string;
  readonly origin?: RuntimeEventOrigin | undefined;
  readonly runId?: RunId | undefined;
  readonly runtimeId?: string | undefined;
  readonly sessionId: SessionId;
  readonly sourceEventId?: string | undefined;
  readonly traceId?: string | undefined;
}

export interface RuntimeEventIngressRejection {
  readonly code: "invalid_input" | "malformed_event" | "unsupported_kind" | "unsupported_schema";
  readonly kind?: string | undefined;
  readonly message: string;
}

export type RuntimeEventIngressOutcome =
  | {
      readonly event: RuntimeEventEnvelope;
      readonly status: "accepted";
    }
  | {
      readonly rejection: RuntimeEventIngressRejection;
      readonly status: "rejected";
    };
