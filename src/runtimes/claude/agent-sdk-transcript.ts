import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { isRecord } from "./agent-sdk-json";

export interface ClaudeTranscriptCursor {
  readonly sessionId: string;
  readonly messageId: string;
  readonly contentJson: string;
}

const TRANSCRIPT_TAIL_BYTES = 64 * 1_024;
const TRANSCRIPT_WAIT_MS = 1_000;

/**
 * Streaming results precede the CLI's batched transcript write. Before publishing
 * run.completed (which may trigger a sandbox checkpoint), observe the final
 * assistant record on disk. Reads are bounded independently of session length.
 * Unsupported layouts/large records/IO failures fall back to closing the query.
 */
export async function waitForClaudeTranscript(
  configDir: string,
  cursor: ClaudeTranscriptCursor | null,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    cursor === null ||
    !/^[a-zA-Z0-9_-]+$/.test(cursor.sessionId) ||
    Buffer.byteLength(cursor.contentJson, "utf8") > TRANSCRIPT_TAIL_BYTES
  )
    return false;
  const projects = join(configDir, "projects");
  const deadline = performance.now() + TRANSCRIPT_WAIT_MS;
  let transcriptPath: string | null = null;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    try {
      if (transcriptPath === null) {
        for (const directory of await readdir(projects, { withFileTypes: true })) {
          if (!directory.isDirectory()) continue;
          const candidate = join(projects, directory.name, `${cursor.sessionId}.jsonl`);
          const status = await readTranscriptTail(candidate, cursor);
          if (status === "persisted") return true;
          if (status === "pending") {
            transcriptPath = candidate;
            break;
          }
        }
      } else if ((await readTranscriptTail(transcriptPath, cursor)) === "persisted") {
        return true;
      }
    } catch (error) {
      if (!isRecord(error) || error["code"] !== "ENOENT") return false;
    }
    await setTimeout(20, undefined, { signal });
  }
  return false;
}

async function readTranscriptTail(
  path: string,
  cursor: ClaudeTranscriptCursor,
): Promise<"missing" | "pending" | "persisted"> {
  const file = await open(path, "r").catch((error: unknown) => {
    if (isRecord(error) && error["code"] === "ENOENT") return null;
    throw error;
  });
  if (file === null) return "missing";
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, TRANSCRIPT_TAIL_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    // Ignore incomplete first/last records; a partial write is not a checkpoint.
    if (start > 0) lines.shift();
    lines.pop();
    for (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        isRecord(entry) &&
        entry["type"] === "assistant" &&
        entry["uuid"] === cursor.messageId &&
        isRecord(entry["message"]) &&
        JSON.stringify(entry["message"]["content"]) === cursor.contentJson
      ) {
        return "persisted";
      }
    }
    return "pending";
  } finally {
    await file.close();
  }
}
