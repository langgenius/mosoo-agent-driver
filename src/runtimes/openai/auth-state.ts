import { chmod, lstat, mkdtemp, rename, rm, rmdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isDriverId } from "../../protocol/id";
import type { DriverInstanceId } from "../../protocol/id";
import type { JsonObject, JsonValue } from "../../protocol/json";
import {
  ensureAbsoluteRealDirectory,
  ensureRealDirectoryAt,
  hasErrorCode,
  readPathStats,
  writeFileAtomicallyAtPath,
} from "../atomic-file";
import { mergeProviderOptions } from "../provider-options";

interface OpenAiRuntimeHomeInput {
  driverGeneration: number;
  driverInstanceId: DriverInstanceId;
  persistentRuntimeHome: string;
  signal?: AbortSignal;
}

interface OpenAiRuntimeHomeState {
  cleanupPath: string;
  cleanupRoot: string | null;
  readonly dev: number;
  readonly ino: number;
  readonly persistentRuntimeHome: string;
  readonly runtimeHome: string;
}

interface OpenAiAuthStateInput {
  env: NodeJS.ProcessEnv;
  runtimeHome: string;
}

interface OpenAiAuthStateResult {
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
const OPENAI_RUNTIME_HOME_PREFIX = "/tmp/.mosoo-agent-driver-openai-";
const OPENAI_RUNTIME_HOME_CLEANUP_PREFIX = "/tmp/.mosoo-agent-driver-openai-cleanup-";
const PERSISTENT_OPENAI_RUNTIME_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "memories",
  "memories_extensions",
] as const;

function readOpenAiApiKey(env: NodeJS.ProcessEnv): string | null {
  const value = env["OPENAI_API_KEY"]?.trim();
  return value || null;
}

function readEnvVar(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value || null;
}

function assertOpenAiRuntimeIdentity(
  driverInstanceId: DriverInstanceId,
  driverGeneration: number,
): void {
  if (
    !isDriverId(driverInstanceId) ||
    !Number.isSafeInteger(driverGeneration) ||
    driverGeneration < 0
  ) {
    throw new TypeError("OpenAI runtime identity is invalid.");
  }
}

async function readRuntimeHomeIdentity(runtimeHome: string): Promise<{
  readonly dev: number;
  readonly ino: number;
} | null> {
  try {
    const stats = await lstat(runtimeHome);
    return stats.isDirectory() && !stats.isSymbolicLink()
      ? { dev: stats.dev, ino: stats.ino }
      : null;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

export async function createOpenAiRuntimeHome(
  input: OpenAiRuntimeHomeInput,
): Promise<OpenAiRuntimeHomeState> {
  input.signal?.throwIfAborted();
  assertOpenAiRuntimeIdentity(input.driverInstanceId, input.driverGeneration);
  const persistentRuntimeHome = resolve(input.persistentRuntimeHome);
  await using persistentHome = await ensureAbsoluteRealDirectory(
    persistentRuntimeHome,
    "Persistent OpenAI runtime home",
    input.signal,
  );
  const persistentAuthPath = join(persistentRuntimeHome, "auth.json");

  if ((await readPathStats(persistentAuthPath)) !== null) {
    throw new Error(
      `Persistent OpenAI runtime home must not contain credentials: ${persistentAuthPath}.`,
    );
  }

  for (const name of PERSISTENT_OPENAI_RUNTIME_DIRECTORIES) {
    await using _directory = await ensureRealDirectoryAt(
      persistentHome,
      name,
      `Persistent OpenAI ${name} directory`,
      input.signal,
    );
  }

  input.signal?.throwIfAborted();
  const runtimeHome = await mkdtemp(
    `${OPENAI_RUNTIME_HOME_PREFIX}${input.driverInstanceId}-g${String(input.driverGeneration)}-`,
  );

  try {
    input.signal?.throwIfAborted();
    await chmod(runtimeHome, 0o700);
    await Promise.all(
      PERSISTENT_OPENAI_RUNTIME_DIRECTORIES.map((name) =>
        symlink(join(persistentRuntimeHome, name), join(runtimeHome, name)),
      ),
    );
    input.signal?.throwIfAborted();
    const identity = await readRuntimeHomeIdentity(runtimeHome);

    if (identity === null) {
      throw new Error(`OpenAI runtime home is not a real directory: ${runtimeHome}.`);
    }

    return {
      cleanupPath: runtimeHome,
      cleanupRoot: null,
      ...identity,
      persistentRuntimeHome,
      runtimeHome,
    };
  } catch (error) {
    try {
      await rm(runtimeHome, { force: true, recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "OpenAI runtime home creation and cleanup failed.",
      );
    }
    throw error;
  }
}

export async function cleanupOpenAiRuntimeHome(state: OpenAiRuntimeHomeState): Promise<boolean> {
  let cleanupRoot = state.cleanupRoot;

  if (cleanupRoot === null) {
    cleanupRoot = await mkdtemp(OPENAI_RUNTIME_HOME_CLEANUP_PREFIX);
    const cleanupPath = join(cleanupRoot, "runtime-home");

    try {
      await rename(state.cleanupPath, cleanupPath);
    } catch (error) {
      let cleanupError: unknown = null;
      try {
        await rmdir(cleanupRoot);
      } catch (failure) {
        cleanupError = failure;
      }

      if (hasErrorCode(error, "ENOENT") && cleanupError === null) {
        return false;
      }
      throw cleanupError === null
        ? error
        : new AggregateError([error, cleanupError], "OpenAI cleanup quarantine failed.");
    }

    state.cleanupPath = cleanupPath;
    state.cleanupRoot = cleanupRoot;
  }

  const identity = await readRuntimeHomeIdentity(state.cleanupPath);

  if (identity === null) {
    if ((await readPathStats(state.cleanupPath)) !== null) {
      throw new Error(
        `OpenAI cleanup preserved an unexpected runtime home at ${state.cleanupPath}.`,
      );
    }
    await rmdir(cleanupRoot);
    state.cleanupPath = state.runtimeHome;
    state.cleanupRoot = null;
    return true;
  }

  if (identity.dev !== state.dev || identity.ino !== state.ino) {
    throw new Error(`OpenAI cleanup preserved an unexpected runtime home at ${state.cleanupPath}.`);
  }

  try {
    await rm(state.cleanupPath, { recursive: true });
    await rmdir(cleanupRoot);
    state.cleanupPath = state.runtimeHome;
    state.cleanupRoot = null;
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      await rmdir(cleanupRoot).catch((cleanupError: unknown) => {
        if (!hasErrorCode(cleanupError, "ENOENT")) {
          throw cleanupError;
        }
      });
      state.cleanupPath = state.runtimeHome;
      state.cleanupRoot = null;
      return true;
    }
    throw error;
  }
}

export async function materializeOpenAiAuthState(
  input: OpenAiAuthStateInput,
): Promise<OpenAiAuthStateResult> {
  const authJsonPath = join(input.runtimeHome, "auth.json");
  const apiKey = readOpenAiApiKey(input.env);

  if (apiKey === null) {
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

  const written = await writeFileAtomicallyAtPath(configTomlPath, Bun.TOML.stringify(config)!, {
    mode: 0o666,
    skipIfUnchanged: true,
  });

  return {
    configTomlPath,
    provider: input.provider,
    written,
  };
}
