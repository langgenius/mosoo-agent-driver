import { formatLogValue } from "../observability";

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readArray(value: JsonObject | null, key: string): unknown[] {
  const entry = value?.[key];
  return Array.isArray(entry) ? entry : [];
}

export function readNonEmptyString(value: JsonObject | null, key: string): string | null {
  const entry = readString(value, key);
  return entry !== null && entry.length > 0 ? entry : null;
}

export function readRecord(value: JsonObject | null, key: string): JsonObject | null {
  const entry = value?.[key];
  return isRecord(entry) ? entry : null;
}

export function readString(value: JsonObject | null, key: string): string | null {
  const entry = value?.[key];
  return typeof entry === "string" ? entry : null;
}

export function stringifyForDisplay(value: unknown): string {
  return value === null || value === undefined ? "" : formatLogValue(value);
}
