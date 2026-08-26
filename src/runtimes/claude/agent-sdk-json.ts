export {
  isRecord,
  readNumber,
  readRecord,
  readString,
  stringifyForDisplay,
} from "../provider-json";
export type { JsonObject } from "../provider-json";

export function toTokenCount(value: unknown): number | null {
  return typeof value === "number" && value >= 0 && Number.isSafeInteger(value) ? value : null;
}

export function sumTokenCounts(input: number | null, output: number | null): number | null {
  return input === null && output === null ? null : toTokenCount((input ?? 0) + (output ?? 0));
}

export function toCostAmount(value: unknown): number | null {
  return typeof value === "number" && value >= 0 && Number.isFinite(value) ? value : null;
}

export function toErrorMessage(error: unknown, defaultMessage: string): string {
  return error instanceof Error ? error.message : defaultMessage;
}

export function readProcessEnvString(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
