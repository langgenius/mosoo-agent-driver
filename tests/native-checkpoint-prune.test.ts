import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseRunId } from "../src/protocol/id";
import { getNativeCheckpointRelativePath } from "../src/protocol/native-checkpoint";
import {
  createNativeCheckpoint,
  pinNativeCheckpointRoot,
  pruneNativeCheckpoints,
} from "../src/runtimes/native-checkpoint";
import { createTestNativeCheckpoint, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "checkpoint-prune-"));
  roots.push(cwd);
  return cwd;
}

async function bundle(cwd: string, runId = DRIVER_TEST_IDS.runId) {
  const checkpoint = createTestNativeCheckpoint(runId);
  await createNativeCheckpoint({
    root: await pinNativeCheckpointRoot(cwd),
    ...checkpoint,
    signal: new AbortController().signal,
    write: async (directory) => {
      await writeFile(join(directory, "session.json"), "native history");
    },
  });
  return checkpoint;
}

test("prunes old immutable bundles while retaining the committed bundle and staging directories", async () => {
  const cwd = await fixture();
  const root = await pinNativeCheckpointRoot(cwd);
  const old = await bundle(cwd);
  const current = await bundle(cwd, DRIVER_TEST_IDS.secondRunId);
  const parent = dirname(join(cwd, getNativeCheckpointRelativePath(old.runId)));
  const staging = `.${old.runId}.pending.tmp`;
  await mkdir(join(parent, staging));

  await pruneNativeCheckpoints(root, current);

  expect((await readdir(parent)).sort()).toEqual([".gitignore", staging, current.runId].sort());
  expect(await readFile(join(parent, current.runId, "session.json"), "utf8")).toBe(
    "native history",
  );
  await pruneNativeCheckpoints(root, current);
  await pruneNativeCheckpoints(root, null);
  expect((await readdir(parent)).sort()).toEqual([".gitignore", staging].sort());
});

test.each(["symlink", "hardlink", "directory", "fifo", "changed contents"])(
  "rejects a checkpoint Git ignore file with %s before pruning any bundles",
  async (kind) => {
    const cwd = await fixture();
    const root = await pinNativeCheckpointRoot(cwd);
    const checkpoint = await bundle(cwd);
    const parent = dirname(join(cwd, getNativeCheckpointRelativePath(checkpoint.runId)));
    const ignore = join(parent, ".gitignore");
    const outside = join(cwd, "private.txt");
    await writeFile(outside, "private");
    await rm(ignore);
    if (kind === "symlink") await symlink(outside, ignore);
    else if (kind === "hardlink") await link(outside, ignore);
    else if (kind === "directory") await mkdir(ignore);
    else if (kind === "fifo") expect(spawnSync("mkfifo", [ignore]).status).toBe(0);
    else await writeFile(ignore, "!\n");
    await expect(pruneNativeCheckpoints(root, null)).rejects.toThrow();
    expect(await readFile(join(parent, checkpoint.runId, "session.json"), "utf8")).toBe(
      "native history",
    );
    expect(await readFile(outside, "utf8")).toBe("private");
  },
);

test.each([".state", ".state/native-checkpoints"])(
  "does not follow a symlink at %s while pruning",
  async (location) => {
    const cwd = await fixture();
    const root = await pinNativeCheckpointRoot(cwd);
    const outside = await fixture();
    const checkpoint = await bundle(outside);
    const outsideRoot =
      location === ".state"
        ? join(outside, ".state")
        : dirname(join(outside, getNativeCheckpointRelativePath(checkpoint.runId)));
    await mkdir(dirname(join(cwd, location)), { recursive: true });
    await symlink(outsideRoot, join(cwd, location));

    await expect(pruneNativeCheckpoints(root, null)).rejects.toThrow();
    expect(
      await readFile(
        join(outside, getNativeCheckpointRelativePath(checkpoint.runId), "session.json"),
        "utf8",
      ),
    ).toBe("native history");
  },
);

test("does not follow a cwd symlink introduced before pruning", async () => {
  const root = await fixture();
  const outside = await fixture();
  const checkpoint = await bundle(outside);
  const cwd = join(root, "session");
  await mkdir(cwd);
  const pinnedRoot = await pinNativeCheckpointRoot(cwd);
  await rm(cwd, { recursive: true });
  await symlink(outside, cwd);

  await expect(pruneNativeCheckpoints(pinnedRoot, null)).rejects.toThrow();
  expect(
    await readFile(
      join(outside, getNativeCheckpointRelativePath(checkpoint.runId), "session.json"),
      "utf8",
    ),
  ).toBe("native history");
});

test("does not follow a bundle symlink or nested symlink outside the checkpoint root", async () => {
  const cwd = await fixture();
  const root = await pinNativeCheckpointRoot(cwd);
  const outside = await fixture();
  const checkpoint = await bundle(cwd);
  const directory = join(cwd, getNativeCheckpointRelativePath(checkpoint.runId));
  await writeFile(join(outside, "private.txt"), "keep");
  await symlink(outside, join(directory, "foreign"));
  await pruneNativeCheckpoints(root, null);
  expect(await readFile(join(outside, "private.txt"), "utf8")).toBe("keep");

  const linkId = parseRunId("01J00000000000000000000099");
  await symlink(outside, join(dirname(directory), linkId));
  await expect(pruneNativeCheckpoints(root, null)).rejects.toThrow();
  expect(await readFile(join(outside, "private.txt"), "utf8")).toBe("keep");
});

test("allows an empty checkpoint store but rejects a removed pinned root", async () => {
  const cwd = await fixture();
  const root = await pinNativeCheckpointRoot(cwd);
  await pruneNativeCheckpoints(root, null);
  expect(await readdir(cwd)).toEqual([]);
  await rm(cwd, { recursive: true });
  await expect(pruneNativeCheckpoints(root, null)).rejects.toThrow();
});

test("keeps cleanup anchored to a trusted cwd alias after the alias is replaced", async () => {
  const parent = await fixture();
  const cwd = join(parent, "session");
  const alias = join(parent, "alias");
  await mkdir(cwd);
  await symlink(cwd, alias);
  const root = await pinNativeCheckpointRoot(alias);
  const old = await bundle(alias);
  const current = await bundle(alias, DRIVER_TEST_IDS.secondRunId);
  const outside = await fixture();
  await bundle(outside);
  await rm(alias);
  await symlink(outside, alias);

  await pruneNativeCheckpoints(root, current);

  expect(
    (await readdir(dirname(join(cwd, getNativeCheckpointRelativePath(old.runId))))).sort(),
  ).toEqual([".gitignore", current.runId]);
  expect(
    await readFile(
      join(outside, getNativeCheckpointRelativePath(old.runId), "session.json"),
      "utf8",
    ),
  ).toBe("native history");
});

test("rejects a real directory substituted for the pinned root", async () => {
  const parent = await fixture();
  const cwd = join(parent, "session");
  const moved = join(parent, "original-session");
  await mkdir(cwd);
  const root = await pinNativeCheckpointRoot(cwd);
  const original = await bundle(cwd);
  await rename(cwd, moved);
  await mkdir(cwd);
  const replacement = await bundle(cwd, DRIVER_TEST_IDS.secondRunId);

  await expect(pruneNativeCheckpoints(root, null)).rejects.toThrow("root changed after startup");
  for (const [directory, checkpoint] of [
    [moved, original],
    [cwd, replacement],
  ] as const) {
    expect(
      await readFile(
        join(directory, getNativeCheckpointRelativePath(checkpoint.runId), "session.json"),
        "utf8",
      ),
    ).toBe("native history");
  }
});
