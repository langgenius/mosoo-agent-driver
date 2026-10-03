import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import images from "../runtime-images.json";

const containerfile = readFileSync(new URL("../Containerfile", import.meta.url), "utf8");
describe("runtime image coverage", () => {
  test("Given all manifest profiles, When CI validates images, Then Pi and every selected runtime execute offline native tools", () => {
    const workflow = readFileSync(new URL("../.github/workflows/pr.yml", import.meta.url), "utf8");
    expect(workflow).toContain("for runtime in all $(node");
    expect(workflow).toContain("image.profile");
    expect(workflow).toContain('--build-arg "RUNTIME=$runtime"');
    expect(workflow).toContain("runtime-image-check.mjs");
    expect(workflow).toContain("environment-package-manager-check.mjs smoke");
    expect(workflow).toContain("--network none");
    expect(workflow).toContain("runtime-image-tools-smoke.mjs");
    expect(workflow).toContain("PI_ACP_ARTIFACT_CONTRACT=1");
    expect(workflow).toContain("tests/pi-acp-artifact.test.ts");
  });

  test("Given main image pins, When adding Pi, Then the pinned base and existing runtimes stay unchanged", () => {
    expect(containerfile).toContain(
      "FROM docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe",
    );
    expect(containerfile).toContain("ARG OPENAI_RUNTIME_VERSION=0.152.0");
    expect(containerfile).toContain("ARG CLAUDE_AGENT_SDK_VERSION=0.3.257");
    expect(containerfile).toContain("ARG OPENCODE_VERSION=1.18.25");
    expect(containerfile).toContain("npm install -g --ignore-scripts");
  });

  // Given a selected image profile, when it is built, then only its pinned
  // runtime is installed; all retains OpenCode alongside the new Pi adapter.
  test("Given Pi v1.0.0, when selecting an image, then the adapter and CLI pins retain the OpenCode fallback", () => {
    expect(images.find((image) => image.runtimeId === "pi-acp")).toMatchObject({
      profile: "pi",
      command: "/usr/local/bin/pi-acp",
      package: "pi-acp",
      version: "0.0.34",
      gitHead: "b0581c9c1d675e634234674484247008b03d69b4",
      additionalPackages: [
        {
          package: "@earendil-works/pi-coding-agent",
          version: "1.0.0",
          gitHead: "a13d35a742c6ef8462812a28fbe1d8c8b7431c32",
          command: "/usr/local/bin/pi",
          probe: ["--version"],
        },
      ],
    });
    expect(containerfile).toContain("ARG PI_ACP_VERSION=0.0.34");
    expect(containerfile).toContain("ARG PI_VERSION=1.0.0");
    expect(containerfile).toContain('if [ "$RUNTIME" = all ] || [ "$RUNTIME" = pi ]; then');
    expect(containerfile).toContain("pi-acp@${PI_ACP_VERSION}");
    expect(containerfile).toContain("@earendil-works/pi-coding-agent@${PI_VERSION}");
    expect(containerfile).toContain("ENV MOSOO_ACP_FALLBACK_COMMAND=opencode");
    expect(containerfile).toContain('ENV MOSOO_ACP_FALLBACK_ARGS=[\\"acp\\",\\"--pure\\"]');
  });

  test("preserves every existing runtime profile and executable probe", () => {
    expect(images.filter((image) => image.runtimeId !== "pi-acp")).toEqual([
      {
        runtimeId: "claude-agent-sdk",
        profile: "claude",
        command: "mosoo-claude-code",
        package: "@anthropic-ai/claude-agent-sdk-linux-x64",
        probe: ["--version"],
      },
      {
        runtimeId: "openai-runtime",
        profile: "openai",
        command: "codex",
        package: "@openai/codex",
        probe: ["app-server", "--help"],
      },
      {
        runtimeId: "acp-fallback",
        profile: "opencode",
        command: "opencode",
        package: "opencode-linux-x64-baseline",
        probe: ["acp", "--help"],
      },
    ]);
    const packages = images.flatMap((image) => [image, ...(image.additionalPackages ?? [])]);
    expect(new Set(packages.map((entry) => entry.command)).size).toBe(packages.length);
    expect(new Set(packages.map((entry) => entry.package)).size).toBe(packages.length);
  });

  test("Given the pinned adapter repair, When dependencies or images install it, Then the same source patch is required", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const patchPath = manifest.patchedDependencies["pi-acp@0.0.34"];
    const patchedSource = readFileSync(
      new URL("../node_modules/pi-acp/dist/index.js", import.meta.url),
    );
    expect(patchPath).toBe("patches/pi-acp@0.0.34.patch");
    expect(readFileSync(new URL(`../${patchPath}`, import.meta.url), "utf8")).toContain(
      'message.stopReason === "length" ? "max_tokens"',
    );
    expect(images.find((image) => image.runtimeId === "pi-acp")?.sourceSha256).toBe(
      createHash("sha256").update(patchedSource).digest("hex"),
    );
    expect(containerfile).toContain(`COPY ${patchPath} /usr/local/libexec/mosoo/pi-acp.patch`);
    expect(containerfile).toContain('git -C "$pi_acp_package" apply');
    expect(containerfile).toContain('"$PI_ACP_SOURCE_SHA256" "$pi_acp_package/dist/index.js"');
    const admittedPaths = readFileSync(new URL("../.containerignore", import.meta.url), "utf8");
    expect(admittedPaths).toContain(`!${patchPath}`);
  });

  test("checks every profile at build time, including real Pi ACP initialization", () => {
    for (const image of images) {
      expect(containerfile).toContain(`|| [ "$RUNTIME" = ${image.profile} ]; then`);
    }
    expect(containerfile).toContain("COPY scripts/pi-acp-image-check.mjs");
    const check = readFileSync(
      new URL("../scripts/runtime-image-check.mjs", import.meta.url),
      "utf8",
    );
    expect(check).toContain("pi-acp-image-check.mjs");
    expect(check).toContain("additionalPackages");
    expect(check).toContain(".version");
  });

  test("runs Pi through the fixed project-resource-disabled launcher", () => {
    const launcher = readFileSync(new URL("../scripts/mosoo-pi", import.meta.url), "utf8");
    expect(launcher).toContain(
      'exec /usr/local/bin/pi --no-extensions --no-approve --no-prompt-templates --no-skills "$@"',
    );
    expect(containerfile).toContain("COPY scripts/mosoo-pi /usr/local/libexec/mosoo/mosoo-pi");
    expect(containerfile).toContain("/usr/local/bin/mosoo-pi");
  });

  test("Given the production build context, When copying Pi scripts, Then the launcher and capability probe are admitted", () => {
    const admittedPaths = readFileSync(
      new URL("../.containerignore", import.meta.url),
      "utf8",
    ).split(/\r?\n/);
    for (const path of ["scripts/mosoo-pi", "scripts/pi-acp-image-check.mjs"]) {
      expect(containerfile).toContain(`COPY ${path} `);
      expect(admittedPaths).toContain(`!${path}`);
    }
  });

  // Given an adapter initialize response, when a pin or advertised capability
  // drifts, then the image probe fails rather than admitting the new contract.
  test("rejects version and capability drift in actual initialize responses", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { verifyPiInitialize } from "./scripts/pi-acp-image-check.mjs";
      const response = {
        jsonrpc: "2.0", id: 1,
        result: {
          protocolVersion: 1, agentInfo: { name: "pi-acp", version: "0.0.34" },
          agentCapabilities: {
            loadSession: true, mcpCapabilities: { http: false, sse: false },
            promptCapabilities: { image: true, audio: false, embeddedContext: false },
            sessionCapabilities: { list: {}, delete: {} },
          },
        },
      };
      verifyPiInitialize(response);
      for (const mutate of [
        r => { r.result.agentInfo.version = "0.0.35"; },
        r => { r.result.protocolVersion = 2; },
        r => { r.result.agentCapabilities.mcpCapabilities.http = true; },
        r => { r.result.agentCapabilities.promptCapabilities.embeddedContext = true; },
        r => { r.result.agentCapabilities.loadSession = false; },
        r => { r.error = { code: -32603 }; },
      ]) {
        const changed = structuredClone(response);
        mutate(changed);
        assert.throws(() => verifyPiInitialize(changed));
      }
    `,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  test("gives every admitted runtime and executable backend an image tested by CI", async () => {
    const { SUPPORTED_DRIVER_RUNTIMES } = await import("../src/protocol/runtime");
    const { AGENT_DRIVER_PROVIDER_REGISTRY } = await import("../src/runtimes/provider-registry");
    const runtimeIds = images.map((image) => image.runtimeId).toSorted();
    expect(runtimeIds).toEqual([...SUPPORTED_DRIVER_RUNTIMES].toSorted());
    expect(runtimeIds).toEqual(
      AGENT_DRIVER_PROVIDER_REGISTRY.list()
        .map((provider) => provider.runtime)
        .toSorted(),
    );
    expect(new Set(images.map((image) => image.profile)).size).toBe(images.length);
    expect(images.some((image) => image.profile === "all")).toBe(false);
  });
});
