import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDriverId } from "../src/protocol/id";
import type { DriverInstanceId } from "../src/protocol/id";
import {
  cleanupOpenAiRuntimeHome,
  createOpenAiRuntimeHome,
  materializeOpenAiAuthState,
  materializeOpenAiModelProviderConfig,
} from "../src/runtimes/openai/auth-state";

type RuntimeHomeState = Awaited<ReturnType<typeof createOpenAiRuntimeHome>>;

const temporaryDirectories: string[] = [];
const runtimeHomeStates: RuntimeHomeState[] = [];
const PERSISTENT_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "memories",
  "memories_extensions",
] as const;

function createDriverInstanceId(): DriverInstanceId {
  return createDriverId() as DriverInstanceId;
}

async function createTemporaryDirectory(prefix = "mosoo-openai-auth-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createRuntimeHome(
  persistentRuntimeHome?: string,
  driverGeneration = 0,
): Promise<RuntimeHomeState> {
  const persistentHome = persistentRuntimeHome ?? (await createTemporaryDirectory());
  const state = await createOpenAiRuntimeHome({
    driverGeneration,
    driverInstanceId: createDriverInstanceId(),
    persistentRuntimeHome: persistentHome,
  });
  runtimeHomeStates.push(state);
  return state;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected ${label} to be an object.`);
  }

  return value as Record<string, unknown>;
}

async function readGeneratedConfig(path: string): Promise<Record<string, unknown>> {
  return requireRecord(Bun.TOML.parse(await readFile(path, "utf8")), "generated config");
}

function expectDisabledRuntimeFeatures(config: Record<string, unknown>): void {
  expect(requireRecord(config["features"], "runtime features")).toMatchObject({
    plugins: false,
    remote_plugin: false,
    tool_suggest: false,
  });
}

async function runCrossProcessAuthChild(
  authState: typeof import("../src/runtimes/openai/auth-state"),
): Promise<void> {
  const root = process.env["RACE_ROOT"]!;
  const role = process.env["RACE_ROLE"]!;
  const driverInstanceId = process.env["DRIVER_INSTANCE_ID"]! as DriverInstanceId;
  let state: Awaited<ReturnType<typeof authState.createOpenAiRuntimeHome>> | null = null;
  const marker = (name: string) => `${root}/${name}`;
  const waitFor = async (name: string) => {
    const deadline = Date.now() + 5_000;
    while (!(await Bun.file(marker(name)).exists())) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for cross-process auth marker ${name}.`);
      }
      await Bun.sleep(2);
    }
  };

  try {
    if (role === "old") {
      state = await authState.createOpenAiRuntimeHome({
        driverGeneration: 1,
        driverInstanceId,
        persistentRuntimeHome: root,
      });
      await Bun.write(marker("old-home.json"), JSON.stringify(state));
      await waitFor("successor-auth.json");
      await authState.materializeOpenAiAuthState({
        env: { OPENAI_API_KEY: "old-key" },
        runtimeHome: state.runtimeHome,
      });
      await Bun.write(marker("old-auth.json"), JSON.stringify(state));
      await waitFor("release-old");
      await authState.cleanupOpenAiRuntimeHome(state);
      state = null;
      await Bun.write(marker("old-cleaned"), "");
      return;
    }

    await waitFor("old-home.json");
    state = await authState.createOpenAiRuntimeHome({
      driverGeneration: 2,
      driverInstanceId,
      persistentRuntimeHome: root,
    });
    await authState.materializeOpenAiAuthState({
      env: { OPENAI_API_KEY: "successor-key" },
      runtimeHome: state.runtimeHome,
    });
    await Bun.write(marker("successor-auth.json"), JSON.stringify(state));
    await waitFor("old-auth.json");
    await Bun.write(marker("release-old"), "");
    await waitFor("old-cleaned");
    const auth = await Bun.file(`${state.runtimeHome}/auth.json`).json();
    await Bun.write(marker("successor-observed.json"), JSON.stringify(auth));
    await authState.cleanupOpenAiRuntimeHome(state);
    state = null;
  } finally {
    if (state !== null) {
      await authState.cleanupOpenAiRuntimeHome(state).catch(() => false);
    }
  }
}

async function readChildError(child: ReturnType<typeof Bun.spawn>): Promise<string> {
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : "",
  ]);
  expect(exitCode, stderr).toBe(0);
  return stderr;
}

afterEach(async () => {
  await Promise.all(
    runtimeHomeStates.splice(0).map((state) => cleanupOpenAiRuntimeHome(state).catch(() => false)),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("OpenAI app-server auth state", () => {
  test("rejects runtime identities that cannot be safe path segments", async () => {
    const persistentRuntimeHome = await createTemporaryDirectory();

    await expect(
      createOpenAiRuntimeHome({
        driverGeneration: -1,
        driverInstanceId: createDriverInstanceId(),
        persistentRuntimeHome,
      }),
    ).rejects.toThrow("identity is invalid");
    await expect(
      createOpenAiRuntimeHome({
        driverGeneration: 0,
        driverInstanceId: "../../credential" as DriverInstanceId,
        persistentRuntimeHome,
      }),
    ).rejects.toThrow("identity is invalid");
  });

  test("creates a private runtime home with only explicit persistent state links", async () => {
    const state = await createRuntimeHome();

    expect((await lstat(state.runtimeHome)).mode & 0o777).toBe(0o700);
    for (const name of PERSISTENT_DIRECTORIES) {
      const persistentPath = join(state.persistentRuntimeHome, name);
      expect((await lstat(persistentPath)).isDirectory()).toBe(true);
      expect((await lstat(join(state.runtimeHome, name))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(state.runtimeHome, name))).toBe(persistentPath);
    }
  });

  test("persists rollout and memory state across isolated runtime-home generations", async () => {
    const persistentRuntimeHome = await createTemporaryDirectory();
    const first = await createRuntimeHome(persistentRuntimeHome, 1);

    for (const name of PERSISTENT_DIRECTORIES) {
      await writeFile(join(first.runtimeHome, name, "retained"), name);
    }
    await cleanupOpenAiRuntimeHome(first);

    const successor = await createRuntimeHome(persistentRuntimeHome, 2);
    for (const name of PERSISTENT_DIRECTORIES) {
      expect(await readFile(join(successor.runtimeHome, name, "retained"), "utf8")).toBe(name);
    }
  });

  test("removes auth, config, and temporary home without following persistent links", async () => {
    const state = await createRuntimeHome();
    await materializeOpenAiAuthState({
      env: { OPENAI_API_KEY: "openai-key" },
      runtimeHome: state.runtimeHome,
    });
    await materializeOpenAiModelProviderConfig({
      env: { OPENAI_API_KEY: "openai-key" },
      provider: "openai",
      runtimeHome: state.runtimeHome,
    });
    await writeFile(join(state.runtimeHome, "sessions", "retained"), "session");

    expect(await cleanupOpenAiRuntimeHome(state)).toBe(true);
    expect(await cleanupOpenAiRuntimeHome(state)).toBe(false);
    await expect(lstat(state.runtimeHome)).rejects.toThrow();
    expect(await readFile(join(state.persistentRuntimeHome, "sessions", "retained"), "utf8")).toBe(
      "session",
    );
  });

  test("preserves a real directory that replaces the owned runtime-home path", async () => {
    const state = await createRuntimeHome();
    const movedOwnedHome = `${state.runtimeHome}.moved`;

    try {
      await materializeOpenAiAuthState({
        env: { OPENAI_API_KEY: "owned-key" },
        runtimeHome: state.runtimeHome,
      });
      await rename(state.runtimeHome, movedOwnedHome);
      await mkdir(state.runtimeHome);
      await writeFile(join(state.runtimeHome, "replacement-marker"), "preserve");

      await expect(cleanupOpenAiRuntimeHome(state)).rejects.toThrow(
        "preserved an unexpected runtime home",
      );
      expect(state.cleanupRoot).not.toBeNull();
      expect(await readFile(join(state.cleanupPath, "replacement-marker"), "utf8")).toBe(
        "preserve",
      );
      expect(await readFile(join(movedOwnedHome, "auth.json"), "utf8")).toContain("owned-key");
    } finally {
      if (state.cleanupRoot !== null) {
        await rm(state.cleanupRoot, { force: true, recursive: true }).catch(() => {});
      }
      state.cleanupPath = state.runtimeHome;
      state.cleanupRoot = null;
      await rm(state.runtimeHome, { force: true, recursive: true });
      await rm(movedOwnedHome, { force: true, recursive: true });
    }
  });

  test("isolates late predecessor materialization and cleanup across child processes", async () => {
    const root = await createTemporaryDirectory("mosoo-openai-process-race-");
    const authStateModule = join(import.meta.dir, "../src/runtimes/openai/auth-state.ts");
    const source = `import * as authState from ${JSON.stringify(authStateModule)};
await (${runCrossProcessAuthChild.toString()})(authState)`;
    const commonEnv = Object.fromEntries(
      Object.entries({
        ...process.env,
        DRIVER_INSTANCE_ID: createDriverInstanceId(),
        RACE_ROOT: root,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const old = Bun.spawn([process.execPath, "-e", source], {
      env: { ...commonEnv, RACE_ROLE: "old" },
      stderr: "pipe",
      stdout: "ignore",
    });
    const successor = Bun.spawn([process.execPath, "-e", source], {
      env: { ...commonEnv, RACE_ROLE: "successor" },
      stderr: "pipe",
      stdout: "ignore",
    });

    try {
      await Promise.all([readChildError(old), readChildError(successor)]);
      expect(
        JSON.parse(await readFile(join(root, "successor-observed.json"), "utf8")),
      ).toMatchObject({
        OPENAI_API_KEY: "successor-key",
        auth_mode: "apikey",
      });
      const oldState = JSON.parse(await readFile(join(root, "old-home.json"), "utf8")) as {
        runtimeHome: string;
      };
      const successorState = JSON.parse(
        await readFile(join(root, "successor-auth.json"), "utf8"),
      ) as { runtimeHome: string };
      await expect(lstat(oldState.runtimeHome)).rejects.toThrow();
      await expect(lstat(successorState.runtimeHome)).rejects.toThrow();
    } finally {
      old.kill("SIGKILL");
      successor.kill("SIGKILL");
      await Promise.allSettled([old.exited, successor.exited]);
    }
  });

  test("writes API-key auth as a private regular file", async () => {
    const { runtimeHome } = await createRuntimeHome();
    const result = await materializeOpenAiAuthState({
      env: { OPENAI_API_KEY: "openai-key" },
      runtimeHome,
    });

    expect(result).toMatchObject({ hasApiKey: true, written: true });
    expect((await lstat(result.authJsonPath)).isFile()).toBe(true);
    expect((await lstat(result.authJsonPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(result.authJsonPath, "utf8"))).toMatchObject({
      OPENAI_API_KEY: "openai-key",
      auth_mode: "apikey",
    });
  });

  test("does not create auth state without an injected API key", async () => {
    const { runtimeHome } = await createRuntimeHome();
    const result = await materializeOpenAiAuthState({ env: {}, runtimeHome });

    expect(result).toMatchObject({ hasApiKey: false, written: false });
    await expect(lstat(result.authJsonPath)).rejects.toThrow();
  });

  test("fails closed without modifying legacy workspace credentials", async () => {
    for (const kind of ["regular", "external-link"] as const) {
      const persistentRuntimeHome = await createTemporaryDirectory();
      const authJsonPath = join(persistentRuntimeHome, "auth.json");
      const externalTarget = join(persistentRuntimeHome, "external-auth.json");

      if (kind === "regular") {
        await writeFile(authJsonPath, "oauth-secret\n");
      } else {
        await writeFile(externalTarget, "external-oauth-secret\n");
        await symlink(externalTarget, authJsonPath);
      }

      await expect(
        createOpenAiRuntimeHome({
          driverGeneration: 0,
          driverInstanceId: createDriverInstanceId(),
          persistentRuntimeHome,
        }),
      ).rejects.toThrow("must not contain credentials");

      if (kind === "regular") {
        expect(await readFile(authJsonPath, "utf8")).toBe("oauth-secret\n");
      } else {
        expect(await readlink(authJsonPath)).toBe(externalTarget);
        expect(await readFile(externalTarget, "utf8")).toBe("external-oauth-secret\n");
      }
    }
  });

  test("writes model provider config for OpenAI-compatible credentials", async () => {
    const runtimeHome = await createTemporaryDirectory();
    const result = await materializeOpenAiModelProviderConfig({
      env: {
        OPENAI_COMPATIBLE_API_KEY: "compat-key",
        OPENAI_COMPATIBLE_BASE_URL: "https://compat.example/v1",
      },
      provider: "openai-compatible",
      providerOptions: {
        features: { tool_suggest: true },
        model_providers: { "openai-compatible": { wire_api: "chat" } },
        sandbox_workspace_write: true,
      },
      runtimeHome,
    });
    const config = await readGeneratedConfig(result.configTomlPath);
    const modelProviders = requireRecord(config["model_providers"], "model providers");

    expect(result.written).toBe(true);
    expect(config["model_provider"]).toBe("openai-compatible");
    expect(modelProviders["openai-compatible"]).toEqual({
      base_url: "https://compat.example/v1",
      env_key: "OPENAI_COMPATIBLE_API_KEY",
      name: "mosoo OpenAI-Compatible",
      wire_api: "chat",
    });
    expect(requireRecord(config["features"], "runtime features")).toMatchObject({
      plugins: false,
      remote_plugin: false,
      tool_suggest: true,
    });
    expect(config["sandbox_workspace_write"]).toBe(true);
  });

  test("writes generated config for built-in OpenAI auth", async () => {
    const runtimeHome = await createTemporaryDirectory();
    const result = await materializeOpenAiModelProviderConfig({
      env: {
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: "https://proxy.example/v1",
      },
      provider: "openai",
      runtimeHome,
    });
    const config = await readGeneratedConfig(result.configTomlPath);

    expect(result.written).toBe(true);
    expect(config["model_provider"]).toBeUndefined();
    expect(config["model_providers"]).toBeUndefined();
    expect(config["openai_base_url"]).toBe("https://proxy.example/v1");
    expectDisabledRuntimeFeatures(config);
  });

  test("passes reasoning effort and verbosity provider options into generated config", async () => {
    const runtimeHome = await createTemporaryDirectory();
    const result = await materializeOpenAiModelProviderConfig({
      env: { OPENAI_API_KEY: "openai-key" },
      provider: "openai",
      providerOptions: {
        model_reasoning_effort: "high",
        model_verbosity: "low",
      },
      runtimeHome,
    });
    const config = await readGeneratedConfig(result.configTomlPath);

    expect(result.written).toBe(true);
    expect(config["model_reasoning_effort"]).toBe("high");
    expect(config["model_verbosity"]).toBe("low");
    expectDisabledRuntimeFeatures(config);
  });

  test("writes only configured mcp_servers tables", async () => {
    const runtimeHome = await createTemporaryDirectory();
    const input = {
      env: { OPENAI_API_KEY: "openai-key" },
      provider: "openai",
      runtimeHome,
    };
    const withServer = await materializeOpenAiModelProviderConfig({
      ...input,
      mcpServers: {
        Linear: {
          bearer_token_env_var: "MOSOO_MCP_BEARER_TOKEN_0",
          url: "https://api.example/driver/mcp/proxy/server-1",
        },
      },
    });
    const config = await readGeneratedConfig(withServer.configTomlPath);

    expect(requireRecord(config["mcp_servers"], "mcp servers")["Linear"]).toEqual({
      bearer_token_env_var: "MOSOO_MCP_BEARER_TOKEN_0",
      url: "https://api.example/driver/mcp/proxy/server-1",
    });

    const withoutServers = await materializeOpenAiModelProviderConfig({
      ...input,
      mcpServers: {},
    });
    expect(
      (await readGeneratedConfig(withoutServers.configTomlPath))["mcp_servers"],
    ).toBeUndefined();
  });

  test("skips unchanged regular config writes but replaces an unchanged symlink", async () => {
    const runtimeHome = await createTemporaryDirectory();
    const configTomlPath = join(runtimeHome, "config.toml");
    const input = {
      env: { OPENAI_API_KEY: "openai-key" },
      provider: "openai",
      runtimeHome,
    };

    await expect(materializeOpenAiModelProviderConfig(input)).resolves.toMatchObject({
      written: true,
    });
    await expect(materializeOpenAiModelProviderConfig(input)).resolves.toMatchObject({
      written: false,
    });

    const contents = await readFile(configTomlPath, "utf8");
    const target = join(runtimeHome, "config-target.toml");
    await rm(configTomlPath);
    await writeFile(target, contents);
    await symlink(target, configTomlPath);

    await expect(materializeOpenAiModelProviderConfig(input)).resolves.toMatchObject({
      written: true,
    });
    expect((await lstat(configTomlPath)).isSymbolicLink()).toBe(false);
    expect(await readFile(target, "utf8")).toBe(contents);
  });

  test("fails OpenAI-compatible provider config when credentials are incomplete", async () => {
    const runtimeHome = await createTemporaryDirectory();

    await expect(
      materializeOpenAiModelProviderConfig({
        env: { OPENAI_COMPATIBLE_API_KEY: "compat-key" },
        provider: "openai-compatible",
        runtimeHome,
      }),
    ).rejects.toThrow(
      "OpenAI-compatible provider requires OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_BASE_URL.",
    );
  });
});
