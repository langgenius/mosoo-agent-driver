import { timestampSchema } from "../../contract/common";
import type { DriverId } from "../id";
import { parseDriverId } from "../id";
import type {
  RuntimeEventKind,
  RuntimeEventNativeRef,
  RuntimeEventRecord,
} from "./runtime-event-types";

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

export function parseNativeRef(value: RuntimeEventRecord): RuntimeEventNativeRef {
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

export function hasTextContent(payload: RuntimeEventRecord): boolean {
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

export function hasRunStartedAt(record: RuntimeEventRecord): boolean {
  if (readString(record, "startedAt") !== undefined) {
    return true;
  }

  const run = record["run"];
  return isRuntimeEventRecord(run) && readString(run, "startedAt") !== undefined;
}

export function omitPayloadIdentity(payload: RuntimeEventRecord): RuntimeEventRecord {
  const result: RuntimeEventRecord = {};

  for (const [key, value] of Object.entries(payload)) {
    if (!payloadIdentityFields.has(key)) {
      result[key] = value;
    }
  }

  return result;
}

export function requirePayloadRecord(
  kind: RuntimeEventKind | string,
  value: unknown,
  label = "payload",
): RuntimeEventRecord {
  if (!isRuntimeEventRecord(value)) {
    throw new Error(`Runtime event ${kind} ${label} must be an object.`);
  }

  return value;
}

export function requireString(
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

export function readString(value: RuntimeEventRecord, field: string): string | undefined {
  const entry = value[field];
  return typeof entry === "string" && entry.length > 0 ? entry : undefined;
}

export function requireEnumValue(
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

export function requireOptionalEnumValue(
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

export function requireOptionalString(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): void {
  if (!(field in value) || value[field] === undefined) {
    return;
  }

  requireString(value, field, label);
}

export function requireOptionalContentString(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): void {
  if (!(field in value) || value[field] === undefined || value[field] === null) {
    return;
  }

  if (typeof value[field] !== "string") {
    throw new Error(`${label} ${field} must be a string.`);
  }
}

export function requireOptionalNullableString(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): void {
  if (!(field in value) || value[field] === undefined || value[field] === null) {
    return;
  }

  requireString(value, field, label);
}

export function requireOptionalStringArray(
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

export function requireOptionalTimestamp(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): void {
  if (!(field in value) || value[field] === undefined) {
    return;
  }

  requireTimestamp(value, field, label);
}

export function requireTimestamp(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
): string {
  const timestamp = requireString(value, field, label);
  assertTimestamp(timestamp, `${label} ${field}`);
  return timestamp;
}

export function requireNullableTimestamp(
  value: RuntimeEventRecord,
  field: string,
  label: RuntimeEventKind | string,
  nullableLabel: string,
): string | null {
  if (value[field] === null) {
    return null;
  }

  return requireTimestamp(value, field, `${label} ${nullableLabel}`);
}

export function requireNonNegativeInt(value: RuntimeEventRecord, field: string): number {
  const entry = value[field];

  if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
    throw new Error(
      `Runtime event runtime.timing.recorded ${field} must be a non-negative safe integer.`,
    );
  }

  return entry;
}

export function readOptionalString(
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

export function readDriverId(value: RuntimeEventRecord, field: string): DriverId {
  return parseDriverId(value[field], `Runtime event ${field}`);
}

export function readOptionalDriverId(
  value: RuntimeEventRecord,
  field: string,
): DriverId | undefined {
  if (!(field in value) || value[field] === undefined) {
    return undefined;
  }

  return parseDriverId(value[field], `Runtime event ${field}`);
}

export function assertTimestamp(value: string, label: string): void {
  if (!timestampSchema.safeParse(value).success) {
    throw new Error(`${label} must be an ISO 8601 timestamp with a timezone offset.`);
  }
}

export function readPrimitiveRecord(
  value: unknown,
): Record<string, string | number | boolean | null> {
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
