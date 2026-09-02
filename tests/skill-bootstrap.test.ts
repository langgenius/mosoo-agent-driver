import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";

import type { DriverExecutionInput } from "../src/protocol/execution";
import type { AgentDriverMaterializedSkill } from "../src/host-ports";
import { closeFileHandles } from "../src/runtimes/atomic-file";
import {
  buildNativeRuntimeSystemPrompt,
  writeNativeRuntimeSystemPrompt,
  writeSkillBootstrapArtifacts,
} from "../src/runtimes/skill-bootstrap";
import { bootPayload } from "./driver-runtime-boundary-fixtures";

function createExecution(root: string, systemPrompt: string): DriverExecutionInput {
  return {
    ...bootPayload.execution,
    session: {
      ...bootPayload.execution.session,
      cwd: root,
      homePath: root,
      sharedRootPath: root,
    },
    skillCatalog: [],
    skills: [],
    systemPrompt,
  };
}

function createCatalogExecution(root: string): DriverExecutionInput {
  return {
    ...createExecution(root, ""),
    skillCatalog: [
      {
        frontmatter: {
          author: null,
          description: "Review code changes.",
          version: null,
        },
        mountPath: join(root, ".mosoo", "skill", "review"),
        resolutionMode: "explicit",
        skillId: "skill-1" as DriverExecutionInput["skillCatalog"][number]["skillId"],
        skillName: "review",
      },
    ],
  };
}

function createMaterializedSkill(root: string): AgentDriverMaterializedSkill {
  const mountPath = join(root, ".mosoo", "skill", "review");

  return {
    mountPath,
    skillId: "skill-1",
    skillMarkdownPath: join(mountPath, "SKILL.md"),
    skillName: "review",
    snapshotId: "snapshot-1",
  };
}

async function interceptAtomicTemporarySync(
  probePath: string,
  directoryPath: string,
  temporaryPrefix: string,
  action: () => Promise<void>,
): Promise<{ didRun: () => boolean; restore: () => void }> {
  const probe = await open(probePath, "r");
  const prototype = Object.getPrototypeOf(probe) as {
    sync(this: FileHandle): Promise<void>;
  };
  const nativeSync = prototype.sync;
  let ran = false;
  await probe.close();

  prototype.sync = async function (this: FileHandle) {
    await nativeSync.call(this);
    if (ran) {
      return;
    }
    let names: string[];
    try {
      names = await readdir(directoryPath);
    } catch {
      // The watched directory may not exist until the writer creates it.
      return;
    }
    if (names.some((name) => name.startsWith(temporaryPrefix))) {
      ran = true;
      await action();
    }
  };

  return {
    didRun: () => ran,
    restore: () => {
      prototype.sync = nativeSync;
    },
  };
}

describe("skill bootstrap", () => {
  test("attempts every owned handle close when an earlier close fails", async () => {
    const calls: string[] = [];
    const first = {
      async close() {
        calls.push("first");
        throw new Error("first close failed");
      },
    } as unknown as FileHandle;
    const second = {
      async close() {
        calls.push("second");
      },
    } as unknown as FileHandle;

    const failures = await closeFileHandles([first, second]);

    expect(calls).toEqual(["first", "second"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ message: "first close failed" });
  });

  test("preserves bootstrap control sentences inside the profile prompt", () => {
    const execution = createExecution(
      "/workspace",
      "Keep this literal.\nReply with exactly READY.",
    );

    expect(buildNativeRuntimeSystemPrompt(execution)).toBe(
      [
        "Runtime context for this session.",
        "",
        "Agent profile prompt:",
        "Keep this literal.",
        "Reply with exactly READY.",
      ].join("\n"),
    );
  });

  test("atomically replaces native instructions with mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
    const path = join(root, "runtime-instructions.md");
    await writeFile(path, "old instructions\n", "utf8");
    await chmod(path, 0o644);
    const oldFile = await open(path, "r");

    try {
      const execution = createExecution(root, "new instructions");

      await expect(
        writeNativeRuntimeSystemPrompt(execution, [], new AbortController().signal),
      ).resolves.toBe(path);
      expect(await readFile(path, "utf8")).toBe(`${buildNativeRuntimeSystemPrompt(execution)}\n`);
      expect(await oldFile.readFile({ encoding: "utf8" })).toBe("old instructions\n");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(root)).toEqual(["runtime-instructions.md"]);
    } finally {
      await oldFile.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not replace native instructions after startup cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
    const path = join(root, "runtime-instructions.md");
    await writeFile(path, "previous instructions\n", "utf8");
    const controller = new AbortController();
    controller.abort(new Error("startup cancelled"));

    try {
      await expect(
        writeNativeRuntimeSystemPrompt(
          createExecution(root, "new instructions"),
          [],
          controller.signal,
        ),
      ).rejects.toThrow("startup cancelled");
      await expect(readFile(path, "utf8")).resolves.toBe("previous instructions\n");
      await expect(readdir(root)).resolves.toEqual(["runtime-instructions.md"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("atomically replaces a native instructions symlink without changing its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-outside-"));
    const path = join(root, "runtime-instructions.md");
    const target = join(outsideRoot, "target.md");
    await writeFile(target, "outside contents\n", "utf8");
    await symlink(target, path, "file");

    try {
      await expect(
        writeNativeRuntimeSystemPrompt(
          createExecution(root, "new instructions"),
          [],
          new AbortController().signal,
        ),
      ).resolves.toBe(path);
      expect(await readFile(target, "utf8")).toBe("outside contents\n");
      await expect(readlink(path)).rejects.toThrow();
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(root)).toEqual(["runtime-instructions.md"]);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("rejects a native instructions symlink ancestor without writing through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-outside-"));
    const homePath = join(root, "linked-home", "runtime");
    await symlink(outsideRoot, join(root, "linked-home"), "dir");
    const baseExecution = createExecution(root, "new instructions");
    const execution = {
      ...baseExecution,
      session: { ...baseExecution.session, homePath },
    };

    try {
      await expect(
        writeNativeRuntimeSystemPrompt(execution, [], new AbortController().signal),
      ).rejects.toThrow("must be a real directory");
      await expect(readdir(outsideRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("rejects a native home directory replaced while instructions are written", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-outside-"));
    const homePath = join(root, "home");
    const detachedHome = join(root, "detached-home");
    await mkdir(homePath);
    await writeFile(join(outsideRoot, "runtime-instructions.md"), "ATTACKER\n", "utf8");
    const baseExecution = createExecution(root, "x".repeat(8 * 1024 * 1024));
    const execution = {
      ...baseExecution,
      session: { ...baseExecution.session, homePath },
    };
    const interception = await interceptAtomicTemporarySync(
      root,
      homePath,
      ".runtime-instructions.md.",
      async () => {
        await rename(homePath, detachedHome);
        await symlink(outsideRoot, homePath, "dir");
      },
    );

    try {
      await expect(
        writeNativeRuntimeSystemPrompt(execution, [], new AbortController().signal),
      ).rejects.toThrow("Runtime home changed while managed files were being written");
      expect(interception.didRun()).toBe(true);
      await expect(readFile(join(outsideRoot, "runtime-instructions.md"), "utf8")).resolves.toBe(
        "ATTACKER\n",
      );
      await expect(readFile(join(detachedHome, "runtime-instructions.md"), "utf8")).resolves.toBe(
        `${buildNativeRuntimeSystemPrompt(execution)}\n`,
      );
    } finally {
      interception.restore();
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("concurrent native instruction writers never share a temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
    const first = createExecution(root, `first-${"a".repeat(2 * 1024 * 1024)}`);
    const second = createExecution(root, `second-${"b".repeat(2 * 1024 * 1024)}`);

    try {
      await Promise.all([
        writeNativeRuntimeSystemPrompt(first, [], new AbortController().signal),
        writeNativeRuntimeSystemPrompt(second, [], new AbortController().signal),
      ]);

      const contents = await readFile(join(root, "runtime-instructions.md"), "utf8");
      expect([
        `${buildNativeRuntimeSystemPrompt(first)}\n`,
        `${buildNativeRuntimeSystemPrompt(second)}\n`,
      ]).toContain(contents);
      expect(await readdir(root)).toEqual(["runtime-instructions.md"]);
      expect((await stat(join(root, "runtime-instructions.md"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("atomically replaces catalog leaf symlinks without changing their targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-outside-"));
    const catalogRoot = join(root, ".mosoo", "skills");
    const manifestPath = join(catalogRoot, "manifest.json");
    const readmePath = join(catalogRoot, "README.md");
    const manifestTarget = join(outsideRoot, "manifest-target.json");
    const readmeTarget = join(outsideRoot, "readme-target.md");
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(manifestTarget, "outside manifest", "utf8");
    await writeFile(readmeTarget, "outside readme", "utf8");
    await symlink(manifestTarget, manifestPath, "file");
    await symlink(readmeTarget, readmePath, "file");

    try {
      await expect(
        writeSkillBootstrapArtifacts(
          createCatalogExecution(root),
          [createMaterializedSkill(root)],
          new AbortController().signal,
        ),
      ).resolves.toEqual({ manifestPath, readmePath });
      expect(await readFile(manifestTarget, "utf8")).toBe("outside manifest");
      expect(await readFile(readmeTarget, "utf8")).toBe("outside readme");
      await expect(readlink(manifestPath)).rejects.toThrow();
      await expect(readlink(readmePath)).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("rejects a catalog directory replaced while bootstrap files are written", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-outside-"));
    const catalogRoot = join(root, ".mosoo", "skills");
    const detachedCatalog = join(root, ".mosoo", "detached-skills");
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(join(outsideRoot, "manifest.json"), "ATTACKER", "utf8");
    await writeFile(join(outsideRoot, "README.md"), "ATTACKER", "utf8");
    const execution = createCatalogExecution(root);
    execution.skillCatalog[0] = {
      ...execution.skillCatalog[0]!,
      frontmatter: {
        ...execution.skillCatalog[0]!.frontmatter,
        description: "x".repeat(8 * 1024 * 1024),
      },
    };
    const interception = await interceptAtomicTemporarySync(
      root,
      catalogRoot,
      ".manifest.json.",
      async () => {
        await rename(catalogRoot, detachedCatalog);
        await symlink(outsideRoot, catalogRoot, "dir");
      },
    );

    try {
      await expect(
        writeSkillBootstrapArtifacts(
          execution,
          [createMaterializedSkill(root)],
          new AbortController().signal,
        ),
      ).rejects.toThrow("catalog root changed while managed files were being written");
      expect(interception.didRun()).toBe(true);
      await expect(readFile(join(outsideRoot, "manifest.json"), "utf8")).resolves.toBe("ATTACKER");
      await expect(readFile(join(outsideRoot, "README.md"), "utf8")).resolves.toBe("ATTACKER");
      await expect(readFile(join(detachedCatalog, "manifest.json"), "utf8")).resolves.toContain(
        '"skillName": "review"',
      );
    } finally {
      interception.restore();
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("rejects a catalog symlink ancestor without writing outside the session", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-outside-"));
    await mkdir(join(root, ".mosoo"));
    await symlink(outsideRoot, join(root, ".mosoo", "skills"), "dir");

    try {
      await expect(
        writeSkillBootstrapArtifacts(
          createCatalogExecution(root),
          [createMaterializedSkill(root)],
          new AbortController().signal,
        ),
      ).rejects.toThrow("must be a real directory");
      expect(await readdir(outsideRoot)).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("does not expose a catalog entry that was not materialized", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
    const execution = createCatalogExecution(root);
    execution.skillCatalog[0] = {
      ...execution.skillCatalog[0]!,
      mountPath: join(root, ".mosoo", "skill", "other"),
      skillName: "other",
    };

    try {
      await expect(
        writeSkillBootstrapArtifacts(
          execution,
          [createMaterializedSkill(root)],
          new AbortController().signal,
        ),
      ).rejects.toThrow("does not match materialized skill");
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not write native instructions for an unmaterialized catalog entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
    const execution = createCatalogExecution(root);

    try {
      await expect(
        writeNativeRuntimeSystemPrompt(execution, [], new AbortController().signal),
      ).rejects.toThrow("does not match materialized skill");
      await expect(readFile(join(root, "runtime-instructions.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("removes stale managed artifacts when the runtime context becomes empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-bootstrap-"));
    const catalogRoot = join(root, ".mosoo", "skills");
    const nativeInstructionsPath = join(root, "runtime-instructions.md");
    const nativeTemporaryPath = join(
      root,
      ".runtime-instructions.md.11111111-1111-4111-8111-111111111111.tmp",
    );
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(join(catalogRoot, "manifest.json"), "stale manifest", "utf8");
    await writeFile(join(catalogRoot, "README.md"), "stale readme", "utf8");
    await writeFile(
      join(catalogRoot, ".manifest.json.22222222-2222-4222-8222-222222222222.tmp"),
      "partial manifest",
      "utf8",
    );
    await writeFile(
      join(catalogRoot, ".README.md.33333333-3333-4333-8333-333333333333.tmp"),
      "partial readme",
      "utf8",
    );
    await writeFile(nativeInstructionsPath, "stale instructions", "utf8");
    await writeFile(nativeTemporaryPath, "partial instructions", "utf8");
    const execution = createExecution(root, "");
    const signal = new AbortController().signal;

    try {
      await expect(writeSkillBootstrapArtifacts(execution, [], signal)).resolves.toBeNull();
      await expect(writeNativeRuntimeSystemPrompt(execution, [], signal)).resolves.toBeNull();
      await expect(readdir(catalogRoot)).resolves.toEqual([]);
      await expect(readFile(nativeInstructionsPath, "utf8")).rejects.toThrow();
      await expect(readFile(nativeTemporaryPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
