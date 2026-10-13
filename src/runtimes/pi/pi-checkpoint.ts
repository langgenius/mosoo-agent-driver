import { unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { RunId } from "../../protocol/id";
import { isJsonObject } from "../../protocol/json";
import {
  MAX_NATIVE_CHECKPOINT_ENTRIES,
  MAX_PI_NATIVE_CHECKPOINT_BYTES,
} from "../../protocol/native-checkpoint";
import type { DriverNativeRuntimeRef } from "../../protocol/runtime";
import {
  assertDirectoryIdentity,
  directoryEntryPath,
  ensureAbsoluteRealDirectory,
  ensureRealDirectoryAt,
  openRealDirectory,
  readDirectoryEntriesBounded,
  readPathStats,
  writeFileAtomically,
} from "../atomic-file";
import {
  createNativeCheckpoint,
  readNativeCheckpoint,
  readNativeCheckpointSourceFile,
} from "../native-checkpoint";
import type { NativeCheckpointRoot } from "../native-checkpoint";

const LABEL = "Pi native output checkpoint";
const NATIVE_HOME_FILE = "native-home.json";
// Pi 1.1 creates these files for shell output, MCP text, and binary resources.
const OUTPUT_NAME =
  /^(?:pi-(?:bash|powershell)-[0-9a-f]{16}\.log|pi-mcp-[0-9a-f]{16}\.[A-Za-z0-9]{1,8})$/u;

type SavedCheckpoint = Awaited<ReturnType<typeof readNativeCheckpoint>>;

function outputName(home: string, path: unknown): string {
  if (
    typeof path !== "string" ||
    !OUTPUT_NAME.test(basename(path)) ||
    path !== join(resolve(home), "outputs", basename(path))
  ) {
    throw new Error(`${LABEL} reference is outside the Session's native output directory.`);
  }
  return basename(path);
}

function outputReferences(content: string, home: string): Set<string> {
  const references = new Set<string>();
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const entry: unknown = JSON.parse(line);
    if (!isJsonObject(entry) || entry["type"] !== "message" || !isJsonObject(entry["message"]))
      continue;
    const message = entry["message"];
    if (message["role"] === "bashExecution" && message["fullOutputPath"] !== undefined) {
      references.add(outputName(home, message["fullOutputPath"]));
    }
    if (message["role"] !== "toolResult") continue;
    const details = message["details"];
    if (isJsonObject(details) && details["fullOutputPath"] !== undefined) {
      references.add(outputName(home, details["fullOutputPath"]));
    }
  }
  return references;
}

function validateReferences(content: string, home: string, outputs: ReadonlySet<string>): void {
  // Tool text can quote arbitrary paths; only native metadata identifies references.
  for (const name of outputReferences(content, home)) {
    if (!outputs.has(name)) throw new Error(`${LABEL} is missing a referenced output.`);
  }
}

async function validateOutputs(saved: SavedCheckpoint, content: string, home: string) {
  const outputs = new Set<string>();
  for (const file of saved.manifest.files) {
    if (file.path === "session.jsonl" || file.path === NATIVE_HOME_FILE) continue;
    const name = file.path.slice("outputs/".length);
    if (!file.path.startsWith("outputs/") || !OUTPUT_NAME.test(name)) {
      throw new Error(`${LABEL} contains an unsupported file.`);
    }
    outputs.add(name);
  }
  const hasNativeHome = saved.manifest.files.some((file) => file.path === NATIVE_HOME_FILE);
  if (outputs.size > 0 || hasNativeHome) {
    const metadata: unknown = JSON.parse((await saved.readFile(NATIVE_HOME_FILE)).toString("utf8"));
    if (!isJsonObject(metadata) || metadata["home"] !== resolve(home)) {
      throw new Error(`${LABEL} requires restoring the original native home path.`);
    }
  }
  validateReferences(content, home, outputs);
  return outputs;
}

export async function createPiNativeCheckpoint(input: {
  root: NativeCheckpointRoot;
  runId: RunId;
  nativeRef: DriverNativeRuntimeRef;
  home: string;
  content: string;
  signal: AbortSignal;
}) {
  const checkpoint = await createNativeCheckpoint({
    ...input,
    write: async (path) => {
      await using destination = await openRealDirectory(`${path}/.`, LABEL);
      await using source = await ensureAbsoluteRealDirectory(
        join(input.home, "outputs"),
        LABEL,
        input.signal,
      );
      const entries = await readDirectoryEntriesBounded(
        source,
        LABEL,
        MAX_NATIVE_CHECKPOINT_ENTRIES,
        input.signal,
      );
      // Native shell errors and MCP binary files can have only textual references.
      const outputs: { name: string; size: number }[] = [];
      for (const entry of entries) {
        input.signal.throwIfAborted();
        if (!OUTPUT_NAME.test(entry.name)) continue;
        const stats = await readPathStats(directoryEntryPath(source, entry.name));
        if (stats === null) throw new Error(`${LABEL} is missing a native output.`);
        outputs.push({ name: entry.name, size: stats.size });
      }
      if (outputs.length + 4 > MAX_NATIVE_CHECKPOINT_ENTRIES) {
        throw new Error(`${LABEL} contains too many entries.`);
      }
      const nativeHome = JSON.stringify({ home: resolve(input.home) });
      const totalBytes =
        Buffer.byteLength(input.content) +
        (outputs.length === 0 ? 0 : Buffer.byteLength(nativeHome)) +
        outputs.reduce((bytes, file) => bytes + file.size, 0);
      if (totalBytes > MAX_PI_NATIVE_CHECKPOINT_BYTES) {
        throw new Error(`${LABEL} exceeds its total size limit.`);
      }
      validateReferences(input.content, input.home, new Set(outputs.map((entry) => entry.name)));
      if (outputs.length > 0) {
        await using outputDirectory = await ensureRealDirectoryAt(
          destination,
          "outputs",
          LABEL,
          input.signal,
        );
        for (const entry of outputs) {
          const { bytes } = await readNativeCheckpointSourceFile(
            source,
            entry.name,
            input.signal,
            entry.size,
          );
          await writeFileAtomically(outputDirectory, entry.name, bytes, 0o600, input.signal);
        }
        await writeFileAtomically(destination, NATIVE_HOME_FILE, nativeHome, 0o600, input.signal);
      }
      await assertDirectoryIdentity(source, join(input.home, "outputs"), LABEL);
      await writeFileAtomically(destination, "session.jsonl", input.content, 0o600, input.signal);
    },
  });
  const saved = await readNativeCheckpoint({
    cwd: input.root.path,
    checkpoint,
    signal: input.signal,
  });
  if ((await saved.readFile("session.jsonl")).toString("utf8") !== input.content) {
    throw new Error(`${LABEL} does not contain the completed native session.`);
  }
  await validateOutputs(saved, input.content, input.home);
  return checkpoint;
}

export async function restorePiNativeOutputs(input: {
  home: string;
  saved: SavedCheckpoint;
  content: string;
  signal: AbortSignal;
}): Promise<void> {
  const outputs = await validateOutputs(input.saved, input.content, input.home);
  await using home = await ensureAbsoluteRealDirectory(input.home, LABEL, input.signal);
  await using outputDirectory = await ensureRealDirectoryAt(home, "outputs", LABEL, input.signal);
  for (const name of outputs) {
    await assertRegularDestination(outputDirectory, name);
    await writeFileAtomically(
      outputDirectory,
      name,
      await input.saved.readFile(`outputs/${name}`),
      0o600,
      input.signal,
    );
  }
  await assertDirectoryIdentity(outputDirectory, join(input.home, "outputs"), LABEL);
  for (const entry of await readDirectoryEntriesBounded(
    outputDirectory,
    LABEL,
    MAX_NATIVE_CHECKPOINT_ENTRIES,
    input.signal,
  )) {
    if (!OUTPUT_NAME.test(entry.name) || outputs.has(entry.name)) continue;
    input.signal.throwIfAborted();
    await assertRegularDestination(outputDirectory, entry.name);
    await unlink(directoryEntryPath(outputDirectory, entry.name));
  }
  await outputDirectory.sync();
  await assertDirectoryIdentity(outputDirectory, join(input.home, "outputs"), LABEL);
  await assertDirectoryIdentity(home, input.home, LABEL);
}

async function assertRegularDestination(directory: FileHandle, name: string): Promise<void> {
  const stats = await readPathStats(directoryEntryPath(directory, name));
  if (stats !== null && (!stats.isFile() || stats.nlink !== 1)) {
    throw new Error(`${LABEL} destination must be a regular file without links.`);
  }
}
