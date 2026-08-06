import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { AgentDriverMaterializedSkill } from "../src/host-ports";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverResolvedSkill } from "../src/protocol/boot";
import type { DriverExecutionInput } from "../src/protocol/execution";
import {
  exposeNativeSkillAliases,
  materializeResolvedSkills,
} from "../src/runtimes/skill-materialization";
import { createZipArchive } from "../src/skill-package";
import type { SkillPackageEntry } from "../src/skill-package";
import { bootPayload } from "./driver-runtime-boundary-fixtures";

const textEncoder = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toDataUrl(bytes: Uint8Array): string {
  return `data:application/zip;base64,${Buffer.from(bytes).toString("base64")}`;
}

function createExecution(root: string, skill: DriverResolvedSkill): DriverExecutionInput {
  return {
    ...bootPayload.execution,
    session: {
      ...bootPayload.execution.session,
      cwd: root,
      sharedRootPath: root,
    },
    skillCatalog: [],
    skills: [skill],
  };
}

function createSkill(root: string, archive: Uint8Array): DriverResolvedSkill {
  return {
    archiveFormat: "zip",
    blobSha256: sha256(archive),
    compression: "deflate",
    downloadUrl: toDataUrl(archive),
    materializationStatus: "pending",
    mountPath: join(root, ".mosoo", "skill", "review"),
    resolutionMode: "explicit",
    skillId: "skill-1" as DriverResolvedSkill["skillId"],
    skillName: "review",
    snapshotId: "snapshot-1" as DriverResolvedSkill["snapshotId"],
    warningCode: null,
  };
}

function createTestLogger() {
  return createBufferedSinkLogger({
    level: "debug",
    service: "skill-materialization-test",
    sink: async () => {},
  });
}

function createMarkdownSkillEntries(markdown: string): SkillPackageEntry[] {
  return [
    {
      body: textEncoder.encode(markdown),
      entryKind: "file",
      isExecutable: false,
      path: "SKILL.md",
    },
  ];
}

describe("skill materialization", () => {
  test("extracts a resolved skill under the session skill root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const archive = createZipArchive(
      createMarkdownSkillEntries(`---
name: review
description: Review code changes.
---

Check the diff.`),
    );
    const skill = createSkill(root, archive);

    try {
      const [materialized] = await materializeResolvedSkills(createExecution(root, skill), logger);

      expect(materialized).toEqual({
        mountPath: skill.mountPath,
        skillId: "skill-1",
        skillMarkdownPath: join(skill.mountPath, "SKILL.md"),
        skillName: "review",
        snapshotId: "snapshot-1",
      });
      await expect(readFile(join(skill.mountPath, "SKILL.md"), "utf8")).resolves.toContain(
        "Check the diff.",
      );
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects skill mounts outside the session skill root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const archive = createZipArchive(
      createMarkdownSkillEntries(`---
name: review
description: Review code changes.
---

Check the diff.`),
    );
    const skill = {
      ...createSkill(root, archive),
      mountPath: join(root, "skill", "review"),
    };

    try {
      await expect(materializeResolvedSkills(createExecution(root, skill), logger)).rejects.toThrow(
        "outside the allowed root",
      );
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fails malformed packages before reporting materialization success", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const archive = createZipArchive([
      {
        body: textEncoder.encode("missing skill markdown"),
        entryKind: "file",
        isExecutable: false,
        path: "references/README.md",
      } satisfies SkillPackageEntry,
    ]);
    const skill = createSkill(root, archive);

    try {
      await expect(materializeResolvedSkills(createExecution(root, skill), logger)).rejects.toThrow(
        "does not contain SKILL.md",
      );
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("exposes a relative native alias and removes it when the skill becomes unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const archive = createZipArchive(
      createMarkdownSkillEntries(`---
name: review
description: Review code changes.
---

Check the diff.`),
    );
    const execution = createExecution(root, createSkill(root, archive));
    const aliasPath = join(root, ".agents", "skills", "review");

    try {
      const materialized = await materializeResolvedSkills(execution, logger);

      await exposeNativeSkillAliases(execution, logger, materialized);

      await expect(readlink(aliasPath)).resolves.toBe("../../.mosoo/skill/review");
      await expect(readFile(join(aliasPath, "SKILL.md"), "utf8")).resolves.toContain(
        "Check the diff.",
      );

      await exposeNativeSkillAliases(execution, logger, []);

      await expect(readFile(join(aliasPath, "SKILL.md"), "utf8")).rejects.toThrow();
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("skips a native alias for an invalid skill name without failing", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const execution = createExecution(
      root,
      createSkill(root, createZipArchive(createMarkdownSkillEntries("unused"))),
    );
    const skill = {
      mountPath: join(root, ".mosoo", "skill", "skill-1"),
      skillId: "skill-1",
      skillMarkdownPath: join(root, ".mosoo", "skill", "skill-1", "SKILL.md"),
      skillName: "My Skill",
      snapshotId: "snapshot-1",
    } satisfies AgentDriverMaterializedSkill;

    try {
      await expect(exposeNativeSkillAliases(execution, logger, [skill])).resolves.toEqual([]);
      await expect(readdir(join(root, ".agents", "skills"))).resolves.toEqual([]);
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("keeps the first skill when native skill names collide", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const execution = createExecution(
      root,
      createSkill(root, createZipArchive(createMarkdownSkillEntries("unused"))),
    );
    const firstMountPath = join(root, ".mosoo", "skill", "skill-1");
    await mkdir(firstMountPath, { recursive: true });
    await writeFile(join(firstMountPath, "SKILL.md"), "canonical", "utf8");
    const first = {
      mountPath: firstMountPath,
      skillId: "skill-1",
      skillMarkdownPath: join(firstMountPath, "SKILL.md"),
      skillName: "review",
      snapshotId: "snapshot-1",
    } satisfies AgentDriverMaterializedSkill;
    const duplicate = {
      ...first,
      mountPath: join(root, ".mosoo", "skill", "skill-2"),
      skillId: "skill-2",
      skillMarkdownPath: join(root, ".mosoo", "skill", "skill-2", "SKILL.md"),
    } satisfies AgentDriverMaterializedSkill;

    try {
      await expect(
        exposeNativeSkillAliases(execution, logger, [first, duplicate]),
      ).resolves.toEqual([join(root, ".agents", "skills", "review")]);
      await expect(readlink(join(root, ".agents", "skills", "review"))).resolves.toBe(
        "../../.mosoo/skill/skill-1",
      );
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("recreates a dangling managed alias and cleans it once the skill is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const execution = createExecution(
      root,
      createSkill(root, createZipArchive(createMarkdownSkillEntries("unused"))),
    );
    const aliasRoot = join(root, ".agents", "skills");
    const aliasPath = join(aliasRoot, "review");
    const mountPath = join(root, ".mosoo", "skill", "skill-2");
    await mkdir(aliasRoot, { recursive: true });
    await mkdir(mountPath, { recursive: true });
    await writeFile(join(mountPath, "SKILL.md"), "canonical", "utf8");
    await symlink("../../.mosoo/skill/gone", aliasPath, "dir");

    try {
      await exposeNativeSkillAliases(execution, logger, [
        {
          mountPath,
          skillId: "skill-2",
          skillMarkdownPath: join(mountPath, "SKILL.md"),
          skillName: "review",
          snapshotId: "snapshot-1",
        },
      ]);
      await expect(readlink(aliasPath)).resolves.toBe("../../.mosoo/skill/skill-2");

      await exposeNativeSkillAliases(execution, logger, []);

      await expect(readlink(aliasPath)).rejects.toThrow();
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("preserves an existing native skill directory on collision", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const execution = createExecution(
      root,
      createSkill(root, createZipArchive(createMarkdownSkillEntries("unused"))),
    );
    const mountPath = join(root, ".mosoo", "skill", "skill-1");
    const aliasPath = join(root, ".agents", "skills", "review");
    await mkdir(mountPath, { recursive: true });
    await writeFile(join(mountPath, "SKILL.md"), "canonical", "utf8");
    await mkdir(aliasPath, { recursive: true });
    await writeFile(join(aliasPath, "KEEP"), "user-owned", "utf8");

    try {
      await expect(
        exposeNativeSkillAliases(execution, logger, [
          {
            mountPath,
            skillId: "skill-1",
            skillMarkdownPath: join(mountPath, "SKILL.md"),
            skillName: "review",
            snapshotId: "snapshot-1",
          },
        ]),
      ).rejects.toThrow('Native skill alias "review" collides');
      await expect(readFile(join(aliasPath, "KEEP"), "utf8")).resolves.toBe("user-owned");
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("is discovered by the pinned OpenCode runtime before its first process starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-opencode-skill-contract-"));
    const homePath = join(root, "home");
    const logger = createTestLogger();
    const archive = createZipArchive(
      createMarkdownSkillEntries(`---
name: review
description: Review code changes.
---

Check the diff.`),
    );
    const baseExecution = createExecution(root, createSkill(root, archive));
    const execution = {
      ...baseExecution,
      session: {
        ...baseExecution.session,
        homePath,
      },
    };
    const opencode = resolve(process.cwd(), "node_modules", ".bin", "opencode");
    const discover = () => {
      const result = spawnSync(opencode, ["debug", "skill", "--pure"], {
        cwd: root,
        encoding: "utf8",
        env: {
          HOME: homePath,
          OPENCODE_TEST_HOME: homePath,
          PATH: process.env["PATH"] ?? "",
          XDG_CACHE_HOME: join(homePath, ".cache"),
          XDG_CONFIG_HOME: join(homePath, ".config"),
          XDG_DATA_HOME: join(homePath, ".local", "share"),
          XDG_STATE_HOME: join(homePath, ".local", "state"),
        },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout) as { location: string; name: string }[];
    };

    try {
      await mkdir(homePath, { recursive: true });
      const materialized = await materializeResolvedSkills(execution, logger);
      await exposeNativeSkillAliases(execution, logger, materialized);

      expect(discover()).toContainEqual(
        expect.objectContaining({
          location: join(await realpath(root), ".agents", "skills", "review", "SKILL.md"),
          name: "review",
        }),
      );

      await exposeNativeSkillAliases(execution, logger, []);

      expect(discover().some((skill) => skill.name === "review")).toBe(false);
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });
});
