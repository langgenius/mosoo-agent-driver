import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { DriverStartInput } from "../src/protocol/start";
import {
  assertPiConfiguration,
  assertPiPromptText,
  buildPiChildEnv,
  buildPiBootstrapFiles,
  readPiModelId,
} from "../src/runtimes/acp/pi-acp-bootstrap";
import { piInput } from "./fixtures/pi-acp/input";

function replaceGrant(input: DriverStartInput, delta: Record<string, unknown>): DriverStartInput {
  const variables = input.execution.environment.variables;
  const token = variables["OPENAI_COMPATIBLE_API_KEY"]!;
  const claims: unknown = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString());
  return {
    ...input,
    execution: {
      ...input.execution,
      environment: {
        variables: {
          ...variables,
          OPENAI_COMPATIBLE_API_KEY: `${Buffer.from(JSON.stringify({ ...Object(claims), ...delta })).toString("base64url")}.${Buffer.alloc(32).toString("base64url")}`,
        },
      },
    },
  };
}

describe("Given a frozen Pi model and existing Mosoo proxy grant", () => {
  test("Given current app-owned and legacy project-owned claim shapes, when structurally admitted, then both shapes pass and missing ownership is rejected", () => {
    const input = piInput();
    expect(() => assertPiConfiguration(input)).not.toThrow();
    expect(() =>
      assertPiConfiguration(replaceGrant(input, { projectId: undefined, appId: "app-fixture" })),
    ).not.toThrow();
    expect(() => assertPiConfiguration(replaceGrant(input, { projectId: undefined }))).toThrow(
      "Pi requires",
    );
    expect(() =>
      assertPiConfiguration(replaceGrant(input, { projectId: undefined, appId: "" })),
    ).toThrow("Pi requires");
  });

  test("when writing persistent native instructions then no one-shot READY bootstrap directive is included", () => {
    const input = piInput();
    const files = buildPiBootstrapFiles(
      {
        ...input,
        execution: { ...input.execution, systemPrompt: "Use the required test policy." },
      },
      [],
    );
    expect(files["APPEND_SYSTEM.md"]).toContain("Use the required test policy.");
    expect(files["APPEND_SYSTEM.md"]).not.toContain("Reply with exactly READY");
    expect(files["APPEND_SYSTEM.md"]).not.toContain("do not call tools");
  });

  test("when a user supplies adapter slash commands then the frozen model and native bootstrap cannot be bypassed", () => {
    for (const text of ["/model other", "  /thinking high", "\n/session", "/hostile"]) {
      expect(() => assertPiPromptText(text)).toThrow("slash commands");
    }
    expect(() => assertPiPromptText("Read /tmp/file and implement the fix.")).not.toThrow();
  });
  test("when building bootstrap then only the selected model and env-reference grant reach Pi", () => {
    const input = piInput();
    expect(() => assertPiConfiguration(input)).not.toThrow();
    expect(readPiModelId(input)).toBe("vendor/model-fixture");
    const files = buildPiBootstrapFiles(input, []);
    const models = JSON.parse(files["models.json"]!);
    expect(models.providers.mosoo).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://proxy.example.invalid/api/driver/llm/proxy/credential-fixture",
      apiKey: "$MOSOO_PI_PROXY_GRANT",
      models: [{ id: "vendor/model-fixture" }],
    });
    expect(JSON.stringify(files)).not.toContain(
      input.execution.environment.variables["OPENAI_COMPATIBLE_API_KEY"]!,
    );
    expect(JSON.parse(files["settings.json"]!)).toMatchObject({
      defaultProjectTrust: "never",
      cacheWarming: "off",
      packages: [],
      extensions: [],
    });
  });

  test("when the model contains multiple slashes then only the selected provider prefix is stripped", () => {
    const input = piInput();
    expect(
      readPiModelId({ ...input, execution: { ...input.execution, model: "vendor/model-fixture" } }),
    ).toBe("vendor/model-fixture");
  });

  test.each([
    { expiresAt: 0 },
    { modelId: "other" },
    { modelProtocol: "openai-responses" },
    { driverGeneration: 1 },
    { driverInstanceId: "other" },
    { action: "other" },
    { resourceId: "other" },
  ])("when a grant has incompatible claims %j then readiness fails closed", (delta) => {
    expect(() => assertPiConfiguration(replaceGrant(piInput(), delta))).toThrow("Pi requires");
  });

  test("when a raw provider key or direct vendor URL is supplied then readiness rejects it without exposing its value", () => {
    const input = piInput();
    const raw = {
      ...input,
      execution: {
        ...input.execution,
        environment: {
          variables: {
            ...input.execution.environment.variables,
            OPENAI_COMPATIBLE_API_KEY: "not-a-mosoo-grant",
          },
        },
      },
    };
    expect(() => assertPiConfiguration(raw)).toThrow("Pi requires");
    const direct = {
      ...input,
      execution: {
        ...input.execution,
        environment: {
          variables: {
            ...input.execution.environment.variables,
            OPENAI_COMPATIBLE_BASE_URL: "https://api.openai.com/v1",
          },
        },
      },
    };
    expect(() => assertPiConfiguration(direct)).toThrow("Pi requires");
  });

  test("when Agent environment attempts to override launch or inherit credentials then the Pi environment excludes them", () => {
    const input = piInput();
    const previousApiKey = process.env["OPENAI_API_KEY"];
    try {
      process.env["OPENAI_API_KEY"] = "ambient-fixture";
      const env = buildPiChildEnv({
        ...input,
        execution: {
          ...input.execution,
          environment: {
            variables: {
              ...input.execution.environment.variables,
              NODE_OPTIONS: "--import=evil",
              PI_ACP_PI_COMMAND: "/tmp/evil",
              HOME: "/tmp/other",
              ANTHROPIC_API_KEY: "unrelated-fixture",
            },
            paths: { executable: ["/tmp/evil-bin"], node: ["/tmp/evil-modules"], python: [] },
          },
        },
      });
      expect(env).toMatchObject({
        HOME: "/tmp/home/pi-acp",
        PI_CODING_AGENT_DIR: "/tmp/home/pi-acp/.pi/agent",
        PI_ACP_PI_COMMAND: "/usr/local/bin/mosoo-pi",
        npm_config_offline: "true",
      });
      for (const key of [
        "NODE_OPTIONS",
        "NODE_PATH",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_COMPATIBLE_API_KEY",
      ])
        expect(env[key]).toBeUndefined();
      expect(env["PATH"]).not.toContain("evil");
    } finally {
      if (previousApiKey === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = previousApiKey;
    }
  });

  test.each(["supervised", "mcp", "directories", "provider", "options"])(
    "when unsupported %s is configured then readiness fails",
    (kind) => {
      const input = piInput();
      const execution = {
        ...input.execution,
        ...(kind === "supervised" ? { permissionPolicy: "supervised" as const } : {}),
        ...(kind === "provider" ? { provider: "anthropic" } : {}),
        ...(kind === "options" ? { providerOptions: { command: "evil" } } : {}),
        session: {
          ...input.execution.session,
          ...(kind === "directories" ? { additionalDirectories: ["/tmp/other"] } : {}),
          ...(kind === "mcp"
            ? {
                mcpServers: [
                  {
                    authorizationState: "disabled" as const,
                    name: "fixture",
                    authType: "none",
                    credentialScope: "project",
                    credentialStatus: "disabled",
                    serverId: "fixture" as never,
                  },
                ],
              }
            : {}),
        },
      };
      expect(() => assertPiConfiguration({ ...input, execution })).toThrow();
    },
  );
});

test("Given Mosoo local Cloudflare provisioning, When proxy uses Docker host alias, Then admit that fixed development origin", () => {
  const input = piInput();
  const payload = {
    ...input,
    execution: {
      ...input.execution,
      environment: {
        variables: {
          ...input.execution.environment.variables,
          OPENAI_COMPATIBLE_BASE_URL:
            "http://host.docker.internal:8787/api/driver/llm/proxy/credential-fixture",
        },
      },
    },
  };
  expect(() => assertPiConfiguration(payload)).not.toThrow();
  payload.execution.environment.variables.OPENAI_COMPATIBLE_BASE_URL =
    "http://remote.example/api/driver/llm/proxy/credential-fixture";
  expect(() => assertPiConfiguration(payload)).toThrow("Pi requires");
});

test("Given Host Skill paths with shell metacharacters, When building explicit launch arguments, Then every path remains one literal argument and empty selection clears prior arguments", () => {
  const paths = [
    "/tmp/skill with spaces/SKILL.md",
    "/tmp/skill'quote/SKILL.md",
    "/tmp/$(exit 7)\nsecond-line/SKILL.md",
  ];
  const input = piInput();
  const skills = paths.map((skillMarkdownPath, index) => ({
    mountPath: "/tmp/skill",
    skillMarkdownPath,
    skillId: `skill-${index}`,
    skillName: `skill-${index}`,
    snapshotId: "snapshot",
  }));
  const files = buildPiBootstrapFiles(input, skills);
  const launch = files["mosoo-skills.sh"];
  expect(launch).toBeDefined();
  const result = spawnSync(
    "/bin/sh",
    ["-c", `${launch}\nprintf '%s\\0' "$@"`, "launcher", "--mode", "rpc"],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  expect(result.stdout.split("\0").slice(0, -1)).toEqual([
    ...paths.flatMap((path) => ["--skill", path]),
    "--mode",
    "rpc",
  ]);
  expect(buildPiBootstrapFiles(input, [])["mosoo-skills.sh"]).toBe("");
});

test("Given no bootstrap environment or skill manifest, When probing exactly --version, Then the fixed binary responds while real executions fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosoo-pi-version-"));
  try {
    const binary = join(directory, "pi");
    await writeFile(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await chmod(binary, 0o755);
    const source = await readFile(resolve(import.meta.dir, "../scripts/mosoo-pi"), "utf8");
    const wrapper = join(directory, "mosoo-pi");
    await writeFile(wrapper, source.replaceAll("/usr/local/bin/pi", binary));
    await chmod(wrapper, 0o755);
    const probe = spawnSync(wrapper, ["--version"], { env: {}, encoding: "utf8" });
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe("--version\n");
    for (const args of [
      ["--mode", "rpc"],
      ["--version", "--mode", "rpc"],
    ]) {
      const result = spawnSync(wrapper, args, { env: {}, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    }
    const absentManifest = spawnSync(wrapper, ["--mode", "rpc"], {
      env: { PI_CODING_AGENT_DIR: directory },
      encoding: "utf8",
    });
    expect(absentManifest.status).not.toBe(0);
    expect(absentManifest.stdout).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
