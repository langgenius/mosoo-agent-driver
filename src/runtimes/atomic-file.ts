import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const activeAtomicWriteTemporaryFiles = new Set<string>();
const ATOMIC_WRITE_TEMPORARY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ATOMIC_WRITE_TEMPORARY_SCAN_ENTRIES = 256;
const NON_ABORTING_SIGNAL = AbortSignal.any([]);

export async function closeFileHandles(
  handles: readonly (FileHandle | null | undefined)[],
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    handles
      .filter((handle): handle is FileHandle => handle !== null && handle !== undefined)
      .map((handle) => handle.close()),
  );
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

async function closeFileHandlesAndThrow(
  error: unknown,
  handles: readonly (FileHandle | null | undefined)[],
  message: string,
): Promise<never> {
  const closeFailures = await closeFileHandles(handles);
  throw closeFailures.length > 0 ? new AggregateError([error, ...closeFailures], message) : error;
}

async function atomicWriteTemporaryFileKey(directory: FileHandle, name: string): Promise<string> {
  const stats = await directory.stat();
  return `${String(stats.dev)}:${String(stats.ino)}:${name}`;
}

export function directoryEntryPath(directory: FileHandle, name: string): string {
  if (name.length === 0 || name === "." || name === ".." || basename(name) !== name) {
    throw new Error(`Directory entry name is invalid: ${name}.`);
  }

  return join(openedDirectoryPath(directory), name);
}

export function openedDirectoryPath(directory: FileHandle): string {
  return join("/proc/self/fd", String(directory.fd));
}

export async function openRealDirectory(path: string, label: string): Promise<FileHandle> {
  if (process.platform !== "linux") {
    throw new Error(`${label} requires Linux /proc filesystem capabilities.`);
  }

  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, "ELOOP") || hasErrorCode(error, "ENOTDIR")) {
      throw new Error(`${label} must be a real directory: ${path}.`, { cause: error });
    }
    throw error;
  }
}

export async function openOptionalRealDirectory(
  path: string,
  label: string,
): Promise<FileHandle | null> {
  try {
    return await openRealDirectory(path, label);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

export async function readPathStats(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

export async function ensureRealDirectoryAt(
  parent: FileHandle,
  name: string,
  label: string,
  signal?: AbortSignal,
): Promise<FileHandle> {
  signal?.throwIfAborted();
  const path = directoryEntryPath(parent, name);
  let created = false;

  try {
    await mkdir(path);
    created = true;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }

  const directory = await openRealDirectory(path, label);
  try {
    if (created) {
      await parent.sync();
    }
    signal?.throwIfAborted();
    return directory;
  } catch (error) {
    const closeFailures = await closeFileHandles([directory]);
    if (closeFailures.length > 0) {
      throw new AggregateError([error, ...closeFailures], `Failed to create ${path}.`);
    }
    throw error;
  }
}

async function walkRealDirectory(
  startPath: string,
  segments: readonly string[],
  label: string,
  create: boolean,
  signal?: AbortSignal,
): Promise<FileHandle> {
  signal?.throwIfAborted();
  let directory = await openRealDirectory(startPath, label);

  for (const segment of segments) {
    let next: FileHandle;
    try {
      signal?.throwIfAborted();
      next = create
        ? await ensureRealDirectoryAt(directory, segment, label, signal)
        : await openRealDirectory(directoryEntryPath(directory, segment), label);
    } catch (error) {
      return closeFileHandlesAndThrow(error, [directory], `Failed to walk ${startPath}.`);
    }

    const closeFailures = await closeFileHandles([directory]);
    if (closeFailures.length > 0) {
      return closeFileHandlesAndThrow(
        new AggregateError(closeFailures, `Failed to close an ancestor of ${startPath}.`),
        [next],
        `Failed to walk ${startPath}.`,
      );
    }
    directory = next;
  }

  return directory;
}

export function openAbsoluteRealDirectory(path: string, label: string): Promise<FileHandle> {
  const absolutePath = resolve(path);
  return walkRealDirectory("/", absolutePath.split("/").filter(Boolean), label, false);
}

export function ensureAbsoluteRealDirectory(
  path: string,
  label: string,
  signal?: AbortSignal,
): Promise<FileHandle> {
  const absolutePath = resolve(path);
  return walkRealDirectory("/", absolutePath.split("/").filter(Boolean), label, true, signal);
}

export function openRelativeRealDirectory(
  root: FileHandle,
  path: string,
  label: string,
  create: boolean,
  signal?: AbortSignal,
): Promise<FileHandle> {
  return walkRealDirectory(
    `${openedDirectoryPath(root)}/.`,
    path === "." ? [] : path.split("/"),
    label,
    create,
    signal,
  );
}

export async function assertDirectoryIdentity(
  directory: FileHandle,
  path: string,
  label: string,
): Promise<void> {
  const openedStats = await directory.stat();
  const pathStats = await readPathStats(path);

  if (
    pathStats === null ||
    pathStats.isSymbolicLink() ||
    !pathStats.isDirectory() ||
    pathStats.dev !== openedStats.dev ||
    pathStats.ino !== openedStats.ino
  ) {
    throw new Error(`${label} changed while managed files were being written: ${path}.`);
  }
}

export async function cleanupAtomicWriteTemporaryFiles(
  directory: FileHandle,
  targetNames: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await using entries = await opendir(openedDirectoryPath(directory));
  let removed = false;
  let scanned = 0;

  for await (const entry of entries) {
    signal.throwIfAborted();
    scanned += 1;
    if (scanned > MAX_ATOMIC_WRITE_TEMPORARY_SCAN_ENTRIES) {
      break;
    }

    const target = targetNames.find(
      (name) =>
        entry.name.startsWith(`.${name}.`) &&
        entry.name.endsWith(".tmp") &&
        ATOMIC_WRITE_TEMPORARY_ID_PATTERN.test(entry.name.slice(name.length + 2, -".tmp".length)),
    );
    if (
      target === undefined ||
      activeAtomicWriteTemporaryFiles.has(await atomicWriteTemporaryFileKey(directory, entry.name))
    ) {
      continue;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      throw new Error(`Atomic write temporary path must not be a directory: ${entry.name}.`);
    }

    await unlink(directoryEntryPath(directory, entry.name));
    removed = true;
  }

  if (removed) {
    await directory.sync();
  }
}

export async function readDirectoryEntriesBounded(
  directory: FileHandle,
  label: string,
  maxEntries: number,
  signal?: AbortSignal,
): Promise<Dirent[]> {
  await using stream = await opendir(openedDirectoryPath(directory));
  const entries: Dirent[] = [];

  for await (const entry of stream) {
    signal?.throwIfAborted();
    if (entries.length >= maxEntries) {
      throw new Error(`${label} contains too many entries.`);
    }
    entries.push(entry);
  }

  return entries.toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function writeFileAtomically(
  directory: FileHandle,
  name: string,
  contents: string,
  mode: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const path = directoryEntryPath(directory, name);
  const temporaryName = `.${name}.${randomUUID()}.tmp`;
  const temporaryPath = directoryEntryPath(directory, temporaryName);
  const temporaryKey = await atomicWriteTemporaryFileKey(directory, temporaryName);
  let temporaryFileCreated = false;
  activeAtomicWriteTemporaryFiles.add(temporaryKey);

  try {
    await using temporaryFile = await open(temporaryPath, "wx", mode);
    temporaryFileCreated = true;
    await temporaryFile.writeFile(contents, { encoding: "utf8", signal });
    await temporaryFile.sync();

    signal.throwIfAborted();
    await rename(temporaryPath, path);
    await directory.sync();
  } catch (error) {
    if (temporaryFileCreated) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!hasErrorCode(cleanupError, "ENOENT")) {
          throw new AggregateError([error, cleanupError], `Failed to clean ${temporaryPath}.`);
        }
      }
    }
    throw error;
  } finally {
    activeAtomicWriteTemporaryFiles.delete(temporaryKey);
  }
}

export async function writeFileAtomicallyAtPath(
  path: string,
  contents: string,
  options: { mode: number; skipIfUnchanged?: boolean },
): Promise<boolean> {
  const absolutePath = resolve(path);
  const directoryPath = dirname(absolutePath);
  const name = basename(absolutePath);
  await using directory = await ensureAbsoluteRealDirectory(
    directoryPath,
    "Atomic file parent",
    NON_ABORTING_SIGNAL,
  );
  await cleanupAtomicWriteTemporaryFiles(directory, [name], NON_ABORTING_SIGNAL);

  let written = true;
  if (options.skipIfUnchanged === true) {
    const existing = await (async (): Promise<string | null> => {
      try {
        await using file = await open(
          directoryEntryPath(directory, name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        return (await file.stat()).isFile() ? await file.readFile("utf8") : null;
      } catch {
        return null;
      }
    })();
    written = existing !== contents;
  }

  if (written) {
    await writeFileAtomically(directory, name, contents, options.mode, NON_ABORTING_SIGNAL);
  }
  await assertDirectoryIdentity(directory, directoryPath, "Atomic file parent");
  return written;
}
