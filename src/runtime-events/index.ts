import type { DriverInstanceId, DriverId, EventId, SessionId, RunId } from "../protocol/id";
import { parseDriverId } from "../protocol/id";

export const RUNTIME_EVENT_SCHEMA_VERSION = "2026-05-26" as const;

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
  readonly completedAtMs: number;
  readonly path: RuntimeTimingPath;
  readonly phases: readonly RuntimeTimingPhase[];
  readonly runId: RunId | null;
  readonly sessionId: SessionId;
  readonly source: RuntimeTimingSource;
  readonly stage: RuntimeTimingStage;
  readonly startedAtMs: number;
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

const runtimeEventKindSet = new Set<string>(RUNTIME_EVENT_KINDS);
const runtimeEventActors = new Set<string>(["agent", "api", "driver", "system", "tool", "user"]);
const runtimeEventOrigins = new Set<string>([
  "api",
  "driver",
  "file",
  "runtime",
  "system",
  "viewer",
]);
const runtimeEventVisibilities = new Set<string>([
  "owner_debug",
  "participant",
  "public",
  "system_internal",
]);
const runtimeEventDeliveries = new Set<string>(["best_effort", "lossless"]);
const ownerDiagnosticRuntimeEventKinds = new Set<RuntimeEventKind>([
  "diagnostic.reported",
  "driver.log.recorded",
  "runtime.config.updated",
  "runtime.driver.updated",
  "runtime.provisioning.updated",
  "runtime.sandbox.released",
  "runtime.sandbox.updated",
  "runtime.transport.updated",
]);
const systemInternalRuntimeEventKinds = new Set<RuntimeEventKind>([
  "driver.command.updated",
  "driver.connected",
  "driver.disconnected",
  "driver.heartbeat",
  "driver.ready",
]);
const runtimeTimingPaths = new Set<string>(["cold", "prewarm", "unknown", "warm"]);
const runtimeTimingSources = new Set<string>(["api", "driver"]);
const runtimeTimingStages = new Set<string>([
  "context_hydration",
  "driver_backend",
  "driver_turn",
  "prepare_run",
  "prewarm",
]);
const runLifecycleStatuses = new Set<string>(["IDLE", "RESCHEDULING", "RUNNING", "TERMINATED"]);
const runStatuses = new Set<string>([
  "booting",
  "cancelled",
  "completed",
  "expired",
  "failed",
  "idle",
  "queued",
  "running",
  "waiting_input",
]);
const toolStatuses = new Set<string>(["completed", "failed", "running"]);
const fileChangeKinds = new Set<string>(["delete", "upsert"]);
const payloadIdentityFields = new Set<string>([
  "occurredAt",
  "receivedAt",
  "runId",
  "runtimeId",
  "sessionId",
  "traceId",
]);

export function isRuntimeEventRecord(value: unknown): value is RuntimeEventRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createRuntimeEvent<TPayload>(
  draft: RuntimeEventDraft<TPayload>,
): RuntimeEventEnvelope<TPayload> {
  return {
    actor: draft.actor ?? "driver",
    ...(draft.correlationId === undefined ? {} : { correlationId: draft.correlationId }),
    delivery: draft.delivery ?? "lossless",
    ...(draft.driverInstanceId === undefined ? {} : { driverInstanceId: draft.driverInstanceId }),
    id: draft.id,
    kind: draft.kind,
    ...(draft.native === undefined ? {} : { native: draft.native }),
    occurredAt: draft.occurredAt,
    origin: draft.origin ?? "driver",
    payload: draft.payload,
    ...(draft.receivedAt === undefined ? {} : { receivedAt: draft.receivedAt }),
    ...(draft.runId === undefined ? {} : { runId: draft.runId }),
    ...(draft.runtimeId === undefined ? {} : { runtimeId: draft.runtimeId }),
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    sessionId: draft.sessionId,
    ...(draft.sourceEventId === undefined ? {} : { sourceEventId: draft.sourceEventId }),
    ...(draft.traceId === undefined ? {} : { traceId: draft.traceId }),
    visibility: draft.visibility ?? getRuntimeEventDefaultVisibility(draft.kind),
  };
}

export function parseRuntimeEventEnvelope(value: unknown): RuntimeEventEnvelope {
  if (!isRuntimeEventRecord(value)) {
    throw new Error("Runtime event must be an object.");
  }

  if (value["schemaVersion"] !== RUNTIME_EVENT_SCHEMA_VERSION) {
    throw new Error("Runtime event schema version is unsupported.");
  }

  const kind = requireEnumValue(
    value,
    "kind",
    runtimeEventKindSet,
    "Runtime event",
  ) as RuntimeEventKind;
  const actor = requireEnumValue(
    value,
    "actor",
    runtimeEventActors,
    "Runtime event",
  ) as RuntimeEventActor;
  const origin = requireEnumValue(
    value,
    "origin",
    runtimeEventOrigins,
    "Runtime event",
  ) as RuntimeEventOrigin;
  const visibility = requireEnumValue(
    value,
    "visibility",
    runtimeEventVisibilities,
    "Runtime event",
  ) as RuntimeEventVisibility;
  const delivery = requireEnumValue(
    value,
    "delivery",
    runtimeEventDeliveries,
    "Runtime event",
  ) as RuntimeEventDelivery;
  const id = readDriverId(value, "id") as EventId;
  const sessionId = readDriverId(value, "sessionId") as SessionId;
  const occurredAt = requireString(value, "occurredAt", "Runtime event");

  assertTimestamp(occurredAt, "Runtime event occurrence time");

  if (!("payload" in value)) {
    throw new Error("Runtime event payload is required.");
  }

  const driverInstanceId = readOptionalDriverId(value, "driverInstanceId") as
    | DriverInstanceId
    | undefined;
  const receivedAt = readOptionalString(value, "receivedAt", "Runtime event");
  const runId = readOptionalDriverId(value, "runId") as RunId | undefined;
  const runtimeId = readOptionalString(value, "runtimeId", "Runtime event");
  const sourceEventId = readOptionalString(value, "sourceEventId", "Runtime event");
  const traceId = readOptionalString(value, "traceId", "Runtime event");

  if (receivedAt !== undefined) {
    assertTimestamp(receivedAt, "Runtime event received time");
  }

  const payload = admitRuntimeEventPayload(
    {
      ...(driverInstanceId === undefined ? {} : { driverInstanceId }),
      kind,
      ...(runId === undefined ? {} : { runId }),
      sessionId,
      ...(traceId === undefined ? {} : { traceId }),
    },
    value["payload"],
  );

  return {
    actor,
    delivery,
    ...(driverInstanceId === undefined ? {} : { driverInstanceId }),
    id,
    kind,
    ...(isRuntimeEventRecord(value["native"]) ? { native: parseNativeRef(value["native"]) } : {}),
    occurredAt,
    origin,
    payload,
    ...(receivedAt === undefined ? {} : { receivedAt }),
    ...(runId === undefined ? {} : { runId }),
    ...(runtimeId === undefined ? {} : { runtimeId }),
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    sessionId,
    ...(sourceEventId === undefined ? {} : { sourceEventId }),
    ...(traceId === undefined ? {} : { traceId }),
    visibility,
  };
}

export function isRuntimeEventEnvelope(value: unknown): value is RuntimeEventEnvelope {
  try {
    parseRuntimeEventEnvelope(value);
    return true;
  } catch {
    return false;
  }
}

export function ingestRuntimeEventInput(
  context: RuntimeEventBuildContext,
  input: unknown,
): RuntimeEventIngressOutcome {
  try {
    if (isRuntimeEventRecord(input) && "schemaVersion" in input) {
      return {
        event: parseRuntimeEventEnvelope(input),
        status: "accepted",
      };
    }

    if (!isRuntimeEventInputDraft(input)) {
      return {
        rejection: {
          code: "invalid_input",
          ...(readRuntimeEventInputKind(input) === undefined
            ? {}
            : { kind: readRuntimeEventInputKind(input) }),
          message: "Driver runtime event input must be a canonical runtime event draft.",
        },
        status: "rejected",
      };
    }

    return {
      event: parseRuntimeEventEnvelope(createRuntimeEnvelopeFromDraft(context, input)),
      status: "accepted",
    };
  } catch (error) {
    return {
      rejection: classifyRuntimeEventIngressError(input, error),
      status: "rejected",
    };
  }
}

export function toRuntimeEventInput(
  context: RuntimeEventBuildContext,
  input: unknown,
): RuntimeEventEnvelope[] {
  const outcome = ingestRuntimeEventInput(context, input);

  if (outcome.status === "accepted") {
    return [outcome.event];
  }

  throw new Error(outcome.rejection.message);
}

function createRuntimeEnvelopeFromDraft(
  context: RuntimeEventBuildContext,
  draft: RuntimeEventInputDraft,
): RuntimeEventEnvelope {
  const runId = context.runId ?? (context.draftRunIdPolicy === "ignore" ? undefined : draft.runId);

  return createRuntimeEvent({
    actor: draft.actor,
    correlationId: draft.correlationId,
    delivery: draft.delivery,
    driverInstanceId: context.driverInstanceId,
    id: draft.id ?? context.createId(),
    kind: draft.kind,
    native: draft.native,
    occurredAt: draft.occurredAt ?? context.occurredAt,
    origin: draft.origin ?? context.origin ?? "driver",
    payload: draft.payload,
    receivedAt: draft.receivedAt,
    runId,
    runtimeId: context.runtimeId,
    sessionId: context.sessionId,
    sourceEventId: draft.sourceEventId ?? context.sourceEventId,
    traceId: draft.traceId ?? context.traceId,
    visibility: draft.visibility,
  });
}

function getRuntimeEventDefaultVisibility(kind: RuntimeEventKind): RuntimeEventVisibility {
  if (ownerDiagnosticRuntimeEventKinds.has(kind)) {
    return "owner_debug";
  }

  if (systemInternalRuntimeEventKinds.has(kind)) {
    return "system_internal";
  }

  return "participant";
}

function admitRuntimeEventPayload(
  context: {
    readonly driverInstanceId?: DriverInstanceId | undefined;
    readonly kind: RuntimeEventKind;
    readonly runId?: RunId | undefined;
    readonly sessionId: SessionId;
    readonly traceId?: string | undefined;
  },
  payload: unknown,
): unknown {
  switch (context.kind) {
    case "diagnostic.reported": {
      const record = requirePayloadRecord(context.kind, payload);
      requireOptionalString(record, "code", context.kind);
      requireOptionalString(record, "message", context.kind);
      requireOptionalString(record, "severity", context.kind);
      return omitPayloadIdentity(record);
    }
    case "file.change.updated":
    case "file.changed": {
      const record = requirePayloadRecord(context.kind, payload);
      const changes = Array.isArray(record["changes"]) ? record["changes"] : [record];

      if (changes.length === 0) {
        throw new Error(`Runtime event ${context.kind} payload must include a file change.`);
      }

      for (const change of changes) {
        const fileChange = requirePayloadRecord(context.kind, change, "file change");
        requireString(fileChange, "path", context.kind);
        requireEnumValue(fileChange, "change", fileChangeKinds, context.kind);
      }

      return omitPayloadIdentity(record);
    }
    case "message.added":
    case "message.delta": {
      const record = requirePayloadRecord(context.kind, payload);

      if (!hasTextContent(record)) {
        throw new Error(`Runtime event ${context.kind} payload must include text content.`);
      }

      requireOptionalString(record, "messageId", context.kind);
      requireOptionalEnumValue(record, "role", new Set(["agent", "user"]), context.kind);
      return omitPayloadIdentity(record);
    }
    case "message.completed":
    case "message.started":
    case "thought.completed":
    case "thought.started": {
      const record = requirePayloadRecord(context.kind, payload);
      requireOptionalString(record, "messageId", context.kind);
      requireOptionalString(record, "thoughtId", context.kind);
      requireOptionalEnumValue(record, "role", new Set(["agent", "user"]), context.kind);
      return omitPayloadIdentity(record);
    }
    case "thought.delta": {
      const record = requirePayloadRecord(context.kind, payload);

      if (!hasTextContent(record)) {
        throw new Error("Runtime event thought.delta payload must include text content.");
      }

      requireOptionalString(record, "thoughtId", context.kind);
      return omitPayloadIdentity(record);
    }
    case "permission.requested": {
      if (context.driverInstanceId === undefined) {
        throw new Error("Runtime event permission.requested requires a driver instance ID.");
      }

      if (context.runId === undefined) {
        throw new Error("Runtime event permission.requested requires a run ID.");
      }

      const record = requirePayloadRecord(context.kind, payload);
      requireString(record, "requestId", context.kind);
      requireString(record, "title", context.kind);
      requireOptionalNullableString(record, "details", context.kind);
      requireOptionalNullableString(record, "targetItemId", context.kind);

      if (
        "options" in record &&
        record["options"] !== undefined &&
        !Array.isArray(record["options"])
      ) {
        throw new Error("Runtime event permission.requested payload options must be an array.");
      }

      if ("toolCall" in record && record["toolCall"] !== undefined && record["toolCall"] !== null) {
        const toolCall = requirePayloadRecord(context.kind, record["toolCall"], "toolCall");
        requireOptionalString(toolCall, "kind", context.kind);
        requireOptionalString(toolCall, "toolCallId", context.kind);
      }

      return omitPayloadIdentity(record);
    }
    case "permission.resolved": {
      const record = requirePayloadRecord(context.kind, payload);
      requireString(record, "requestId", context.kind);
      requireString(record, "outcome", context.kind);
      requireOptionalString(record, "optionId", context.kind);
      requireOptionalString(record, "optionKind", context.kind);
      return omitPayloadIdentity(record);
    }
    case "run.cancel.requested":
    case "run.cancelled":
    case "run.completed":
    case "run.dispatched":
    case "run.failed":
    case "run.queued":
    case "run.started":
    case "run.steered":
    case "run.waiting": {
      return readRunPayload(context, payload);
    }
    case "runtime.config.updated":
    case "runtime.driver.updated":
    case "runtime.provisioning.updated":
    case "runtime.sandbox.updated":
    case "runtime.transport.updated": {
      const record = requirePayloadRecord(context.kind, payload);
      requireString(record, "status", context.kind);

      if (context.kind === "runtime.transport.updated") {
        requireString(record, "channel", context.kind);
      } else {
        requireString(record, "phase", context.kind);
      }

      return omitPayloadIdentity(record);
    }
    case "runtime.timing.recorded": {
      return readTimingPayload(context, payload);
    }
    case "tool.call.updated": {
      const record = requirePayloadRecord(context.kind, payload);
      requireEnumValue(record, "status", toolStatuses, context.kind);
      requireString(record, "toolCallId", context.kind);
      requireOptionalContentString(record, "content", context.kind);
      requireOptionalString(record, "kind", context.kind);
      requireOptionalString(record, "messageId", context.kind);
      requireOptionalString(record, "parentMessageId", context.kind);
      requireOptionalString(record, "rawInput", context.kind);
      requireOptionalString(record, "rawOutput", context.kind);
      requireOptionalNullableString(record, "title", context.kind);
      return omitPayloadIdentity(record);
    }
    default: {
      return isRuntimeEventRecord(payload) ? omitPayloadIdentity(payload) : payload;
    }
  }
}

function readRunPayload(
  context: {
    readonly kind: RuntimeEventKind;
    readonly runId?: RunId | undefined;
    readonly traceId?: string | undefined;
  },
  payload: unknown,
): RuntimeEventRecord {
  const record = requirePayloadRecord(context.kind, payload);

  if (context.runId === undefined) {
    throw new Error(`Runtime event ${context.kind} requires a run ID.`);
  }

  requireOptionalEnumValue(record, "lifecycle", runLifecycleStatuses, context.kind);
  requireOptionalEnumValue(record, "status", runStatuses, context.kind);
  requireOptionalString(record, "inputSummary", context.kind);
  requireOptionalString(record, "reason", context.kind);
  requireOptionalString(record, "requestedBy", context.kind);
  requireOptionalString(record, "stopReason", context.kind);
  requireOptionalString(record, "targetRunId", context.kind);
  requireOptionalString(record, "userMessageId", context.kind);
  requireOptionalStringArray(record, "inputItemIds", context.kind);
  requireOptionalTimestampString(record, "completedAt", context.kind);
  requireOptionalTimestampString(record, "startedAt", context.kind);

  const admitted = omitPayloadIdentity(record);

  if ("run" in record && record["run"] !== undefined) {
    admitted["run"] = readRunView(context, record["run"]);
  }

  if ("error" in record && record["error"] !== undefined && record["error"] !== null) {
    admitted["error"] = readRunError(context.kind, record["error"], "error");
  }

  if (context.kind === "run.started" && !hasRunStartedAt(admitted)) {
    throw new Error("Runtime event run.started payload must include a start time.");
  }

  if (context.kind === "run.failed" && !isRuntimeEventRecord(admitted["error"])) {
    throw new Error("Runtime event run.failed payload must include an error.");
  }

  return admitted;
}

function readRunView(
  context: {
    readonly kind: RuntimeEventKind;
    readonly runId?: RunId | undefined;
    readonly traceId?: string | undefined;
  },
  value: unknown,
): RuntimeEventRecord {
  const record = requirePayloadRecord(context.kind, value, "run");
  requireEnumValue(record, "status", runStatuses, context.kind);

  return {
    completedAt: requireNullableTimestampString(
      record,
      "completedAt",
      context.kind,
      "run.completedAt",
    ),
    error:
      record["error"] === null ? null : readRunError(context.kind, record["error"], "run.error"),
    id: context.runId ?? null,
    startedAt: requireNullableTimestampString(record, "startedAt", context.kind, "run.startedAt"),
    status: record["status"],
    traceId: context.traceId ?? null,
  };
}

function readRunError(kind: RuntimeEventKind, value: unknown, label: string): RuntimeEventRecord {
  const record = requirePayloadRecord(kind, value, label);
  const details = record["details"];
  const recoverable = record["recoverable"];
  const retryable = record["retryable"];

  if (details !== undefined && !isRuntimeEventRecord(details)) {
    throw new Error(`Runtime event ${kind} payload ${label}.details must be an object.`);
  }

  if (recoverable !== undefined && typeof recoverable !== "boolean") {
    throw new Error(`Runtime event ${kind} payload ${label}.recoverable must be a boolean.`);
  }

  if (retryable !== undefined && typeof retryable !== "boolean") {
    throw new Error(`Runtime event ${kind} payload ${label}.retryable must be a boolean.`);
  }

  return {
    code: requireString(record, "code", kind),
    details: readPrimitiveRecord(details),
    message: requireString(record, "message", kind),
    retryable: retryable === true || recoverable === true,
  };
}

function readTimingPayload(
  context: {
    readonly kind: RuntimeEventKind;
    readonly runId?: RunId | undefined;
    readonly sessionId: SessionId;
    readonly traceId?: string | undefined;
  },
  payload: unknown,
): RuntimeTimingPayload {
  const record = requirePayloadRecord("runtime.timing.recorded", payload);
  const completedAtMs = requireNonNegativeNumber(record, "completedAtMs");
  const path = requireEnumValue(record, "path", runtimeTimingPaths, "runtime.timing.recorded");
  const source = requireEnumValue(
    record,
    "source",
    runtimeTimingSources,
    "runtime.timing.recorded",
  );
  const stage = requireEnumValue(record, "stage", runtimeTimingStages, "runtime.timing.recorded");
  const startedAtMs = requireNonNegativeNumber(record, "startedAtMs");
  const totalMs = requireNonNegativeNumber(record, "totalMs");
  const phases = readTimingPhases(record["phases"]);

  if (completedAtMs < startedAtMs) {
    throw new Error(
      "Runtime event runtime.timing.recorded payload completedAtMs must not precede startedAtMs.",
    );
  }

  return {
    completedAtMs,
    path: path as RuntimeTimingPath,
    phases,
    runId: context.runId ?? null,
    sessionId: context.sessionId,
    source: source as RuntimeTimingSource,
    stage: stage as RuntimeTimingStage,
    startedAtMs,
    totalMs,
    traceId: context.traceId ?? null,
  };
}

function readTimingPhases(value: unknown): RuntimeTimingPhase[] {
  if (!Array.isArray(value)) {
    throw new Error("Runtime event runtime.timing.recorded phases must be an array.");
  }

  return value.map((phase) => {
    const record = requirePayloadRecord("runtime.timing.recorded", phase, "phase");

    return {
      durationMs: requireNonNegativeNumber(record, "durationMs"),
      name: requireString(record, "name", "runtime.timing.recorded"),
    };
  });
}

function classifyRuntimeEventIngressError(
  input: unknown,
  error: unknown,
): RuntimeEventIngressRejection {
  const message = error instanceof Error ? error.message : "Runtime event input is malformed.";
  const kind = readRuntimeEventInputKind(input);

  if (message.includes("schema version")) {
    return {
      code: "unsupported_schema",
      ...(kind === undefined ? {} : { kind }),
      message,
    };
  }

  if (message.includes("kind is unsupported")) {
    return {
      code: "unsupported_kind",
      ...(kind === undefined ? {} : { kind }),
      message,
    };
  }

  return {
    code: message.includes("canonical runtime event draft") ? "invalid_input" : "malformed_event",
    ...(kind === undefined ? {} : { kind }),
    message,
  };
}

function isRuntimeEventInputDraft(value: unknown): value is RuntimeEventInputDraft {
  return isRuntimeEventRecord(value) && typeof value["kind"] === "string" && "payload" in value;
}

function readRuntimeEventInputKind(input: unknown): string | undefined {
  return isRuntimeEventRecord(input) && typeof input["kind"] === "string"
    ? input["kind"]
    : undefined;
}

function parseNativeRef(value: RuntimeEventRecord): RuntimeEventNativeRef {
  return {
    ...(readOptionalString(value, "eventName", "Runtime event native reference") === undefined
      ? {}
      : { eventName: readOptionalString(value, "eventName", "Runtime event native reference") }),
    ...(readOptionalString(value, "itemId", "Runtime event native reference") === undefined
      ? {}
      : { itemId: readOptionalString(value, "itemId", "Runtime event native reference") }),
    ...(readOptionalString(value, "protocolVersion", "Runtime event native reference") === undefined
      ? {}
      : {
          protocolVersion: readOptionalString(
            value,
            "protocolVersion",
            "Runtime event native reference",
          ),
        }),
    provider: requireString(value, "provider", "Runtime event native reference"),
    ...(readOptionalString(value, "requestId", "Runtime event native reference") === undefined
      ? {}
      : { requestId: readOptionalString(value, "requestId", "Runtime event native reference") }),
    ...(readOptionalNumber(value, "sequence", "Runtime event native reference") === undefined
      ? {}
      : { sequence: readOptionalNumber(value, "sequence", "Runtime event native reference") }),
    ...(readOptionalString(value, "threadId", "Runtime event native reference") === undefined
      ? {}
      : { threadId: readOptionalString(value, "threadId", "Runtime event native reference") }),
    ...(readOptionalString(value, "turnId", "Runtime event native reference") === undefined
      ? {}
      : { turnId: readOptionalString(value, "turnId", "Runtime event native reference") }),
  };
}

function hasTextContent(payload: RuntimeEventRecord): boolean {
  return (
    readString(payload, "contentDelta") !== undefined ||
    readString(payload, "content") !== undefined ||
    readTextBlocks(payload["content"]) !== null
  );
}

function readTextBlocks(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const text = value
    .flatMap((entry) => {
      if (!isRuntimeEventRecord(entry)) {
        return [];
      }

      const blockText = readString(entry, "text");
      return blockText === undefined ? [] : [blockText];
    })
    .join("");

  return text.length > 0 ? text : null;
}

function hasRunStartedAt(record: RuntimeEventRecord): boolean {
  if (readString(record, "startedAt") !== undefined) {
    return true;
  }

  const run = record["run"];
  return isRuntimeEventRecord(run) && readString(run, "startedAt") !== undefined;
}

function omitPayloadIdentity(payload: RuntimeEventRecord): RuntimeEventRecord {
  const result: RuntimeEventRecord = {};

  for (const [key, value] of Object.entries(payload)) {
    if (!payloadIdentityFields.has(key)) {
      result[key] = value;
    }
  }

  return result;
}

function requirePayloadRecord(
  kind: RuntimeEventKind | string,
  value: unknown,
  label = "payload",
): RuntimeEventRecord {
  if (!isRuntimeEventRecord(value)) {
    throw new Error(`Runtime event ${kind} ${label} must be an object.`);
  }

  return value;
}

function requireString(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): string {
  const entry = readString(value, field);

  if (entry === undefined) {
    throw new Error(`${label} ${field} must be a non-empty string.`);
  }

  return entry;
}

function readString(value: RuntimeEventRecord, field: string): string | undefined {
  const entry = value[field];
  return typeof entry === "string" && entry.length > 0 ? entry : undefined;
}

function requireEnumValue(
  value: RuntimeEventRecord,
  field: string,
  values: Set<string>,
  label: RuntimeEventKind | string,
): string {
  const entry = requireString(value, field, label);

  if (!values.has(entry)) {
    throw new Error(`${label} ${field} is unsupported.`);
  }

  return entry;
}

function requireOptionalEnumValue(
  value: RuntimeEventRecord,
  field: string,
  values: Set<string>,
  label: RuntimeEventKind | string,
): void {
  if (!(field in value) || value[field] === undefined) {
    return;
  }

  requireEnumValue(value, field, values, label);
}

function requireOptionalString(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): void {
  if (!(field in value) || value[field] === undefined) {
    return;
  }

  requireString(value, field, label);
}

function requireOptionalContentString(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): void {
  if (!(field in value) || value[field] === undefined || value[field] === null) {
    return;
  }

  const entry = value[field];

  if (typeof entry !== "string") {
    throw new Error(`${label} ${field} must be a string.`);
  }
}

function requireOptionalNullableString(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): void {
  if (!(field in value) || value[field] === undefined || value[field] === null) {
    return;
  }

  requireString(value, field, label);
}

function requireOptionalStringArray(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): void {
  if (!(field in value) || value[field] === undefined) {
    return;
  }

  if (!Array.isArray(value[field]) || !value[field].every((entry) => typeof entry === "string")) {
    throw new Error(`${label} ${field} must be an array of strings.`);
  }
}

function requireOptionalTimestampString(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): void {
  if (!(field in value) || value[field] === undefined) {
    return;
  }

  const timestamp = requireString(value, field, label);
  assertTimestamp(timestamp, `${label} ${field}`);
}

function requireNullableTimestampString(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
  nullableLabel: string,
): string | null {
  if (value[field] === null) {
    return null;
  }

  const timestamp = requireString(value, field, `${label} ${nullableLabel}`);
  assertTimestamp(timestamp, `${label} ${nullableLabel}`);
  return timestamp;
}

function requireNonNegativeNumber(value: RuntimeEventRecord, field: string): number {
  const entry = value[field];

  if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
    throw new Error(
      `Runtime event runtime.timing.recorded ${field} must be a non-negative number.`,
    );
  }

  return entry;
}

function readOptionalString(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): string | undefined {
  if (!(field in value) || value[field] === undefined) {
    return undefined;
  }

  return requireString(value, field, label);
}

function readOptionalNumber(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): number | undefined {
  if (!(field in value) || value[field] === undefined) {
    return undefined;
  }

  const entry = value[field];

  if (typeof entry !== "number" || !Number.isFinite(entry)) {
    throw new Error(`${label} ${field} must be a finite number.`);
  }

  return entry;
}

function readDriverId(value: RuntimeEventRecord, field: string): DriverId {
  return parseDriverId(value[field], `Runtime event ${field}`);
}

function readOptionalDriverId(value: RuntimeEventRecord, field: string): DriverId | undefined {
  if (!(field in value) || value[field] === undefined) {
    return undefined;
  }

  return parseDriverId(value[field], `Runtime event ${field}`);
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
}

function readPrimitiveRecord(value: unknown): Record<string, string | number | boolean | null> {
  if (!isRuntimeEventRecord(value)) {
    return {};
  }

  const result: Record<string, string | number | boolean | null> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      result[key] = entry;
    }
  }

  return result;
}
