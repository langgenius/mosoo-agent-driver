import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AGENT_DRIVER_VERSION } from "../src/core/version";
import viteConfig from "../vite.config";

interface DriverPackageExportTarget {
  readonly default?: string;
  readonly types?: string;
}

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

interface EnvironmentPackageManagerManifest {
  readonly managers?: readonly string[];
  readonly schemaVersion?: number;
}

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
}

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly concurrency?: {
    readonly group?: string;
    readonly queue?: string;
  };
  readonly jobs?: Record<string, WorkflowJob>;
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

function readEnvironmentPackageManagerManifest(): EnvironmentPackageManagerManifest {
  return JSON.parse(
    readText("../environment-package-managers.json"),
  ) as EnvironmentPackageManagerManifest;
}

function readWorkflow(path: string): Workflow {
  return Bun.YAML.parse(readText(path)) as Workflow;
}

function readContainerArguments(): Record<string, string> {
  return Object.fromEntries(
    [...readText("../Containerfile").matchAll(/^ARG ([A-Z_]+)=(.+)$/gmu)].map(([, name, value]) => [
      name,
      value,
    ]),
  );
}

function workflowJob(workflow: Workflow, id: string): WorkflowJob {
  const job = workflow.jobs?.[id];
  if (job === undefined) {
    throw new Error(`Missing workflow job ${id}.`);
  }
  return job;
}

function workflowStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`Missing workflow step ${name}.`);
  }
  return step;
}

describe("driver artifact contract", () => {
  test("uses the public mosoo package identity", () => {
    const packageJson = readDriverPackageJson();

    expect(packageJson.name).toBe("@mosoo/agent-driver");
    expect(packageJson.private).toBe(false);
    expect(packageJson.version).toBe(AGENT_DRIVER_VERSION);
    expect(packageJson.description).toContain("Agent Driver");
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.packageManager).toBe("bun@1.4.0");
    expect(packageJson.engines).toEqual({ bun: ">=1.4.0" });
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
    expect(packageJson.files).toEqual(["dist", "src", "!src/runtimes/openai/generated", "assets"]);
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

  test("builds declarations for exactly the public package entries", () => {
    const packageJson = readDriverPackageJson();
    const targets = Object.values(packageJson.exports ?? {});
    const sources = [
      ...new Bun.Glob("src/*.ts").scanSync({
        cwd: new URL("../", import.meta.url).pathname,
      }),
      "src/contract/index.ts",
    ].toSorted();

    expect(viteConfig.pack).toEqual({
      dts: { emitDtsOnly: true },
      entry: ["src/*.ts", "src/contract/index.ts"],
      fixedExtension: false,
      outDir: "dist/types",
      platform: "neutral",
    });
    expect(targets.map(({ default: source }) => source?.slice(2)).toSorted()).toEqual(sources);
    for (const { default: source, types } of targets) {
      expect(source).toMatch(/^\.\/src\/.+\.ts$/);
      expect(types).toBe(source?.replace("./src/", "./dist/types/").replace(/\.ts$/, ".d.ts"));
      expect(source).not.toContain("/generated");
    }
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

  test("pins container runtimes to package dependency versions", () => {
    const packageJson = readDriverPackageJson();
    const containerfile = readText("../Containerfile");
    const versions = {
      BUN_VERSION: packageJson.packageManager?.replace("bun@", ""),
      CLAUDE_AGENT_SDK_VERSION: packageJson.dependencies?.["@anthropic-ai/claude-agent-sdk"],
      OPENAI_RUNTIME_VERSION: packageJson.devDependencies?.["@openai/codex"],
      OPENCODE_VERSION: packageJson.devDependencies?.["opencode-ai"],
    };

    expect(readContainerArguments()).toMatchObject(versions);
    for (const version of Object.values(versions)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    for (const marker of [
      'test "$(bun --version)" = "$BUN_VERSION"',
      "@anthropic-ai/claude-agent-sdk-linux-x64@${CLAUDE_AGENT_SDK_VERSION}",
      "opencode-linux-x64-baseline@${OPENCODE_VERSION}",
    ])
      expect(containerfile).toContain(marker);

    const openAiVersion = versions.OPENAI_RUNTIME_VERSION;
    expect(readText("../src/runtimes/openai/generated/README.md")).toContain(
      `version \`${openAiVersion}\``,
    );
    expect(readText("../src/runtimes/openai/generated-json-schema/README.md")).toContain(
      `@openai/codex@${openAiVersion}`,
    );
  });

  test("builds and tests the packed process artifact", () => {
    const scripts = readDriverPackageJson().scripts ?? {};
    const containerfile = readText("../Containerfile");

    expect(scripts["build"]).toContain("src/bin/driver.ts");
    expect(scripts["build"]).toContain("dist/driver.mjs");
    expect(scripts["prepack"]).toBe("vp run build");
    expect(containerfile).toContain("COPY dist/driver.mjs /usr/local/bin/agent-driver");
    expect(scripts["test:live"]).toBe("vp run build && vp run test:live:artifact");
    expect(scripts["test:live:artifact"]).toContain("tests/driver-artifact-mcp.test.ts");

    for (const suite of ["anthropic", "openai", "opencode"] as const) {
      expect(scripts[`test:live:${suite}`]).toContain("vp run build");
      expect(scripts[`test:live:${suite}`]).toContain(`AGENT_DRIVER_LIVE_SUITE=${suite}`);
      expect(scripts[`test:live:${suite}`]).toContain("tests/driver-artifact-live.test.ts");
    }
  });

  test("keeps release publication ordered, monotonic, and verifiable", () => {
    const prWorkflow = readWorkflow("../.github/workflows/pr.yml");
    const releaseWorkflowText = readText("../.github/workflows/release.yml");
    const releaseWorkflow = readWorkflow("../.github/workflows/release.yml");
    const verifyJob = workflowJob(releaseWorkflow, "verify");
    const buildJob = workflowJob(releaseWorkflow, "build");
    const imageJob = workflowJob(releaseWorkflow, "publish-versioned-image");
    const npmJob = workflowJob(releaseWorkflow, "publish-npm");
    const latestJob = workflowJob(releaseWorkflow, "publish-latest-image");
    const verifyRun = workflowStep(verifyJob, "Verify release tag").run ?? "";
    const imageRun = workflowStep(imageJob, "Publish versioned image").run ?? "";
    const npmRun = workflowStep(npmJob, "Publish package").run ?? "";
    const buildRun =
      buildJob.steps?.flatMap(({ run }) => (run === undefined ? [] : [run])).join("\n") ?? "";
    const latestRun =
      latestJob.steps?.flatMap(({ run }) => (run === undefined ? [] : [run])).join("\n") ?? "";
    const actionUses = [prWorkflow, releaseWorkflow].flatMap((workflow) =>
      Object.values(workflow.jobs ?? {}).flatMap((job) =>
        (job.steps ?? []).flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
      ),
    );

    expect(releaseWorkflow.concurrency).toEqual({ group: "release", queue: "max" });
    expect({
      build: buildJob.needs,
      latest: latestJob.needs,
      npm: npmJob.needs,
      versionedImage: imageJob.needs,
    }).toEqual({
      build: "verify",
      latest: ["publish-versioned-image", "publish-npm"],
      npm: ["build", "publish-versioned-image"],
      versionedImage: "build",
    });
    expect(latestJob.if).toBe("needs.publish-npm.outputs.promote_latest == 'true'");
    for (const marker of [
      'version="$(node -p "require(\'./package.json\').version")"',
      'if [[ "${tag}" != "v${version}" ]]',
      'git merge-base --is-ancestor "${GITHUB_SHA}" origin/main',
    ])
      expect(verifyRun).toContain(marker);
    for (const marker of [
      "npm pack --ignore-scripts",
      "declarations=(packed/dist/types/**/*.d.ts)",
      "bun test tests/driver-artifact-mcp.test.ts",
      "buildah build",
      "podman run --pull=never --rm",
    ])
      expect(buildRun).toContain(marker);
    for (const marker of [
      "remote_digest=",
      'if [[ "$remote_digest" != "$EXPECTED_DIGEST" ]]',
      "skopeo copy --preserve-digests",
      "gh attestation verify",
    ])
      expect(imageRun).toContain(marker);
    for (const marker of [
      "remote_integrity=",
      'npm view "$package_name@>$VERSION"',
      'npm publish "$tarball" --ignore-scripts --provenance',
    ])
      expect(npmRun).toContain(marker);
    for (const marker of [
      'npm view "$PACKAGE_NAME" dist-tags.latest',
      'npm view "$PACKAGE_NAME@>$VERSION"',
      'skopeo copy --preserve-digests "docker://$IMAGE@$DIGEST" "docker://$IMAGE:latest"',
    ])
      expect(latestRun).toContain(marker);
    expect(releaseWorkflowText).not.toContain("OPENROUTER_API_KEY");
    expect(releaseWorkflowText).not.toContain("test:live:artifact");
    expect(actionUses.length).toBeGreaterThan(0);
    for (const uses of actionUses) {
      expect(uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  test("declares writable Environment package managers", () => {
    const manifest = readEnvironmentPackageManagerManifest();

    expect(manifest).toEqual({
      managers: ["npm", "pip"],
      schemaVersion: 1,
    });
  });

  test("keeps the standalone package independent of Mosoo workspace packages", () => {
    const packageJson = readDriverPackageJson();
    const deps = Object.keys(packageJson.dependencies ?? {});

    expect(deps.filter((dependency) => dependency.startsWith("@mosoo/"))).toEqual([]);
  });
});
