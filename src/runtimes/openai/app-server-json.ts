import { isRecord } from "../provider-json";
import type { JsonObject } from "../provider-json";

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

export function toGrantedPermissionProfile(value: unknown): JsonObject {
  if (!isRecord(value)) {
    return {};
  }

  return {
    ...(isRecord(value["fileSystem"]) ? { fileSystem: value["fileSystem"] } : {}),
    ...(isRecord(value["network"]) ? { network: value["network"] } : {}),
  };
}

export function toJsonRpcId(value: unknown): JsonRpcId | null {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }

  return null;
}
