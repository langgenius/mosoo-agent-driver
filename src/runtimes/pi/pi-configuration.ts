import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { isJsonObject } from "../../protocol/json";
import type { DriverStartInput } from "../../protocol/start";
import { buildRuntimeChildProcessEnv } from "../child-process-env";
import { writeNativeRuntimeSystemPrompt } from "../skill-bootstrap";

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
  if (isAbsolute(pointer) || within === "" || within.startsWith("..") || isAbsolute(within)) {
    throw new Error("Pi native resume pointer is outside the Session runtime home.");
  }
  return path;
}

export async function preparePiLaunch(payload: DriverStartInput): Promise<PiLaunchConfiguration> {
  const execution = payload.execution;
  const home = join(execution.session.homePath, "pi");
  const sessions = join(home, "sessions");
  await mkdir(sessions, { recursive: true });
  const variables = execution.environment.variables;
  const content = variables[PI_CONFIG_ENV];
  const config: unknown = content === undefined ? null : JSON.parse(content);
  if (!isJsonObject(config) || !variables[PI_PROXY_GRANT_ENV]) {
    throw new Error("Pi requires a control-plane model configuration and proxy grant.");
  }
  await writeFile(join(home, "models.json"), JSON.stringify(config), { mode: 0o600 });
  await writeFile(
    join(home, "settings.json"),
    JSON.stringify({
      extensions: [],
      skills: [],
      promptTemplates: [],
      packages: [],
      quietStartup: true,
      retry: { enabled: false },
    }),
    { mode: 0o600 },
  );
  const permissionPath = join(home, "mosoo-permissions.mjs");
  await writeFile(permissionPath, PERMISSION_EXTENSION, { mode: 0o600 });

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
  await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers }), { mode: 0o600 });
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
  if (resume !== null) {
    if (resume.runtimeId !== "pi" || resume.kind !== "pi_session_path") {
      throw new Error("Pi cannot resume another runtime's conversation.");
    }
    const path = resolvePiSessionPath(home, resume.value);
    // Pi otherwise creates a new session for a missing path. Restore must fail
    // explicitly instead of admitting an empty conversation.
    const header = JSON.parse((await readFile(path, "utf8")).split("\n")[0]!);
    if (
      !isJsonObject(header) ||
      header["type"] !== "session" ||
      header["cwd"] !== execution.session.cwd
    ) {
      throw new Error("Pi restored session header does not match its workspace.");
    }
    args.push("--session", path);
  }
  const instructions = await writeNativeRuntimeSystemPrompt(execution);
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
