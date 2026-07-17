import { isRecord, readString } from "./agent-sdk-json";

export function readClaudeSdkSessionId(value: unknown): string | null {
  const record = isRecord(value) ? value : null;
  return readString(record, "session_id");
}
