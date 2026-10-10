import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import { raceWithAbort } from "../../utils/async";
import {
  directoryEntryPath,
  hasErrorCode,
  openAbsoluteRealDirectory,
  openRealDirectory,
  readDirectoryEntriesBounded,
} from "../atomic-file";
import { isRecord } from "./agent-sdk-json";

export interface ClaudeTranscriptCursor {
  readonly sessionId: string;
  readonly messageId: string;
  readonly contentJson: string;
}

const TRANSCRIPT_CHUNK_BYTES = 64 * 1_024;
const TRANSCRIPT_RECORD_BYTES = 64 * 1_024;
const TRANSCRIPT_WAIT_MS = 1_000;
const LABEL = "Claude transcript";

/**
 * Streaming results precede the CLI's batched transcript write. Before publishing
 * run.completed (which may trigger a sandbox checkpoint), observe the final
 * assistant record on disk. Scan backwards with bounded memory and a deadline.
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
    Buffer.byteLength(cursor.contentJson, "utf8") > TRANSCRIPT_RECORD_BYTES
  )
    return false;
  const waiting = AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIPT_WAIT_MS)]);
  try {
    // The scan retains its handles through delayed I/O and closes them when that I/O settles.
    return await raceWithAbort(pollTranscript(configDir, cursor, waiting), waiting);
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

async function pollTranscript(
  configDir: string,
  cursor: ClaudeTranscriptCursor,
  signal: AbortSignal,
): Promise<boolean> {
  let projectName: string | null = null;
  for (;;) {
    signal.throwIfAborted();
    try {
      await using home = await openAbsoluteRealDirectory(configDir, LABEL);
      signal.throwIfAborted();
      await using projects = await openRealDirectory(directoryEntryPath(home, "projects"), LABEL);
      const names: readonly string[] =
        projectName === null
          ? (await readDirectoryEntriesBounded(projects, LABEL, 1_024, signal))
              .filter((directory) => directory.isDirectory())
              .map((directory) => directory.name)
          : [projectName];
      for (const name of names) {
        signal.throwIfAborted();
        await using project = await openRealDirectory(directoryEntryPath(projects, name), LABEL);
        const status = await readTranscript(
          directoryEntryPath(project, `${cursor.sessionId}.jsonl`),
          cursor,
          signal,
        );
        if (status === "persisted") return true;
        if (status === "pending") {
          projectName = name;
          break;
        }
      }
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    await setTimeout(20, undefined, { signal });
  }
}

async function readTranscript(
  path: string,
  cursor: ClaudeTranscriptCursor,
  signal: AbortSignal,
): Promise<"missing" | "pending" | "persisted"> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (file === null) return "missing";
  try {
    signal.throwIfAborted();
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size)) {
      throw new Error("Claude transcript must be a regular file.");
    }
    let position = stat.size;
    let parts: Buffer[] = [];
    let recordBytes = 0;
    // The tail is incomplete until a newline is found; oversized records are skipped too.
    let discard = true;
    const append = (part: Buffer) => {
      if (discard) return;
      recordBytes += part.length;
      if (recordBytes > TRANSCRIPT_RECORD_BYTES) {
        parts = [];
        discard = true;
      } else {
        parts.push(part);
      }
    };
    while (position > 0) {
      signal.throwIfAborted();
      const start = Math.max(0, position - TRANSCRIPT_CHUNK_BYTES);
      const buffer = Buffer.alloc(position - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      signal.throwIfAborted();
      if (bytesRead !== buffer.length) return "pending";
      let end = bytesRead;
      for (let index = bytesRead - 1; index >= 0; index--) {
        if (buffer[index] !== 0x0a) continue;
        append(buffer.subarray(index + 1, end));
        if (!discard && matchesAssistant(parts, recordBytes, cursor)) return "persisted";
        parts = [];
        recordBytes = 0;
        discard = false;
        end = index;
      }
      append(buffer.subarray(0, end));
      position = start;
    }
    return !discard && matchesAssistant(parts, recordBytes, cursor) ? "persisted" : "pending";
  } finally {
    await file.close();
  }
}

function matchesAssistant(
  parts: readonly Buffer[],
  size: number,
  cursor: ClaudeTranscriptCursor,
): boolean {
  let entry: unknown;
  try {
    entry = JSON.parse(Buffer.concat(parts.toReversed(), size).toString("utf8"));
  } catch {
    return false;
  }
  return (
    isRecord(entry) &&
    entry["type"] === "assistant" &&
    entry["uuid"] === cursor.messageId &&
    isRecord(entry["message"]) &&
    JSON.stringify(entry["message"]["content"]) === cursor.contentJson
  );
}
