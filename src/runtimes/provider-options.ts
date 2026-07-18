import type { JsonObject } from "../protocol/json";
import { isJsonObject } from "../protocol/json";

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
      result[key] = structuredClone(value);
    }
  }

  return result;
}

export function mergeProviderOptions<T extends object>(base: T, providerOptions: JsonObject): T {
  return deepMergeRecords(base as Record<string, unknown>, providerOptions) as T;
}
