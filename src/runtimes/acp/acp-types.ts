import type { JsonObject } from "../provider-json";

export { raceWithAbort } from "../../utils/async";

export {
  isRecord,
  readArray,
  readNonEmptyString,
  readRecord,
  readString,
  stringifyForDisplay,
} from "../provider-json";
export type { JsonObject } from "../provider-json";

export function readNullableString(
  value: JsonObject | null,
  key: string,
): string | null | undefined {
  const entry = value?.[key];

  if (entry === null) {
    return null;
  }

  return typeof entry === "string" ? entry : undefined;
}

export function readNumber(value: JsonObject | null, key: string): number | null {
  const entry = value?.[key];
  return typeof entry === "number" && Number.isFinite(entry) ? entry : null;
}
