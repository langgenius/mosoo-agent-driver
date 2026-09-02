import type { JsonObject } from "../protocol/json";
import { isJsonObject } from "../protocol/json";

function isMergeableRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMergeRecords(
  base: Record<string, unknown>,
  providerOptions: JsonObject,
): Record<string, unknown> {
  return Object.fromEntries([
    ...Object.entries(base),
    ...Object.entries(providerOptions).map(([key, value]) => {
      const current = Object.hasOwn(base, key) ? base[key] : undefined;
      return [
        key,
        isMergeableRecord(current) && isJsonObject(value)
          ? deepMergeRecords(current, value)
          : structuredClone(value),
      ];
    }),
  ]);
}

export function mergeProviderOptions<T extends object>(base: T, providerOptions: JsonObject): T {
  return deepMergeRecords(base as Record<string, unknown>, providerOptions) as T;
}
