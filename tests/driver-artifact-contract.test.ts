import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type DriverPackageExportTarget =
  | string
  | {
      readonly default?: string;
      readonly types?: string;
    };

interface DriverPackageJson {
  readonly bin?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly description?: string;
  readonly exports?: Record<string, DriverPackageExportTarget>;
  readonly files?: readonly string[];
  readonly license?: string;
  readonly name?: string;
  readonly packageManager?: string;
  readonly private?: boolean;
  readonly scripts?: Record<string, string>;
  readonly types?: string;
  readonly type?: string;
  readonly version?: string;
}

const PUBLIC_EXPORTS = [
  ".",
  "./bin/driver",
  "./boot",
  "./cma-http",
  "./cma-sdk",
  "./events",
  "./orpc",
  "./paths",
  "./runtime",
] as const;

function readText(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function readDriverPackageJson(): DriverPackageJson {
  return JSON.parse(readText("../package.json")) as DriverPackageJson;
}

describe("driver artifact contract", () => {
  test("uses the independent agent-driver package identity", () => {
    const packageJson = readDriverPackageJson();

    expect(packageJson.name).toBe("agent-driver");
    expect(packageJson.private).toBe(false);
    expect(packageJson.version).toBe("0.1.0");
    expect(packageJson.description).toContain("Agent Driver");
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.packageManager).toBe("bun@1.3.14");
    expect(packageJson.bin).toEqual({
      "agent-driver": "./dist/driver.mjs",
    });
    expect(packageJson.types).toBe("./dist/types/index.d.ts");
    expect(packageJson.files).toEqual(
      expect.arrayContaining(["dist", "src", "Dockerfile", ".dockerignore", "README.md"]),
    );
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
    expect(packageJson.exports?.["./bin/driver"]).toEqual({
      default: "./src/bin/driver.ts",
      types: "./dist/types/bin/driver.d.ts",
    });
  });

  test("keeps the root library entry free of boot and transport internals", () => {
    const publicApi = readText("../src/index.ts");

    expect(publicApi).toContain("./core/agent-driver-kernel");
    expect(publicApi).toContain("./runtimes/provider-registry");
    expect(publicApi).toContain("./protocol/runtime");
    expect(publicApi).not.toContain("./core/driver-process");
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
    const dockerBuildScript = packageJson.scripts?.["docker:build"] ?? "";
    const dockerignore = readText("../.dockerignore");
    const dockerfile = readText("../Dockerfile");
    const processEntry = readText("../src/bin/driver.ts");

    expect(processEntry.startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(buildScript).toContain("src/bin/driver.ts");
    expect(buildScript).toContain("dist/driver.mjs");
    expect(buildScript).not.toContain("src/index.ts");
    expect(dockerfile).toContain("COPY dist/driver.mjs /usr/local/bin/agent-driver");
    expect(dockerfile).toContain("RUN chmod +x /usr/local/bin/agent-driver");
    expect(dockerfile).toContain("ENV MOSOO_ACP_FALLBACK_COMMAND=opencode");
    expect(dockerignore).toContain("!dist/driver.mjs");
    expect(dockerBuildScript).toBe("bun run build && docker build -t agent-driver:local .");
  });

  test("keeps the standalone package out of Mosoo workspace dependencies", () => {
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
