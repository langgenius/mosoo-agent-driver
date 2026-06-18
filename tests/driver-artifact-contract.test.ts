import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { AGENT_DRIVER_TESTING_FIXTURE_PATHS } from "../src/testing";

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
      expect.arrayContaining([
        "dist",
        "src",
        "tests/fixtures",
        "Dockerfile",
        ".dockerignore",
        "README.md",
      ]),
    );
  });

  test("keeps library and process entries separate", () => {
    const packageJson = readDriverPackageJson();

    expect(packageJson.type).toBe("module");
    expect(packageJson.exports).toEqual({
      ".": {
        types: "./dist/types/index.d.ts",
        default: "./src/index.ts",
      },
      "./bin/driver": {
        types: "./dist/types/bin/driver.d.ts",
        default: "./src/bin/driver.ts",
      },
      "./boot": {
        types: "./dist/types/boot.d.ts",
        default: "./src/boot.ts",
      },
      "./runtime": {
        types: "./dist/types/runtime.d.ts",
        default: "./src/runtime.ts",
      },
      "./paths": {
        types: "./dist/types/paths.d.ts",
        default: "./src/paths.ts",
      },
      "./events": {
        types: "./dist/types/events.d.ts",
        default: "./src/events.ts",
      },
      "./orpc": {
        types: "./dist/types/orpc.d.ts",
        default: "./src/orpc.ts",
      },
      "./cma-http": {
        types: "./dist/types/cma-http.d.ts",
        default: "./src/cma-http.ts",
      },
      "./cma-sdk": {
        types: "./dist/types/cma-sdk.d.ts",
        default: "./src/cma-sdk.ts",
      },
      "./testing": {
        types: "./dist/types/testing.d.ts",
        default: "./src/testing.ts",
      },
    });
  });

  test("publishes CMA and fixture subpath entries", () => {
    const bootEntry = readText("../src/boot.ts");
    const cmaHttpEntry = readText("../src/cma-http.ts");
    const cmaSdkEntry = readText("../src/cma-sdk.ts");
    const eventsEntry = readText("../src/events.ts");
    const orpcEntry = readText("../src/orpc.ts");
    const pathsEntry = readText("../src/paths.ts");
    const runtimeEntry = readText("../src/runtime.ts");
    const testingEntry = readText("../src/testing.ts");

    expect(bootEntry).toBe('export * from "./protocol/boot";\n');
    expect(cmaHttpEntry).toBe('export * from "./surfaces/cma-http";\n');
    expect(cmaSdkEntry).toBe('export * from "./surfaces/cma-sdk";\n');
    expect(eventsEntry).toBe('export * from "./protocol/events";\n');
    expect(orpcEntry).toBe('export * from "./protocol/orpc";\n');
    expect(pathsEntry).toBe('export * from "./protocol/paths";\n');
    expect(runtimeEntry).toBe('export * from "./protocol/runtime";\n');
    expect(testingEntry).toContain("AGENT_DRIVER_TESTING_FIXTURES");
    expect(testingEntry).toContain("AGENT_DRIVER_TESTING_FIXTURE_PATHS");
    expect(testingEntry).toContain("tests/fixtures/cma/inbound/user-message.json");
    expect(testingEntry).toContain(
      "tests/fixtures/providers/openai-app-server/cases/turn-plan-updated.json",
    );
  });

  test("keeps every public testing fixture path packaged", () => {
    expect(AGENT_DRIVER_TESTING_FIXTURE_PATHS.length).toBe(41);

    for (const fixturePath of AGENT_DRIVER_TESTING_FIXTURE_PATHS) {
      expect(existsSync(new URL(`../${fixturePath}`, import.meta.url))).toBe(true);
    }
  });

  test("keeps the root library entry free of process boot and transport internals", () => {
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

  test("builds and packages the process runner artifact", () => {
    const packageJson = readDriverPackageJson();
    const buildScript = packageJson.scripts?.["build"] ?? "";
    const buildTypesScript = packageJson.scripts?.["build:types"] ?? "";
    const dockerBuildScript = packageJson.scripts?.["docker:build"] ?? "";
    const dockerignore = readText("../.dockerignore");
    const dockerfile = readText("../Dockerfile");
    const processEntry = readText("../src/bin/driver.ts");

    expect(processEntry.startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(buildTypesScript).toBe("vp exec tsc -p tsconfig.types.json");
    expect(buildScript).toContain("bun run build:types");
    expect(buildScript).toContain("src/bin/driver.ts");
    expect(buildScript).toContain("dist/driver.mjs");
    expect(buildScript).not.toContain("src/index.ts");
    expect(dockerfile).toContain("COPY dist/driver.mjs /usr/local/bin/agent-driver");
    expect(dockerfile).toContain("RUN chmod +x /usr/local/bin/agent-driver");
    expect(dockerfile).toContain("EXPOSE 20000-59999");
    expect(dockerfile).toContain("ARG OPENCODE_VERSION=1.17.7");
    expect(dockerfile).toContain("opencode-ai@${OPENCODE_VERSION}");
    expect(dockerfile).toContain("opencode acp --help");
    expect(dockerfile).toContain("ENV MOSOO_ACP_FALLBACK_COMMAND=opencode");
    expect(dockerfile).toContain('ENV MOSOO_ACP_FALLBACK_ARGS=[\\"acp\\",\\"--pure\\"]');
    expect(dockerignore).toContain("!dist/driver.mjs");
    expect(dockerBuildScript).toBe("bun run build && docker build -t agent-driver:local .");
    expect(buildScript).not.toContain("vp run");
    expect(dockerBuildScript).not.toContain("vp run");
  });

  test("keeps standalone package tooling out of the Mosoo workspace", () => {
    const gitignore = readText("../.gitignore");
    const tsconfig = readText("../tsconfig.json");
    const typesTsconfig = readText("../tsconfig.types.json");

    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain("coverage/");
    expect(tsconfig).not.toContain("../../dev/");
    expect(tsconfig).not.toContain('"extends"');
    expect(typesTsconfig).not.toContain("../../dev/");
    expect(typesTsconfig).toContain('"declaration": true');
    expect(typesTsconfig).toContain('"emitDeclarationOnly": true');
    expect(typesTsconfig).toContain('"outDir": "dist/types"');
  });

  test("documents the standalone release boundary", () => {
    const readme = readText("../README.md");

    expect(readme).toContain("The core product is the **Driver Kernel**");
    expect(readme).toContain("CMA (the Anthropic Managed Agents compatibility surface)");
    expect(readme).toContain("Every public entry has a matching declaration file");
    expect(readme).toContain("agent-driver/boot");
    expect(readme).toContain("agent-driver/events");
    expect(readme).toContain("agent-driver/orpc");
    expect(readme).toContain("agent-driver/paths");
    expect(readme).toContain("agent-driver/runtime");
    expect(readme).toContain("The library root is safe to import");
    expect(readme).toContain("must not depend on Mosoo workspace packages at runtime");
    expect(readme).toContain("bun run lint");
    expect(readme).toContain("bun run test");
    expect(readme).toContain("bun run build");
    expect(readme).toContain("bun run docker:build");
    expect(readme).toContain("live provider smoke tests are gated by environment credentials");
  });

  test("keeps local async utilities out of workspace dependencies", () => {
    const packageJson = readDriverPackageJson();

    expect(packageJson.dependencies).not.toHaveProperty("@mosoo/effects");
  });

  test("keeps logger utilities out of workspace dependencies", () => {
    const packageJson = readDriverPackageJson();

    expect(packageJson.dependencies).not.toHaveProperty("@mosoo/observability");
    expect(packageJson.dependencies).toHaveProperty("vestig");
  });

  test("keeps skill archive utilities out of workspace dependencies", () => {
    const packageJson = readDriverPackageJson();

    expect(packageJson.dependencies).not.toHaveProperty("@mosoo/skill-package");
    expect(packageJson.dependencies).toHaveProperty("fflate");
  });

  test("keeps runtime event ingress out of workspace dependencies", () => {
    const packageJson = readDriverPackageJson();

    expect(packageJson.dependencies).not.toHaveProperty("@mosoo/runtime-events");
  });

  test("keeps runtime command contracts out of workspace dependencies", () => {
    const packageJson = readDriverPackageJson();

    expect(packageJson.dependencies).not.toHaveProperty("@mosoo/contracts");
  });

  test("keeps driver protocol contracts out of workspace dependencies", () => {
    const packageJson = readDriverPackageJson();

    expect(packageJson.dependencies).not.toHaveProperty("@mosoo/driver-protocol");
  });

  test("keeps driver ID admission out of workspace dependencies", () => {
    const packageJson = readDriverPackageJson();

    expect(packageJson.dependencies).not.toHaveProperty("@mosoo/id");
  });

  test("keeps driver event protocol local to the driver", () => {
    const eventProtocol = readText("../src/protocol/events/index.ts");

    expect(eventProtocol).toContain("../../runtime-events");
    expect(eventProtocol).not.toContain("@mosoo/driver-protocol");
  });

  test("keeps sandbox path helpers local to the driver", () => {
    const pathProtocol = readText("../src/protocol/paths/index.ts");

    expect(pathProtocol).toContain("SANDBOX_SESSION_ROOT");
    expect(pathProtocol).not.toContain("@mosoo/driver-protocol");
  });

  test("keeps boot and transport protocol local to the driver", () => {
    const bootProtocol = readText("../src/protocol/boot/index.ts");
    const orpcProtocol = readText("../src/protocol/orpc/index.ts");

    expect(bootProtocol).toContain("parseDriverBootPayloadJson");
    expect(bootProtocol).not.toContain("@mosoo/driver-protocol");
    expect(orpcProtocol).toContain("DriverRuntimeClient");
    expect(orpcProtocol).toContain("runId");
    expect(orpcProtocol).not.toContain("sessionRunId");
    expect(orpcProtocol).not.toContain("@mosoo/driver-protocol");
  });

  test("keeps host snapshot parsing behind the boot host snapshot boundary", () => {
    const bootProtocol = readText("../src/protocol/boot/index.ts");
    const hostSnapshot = readText("../src/protocol/boot/host-snapshot.ts");

    expect(bootProtocol).toContain("./host-snapshot");
    expect(bootProtocol).not.toContain("interface DriverOrigin");
    expect(bootProtocol).not.toContain("function readOrigin");
    expect(hostSnapshot).toContain("interface DriverOrigin");
    expect(hostSnapshot).toContain("readExecutionSessionContext");
  });

  test("keeps kernel start input separate from the boot transport envelope", () => {
    const kernel = readText("../src/core/agent-driver-kernel.ts");
    const executionInput = readText("../src/protocol/execution.ts");
    const hostIntegration = readText("../src/protocol/host-integration.ts");
    const hostPorts = readText("../src/host-ports/index.ts");
    const providerRegistry = readText("../src/runtimes/provider-registry.ts");
    const startInput = readText("../src/protocol/start.ts");

    expect(startInput).toContain("interface DriverStartInput");
    expect(startInput).toContain("createDriverStartInputFromBootPayload");
    expect(startInput).toContain("DriverExecutionInput");
    expect(startInput).not.toContain("bootToken");
    expect(startInput).not.toContain("driverControlPort");
    expect(startInput).not.toContain("heartbeatIntervalMs");
    expect(startInput).not.toContain("traceparent");
    expect(executionInput).toContain("interface DriverExecutionInput");
    expect(executionInput).toContain("sharedRootPath");
    expect(executionInput).not.toContain("mountAliases");
    expect(executionInput).not.toContain("readonly host");
    expect(hostIntegration).toContain("interface DriverHostIntegrationSnapshot");
    expect(hostIntegration).toContain("createDriverHostIntegrationSnapshotFromBootExecution");
    expect(hostPorts).toContain("AgentDriverHostIntegrationPort");
    expect(kernel).toContain("AgentDriverKernelStartInput = DriverStartInput");
    expect(kernel).not.toContain("DriverBootPayload");
    expect(providerRegistry).toContain("getByStartInput");
    expect(providerRegistry).not.toContain("DriverBootPayload");
    expect(providerRegistry).not.toContain("getByPayload");
  });

  test("keeps driver ID admission local to the driver", () => {
    const idProtocol = readText("../src/protocol/id/index.ts");

    expect(idProtocol).toContain("DRIVER_ID_PATTERN");
    expect(idProtocol).not.toContain("@mosoo/id");
  });

  test("keeps host snapshot ID aliases out of generic driver ID admission", () => {
    const idProtocol = readText("../src/protocol/id/index.ts");
    const bootHostIds = readText("../src/protocol/boot/host-ids.ts");

    expect(idProtocol).toContain("RunId");
    expect(idProtocol).toContain("MessageId");
    expect(idProtocol).not.toContain("AgentId");
    expect(idProtocol).not.toContain("SandboxId");
    expect(bootHostIds).toContain("AgentId");
    expect(bootHostIds).toContain("SandboxId");
  });
});
