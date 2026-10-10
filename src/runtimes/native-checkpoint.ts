import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { isDriverId, type RunId } from "../protocol/id";
import {
  getNativeCheckpointRelativePath,
  MAX_NATIVE_CHECKPOINT_DIRECTORY_DEPTH,
  MAX_NATIVE_CHECKPOINT_ENTRIES,
  MAX_NATIVE_CHECKPOINT_FILE_BYTES,
  MAX_NATIVE_CHECKPOINT_MANIFEST_BYTES,
  NATIVE_CHECKPOINT_MANIFEST_NAME,
  nativeRuntimeRefsEqual,
  parseNativeCheckpoint,
  parseNativeCheckpointManifest,
  type NativeCheckpoint,
  type NativeCheckpointFile,
  type NativeCheckpointManifest,
} from "../protocol/native-checkpoint";
import type { DriverNativeRuntimeRef } from "../protocol/runtime";
import {
  assertDirectoryIdentity,
  directoryEntryPath,
  hasErrorCode,
  openAbsoluteRealDirectory,
  openOptionalRealDirectory,
  openRealDirectory,
  openRelativeRealDirectory,
  readDirectoryEntriesBounded,
  writeFileAtomically,
} from "./atomic-file";

const CHECKPOINT_LABEL = "Native checkpoint";
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CHECKPOINT_GIT_IGNORE_NAME = ".gitignore";
const CHECKPOINT_GIT_IGNORE_CONTENT = "*\n";

export interface NativeCheckpointRoot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

export async function pinNativeCheckpointRoot(
  cwd: string,
  signal?: AbortSignal,
): Promise<NativeCheckpointRoot> {
  signal?.throwIfAborted();
  const path = await realpath(cwd);
  await using directory = await openAbsoluteRealDirectory(path, CHECKPOINT_LABEL);
  const { dev, ino } = await directory.stat({ bigint: true });
  signal?.throwIfAborted();
  return Object.freeze({ path, dev, ino });
}

async function openCheckpointParent(
  cwd: string,
  checkpoint: NativeCheckpoint,
  create: boolean,
  signal?: AbortSignal,
): Promise<FileHandle> {
  await using root = await openAbsoluteRealDirectory(cwd, CHECKPOINT_LABEL);
  return await openRelativeRealDirectory(
    root,
    dirname(getNativeCheckpointRelativePath(checkpoint.runId)),
    CHECKPOINT_LABEL,
    create,
    signal,
  );
}

async function readRegularFile(
  directory: FileHandle,
  name: string,
  signal: AbortSignal | undefined,
  sync: boolean,
  collect: boolean,
  maxBytes = MAX_NATIVE_CHECKPOINT_FILE_BYTES,
): Promise<{ size: number; sha256: string; bytes: Buffer; mode: number }> {
  signal?.throwIfAborted();
  await using file = await open(directoryEntryPath(directory, name), READ_FLAGS);
  const before = await file.stat({ bigint: true });
  if (!before.isFile() || before.nlink !== 1n) {
    throw new Error(`${CHECKPOINT_LABEL} file must be regular and have no hard links: ${name}.`);
  }
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size > maxBytes) {
    throw new Error(`${CHECKPOINT_LABEL} file exceeds its size limit: ${name}.`);
  }

  const hash = createHash("sha256");
  const buffer = Buffer.alloc(Math.min(size + 1, 64 * 1_024));
  const bytes = Buffer.alloc(collect ? size : 0);
  let offset = 0;
  while (offset <= size) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, size + 1 - offset),
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    if (offset + bytesRead > size) {
      throw new Error(`${CHECKPOINT_LABEL} file grew while being read: ${name}.`);
    }
    hash.update(buffer.subarray(0, bytesRead));
    if (collect) {
      buffer.copy(bytes, offset, 0, bytesRead);
    }
    offset += bytesRead;
  }
  const after = await file.stat({ bigint: true });
  if (
    offset !== size ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.mode !== after.mode ||
    after.nlink !== 1n
  ) {
    throw new Error(`${CHECKPOINT_LABEL} file changed while being read: ${name}.`);
  }
  if (sync) {
    await file.sync();
  }
  return { size, sha256: hash.digest("hex"), bytes, mode: Number(before.mode) & 0o777 };
}

export async function readNativeCheckpointSourceFile(
  directory: FileHandle,
  name: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mode: number }> {
  const { bytes, mode } = await readRegularFile(directory, name, signal, false, true);
  return { bytes, mode };
}

async function scanCheckpoint(
  directory: FileHandle,
  signal: AbortSignal | undefined,
  sync: boolean,
  hasManifest: boolean,
): Promise<NativeCheckpointFile[]> {
  const files: NativeCheckpointFile[] = [];
  let count = 0;
  async function visit(current: FileHandle, prefix: string, depth: number): Promise<void> {
    if (depth > MAX_NATIVE_CHECKPOINT_DIRECTORY_DEPTH) {
      throw new Error(`${CHECKPOINT_LABEL} has too many directory levels.`);
    }
    const entries = await readDirectoryEntriesBounded(
      current,
      CHECKPOINT_LABEL,
      MAX_NATIVE_CHECKPOINT_ENTRIES,
      signal,
    );
    for (const entry of entries) {
      signal?.throwIfAborted();
      count += 1;
      if (count > MAX_NATIVE_CHECKPOINT_ENTRIES) {
        throw new Error(`${CHECKPOINT_LABEL} contains too many entries.`);
      }
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (path === NATIVE_CHECKPOINT_MANIFEST_NAME) {
        if (!hasManifest) {
          throw new Error(`${CHECKPOINT_LABEL} uses the reserved manifest filename.`);
        }
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`${CHECKPOINT_LABEL} must not contain symbolic links: ${path}.`);
      }
      if (entry.isDirectory()) {
        await using child = await openRealDirectory(
          directoryEntryPath(current, entry.name),
          CHECKPOINT_LABEL,
        );
        await visit(child, path, depth + 1);
      } else {
        const { size, sha256 } = await readRegularFile(current, entry.name, signal, sync, false);
        files.push({ path, size, sha256 });
      }
    }
    if (sync) {
      await current.sync();
    }
  }
  await visit(directory, "", 0);
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

async function validateCheckpoint(
  directory: FileHandle,
  expected: NativeCheckpoint,
  signal?: AbortSignal,
): Promise<NativeCheckpointManifest> {
  const { bytes } = await readRegularFile(
    directory,
    NATIVE_CHECKPOINT_MANIFEST_NAME,
    signal,
    false,
    true,
    MAX_NATIVE_CHECKPOINT_MANIFEST_BYTES,
  );
  const manifest = parseNativeCheckpointManifest(JSON.parse(bytes.toString("utf8")));
  if (
    manifest.runId !== expected.runId ||
    !nativeRuntimeRefsEqual(manifest.nativeRef, expected.nativeRef)
  ) {
    throw new Error(`${CHECKPOINT_LABEL} identity does not match its descriptor.`);
  }
  const files = await scanCheckpoint(directory, signal, false, true);
  const expectedFiles = new Map(manifest.files.map((file) => [file.path, file]));
  if (
    files.length !== expectedFiles.size ||
    files.some((file) => {
      const expectedFile = expectedFiles.get(file.path);
      return expectedFile?.size !== file.size || expectedFile.sha256 !== file.sha256;
    })
  ) {
    throw new Error(`${CHECKPOINT_LABEL} files do not match the manifest.`);
  }
  return manifest;
}

export async function removeNativeCheckpointDirectory(
  directory: FileHandle,
  path: string,
): Promise<void> {
  await assertDirectoryIdentity(directory, path, CHECKPOINT_LABEL);
  const entries = await readDirectoryEntriesBounded(
    directory,
    CHECKPOINT_LABEL,
    MAX_NATIVE_CHECKPOINT_ENTRIES,
  );
  for (const entry of entries) {
    const entryPath = directoryEntryPath(directory, entry.name);
    if (entry.isDirectory()) {
      await using child = await openRealDirectory(entryPath, CHECKPOINT_LABEL);
      await removeNativeCheckpointDirectory(child, entryPath);
    } else {
      await unlink(entryPath);
    }
  }
  await assertDirectoryIdentity(directory, path, CHECKPOINT_LABEL);
  await rmdir(path);
}

export async function createNativeCheckpoint(input: {
  cwd: string;
  runId: RunId;
  nativeRef: DriverNativeRuntimeRef;
  signal: AbortSignal;
  write: (stagingDirectory: string) => Promise<void>;
}): Promise<NativeCheckpoint> {
  const checkpoint = parseNativeCheckpoint({
    formatVersion: 1,
    runId: input.runId,
    nativeRef: input.nativeRef,
  });
  input.signal.throwIfAborted();
  const cwd = await realpath(input.cwd);
  await using parent = await openCheckpointParent(cwd, checkpoint, true, input.signal);
  try {
    await using existingIgnore = await open(
      directoryEntryPath(parent, CHECKPOINT_GIT_IGNORE_NAME),
      READ_FLAGS,
    );
    const stats = await existingIgnore.stat();
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error(
        `${CHECKPOINT_LABEL} Git ignore file must be regular and have no hard links.`,
      );
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  // A native Git snapshot must not recursively include earlier checkpoint bundles.
  await writeFileAtomically(
    parent,
    CHECKPOINT_GIT_IGNORE_NAME,
    CHECKPOINT_GIT_IGNORE_CONTENT,
    0o600,
    input.signal,
  );
  const destination = directoryEntryPath(parent, checkpoint.runId);
  await using existing = await openOptionalRealDirectory(destination, CHECKPOINT_LABEL);
  if (existing !== null) {
    await validateCheckpoint(existing, checkpoint, input.signal);
    await parent.sync();
    return checkpoint;
  }

  const temporaryName = `.${checkpoint.runId}.${randomUUID()}.tmp`;
  const temporaryPath = directoryEntryPath(parent, temporaryName);
  await mkdir(temporaryPath, { mode: 0o700 });
  await using staging = await openRealDirectory(temporaryPath, CHECKPOINT_LABEL);
  let published = false;
  let failure: { error: unknown } | undefined;
  try {
    // Keep the callback anchored to this directory even if an ancestor is renamed.
    await input.write(join("/proc", String(process.pid), "fd", String(staging.fd)));
    const files = await scanCheckpoint(staging, input.signal, true, false);
    const manifest = parseNativeCheckpointManifest({ ...checkpoint, files });
    const serialized = JSON.stringify(manifest);
    if (Buffer.byteLength(serialized) > MAX_NATIVE_CHECKPOINT_MANIFEST_BYTES) {
      throw new Error(`${CHECKPOINT_LABEL} manifest exceeds its size limit.`);
    }
    await writeFileAtomically(
      staging,
      NATIVE_CHECKPOINT_MANIFEST_NAME,
      serialized,
      0o600,
      input.signal,
    );
    await assertDirectoryIdentity(staging, temporaryPath, CHECKPOINT_LABEL);
    await assertDirectoryIdentity(
      parent,
      resolve(cwd, dirname(getNativeCheckpointRelativePath(checkpoint.runId))),
      CHECKPOINT_LABEL,
    );
    input.signal.throwIfAborted();
    try {
      await rename(temporaryPath, destination);
      published = true;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST") && !hasErrorCode(error, "ENOTEMPTY")) {
        throw error;
      }
      await using winner = await openRealDirectory(destination, CHECKPOINT_LABEL);
      await validateCheckpoint(winner, checkpoint, input.signal);
    }
    await parent.sync();
  } catch (error) {
    failure = { error };
  }
  if (!published) {
    try {
      await removeNativeCheckpointDirectory(staging, temporaryPath);
      await parent.sync();
    } catch (cleanupError) {
      failure = {
        error:
          failure === undefined
            ? cleanupError
            : new AggregateError(
                [failure.error, cleanupError],
                `${CHECKPOINT_LABEL} staging cleanup failed.`,
              ),
      };
    }
  }
  if (failure !== undefined) {
    throw failure.error;
  }
  return checkpoint;
}

export async function pruneNativeCheckpoints(
  pinnedRoot: NativeCheckpointRoot,
  keepCheckpoint: NativeCheckpoint | null,
): Promise<void> {
  const keep = keepCheckpoint === null ? null : parseNativeCheckpoint(keepCheckpoint);
  await using root = await openAbsoluteRealDirectory(pinnedRoot.path, CHECKPOINT_LABEL);
  const identity = await root.stat({ bigint: true });
  if (identity.dev !== pinnedRoot.dev || identity.ino !== pinnedRoot.ino) {
    throw new Error(`${CHECKPOINT_LABEL} root changed after startup: ${pinnedRoot.path}.`);
  }
  await using state = await openOptionalRealDirectory(
    directoryEntryPath(root, ".state"),
    CHECKPOINT_LABEL,
  );
  if (state === null) return;
  await using parent = await openOptionalRealDirectory(
    directoryEntryPath(state, "native-checkpoints"),
    CHECKPOINT_LABEL,
  );
  if (parent === null) return;
  const entries = await readDirectoryEntriesBounded(
    parent,
    CHECKPOINT_LABEL,
    MAX_NATIVE_CHECKPOINT_ENTRIES,
  );
  if (entries.some((entry) => entry.name === CHECKPOINT_GIT_IGNORE_NAME)) {
    const ignore = await readRegularFile(
      parent,
      CHECKPOINT_GIT_IGNORE_NAME,
      undefined,
      false,
      true,
      CHECKPOINT_GIT_IGNORE_CONTENT.length,
    );
    if (ignore.bytes.toString("utf8") !== CHECKPOINT_GIT_IGNORE_CONTENT) {
      throw new Error(`${CHECKPOINT_LABEL} Git ignore file has unexpected contents.`);
    }
  }
  for (const entry of entries) {
    if (!isDriverId(entry.name) || entry.name === keep?.runId) continue;
    const path = directoryEntryPath(parent, entry.name);
    await using directory = await openRealDirectory(path, CHECKPOINT_LABEL);
    await removeNativeCheckpointDirectory(directory, path);
  }
  await parent.sync();
}

export async function readNativeCheckpoint(input: {
  cwd: string;
  checkpoint: NativeCheckpoint;
  signal?: AbortSignal;
}): Promise<{
  directory: string;
  manifest: NativeCheckpointManifest;
  readFile: (path: string) => Promise<Buffer>;
}> {
  const checkpoint = parseNativeCheckpoint(input.checkpoint);
  input.signal?.throwIfAborted();
  const cwd = await realpath(input.cwd);
  await using parent = await openCheckpointParent(cwd, checkpoint, false, input.signal);
  await using directory = await openRealDirectory(
    directoryEntryPath(parent, checkpoint.runId),
    CHECKPOINT_LABEL,
  );
  const manifest = await validateCheckpoint(directory, checkpoint, input.signal);
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  return {
    directory: resolve(cwd, getNativeCheckpointRelativePath(checkpoint.runId)),
    manifest,
    async readFile(path) {
      const expected = files.get(path);
      if (expected === undefined) {
        throw new Error(`${CHECKPOINT_LABEL} file is not in the manifest: ${path}.`);
      }
      await using root = await openAbsoluteRealDirectory(cwd, CHECKPOINT_LABEL);
      const parts = path.split("/");
      const name = parts.pop()!;
      await using fileParent = await openRelativeRealDirectory(
        root,
        [getNativeCheckpointRelativePath(checkpoint.runId), ...parts].join("/"),
        CHECKPOINT_LABEL,
        false,
        input.signal,
      );
      const file = await readRegularFile(
        fileParent,
        name,
        input.signal,
        false,
        true,
        expected.size,
      );
      if (file.size !== expected.size || file.sha256 !== expected.sha256) {
        throw new Error(`${CHECKPOINT_LABEL} file no longer matches its manifest: ${path}.`);
      }
      return file.bytes;
    },
  };
}
