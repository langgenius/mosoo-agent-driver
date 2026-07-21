import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { OPENAI_APP_SERVER_SCHEMA_VERSION } from "../src/runtimes/openai/generated/app-server-protocol-types";
import { AGENT_DRIVER_VERSION } from "../src/core/version";

type DriverPackageExportTarget =
  | string
  | {
      readonly default?: string;
      readonly types?: string;
    };

interface DriverPackageJson {
  readonly bin?: Record<string, string>;
  readonly bugs?: { readonly url?: string };
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly description?: string;
  readonly engines?: Record<string, string>;
  readonly exports?: Record<string, DriverPackageExportTarget>;
  readonly files?: readonly string[];
  readonly homepage?: string;
  readonly license?: string;
  readonly name?: string;
  readonly packageManager?: string;
  readonly private?: boolean;
  readonly publishConfig?: Record<string, string>;
  readonly repository?: { readonly type?: string; readonly url?: string };
  readonly scripts?: Record<string, string>;
  readonly types?: string;
  readonly type?: string;
  readonly version?: string;
}

const PUBLIC_EXPORTS = [
  ".",
  "./boot",
  "./cma-http",
  "./cma-sdk",
  "./contract",
  "./events",
  "./orpc",
  "./paths",
  "./provider-output",
  "./runtime",
] as const;

function readText(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function readDriverPackageJson(): DriverPackageJson {
  return JSON.parse(readText("../package.json")) as DriverPackageJson;
}

describe("driver artifact contract", () => {
  test("uses the public mosoo package identity", () => {
    const packageJson = readDriverPackageJson();

    expect(packageJson.name).toBe("@mosoo/agent-driver");
    expect(packageJson.private).toBe(false);
    expect(packageJson.version).toBe(AGENT_DRIVER_VERSION);
    expect(packageJson.description).toContain("Agent Driver");
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.packageManager).toBe("bun@1.3.14");
    expect(packageJson.engines).toEqual({ bun: ">=1.3.14" });
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/langgenius/mosoo-agent-driver.git",
    });
    expect(packageJson.bugs?.url).toBe("https://github.com/langgenius/mosoo-agent-driver/issues");
    expect(packageJson.homepage).toBe("https://github.com/langgenius/mosoo-agent-driver");
    expect(packageJson.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/",
    });
    expect(packageJson.bin).toEqual({
      "agent-driver": "./dist/driver.mjs",
    });
    expect(packageJson.types).toBe("./dist/types/index.d.ts");
    expect(packageJson.files).toEqual(["dist", "src", "assets"]);
    expect(packageJson.files).not.toContain("tests/fixtures");
  });

  test("keeps public package entries separate from process internals", () => {
    const packageJson = readDriverPackageJson();

    expect(packageJson.type).toBe("module");
    expect(Object.keys(packageJson.exports ?? {}).toSorted()).toEqual(
      [...PUBLIC_EXPORTS].toSorted(),
    );
    expect(packageJson.exports?.["."]).toEqual({
      default: "./src/index.ts",
      types: "./dist/types/index.d.ts",
    });
    expect(packageJson.exports).not.toHaveProperty("./bin/driver");
  });

  test("uses package.json as the runtime version source", () => {
    const packageJson = readDriverPackageJson();
    const runtimeVersionSources = [
      "../src/bin/driver-process.ts",
      "../src/runtimes/acp/acp-driver-backend.ts",
      "../src/runtimes/claude/agent-sdk-query-options.ts",
      "../src/runtimes/mcp/remote-http-mcp-executor.ts",
      "../src/runtimes/openai/app-server-client.ts",
    ];

    expect(readText("../src/core/version.ts")).toContain('from "../../package.json"');
    for (const source of runtimeVersionSources) {
      expect(readText(source)).toContain("AGENT_DRIVER_VERSION");
      expect(readText(source)).not.toContain(`"${packageJson.version}"`);
    }
  });

  test("keeps the root library entry free of boot and transport internals", () => {
    const publicApi = readText("../src/index.ts");

    expect(publicApi).toContain("./core/agent-driver-kernel");
    expect(publicApi).toContain("./runtimes/provider-registry");
    expect(publicApi).toContain("./protocol/runtime");
    expect(publicApi).not.toContain("./bin/driver-process");
    expect(publicApi).not.toContain("./protocol/boot");
    expect(publicApi).not.toContain("./protocol/orpc");
    expect(publicApi).not.toContain("./protocol/paths");
    expect(publicApi).not.toContain("DriverProcess");
    expect(publicApi).not.toContain("DriverBootPayload");
    expect(publicApi).not.toContain("DriverRuntimeClient");
    expect(publicApi).not.toContain("createDriverStartInputFromBootPayload");
  });

  test("builds and packages only the process runner artifact", () => {
    const packageJson = readDriverPackageJson();
    const buildScript = packageJson.scripts?.["build"] ?? "";
    const imageBuildScript = packageJson.scripts?.["build:image"] ?? "";
    const containerignore = readText("../.containerignore");
    const containerfile = readText("../Containerfile");
    const processEntry = readText("../src/bin/driver.ts");

    expect(processEntry.startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(buildScript).toContain("src/bin/driver.ts");
    expect(buildScript).toContain("dist/driver.mjs");
    expect(buildScript).not.toContain("src/index.ts");
    expect(containerfile).toContain("COPY dist/driver.mjs /usr/local/bin/agent-driver");
    expect(containerfile).toContain("RUN chmod +x /usr/local/bin/agent-driver");
    expect(containerfile).toContain("ENV MOSOO_ACP_FALLBACK_COMMAND=opencode");
    expect(containerignore).toContain("!dist/driver.mjs");
    expect(imageBuildScript).toBe("vp run build && buildah build -t agent-driver:local .");
    expect(packageJson.scripts?.["prepack"]).toBe("vp run build");
  });

  test("pins the OpenAI runtime, SDK, and app-server schema to one stable version", () => {
    const packageJson = readDriverPackageJson();
    const containerfile = readText("../Containerfile");

    expect(packageJson.devDependencies?.["@openai/codex-sdk"]).toBe(
      OPENAI_APP_SERVER_SCHEMA_VERSION,
    );
    expect(containerfile).toContain(
      `ARG OPENAI_RUNTIME_VERSION=${OPENAI_APP_SERVER_SCHEMA_VERSION}`,
    );
  });

  test("runs every live suite through the packed driver controller", () => {
    const packageJson = readDriverPackageJson();
    const controller = readText("./driver-artifact-test-controller.ts");
    const liveTest = readText("./driver-artifact-live.test.ts");
    const artifactScript = packageJson.scripts?.["test:live:artifact"] ?? "";

    expect(artifactScript).toContain("AGENT_DRIVER_LIVE=1");
    expect(artifactScript).toContain("tests/driver-artifact-live.test.ts");
    expect(packageJson.scripts?.["test:live"]).toBe("vp run build && vp run test:live:artifact");
    for (const suite of ["anthropic", "openai", "opencode"] as const) {
      const script = packageJson.scripts?.[`test:live:${suite}`] ?? "";
      expect(script).toContain("vp run build");
      expect(script).toContain(`AGENT_DRIVER_LIVE_SUITE=${suite}`);
      expect(script).toContain("tests/driver-artifact-live.test.ts");
    }
    expect(controller).toContain("export class DriverArtifactTestController");
    expect(controller).toContain("crashDriver(): void");
    expect(controller).toContain("disconnectDriver(): void");
    expect(controller).toContain("failHeartbeats(): void");
    expect(controller).toContain("signalDriver(signal: NodeJS.Signals): void");
    expect(liveTest).toContain("const compatibilityScenarios");
    expect(liveTest).toContain("const lifecycleScenarios");
    expect(liveTest).toContain("const controlScenarios");
    expect(liveTest).toContain("for (const runtimeCase of runtimeCases)");
    expect(liveTest).toContain("for (const runtimeCase of lifecycleCases)");
    expect(liveTest).not.toMatch(/from ["']\.\.\/src\/(?:core|runtimes)/);
  });

  test("pins the release OpenCode executable and gates publishing on the packed artifact", () => {
    const packageJson = readDriverPackageJson();
    const containerfile = readText("../Containerfile");
    const releaseWorkflow = readText("../.github/workflows/release.yml");
    const openCodeVersion = packageJson.devDependencies?.["opencode-ai"];
    const packIndex = releaseWorkflow.indexOf("- name: Pack package");
    const liveIndex = releaseWorkflow.indexOf("- name: Test packed driver");
    const imageIndex = releaseWorkflow.indexOf("- name: Build image");

    expect(openCodeVersion).toBe("1.18.4");
    expect(containerfile).toContain(`ARG OPENCODE_VERSION=${openCodeVersion}`);
    expect(releaseWorkflow).toContain("AGENT_DRIVER_LIVE_ARTIFACT: packed/dist/driver.mjs");
    expect(releaseWorkflow).toContain("--strip-components=1");
    expect(releaseWorkflow).toContain("secrets.OPENROUTER_API_KEY");
    expect(packIndex).toBeGreaterThan(-1);
    expect(liveIndex).toBeGreaterThan(packIndex);
    expect(imageIndex).toBeGreaterThan(liveIndex);
  });

  test("keeps the standalone package out of mosoo workspace dependencies", () => {
    const packageJson = readDriverPackageJson();
    const deps = Object.keys(packageJson.dependencies ?? {});
    const tsconfig = readText("../tsconfig.json");
    const typesTsconfig = readText("../tsconfig.types.json");

    expect(deps.filter((dependency) => dependency.startsWith("@mosoo/"))).toEqual([]);
    expect(packageJson.dependencies).not.toHaveProperty("@cfworker/json-schema");
    expect(packageJson.dependencies).toHaveProperty("fflate");
    expect(packageJson.dependencies).toHaveProperty("vestig");
    expect(tsconfig).not.toContain("../../dev/");
    expect(tsconfig).not.toContain('"extends"');
    expect(typesTsconfig).not.toContain("../../dev/");
    expect(typesTsconfig).toContain('"declaration": true');
    expect(typesTsconfig).toContain('"emitDeclarationOnly": true');
    expect(typesTsconfig).toContain('"outDir": "dist/types"');
  });
});
