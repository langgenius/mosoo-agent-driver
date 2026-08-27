import { createHash } from "node:crypto";
import { readlink, symlink, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type { AgentDriverMaterializedSkill } from "../host-ports";
import type { Logger } from "../observability";
import type { DriverSkillCatalogEntry } from "../protocol/boot";
import type { DriverExecutionInput } from "../protocol/execution";
import {
  assertDirectoryIdentity,
  closeFileHandles,
  cleanupAtomicWriteTemporaryFiles,
  directoryEntryPath,
  ensureAbsoluteRealDirectory,
  ensureRealDirectoryAt,
  openAbsoluteRealDirectory,
  openRealDirectory,
  readDirectoryEntriesBounded,
  writeFileAtomically,
} from "./atomic-file";

const NATIVE_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NATIVE_SKILL_ALIAS_ENTRIES = 1_024;

interface SkillCatalogManifestEntry {
  frontmatter: DriverSkillCatalogEntry["frontmatter"];
  mountPath: string;
  resolutionMode: DriverSkillCatalogEntry["resolutionMode"];
  skillId: string;
  skillMarkdownPath: string;
  skillName: string;
}

export interface SkillBootstrapArtifacts {
  manifestPath: string;
  readmePath: string;
}

function getSkillCatalogRoot(execution: DriverExecutionInput): string {
  return join(execution.session.sharedRootPath, ".mosoo", "skills");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function openOptionalRealDirectory(path: string, label: string): Promise<FileHandle | null> {
  try {
    return await openRealDirectory(path, label);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function openOptionalAbsoluteRealDirectory(
  path: string,
  label: string,
): Promise<FileHandle | null> {
  try {
    return await openAbsoluteRealDirectory(path, label);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function ensureNativeSkillAliasRoot(
  sharedRootPath: string,
  create: boolean,
  signal: AbortSignal,
): Promise<{ directory: FileHandle; path: string } | null> {
  signal.throwIfAborted();
  const sharedRoot = resolve(sharedRootPath);
  const aliasRoot = join(sharedRoot, ".agents", "skills");
  const sharedRootDirectory = await openAbsoluteRealDirectory(sharedRoot, "Session shared root");
  let agentsRootDirectory: FileHandle | null = null;
  let aliasDirectory: FileHandle | null = null;

  try {
    agentsRootDirectory = create
      ? await ensureRealDirectoryAt(
          sharedRootDirectory,
          ".agents",
          "Native skill alias root",
          signal,
        )
      : await openOptionalRealDirectory(
          directoryEntryPath(sharedRootDirectory, ".agents"),
          "Native skill alias root",
        );
    if (agentsRootDirectory !== null) {
      aliasDirectory = create
        ? await ensureRealDirectoryAt(
            agentsRootDirectory,
            "skills",
            "Native skill alias root",
            signal,
          )
        : await openOptionalRealDirectory(
            directoryEntryPath(agentsRootDirectory, "skills"),
            "Native skill alias root",
          );
    }
  } catch (error) {
    const closeFailures = await closeFileHandles([
      aliasDirectory,
      agentsRootDirectory,
      sharedRootDirectory,
    ]);
    if (closeFailures.length > 0) {
      throw new AggregateError(
        [error, ...closeFailures],
        "Failed to open native skill alias root.",
      );
    }
    throw error;
  }

  const closeFailures = await closeFileHandles([agentsRootDirectory, sharedRootDirectory]);
  if (closeFailures.length > 0) {
    const aliasCloseFailures = await closeFileHandles([aliasDirectory]);
    throw new AggregateError(
      [...closeFailures, ...aliasCloseFailures],
      "Failed to close native skill alias ancestors.",
    );
  }
  return aliasDirectory === null ? null : { directory: aliasDirectory, path: aliasRoot };
}

function resolveMaterializedSkillMount(sharedRootPath: string, mountPath: string): string {
  const resolvedMount = resolve(mountPath);
  if (dirname(resolvedMount) !== resolve(sharedRootPath, ".mosoo", "skill")) {
    throw new Error(`Resolved skill mount path is outside the allowed root: ${mountPath}.`);
  }
  return resolvedMount;
}

function isManagedNativeSkillAliasTarget(sharedRootPath: string, target: string): boolean {
  return dirname(resolve(target)) === resolve(sharedRootPath, ".mosoo", "skill");
}

export async function exposeNativeSkillAliases(
  execution: DriverExecutionInput,
  logger: Logger,
  materializedSkills: readonly AgentDriverMaterializedSkill[],
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();
  const desired = new Map<string, AgentDriverMaterializedSkill>();

  for (const skill of materializedSkills) {
    signal.throwIfAborted();
    if (skill.skillName.length > 64 || !NATIVE_SKILL_NAME_PATTERN.test(skill.skillName)) {
      logger.warn("driver.skill.native_alias.skipped", {
        reason: "invalid_name",
        skillId: skill.skillId,
        skillName: skill.skillName,
      });
      continue;
    }
    if (desired.has(skill.skillName)) {
      throw new Error(`Materialized skills contain a duplicate skill name: ${skill.skillName}.`);
    }

    const mountPath = resolveMaterializedSkillMount(
      execution.session.sharedRootPath,
      skill.mountPath,
    );
    if (resolve(skill.skillMarkdownPath) !== join(mountPath, "SKILL.md")) {
      throw new Error(`Native skill path mismatch for "${skill.skillName}".`);
    }
    desired.set(skill.skillName, skill);
  }

  const aliasRoot = await ensureNativeSkillAliasRoot(
    execution.session.sharedRootPath,
    desired.size > 0,
    signal,
  );
  if (aliasRoot === null) {
    return [];
  }

  const retainedAliases = new Set<string>();
  let result: string[] | null = null;
  let operationError: unknown = null;
  try {
    const entries = await readDirectoryEntriesBounded(
      aliasRoot.directory,
      "Native skill alias root",
      MAX_NATIVE_SKILL_ALIAS_ENTRIES,
      signal,
    );
    for (const entry of entries) {
      signal.throwIfAborted();
      const aliasPath = directoryEntryPath(aliasRoot.directory, entry.name);
      const skill = desired.get(entry.name);

      if (entry.isSymbolicLink()) {
        const target = resolve(aliasRoot.path, await readlink(aliasPath));
        if (skill !== undefined && target === resolve(skill.mountPath)) {
          retainedAliases.add(entry.name);
          continue;
        }
        if (isManagedNativeSkillAliasTarget(execution.session.sharedRootPath, target)) {
          await unlink(aliasPath);
          continue;
        }
      }
      if (skill !== undefined) {
        throw new Error(`Native skill alias "${entry.name}" collides with an existing path.`);
      }
    }

    result = [];
    for (const [skillName, skill] of desired) {
      signal.throwIfAborted();
      result.push(join(aliasRoot.path, skillName));
      if (!retainedAliases.has(skillName)) {
        await symlink(
          relative(aliasRoot.path, resolve(skill.mountPath)),
          directoryEntryPath(aliasRoot.directory, skillName),
          "dir",
        );
      }
    }
    await aliasRoot.directory.sync();
    signal.throwIfAborted();
    await assertDirectoryIdentity(aliasRoot.directory, aliasRoot.path, "Native skill alias root");
  } catch (error) {
    operationError = error;
  }

  const closeFailures = await closeFileHandles([aliasRoot.directory]);
  if (operationError !== null) {
    if (closeFailures.length > 0) {
      throw new AggregateError(
        [operationError, ...closeFailures],
        "Native skill alias update and cleanup failed.",
      );
    }
    throw operationError;
  }
  if (closeFailures.length > 0) {
    throw new AggregateError(closeFailures, "Failed to close the native skill alias root.");
  }
  if (result === null) {
    throw new Error("Native skill aliases completed without a result.");
  }
  return result;
}

async function ensureSkillCatalogRoot(
  execution: DriverExecutionInput,
  signal: AbortSignal,
): Promise<{ directory: FileHandle; path: string }> {
  signal.throwIfAborted();
  const sharedRoot = resolve(execution.session.sharedRootPath);
  const mosooRoot = join(sharedRoot, ".mosoo");
  const skillCatalogRoot = join(mosooRoot, "skills");
  const sharedRootDirectory = await openAbsoluteRealDirectory(sharedRoot, "Session shared root");
  let mosooRootDirectory: FileHandle | null = null;
  let skillCatalogRootDirectory: FileHandle | null = null;
  let operationError: unknown = null;

  try {
    mosooRootDirectory = await ensureRealDirectoryAt(
      sharedRootDirectory,
      ".mosoo",
      "Skill bootstrap .mosoo root",
      signal,
    );
    skillCatalogRootDirectory = await ensureRealDirectoryAt(
      mosooRootDirectory,
      "skills",
      "Skill bootstrap catalog root",
      signal,
    );
  } catch (error) {
    operationError = error;
  }

  const ancestorCloseFailures = await closeFileHandles([mosooRootDirectory, sharedRootDirectory]);
  if (operationError !== null || ancestorCloseFailures.length > 0) {
    const catalogCloseFailures = await closeFileHandles([skillCatalogRootDirectory]);
    const failures = [...ancestorCloseFailures, ...catalogCloseFailures];
    if (operationError !== null) {
      throw failures.length > 0
        ? new AggregateError([operationError, ...failures], "Failed to open skill catalog root.")
        : operationError;
    }
    throw new AggregateError(failures, "Failed to close skill catalog ancestors.");
  }
  if (skillCatalogRootDirectory === null) {
    throw new Error("Skill catalog root was not opened.");
  }
  return { directory: skillCatalogRootDirectory, path: skillCatalogRoot };
}

async function unlinkManagedFile(
  directory: FileHandle,
  name: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  try {
    await unlink(directoryEntryPath(directory, name));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function removeSkillBootstrapArtifacts(
  execution: DriverExecutionInput,
  signal: AbortSignal,
): Promise<void> {
  const sharedRoot = resolve(execution.session.sharedRootPath);
  const sharedRootDirectory = await openOptionalAbsoluteRealDirectory(
    sharedRoot,
    "Session shared root",
  );
  if (sharedRootDirectory === null) {
    return;
  }
  let mosooRootDirectory: FileHandle | null = null;
  let skillCatalogRootDirectory: FileHandle | null = null;
  let operationError: unknown = null;

  try {
    mosooRootDirectory = await openOptionalRealDirectory(
      directoryEntryPath(sharedRootDirectory, ".mosoo"),
      "Skill bootstrap .mosoo root",
    );
    if (mosooRootDirectory !== null) {
      skillCatalogRootDirectory = await openOptionalRealDirectory(
        directoryEntryPath(mosooRootDirectory, "skills"),
        "Skill bootstrap catalog root",
      );
    }
    if (skillCatalogRootDirectory !== null) {
      await cleanupAtomicWriteTemporaryFiles(
        skillCatalogRootDirectory,
        ["manifest.json", "README.md"],
        signal,
      );
      await unlinkManagedFile(skillCatalogRootDirectory, "manifest.json", signal);
      await unlinkManagedFile(skillCatalogRootDirectory, "README.md", signal);
      await skillCatalogRootDirectory.sync();
      await assertDirectoryIdentity(
        skillCatalogRootDirectory,
        getSkillCatalogRoot(execution),
        "Skill bootstrap catalog root",
      );
    }
  } catch (error) {
    operationError = error;
  }

  const closeFailures = await closeFileHandles([
    skillCatalogRootDirectory,
    mosooRootDirectory,
    sharedRootDirectory,
  ]);
  if (operationError !== null) {
    if (closeFailures.length > 0) {
      throw new AggregateError(
        [operationError, ...closeFailures],
        "Skill bootstrap removal and cleanup failed.",
      );
    }
    throw operationError;
  }
  if (closeFailures.length > 0) {
    throw new AggregateError(closeFailures, "Failed to close skill bootstrap roots.");
  }
}

function getSkillCatalogManifestEntries(
  execution: DriverExecutionInput,
  materializedSkills: readonly AgentDriverMaterializedSkill[],
): SkillCatalogManifestEntry[] {
  const materializedById = new Map(materializedSkills.map((skill) => [skill.skillId, skill]));
  const matchedSkillIds = new Set<string>();
  const entries = execution.skillCatalog.map((entry) => {
    if (entry.resolutionMode === "tombstone") {
      return {
        frontmatter: entry.frontmatter,
        mountPath: entry.mountPath,
        resolutionMode: entry.resolutionMode,
        skillId: entry.skillId,
        skillMarkdownPath: join(entry.mountPath, "SKILL.md"),
        skillName: entry.skillName,
      };
    }

    const materialized = materializedById.get(entry.skillId);
    if (
      materialized === undefined ||
      materialized.skillName !== entry.skillName ||
      resolve(materialized.mountPath) !== resolve(entry.mountPath)
    ) {
      throw new Error(`Skill catalog does not match materialized skill ${entry.skillId}.`);
    }
    matchedSkillIds.add(entry.skillId);

    return {
      frontmatter: entry.frontmatter,
      mountPath: materialized.mountPath,
      resolutionMode: entry.resolutionMode,
      skillId: materialized.skillId,
      skillMarkdownPath: materialized.skillMarkdownPath,
      skillName: materialized.skillName,
    };
  });

  if (matchedSkillIds.size !== materializedSkills.length) {
    throw new Error("Skill catalog does not match the materialized skill set.");
  }

  return entries;
}

function buildSkillCatalogReadme(manifestEntries: readonly SkillCatalogManifestEntry[]): string {
  const lines = [
    "# Skill Catalog",
    "",
    "The driver prepared the following skill packages for this session.",
    "Only open a skill's `SKILL.md` when the current task clearly matches that skill.",
    "Do not assume the full skill text has already been loaded.",
    "",
  ];

  if (manifestEntries.length === 0) {
    lines.push("No skills are available for this session.", "");
    return lines.join("\n");
  }

  lines.push("## Entries", "");

  for (const entry of manifestEntries) {
    const summary = entry.frontmatter.description?.trim() ?? "No summary provided.";
    lines.push(`- ${entry.skillName} (${entry.resolutionMode})`);
    lines.push(`  Summary: ${summary}`);
    lines.push(`  Path: ${entry.skillMarkdownPath}`);

    if (entry.resolutionMode === "tombstone") {
      lines.push("  Status: unavailable in this session; skip it.");
    }

    lines.push("");
  }

  return lines.join("\n");
}

export async function writeSkillBootstrapArtifacts(
  execution: DriverExecutionInput,
  materializedSkills: readonly AgentDriverMaterializedSkill[],
  signal: AbortSignal,
): Promise<SkillBootstrapArtifacts | null> {
  signal.throwIfAborted();
  const manifestEntries = getSkillCatalogManifestEntries(execution, materializedSkills);

  if (execution.skillCatalog.length === 0) {
    await removeSkillBootstrapArtifacts(execution, signal);
    return null;
  }

  const skillCatalogRoot = await ensureSkillCatalogRoot(execution, signal);
  await using skillCatalogDirectory = skillCatalogRoot.directory;
  const manifestPath = join(skillCatalogRoot.path, "manifest.json");
  const readmePath = join(skillCatalogRoot.path, "README.md");

  await cleanupAtomicWriteTemporaryFiles(
    skillCatalogDirectory,
    ["manifest.json", "README.md"],
    signal,
  );
  await writeFileAtomically(
    skillCatalogDirectory,
    "manifest.json",
    JSON.stringify(manifestEntries, null, 2),
    0o644,
    signal,
  );
  await writeFileAtomically(
    skillCatalogDirectory,
    "README.md",
    buildSkillCatalogReadme(manifestEntries),
    0o644,
    signal,
  );
  await assertDirectoryIdentity(
    skillCatalogDirectory,
    skillCatalogRoot.path,
    "Skill bootstrap catalog root",
  );

  return { manifestPath, readmePath };
}

function buildRuntimeContextSections(execution: DriverExecutionInput): string[] {
  const systemPrompt = execution.systemPrompt.trim();
  const sections: string[] = [];

  if (systemPrompt) {
    sections.push(`Agent profile prompt:\n${systemPrompt}`);
  }

  if (execution.skillCatalog.length > 0) {
    const manifestPath = join(getSkillCatalogRoot(execution), "manifest.json");
    const readmePath = join(getSkillCatalogRoot(execution), "README.md");
    const availableSkills = execution.skillCatalog.filter(
      (entry) => entry.resolutionMode !== "tombstone",
    );
    const unavailableSkills = execution.skillCatalog.filter(
      (entry) => entry.resolutionMode === "tombstone",
    );
    const skillLines = [
      `Skill catalog README: ${readmePath}`,
      `Skill catalog manifest: ${manifestPath}`,
      "When a task clearly matches one of the listed skills, open that skill's `SKILL.md` on demand before acting.",
    ];

    if (availableSkills.length > 0) {
      skillLines.push(
        "Available skills:",
        ...availableSkills.map((entry) => {
          const summary = entry.frontmatter.description?.trim() ?? "No summary provided.";
          return `- ${entry.skillName}: ${summary}. Skill file: ${join(entry.mountPath, "SKILL.md")}`;
        }),
      );
    }

    if (unavailableSkills.length > 0) {
      skillLines.push(
        "Unavailable skills to ignore for this session:",
        ...unavailableSkills.map((entry) => `- ${entry.skillName}`),
      );
    }

    sections.push(skillLines.join("\n"));
  }

  return sections;
}

export function buildRuntimeBootstrapText(execution: DriverExecutionInput): string {
  const contextSections = buildRuntimeContextSections(execution);

  if (contextSections.length === 0) {
    return "";
  }

  return [
    "Internal runtime bootstrap for this session.",
    "Record these instructions for future turns.",
    "Do not treat this as an end-user request.",
    "Do not ask follow-up questions, do not call tools, and do not modify files in response to this bootstrap message.",
    ...contextSections,
    "Reply with exactly READY.",
  ].join("\n\n");
}

export function buildNativeRuntimeSystemPrompt(execution: DriverExecutionInput): string | null {
  const contextSections = buildRuntimeContextSections(execution);

  return contextSections.length > 0
    ? ["Runtime context for this session.", ...contextSections].join("\n\n")
    : null;
}

export async function writeNativeRuntimeSystemPrompt(
  execution: DriverExecutionInput,
  materializedSkills: readonly AgentDriverMaterializedSkill[],
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  getSkillCatalogManifestEntries(execution, materializedSkills);
  const systemPrompt = buildNativeRuntimeSystemPrompt(execution);
  const path = join(execution.session.homePath, "runtime-instructions.md");

  if (systemPrompt === null) {
    const homeDirectory = await openOptionalAbsoluteRealDirectory(
      execution.session.homePath,
      "Runtime home",
    );
    if (homeDirectory === null) {
      return null;
    }
    await using ownedHomeDirectory = homeDirectory;
    await cleanupAtomicWriteTemporaryFiles(ownedHomeDirectory, ["runtime-instructions.md"], signal);
    await unlinkManagedFile(ownedHomeDirectory, "runtime-instructions.md", signal);
    await ownedHomeDirectory.sync();
    await assertDirectoryIdentity(
      ownedHomeDirectory,
      resolve(execution.session.homePath),
      "Runtime home",
    );
    return null;
  }

  await using homeDirectory = await ensureAbsoluteRealDirectory(
    execution.session.homePath,
    "Runtime home",
    signal,
  );
  await cleanupAtomicWriteTemporaryFiles(homeDirectory, ["runtime-instructions.md"], signal);
  await writeFileAtomically(
    homeDirectory,
    "runtime-instructions.md",
    `${systemPrompt}\n`,
    0o600,
    signal,
  );
  await assertDirectoryIdentity(homeDirectory, resolve(execution.session.homePath), "Runtime home");

  return path;
}

export function computeRuntimeBootstrapDigest(execution: DriverExecutionInput): string | null {
  const bootstrapText = buildRuntimeBootstrapText(execution);

  if (!bootstrapText) {
    return null;
  }

  return createHash("sha256").update("runtime-bootstrap-v1\n").update(bootstrapText).digest("hex");
}
