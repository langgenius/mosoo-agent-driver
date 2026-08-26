import { formatLogValue } from "../observability";

export type JsonObject = Record<string, unknown>;

function jsonStringContentBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

export function chunkJsonText(
  text: string,
  firstChunkBytes: number,
  remainingChunkBytes = firstChunkBytes,
): string[] {
  if (text.length === 0 || jsonStringContentBytes(text) <= firstChunkBytes) {
    return [text];
  }

  const chunks: string[] = [];
  let offset = 0;
  let chunkBytes = firstChunkBytes;

  while (offset < text.length) {
    let end = offset;
    let low = offset + 1;
    let high = Math.min(text.length, offset + chunkBytes);

    while (low <= high) {
      const probe = Math.floor((low + high) / 2);
      let candidate = probe;
      const previous = text.charCodeAt(candidate - 1);
      const next = text.charCodeAt(candidate);

      if (
        candidate < text.length &&
        previous >= 0xd800 &&
        previous <= 0xdbff &&
        next >= 0xdc00 &&
        next <= 0xdfff
      ) {
        candidate -= 1;
      }

      if (jsonStringContentBytes(text.slice(offset, candidate)) <= chunkBytes) {
        end = candidate;
        low = probe + 1;
      } else {
        high = probe - 1;
      }
    }

    if (end === offset) {
      if (chunks.length > 0) {
        throw new RangeError("JSON text chunk byte budget cannot fit the next character.");
      }
      chunks.push("");
    } else {
      chunks.push(text.slice(offset, end));
      offset = end;
    }
    chunkBytes = remainingChunkBytes;
  }

  return chunks;
}

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

export function readNumber(value: JsonObject | null, key: string): number | null {
  const entry = value?.[key];
  return typeof entry === "number" && Number.isFinite(entry) ? entry : null;
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
