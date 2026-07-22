import type {
  DriverCapability,
  DriverCapabilityId,
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeCommandStatus,
} from "../../runtime-command";
import type { DriverBootPayload } from "../boot";
import { parseDriverEventEnvelope, type DriverEventEnvelope } from "../events";
import { isSupportedDriverRuntime } from "../runtime";
import type { DriverRuntime } from "../runtime";

export interface DriverHelloInput {
  readonly capabilities: readonly DriverCapability[];
  readonly driverVersion: string;
  readonly pid: number;
  readonly protocolVersion: DriverBootPayload["protocolVersion"];
  readonly runtime: DriverRuntime;
  readonly startedAt: string;
}

export interface DriverHelloOutput {
  readonly acceptedCapabilities: readonly DriverCapability[];
  readonly connectionId: string;
  readonly driverInstanceId: string;
  readonly heartbeatIntervalMs: number;
  readonly runConfig: {
    readonly commandLeaseMs: number;
    readonly envPolicy: "strict";
    readonly eventBatchMaxSize: number;
    readonly organizationPath: string;
  };
  readonly runId: string | null;
}

export interface DriverHeartbeatInput {
  readonly at: string;
  readonly pid: number;
  readonly reason: "interval" | "ping";
}

export interface DriverHeartbeatOutput {
  readonly heartbeatCount: number;
  readonly ok: true;
}

export interface DriverReadyInput {
  readonly at: string;
  readonly driverInstanceId: string;
  readonly pid: number;
}

export interface DriverLogContext {
  parentSpanId?: string | undefined;
  requestId?: string | undefined;
  sandboxId?: string | undefined;
  sessionId?: string | undefined;
  spanId?: string | undefined;
  traceId?: string | undefined;
}

export interface DriverLogError {
  readonly code?: number | string | undefined;
  readonly message: string;
  readonly name: string;
  readonly stack?: string | null | undefined;
}

export interface DriverLogEntry {
  readonly context?: DriverLogContext | undefined;
  readonly error?: DriverLogError | undefined;
  readonly fields?: Record<string, string | number | boolean | null> | undefined;
  readonly level: "debug" | "error" | "info" | "trace" | "warn";
  readonly message: string;
  readonly namespace?: string | null | undefined;
  readonly seq: number;
  readonly timestamp: string;
}

export interface DriverLogBatchInput {
  readonly driverInstanceId: string;
  readonly logs: readonly DriverLogEntry[];
}

export interface DriverLogBatchOutput {
  readonly ok: true;
}

export interface DriverFailureInput {
  readonly driverInstanceId: string;
  readonly error: {
    readonly code: string;
    readonly details: Record<string, string | number | boolean | null>;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface DriverCommandUpdateInput {
  readonly commandId: string;
  readonly driverInstanceId: string;
  readonly error?: DriverFailureInput["error"] | undefined;
  readonly result?: RuntimeCommandResult | undefined;
  readonly status: RuntimeCommandStatus;
}

export interface DriverEventBatchInput {
  readonly driverInstanceId: string;
  readonly events: readonly DriverEventEnvelope[];
}

export interface DriverEventReceipt {
  readonly eventId?: string | undefined;
  readonly seq: number;
  readonly type: string;
}

export interface DriverEventBatchOutput {
  readonly accepted: readonly DriverEventReceipt[];
}

export interface DriverNextCommandInput {
  readonly driverInstanceId: string;
}

export interface DriverNextCommandOutput {
  readonly command: RuntimeCommand | null;
}

export interface DriverCompletionInput {
  readonly driverInstanceId: string;
}

export interface DriverRpcOptions {
  readonly signal?: AbortSignal;
}

export interface DriverRuntimeClient {
  readonly driver: {
    commandUpdate(
      input: DriverCommandUpdateInput,
      options?: DriverRpcOptions,
    ): Promise<{ ok: true }>;
    completeRun(input: DriverCompletionInput, options?: DriverRpcOptions): Promise<{ ok: true }>;
    failRun(input: DriverFailureInput, options?: DriverRpcOptions): Promise<{ ok: true }>;
    heartbeat(
      input: DriverHeartbeatInput,
      options?: DriverRpcOptions,
    ): Promise<DriverHeartbeatOutput>;
    hello(input: DriverHelloInput, options?: DriverRpcOptions): Promise<DriverHelloOutput>;
    pushEvents(
      input: DriverEventBatchInput,
      options?: DriverRpcOptions,
    ): Promise<DriverEventBatchOutput>;
    pushLogs(input: DriverLogBatchInput, options?: DriverRpcOptions): Promise<DriverLogBatchOutput>;
    ready(input: DriverReadyInput, options?: DriverRpcOptions): Promise<{ ok: true }>;
  };
  readonly driverInstance: {
    nextCommand(
      input: DriverNextCommandInput,
      options?: DriverRpcOptions,
    ): Promise<DriverNextCommandOutput>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }

  return value;
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];

  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string.`);
  }

  return value;
}

function readNonEmptyString(record: Record<string, unknown>, field: string): string {
  const value = readString(record, field);

  if (value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }

  return value;
}

function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string.`);
  }

  return value;
}

function readNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number.`);
  }

  return value;
}

function readPositiveInteger(record: Record<string, unknown>, field: string): number {
  const value = readNumber(record, field);

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }

  return value;
}

function readNonNegativeInteger(record: Record<string, unknown>, field: string): number {
  const value = readNumber(record, field);

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }

  return value;
}

function readBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];

  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean.`);
  }

  return value;
}

function readProtocolVersion(
  record: Record<string, unknown>,
): DriverBootPayload["protocolVersion"] {
  const value = record["protocolVersion"];

  if (value !== 1) {
    throw new TypeError("protocolVersion must be 1.");
  }

  return value;
}

function readDriverRuntime(record: Record<string, unknown>): DriverRuntime {
  const runtime = readNonEmptyString(record, "runtime");

  if (!isSupportedDriverRuntime(runtime)) {
    throw new TypeError(`Unsupported driver runtime: ${runtime}.`);
  }

  return runtime;
}

function readHeartbeatReason(value: unknown): DriverHeartbeatInput["reason"] {
  if (value === "interval" || value === "ping") {
    return value;
  }

  throw new TypeError("reason must be interval or ping.");
}

const DRIVER_CAPABILITY_IDS = new Set<DriverCapabilityId>([
  "custom_tool_execute",
  "file_change",
  "input_start",
  "mcp_execute",
  "native_resume",
  "permission_request",
  "session_stop",
  "text_stream",
  "thinking_stream",
  "tool_stream",
  "turn_cancel",
  "usage",
  "visible_activity",
]);

function readDriverCapabilityId(value: unknown): DriverCapabilityId {
  if (typeof value === "string" && DRIVER_CAPABILITY_IDS.has(value as DriverCapabilityId)) {
    return value as DriverCapabilityId;
  }

  throw new TypeError("capability id is unsupported.");
}

function readDriverCapabilityStatus(value: unknown): DriverCapability["status"] {
  if (value === "supported" || value === "unsupported") {
    return value;
  }

  throw new TypeError("capability status must be supported or unsupported.");
}

function readDriverCapability(value: unknown): DriverCapability {
  const record = readRecord(value, "capability");
  const details = readOptionalString(record, "details");

  return {
    ...(details === undefined ? {} : { details }),
    id: readDriverCapabilityId(record["id"]),
    status: readDriverCapabilityStatus(record["status"]),
    version: readDriverCapabilityVersion(record["version"]),
  };
}

function readDriverCapabilityVersion(value: unknown): 1 {
  if (value !== 1) {
    throw new TypeError("capability version must be 1.");
  }

  return value;
}

function readDriverCapabilities(record: Record<string, unknown>): DriverCapability[] {
  const value = record["capabilities"];

  if (!Array.isArray(value)) {
    throw new TypeError("capabilities must be an array.");
  }

  const capabilities = value.map(readDriverCapability);

  if (new Set(capabilities.map(({ id }) => id)).size !== capabilities.length) {
    throw new TypeError("capabilities must not contain duplicate ids.");
  }

  return capabilities;
}

export function parseDriverHelloInput(value: unknown): DriverHelloInput {
  const record = readRecord(value, "driver hello input");

  return {
    capabilities: readDriverCapabilities(record),
    driverVersion: readNonEmptyString(record, "driverVersion"),
    pid: readPositiveInteger(record, "pid"),
    protocolVersion: readProtocolVersion(record),
    runtime: readDriverRuntime(record),
    startedAt: readNonEmptyString(record, "startedAt"),
  };
}

export function parseDriverHeartbeatInput(value: unknown): DriverHeartbeatInput {
  const record = readRecord(value, "driver heartbeat input");

  return {
    at: readNonEmptyString(record, "at"),
    pid: readPositiveInteger(record, "pid"),
    reason: readHeartbeatReason(record["reason"]),
  };
}

export function parseDriverReadyInput(value: unknown): DriverReadyInput {
  const record = readRecord(value, "driver ready input");

  return {
    at: readNonEmptyString(record, "at"),
    driverInstanceId: readNonEmptyString(record, "driverInstanceId"),
    pid: readPositiveInteger(record, "pid"),
  };
}

const DRIVER_COMMAND_STATUSES = new Set<RuntimeCommandStatus>([
  "accepted",
  "cancelled",
  "completed",
  "delivered",
  "expired",
  "failed",
  "queued",
]);

function readDriverCommandStatus(value: unknown): RuntimeCommandStatus {
  if (typeof value === "string" && DRIVER_COMMAND_STATUSES.has(value as RuntimeCommandStatus)) {
    return value as RuntimeCommandStatus;
  }

  throw new TypeError("status is not a supported runtime command status.");
}

function readPrimitiveRecord(
  value: unknown,
  label: string,
): Record<string, string | number | boolean | null> {
  const record = readRecord(value, label);

  for (const [field, entry] of Object.entries(record)) {
    if (
      entry !== null &&
      typeof entry !== "string" &&
      typeof entry !== "boolean" &&
      (typeof entry !== "number" || !Number.isFinite(entry))
    ) {
      throw new TypeError(`${label}.${field} must be a primitive value.`);
    }
  }

  return { ...record } as Record<string, string | number | boolean | null>;
}

function readDriverFailure(value: unknown): DriverFailureInput["error"] {
  const record = readRecord(value, "driver failure");

  return {
    code: readNonEmptyString(record, "code"),
    details: readPrimitiveRecord(record["details"], "driver failure details"),
    message: readString(record, "message"),
    retryable: readBoolean(record, "retryable"),
  };
}

function readRuntimeCommandResult(value: unknown): RuntimeCommandResult {
  if (value === null) {
    return null;
  }

  const record = readRecord(value, "runtime command result");
  const requestId = readNonEmptyString(record, "requestId");

  if (
    record["outputText"] !== undefined ||
    record["serverId"] !== undefined ||
    record["toolName"] !== undefined
  ) {
    const isError = record["isError"] === undefined ? undefined : readBoolean(record, "isError");

    return {
      ...(isError === undefined ? {} : { isError }),
      outputText: readString(record, "outputText"),
      requestId,
      serverId: readNonEmptyString(record, "serverId"),
      toolName: readNonEmptyString(record, "toolName"),
    };
  }

  return { requestId };
}

export function parseDriverCommandUpdateInput(value: unknown): DriverCommandUpdateInput {
  const record = readRecord(value, "driver command update input");
  const error = record["error"] === undefined ? undefined : readDriverFailure(record["error"]);
  const result =
    record["result"] === undefined ? undefined : readRuntimeCommandResult(record["result"]);

  return {
    commandId: readNonEmptyString(record, "commandId"),
    driverInstanceId: readNonEmptyString(record, "driverInstanceId"),
    ...(error === undefined ? {} : { error }),
    ...(result === undefined ? {} : { result }),
    status: readDriverCommandStatus(record["status"]),
  };
}

export function parseDriverCompletionInput(value: unknown): DriverCompletionInput {
  const record = readRecord(value, "driver completion input");
  return { driverInstanceId: readNonEmptyString(record, "driverInstanceId") };
}

export function parseDriverFailureInput(value: unknown): DriverFailureInput {
  const record = readRecord(value, "driver failure input");

  return {
    driverInstanceId: readNonEmptyString(record, "driverInstanceId"),
    error: readDriverFailure(record["error"]),
  };
}

function readOptionalLogContext(value: unknown): DriverLogContext | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = readRecord(value, "driver log context");
  const context = {
    parentSpanId: readOptionalString(record, "parentSpanId"),
    requestId: readOptionalString(record, "requestId"),
    sandboxId: readOptionalString(record, "sandboxId"),
    sessionId: readOptionalString(record, "sessionId"),
    spanId: readOptionalString(record, "spanId"),
    traceId: readOptionalString(record, "traceId"),
  };

  return Object.fromEntries(
    Object.entries(context).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function readOptionalLogError(value: unknown): DriverLogError | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = readRecord(value, "driver log error");
  const code = record["code"];
  const stack = record["stack"];

  if (
    code !== undefined &&
    typeof code !== "string" &&
    (typeof code !== "number" || !Number.isFinite(code))
  ) {
    throw new TypeError("driver log error.code must be a string or finite number.");
  }

  if (stack !== undefined && stack !== null && typeof stack !== "string") {
    throw new TypeError("driver log error.stack must be a string or null.");
  }

  return {
    ...(code === undefined ? {} : { code }),
    message: readString(record, "message"),
    name: readString(record, "name"),
    ...(stack === undefined ? {} : { stack }),
  };
}

function readOptionalNullableString(
  record: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = record[field];

  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }

  throw new TypeError(`${field} must be a string or null.`);
}

function readDriverLogLevel(value: unknown): DriverLogEntry["level"] {
  if (
    value === "debug" ||
    value === "error" ||
    value === "info" ||
    value === "trace" ||
    value === "warn"
  ) {
    return value;
  }

  throw new TypeError("driver log level is unsupported.");
}

function readDriverLogEntry(value: unknown): DriverLogEntry {
  const record = readRecord(value, "driver log entry");
  const context = readOptionalLogContext(record["context"]);
  const error = readOptionalLogError(record["error"]);
  const fields =
    record["fields"] === undefined
      ? undefined
      : readPrimitiveRecord(record["fields"], "driver log fields");
  const namespace = readOptionalNullableString(record, "namespace");

  return {
    ...(context === undefined ? {} : { context }),
    ...(error === undefined ? {} : { error }),
    ...(fields === undefined ? {} : { fields }),
    level: readDriverLogLevel(record["level"]),
    message: readString(record, "message"),
    ...(namespace === undefined ? {} : { namespace }),
    seq: readNonNegativeInteger(record, "seq"),
    timestamp: readNonEmptyString(record, "timestamp"),
  };
}

export function parseDriverLogBatchInput(value: unknown): DriverLogBatchInput {
  const record = readRecord(value, "driver log batch input");
  const logs = record["logs"];

  if (!Array.isArray(logs)) {
    throw new TypeError("logs must be an array.");
  }

  return {
    driverInstanceId: readNonEmptyString(record, "driverInstanceId"),
    logs: logs.map(readDriverLogEntry),
  };
}

export function parseDriverEventBatchInput(value: unknown): DriverEventBatchInput {
  const record = readRecord(value, "driver event batch input");
  const events = record["events"];

  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array.");
  }

  return {
    driverInstanceId: readNonEmptyString(record, "driverInstanceId"),
    events: events.map(parseDriverEventEnvelope),
  };
}

export function parseDriverNextCommandInput(value: unknown): DriverNextCommandInput {
  const record = readRecord(value, "driver next command input");
  return { driverInstanceId: readNonEmptyString(record, "driverInstanceId") };
}
