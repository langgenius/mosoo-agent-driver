import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, opendir, rename, rmdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { AgentDriverMaterializedSkill } from "../host-ports";
import type { Logger } from "../observability";
import type { DriverResolvedSkill } from "../protocol/boot";
import type { DriverExecutionInput } from "../protocol/execution";
import { extractZipArchive } from "../skill-package";
import type { SkillArchiveExtractOptions, SkillPackageEntry } from "../skill-package";
import {
  assertDirectoryIdentity,
  closeFileHandles,
  directoryEntryPath,
  ensureRealDirectoryAt,
  hasErrorCode,
  openedDirectoryPath,
  openAbsoluteRealDirectory,
  openOptionalRealDirectory,
  openRealDirectory,
  openRelativeRealDirectory,
  readPathStats,
  readDirectoryEntriesBounded,
} from "./atomic-file";

const MAX_SKILL_COMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_SKILL_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const SKILL_DOWNLOAD_TIMEOUT_MS = 30_000;
const SKILL_ARCHIVE_EXTRACT_OPTIONS: SkillArchiveExtractOptions = {
  maxEntryCount: 256,
  maxFileBytes: MAX_SKILL_ENTRY_BYTES,
  maxTotalFileBytes: MAX_SKILL_UNCOMPRESSED_BYTES,
};

interface MaterializationRoots {
  readonly mosooDirectory: FileHandle;
  readonly mosooRoot: string;
  readonly mountRoot: string;
  readonly transactionDirectory: FileHandle;
  readonly transactionRoot: string;
}

interface ResolvedSkillInput {
  readonly mountPath: string;
  readonly skill: DriverResolvedSkill;
  readonly snapshotId: string;
}

interface MaterializationOwner {
  currentName: string;
  readonly newDirectory: FileHandle | null;
  readonly ownerDirectory: FileHandle;
}

interface QuarantineCleanupBudget {
  readonly deadlineMs: number;
  remainingEntries: number;
}

interface QuarantineCleanupFrame {
  readonly directory: Awaited<ReturnType<typeof opendir>>;
  readonly handle: FileHandle;
  readonly removePath: string;
}

const latestGenerationByRoot = new Map<string, AbortController>();
const activeStagingPaths = new Set<string>();

const SKILL_STAGING_DIRECTORY_PATTERN =
  /^stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SKILL_QUARANTINE_DIRECTORY_PATTERN =
  /^quarantine-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_MANAGED_DIRECTORY_ENTRIES = 1_024;
const SKILL_QUARANTINE_CLEANUP_BUDGET_MS = 250;
const MAX_SKILL_QUARANTINE_CLEANUP_ENTRIES = 1_024;
const MAX_SKILL_QUARANTINE_CLEANUP_DEPTH = 64;
const SKILL_TRANSACTION_ACTIVE_NAME = "active";
const SKILL_TRANSACTION_COMMIT_MARKER_NAME = "COMMITTED";

function createSerialLock(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const predecessor = tail;
    const release = Promise.withResolvers<void>();
    tail = release.promise;
    await predecessor;
    try {
      return await operation();
    } finally {
      release.resolve();
    }
  };
}

// ponytail: startup-only materialization is serialized process-wide until contention is measured.
const withCommitLock = createSerialLock();
const withCleanupLock = createSerialLock();

function enforceSkillMountPath(sessionOrganizationPath: string, mountPath: string): string {
  const allowedRoot = resolve(sessionOrganizationPath, ".mosoo", "skill");
  const resolvedMountPath = resolve(mountPath);

  if (dirname(resolvedMountPath) !== allowedRoot) {
    throw new Error(`Resolved skill mount path is outside the allowed root: ${mountPath}.`);
  }

  return resolvedMountPath;
}

async function ensureMaterializationRoots(
  sessionOrganizationPath: string,
  create: boolean,
  signal: AbortSignal,
): Promise<MaterializationRoots | null> {
  signal.throwIfAborted();
  const sharedRoot = resolve(sessionOrganizationPath);
  const mosooRoot = join(sharedRoot, ".mosoo");
  const mountRoot = join(mosooRoot, "skill");
  const transactionRoot = join(mosooRoot, ".skill-transactions");
  const sharedRootDirectory = await openAbsoluteRealDirectory(sharedRoot, "Session shared root");
  let mosooRootDirectory: FileHandle | null = null;
  let transactionDirectory: FileHandle | null = null;
  let result: MaterializationRoots | null = null;

  try {
    mosooRootDirectory = create
      ? await ensureRealDirectoryAt(sharedRootDirectory, ".mosoo", "Session .mosoo root", signal)
      : await openOptionalRealDirectory(
          directoryEntryPath(sharedRootDirectory, ".mosoo"),
          "Session .mosoo root",
        );
    if (mosooRootDirectory === null) {
      result = null;
    } else {
      transactionDirectory = await openOptionalRealDirectory(
        directoryEntryPath(mosooRootDirectory, ".skill-transactions"),
        "Skill transaction root",
      );
      if (
        create ||
        transactionDirectory !== null ||
        (await readPathStats(directoryEntryPath(mosooRootDirectory, "skill"))) !== null
      ) {
        transactionDirectory ??= await ensureRealDirectoryAt(
          mosooRootDirectory,
          ".skill-transactions",
          "Skill transaction root",
          signal,
        );
        result = {
          mosooDirectory: mosooRootDirectory,
          mosooRoot,
          mountRoot,
          transactionDirectory,
          transactionRoot,
        };
      }
    }
  } catch (error) {
    const closeFailures = await closeFileHandles([
      transactionDirectory,
      mosooRootDirectory,
      sharedRootDirectory,
    ]);
    if (closeFailures.length > 0) {
      throw new AggregateError([error, ...closeFailures], "Failed to open skill roots.");
    }
    throw error;
  }

  const closeFailures = await closeFileHandles([
    result === null ? mosooRootDirectory : null,
    sharedRootDirectory,
  ]);
  if (closeFailures.length > 0) {
    const ownedCloseFailures =
      result === null
        ? []
        : await closeFileHandles([result.transactionDirectory, result.mosooDirectory]);
    throw new AggregateError(
      [...closeFailures, ...ownedCloseFailures],
      "Failed to close skill root ancestors.",
    );
  }
  return result;
}

async function assertMaterializationRootIdentities(roots: MaterializationRoots): Promise<void> {
  await assertDirectoryIdentity(roots.mosooDirectory, roots.mosooRoot, "Session .mosoo root");
  await assertDirectoryIdentity(
    roots.transactionDirectory,
    roots.transactionRoot,
    "Skill transaction root",
  );
}

async function assertSkillMountLeaf(mountPath: string): Promise<void> {
  const stats = await readPathStats(mountPath);

  if (stats !== null && (stats.isSymbolicLink() || !stats.isDirectory())) {
    throw new Error(`Resolved skill mount must be a real directory or absent: ${mountPath}.`);
  }
}

function createQuarantineCleanupBudget(): QuarantineCleanupBudget {
  return {
    deadlineMs: Date.now() + SKILL_QUARANTINE_CLEANUP_BUDGET_MS,
    remainingEntries: MAX_SKILL_QUARANTINE_CLEANUP_ENTRIES,
  };
}

async function openQuarantineCleanupFrame(removePath: string): Promise<QuarantineCleanupFrame> {
  const handle = await openRealDirectory(removePath, "Skill quarantine directory");

  try {
    return {
      directory: await opendir(openedDirectoryPath(handle)),
      handle,
      removePath,
    };
  } catch (error) {
    const closeFailures = await closeFileHandles([handle]);
    if (closeFailures.length > 0) {
      throw new AggregateError(
        [error, ...closeFailures],
        "Failed to open a skill quarantine directory.",
      );
    }
    throw error;
  }
}

async function closeQuarantineCleanupFrames(
  frames: readonly QuarantineCleanupFrame[],
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    frames.flatMap((frame) => [frame.directory.close(), frame.handle.close()]),
  );
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

async function cleanupQuarantine(
  path: string,
  budget: QuarantineCleanupBudget,
  transactionDirectory: FileHandle,
): Promise<boolean> {
  const rootStats = await readPathStats(path);

  if (rootStats === null) {
    return true;
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    await unlink(path);
    return true;
  }

  const frames: QuarantineCleanupFrame[] = [await openQuarantineCleanupFrame(path)];
  let complete = true;
  let operationError: unknown = null;

  try {
    while (frames.length > 0) {
      if (budget.remainingEntries <= 0 || Date.now() >= budget.deadlineMs) {
        complete = false;
        break;
      }

      const frame = frames[frames.length - 1];
      if (frame === undefined) {
        throw new Error("Skill quarantine traversal lost its active directory.");
      }
      const entry = await frame.directory.read();

      if (entry === null) {
        frames.pop();
        const closeFailures = await closeQuarantineCleanupFrames([frame]);
        if (closeFailures.length > 0) {
          throw new AggregateError(closeFailures, "Failed to close skill quarantine handles.");
        }
        budget.remainingEntries -= 1;
        try {
          await rmdir(frame.removePath);
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) {
            continue;
          }
          if (hasErrorCode(error, "ENOTEMPTY")) {
            complete = false;
            break;
          }
          throw error;
        }
        continue;
      }

      budget.remainingEntries -= 1;
      const entryPath = directoryEntryPath(frame.handle, entry.name);
      const stats = await readPathStats(entryPath);
      if (stats === null) {
        continue;
      }
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        if (frames.length >= MAX_SKILL_QUARANTINE_CLEANUP_DEPTH) {
          await rename(
            entryPath,
            directoryEntryPath(transactionDirectory, `quarantine-${randomUUID()}`),
          );
          await transactionDirectory.sync();
          complete = false;
          continue;
        }
        frames.push(await openQuarantineCleanupFrame(entryPath));
      } else {
        await unlink(entryPath);
      }
    }
  } catch (error) {
    operationError = error;
  }

  const closeFailures = await closeQuarantineCleanupFrames(frames);
  if (operationError !== null) {
    if (closeFailures.length > 0) {
      throw new AggregateError(
        [operationError, ...closeFailures],
        "Skill quarantine cleanup and resource cleanup failed.",
      );
    }
    throw operationError;
  }
  if (closeFailures.length > 0) {
    throw new AggregateError(closeFailures, "Failed to close skill quarantine handles.");
  }
  return complete;
}

export async function materializeResolvedSkills(
  execution: DriverExecutionInput,
  logger: Logger,
  signal: AbortSignal,
): Promise<AgentDriverMaterializedSkill[]> {
  signal.throwIfAborted();
  const inputs = resolveSkillInputs(execution, logger);
  const rootKey = resolve(execution.session.sharedRootPath);
  const generation = new AbortController();
  const superseded = new Error("Skill materialization was superseded by a newer generation.");

  await withCommitLock(async () => {
    signal.throwIfAborted();
    latestGenerationByRoot.get(rootKey)?.abort(superseded);
    latestGenerationByRoot.set(rootKey, generation);
  });

  const operationSignal = AbortSignal.any([signal, generation.signal]);
  try {
    const roots = await ensureMaterializationRoots(
      execution.session.sharedRootPath,
      inputs.length > 0,
      operationSignal,
    );
    if (roots === null) {
      return [];
    }

    await using _mosooDirectory = roots.mosooDirectory;
    await using _transactionDirectory = roots.transactionDirectory;
    return await materializeSkillGeneration(
      logger,
      inputs,
      roots,
      generation.signal,
      operationSignal,
    );
  } finally {
    if (latestGenerationByRoot.get(rootKey) === generation) {
      latestGenerationByRoot.delete(rootKey);
    }
  }
}

async function materializeSkillGeneration(
  logger: Logger,
  inputs: readonly ResolvedSkillInput[],
  roots: MaterializationRoots,
  generationSignal: AbortSignal,
  operationSignal: AbortSignal,
): Promise<AgentDriverMaterializedSkill[]> {
  let liveCatalogExists = false;
  await withCommitLock(async () => {
    operationSignal.throwIfAborted();
    await withCleanupLock(async () => recoverSkillTransactions(roots, logger, operationSignal));
    await assertMaterializationRootIdentities(roots);
    await assertDesiredSkillMounts(roots, inputs);
    liveCatalogExists =
      (await readPathStats(directoryEntryPath(roots.mosooDirectory, "skill"))) !== null;
  });

  if (inputs.length === 0 && !liveCatalogExists) {
    operationSignal.throwIfAborted();
    return [];
  }

  const owner = await createMaterializationOwner(roots, operationSignal);
  let result: AgentDriverMaterializedSkill[] | null = null;
  let materializationError: unknown = null;
  try {
    for (const input of inputs) {
      await prepareSkill(input, owner, operationSignal);
    }

    await withCommitLock(async () => {
      operationSignal.throwIfAborted();
      await assertMaterializationRootIdentities(roots);
      await assertDesiredSkillMounts(roots, inputs);
      await commitSkillTransaction(owner, roots, operationSignal);
    });
    generationSignal.throwIfAborted();
    await assertMaterializationRootIdentities(roots);
    result = inputs.map(({ mountPath, skill, snapshotId }) => ({
      mountPath,
      skillId: skill.skillId,
      skillMarkdownPath: join(mountPath, "SKILL.md"),
      skillName: skill.skillName,
      snapshotId,
    }));
  } catch (error) {
    materializationError = error;
  }

  const cleanupFailures = await disposeMaterializationOwner(owner, roots, logger);
  if (materializationError !== null) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [materializationError, ...cleanupFailures],
        "Skill materialization cleanup failed.",
      );
    }
    throw materializationError;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "Skill materialization cleanup failed.");
  }
  if (result === null) {
    throw new Error("Skill generation completed without a result.");
  }
  return result;
}

function resolveSkillInputs(execution: DriverExecutionInput, logger: Logger): ResolvedSkillInput[] {
  const inputs: ResolvedSkillInput[] = [];
  const mounts = new Set<string>();
  const names = new Set<string>();

  for (const skill of execution.skills) {
    const snapshotId = skill.snapshotId;

    if (
      skill.resolutionMode === "tombstone" ||
      snapshotId === undefined ||
      snapshotId === null ||
      snapshotId.length === 0
    ) {
      logger.info("driver.skill.skipped", {
        reason: skill.warningCode ?? "skill.tombstone",
        skillId: skill.skillId,
        skillName: skill.skillName,
      });
      continue;
    }

    const mountPath = enforceSkillMountPath(execution.session.sharedRootPath, skill.mountPath);
    if (mounts.has(mountPath)) {
      throw new Error(`Resolved skills contain a duplicate mount path: ${mountPath}.`);
    }
    if (names.has(skill.skillName)) {
      throw new Error(`Resolved skills contain a duplicate skill name: ${skill.skillName}.`);
    }
    mounts.add(mountPath);
    names.add(skill.skillName);
    inputs.push({ mountPath, skill, snapshotId });
  }

  validateActiveSkillCatalog(execution, inputs);
  return inputs;
}

function validateActiveSkillCatalog(
  execution: DriverExecutionInput,
  inputs: readonly ResolvedSkillInput[],
): void {
  const activeCatalog = new Map<string, DriverExecutionInput["skillCatalog"][number]>();
  const catalogIds = new Set<string>();
  const catalogNames = new Set<string>();
  const catalogMounts = new Set<string>();

  for (const entry of execution.skillCatalog) {
    const mountPath = enforceSkillMountPath(execution.session.sharedRootPath, entry.mountPath);
    if (catalogIds.has(entry.skillId)) {
      throw new Error(`Skill catalog contains a duplicate skill ID: ${entry.skillId}.`);
    }
    if (catalogNames.has(entry.skillName)) {
      throw new Error(`Skill catalog contains a duplicate skill name: ${entry.skillName}.`);
    }
    if (catalogMounts.has(mountPath)) {
      throw new Error(`Skill catalog contains a duplicate mount path: ${mountPath}.`);
    }

    catalogIds.add(entry.skillId);
    catalogNames.add(entry.skillName);
    catalogMounts.add(mountPath);
    if (entry.resolutionMode !== "tombstone") {
      activeCatalog.set(entry.skillId, entry);
    }
  }

  if (activeCatalog.size !== inputs.length) {
    throw new Error("Active skill catalog does not match the resolved skill set.");
  }

  for (const input of inputs) {
    const entry = activeCatalog.get(input.skill.skillId);
    if (
      entry === undefined ||
      entry.skillName !== input.skill.skillName ||
      resolve(entry.mountPath) !== input.mountPath ||
      entry.resolutionMode !== input.skill.resolutionMode
    ) {
      throw new Error(
        `Active skill catalog entry does not match resolved skill ${input.skill.skillId}.`,
      );
    }
  }
}

async function assertDesiredSkillMounts(
  roots: MaterializationRoots,
  inputs: readonly ResolvedSkillInput[],
): Promise<void> {
  const mountPath = directoryEntryPath(roots.mosooDirectory, "skill");
  const mountDirectory = await openOptionalRealDirectory(mountPath, "Skill mount root");
  if (mountDirectory === null) {
    return;
  }
  await using ownedMountDirectory = mountDirectory;
  for (const input of inputs) {
    await assertSkillMountLeaf(directoryEntryPath(ownedMountDirectory, basename(input.mountPath)));
  }
  await assertDirectoryIdentity(ownedMountDirectory, roots.mountRoot, "Skill mount root");
}

async function createMaterializationOwner(
  roots: MaterializationRoots,
  signal: AbortSignal,
): Promise<MaterializationOwner> {
  signal.throwIfAborted();
  const transactionId = randomUUID();
  const currentName = `stage-${transactionId}`;
  const currentPath = directoryEntryPath(roots.transactionDirectory, currentName);
  const ownerKey = join(roots.transactionRoot, currentName);
  let ownerDirectory: FileHandle | null = null;
  let newDirectory: FileHandle | null = null;
  activeStagingPaths.add(ownerKey);

  try {
    await mkdir(currentPath, { mode: 0o700 });
    ownerDirectory = await openRealDirectory(currentPath, "Skill transaction owner");
    newDirectory = await ensureRealDirectoryAt(ownerDirectory, "new", "New skill owner", signal);
    await Promise.all([newDirectory.sync(), ownerDirectory.sync()]);
    await roots.transactionDirectory.sync();
    return {
      currentName,
      newDirectory,
      ownerDirectory,
    };
  } catch (error) {
    activeStagingPaths.delete(ownerKey);
    const failures = await closeFileHandles([newDirectory, ownerDirectory]);
    try {
      await cleanupQuarantine(
        currentPath,
        createQuarantineCleanupBudget(),
        roots.transactionDirectory,
      );
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], "Failed to create a skill transaction owner.");
    }
    throw error;
  }
}

async function prepareSkill(
  input: ResolvedSkillInput,
  owner: MaterializationOwner,
  signal: AbortSignal,
): Promise<void> {
  if (owner.newDirectory === null) {
    throw new Error("New skill transaction root is missing.");
  }
  const downloaded = await downloadSkillPackage(input.skill, signal);

  signal.throwIfAborted();
  const entries = extractZipArchive(downloaded, SKILL_ARCHIVE_EXTRACT_OPTIONS);
  if (!entries.some((entry) => entry.entryKind === "file" && entry.path === "SKILL.md")) {
    throw new Error(`Skill package for ${input.skill.skillId} does not contain SKILL.md.`);
  }

  signal.throwIfAborted();
  const stagingPath = directoryEntryPath(owner.newDirectory, basename(input.mountPath));
  await mkdir(stagingPath, { mode: 0o700 });
  await using stagingDirectory = await openRealDirectory(stagingPath, "Staged skill root");
  for (const entry of entries) {
    await materializeSkillEntry(stagingDirectory, entry, signal);
  }
  await syncSkillStageDirectories(stagingDirectory, entries, signal);
  await owner.newDirectory.sync();
  await assertDirectoryIdentity(stagingDirectory, stagingPath, "Staged skill root");

  signal.throwIfAborted();
  await using manifest = await open(
    directoryEntryPath(stagingDirectory, "SKILL.md"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  if (!(await manifest.stat()).isFile()) {
    throw new Error(`Skill package for ${input.skill.skillId} has an invalid SKILL.md.`);
  }
}

async function commitSkillTransaction(
  owner: MaterializationOwner,
  roots: MaterializationRoots,
  signal: AbortSignal,
): Promise<void> {
  if (owner.newDirectory === null) {
    throw new Error("New skill transaction root is missing.");
  }
  await Promise.all([owner.newDirectory.sync(), owner.ownerDirectory.sync()]);
  await assertDirectoryIdentity(
    owner.newDirectory,
    directoryEntryPath(owner.ownerDirectory, "new"),
    "New skill catalog root",
  );
  signal.throwIfAborted();
  await assertMaterializationRootIdentities(roots);
  await renameMaterializationOwner(owner, roots, SKILL_TRANSACTION_ACTIVE_NAME);

  let markerCreated = false;
  try {
    await moveLiveSkillCatalogToBackup(owner, roots);
    signal.throwIfAborted();
    await assertMaterializationRootIdentities(roots);
    await assertDirectoryIdentity(
      owner.newDirectory,
      directoryEntryPath(owner.ownerDirectory, "new"),
      "New skill catalog root",
    );
    if ((await readPathStats(directoryEntryPath(roots.mosooDirectory, "skill"))) !== null) {
      throw new Error("Skill mount root changed during catalog commit.");
    }
    await using marker = await open(
      directoryEntryPath(owner.ownerDirectory, SKILL_TRANSACTION_COMMIT_MARKER_NAME),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    markerCreated = true;
    await marker.sync();
    await owner.ownerDirectory.sync();
  } catch (error) {
    try {
      if (markerCreated) {
        await finishCommittedSkillTransaction(owner, roots);
        await retireMaterializationOwner(owner, roots);
      } else {
        await rollbackSkillTransaction(owner, roots);
      }
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        markerCreated
          ? "Skill materialization committed but could not finish installing the catalog."
          : "Skill materialization failed and could not be fully rolled back.",
      );
    }
    throw error;
  }

  await finishCommittedSkillTransaction(owner, roots);
  await retireMaterializationOwner(owner, roots);
}

async function moveLiveSkillCatalogToBackup(
  owner: MaterializationOwner,
  roots: MaterializationRoots,
): Promise<void> {
  const livePath = directoryEntryPath(roots.mosooDirectory, "skill");
  const oldPath = directoryEntryPath(owner.ownerDirectory, "old");
  const liveStats = await readPathStats(livePath);
  if (liveStats === null) {
    return;
  }
  if (liveStats.isSymbolicLink() || !liveStats.isDirectory()) {
    throw new Error(`Skill mount root must be a real directory: ${roots.mountRoot}.`);
  }
  if ((await readPathStats(oldPath)) !== null) {
    throw new Error("Skill transaction backup already exists.");
  }

  await rename(livePath, oldPath);
  await Promise.all([roots.mosooDirectory.sync(), owner.ownerDirectory.sync()]);
  const oldStats = await readPathStats(oldPath);
  if (oldStats === null || oldStats.dev !== liveStats.dev || oldStats.ino !== liveStats.ino) {
    throw new Error("Skill mount root changed during catalog commit.");
  }
}

async function rollbackSkillTransaction(
  owner: MaterializationOwner,
  roots: MaterializationRoots,
): Promise<void> {
  if (owner.newDirectory === null) {
    throw new Error("Interrupted skill transaction lost its new catalog root.");
  }
  const livePath = directoryEntryPath(roots.mosooDirectory, "skill");
  const oldPath = directoryEntryPath(owner.ownerDirectory, "old");
  const [liveStats, oldStats] = await Promise.all([
    readPathStats(livePath),
    readPathStats(oldPath),
  ]);
  if (liveStats !== null && oldStats !== null) {
    throw new Error("Interrupted skill transaction has both live and old catalog roots.");
  }
  if (
    (liveStats !== null && (liveStats.isSymbolicLink() || !liveStats.isDirectory())) ||
    (oldStats !== null && (oldStats.isSymbolicLink() || !oldStats.isDirectory()))
  ) {
    throw new Error("Interrupted skill catalog root must be a real directory.");
  }
  if (oldStats !== null) {
    await rename(oldPath, livePath);
    await Promise.all([roots.mosooDirectory.sync(), owner.ownerDirectory.sync()]);
  }
  await retireMaterializationOwner(owner, roots);
}

async function finishCommittedSkillTransaction(
  owner: MaterializationOwner,
  roots: MaterializationRoots,
): Promise<void> {
  const livePath = directoryEntryPath(roots.mosooDirectory, "skill");
  const newPath = directoryEntryPath(owner.ownerDirectory, "new");
  const [liveStats, newStats] = await Promise.all([
    readPathStats(livePath),
    readPathStats(newPath),
  ]);
  if (liveStats !== null && newStats !== null) {
    throw new Error("Committed skill transaction has both live and new catalog roots.");
  }
  if (liveStats === null && newStats === null) {
    throw new Error("Committed skill transaction lost its catalog root.");
  }
  if (liveStats !== null) {
    if (liveStats.isSymbolicLink() || !liveStats.isDirectory()) {
      throw new Error("Committed skill catalog root must be a real directory.");
    }
    return;
  }
  if (newStats!.isSymbolicLink() || !newStats!.isDirectory()) {
    throw new Error("New skill catalog root must be a real directory.");
  }
  await rename(newPath, livePath);
  await Promise.all([roots.mosooDirectory.sync(), owner.ownerDirectory.sync()]);
  if (owner.newDirectory !== null) {
    await assertDirectoryIdentity(owner.newDirectory, roots.mountRoot, "Skill mount root");
  }
}

async function renameMaterializationOwner(
  owner: MaterializationOwner,
  roots: MaterializationRoots,
  nextName: string,
): Promise<void> {
  const previousName = owner.currentName;
  const previousPath = directoryEntryPath(roots.transactionDirectory, previousName);
  try {
    await assertDirectoryIdentity(owner.ownerDirectory, previousPath, "Skill transaction owner");
  } catch (error) {
    await quarantineChangedOwnerEntry(owner, roots, previousName);
    throw error;
  }
  await rename(
    directoryEntryPath(roots.transactionDirectory, previousName),
    directoryEntryPath(roots.transactionDirectory, nextName),
  );
  activeStagingPaths.delete(join(roots.transactionRoot, previousName));
  owner.currentName = nextName;
  await roots.transactionDirectory.sync();
  try {
    await assertDirectoryIdentity(
      owner.ownerDirectory,
      directoryEntryPath(roots.transactionDirectory, nextName),
      "Skill transaction owner",
    );
  } catch (error) {
    await quarantineChangedOwnerEntry(owner, roots, nextName);
    throw error;
  }
}

async function quarantineChangedOwnerEntry(
  owner: MaterializationOwner,
  roots: MaterializationRoots,
  entryName: string,
): Promise<void> {
  const entryPath = directoryEntryPath(roots.transactionDirectory, entryName);
  const stats = await readPathStats(entryPath);
  activeStagingPaths.delete(join(roots.transactionRoot, entryName));
  if (stats === null) {
    return;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    await unlink(entryPath);
    await roots.transactionDirectory.sync();
    return;
  }

  const quarantineName = `quarantine-${randomUUID()}`;
  await rename(entryPath, directoryEntryPath(roots.transactionDirectory, quarantineName));
  owner.currentName = quarantineName;
  await roots.transactionDirectory.sync();
}

async function retireMaterializationOwner(
  owner: MaterializationOwner,
  roots: MaterializationRoots,
): Promise<void> {
  await renameMaterializationOwner(owner, roots, `quarantine-${randomUUID()}`);
}

async function openExistingMaterializationOwner(
  roots: MaterializationRoots,
): Promise<MaterializationOwner> {
  const currentPath = directoryEntryPath(roots.transactionDirectory, SKILL_TRANSACTION_ACTIVE_NAME);
  const ownerDirectory = await openRealDirectory(currentPath, "Active skill transaction owner");
  let newDirectory: FileHandle | null = null;
  try {
    newDirectory = await openOptionalRealDirectory(
      directoryEntryPath(ownerDirectory, "new"),
      "Active new skill owner",
    );
    return {
      currentName: SKILL_TRANSACTION_ACTIVE_NAME,
      newDirectory,
      ownerDirectory,
    };
  } catch (error) {
    const closeFailures = await closeFileHandles([newDirectory, ownerDirectory]);
    if (closeFailures.length > 0) {
      throw new AggregateError(
        [error, ...closeFailures],
        "Failed to open the active skill transaction.",
      );
    }
    throw error;
  }
}

async function hasSkillTransactionCommitMarker(owner: MaterializationOwner): Promise<boolean> {
  let marker: FileHandle;
  try {
    marker = await open(
      directoryEntryPath(owner.ownerDirectory, SKILL_TRANSACTION_COMMIT_MARKER_NAME),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }

  await using ownedMarker = marker;
  const stats = await ownedMarker.stat();
  if (!stats.isFile() || stats.size !== 0) {
    throw new Error("Skill transaction commit marker is invalid.");
  }
  return true;
}

async function disposeMaterializationOwner(
  owner: MaterializationOwner,
  roots: MaterializationRoots,
  logger: Logger,
): Promise<unknown[]> {
  activeStagingPaths.delete(join(roots.transactionRoot, owner.currentName));
  const failures = await closeFileHandles([owner.newDirectory, owner.ownerDirectory]);
  if (owner.currentName === SKILL_TRANSACTION_ACTIVE_NAME) {
    return failures;
  }

  try {
    await withCleanupLock(async () => {
      if (
        !(await cleanupQuarantine(
          directoryEntryPath(roots.transactionDirectory, owner.currentName),
          createQuarantineCleanupBudget(),
          roots.transactionDirectory,
        ))
      ) {
        logger.info("driver.skill.materialization.transaction_cleanup_deferred", {
          transactionPath: owner.currentName,
        });
      }
    });
  } catch (error) {
    logger.warn("driver.skill.materialization.transaction_cleanup_failed", {
      error,
      transactionPath: owner.currentName,
    });
  }
  return failures;
}

async function recoverSkillTransactions(
  roots: MaterializationRoots,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  const entries = await readDirectoryEntriesBounded(
    roots.transactionDirectory,
    "Skill transaction root",
    MAX_MANAGED_DIRECTORY_ENTRIES,
    signal,
  );
  const cleanupBudget = createQuarantineCleanupBudget();
  const activeEntry = entries.find((entry) => entry.name === SKILL_TRANSACTION_ACTIVE_NAME);
  if (activeEntry !== undefined) {
    signal.throwIfAborted();
    if (activeEntry.isSymbolicLink() || !activeEntry.isDirectory()) {
      throw new Error("Active skill transaction owner must be a real directory.");
    }
    const owner = await openExistingMaterializationOwner(roots);
    let retiredPath: string | null = null;
    {
      await using _ownerDirectory = owner.ownerDirectory;
      await using _newDirectory = owner.newDirectory;
      if (await hasSkillTransactionCommitMarker(owner)) {
        await finishCommittedSkillTransaction(owner, roots);
        await retireMaterializationOwner(owner, roots);
        logger.info("driver.skill.materialization.transaction_finished", {});
      } else {
        await rollbackSkillTransaction(owner, roots);
        logger.info("driver.skill.materialization.transaction_restored", {});
      }
      retiredPath = directoryEntryPath(roots.transactionDirectory, owner.currentName);
    }
    if (retiredPath !== null) {
      try {
        if (!(await cleanupQuarantine(retiredPath, cleanupBudget, roots.transactionDirectory))) {
          logger.info("driver.skill.materialization.transaction_cleanup_deferred", {
            transactionPath: basename(retiredPath),
          });
        }
      } catch (error) {
        logger.warn("driver.skill.materialization.transaction_cleanup_failed", {
          error,
          transactionPath: basename(retiredPath),
        });
      }
    }
  }

  for (const entry of entries) {
    signal.throwIfAborted();
    const isStaging = SKILL_STAGING_DIRECTORY_PATTERN.test(entry.name);
    const isQuarantine = SKILL_QUARANTINE_DIRECTORY_PATTERN.test(entry.name);
    if (
      (!isStaging && !isQuarantine) ||
      activeStagingPaths.has(join(roots.transactionRoot, entry.name))
    ) {
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      await unlink(directoryEntryPath(roots.transactionDirectory, entry.name));
      continue;
    }

    try {
      if (
        !(await cleanupQuarantine(
          directoryEntryPath(roots.transactionDirectory, entry.name),
          cleanupBudget,
          roots.transactionDirectory,
        ))
      ) {
        logger.info("driver.skill.materialization.transaction_cleanup_deferred", {
          transactionPath: entry.name,
        });
      }
    } catch (error) {
      logger.warn("driver.skill.materialization.transaction_cleanup_failed", {
        error,
        transactionPath: entry.name,
      });
    }
  }
  await roots.transactionDirectory.sync();
}

async function materializeSkillEntry(
  stagingDirectory: FileHandle,
  entry: SkillPackageEntry,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();

  if (entry.entryKind === "directory") {
    await using _directory = await openRelativeRealDirectory(
      stagingDirectory,
      entry.path,
      "Staged skill directory",
      true,
      signal,
    );
    return;
  }

  await using parent = await openRelativeRealDirectory(
    stagingDirectory,
    dirname(entry.path),
    "Staged skill directory",
    true,
    signal,
  );
  signal.throwIfAborted();
  await using file = await open(
    directoryEntryPath(parent, basename(entry.path)),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    entry.isExecutable ? 0o755 : 0o644,
  );
  await file.writeFile(entry.body, { signal });
  await file.sync();
}

async function syncSkillStageDirectories(
  stagingDirectory: FileHandle,
  entries: readonly SkillPackageEntry[],
  signal: AbortSignal,
): Promise<void> {
  const directories = new Set<string>(["."]);

  for (const entry of entries) {
    let directory = entry.entryKind === "directory" ? entry.path : dirname(entry.path);
    while (directory !== ".") {
      directories.add(directory);
      directory = dirname(directory);
    }
  }

  for (const directory of [...directories].toSorted(
    (a, b) => b.split("/").length - a.split("/").length,
  )) {
    signal.throwIfAborted();
    await using handle = await openRelativeRealDirectory(
      stagingDirectory,
      directory,
      "Staged skill directory",
      false,
      signal,
    );
    await handle.sync();
  }
}

async function downloadSkillPackage(
  skill: DriverResolvedSkill,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(SKILL_DOWNLOAD_TIMEOUT_MS)]);
  requestSignal.throwIfAborted();
  const response = await fetch(skill.downloadUrl, { signal: requestSignal });

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Failed to download skill package for ${skill.skillId}: ${response.status}.`);
  }
  if (response.body === null) {
    throw new Error(`Skill package download for ${skill.skillId} has no response body.`);
  }

  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_SKILL_COMPRESSED_BYTES
  ) {
    await response.body.cancel().catch(() => {});
    throw new Error(
      `Compressed skill package exceeds the limit (${MAX_SKILL_COMPRESSED_BYTES} bytes).`,
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let totalBytes = 0;
  const onAbort = () => {
    void reader.cancel(requestSignal.reason).catch(() => {});
  };
  requestSignal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      requestSignal.throwIfAborted();
      const { done, value } = await reader.read();
      requestSignal.throwIfAborted();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > MAX_SKILL_COMPRESSED_BYTES) {
        const error = new Error(
          `Compressed skill package exceeds the limit (${MAX_SKILL_COMPRESSED_BYTES} bytes).`,
        );
        await reader.cancel(error).catch(() => {});
        throw error;
      }

      chunks.push(value);
      hash.update(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    requestSignal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks, totalBytes);

  if (hash.digest("hex") !== skill.blobSha256) {
    throw new Error(`Skill blob checksum mismatch for ${skill.skillId}.`);
  }
  return bytes;
}
