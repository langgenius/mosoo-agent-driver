import type { JsonObject, JsonValue } from "../protocol/json";
import { isJsonObject } from "../protocol/json";

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }

  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]),
    );
  }

  return value;
}

function isMergeableRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMergeRecords(
  base: Record<string, unknown>,
  providerOptions: JsonObject,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(providerOptions)) {
    const current = result[key];

    if (isMergeableRecord(current) && isJsonObject(value)) {
      result[key] = deepMergeRecords(current, value);
    } else {
      result[key] = cloneJsonValue(value);
    }
  }

  return result;
}

export function mergeProviderOptions<T extends object>(base: T, providerOptions: JsonObject): T {
  return deepMergeRecords(base as Record<string, unknown>, providerOptions) as T;
}
