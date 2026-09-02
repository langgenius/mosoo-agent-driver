import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zipSync as createZipArchive } from "fflate";

import type { AgentDriverMaterializedSkill } from "../src/host-ports";
import { createDisabledLogger as createTestLogger } from "../src/observability";
import type { DriverResolvedSkill } from "../src/protocol/boot";
import type { DriverExecutionInput } from "../src/protocol/execution";
import { exposeNativeSkillAliases } from "../src/runtimes/skill-bootstrap";
import { materializeResolvedSkills } from "../src/runtimes/skill-materialization";
import { promiseWithTimeout } from "../src/utils/async";
import { bootPayload } from "./driver-runtime-boundary-fixtures";

const textEncoder = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toDataUrl(bytes: Uint8Array): string {
  return `data:application/zip;base64,${Buffer.from(bytes).toString("base64")}`;
}

function createExecution(
  root: string,
  skills: DriverResolvedSkill | DriverResolvedSkill[],
): DriverExecutionInput {
  const resolvedSkills = Array.isArray(skills) ? skills : [skills];

  return {
    ...bootPayload.execution,
    session: {
      ...bootPayload.execution.session,
      cwd: root,
      sharedRootPath: root,
    },
    skillCatalog: resolvedSkills.map((skill) => ({
      frontmatter: {
        author: null,
        description: null,
        version: null,
      },
      mountPath: skill.mountPath,
      resolutionMode: skill.resolutionMode,
      skillId: skill.skillId,
      skillName: skill.skillName,
    })),
    skills: resolvedSkills,
  };
}

function createSkill(
  root: string,
  archive: Uint8Array,
  overrides: Partial<DriverResolvedSkill> = {},
): DriverResolvedSkill {
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
    ...overrides,
  };
}

function materialize(execution: DriverExecutionInput, logger: ReturnType<typeof createTestLogger>) {
  return materializeResolvedSkills(execution, logger, new AbortController().signal);
}

function exposeAliases(
  execution: DriverExecutionInput,
  logger: ReturnType<typeof createTestLogger>,
  skills: readonly AgentDriverMaterializedSkill[],
  signal = new AbortController().signal,
) {
  return exposeNativeSkillAliases(execution, logger, skills, signal);
}

function createMarkdownSkillEntries(markdown: string) {
  return { "SKILL.md": textEncoder.encode(markdown) };
}

async function createActiveTransaction(root: string, committed = false) {
  const activeRoot = join(root, ".mosoo", ".skill-transactions", "active");
  const newRoot = join(activeRoot, "new");
  const oldRoot = join(activeRoot, "old");
  await mkdir(activeRoot, { recursive: true });
  if (committed) {
    await mkdir(oldRoot);
    await writeFile(join(activeRoot, "COMMITTED"), "");
  } else {
    await mkdir(newRoot);
  }
  return { activeRoot, newRoot, oldRoot };
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
      const [materializedSkill] = await materialize(createExecution(root, skill), logger);

      expect(materializedSkill).toEqual({
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
      await expect(materialize(createExecution(root, skill), logger)).rejects.toThrow(
        "outside the allowed root",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects duplicate resolved mounts before touching either skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const archive = createZipArchive(createMarkdownSkillEntries("canonical"));
    const first = createSkill(root, archive);
    const duplicate = createSkill(root, archive, {
      mountPath: join(root, ".mosoo", "skill", "unused", "..", "review"),
      skillId: "skill-2" as DriverResolvedSkill["skillId"],
      skillName: "duplicate",
      snapshotId: "snapshot-2" as DriverResolvedSkill["snapshotId"],
    });
    await mkdir(first.mountPath, { recursive: true });
    await writeFile(join(first.mountPath, "KEEP"), "untouched", "utf8");

    try {
      await expect(materialize(createExecution(root, [first, duplicate]), logger)).rejects.toThrow(
        "duplicate mount path",
      );
      await expect(readFile(join(first.mountPath, "KEEP"), "utf8")).resolves.toBe("untouched");
      await expect(readdir(join(root, ".mosoo"))).resolves.toEqual(["skill"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects duplicate resolved skill names before downloading either skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const archive = createZipArchive(createMarkdownSkillEntries("canonical"));
    const first = createSkill(root, archive);
    const duplicate = createSkill(root, archive, {
      mountPath: join(root, ".mosoo", "skill", "second"),
      skillId: "skill-2" as DriverResolvedSkill["skillId"],
      snapshotId: "snapshot-2" as DriverResolvedSkill["snapshotId"],
    });

    try {
      await expect(materialize(createExecution(root, [first, duplicate]), logger)).rejects.toThrow(
        "duplicate skill name",
      );
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects a catalog that advertises a different active skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const archive = createZipArchive(createMarkdownSkillEntries("canonical"));
    const skill = createSkill(root, archive);
    const execution = createExecution(root, skill);
    execution.skillCatalog[0] = {
      ...execution.skillCatalog[0]!,
      mountPath: join(root, ".mosoo", "skill", "other"),
      skillName: "other",
    };

    try {
      await expect(materialize(execution, logger)).rejects.toThrow("does not match resolved skill");
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects a symbolic-link mount ancestor without touching its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-outside-"));
    const logger = createTestLogger();
    const archive = createZipArchive(createMarkdownSkillEntries("new contents"));
    const skill = createSkill(root, archive);
    const outsideMount = join(outsideRoot, "review");
    await mkdir(join(root, ".mosoo"));
    await mkdir(outsideMount, { recursive: true });
    await writeFile(join(outsideMount, "KEEP"), "outside", "utf8");
    await symlink(outsideRoot, join(root, ".mosoo", "skill"), "dir");

    try {
      await expect(materialize(createExecution(root, skill), logger)).rejects.toThrow(
        "Skill mount root must be a real directory",
      );
      await expect(readFile(join(outsideMount, "KEEP"), "utf8")).resolves.toBe("outside");
      await expect(readlink(join(root, ".mosoo", "skill"))).resolves.toBe(outsideRoot);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("rejects a symbolic-link mount leaf without touching its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-outside-"));
    const logger = createTestLogger();
    const archive = createZipArchive(createMarkdownSkillEntries("new contents"));
    const skill = createSkill(root, archive);
    await mkdir(dirname(skill.mountPath), { recursive: true });
    await writeFile(join(outsideRoot, "KEEP"), "outside", "utf8");
    await symlink(outsideRoot, skill.mountPath, "dir");

    try {
      await expect(materialize(createExecution(root, skill), logger)).rejects.toThrow(
        "must be a real directory or absent",
      );
      await expect(readFile(join(outsideRoot, "KEEP"), "utf8")).resolves.toBe("outside");
      await expect(readlink(skill.mountPath)).resolves.toBe(outsideRoot);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("an empty catalog fails closed for a symbolic-link live root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-outside-"));
    const logger = createTestLogger();
    await mkdir(join(root, ".mosoo"));
    await writeFile(join(outsideRoot, "KEEP"), "outside", "utf8");
    await symlink(outsideRoot, join(root, ".mosoo", "skill"), "dir");

    try {
      await expect(materialize(createExecution(root, []), logger)).rejects.toThrow(
        "must be a real directory",
      );
      await expect(readFile(join(outsideRoot, "KEEP"), "utf8")).resolves.toBe("outside");
      await expect(readlink(join(root, ".mosoo", "skill"))).resolves.toBe(outsideRoot);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("an empty catalog fails closed for a non-directory live root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const mountRoot = join(root, ".mosoo", "skill");
    await mkdir(join(root, ".mosoo"));
    await writeFile(mountRoot, "user-controlled", "utf8");

    try {
      await expect(materialize(createExecution(root, []), logger)).rejects.toThrow(
        "must be a real directory",
      );
      await expect(readFile(mountRoot, "utf8")).resolves.toBe("user-controlled");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("recovery does not accept a symbolic-link untouched live root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-outside-"));
    const logger = createTestLogger();
    await mkdir(join(root, ".mosoo"));
    await writeFile(join(outsideRoot, "KEEP"), "outside", "utf8");
    await symlink(outsideRoot, join(root, ".mosoo", "skill"), "dir");
    await createActiveTransaction(root);

    try {
      await expect(materialize(createExecution(root, []), logger)).rejects.toThrow(
        "must be a real directory",
      );
      await expect(readFile(join(outsideRoot, "KEEP"), "utf8")).resolves.toBe("outside");
      await expect(readlink(join(root, ".mosoo", "skill"))).resolves.toBe(outsideRoot);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("does not follow a mount ancestor replaced after admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-outside-"));
    const logger = createTestLogger();
    const archive = createZipArchive(createMarkdownSkillEntries("new contents"));
    const skill = createSkill(root, archive, {
      downloadUrl: "https://skills.test/raced-ancestor.zip",
    });
    const requestStarted = Promise.withResolvers<void>();
    const releaseResponse = Promise.withResolvers<void>();
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      requestStarted.resolve();
      await releaseResponse.promise;
      return new Response(archive);
    }) as unknown as typeof fetch;
    await mkdir(skill.mountPath, { recursive: true });
    await writeFile(join(skill.mountPath, "SKILL.md"), "previous contents", "utf8");

    try {
      const result = materialize(createExecution(root, skill), logger);
      const rejection = result.then(
        () => null,
        (error: unknown) => error,
      );
      await requestStarted.promise;
      const mountRoot = dirname(skill.mountPath);
      const detachedMountRoot = join(root, ".mosoo", "detached-skill");
      await rename(mountRoot, detachedMountRoot);
      await symlink(outsideRoot, mountRoot, "dir");
      releaseResponse.resolve();

      await expect(rejection).resolves.toMatchObject({
        message: expect.stringContaining("must be a real directory"),
      });
      await expect(readdir(outsideRoot)).resolves.toEqual([]);
      await expect(readFile(join(detachedMountRoot, "review", "SKILL.md"), "utf8")).resolves.toBe(
        "previous contents",
      );
    } finally {
      globalThis.fetch = nativeFetch;
      releaseResponse.resolve();
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("does not follow a staged archive ancestor replaced during extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-outside-"));
    const logger = createTestLogger();
    const archive = createZipArchive({
      ...createMarkdownSkillEntries("canonical"),
      "nested/first.txt": textEncoder.encode("first"),
      "nested/second.txt": textEncoder.encode("second"),
    });
    const skill = createSkill(root, archive);
    const probe = await open(root, "r");
    const handlePrototype = Object.getPrototypeOf(probe) as {
      sync(this: FileHandle): Promise<void>;
    };
    const nativeSync = handlePrototype.sync;
    let swapped = false;
    await probe.close();
    await writeFile(join(outsideRoot, "KEEP"), "outside", "utf8");

    try {
      handlePrototype.sync = async function (this: FileHandle) {
        await nativeSync.call(this);
        if (swapped) {
          return;
        }
        const transactionRoot = join(root, ".mosoo", ".skill-transactions");
        let ownerNames: string[];
        try {
          ownerNames = await readdir(transactionRoot);
        } catch {
          return;
        }
        const ownerName = ownerNames.find((name) => name.startsWith("stage-"));
        if (ownerName === undefined) {
          return;
        }
        const reviewRoot = join(transactionRoot, ownerName, "new", "review");
        const nestedPath = join(reviewRoot, "nested");
        if (!existsSync(join(nestedPath, "first.txt"))) {
          return;
        }

        swapped = true;
        await rename(nestedPath, join(reviewRoot, "detached-nested"));
        await symlink(outsideRoot, nestedPath, "dir");
      };

      await expect(materialize(createExecution(root, skill), logger)).rejects.toThrow(
        "must be a real directory",
      );
      expect(swapped).toBe(true);
      await expect(readFile(join(outsideRoot, "KEEP"), "utf8")).resolves.toBe("outside");
      await expect(readFile(join(outsideRoot, "second.txt"), "utf8")).rejects.toThrow();
      await expect(readFile(join(skill.mountPath, "SKILL.md"), "utf8")).rejects.toThrow();
    } finally {
      handlePrototype.sync = nativeSync;
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("preserves the previous tree when a replacement package is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const validArchive = createZipArchive(createMarkdownSkillEntries("previous contents"));
    const malformedArchive = createZipArchive({
      "references/README.md": textEncoder.encode("missing skill markdown"),
    });
    const validSkill = createSkill(root, validArchive);
    const malformedSkill = createSkill(root, malformedArchive, {
      snapshotId: "snapshot-2" as DriverResolvedSkill["snapshotId"],
    });

    try {
      await materialize(createExecution(root, validSkill), logger);
      await expect(materialize(createExecution(root, malformedSkill), logger)).rejects.toThrow(
        "does not contain SKILL.md",
      );
      await expect(readFile(join(validSkill.mountPath, "SKILL.md"), "utf8")).resolves.toBe(
        "previous contents",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not trust cache metadata in the agent-writable skill tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const archive = createZipArchive(createMarkdownSkillEntries("canonical contents"));
    const skill = createSkill(root, archive);

    try {
      await materialize(createExecution(root, skill), logger);
      await writeFile(join(skill.mountPath, "SKILL.md"), "tampered", "utf8");
      await writeFile(
        join(skill.mountPath, ".mosoo-skill-cache.json"),
        JSON.stringify({ blobSha256: skill.blobSha256, snapshotId: skill.snapshotId }),
        "utf8",
      );

      await materialize(createExecution(root, skill), logger);

      await expect(readFile(join(skill.mountPath, "SKILL.md"), "utf8")).resolves.toBe(
        "canonical contents",
      );
      await expect(
        readFile(join(skill.mountPath, ".mosoo-skill-cache.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("quarantine cleanup unlinks old symlinks without traversing their targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-outside-"));
    const logger = createTestLogger();
    const archive = createZipArchive(createMarkdownSkillEntries("replacement contents"));
    const skill = createSkill(root, archive);
    await mkdir(skill.mountPath, { recursive: true });
    await writeFile(join(skill.mountPath, "SKILL.md"), "previous contents", "utf8");
    await writeFile(join(outsideRoot, "KEEP"), "outside", "utf8");
    await symlink(outsideRoot, join(skill.mountPath, "escape"), "dir");

    try {
      await materialize(createExecution(root, skill), logger);

      await expect(readFile(join(skill.mountPath, "SKILL.md"), "utf8")).resolves.toBe(
        "replacement contents",
      );
      await expect(readFile(join(outsideRoot, "KEEP"), "utf8")).resolves.toBe("outside");
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test("quarantines managed mounts that are absent from an empty catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const skill = createSkill(
      root,
      createZipArchive(createMarkdownSkillEntries("previous contents")),
    );

    try {
      await materialize(createExecution(root, skill), logger);
      await expect(materialize(createExecution(root, []), logger)).resolves.toEqual([]);

      await expect(readFile(join(skill.mountPath, "SKILL.md"), "utf8")).rejects.toThrow();
      await expect(readdir(join(root, ".mosoo", ".skill-transactions"))).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not create managed roots for an already empty session", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const execution = createExecution(root, []);

    try {
      await expect(materialize(execution, logger)).resolves.toEqual([]);
      await expect(exposeAliases(execution, logger, [])).resolves.toEqual([]);
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("an empty catalog supersedes an older download for the whole mount root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const archive = createZipArchive(createMarkdownSkillEntries("obsolete contents"));
    const requestStarted = Promise.withResolvers<void>();
    const releaseResponse = Promise.withResolvers<void>();
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input) !== "https://skills.test/obsolete.zip") {
        return nativeFetch(input);
      }

      requestStarted.resolve();
      await releaseResponse.promise;
      return new Response(archive);
    }) as typeof fetch;
    const oldSkill = createSkill(root, archive, {
      downloadUrl: "https://skills.test/obsolete.zip",
    });

    try {
      const oldResult = materialize(createExecution(root, oldSkill), logger).then(
        () => null,
        (error: unknown) => error,
      );
      await requestStarted.promise;

      await expect(materialize(createExecution(root, []), logger)).resolves.toEqual([]);
      releaseResponse.resolve();

      await expect(oldResult).resolves.toMatchObject({
        message: "Skill materialization was superseded by a newer generation.",
      });
      await expect(readFile(join(oldSkill.mountPath, "SKILL.md"), "utf8")).rejects.toThrow();
    } finally {
      releaseResponse.resolve();
      globalThis.fetch = nativeFetch;
      await rm(root, { force: true, recursive: true });
    }
  });

  test("cancellation after old mounts move still rolls back the whole catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const skill = createSkill(
      root,
      createZipArchive(createMarkdownSkillEntries("previous contents")),
    );
    const controller = new AbortController();
    const probe = await open(root, "r");
    const handlePrototype = Object.getPrototypeOf(probe) as {
      sync(this: FileHandle): Promise<void>;
    };
    const nativeSync = handlePrototype.sync;
    await probe.close();

    try {
      await materialize(createExecution(root, skill), logger);
      handlePrototype.sync = async function (this: FileHandle) {
        await nativeSync.call(this);
        if (!existsSync(skill.mountPath)) {
          controller.abort(new Error("cancel after backup"));
        }
      };

      await expect(
        materializeResolvedSkills(createExecution(root, []), logger, controller.signal),
      ).rejects.toThrow("cancel after backup");
      await expect(readFile(join(skill.mountPath, "SKILL.md"), "utf8")).resolves.toBe(
        "previous contents",
      );
      await expect(readdir(join(root, ".mosoo", ".skill-transactions"))).resolves.toEqual([]);
    } finally {
      handlePrototype.sync = nativeSync;
      await rm(root, { force: true, recursive: true });
    }
  });

  test("recovers a bounded orphan transaction owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const transactionRoot = join(root, ".mosoo", ".skill-transactions");
    const transactionId = "44444444-4444-4444-8444-444444444444";
    const stagePath = join(transactionRoot, `stage-${transactionId}`);
    await mkdir(join(root, ".mosoo", "skill"), { recursive: true });
    await mkdir(stagePath, { recursive: true });
    await writeFile(join(stagePath, "partial"), "orphan", "utf8");

    try {
      await expect(materialize(createExecution(root, []), logger)).resolves.toEqual([]);
      await expect(readdir(transactionRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("makes bounded progress cleaning a deeply nested orphan owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const transactionRoot = join(root, ".mosoo", ".skill-transactions");
    const stagePath = join(transactionRoot, "stage-55555555-5555-4555-8555-555555555555");
    const deepPath = join(
      stagePath,
      ...Array.from({ length: 80 }, (_, index) => `level-${String(index)}`),
    );
    await mkdir(join(root, ".mosoo", "skill"), { recursive: true });
    await mkdir(deepPath, { recursive: true });
    await writeFile(join(deepPath, "leaf"), "orphan", "utf8");

    try {
      await expect(materialize(createExecution(root, []), logger)).resolves.toEqual([]);
      expect(await readdir(transactionRoot)).toHaveLength(1);
      await expect(materialize(createExecution(root, []), logger)).resolves.toEqual([]);
      await expect(readdir(transactionRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fsyncs the shared root after creating the managed .mosoo entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const skill = createSkill(
      root,
      createZipArchive(createMarkdownSkillEntries("durable contents")),
    );
    const probe = await open(root, "r");
    const rootStats = await probe.stat();
    const handlePrototype = Object.getPrototypeOf(probe) as {
      sync(this: FileHandle): Promise<void>;
    };
    const nativeSync = handlePrototype.sync;
    let sharedRootSynced = false;
    await probe.close();

    try {
      handlePrototype.sync = async function (this: FileHandle) {
        const stats = await this.stat();
        if (stats.dev === rootStats.dev && stats.ino === rootStats.ino) {
          sharedRootSynced = true;
        }
        await nativeSync.call(this);
      };
      await materialize(createExecution(root, skill), logger);
      expect(sharedRootSynced).toBe(true);
    } finally {
      handlePrototype.sync = nativeSync;
      await rm(root, { force: true, recursive: true });
    }
  });

  test("restores an interrupted whole-catalog swap before its commit marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const mountPath = join(root, ".mosoo", "skill", "review");
    const malformedSkill = createSkill(
      root,
      createZipArchive({ "README.md": textEncoder.encode("missing skill markdown") }),
    );
    await mkdir(mountPath, { recursive: true });
    await writeFile(join(mountPath, "SKILL.md"), "previous contents", "utf8");
    const { newRoot, oldRoot } = await createActiveTransaction(root);
    await mkdir(join(newRoot, "review"));
    await writeFile(join(newRoot, "review", "SKILL.md"), "staged contents", "utf8");
    await rename(dirname(mountPath), oldRoot);

    try {
      await expect(materialize(createExecution(root, malformedSkill), logger)).rejects.toThrow(
        "does not contain SKILL.md",
      );
      await expect(readFile(join(mountPath, "SKILL.md"), "utf8")).resolves.toBe(
        "previous contents",
      );
      await expect(readdir(join(root, ".mosoo", ".skill-transactions"))).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("finishes a committed first catalog installation after a crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const mountPath = join(root, ".mosoo", "skill", "review");
    const malformedSkill = createSkill(
      root,
      createZipArchive({ "README.md": textEncoder.encode("missing skill markdown") }),
    );
    const { activeRoot, newRoot } = await createActiveTransaction(root);
    await mkdir(join(newRoot, "review"));
    await writeFile(join(newRoot, "review", "SKILL.md"), "committed contents", "utf8");
    await writeFile(join(activeRoot, "COMMITTED"), "");

    try {
      await expect(materialize(createExecution(root, malformedSkill), logger)).rejects.toThrow(
        "does not contain SKILL.md",
      );
      await expect(readFile(join(mountPath, "SKILL.md"), "utf8")).resolves.toBe(
        "committed contents",
      );
      await expect(readdir(join(root, ".mosoo", ".skill-transactions"))).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("finishes a committed whole-catalog replacement after a crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const mountRoot = join(root, ".mosoo", "skill");
    const mountPath = join(mountRoot, "review");
    const malformedSkill = createSkill(
      root,
      createZipArchive({ "README.md": textEncoder.encode("missing skill markdown") }),
    );
    await mkdir(mountPath, { recursive: true });
    await writeFile(join(mountPath, "SKILL.md"), "previous contents", "utf8");
    const { activeRoot, newRoot, oldRoot } = await createActiveTransaction(root);
    await mkdir(join(newRoot, "review"));
    await writeFile(join(newRoot, "review", "SKILL.md"), "committed contents", "utf8");
    await rename(mountRoot, oldRoot);
    await writeFile(join(activeRoot, "COMMITTED"), "");

    try {
      await expect(materialize(createExecution(root, malformedSkill), logger)).rejects.toThrow(
        "does not contain SKILL.md",
      );
      await expect(readFile(join(mountPath, "SKILL.md"), "utf8")).resolves.toBe(
        "committed contents",
      );
      await expect(readdir(join(root, ".mosoo", ".skill-transactions"))).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("a rolled-back transaction does not conflict with the next catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const mountPath = join(root, ".mosoo", "skill", "review");
    const currentSkill = createSkill(
      root,
      createZipArchive(createMarkdownSkillEntries("next catalog contents")),
    );
    await mkdir(mountPath, { recursive: true });
    await writeFile(join(mountPath, "SKILL.md"), "previous contents", "utf8");
    const { newRoot, oldRoot } = await createActiveTransaction(root);
    await mkdir(join(newRoot, "review"));
    await writeFile(join(newRoot, "review", "SKILL.md"), "abandoned contents", "utf8");
    await rename(dirname(mountPath), oldRoot);

    try {
      await materialize(createExecution(root, currentSkill), logger);

      await expect(readFile(join(mountPath, "SKILL.md"), "utf8")).resolves.toBe(
        "next catalog contents",
      );
      await expect(readdir(join(root, ".mosoo", ".skill-transactions"))).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("retires a committed transaction owner before a later catalog removes its mount", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const mountPath = join(root, ".mosoo", "skill", "review");
    await mkdir(mountPath, { recursive: true });
    await writeFile(join(mountPath, "SKILL.md"), "current contents", "utf8");
    const { oldRoot } = await createActiveTransaction(root, true);
    await mkdir(join(oldRoot, "review"));
    await Promise.all(
      Array.from({ length: 1_025 }, (_, index) =>
        writeFile(join(oldRoot, "review", `old-${String(index)}`), "", "utf8"),
      ),
    );

    try {
      await expect(materialize(createExecution(root, []), logger)).resolves.toEqual([]);
      await expect(readFile(join(mountPath, "SKILL.md"), "utf8")).rejects.toThrow();

      await expect(materialize(createExecution(root, []), logger)).resolves.toEqual([]);
      await expect(readdir(join(root, ".mosoo", ".skill-transactions"))).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("a committed empty-catalog transaction does not conflict with re-adding the skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const skill = createSkill(
      root,
      createZipArchive(createMarkdownSkillEntries("re-added contents")),
    );
    const { oldRoot } = await createActiveTransaction(root, true);
    await mkdir(join(oldRoot, "review"));
    await writeFile(join(oldRoot, "review", "SKILL.md"), "removed contents", "utf8");
    await mkdir(join(root, ".mosoo", "skill"));

    try {
      await materialize(createExecution(root, skill), logger);

      await expect(readFile(join(skill.mountPath, "SKILL.md"), "utf8")).resolves.toBe(
        "re-added contents",
      );
      await expect(readdir(join(root, ".mosoo", ".skill-transactions"))).resolves.toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("a newer generation cancels an obsolete download before it can overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const oldArchive = createZipArchive(createMarkdownSkillEntries("obsolete contents"));
    const newArchive = createZipArchive(createMarkdownSkillEntries("current contents"));
    const oldRequestStarted = Promise.withResolvers<void>();
    const nativeFetch = globalThis.fetch;
    let oldRequestSignal: AbortSignal | null = null;
    let oldStreamCancelled = false;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (String(input) !== "https://skills.test/obsolete.zip") {
        return nativeFetch(input, init);
      }

      oldRequestSignal = init?.signal ?? null;
      oldRequestStarted.resolve();
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            oldStreamCancelled = true;
          },
          start(controller) {
            controller.enqueue(oldArchive);
          },
        }),
      );
    }) as unknown as typeof fetch;
    const oldSkill = createSkill(root, oldArchive, {
      downloadUrl: "https://skills.test/obsolete.zip",
    });
    const newSkill = createSkill(root, newArchive, {
      snapshotId: "snapshot-2" as DriverResolvedSkill["snapshotId"],
    });
    try {
      const oldMaterialization = materializeResolvedSkills(
        createExecution(root, oldSkill),
        logger,
        new AbortController().signal,
      );
      const oldResult = oldMaterialization.then(
        () => null,
        (error: unknown) => error,
      );
      await oldRequestStarted.promise;
      await materialize(createExecution(root, newSkill), logger);

      await expect(oldResult).resolves.toMatchObject({
        message: "Skill materialization was superseded by a newer generation.",
      });
      expect((oldRequestSignal as AbortSignal | null)?.aborted).toBe(true);
      expect(oldStreamCancelled).toBe(true);
      await expect(readFile(join(newSkill.mountPath, "SKILL.md"), "utf8")).resolves.toBe(
        "current contents",
      );
    } finally {
      globalThis.fetch = nativeFetch;
      await rm(root, { force: true, recursive: true });
    }
  });

  test.each([
    ["http-error", "cooperative"],
    ["http-error", "stalled"],
    ["content-length", "cooperative"],
    ["content-length", "stalled"],
    ["stream", "cooperative"],
    ["stream", "stalled"],
  ] as const)("bounds %s skill downloads with %s cancellation", async (boundary, cancellation) => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-skill-materialization-"));
    const logger = createTestLogger();
    const skill = createSkill(root, new Uint8Array(), {
      downloadUrl: "https://skills.test/oversized.zip",
    });
    const nativeFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = (async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
            return cancellation === "stalled" ? new Promise<void>(() => {}) : undefined;
          },
          pull(controller) {
            if (boundary === "stream") {
              controller.enqueue(new Uint8Array(1024 * 1024));
            }
          },
        }),
        boundary === "http-error"
          ? { status: 502 }
          : boundary === "content-length"
            ? { headers: { "content-length": "26214401" } }
            : undefined,
      );
    }) as unknown as typeof fetch;
    await mkdir(skill.mountPath, { recursive: true });
    await writeFile(join(skill.mountPath, "SKILL.md"), "previous contents", "utf8");

    try {
      await expect(
        promiseWithTimeout(materialize(createExecution(root, skill), logger), {
          label: "bounded skill download",
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow(
        boundary === "http-error"
          ? "Failed to download skill package"
          : "Compressed skill package exceeds the limit",
      );
      expect(cancelled).toBe(true);
      await expect(readFile(join(skill.mountPath, "SKILL.md"), "utf8")).resolves.toBe(
        "previous contents",
      );
    } finally {
      globalThis.fetch = nativeFetch;
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
      const materializedSkills = await materialize(execution, logger);

      await exposeAliases(execution, logger, materializedSkills);

      await expect(readlink(aliasPath)).resolves.toBe("../../.mosoo/skill/review");
      await expect(readFile(join(aliasPath, "SKILL.md"), "utf8")).resolves.toContain(
        "Check the diff.",
      );

      await exposeAliases(execution, logger, []);

      await expect(readFile(join(aliasPath, "SKILL.md"), "utf8")).rejects.toThrow();
    } finally {
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
      await expect(exposeAliases(execution, logger, [skill])).resolves.toEqual([]);
      await expect(readdir(join(root, ".agents", "skills"))).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects duplicate native skill names instead of silently choosing one", async () => {
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
      await expect(exposeAliases(execution, logger, [first, duplicate])).rejects.toThrow(
        "duplicate skill name",
      );
      await expect(readlink(join(root, ".agents", "skills", "review"))).rejects.toThrow();
    } finally {
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
      await exposeAliases(execution, logger, [
        {
          mountPath,
          skillId: "skill-2",
          skillMarkdownPath: join(mountPath, "SKILL.md"),
          skillName: "review",
          snapshotId: "snapshot-1",
        },
      ]);
      await expect(readlink(aliasPath)).resolves.toBe("../../.mosoo/skill/skill-2");

      await exposeAliases(execution, logger, []);

      await expect(readlink(aliasPath)).rejects.toThrow();
    } finally {
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
        exposeAliases(execution, logger, [
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
      await rm(root, { force: true, recursive: true });
    }
  });
});
