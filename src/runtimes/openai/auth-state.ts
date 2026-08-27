import { join } from "node:path";

import type { JsonObject, JsonValue } from "../../protocol/json";
import { isJsonObject } from "../../protocol/json";
import { writeFileAtomicallyAtPath } from "../atomic-file";
import { mergeProviderOptions } from "../provider-options";
interface OpenAiApiKeyAuthStateInput {
  env: NodeJS.ProcessEnv;
  runtimeHome: string;
}

interface OpenAiApiKeyAuthStateResult {
  authJsonPath: string;
  hasApiKey: boolean;
  written: boolean;
}

interface OpenAiModelProviderConfigInput {
  env: NodeJS.ProcessEnv;
  mcpServers?: Record<string, JsonValue>;
  provider: string;
  providerOptions?: JsonObject;
  runtimeHome: string;
}

interface OpenAiModelProviderConfigResult {
  configTomlPath: string;
  provider: string;
  written: boolean;
}

const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";
const OPENAI_COMPATIBLE_API_KEY_ENV_NAME = "OPENAI_COMPATIBLE_API_KEY";
const OPENAI_COMPATIBLE_BASE_URL_ENV_NAME = "OPENAI_COMPATIBLE_BASE_URL";
const OPENAI_BASE_URL_ENV_NAME = "OPENAI_BASE_URL";
const DISABLED_RUNTIME_FEATURES = ["plugins", "remote_plugin", "tool_suggest"] as const;

function readOpenAiApiKey(env: NodeJS.ProcessEnv): string | null {
  const value = env["OPENAI_API_KEY"]?.trim();
  return value ?? null;
}

function readEnvVar(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value || null;
}

function toTomlString(value: string): string {
  return JSON.stringify(value);
}

function toTomlKeySegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : toTomlString(value);
}

function toTomlInlineValue(value: JsonValue, path: string): string {
  if (value === null) {
    throw new Error(`OpenAI provider option ${path} cannot be null in config.toml.`);
  }

  if (typeof value === "string") {
    return toTomlString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => toTomlInlineValue(entry, `${path}[${index}]`)).join(", ")}]`;
  }

  return `{ ${Object.entries(value)
    .map(
      ([key, entry]) => `${toTomlKeySegment(key)} = ${toTomlInlineValue(entry, `${path}.${key}`)}`,
    )
    .join(", ")} }`;
}

function isTomlTable(value: unknown): value is JsonObject {
  return isJsonObject(value);
}

function appendTomlObject(
  lines: string[],
  object: Record<string, JsonValue>,
  path: string[] = [],
): void {
  if (path.length > 0) {
    if (lines.length > 0 && lines.at(-1) !== "") {
      lines.push("");
    }

    lines.push(`[${path.map(toTomlKeySegment).join(".")}]`);
  }

  const nestedEntries: [string, JsonObject][] = [];

  for (const [key, value] of Object.entries(object)) {
    if (isTomlTable(value)) {
      nestedEntries.push([key, value]);
    } else {
      lines.push(
        `${toTomlKeySegment(key)} = ${toTomlInlineValue(value, [...path, key].join("."))}`,
      );
    }
  }

  for (const [key, value] of nestedEntries) {
    appendTomlObject(lines, value, [...path, key]);
  }
}

function stringifyToml(object: Record<string, JsonValue>): string {
  const lines: string[] = [];
  appendTomlObject(lines, object);
  return `${lines.join("\n")}\n`;
}

export async function materializeOpenAiApiKeyAuthState(
  input: OpenAiApiKeyAuthStateInput,
): Promise<OpenAiApiKeyAuthStateResult> {
  const authJsonPath = join(input.runtimeHome, "auth.json");
  const apiKey = readOpenAiApiKey(input.env);

  if (!apiKey) {
    return {
      authJsonPath,
      hasApiKey: false,
      written: false,
    };
  }

  await writeFileAtomicallyAtPath(
    authJsonPath,
    `${JSON.stringify(
      {
        OPENAI_API_KEY: apiKey,
        auth_mode: "apikey",
        last_refresh: null,
        tokens: null,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  return {
    authJsonPath,
    hasApiKey: true,
    written: true,
  };
}

export async function materializeOpenAiModelProviderConfig(
  input: OpenAiModelProviderConfigInput,
): Promise<OpenAiModelProviderConfigResult> {
  const configTomlPath = join(input.runtimeHome, "config.toml");
  const generatedConfig: Record<string, JsonValue> = {
    features: Object.fromEntries(DISABLED_RUNTIME_FEATURES.map((feature) => [feature, false])),
  };

  if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    const apiKey = readEnvVar(input.env, OPENAI_COMPATIBLE_API_KEY_ENV_NAME);
    const baseUrl = readEnvVar(input.env, OPENAI_COMPATIBLE_BASE_URL_ENV_NAME);

    if (apiKey === null || baseUrl === null) {
      throw new Error(
        "OpenAI-compatible provider requires OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_BASE_URL.",
      );
    }

    generatedConfig["model_provider"] = input.provider;
    generatedConfig["model_providers"] = {
      [input.provider]: {
        base_url: baseUrl,
        env_key: OPENAI_COMPATIBLE_API_KEY_ENV_NAME,
        name: "mosoo OpenAI-Compatible",
        wire_api: "responses",
      },
    };
  } else if (input.provider === "openai") {
    const baseUrl = readEnvVar(input.env, OPENAI_BASE_URL_ENV_NAME);

    if (baseUrl !== null) {
      generatedConfig["openai_base_url"] = baseUrl;
    }
  }

  if (input.mcpServers !== undefined && Object.keys(input.mcpServers).length > 0) {
    generatedConfig["mcp_servers"] = input.mcpServers;
  }

  const config = mergeProviderOptions(generatedConfig, input.providerOptions ?? {});

  const written = await writeFileAtomicallyAtPath(configTomlPath, stringifyToml(config), {
    mode: 0o666,
    skipIfUnchanged: true,
  });

  return {
    configTomlPath,
    provider: input.provider,
    written,
  };
}
