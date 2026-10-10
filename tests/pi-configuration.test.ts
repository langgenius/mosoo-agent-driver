import { afterEach, expect, test } from "bun:test";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CredentialId, McpServerId } from "../src/protocol/boot";
import { MAX_NATIVE_CHECKPOINT_FILE_BYTES } from "../src/protocol/native-checkpoint";
import type { DriverNativeRuntimeRef } from "../src/protocol/runtime";
import type { DriverStartInput } from "../src/protocol/start";
import {
  DRIVER_BOOT_PAYLOAD_ENV_NAME,
  DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME,
} from "../src/runtimes/child-process-env";
import { createNativeCheckpoint, pinNativeCheckpointRoot } from "../src/runtimes/native-checkpoint";
import {
  preparePiLaunch,
  readPiSessionFile,
  resolvePiSessionPath,
} from "../src/runtimes/pi/pi-configuration";
import { driverStartInput, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function payloadFor(): Promise<DriverStartInput> {
  const root = await mkdtemp(join(tmpdir(), "mosoo-pi-configuration-"));
  roots.push(root);
  return {
    ...driverStartInput,
    runtime: "pi",
    runtimeTransport: "pi-rpc",
    execution: {
      ...driverStartInput.execution,
      model: "deepseek/pi-test",
      provider: "deepseek",
      systemPrompt: "Keep this instruction.",
      environment: {
        variables: {
          MOSOO_PI_CONFIG_CONTENT: JSON.stringify({
            providers: {
              mosoo: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:1/v1",
                apiKey: "${MOSOO_PI_PROXY_GRANT}",
                models: [{ id: "pi-test" }],
              },
            },
          }),
          MOSOO_PI_PROXY_GRANT: "model-grant",
          [DRIVER_BOOT_PAYLOAD_ENV_NAME]: "private-boot",
          [DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME]: "/private/boot.json",
        },
        paths: { executable: ["/runtime/bin"], node: [], python: [] },
      },
      session: {
        ...driverStartInput.execution.session,
        homePath: root,
        cwd: root,
        sharedRootPath: root,
        mcpServers: [],
      },
    },
  };
}

function resume(payload: DriverStartInput, value: string, runtimeId = "pi"): DriverStartInput {
  const nativeRef = { runtimeId, kind: "pi_session_path", value } as DriverNativeRuntimeRef;
  return {
    ...payload,
    execution: {
      ...payload.execution,
      session: {
        ...payload.execution.session,
        nativeResumeRef: nativeRef,
        nativeCheckpoint: { formatVersion: 1, runId: DRIVER_TEST_IDS.runId, nativeRef },
      },
    },
  };
}

async function withCheckpoint(
  payload: DriverStartInput,
  content: string,
  pointer = "sessions/session.jsonl",
): Promise<DriverStartInput> {
  const restored = resume(payload, pointer);
  await createNativeCheckpoint({
    root: await pinNativeCheckpointRoot(payload.execution.session.cwd),
    runId: DRIVER_TEST_IDS.runId,
    nativeRef: restored.execution.session.nativeResumeRef!,
    signal: new AbortController().signal,
    write: async (directory) => {
      await writeFile(join(directory, "session.jsonl"), content);
    },
  });
  return restored;
}

function session(cwd: string): string {
  return (
    JSON.stringify({
      type: "session",
      version: 3,
      id: "session",
      timestamp: "2026-10-10T00:00:00.000Z",
      cwd,
    }) + "\n"
  );
}

test("launch preserves native model, instruction, permission and active MCP wiring", async () => {
  const payload = await payloadFor();
  const server = {
    authType: "oauth",
    credentialScope: "account",
    credentialStatus: "active",
    name: "MCP server",
    serverId: "01J00000000000000000000020" as McpServerId,
  };
  payload.execution.session.mcpServers.push(
    {
      ...server,
      authorizationState: "active",
      credentialId: "01J00000000000000000000021" as CredentialId,
      proxyGrantId: "mcp-grant",
      proxyUrl: "https://example.com/mcp",
    },
    {
      ...server,
      serverId: "01J00000000000000000000022" as McpServerId,
      authorizationState: "revoked",
    },
  );

  const config = await preparePiLaunch(payload);
  expect(config.cwd).toBe(payload.execution.session.cwd);
  expect(
    config.args.slice(config.args.indexOf("--model"), config.args.indexOf("--model") + 2),
  ).toEqual(["--model", "pi-test"]);
  expect(config.args).toContain("builtin:mcp");
  expect(config.args).toContain(join(config.home, "mosoo-permissions.mjs"));
  expect(await readFile(join(config.home, "mosoo-permissions.mjs"), "utf8")).toContain(
    'ctx.ui.confirm("mosoo.tool_permission"',
  );
  expect(
    await readFile(join(payload.execution.session.homePath, "runtime-instructions.md"), "utf8"),
  ).toContain("Keep this instruction.");
  expect(JSON.parse(await readFile(join(config.home, "mcp.json"), "utf8"))).toEqual({
    mcpServers: {
      [server.serverId]: {
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer ${MOSOO_PI_MCP_GRANT_0}" },
        exposure: "direct",
      },
    },
  });
  expect(config.env["MOSOO_PI_MCP_GRANT_0"]).toBe("mcp-grant");
  expect(config.env["MOSOO_PI_PROXY_GRANT"]).toBe("model-grant");
  expect(config.env["PATH"]?.startsWith("/runtime/bin:")).toBe(true);
  expect(config.env["HOME"]).toBe(payload.execution.session.homePath);
  expect(config.env["PI_CODING_AGENT_DIR"]).toBe(config.home);
  expect(config.env[DRIVER_BOOT_PAYLOAD_ENV_NAME]).toBeUndefined();
  expect(config.env[DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME]).toBeUndefined();
});

test("atomic configuration writes replace symlinks without modifying their targets", async () => {
  const payload = await payloadFor();
  const home = join(payload.execution.session.homePath, "pi");
  const target = join(payload.execution.session.homePath, "untouched.txt");
  await mkdir(home);
  await writeFile(target, "keep", { mode: 0o644 });
  const names = ["models.json", "settings.json", "mosoo-permissions.mjs", "mcp.json"];
  for (const name of names) await symlink(target, join(home, name));

  await preparePiLaunch(payload);
  expect(await readFile(target, "utf8")).toBe("keep");
  for (const name of names) {
    expect((await lstat(join(home, name))).isSymbolicLink()).toBe(false);
    expect((await stat(join(home, name))).mode & 0o777).toBe(0o600);
  }
});

test.each(["pi", "pi/sessions"])("refuses a symlink directory at %s", async (name) => {
  const payload = await payloadFor();
  const root = payload.execution.session.homePath;
  const outside = join(root, "outside");
  await mkdir(outside);
  if (name !== "pi") await mkdir(join(root, "pi"));
  await symlink(outside, join(root, name));
  await expect(preparePiLaunch(payload)).rejects.toThrow("real directory");
  await expect(readFile(join(outside, "models.json"))).rejects.toThrow();
});

test("cancelled startup performs no configuration write", async () => {
  const payload = await payloadFor();
  await expect(
    preparePiLaunch(payload, [], AbortSignal.abort(new Error("cancelled"))),
  ).rejects.toThrow("cancelled");
  await expect(stat(join(payload.execution.session.homePath, "pi"))).rejects.toThrow();
});

test.each(["missing-config", "invalid-json", "non-object", "missing-grant"])(
  "requires a model configuration and grant: %s",
  async (invalid) => {
    const payload = await payloadFor();
    const variables = payload.execution.environment.variables;
    if (invalid === "missing-config") delete variables["MOSOO_PI_CONFIG_CONTENT"];
    if (invalid === "invalid-json") variables["MOSOO_PI_CONFIG_CONTENT"] = "{broken";
    if (invalid === "non-object") variables["MOSOO_PI_CONFIG_CONTENT"] = "[]";
    if (invalid === "missing-grant") delete variables["MOSOO_PI_PROXY_GRANT"];
    await expect(preparePiLaunch(payload)).rejects.toThrow();
    await expect(stat(join(payload.execution.session.homePath, "pi"))).rejects.toThrow();
  },
);

test("resume reconstructs the native session from the durable checkpoint", async () => {
  const payload = await payloadFor();
  const root = payload.execution.session.homePath;
  const path = join(root, "pi", "sessions", "session.jsonl");
  const restored = await withCheckpoint(payload, session(root));
  const config = await preparePiLaunch(restored);
  expect(
    config.args.slice(config.args.indexOf("--session"), config.args.indexOf("--session") + 2),
  ).toEqual(["--session", path]);
  expect(await readPiSessionFile(config.home, "sessions/session.jsonl")).toBe(session(root));
  await writeFile(path, "stale runtime content");
  await preparePiLaunch(restored);
  expect(await readFile(path, "utf8")).toBe(session(root));
});

test.each(["jsonl", "workspace"])(
  "resume rejects a valid checkpoint with invalid %s",
  async (invalid) => {
    const payload = await payloadFor();
    const content =
      invalid === "jsonl" ? session(payload.execution.session.cwd) + "{broken" : session(tmpdir());
    const restored = await withCheckpoint(payload, content);
    await expect(preparePiLaunch(restored)).rejects.toThrow();
    await expect(
      stat(join(payload.execution.session.homePath, "pi", "sessions", "session.jsonl")),
    ).rejects.toThrow();
  },
);

test("resume fails for a missing checkpoint, missing descriptor, or another runtime", async () => {
  const payload = await payloadFor();
  await expect(preparePiLaunch(resume(payload, "sessions/missing.jsonl"))).rejects.toThrow();
  const withoutCheckpoint = resume(payload, "sessions/missing.jsonl");
  await expect(
    preparePiLaunch({
      ...withoutCheckpoint,
      execution: {
        ...withoutCheckpoint.execution,
        session: { ...withoutCheckpoint.execution.session, nativeCheckpoint: null },
      },
    }),
  ).rejects.toThrow("matching durable checkpoint");
  await expect(
    preparePiLaunch(resume(payload, "sessions/session.jsonl", "openai-runtime")),
  ).rejects.toThrow("another runtime");
});

test.each(["linked.jsonl", "linked-directory/outside.jsonl"])(
  "resume rejects symlinks at %s",
  async (pointer) => {
    const payload = await payloadFor();
    const root = payload.execution.session.homePath;
    const restored = await withCheckpoint(payload, session(root), `sessions/${pointer}`);
    const sessions = join(root, "pi", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(root, "outside.jsonl"), session(root));
    await symlink(join(root, "outside.jsonl"), join(sessions, "linked.jsonl"));
    await symlink(root, join(sessions, "linked-directory"));
    await expect(preparePiLaunch(restored)).rejects.toThrow();
    await expect(readPiSessionFile(join(root, "pi"), `sessions/${pointer}`)).rejects.toThrow();
    expect(await readFile(join(root, "outside.jsonl"), "utf8")).toBe(session(root));
  },
);

test("native resume pointers must remain under sessions", () => {
  for (const pointer of [
    "/outside.jsonl",
    "../outside.jsonl",
    "sessions/../../outside.jsonl",
    "sessions",
  ]) {
    expect(() => resolvePiSessionPath("/home/pi", pointer)).toThrow("outside");
  }
});

test("live native session reads reject directories and hardlinks", async () => {
  const payload = await payloadFor();
  const root = payload.execution.session.homePath;
  const home = join(root, "pi");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "sessions", "directory"));
  await writeFile(join(root, "outside.jsonl"), session(root));
  await link(join(root, "outside.jsonl"), join(home, "sessions", "linked.jsonl"));
  await expect(readPiSessionFile(home, "sessions/directory")).rejects.toThrow("regular file");
  await expect(readPiSessionFile(home, "sessions/linked.jsonl")).rejects.toThrow(
    "without hardlinks",
  );
});

test("live native session rejects an oversized sparse file before reading it", async () => {
  const payload = await payloadFor();
  const home = join(payload.execution.session.homePath, "pi");
  await mkdir(join(home, "sessions"), { recursive: true });
  const file = join(home, "sessions", "large.jsonl");
  await writeFile(file, "");
  await truncate(file, MAX_NATIVE_CHECKPOINT_FILE_BYTES + 1);
  await expect(readPiSessionFile(home, "sessions/large.jsonl")).rejects.toThrow(
    "checkpoint size limit",
  );
});

test("live native session rejects invalid UTF-8 instead of replacing conversation bytes", async () => {
  const payload = await payloadFor();
  const home = join(payload.execution.session.homePath, "pi");
  await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(join(home, "sessions", "invalid.jsonl"), Buffer.from([0xc3, 0x28]));
  await expect(readPiSessionFile(home, "sessions/invalid.jsonl")).rejects.toThrow();
});
