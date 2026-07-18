export {
  isRecord,
  readArray,
  readNonEmptyString,
  readRecord,
  readString,
  stringifyForDisplay,
} from "../provider-json";
export type { JsonObject } from "../provider-json";
export type JsonRpcId = number | string;

export function toJsonRpcId(value: unknown): JsonRpcId | null {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }

  return null;
}
