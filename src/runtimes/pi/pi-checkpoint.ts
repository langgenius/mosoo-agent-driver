import { unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { RunId } from "../../protocol/id";
import { isJsonObject } from "../../protocol/json";
import { MAX_NATIVE_CHECKPOINT_ENTRIES } from "../../protocol/native-checkpoint";
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
    path !== join(resolve(home), "tmp", basename(path))
  ) {
    throw new Error(`${LABEL} reference is outside the Session's native output directory.`);
  }
  return basename(path);
}

function binaryResourceReferences(text: string): string[] {
  return Array.from(
    text.matchAll(/^\[Binary resource .* saved to (.+)\]$/gmu),
    (match) => match[1]!,
  );
}

function shellOutputReferences(text: string): string[] {
  return Array.from(
    text.matchAll(
      /^\[Showing (?:lines \d+-\d+ of \d+(?: \(\d+(?:\.\d+)?(?:B|KB|MB) limit\))?|last \d+(?:\.\d+)?(?:B|KB|MB) of line \d+ \(line is \d+(?:\.\d+)?(?:B|KB|MB)\))\. Full output: (.+)\]$/gmu,
    ),
    (match) => match[1]!,
  );
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
    if (!Array.isArray(message["content"])) continue;
    for (const block of message["content"]) {
      if (!isJsonObject(block) || block["type"] !== "text" || typeof block["text"] !== "string")
        continue;
      for (const path of binaryResourceReferences(block["text"])) {
        references.add(outputName(home, path));
      }
      // Shell timeout/abort errors keep the footer but lose details.fullOutputPath.
      if (message["toolName"] === "bash" || message["toolName"] === "powershell") {
        for (const path of shellOutputReferences(block["text"])) {
          references.add(outputName(home, path));
        }
      }
    }
  }
  return references;
}

async function validateReferences(
  content: string,
  home: string,
  outputs: ReadonlySet<string>,
  readFile: (name: string) => Promise<Buffer>,
): Promise<void> {
  const references = outputReferences(content, home);
  for (const name of references) {
    if (!outputs.has(name)) throw new Error(`${LABEL} is missing a referenced output.`);
    // MCP's truncated text can itself contain references to saved binary resources.
    if (name.startsWith("pi-mcp-") && name.endsWith(".txt")) {
      for (const path of binaryResourceReferences((await readFile(name)).toString("utf8"))) {
        references.add(outputName(home, path));
      }
    }
  }
}

async function validateOutputs(saved: SavedCheckpoint, content: string, home: string) {
  const outputs = new Set<string>();
  for (const file of saved.manifest.files) {
    if (file.path === "session.jsonl" || file.path === NATIVE_HOME_FILE) continue;
    const name = file.path.slice("tmp/".length);
    if (!file.path.startsWith("tmp/") || !OUTPUT_NAME.test(name)) {
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
  await validateReferences(content, home, outputs, (name) => saved.readFile(`tmp/${name}`));
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
        join(input.home, "tmp"),
        LABEL,
        input.signal,
      );
      const entries = await readDirectoryEntriesBounded(
        source,
        LABEL,
        MAX_NATIVE_CHECKPOINT_ENTRIES,
        input.signal,
      );
      const outputs = entries.filter((entry) => OUTPUT_NAME.test(entry.name));
      if (outputs.length + 4 > MAX_NATIVE_CHECKPOINT_ENTRIES) {
        throw new Error(`${LABEL} contains too many entries.`);
      }
      if (outputs.length > 0) {
        await using temporary = await ensureRealDirectoryAt(
          destination,
          "tmp",
          LABEL,
          input.signal,
        );
        for (const entry of outputs) {
          const { bytes } = await readNativeCheckpointSourceFile(source, entry.name, input.signal);
          await writeFileAtomically(temporary, entry.name, bytes, 0o600, input.signal);
        }
        await validateReferences(
          input.content,
          input.home,
          new Set(outputs.map((entry) => entry.name)),
          async (name) =>
            (await readNativeCheckpointSourceFile(temporary, name, input.signal)).bytes,
        );
        await writeFileAtomically(
          destination,
          NATIVE_HOME_FILE,
          JSON.stringify({ home: resolve(input.home) }),
          0o600,
          input.signal,
        );
      } else if (outputReferences(input.content, input.home).size > 0) {
        throw new Error(`${LABEL} is missing a referenced output.`);
      }
      await assertDirectoryIdentity(source, join(input.home, "tmp"), LABEL);
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
  await using temporary = await ensureRealDirectoryAt(home, "tmp", LABEL, input.signal);
  for (const name of outputs) {
    await assertRegularDestination(temporary, name);
    await writeFileAtomically(
      temporary,
      name,
      await input.saved.readFile(`tmp/${name}`),
      0o600,
      input.signal,
    );
  }
  await assertDirectoryIdentity(temporary, join(input.home, "tmp"), LABEL);
  for (const entry of await readDirectoryEntriesBounded(
    temporary,
    LABEL,
    MAX_NATIVE_CHECKPOINT_ENTRIES,
    input.signal,
  )) {
    if (!OUTPUT_NAME.test(entry.name) || outputs.has(entry.name)) continue;
    input.signal.throwIfAborted();
    await assertRegularDestination(temporary, entry.name);
    await unlink(directoryEntryPath(temporary, entry.name));
  }
  await temporary.sync();
  await assertDirectoryIdentity(temporary, join(input.home, "tmp"), LABEL);
  await assertDirectoryIdentity(home, input.home, LABEL);
}

async function assertRegularDestination(directory: FileHandle, name: string): Promise<void> {
  const stats = await readPathStats(directoryEntryPath(directory, name));
  if (stats !== null && (!stats.isFile() || stats.nlink !== 1)) {
    throw new Error(`${LABEL} destination must be a regular file without links.`);
  }
}
