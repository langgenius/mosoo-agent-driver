import {
  getSessionMessages,
  getSubagentMessages,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, normalize, relative } from "node:path";

import type { RunId } from "../../protocol/id";
import {
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
  readPathStats,
} from "../atomic-file";
import {
  createNativeCheckpoint,
  readNativeCheckpoint,
  readNativeCheckpointSourceFile,
  removeNativeCheckpointDirectory,
} from "../native-checkpoint";
import { isRecord } from "./agent-sdk-json";
import { resolveClaudeConfigDir } from "./agent-sdk-query-options";
import { requireClaudeNativeSessionId } from "./agent-sdk-resume";
import type { ClaudeTranscriptCursor } from "./agent-sdk-transcript";

const LABEL = "Claude native checkpoint";
const NATIVE_HOME_FILE = "native-home.json";

interface TranscriptReferences {
  readonly toolOutputs: Map<string, number | null>;
  fileHistory: boolean;
}

function sessionPathId(sessionId: string): string {
  requireClaudeNativeSessionId(sessionId);
  if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId)) {
    throw new Error(`${LABEL} session ID cannot be used as a filename.`);
  }
  return sessionId;
}

function isSessionFile(path: string, project: string, sessionId: string): boolean {
  // shortcut: Pinned CLI recovery layouts only; verify additional native paths before upgrading.
  const parts = path.split("/");
  if (parts[0] === "file-history") {
    return (
      parts.length === 3 &&
      parts[1] === sessionId &&
      /^[0-9a-f]{16}(?:[0-9a-f]{48})?@v\d+$/u.test(parts[2]!)
    );
  }
  if (parts[0] !== "projects" || parts[1] !== project) return false;
  if (parts.length === 3) return parts[2] === `${sessionId}.jsonl`;
  if (parts.length !== 5 || parts[2] !== sessionId) return false;
  if (parts[3] === "subagents") {
    return /^agent-[a-zA-Z0-9_-]+\.(?:jsonl|meta\.json)$/u.test(parts[4]!);
  }
  return parts[3] === "tool-results" && /^[a-zA-Z0-9_-]+\.(?:txt|json)$/u.test(parts[4]!);
}

function expectedMessages(
  sessionId: string,
  cursors: readonly ClaudeTranscriptCursor[],
): Map<string, string> {
  if (cursors.length === 0 || cursors.some((cursor) => cursor.sessionId !== sessionId)) {
    throw new Error(`${LABEL} requires the completed Run's assistant transcript boundaries.`);
  }
  return new Map(cursors.map((cursor) => [cursor.messageId, cursor.contentJson]));
}

async function checkTranscript(
  bytes: Buffer,
  sessionId: string,
  expected: ReadonlyMap<string, string>,
  found: Set<string>,
  references: TranscriptReferences,
  agentId?: string,
): Promise<number> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw new Error(`${LABEL} transcript has an incomplete record.`);
  const entries: SessionStoreEntry[] = [];
  const chainExpected = new Set<string>();
  const parents = new Map<string, { parent: string | null; index: number }>();
  let compactIndex = -1;
  for (let start = 0; start < text.length;) {
    const end = text.indexOf("\n", start);
    const line = text.slice(start, end);
    start = end + 1;
    if (line.trim() === "") continue;
    const entry: unknown = JSON.parse(line);
    if (
      !isRecord(entry) ||
      typeof entry["type"] !== "string" ||
      (entry["sessionId"] !== undefined && entry["sessionId"] !== sessionId)
    ) {
      throw new Error(`${LABEL} transcript belongs to an invalid or different native session.`);
    }
    entries.push(entry as SessionStoreEntry);
    references.fileHistory ||=
      entry["type"] === "file-history-snapshot" || entry["type"] === "file-history-delta";
    const toolResult = entry["toolUseResult"];
    if (isRecord(toolResult) && toolResult["persistedOutputPath"] !== undefined) {
      const path = toolResult["persistedOutputPath"];
      const size = toolResult["persistedOutputSize"];
      if (
        typeof path !== "string" ||
        !isAbsolute(path) ||
        (size !== undefined &&
          (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0))
      ) {
        throw new Error(`${LABEL} transcript has an invalid persisted tool output.`);
      }
      references.toolOutputs.set(path, size ?? null);
    }
    if (typeof entry["uuid"] === "string") {
      const parent = entry["parentUuid"];
      if (parent !== undefined && parent !== null && typeof parent !== "string") {
        throw new Error(`${LABEL} transcript has an invalid parent message.`);
      }
      parents.set(entry["uuid"], { parent: parent ?? null, index: entries.length - 1 });
    }
    if (entry["type"] === "system" && entry["subtype"] === "compact_boundary") {
      chainExpected.clear();
      compactIndex = entries.length - 1;
    }
    if (entry["type"] !== "assistant") continue;
    if (
      entry["sessionId"] !== sessionId ||
      typeof entry["uuid"] !== "string" ||
      !isRecord(entry["message"]) ||
      !Array.isArray(entry["message"]["content"])
    ) {
      throw new Error(`${LABEL} transcript contains an invalid assistant record.`);
    }
    if (expected.has(entry["uuid"])) {
      if (JSON.stringify(entry["message"]["content"]) === expected.get(entry["uuid"])) {
        found.add(entry["uuid"]);
        chainExpected.add(entry["uuid"]);
      } else {
        found.delete(entry["uuid"]);
        chainExpected.delete(entry["uuid"]);
      }
    }
  }
  const connected = new Set<string>();
  for (const id of parents.keys()) {
    const visited = new Set<string>();
    let current: string | null = id;
    while (current !== null && !connected.has(current)) {
      const node = parents.get(current);
      if (visited.has(current) || node === undefined) {
        throw new Error(`${LABEL} transcript has a missing or cyclic parent message.`);
      }
      // The native reader repairs preserved history links across compaction.
      if (node.index <= compactIndex) break;
      visited.add(current);
      current = node.parent;
    }
    for (const ancestor of visited) connected.add(ancestor);
  }
  const options = {
    dir: "/",
    sessionStore: { load: async () => entries, append: async () => {} },
  };
  const messages =
    agentId === undefined
      ? await getSessionMessages(sessionId, options)
      : await getSubagentMessages(sessionId, agentId, options);
  let assistants = 0;
  const resumed = new Set<string>();
  for (const entry of messages) {
    if (entry.type !== "assistant") continue;
    assistants += 1;
    if (
      expected.has(entry.uuid) &&
      isRecord(entry.message) &&
      JSON.stringify(entry.message["content"]) === expected.get(entry.uuid)
    ) {
      resumed.add(entry.uuid);
    }
  }
  if ([...chainExpected].some((id) => !resumed.has(id))) {
    throw new Error(`${LABEL} acknowledged output is outside the native resume chain.`);
  }
  return assistants;
}

function assertMessagesPersisted(expected: ReadonlyMap<string, string>, found: Set<string>): void {
  if ([...expected.keys()].some((messageId) => !found.has(messageId))) {
    throw new Error(`${LABEL} is missing an acknowledged assistant record.`);
  }
}

function assertToolOutputsPersisted(
  outputs: ReadonlyMap<string, number | null>,
  nativeHome: string | null,
  project: string,
  sessionId: string,
  files: ReadonlyMap<string, number>,
): void {
  for (const [path, size] of outputs) {
    const storedPath = nativeHome === null ? "" : relative(nativeHome, path);
    if (
      !storedPath.includes("/tool-results/") ||
      !isSessionFile(storedPath, project, sessionId) ||
      !files.has(storedPath) ||
      (size !== null && files.get(storedPath) !== size)
    ) {
      throw new Error(`${LABEL} is missing a complete persisted tool output.`);
    }
  }
}

async function writeSnapshotFile(
  root: FileHandle,
  path: string,
  bytes: Buffer,
  signal: AbortSignal,
  mode = 0o600,
): Promise<void> {
  const parts = path.split("/");
  const name = parts.pop()!;
  await using directory = await openRelativeRealDirectory(
    root,
    parts.length === 0 ? "." : parts.join("/"),
    LABEL,
    true,
    signal,
  );
  await using file = await open(
    directoryEntryPath(directory, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  await file.writeFile(bytes, { signal });
  if (mode !== 0o600) await file.chmod(mode);
  await file.sync();
  await directory.sync();
}

async function findSessionProject(
  projects: FileHandle,
  sessionId: string,
  signal: AbortSignal,
): Promise<string> {
  let found: string | null = null;
  for (const entry of await readDirectoryEntriesBounded(
    projects,
    LABEL,
    MAX_NATIVE_CHECKPOINT_ENTRIES,
    signal,
  )) {
    if (entry.isSymbolicLink()) throw new Error(`${LABEL} project cannot be a symbolic link.`);
    if (!entry.isDirectory()) continue;
    await using project = await openRealDirectory(directoryEntryPath(projects, entry.name), LABEL);
    const transcript = await readPathStats(directoryEntryPath(project, `${sessionId}.jsonl`));
    if (transcript === null) continue;
    if (!transcript.isFile() || transcript.nlink !== 1) {
      throw new Error(`${LABEL} transcript must be a regular file without links.`);
    }
    if (found !== null) throw new Error(`${LABEL} session exists in multiple project directories.`);
    found = entry.name;
  }
  if (found === null) throw new Error(`${LABEL} native session transcript is missing.`);
  return found;
}

async function validateSavedSession(
  saved: Awaited<ReturnType<typeof readNativeCheckpoint>>,
  sessionId: string,
  expected: ReadonlyMap<string, string>,
): Promise<{
  nativeHome: string | null;
  nativeCwd: string | null;
  fileModes: Map<string, number>;
  hasToolResults: boolean;
}> {
  const main = saved.manifest.files.filter((file) => {
    const parts = file.path.split("/");
    return parts.length === 3 && parts[0] === "projects" && parts[2] === `${sessionId}.jsonl`;
  });
  if (main.length !== 1) throw new Error(`${LABEL} must contain exactly one session transcript.`);
  const project = main[0]!.path.split("/")[1]!;
  const found = new Set<string>();
  const references: TranscriptReferences = { toolOutputs: new Map(), fileHistory: false };
  let nativeHome: string | null = null;
  let nativeCwd: string | null = null;
  const fileModes = new Map<string, number>();
  const historyFiles = saved.manifest.files.filter((file) => file.path.startsWith("file-history/"));
  let hasToolResults = false;
  for (const file of saved.manifest.files) {
    if (file.path === NATIVE_HOME_FILE) {
      const metadata: unknown = JSON.parse((await saved.readFile(file.path)).toString("utf8"));
      if (
        !isRecord(metadata) ||
        Object.keys(metadata).some((key) => !["configDir", "cwd", "fileModes"].includes(key)) ||
        typeof metadata["configDir"] !== "string" ||
        !isAbsolute(metadata["configDir"])
      ) {
        throw new Error(`${LABEL} has invalid native home metadata.`);
      }
      nativeHome = normalize(metadata["configDir"]);
      if (metadata["cwd"] !== undefined || metadata["fileModes"] !== undefined) {
        if (
          typeof metadata["cwd"] !== "string" ||
          !isAbsolute(metadata["cwd"]) ||
          !isRecord(metadata["fileModes"])
        ) {
          throw new Error(`${LABEL} has invalid file history metadata.`);
        }
        nativeCwd = normalize(metadata["cwd"]);
        for (const [path, mode] of Object.entries(metadata["fileModes"])) {
          if (
            !path.startsWith("file-history/") ||
            !isSessionFile(path, project, sessionId) ||
            typeof mode !== "number" ||
            !Number.isInteger(mode) ||
            mode < 0 ||
            mode > 0o777
          ) {
            throw new Error(`${LABEL} has invalid file history permissions.`);
          }
          fileModes.set(path, mode);
        }
      }
      continue;
    }
    if (!isSessionFile(file.path, project, sessionId)) {
      throw new Error(`${LABEL} contains an unsupported recovery file: ${file.path}.`);
    }
    hasToolResults ||= file.path.includes("/tool-results/");
    const bytes = await saved.readFile(file.path);
    if (file.path.endsWith(".jsonl")) {
      const assistants = await checkTranscript(
        bytes,
        sessionId,
        expected,
        found,
        references,
        file.path === main[0]!.path
          ? undefined
          : file.path.split("/").at(-1)!.slice("agent-".length, -".jsonl".length),
      );
      if (file.path === main[0]!.path && assistants === 0) {
        throw new Error(`${LABEL} session transcript has no assistant messages.`);
      }
    } else if (file.path.endsWith(".meta.json") && !isRecord(JSON.parse(bytes.toString("utf8")))) {
      throw new Error(`${LABEL} has invalid subagent metadata.`);
    }
  }
  const hasFileHistory = references.fileHistory || historyFiles.length > 0;
  if (
    (hasToolResults || hasFileHistory) !== (nativeHome !== null) ||
    hasFileHistory !== (nativeCwd !== null) ||
    fileModes.size !== historyFiles.length ||
    historyFiles.some((file) => !fileModes.has(file.path))
  ) {
    throw new Error(`${LABEL} requires complete native path and file history metadata.`);
  }
  assertMessagesPersisted(expected, found);
  assertToolOutputsPersisted(
    references.toolOutputs,
    nativeHome,
    project,
    sessionId,
    new Map(saved.manifest.files.map((file) => [file.path, file.size])),
  );
  return { nativeHome, nativeCwd, fileModes, hasToolResults };
}

export async function createClaudeNativeCheckpoint(input: {
  payload: DriverStartInput;
  runId: RunId;
  sessionId: string;
  expectedTranscriptCursors: readonly ClaudeTranscriptCursor[];
  signal: AbortSignal;
}): Promise<NativeCheckpoint> {
  const sessionId = sessionPathId(input.sessionId);
  const expected = expectedMessages(sessionId, input.expectedTranscriptCursors);
  const checkpoint = await createNativeCheckpoint({
    cwd: input.payload.execution.session.cwd,
    runId: input.runId,
    nativeRef: { runtimeId: "claude-agent-sdk", kind: "claude_session_id", value: sessionId },
    signal: input.signal,
    write: async (directory) => {
      await using home = await openAbsoluteRealDirectory(
        resolveClaudeConfigDir(input.payload),
        LABEL,
      );
      await using projects = await openRealDirectory(directoryEntryPath(home, "projects"), LABEL);
      const projectName = await findSessionProject(projects, sessionId, input.signal);
      await using project = await openRealDirectory(
        directoryEntryPath(projects, projectName),
        LABEL,
      );
      await using destination = await openRealDirectory(`${directory}/.`, LABEL);
      const found = new Set<string>();
      const references: TranscriptReferences = { toolOutputs: new Map(), fileHistory: false };
      const copiedFiles = new Map<string, number>();
      const fileModes = new Map<string, number>();
      let count = 0;
      let hasToolResults = false;
      const copy = async (source: FileHandle, name: string, relativePath: string) => {
        count += 1;
        if (
          count > MAX_NATIVE_CHECKPOINT_ENTRIES ||
          !isSessionFile(relativePath, projectName, sessionId)
        ) {
          throw new Error(`${LABEL} contains too many or unsupported recovery files.`);
        }
        hasToolResults ||= relativePath.includes("/tool-results/");
        const { bytes, mode } = await readNativeCheckpointSourceFile(source, name, input.signal);
        if (relativePath.startsWith("file-history/")) fileModes.set(relativePath, mode);
        if (name.endsWith(".jsonl")) {
          const assistants = await checkTranscript(
            bytes,
            sessionId,
            expected,
            found,
            references,
            name === `${sessionId}.jsonl`
              ? undefined
              : name.slice("agent-".length, -".jsonl".length),
          );
          if (name === `${sessionId}.jsonl` && assistants === 0) {
            throw new Error(`${LABEL} session transcript has no assistant messages.`);
          }
        }
        if (name.endsWith(".meta.json") && !isRecord(JSON.parse(bytes.toString("utf8")))) {
          throw new Error(`${LABEL} has invalid subagent metadata.`);
        }
        await writeSnapshotFile(destination, relativePath, bytes, input.signal);
        copiedFiles.set(relativePath, bytes.length);
      };
      await copy(project, `${sessionId}.jsonl`, `projects/${projectName}/${sessionId}.jsonl`);
      await using session = await openOptionalRealDirectory(
        directoryEntryPath(project, sessionId),
        LABEL,
      );
      if (session !== null) {
        for (const entry of await readDirectoryEntriesBounded(
          session,
          LABEL,
          MAX_NATIVE_CHECKPOINT_ENTRIES,
          input.signal,
        )) {
          if (["precompact.json", "custom-title.json"].includes(entry.name) && entry.isFile()) {
            // Pending summaries and display titles are not recovery history.
            await readNativeCheckpointSourceFile(session, entry.name, input.signal);
            continue;
          }
          if (!entry.isDirectory() || !["subagents", "tool-results"].includes(entry.name)) {
            throw new Error(`${LABEL} contains an unsupported session directory.`);
          }
          await using child = await openRealDirectory(
            directoryEntryPath(session, entry.name),
            LABEL,
          );
          for (const file of await readDirectoryEntriesBounded(
            child,
            LABEL,
            MAX_NATIVE_CHECKPOINT_ENTRIES,
            input.signal,
          )) {
            await copy(
              child,
              file.name,
              `projects/${projectName}/${sessionId}/${entry.name}/${file.name}`,
            );
          }
        }
      }
      await using historyRoot = await openOptionalRealDirectory(
        directoryEntryPath(home, "file-history"),
        LABEL,
      );
      if (historyRoot !== null) {
        await using history = await openOptionalRealDirectory(
          directoryEntryPath(historyRoot, sessionId),
          LABEL,
        );
        if (history !== null) {
          for (const file of await readDirectoryEntriesBounded(
            history,
            LABEL,
            MAX_NATIVE_CHECKPOINT_ENTRIES,
            input.signal,
          )) {
            await copy(history, file.name, `file-history/${sessionId}/${file.name}`);
          }
        }
      }
      const hasFileHistory = references.fileHistory || fileModes.size > 0;
      if (hasToolResults || hasFileHistory) {
        await writeSnapshotFile(
          destination,
          NATIVE_HOME_FILE,
          Buffer.from(
            JSON.stringify({
              configDir: normalize(resolveClaudeConfigDir(input.payload)),
              ...(hasFileHistory
                ? {
                    cwd: normalize(input.payload.execution.session.cwd),
                    fileModes: Object.fromEntries(fileModes),
                  }
                : {}),
            }),
          ),
          input.signal,
        );
      }
      assertMessagesPersisted(expected, found);
      assertToolOutputsPersisted(
        references.toolOutputs,
        normalize(resolveClaudeConfigDir(input.payload)),
        projectName,
        sessionId,
        copiedFiles,
      );
    },
  });
  // A retry must validate the first sealed copy, including after a concurrent creator won.
  const saved = await readNativeCheckpoint({
    cwd: input.payload.execution.session.cwd,
    checkpoint,
    signal: input.signal,
  });
  await validateSavedSession(saved, sessionId, expected);
  return checkpoint;
}

export async function restoreClaudeNativeCheckpoint(
  payload: DriverStartInput,
  signal: AbortSignal,
): Promise<void> {
  const {
    nativeCheckpoint: checkpoint,
    nativeResumeRef: reference,
    cwd,
  } = payload.execution.session;
  if (checkpoint === null) {
    if (reference !== null) throw new Error(`${LABEL} is required for native session recovery.`);
    return;
  }
  if (
    reference === null ||
    checkpoint.nativeRef.runtimeId !== "claude-agent-sdk" ||
    checkpoint.nativeRef.kind !== "claude_session_id" ||
    !nativeRuntimeRefsEqual(checkpoint.nativeRef, reference)
  ) {
    throw new Error(`${LABEL} does not match the requested native session.`);
  }
  const sessionId = sessionPathId(reference.value);
  const saved = await readNativeCheckpoint({ cwd, checkpoint, signal });
  const restored = await validateSavedSession(saved, sessionId, new Map());
  const configDir = resolveClaudeConfigDir(payload);
  if (restored.hasToolResults && restored.nativeHome !== normalize(configDir)) {
    throw new Error(`${LABEL} tool results require restoring to the original native home path.`);
  }
  if (restored.nativeCwd !== null && restored.nativeCwd !== normalize(cwd)) {
    throw new Error(`${LABEL} file history requires restoring to the original workspace cwd.`);
  }
  await using home = await ensureAbsoluteRealDirectory(configDir, LABEL, signal);
  const temporaryPath = directoryEntryPath(home, `.projects.restore-${randomUUID()}`);
  await mkdir(temporaryPath, { mode: 0o700 });
  await using staging = await openRealDirectory(temporaryPath, LABEL);
  const trees: {
    path: string;
    stagedPath: string;
    backupPath: string;
    staged: FileHandle;
    previous: FileHandle | null;
    published: boolean;
    previousMoved: boolean;
  }[] = [];
  try {
    for (const file of saved.manifest.files) {
      if (file.path === NATIVE_HOME_FILE) continue;
      await writeSnapshotFile(
        staging,
        file.path,
        await saved.readFile(file.path),
        signal,
        restored.fileModes.get(file.path),
      );
    }
    for (const name of ["projects", "file-history"]) {
      const staged = await openRelativeRealDirectory(staging, name, LABEL, true, signal);
      const tree = {
        path: directoryEntryPath(home, name),
        stagedPath: directoryEntryPath(staging, name),
        backupPath: directoryEntryPath(home, `.${name}.previous-${randomUUID()}`),
        staged,
        previous: null as FileHandle | null,
        published: false,
        previousMoved: false,
      };
      trees.push(tree);
      tree.previous = await openOptionalRealDirectory(tree.path, LABEL);
      await staged.sync();
    }
    await staging.sync();
    try {
      for (const tree of trees) {
        signal.throwIfAborted();
        await assertDirectoryIdentity(home, configDir, LABEL);
        await assertDirectoryIdentity(staging, temporaryPath, LABEL);
        if (tree.previous !== null) {
          await assertDirectoryIdentity(tree.previous, tree.path, LABEL);
          await rename(tree.path, tree.backupPath);
          tree.previousMoved = true;
        }
        await assertDirectoryIdentity(staging, temporaryPath, LABEL);
        await assertDirectoryIdentity(tree.staged, tree.stagedPath, LABEL);
        await rename(tree.stagedPath, tree.path);
        tree.published = true;
      }
      await home.sync();
    } catch (error) {
      const failures: unknown[] = [error];
      for (const tree of [...trees].reverse()) {
        try {
          if (tree.published) {
            await assertDirectoryIdentity(tree.staged, tree.path, LABEL);
            await rename(tree.path, tree.stagedPath);
            tree.published = false;
          }
          if (tree.previousMoved) {
            await assertDirectoryIdentity(tree.previous!, tree.backupPath, LABEL);
            await rename(tree.backupPath, tree.path);
            tree.previousMoved = false;
          }
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      await home.sync();
      if (failures.length > 1) throw new AggregateError(failures, `${LABEL} rollback failed.`);
      throw error;
    }
    for (const tree of trees) {
      if (tree.previous !== null) {
        await removeNativeCheckpointDirectory(tree.previous, tree.backupPath);
      }
    }
    await home.sync();
  } finally {
    try {
      await removeNativeCheckpointDirectory(staging, temporaryPath);
      await home.sync();
    } finally {
      for (const tree of trees) {
        await tree.staged.close();
        await tree.previous?.close();
      }
    }
  }
}
