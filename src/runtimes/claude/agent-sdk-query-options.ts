import { mkdir } from "node:fs/promises";

import type {
  CanUseTool,
  Options as ClaudeQueryOptions,
  McpServerConfig,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

import type { DriverBootMcpServer } from "../../protocol/boot";
import type { DriverBuiltInToolName } from "../../protocol/boot";
import type { JsonObject } from "../../protocol/json";
import type { DriverStartInput } from "../../protocol/start";
import { AGENT_DRIVER_VERSION } from "../../core/version";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { buildRuntimeChildProcessEnv } from "../child-process-env";
import { toMcpServerKey } from "../mcp/server-key";
import { mergeProviderOptions } from "../provider-options";
import { buildNativeRuntimeSystemPrompt } from "../skill-bootstrap";
import { readProcessEnvString, stringifyForDisplay } from "./agent-sdk-json";

export const CLAUDE_CODE_EXECUTABLE_ENV = "MOSOO_CLAUDE_CODE_EXECUTABLE";

const CLAUDE_BUILT_IN_TOOL_NAMES = {
  bash: "Bash",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  read: "Read",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
  write: "Write",
} as const satisfies Record<DriverBuiltInToolName, string>;

const CLAUDE_PROVIDER_OPTION_KEYS = new Set<string>([
  "agentProgressSummaries",
  "betas",
  "effort",
  "enableFileCheckpointing",
  "fallbackModel",
  "forwardSubagentText",
  "includeHookEvents",
  "maxBudgetUsd",
  "maxThinkingTokens",
  "maxTurns",
  "outputFormat",
  "taskBudget",
  "thinking",
  "title",
] satisfies readonly (keyof ClaudeQueryOptions)[]);

function createCanUseTool(context: AgentDriverContext): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    if (options.signal.aborted) {
      return {
        behavior: "deny",
        interrupt: true,
        message: "Permission request was aborted.",
        toolUseID: options.toolUseID,
      };
    }

    const decision = await context.ports.permission.request(
      {
        rawInput: stringifyForDisplay(input),
        requestId: options.requestId,
        title: options.title ?? options.displayName ?? `Approve ${toolName}`,
        toolCallId: options.toolUseID,
        toolKind: toolName,
      },
      options.signal,
    );

    if (options.signal.aborted) {
      return {
        behavior: "deny",
        interrupt: true,
        message: "Permission request was aborted.",
        toolUseID: options.toolUseID,
      };
    }

    if (decision === "allow_once") {
      return {
        behavior: "allow",
        toolUseID: options.toolUseID,
        updatedInput: input,
      };
    }

    return {
      behavior: "deny",
      message: "Rejected by mosoo permission review.",
      toolUseID: options.toolUseID,
    };
  };
}

function toClaudeMcpServers(
  servers: DriverBootMcpServer[],
): Record<string, McpServerConfig> | undefined {
  const usedNames = new Set<string>();
  const mcpServers: Record<string, McpServerConfig> = {};

  for (const server of servers) {
    if (server.authorizationState !== "active") {
      continue;
    }

    mcpServers[toMcpServerKey(server, usedNames)] = {
      headers: {
        Authorization: `Bearer ${server.proxyGrantId}`,
      },
      type: "http",
      url: server.proxyUrl,
    };
  }

  return Object.keys(mcpServers).length > 0 ? mcpServers : undefined;
}

function toClaudeEnv(payload: DriverStartInput, claudeConfigDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...payload.execution.environment.variables,
    CLAUDE_AGENT_SDK_CLIENT_APP: `mosoo-driver/${AGENT_DRIVER_VERSION}`,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
}

export function toClaudeBuiltInTools(payload: DriverStartInput): string[] {
  return payload.execution.builtInTools.flatMap((tool) =>
    tool.enabled ? [CLAUDE_BUILT_IN_TOOL_NAMES[tool.name]] : [],
  );
}

export function resolveClaudeConfigDir(payload: DriverStartInput): string {
  return payload.execution.session.homePath;
}

export function mergeClaudeQueryOptions<T extends object>(
  options: T,
  providerOptions: JsonObject,
): T {
  return mergeProviderOptions(
    options,
    Object.fromEntries(
      Object.entries(providerOptions).filter(([key]) => CLAUDE_PROVIDER_OPTION_KEYS.has(key)),
    ),
  );
}

export async function createClaudeQueryOptions(input: {
  abortController: AbortController;
  context: AgentDriverContext;
  nativeSessionId: string | null;
  payload: DriverStartInput;
}): Promise<ClaudeQueryOptions> {
  const claudeConfigDir = resolveClaudeConfigDir(input.payload);
  await mkdir(claudeConfigDir, { recursive: true });

  const appendSystemPrompt = buildNativeRuntimeSystemPrompt(input.payload.execution) ?? undefined;

  const options: ClaudeQueryOptions = {
    abortController: input.abortController,
    additionalDirectories: input.payload.execution.session.additionalDirectories,
    canUseTool: createCanUseTool(input.context),
    cwd: input.payload.execution.session.cwd,
    env: toClaudeEnv(input.payload, claudeConfigDir),
    includePartialMessages: true,
    model: input.payload.execution.model,
    permissionMode: "default",
    persistSession: true,
    stderr: (data) => {
      input.context.logger.debug("driver.claude.stderr", {
        chunk: data,
      });
    },
  };
  const builtInTools = toClaudeBuiltInTools(input.payload);
  options.tools = builtInTools;

  const claudeCodeExecutable = readProcessEnvString(CLAUDE_CODE_EXECUTABLE_ENV);
  if (claudeCodeExecutable) {
    options.pathToClaudeCodeExecutable = claudeCodeExecutable;
  }

  const mcpServers = toClaudeMcpServers(input.payload.execution.session.mcpServers);
  if (mcpServers) {
    options.mcpServers = mcpServers;
  }

  if (appendSystemPrompt) {
    options.systemPrompt = {
      append: appendSystemPrompt,
      preset: "claude_code",
      type: "preset",
    };
  }

  if (input.nativeSessionId) {
    options.resume = input.nativeSessionId;
  }

  const mergedOptions = mergeClaudeQueryOptions(options, input.payload.execution.providerOptions);
  mergedOptions.env = buildRuntimeChildProcessEnv(
    input.payload.execution.environment.paths,
    mergedOptions.env ?? {},
  );
  return mergedOptions;
}
