import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface DriverPackageJson {
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, { readonly types?: string } | string>;
}

const FORBIDDEN_TARBALL_ENTRIES = [
  "package/src/cma-http.ts",
  "package/src/cma-sdk.ts",
  "package/dist/types/cma-http.d.ts",
  "package/dist/types/cma-sdk.d.ts",
] as const;

function fail(message: string): never {
  throw new Error(`Driver package smoke failed: ${message}`);
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    fail(`${command} could not start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} exited with ${String(result.status)}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return result.stdout;
}

function readPackageJson(packageRoot: string): DriverPackageJson {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as DriverPackageJson;
}

function expectedTarballEntries(packageJson: DriverPackageJson): string[] {
  const typeEntries = Object.values(packageJson.exports ?? {}).flatMap((target) => {
    if (typeof target === "string" || target.types === undefined) {
      return [];
    }

    return [`package/${target.types.replace(/^\.\//u, "")}`];
  });
  const binEntries = Object.values(packageJson.bin ?? {}).map(
    (target) => `package/${target.replace(/^\.\//u, "")}`,
  );

  return [
    "package/README.md",
    "package/LICENSE.txt",
    "package/assets/logo.svg",
    ...binEntries,
    ...typeEntries,
  ];
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "agent-driver-package-smoke-"));

try {
  rmSync(join(packageRoot, "dist"), { force: true, recursive: true });
  mkdirSync(join(packageRoot, "dist/types"), { recursive: true });
  writeFileSync(
    join(packageRoot, "dist/types/cma-http.d.ts"),
    "export declare const staleCmaHttp: true;\n",
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "dist/types/cma-sdk.d.ts"),
    "export declare const staleCmaSdk: true;\n",
    "utf8",
  );
  run("npm", ["pack", "--pack-destination", tempRoot], packageRoot);

  const tarballs = readdirSync(tempRoot).filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    fail(`expected one npm tarball, found ${String(tarballs.length)}.`);
  }

  const tarball = join(tempRoot, tarballs[0] ?? fail("npm tarball name is missing."));
  const tarEntries = new Set(run("tar", ["-tzf", tarball], tempRoot).trim().split("\n"));
  const packageJson = readPackageJson(packageRoot);

  for (const expected of expectedTarballEntries(packageJson)) {
    if (!tarEntries.has(expected)) {
      fail(`tarball is missing ${expected}.`);
    }
  }

  for (const forbidden of FORBIDDEN_TARBALL_ENTRIES) {
    if (tarEntries.has(forbidden)) {
      fail(`tarball contains stale removed entry ${forbidden}.`);
    }
  }

  writeFileSync(
    join(tempRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2),
    "utf8",
  );
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], tempRoot);

  writeFileSync(
    join(tempRoot, "import-smoke.ts"),
    [
      'import { AgentDriverKernelCore } from "agent-driver";',
      'import { DRIVER_PROTOCOL_VERSION } from "agent-driver/boot";',
      'import { parseDriverEventEnvelope } from "agent-driver/events";',
      'import { createCmaHttpHandler, createCmaMemoryStore, createCmaSdkClient } from "agent-driver/experimental/cma";',
      'import { parseDriverHelloInput } from "agent-driver/orpc";',
      'import { SANDBOX_MEMORY_PATH } from "agent-driver/paths";',
      'import { AGENT_DRIVER_PROVIDER_CONTRACTS, isSupportedDriverRuntime } from "agent-driver/runtime";',
      "",
      "if (",
      '  typeof AgentDriverKernelCore !== "function" ||',
      '  typeof createCmaMemoryStore !== "function" ||',
      '  typeof createCmaHttpHandler !== "function" ||',
      '  typeof createCmaSdkClient !== "function" ||',
      '  typeof parseDriverEventEnvelope !== "function" ||',
      '  typeof parseDriverHelloInput !== "function" ||',
      "  DRIVER_PROTOCOL_VERSION !== 1 ||",
      '  SANDBOX_MEMORY_PATH !== "/workspace/memory" ||',
      "  AGENT_DRIVER_PROVIDER_CONTRACTS.length !== 3 ||",
      '  !isSupportedDriverRuntime("openai-runtime")',
      ") {",
      '  throw new Error("agent-driver package import smoke failed.");',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  run("bun", ["import-smoke.ts"], tempRoot);

  writeFileSync(
    join(tempRoot, "type-smoke.ts"),
    [
      'import type { AgentDriverKernel, DriverStartInput } from "agent-driver";',
      'import type { DriverBootPayload } from "agent-driver/boot";',
      'import type { CmaHttpHandler, CmaSdkClient } from "agent-driver/experimental/cma";',
      'import type { AgentDriverProviderContract } from "agent-driver/runtime";',
      "",
      "declare const kernel: AgentDriverKernel;",
      "declare const start: DriverStartInput;",
      "declare const boot: DriverBootPayload;",
      "declare const handler: CmaHttpHandler;",
      "declare const client: CmaSdkClient;",
      "declare const provider: AgentDriverProviderContract;",
      "void [kernel, start, boot, handler, client, provider];",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(tempRoot, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ESNext",
        },
        include: ["type-smoke.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  run(join(packageRoot, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], tempRoot);

  const binPath = join(tempRoot, "node_modules/.bin/agent-driver");
  if (!existsSync(binPath)) {
    fail("installed package is missing the agent-driver bin link.");
  }

  const binResult = spawnSync(binPath, ["--package-smoke"], {
    cwd: tempRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MOSOO_DRIVER_BOOT_PAYLOAD: "",
      MOSOO_DRIVER_BOOT_PAYLOAD_FILE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });

  if (binResult.error || binResult.status === null || binResult.status === 0) {
    fail("installed agent-driver bin did not execute and fail fast without a boot payload.");
  }

  const binOutput = `${binResult.stdout}\n${binResult.stderr}`;
  if (!binOutput.includes("Driver boot payload is empty.")) {
    fail(`installed agent-driver bin failed for an unexpected reason:\n${binOutput}`);
  }

  console.log("Driver npm tarball smoke passed.");
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}
