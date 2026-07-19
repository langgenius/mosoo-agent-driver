import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverResolvedSkill } from "../src/protocol/boot";
import type { DriverExecutionInput } from "../src/protocol/execution";
import { materializeResolvedSkills } from "../src/runtimes/skill-materialization";
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
    const logger = createBufferedSinkLogger({
      level: "debug",
      service: "skill-materialization-test",
      sink: async () => {},
    });
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
    const logger = createBufferedSinkLogger({
      level: "debug",
      service: "skill-materialization-test",
      sink: async () => {},
    });
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
    const logger = createBufferedSinkLogger({
      level: "debug",
      service: "skill-materialization-test",
      sink: async () => {},
    });
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
});
