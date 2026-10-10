import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseRunId } from "../src/protocol/id";
import {
  getNativeCheckpointRelativePath,
  MAX_NATIVE_CHECKPOINT_FILE_BYTES,
  parseNativeCheckpointManifest,
  type NativeCheckpoint,
} from "../src/protocol/native-checkpoint";
import {
  createNativeCheckpoint,
  readNativeCheckpoint,
  readNativeCheckpointSourceFile,
} from "../src/runtimes/native-checkpoint";

const checkpoint: NativeCheckpoint = {
  formatVersion: 1,
  runId: parseRunId("01J00000000000000000000012"),
  nativeRef: { runtimeId: "openai-runtime", kind: "openai_thread_id", value: "thread-1" },
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "native-checkpoint-"));
  roots.push(cwd);
  const signal = new AbortController().signal;
  const directory = join(cwd, getNativeCheckpointRelativePath(checkpoint.runId));
  return { cwd, directory, signal, ...checkpoint };
}

async function publish(input: Awaited<ReturnType<typeof fixture>>) {
  return createNativeCheckpoint({
    ...input,
    write: async (stage) => {
      await mkdir(join(stage, "history"));
      await writeFile(join(stage, "history/session.jsonl"), "saved history\n");
    },
  });
}

test.each([0o640, 0o751])(
  "reads source bytes and permission bits from the same file (%o)",
  async (mode) => {
    const input = await fixture();
    const path = join(input.cwd, "source");
    await writeFile(path, "native backup\n");
    await chmod(path, mode);
    await using directory = await open(input.cwd, "r");
    const source = await readNativeCheckpointSourceFile(directory, "source", input.signal);
    expect(source.bytes.toString()).toBe("native backup\n");
    expect(source.mode).toBe(mode);
  },
);

test.each(["before", "after"])(
  "excludes checkpoint bundles from Git initialized %s publication and repairs missing ignore rules",
  async (initialization) => {
    const input = await fixture();
    const initializeGit = () => {
      const result = spawnSync("git", ["-C", input.cwd, "init", "--quiet"]);
      expect(result.status).toBe(0);
    };
    if (initialization === "before") initializeGit();
    await publish(input);
    if (initialization === "after") initializeGit();
    const userExclude = join(input.cwd, ".git/info/exclude");
    await writeFile(userExclude, "user-managed-file\n");
    const ignore = join(dirname(input.directory), ".gitignore");
    expect(await readFile(ignore, "utf8")).toBe("*\n");
    await rm(ignore);
    await createNativeCheckpoint({
      ...input,
      write: async () => {
        throw new Error("must reuse the existing bundle");
      },
    });
    expect(await readFile(ignore, "utf8")).toBe("*\n");
    expect(await readFile(userExclude, "utf8")).toBe("user-managed-file\n");
    const paths = [
      `${getNativeCheckpointRelativePath(checkpoint.runId)}/history/session.jsonl`,
      ".state/native-checkpoints/.gitignore",
      ".state/native-checkpoints/.pending.tmp/nested/payload",
    ];
    const checked = spawnSync(
      "git",
      ["-C", input.cwd, "check-ignore", "--no-index", "--", ...paths],
      {
        encoding: "utf8",
      },
    );
    expect(checked.status).toBe(0);
    expect(checked.stdout.trimEnd().split("\n")).toEqual(paths);
  },
);

test.each(["symlink", "hardlink", "directory", "fifo"])(
  "rejects a %s at the checkpoint Git ignore path before exporting",
  async (kind) => {
    const input = await fixture();
    const parent = dirname(input.directory);
    const outside = join(input.cwd, "private.txt");
    const ignore = join(parent, ".gitignore");
    await mkdir(parent, { recursive: true });
    await writeFile(outside, "private");
    if (kind === "symlink") await symlink(outside, ignore);
    else if (kind === "hardlink") await link(outside, ignore);
    else if (kind === "directory") await mkdir(ignore);
    else expect(spawnSync("mkfifo", [ignore]).status).toBe(0);
    let exported = false;
    await expect(
      createNativeCheckpoint({
        ...input,
        write: async () => {
          exported = true;
        },
      }),
    ).rejects.toThrow();
    expect(exported).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("private");
    expect(await readdir(parent)).toEqual([".gitignore"]);
  },
);

test("publishes a durable file manifest and reuses a validated checkpoint without exporting again", async () => {
  const input = await fixture();
  expect(await publish(input)).toEqual(checkpoint);
  const saved = await readNativeCheckpoint({ cwd: input.cwd, checkpoint });
  expect(saved.directory).toBe(input.directory);
  expect(saved.manifest).toEqual({
    ...checkpoint,
    files: [
      {
        path: "history/session.jsonl",
        size: 14,
        sha256: createHash("sha256").update("saved history\n").digest("hex"),
      },
    ],
  });
  expect((await saved.readFile("history/session.jsonl")).toString()).toBe("saved history\n");
  expect(
    await createNativeCheckpoint({
      ...input,
      write: async () => {
        throw new Error("must not export again");
      },
    }),
  ).toEqual(checkpoint);
  await expect(
    createNativeCheckpoint({
      ...input,
      nativeRef: { ...checkpoint.nativeRef, value: "another-thread" },
      write: async () => {},
    }),
  ).rejects.toThrow("identity");
  expect((await readdir(dirname(input.directory))).sort()).toEqual([
    ".gitignore",
    checkpoint.runId,
  ]);
});

test("rejects corrupt, extra and missing files and revalidates bytes consumed after read", async () => {
  const input = await fixture();
  await publish(input);
  const saved = await readNativeCheckpoint({ cwd: input.cwd, checkpoint });
  await writeFile(join(input.directory, "history/session.jsonl"), "other history\n");
  await expect(saved.readFile("history/session.jsonl")).rejects.toThrow("manifest");
  await expect(readNativeCheckpoint({ cwd: input.cwd, checkpoint })).rejects.toThrow("manifest");
  await writeFile(join(input.directory, "history/session.jsonl"), "saved history\n");
  await writeFile(join(input.directory, "extra.txt"), "unlisted");
  await expect(readNativeCheckpoint({ cwd: input.cwd, checkpoint })).rejects.toThrow("manifest");
  await rm(join(input.directory, "extra.txt"));
  await rm(join(input.directory, "history/session.jsonl"));
  await expect(readNativeCheckpoint({ cwd: input.cwd, checkpoint })).rejects.toThrow("manifest");
  await expect(saved.readFile("../outside")).rejects.toThrow("not in the manifest");
});

test.each(["symlink", "directory-symlink", "hardlink", "fifo"])(
  "rejects %s exports without following them during cleanup",
  async (kind) => {
    const input = await fixture();
    const outside = join(input.cwd, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "private.txt"), "private");
    await expect(
      createNativeCheckpoint({
        ...input,
        write: async (stage) => {
          const target = join(stage, "payload");
          if (kind === "symlink") {
            await symlink(join(outside, "private.txt"), target);
          } else if (kind === "directory-symlink") {
            await symlink(outside, target);
          } else if (kind === "hardlink") {
            await link(join(outside, "private.txt"), target);
          } else {
            const result = spawnSync("mkfifo", [target]);
            expect(result.status).toBe(0);
          }
        },
      }),
    ).rejects.toThrow();
    expect(await readFile(join(outside, "private.txt"), "utf8")).toBe("private");
    expect(await readdir(dirname(input.directory))).toEqual([".gitignore"]);
  },
);

test("rejects symlink ancestors and symlinks substituted after validation", async () => {
  const input = await fixture();
  const outside = join(input.cwd, "outside");
  await mkdir(outside);
  await symlink(outside, join(input.cwd, ".state"));
  await expect(publish(input)).rejects.toThrow("real directory");
  expect(await readdir(outside)).toEqual([]);
  await rm(join(input.cwd, ".state"));
  await publish(input);
  const saved = await readNativeCheckpoint({ cwd: input.cwd, checkpoint });
  await writeFile(join(outside, "session.jsonl"), "saved history\n");
  await rm(join(input.directory, "history"), { recursive: true });
  await symlink(outside, join(input.directory, "history"));
  await expect(saved.readFile("history/session.jsonl")).rejects.toThrow("real directory");
});

test("resolves a trusted cwd alias once and keeps restore anchored when the alias changes", async () => {
  const input = await fixture();
  const workspace = join(input.cwd, "workspace");
  const alias = join(input.cwd, "alias");
  const elsewhere = join(input.cwd, "elsewhere");
  await mkdir(workspace);
  await mkdir(elsewhere);
  await symlink(workspace, alias);
  await publish({ ...input, cwd: alias });
  const saved = await readNativeCheckpoint({ cwd: alias, checkpoint });
  await rm(alias);
  await symlink(elsewhere, alias);
  expect((await saved.readFile("history/session.jsonl")).toString()).toBe("saved history\n");
  expect(saved.directory).toBe(join(workspace, getNativeCheckpointRelativePath(checkpoint.runId)));
});

test("aborted exports remove only their staging directory", async () => {
  const input = await fixture();
  const controller = new AbortController();
  const otherStage = join(dirname(input.directory), ".other-export.tmp");
  await mkdir(otherStage, { recursive: true });
  await writeFile(join(otherStage, "keep.txt"), "another attempt");
  await expect(
    createNativeCheckpoint({
      ...input,
      signal: controller.signal,
      write: async (stage) => {
        await writeFile(join(stage, "payload"), "unfinished");
        controller.abort(new Error("cancel export"));
      },
    }),
  ).rejects.toThrow("cancel export");
  expect((await readdir(dirname(input.directory))).sort()).toEqual([
    ".gitignore",
    ".other-export.tmp",
  ]);
});

test("oversized payloads fail before hashing or allocating a restore buffer", async () => {
  const input = await fixture();
  await expect(
    createNativeCheckpoint({
      ...input,
      write: async (stage) => {
        await using file = await open(join(stage, "large"), "w");
        await file.truncate(MAX_NATIVE_CHECKPOINT_FILE_BYTES + 1);
      },
    }),
  ).rejects.toThrow("size limit");
  expect(await readdir(dirname(input.directory))).toEqual([".gitignore"]);
});

test("concurrent exports reuse the first complete checkpoint", async () => {
  const input = await fixture();
  const ready = Promise.withResolvers<void>();
  let writers = 0;
  const results = await Promise.all(
    ["first", "second"].map((value) =>
      createNativeCheckpoint({
        ...input,
        write: async (stage) => {
          await writeFile(join(stage, "payload"), value);
          writers += 1;
          if (writers === 2) ready.resolve();
          await ready.promise;
        },
      }),
    ),
  );
  expect(results).toEqual([checkpoint, checkpoint]);
  const saved = await readNativeCheckpoint({ cwd: input.cwd, checkpoint });
  expect(["first", "second"]).toContain((await saved.readFile("payload")).toString());
  expect((await readdir(dirname(input.directory))).sort()).toEqual([
    ".gitignore",
    checkpoint.runId,
  ]);
});

test("a failure after rename preserves the published checkpoint for retry", async () => {
  const input = await fixture();
  await mkdir(dirname(input.directory), { recursive: true });
  await using parent = await open(dirname(input.directory), "r");
  const parentStats = await parent.stat();
  const prototype = Object.getPrototypeOf(parent) as FileHandle;
  const originalSync = prototype.sync;
  let failed = false;
  const sync = spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
    const stats = await this.stat();
    if (
      !failed &&
      stats.ino === parentStats.ino &&
      stats.dev === parentStats.dev &&
      existsSync(input.directory)
    ) {
      failed = true;
      throw new Error("parent sync failed");
    }
    await originalSync.call(this);
  });
  try {
    await expect(publish(input)).rejects.toThrow("parent sync failed");
    expect(existsSync(join(input.directory, "manifest.json"))).toBe(true);
    expect(
      await createNativeCheckpoint({
        ...input,
        write: async () => {
          throw new Error("must reuse published files");
        },
      }),
    ).toEqual(checkpoint);
  } finally {
    sync.mockRestore();
  }
});

describe("manifest boundary", () => {
  const file = { path: "session.jsonl", size: 0, sha256: "a".repeat(64) };
  test.each([
    "",
    "../escape",
    "/absolute",
    "C:/absolute",
    "a//b",
    "a/./b",
    "a/../b",
    "a\\b",
    "a\u0000b",
    "manifest.json",
    "manifest.json/child",
  ])("rejects unsafe path %j", (path) => {
    expect(() =>
      parseNativeCheckpointManifest({ ...checkpoint, files: [{ ...file, path }] }),
    ).toThrow();
  });
  test("rejects duplicate, conflicting, invalid and inherited manifests", () => {
    for (const files of [
      [],
      [file, file],
      [file, { ...file, path: "session.jsonl/child" }],
      [{ ...file, size: -1 }],
      [{ ...file, size: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...file, size: MAX_NATIVE_CHECKPOINT_FILE_BYTES + 1 }],
      [{ ...file, sha256: "invalid" }],
      [Object.create(file)],
    ]) {
      expect(() => parseNativeCheckpointManifest({ ...checkpoint, files })).toThrow();
    }
    expect(() =>
      parseNativeCheckpointManifest(Object.create({ ...checkpoint, files: [file] })),
    ).toThrow();
  });
});
