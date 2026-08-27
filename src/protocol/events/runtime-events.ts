import { jsonValueSchema } from "../../contract/common";
import type { DriverInstanceId, EventId, SessionId, RunId } from "../id";
import {
  RUNTIME_EVENT_KINDS,
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEventActor,
  type RuntimeEventBuildContext,
  type RuntimeEventDelivery,
  type RuntimeEventDraft,
  type RuntimeEventEnvelope,
  type RuntimeEventIngressOutcome,
  type RuntimeEventIngressRejection,
  type RuntimeEventInputDraft,
  type RuntimeEventKind,
  type RuntimeEventOrigin,
  type RuntimeEventRecord,
  type RuntimeEventVisibility,
  type RuntimeTimingPath,
  type RuntimeTimingPayload,
  type RuntimeTimingPhase,
  type RuntimeTimingSource,
  type RuntimeTimingStage,
} from "./runtime-event-types";
import {
  assertTimestamp,
  hasRunStartedAt,
  hasTextContent,
  isRuntimeEventRecord,
  omitPayloadIdentity,
  parseNativeRef,
  readDriverId,
  readOptionalDriverId,
  readOptionalString,
  readPrimitiveRecord,
  requireEnumValue,
  requireNonNegativeInt,
  requireNullableTimestamp,
  requireOptionalBoolean,
  requireOptionalContentString,
  requireOptionalEnumValue,
  requireOptionalNullableString,
  requireOptionalString,
  requireOptionalStringArray,
  requireOptionalTimestamp,
  requirePayloadRecord,
  requireString,
  requireTimestamp,
} from "./runtime-event-validation";

export * from "./runtime-event-types";

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
const toolStatuses = new Set<string>(["cancelled", "completed", "failed", "running"]);
const fileChangeKinds = new Set<string>(["delete", "upsert"]);
function createRuntimeEvent<TPayload>(
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
    visibility: draft.visibility ?? defaultVisibility(draft.kind),
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

  const correlationId = readOptionalString(value, "correlationId", "Runtime event");
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
    ...(correlationId === undefined ? {} : { correlationId }),
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
      event: parseRuntimeEventEnvelope(eventFromDraft(context, input)),
      status: "accepted",
    };
  } catch (error) {
    return {
      rejection: classifyIngressError(input, error),
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

function eventFromDraft(
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

function defaultVisibility(kind: RuntimeEventKind): RuntimeEventVisibility {
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
  let canonicalPayload: unknown;

  try {
    canonicalPayload = structuredClone(payload);
  } catch {
    throw new Error(`Runtime event ${context.kind} payload must be JSON-serializable.`);
  }

  if (!jsonValueSchema.safeParse(canonicalPayload).success) {
    throw new Error(`Runtime event ${context.kind} payload must be JSON-serializable.`);
  }

  switch (context.kind) {
    case "agent.task.updated": {
      const record = requirePayloadRecord(context.kind, canonicalPayload);
      requireString(record, "taskId", context.kind);
      requireOptionalBoolean(record, "active", context.kind);
      requireOptionalEnumValue(record, "status", toolStatuses, context.kind);
      for (const field of ["activityKind", "agentId", "agentPath", "taskType", "title"]) {
        requireOptionalString(record, field, context.kind);
      }
      return omitPayloadIdentity(record);
    }
    case "diagnostic.reported": {
      const record = requirePayloadRecord(context.kind, canonicalPayload);
      requireOptionalString(record, "code", context.kind);
      requireOptionalString(record, "message", context.kind);
      requireOptionalString(record, "severity", context.kind);
      return omitPayloadIdentity(record);
    }
    case "file.change.updated":
    case "file.changed": {
      const record = requirePayloadRecord(context.kind, canonicalPayload);
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
      const record = requirePayloadRecord(context.kind, canonicalPayload);

      if (!hasTextContent(record)) {
        throw new Error(`Runtime event ${context.kind} payload must include text content.`);
      }

      requireOptionalString(record, "messageId", context.kind);
      requireOptionalEnumValue(
        record,
        "level",
        new Set(["info", "notice", "suggestion", "warning"]),
        context.kind,
      );
      requireOptionalBoolean(record, "preventContinuation", context.kind);
      requireOptionalEnumValue(record, "role", new Set(["agent", "user"]), context.kind);
      requireOptionalString(record, "subtype", context.kind);
      requireOptionalString(record, "toolCallId", context.kind);

      requireOptionalEnumValue(record, "phase", new Set(["commentary", "final"]), context.kind);
      return omitPayloadIdentity(record);
    }
    case "message.cancelled":
    case "message.completed":
    case "message.started":
    case "thought.cancelled":
    case "thought.completed":
    case "thought.started": {
      const record = requirePayloadRecord(context.kind, canonicalPayload);
      requireOptionalString(record, "messageId", context.kind);
      requireOptionalString(record, "thoughtId", context.kind);
      requireOptionalEnumValue(record, "role", new Set(["agent", "user"]), context.kind);
      return omitPayloadIdentity(record);
    }
    case "message.failed": {
      const record = requirePayloadRecord(context.kind, canonicalPayload);
      requireString(record, "messageId", context.kind);
      requireOptionalEnumValue(record, "role", new Set(["agent", "user"]), context.kind);
      const admitted = omitPayloadIdentity(record);
      admitted["error"] = readRunError(context.kind, record["error"], "error");
      return admitted;
    }
    case "thought.delta": {
      const record = requirePayloadRecord(context.kind, canonicalPayload);

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

      const record = requirePayloadRecord(context.kind, canonicalPayload);
      requireString(record, "requestId", context.kind);
      requireString(record, "title", context.kind);
      requireOptionalString(record, "agentId", context.kind);
      requireOptionalString(record, "blockedPath", context.kind);
      requireOptionalString(record, "decisionReason", context.kind);
      requireOptionalString(record, "description", context.kind);
      requireOptionalNullableString(record, "details", context.kind);
      requireOptionalNullableString(record, "targetItemId", context.kind);

      if (record["matchedAskRule"] !== undefined) {
        const matchedAskRule = requirePayloadRecord(
          context.kind,
          record["matchedAskRule"],
          "matchedAskRule",
        );
        requireString(matchedAskRule, "source", context.kind);
        requireString(matchedAskRule, "toolName", context.kind);
        requireOptionalString(matchedAskRule, "ruleContent", context.kind);
      }

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
      const record = requirePayloadRecord(context.kind, canonicalPayload);
      requireString(record, "requestId", context.kind);
      requireString(record, "outcome", context.kind);
      requireOptionalString(record, "optionId", context.kind);
      requireOptionalString(record, "optionKind", context.kind);
      return omitPayloadIdentity(record);
    }
    case "session.info.updated": {
      const record = requirePayloadRecord(context.kind, canonicalPayload);
      requireOptionalNullableString(record, "title", context.kind);
      if (record["updatedAt"] !== undefined) {
        requireNullableTimestamp(record, "updatedAt", context.kind, "updatedAt");
      }
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
      return readRunPayload(context, canonicalPayload);
    }
    case "runtime.config.updated":
    case "runtime.driver.updated":
    case "runtime.provisioning.updated":
    case "runtime.sandbox.updated":
    case "runtime.transport.updated": {
      const record = requirePayloadRecord(context.kind, canonicalPayload);
      requireString(record, "status", context.kind);

      if (context.kind === "runtime.transport.updated") {
        requireString(record, "channel", context.kind);
      } else {
        requireString(record, "phase", context.kind);
      }

      return omitPayloadIdentity(record);
    }
    case "runtime.timing.recorded": {
      return readTimingPayload(context, canonicalPayload);
    }
    case "tool.call.updated": {
      const record = requirePayloadRecord(context.kind, canonicalPayload);
      requireEnumValue(record, "status", toolStatuses, context.kind);
      requireString(record, "toolCallId", context.kind);
      requireOptionalContentString(record, "content", context.kind);
      requireOptionalString(record, "agentId", context.kind);
      requireOptionalString(record, "decisionReason", context.kind);
      requireOptionalString(record, "decisionReasonType", context.kind);
      requireOptionalString(record, "kind", context.kind);
      requireOptionalString(record, "messageId", context.kind);
      requireOptionalString(record, "name", context.kind);
      requireOptionalString(record, "nonExecutionKind", context.kind);
      requireOptionalString(record, "parentMessageId", context.kind);
      requireOptionalString(record, "rawInput", context.kind);
      requireOptionalString(record, "rawOutput", context.kind);
      requireOptionalNullableString(record, "title", context.kind);
      requireOptionalString(record, "userFeedback", context.kind);
      return omitPayloadIdentity(record);
    }
    default: {
      return isRuntimeEventRecord(canonicalPayload)
        ? omitPayloadIdentity(canonicalPayload)
        : canonicalPayload;
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
  requireOptionalTimestamp(record, "completedAt", context.kind);
  requireOptionalTimestamp(record, "startedAt", context.kind);

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
    completedAt: requireNullableTimestamp(record, "completedAt", context.kind, "run.completedAt"),
    error:
      record["error"] === null ? null : readRunError(context.kind, record["error"], "run.error"),
    id: context.runId ?? null,
    startedAt: requireNullableTimestamp(record, "startedAt", context.kind, "run.startedAt"),
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
  const completedAt = requireTimestamp(record, "completedAt", "runtime.timing.recorded");
  const path = requireEnumValue(record, "path", runtimeTimingPaths, "runtime.timing.recorded");
  const source = requireEnumValue(
    record,
    "source",
    runtimeTimingSources,
    "runtime.timing.recorded",
  );
  const stage = requireEnumValue(record, "stage", runtimeTimingStages, "runtime.timing.recorded");
  const startedAt = requireTimestamp(record, "startedAt", "runtime.timing.recorded");
  const totalMs = requireNonNegativeInt(record, "totalMs");
  const phases = readTimingPhases(record["phases"]);

  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error(
      "Runtime event runtime.timing.recorded payload completedAt must not precede startedAt.",
    );
  }

  return {
    completedAt,
    path: path as RuntimeTimingPath,
    phases,
    runId: context.runId ?? null,
    sessionId: context.sessionId,
    source: source as RuntimeTimingSource,
    stage: stage as RuntimeTimingStage,
    startedAt,
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
      durationMs: requireNonNegativeInt(record, "durationMs"),
      name: requireString(record, "name", "runtime.timing.recorded"),
    };
  });
}

function classifyIngressError(input: unknown, error: unknown): RuntimeEventIngressRejection {
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
