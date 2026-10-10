import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { AgentDriverMaterializedSkill } from "../../host-ports";
import { isJsonObject } from "../../protocol/json";
import {
  MAX_NATIVE_CHECKPOINT_FILE_BYTES,
  nativeRuntimeRefsEqual,
} from "../../protocol/native-checkpoint";
import type { DriverStartInput } from "../../protocol/start";
import {
  assertDirectoryIdentity,
  cleanupAtomicWriteTemporaryFiles,
  directoryEntryPath,
  ensureAbsoluteRealDirectory,
  ensureRealDirectoryAt,
  openAbsoluteRealDirectory,
  openRelativeRealDirectory,
  readPathStats,
  writeFileAtomically,
} from "../atomic-file";
import { buildRuntimeChildProcessEnv } from "../child-process-env";
import { readNativeCheckpoint } from "../native-checkpoint";
import { writeNativeRuntimeSystemPrompt } from "../skill-bootstrap";
import { readPiSessionHeader } from "./pi-session-validation";

export const PI_CONFIG_ENV = "MOSOO_PI_CONFIG_CONTENT";
export const PI_PROXY_GRANT_ENV = "MOSOO_PI_PROXY_GRANT";

// The extension asks through RPC before any tool execution. The Driver owns
// the decision, including cancellation of an outstanding permission request.
const PERMISSION_EXTENSION = `export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    const allowed = await ctx.ui.confirm("mosoo.tool_permission", JSON.stringify({
      toolCallId: event.toolCallId, toolName: event.toolName, input: event.input
    }));
    if (!allowed) return { block: true, reason: "Tool execution rejected by mosoo." };
  });
}`;

export interface PiLaunchConfiguration {
  readonly args: string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly home: string;
}

export function resolvePiSessionPath(home: string, pointer: string): string {
  const root = resolve(home, "sessions");
  const path = resolve(home, pointer);
  const within = relative(root, path);
  if (
    isAbsolute(pointer) ||
    within === "" ||
    within === ".." ||
    within.startsWith("../") ||
    isAbsolute(within)
  ) {
    throw new Error("Pi native resume pointer is outside the Session runtime home.");
  }
  return path;
}

async function readSessionAt(
  directory: FileHandle,
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  await using file = await open(
    directoryEntryPath(directory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const before = await file.stat({ bigint: true });
  if (!before.isFile() || before.nlink !== 1n) {
    throw new Error("Pi native session must be a regular file without hardlinks.");
  }
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size > MAX_NATIVE_CHECKPOINT_FILE_BYTES) {
    throw new Error("Pi native session exceeds the checkpoint size limit.");
  }
  const bytes = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const after = await file.stat({ bigint: true });
  if (
    offset !== size ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    after.nlink !== 1n
  ) {
    throw new Error("Pi native session changed while being read.");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
}

export async function readPiSessionFile(
  home: string,
  pointer: string,
  signal?: AbortSignal,
): Promise<string> {
  const path = resolvePiSessionPath(home, pointer);
  await using parent = await openAbsoluteRealDirectory(dirname(path), "Pi session directory");
  return await readSessionAt(parent, basename(path), signal);
}

export async function preparePiLaunch(
  payload: DriverStartInput,
  materializedSkills: readonly AgentDriverMaterializedSkill[] = [],
  signal: AbortSignal = AbortSignal.any([]),
): Promise<PiLaunchConfiguration> {
  signal.throwIfAborted();
  const execution = payload.execution;
  const home = resolve(execution.session.homePath, "pi");
  const sessions = join(home, "sessions");
  const variables = execution.environment.variables;
  const content = variables[PI_CONFIG_ENV];
  const config: unknown = content === undefined ? null : JSON.parse(content);
  if (!isJsonObject(config) || !variables[PI_PROXY_GRANT_ENV]) {
    throw new Error("Pi requires a control-plane model configuration and proxy grant.");
  }
  await using homeDirectory = await ensureAbsoluteRealDirectory(home, "Pi runtime home", signal);
  await using sessionsDirectory = await ensureRealDirectoryAt(
    homeDirectory,
    "sessions",
    "Pi sessions",
    signal,
  );
  await cleanupAtomicWriteTemporaryFiles(
    homeDirectory,
    ["models.json", "settings.json", "mosoo-permissions.mjs", "mcp.json"],
    signal,
  );
  await writeFileAtomically(homeDirectory, "models.json", JSON.stringify(config), 0o600, signal);
  await writeFileAtomically(
    homeDirectory,
    "settings.json",
    JSON.stringify({
      extensions: [],
      skills: [],
      promptTemplates: [],
      packages: [],
      quietStartup: true,
      retry: { enabled: false },
    }),
    0o600,
    signal,
  );
  const permissionPath = join(home, "mosoo-permissions.mjs");
  await writeFileAtomically(
    homeDirectory,
    "mosoo-permissions.mjs",
    PERMISSION_EXTENSION,
    0o600,
    signal,
  );

  const mcpServers: Record<string, object> = {};
  const mcpEnv: Record<string, string> = {};
  for (const server of execution.session.mcpServers) {
    if (server.authorizationState !== "active") {
      continue;
    }
    const grantEnv = `MOSOO_PI_MCP_GRANT_${Object.keys(mcpEnv).length}`;
    mcpEnv[grantEnv] = server.proxyGrantId;
    mcpServers[server.serverId] = {
      url: server.proxyUrl,
      headers: { Authorization: `Bearer \${${grantEnv}}` },
      exposure: "direct",
    };
  }
  await writeFileAtomically(
    homeDirectory,
    "mcp.json",
    JSON.stringify({ mcpServers }),
    0o600,
    signal,
  );
  const prefix: unknown = JSON.parse(process.env["MOSOO_PI_ARGS"] ?? "[]");
  if (!Array.isArray(prefix) || !prefix.every((arg) => typeof arg === "string")) {
    throw new Error("MOSOO_PI_ARGS must be a JSON string array.");
  }
  const modelPrefix = `${execution.provider}/`;
  const model = execution.model.startsWith(modelPrefix)
    ? execution.model.slice(modelPrefix.length)
    : execution.model;
  const args = [
    ...prefix,
    "--mode",
    "rpc",
    "--provider",
    "mosoo",
    "--model",
    model,
    "--session-dir",
    sessions,
    "--no-approve",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--extension",
    permissionPath,
  ];
  if (Object.keys(mcpServers).length > 0) args.push("--extension", "builtin:mcp");
  const resume = execution.session.nativeResumeRef;
  const checkpoint = execution.session.nativeCheckpoint;
  if ((resume === null) !== (checkpoint === null)) {
    throw new Error("Pi native resume requires its matching durable checkpoint.");
  }
  if (resume !== null) {
    if (resume.runtimeId !== "pi" || resume.kind !== "pi_session_path") {
      throw new Error("Pi cannot resume another runtime's conversation.");
    }
    if (checkpoint === null || !nativeRuntimeRefsEqual(resume, checkpoint.nativeRef)) {
      throw new Error("Pi native resume does not match its durable checkpoint.");
    }
    const path = resolvePiSessionPath(home, resume.value);
    const restored = await readNativeCheckpoint({ cwd: execution.session.cwd, checkpoint, signal });
    if (
      restored.manifest.files.length !== 1 ||
      restored.manifest.files[0]?.path !== "session.jsonl"
    ) {
      throw new Error("Pi durable checkpoint must contain its native session.jsonl file.");
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      await restored.readFile("session.jsonl"),
    );
    // Pi skips malformed JSONL records; reject snapshots that would lose context.
    const header = readPiSessionHeader(content);
    if ((await realpath(header.cwd)) !== (await realpath(execution.session.cwd))) {
      throw new Error("Pi restored session header does not match its workspace.");
    }
    await using parent = await openRelativeRealDirectory(
      sessionsDirectory,
      dirname(relative(sessions, path)),
      "Pi restored session directory",
      true,
      signal,
    );
    const existing = await readPathStats(directoryEntryPath(parent, basename(path)));
    if (existing !== null && !existing.isFile()) {
      throw new Error("Pi restored session destination must be a regular file.");
    }
    await writeFileAtomically(parent, basename(path), content, 0o600, signal);
    await assertDirectoryIdentity(parent, dirname(path), "Pi restored session directory");
    args.push("--session", path);
  }
  const instructions = await writeNativeRuntimeSystemPrompt(execution, materializedSkills, signal);
  if (instructions !== null) args.push("--append-system-prompt", instructions);
  const inherited: Record<string, string> = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "TEMP",
    "TMP",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ]) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  signal.throwIfAborted();
  await assertDirectoryIdentity(homeDirectory, home, "Pi runtime home");
  await assertDirectoryIdentity(sessionsDirectory, sessions, "Pi sessions");
  return {
    args,
    command: process.env["MOSOO_PI_EXECUTABLE"] ?? "pi",
    cwd: execution.session.cwd,
    home,
    env: buildRuntimeChildProcessEnv(execution.environment.paths, {
      ...inherited,
      ...variables,
      ...mcpEnv,
      HOME: execution.session.homePath,
      PI_CODING_AGENT_DIR: home,
      PI_OFFLINE: "1",
    }),
  };
}
