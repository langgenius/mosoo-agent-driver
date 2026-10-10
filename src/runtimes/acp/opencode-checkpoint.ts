import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunId } from "../../protocol/id";
import {
  MAX_NATIVE_CHECKPOINT_DIRECTORY_DEPTH,
  MAX_NATIVE_CHECKPOINT_ENTRIES,
  MAX_NATIVE_CHECKPOINT_FILE_BYTES,
  type NativeCheckpoint,
} from "../../protocol/native-checkpoint";
import { createNativeCheckpoint, readNativeCheckpoint } from "../native-checkpoint";
import type { NativeCheckpointRoot } from "../native-checkpoint";
import {
  directoryEntryPath,
  ensureAbsoluteRealDirectory,
  openAbsoluteRealDirectory,
  openOptionalRealDirectory,
  openRealDirectory,
  openedDirectoryPath,
  openRelativeRealDirectory,
  readDirectoryEntriesBounded,
} from "../atomic-file";

export interface OpenCodeUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  totalTokens: number;
  costAmount: number;
}

export function openCodeDataPath(homePath: string): string {
  return join(homePath, ".local", "share", "opencode");
}

const FILE_METADATA_DIRECTORIES = ["tool-output", "plans", "storage"] as const;

const zeroUsage = (): OpenCodeUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  totalTokens: 0,
  costAmount: 0,
});

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenCode native usage contains an invalid object.");
  }
  return value as Record<string, unknown>;
}

function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("OpenCode native usage contains an invalid token count.");
  }
  return value;
}

function databaseUsage(database: Database, sessionId: string): OpenCodeUsage {
  if (database.query("SELECT id FROM session WHERE id = ?").get(sessionId) === null) {
    throw new Error("OpenCode native checkpoint is missing its session.");
  }
  const rows = database
    .query<{ data: string }, [string]>(`
    WITH RECURSIVE sessions(id) AS (
      SELECT id FROM session WHERE id = ?
      UNION SELECT child.id FROM session child JOIN sessions parent ON child.parent_id = parent.id
    ) SELECT part.data FROM part JOIN sessions ON sessions.id = part.session_id
      WHERE json_extract(part.data, '$.type') = 'step-finish'
  `)
    .all(sessionId);
  const usage = zeroUsage();
  for (const row of rows) {
    const part = record(JSON.parse(row.data));
    const tokens = record(part["tokens"]);
    const cache = record(tokens["cache"]);
    const cost = part["cost"];
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      throw new Error("OpenCode native usage contains an invalid cost.");
    }
    usage.inputTokens += counter(tokens["input"]);
    usage.outputTokens += counter(tokens["output"]);
    usage.thoughtTokens += counter(tokens["reasoning"]);
    usage.cachedReadTokens += counter(cache["read"]);
    usage.cachedWriteTokens += counter(cache["write"]);
    usage.costAmount += cost;
  }
  usage.totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.thoughtTokens +
    usage.cachedReadTokens +
    usage.cachedWriteTokens;
  for (const [key, value] of Object.entries(usage)) {
    if (!Number.isFinite(value) || (key !== "costAmount" && !Number.isSafeInteger(value))) {
      throw new Error("OpenCode native usage exceeds the supported range.");
    }
  }
  return usage;
}

export function readOpenCodeUsage(dataPath: string, sessionId: string): OpenCodeUsage {
  using database = new Database(join(dataPath, "opencode.db"), { readonly: true });
  return databaseUsage(database, sessionId);
}

export function openCodeRunUsage(current: OpenCodeUsage, baseline: OpenCodeUsage): OpenCodeUsage {
  const usage = zeroUsage();
  for (const key of Object.keys(usage) as (keyof OpenCodeUsage)[]) {
    const difference = current[key] - baseline[key];
    if (!Number.isFinite(difference) || difference < 0) {
      throw new Error("OpenCode native usage decreased during a run.");
    }
    usage[key] = difference;
  }
  return usage;
}

async function copyMetadata(
  source: string,
  destination: string,
  signal: AbortSignal,
  budget: { remainingEntries: number },
  depth = 1,
): Promise<void> {
  await using directory = await openOptionalRealDirectory(source, "OpenCode native metadata");
  if (directory === null) return;
  if (depth > MAX_NATIVE_CHECKPOINT_DIRECTORY_DEPTH) {
    throw new Error("OpenCode native metadata has too many directory levels.");
  }
  if (budget.remainingEntries-- <= 0) {
    throw new Error("OpenCode native metadata contains too many entries.");
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readDirectoryEntriesBounded(
    directory,
    "OpenCode native metadata",
    budget.remainingEntries,
    signal,
  )) {
    signal.throwIfAborted();
    const from = directoryEntryPath(directory, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyMetadata(from, to, signal, budget, depth + 1);
    } else {
      if (budget.remainingEntries-- <= 0) {
        throw new Error("OpenCode native metadata contains too many entries.");
      }
      await using file = await open(
        from,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) {
        throw new Error("OpenCode native metadata contains a non-regular file.");
      }
      if (before.size > BigInt(MAX_NATIVE_CHECKPOINT_FILE_BYTES)) {
        throw new Error("OpenCode native metadata file exceeds its size limit.");
      }
      const size = Number(before.size);
      const buffer = Buffer.alloc(Math.min(size + 1, 64 * 1_024));
      let offset = 0;
      await using output = await open(to, "wx", 0o600);
      while (offset <= size) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, size + 1 - offset),
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
        if (offset > size) {
          throw new Error("OpenCode native metadata grew during checkpoint export.");
        }
        await output.writeFile(buffer.subarray(0, bytesRead), { signal });
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
        throw new Error("OpenCode native metadata changed during checkpoint export.");
      }
    }
  }
}

function snapshotRoots(database: Database): string[] {
  const roots = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || value.length === 0) return;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))
      throw new Error("OpenCode native snapshot has an invalid object ID.");
    roots.add(value);
  };
  const parts = database
    .query<{ data: string }, []>(`
    SELECT data FROM part WHERE json_extract(data, '$.type') IN ('step-start', 'step-finish', 'patch')
  `)
    .all();
  for (const row of parts) {
    const part = record(JSON.parse(row.data));
    add(part["type"] === "patch" ? part["hash"] : part["snapshot"]);
  }
  if (
    database
      .query<{ name: string }, []>("PRAGMA table_info(session)")
      .all()
      .some((column) => column.name === "revert")
  ) {
    for (const row of database
      .query<{ revert: string }, []>("SELECT revert FROM session WHERE revert IS NOT NULL")
      .all()) {
      add(record(JSON.parse(row.revert))["snapshot"]);
    }
  }
  return [...roots];
}

async function runSnapshotGit(args: string[], input: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const child = spawn("git", args, { signal, stdio: ["pipe", "pipe", "ignore"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    return await new Promise<string>((resolve, reject) => {
      let output = "";
      child.once("error", reject);
      child.stdin.on("error", reject);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > input.length * 4 + 1024) {
          child.kill("SIGKILL");
          reject(new Error("OpenCode snapshot export returned excessive output."));
        }
      });
      child.once("close", (code) =>
        code === 0 ? resolve(output) : reject(new Error("OpenCode snapshot object export failed.")),
      );
      child.stdin.end(input);
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await closed;
  }
}

async function packSnapshot(
  source: string,
  destination: string,
  roots: string[],
  signal: AbortSignal,
): Promise<void> {
  const objects = await runSnapshotGit(
    ["--git-dir", source, "cat-file", "--batch-check"],
    roots.join("\n") + "\n",
    signal,
  );
  const available = objects.split("\n").flatMap((line) => {
    const [hash, type] = line.split(" ");
    return type === "tree" && hash !== undefined ? [hash] : [];
  });
  if (available.length === 0) return;
  await mkdir(join(destination, "objects", "pack"), { recursive: true, mode: 0o700 });
  await writeFile(join(destination, "HEAD"), "ref: refs/heads/master\n", { mode: 0o600, signal });
  await writeFile(
    join(destination, "config"),
    `[core]\nrepositoryformatversion = ${available[0]!.length === 64 ? 1 : 0}\nbare = false\nautocrlf = false\nlongpaths = true\nsymlinks = true\nfsmonitor = false\n${available[0]!.length === 64 ? "[extensions]\nobjectformat = sha256\n" : ""}`,
    { mode: 0o600, signal },
  );
  await mkdir(join(destination, "refs"));
  await writeFile(join(destination, "refs", ".keep"), "", { mode: 0o600, signal });
  // Native write-tree snapshots may be dangling and borrow blobs through alternates.
  // Pack the referenced trees' full closure, without unrelated repository history.
  await runSnapshotGit(
    ["--git-dir", source, "pack-objects", "--revs", join(destination, "objects", "pack", "pack")],
    available.join("\n") + "\n",
    signal,
  );
}

async function exportSnapshots(
  dataPath: string,
  directory: string,
  database: Database,
  signal: AbortSignal,
): Promise<void> {
  const roots = snapshotRoots(database);
  if (roots.length === 0) return;
  await using root = await openOptionalRealDirectory(
    join(dataPath, "snapshot"),
    "OpenCode snapshot",
  );
  if (root === null) return;
  for (const projectName of await readdir(openedDirectoryPath(root))) {
    await using project = await openRealDirectory(
      directoryEntryPath(root, projectName),
      "OpenCode snapshot project",
    );
    for (const worktreeName of await readdir(openedDirectoryPath(project))) {
      await using worktree = await openRealDirectory(
        directoryEntryPath(project, worktreeName),
        "OpenCode snapshot worktree",
      );
      const source = join("/proc", String(process.pid), "fd", String(worktree.fd));
      await packSnapshot(
        source,
        join(directory, "snapshot", projectName, worktreeName),
        roots,
        signal,
      );
    }
  }
}

export async function exportOpenCodeCheckpoint(input: {
  root: NativeCheckpointRoot;
  dataPath: string;
  runId: RunId;
  sessionId: string;
  baseline: OpenCodeUsage;
  signal: AbortSignal;
}): Promise<{ checkpoint: NativeCheckpoint; usage: OpenCodeUsage }> {
  const checkpoint = await createNativeCheckpoint({
    root: input.root,
    runId: input.runId,
    nativeRef: { runtimeId: "acp-fallback", kind: "acp_session_id", value: input.sessionId },
    signal: input.signal,
    write: async (directory) => {
      input.signal.throwIfAborted();
      await using nativeRoot = await openAbsoluteRealDirectory(
        input.dataPath,
        "OpenCode native state",
      );
      using database = new Database(directoryEntryPath(nativeRoot, "opencode.db"), {
        readonly: true,
      });
      database.exec("PRAGMA busy_timeout = 5000");
      database.query("VACUUM INTO ?").run(join(directory, "opencode.db"));
      using snapshot = new Database(join(directory, "opencode.db"), { readonly: true });
      databaseUsage(snapshot, input.sessionId);
      // Reserve entries for the database and manifest before copying metadata.
      const budget = { remainingEntries: MAX_NATIVE_CHECKPOINT_ENTRIES - 2 };
      for (const name of FILE_METADATA_DIRECTORIES) {
        await copyMetadata(
          directoryEntryPath(nativeRoot, name),
          join(directory, name),
          input.signal,
          budget,
        );
      }
      await exportSnapshots(openedDirectoryPath(nativeRoot), directory, snapshot, input.signal);
    },
  });
  // Use the sealed snapshot on retries, even if the live process has advanced.
  const saved = await readNativeCheckpoint({
    cwd: input.root.path,
    checkpoint,
    signal: input.signal,
  });
  using database = Database.deserialize(await saved.readFile("opencode.db"), { readonly: true });
  return {
    checkpoint,
    usage: openCodeRunUsage(databaseUsage(database, input.sessionId), input.baseline),
  };
}

export async function restoreOpenCodeCheckpoint(input: {
  cwd: string;
  dataPath: string;
  checkpoint: NativeCheckpoint;
  signal: AbortSignal;
}): Promise<void> {
  const saved = await readNativeCheckpoint(input);
  for (const file of saved.manifest.files) {
    if (
      file.path !== "opencode.db" &&
      !file.path.startsWith("snapshot/") &&
      !FILE_METADATA_DIRECTORIES.some((name) => file.path.startsWith(`${name}/`))
    ) {
      throw new Error("OpenCode native checkpoint contains an unsupported file.");
    }
  }
  const bytes = await saved.readFile("opencode.db");
  using database = Database.deserialize(bytes, { readonly: true });
  databaseUsage(database, input.checkpoint.nativeRef.value);
  await using root = await ensureAbsoluteRealDirectory(
    input.dataPath,
    "OpenCode native restore",
    input.signal,
  );
  // The provider has not started yet. Remove stale journals before replacing its database.
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await rm(directoryEntryPath(root, `opencode.db${suffix}`), { force: true });
  }
  for (const name of ["snapshot", ...FILE_METADATA_DIRECTORIES]) {
    await rm(directoryEntryPath(root, name), { force: true, recursive: true });
  }
  for (const file of saved.manifest.files) {
    input.signal.throwIfAborted();
    const segments = file.path.split("/");
    const name = segments.pop()!;
    await using parent = await openRelativeRealDirectory(
      root,
      segments.join("/") || ".",
      "OpenCode native restore",
      true,
      input.signal,
    );
    const temporary = directoryEntryPath(parent, `.${name}.${randomUUID()}.restore`);
    try {
      await using output = await open(temporary, "wx", 0o600);
      await output.writeFile(
        file.path === "opencode.db" ? bytes : await saved.readFile(file.path),
        { signal: input.signal },
      );
      await output.sync();
      input.signal.throwIfAborted();
      await rename(temporary, directoryEntryPath(parent, name));
      await parent.sync();
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
