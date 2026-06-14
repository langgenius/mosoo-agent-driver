import type { DriverId } from "../id";
import { parseDriverId } from "../id";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }

  return value;
}

export function readString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];

  if (typeof value !== "string") {
    throw new TypeError(`${label}.${field} must be a string.`);
  }

  return value;
}

export function readNonEmptyString(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = readString(record, field, label);

  if (value.length === 0) {
    throw new TypeError(`${label}.${field} must be non-empty.`);
  }

  return value;
}

export function readOptionalNullableString(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string | null | undefined {
  const value = record[field];

  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value !== "string") {
    throw new TypeError(`${label}.${field} must be a string, null, or undefined.`);
  }

  return value;
}

export function readNumber(record: Record<string, unknown>, field: string, label: string): number {
  const value = record[field];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label}.${field} must be a finite number.`);
  }

  return value;
}

export function readBoolean(
  record: Record<string, unknown>,
  field: string,
  label: string,
): boolean {
  const value = record[field];

  if (typeof value !== "boolean") {
    throw new TypeError(`${label}.${field} must be a boolean.`);
  }

  return value;
}

export function readInteger(record: Record<string, unknown>, field: string, label: string): number {
  const value = readNumber(record, field, label);

  if (!Number.isInteger(value)) {
    throw new TypeError(`${label}.${field} must be an integer.`);
  }

  return value;
}

export function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array.`);
  }

  return value;
}

export function readStringArray(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string[] {
  return readArray(record[field], `${label}.${field}`).map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new TypeError(`${label}.${field}[${index}] must be a non-empty string.`);
    }

    return entry;
  });
}

export function parseId(value: unknown, label: string): DriverId {
  return parseDriverId(value, label);
}

export function parseNullableId(value: unknown, label: string): DriverId | null {
  return value === null ? null : parseId(value, label);
}
