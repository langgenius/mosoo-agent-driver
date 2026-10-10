import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { RunId } from "../../protocol/id";
import {
  MAX_NATIVE_CHECKPOINT_DIRECTORY_DEPTH,
  MAX_NATIVE_CHECKPOINT_ENTRIES,
  nativeRuntimeRefsEqual,
  type NativeCheckpoint,
} from "../../protocol/native-checkpoint";
import type { DriverStartInput } from "../../protocol/start";
import {
  assertDirectoryIdentity,
  directoryEntryPath,
  ensureAbsoluteRealDirectory,
  openAbsoluteRealDirectory,
  openOptionalRealDirectory,
  openRealDirectory,
  openRelativeRealDirectory,
  readDirectoryEntriesBounded,
} from "../atomic-file";
import {
  createNativeCheckpoint,
  readNativeCheckpoint,
  readNativeCheckpointSourceFile,
  removeNativeCheckpointDirectory,
  type NativeCheckpointRoot,
} from "../native-checkpoint";

const LABEL = "OpenAI native checkpoint";
const DIRECTORIES = ["sessions", "archived_sessions", "memories", "memories_extensions"] as const;
const SQLITE_PROJECTION = /^(?:state|thread_history)_\d+\.sqlite(?:-shm|-wal)?$/u;

interface Rollout {
  threadId: string;
  successfulTurns: Map<string, number>;
}

function readRollout(bytes: Buffer): Rollout {
  let offset = 0;
  let threadId: string | undefined;
  const successfulTurns = new Map<string, number>();
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline === -1) throw new Error(`${LABEL} rollout has an incomplete record.`);
    const line = bytes.subarray(offset, newline).toString("utf8");
    const record = JSON.parse(line) as {
      type?: string;
      payload?: { id?: string; type?: string; turn_id?: string; error?: unknown };
    };
    if (offset === 0) {
      if (record.type !== "session_meta" || typeof record.payload?.id !== "string") {
        throw new Error(`${LABEL} rollout is missing its session metadata.`);
      }
      threadId = record.payload.id;
    }
    if (
      record.type === "event_msg" &&
      (record.payload?.type === "task_complete" || record.payload?.type === "turn_complete") &&
      typeof record.payload.turn_id === "string" &&
      record.payload.error == null
    ) {
      successfulTurns.set(record.payload.turn_id, newline + 1);
    }
    offset = newline + 1;
  }
  if (threadId === undefined) throw new Error(`${LABEL} rollout is empty.`);
  return { threadId, successfulTurns };
}

function isRolloutPath(path: string): boolean {
  return (
    (path.startsWith("sessions/") || path.startsWith("archived_sessions/")) &&
    path.endsWith(".jsonl")
  );
}

async function writeSnapshotFile(
  root: FileHandle,
  path: string,
  bytes: Buffer,
  signal: AbortSignal,
): Promise<void> {
  await using parent = await openRelativeRealDirectory(root, dirname(path), LABEL, true, signal);
  await using file = await open(directoryEntryPath(parent, path.split("/").at(-1)!), "wx", 0o600);
  await file.writeFile(bytes, { signal });
  await file.sync();
  await parent.sync();
}

export async function createOpenAiNativeCheckpoint(input: {
  payload: DriverStartInput;
  root: NativeCheckpointRoot;
  runId: RunId;
  threadId: string;
  turnId: string;
  signal: AbortSignal;
}): Promise<NativeCheckpoint> {
  const { session } = input.payload.execution;
  return createNativeCheckpoint({
    root: input.root,
    runId: input.runId,
    nativeRef: { runtimeId: "openai-runtime", kind: "openai_thread_id", value: input.threadId },
    signal: input.signal,
    async write(stage) {
      await using home = await openAbsoluteRealDirectory(session.homePath, LABEL);
      await using target = await openRealDirectory(`${stage}/.`, LABEL);
      let matchingRollouts = 0;
      let completedTurn = false;
      let count = 0;
      async function visit(directory: FileHandle, prefix: string, depth: number): Promise<void> {
        if (depth > MAX_NATIVE_CHECKPOINT_DIRECTORY_DEPTH) {
          throw new Error(`${LABEL} contains too many directory levels.`);
        }
        const entries = await readDirectoryEntriesBounded(
          directory,
          LABEL,
          MAX_NATIVE_CHECKPOINT_ENTRIES,
          input.signal,
        );
        for (const entry of entries) {
          input.signal.throwIfAborted();
          if (++count > MAX_NATIVE_CHECKPOINT_ENTRIES)
            throw new Error(`${LABEL} has too many files.`);
          const path = `${prefix}/${entry.name}`;
          if (entry.isDirectory()) {
            await using child = await openRealDirectory(
              directoryEntryPath(directory, entry.name),
              LABEL,
            );
            await visit(child, path, depth + 1);
            continue;
          }
          let { bytes } = await readNativeCheckpointSourceFile(directory, entry.name, input.signal);
          if (prefix.startsWith("sessions") || prefix.startsWith("archived_sessions")) {
            if (!isRolloutPath(path))
              throw new Error(`${LABEL} contains an unexpected history file: ${path}.`);
            const rollout = readRollout(bytes);
            if (rollout.threadId === input.threadId) {
              matchingRollouts++;
              const end = rollout.successfulTurns.get(input.turnId);
              if (end !== undefined) {
                // Native append-and-flush precedes turn/completed; later warm activity is outside this run.
                bytes = bytes.subarray(0, end);
                completedTurn = true;
              }
            }
          }
          await writeSnapshotFile(target, path, bytes, input.signal);
        }
      }
      for (const name of DIRECTORIES) {
        await using source = await openOptionalRealDirectory(directoryEntryPath(home, name), LABEL);
        if (source !== null) await visit(source, name, 0);
      }
      if (matchingRollouts !== 1 || !completedTurn) {
        throw new Error(`${LABEL} requires one matching rollout with a successful persisted turn.`);
      }
    },
  });
}

export async function restoreOpenAiNativeCheckpoint(
  payload: DriverStartInput,
  signal: AbortSignal,
): Promise<void> {
  const { session } = payload.execution;
  if (session.nativeResumeRef === null) {
    if (session.nativeCheckpoint !== null)
      throw new Error(`${LABEL} has no native resume reference.`);
    return;
  }
  const checkpoint = session.nativeCheckpoint;
  if (
    checkpoint === null ||
    checkpoint.nativeRef.kind !== "openai_thread_id" ||
    checkpoint.nativeRef.runtimeId !== "openai-runtime" ||
    !nativeRuntimeRefsEqual(checkpoint.nativeRef, session.nativeResumeRef)
  ) {
    throw new Error(`${LABEL} is required and must match the native resume reference.`);
  }
  const source = await readNativeCheckpoint({ cwd: session.cwd, checkpoint, signal });
  await using home = await ensureAbsoluteRealDirectory(session.homePath, LABEL, signal);
  const stageName = `.checkpoint-restore-${randomUUID()}`;
  const stagePath = directoryEntryPath(home, stageName);
  await mkdir(stagePath, { mode: 0o700 });
  await using stage = await openRealDirectory(stagePath, LABEL);
  const moves: { from: string; to: string }[] = [];
  async function move(from: string, to: string): Promise<void> {
    await rename(from, to);
    moves.push({ from, to });
  }
  let failure: unknown;
  try {
    for (const name of DIRECTORIES) {
      await mkdir(directoryEntryPath(stage, name), { mode: 0o700 });
    }
    let matchingRollouts = 0;
    for (const file of source.manifest.files) {
      const directory = file.path.split("/")[0];
      if (!DIRECTORIES.some((name) => name === directory) || !file.path.includes("/")) {
        throw new Error(`${LABEL} contains an unsupported file: ${file.path}.`);
      }
      const bytes = await source.readFile(file.path);
      if (directory === "sessions" || directory === "archived_sessions") {
        if (!isRolloutPath(file.path))
          throw new Error(`${LABEL} contains an invalid rollout path.`);
        const rollout = readRollout(bytes);
        if (rollout.threadId === checkpoint.nativeRef.value) {
          if (rollout.successfulTurns.size === 0)
            throw new Error(`${LABEL} has no successful persisted turn.`);
          matchingRollouts++;
        }
      }
      await writeSnapshotFile(stage, file.path, bytes, signal);
    }
    if (matchingRollouts !== 1)
      throw new Error(`${LABEL} must contain exactly one matching rollout.`);
    await stage.sync();
    await assertDirectoryIdentity(home, resolve(session.homePath), LABEL);
    // Both databases are projections of canonical rollouts. Rebuilding avoids stale authoritative paths.
    for (const entry of await readDirectoryEntriesBounded(
      home,
      LABEL,
      MAX_NATIVE_CHECKPOINT_ENTRIES,
      signal,
    )) {
      if (SQLITE_PROJECTION.test(entry.name)) {
        await move(
          directoryEntryPath(home, entry.name),
          directoryEntryPath(stage, `${entry.name}.previous`),
        );
      }
    }
    for (const name of DIRECTORIES) {
      signal.throwIfAborted();
      const destination = directoryEntryPath(home, name);
      await using previous = await openOptionalRealDirectory(destination, LABEL);
      if (previous !== null) {
        await assertDirectoryIdentity(previous, destination, LABEL);
        await move(destination, directoryEntryPath(stage, `${name}.previous`));
      }
      await move(directoryEntryPath(stage, name), destination);
      await home.sync();
    }
    await assertDirectoryIdentity(home, resolve(session.homePath), LABEL);
    signal.throwIfAborted();
  } catch (error) {
    failure = error;
    const rollbackErrors: unknown[] = [];
    for (const { from, to } of moves.toReversed()) {
      try {
        await rename(to, from);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (moves.length > 0) {
      for (const directory of [stage, home]) {
        try {
          await directory.sync();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
    }
    if (rollbackErrors.length > 0) {
      // Keep the staging directory because it may contain the only remaining original data.
      throw new AggregateError([error, ...rollbackErrors], `${LABEL} restore rollback failed.`);
    }
  }
  try {
    await removeNativeCheckpointDirectory(stage, stagePath);
    await home.sync();
  } catch (error) {
    failure =
      failure === undefined
        ? error
        : new AggregateError([failure, error], `${LABEL} restore cleanup failed.`);
  }
  if (failure !== undefined) throw failure;
}
