import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  createDriverStartInputFromBootPayload,
  type DriverStartInput,
} from "../src/protocol/start";
import {
  getNativeCheckpointRelativePath,
  type NativeCheckpoint,
} from "../src/protocol/native-checkpoint";
import {
  createNativeCheckpoint,
  pinNativeCheckpointRoot,
  readNativeCheckpoint,
} from "../src/runtimes/native-checkpoint";
import {
  createOpenAiNativeCheckpoint,
  restoreOpenAiNativeCheckpoint,
} from "../src/runtimes/openai/native-checkpoint";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

const roots: string[] = [];
const threadId = "thread-checkpoint";
const turnId = "turn-checkpoint";
const historyPath = `sessions/2026/10/10/rollout-${threadId}.jsonl`;
const signal = new AbortController().signal;
const nativeRef = {
  kind: "openai_thread_id",
  runtimeId: "openai-runtime",
  value: threadId,
} as const;
function rollout(error: unknown = null) {
  return [
    { type: "session_meta", payload: { id: threadId, history_mode: "paginated" } },
    { type: "response_item", payload: { role: "user", content: "retained user context" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId, error } },
  ]
    .map((record) => JSON.stringify(record) + "\n")
    .join("");
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
async function fixture(contents = rollout()) {
  const cwd = await mkdtemp("/tmp/openai-native-checkpoint-");
  roots.push(cwd);
  const homePath = join(cwd, "home");
  await mkdir(dirname(join(homePath, historyPath)), { recursive: true });
  await writeFile(join(homePath, historyPath), contents);
  const payload = createDriverStartInputFromBootPayload({
    ...driverBootPayload,
    execution: {
      ...driverBootPayload.execution,
      session: {
        ...driverBootPayload.execution.session,
        cwd,
        nativeResumeRef: null,
        nativeCheckpoint: null,
        context: { ...driverBootPayload.execution.session.context, homePath },
      },
    },
  });
  return {
    cwd,
    root: await pinNativeCheckpointRoot(cwd),
    homePath,
    payload,
    runId: DRIVER_TEST_IDS.runId,
    threadId,
    turnId,
    signal,
  };
}

function resumePayload(payload: DriverStartInput, nativeCheckpoint: NativeCheckpoint | null) {
  return {
    ...payload,
    execution: {
      ...payload.execution,
      session: {
        ...payload.execution.session,
        nativeCheckpoint,
        nativeResumeRef: nativeRef,
      },
    },
  };
}

test("exports the completed native prefix and restores it after live home drift", async () => {
  const completed = rollout();
  const input = await fixture(
    completed +
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "later" } }) +
      "\n",
  );
  await writeFile(join(input.homePath, "auth.json"), "private");
  await writeFile(join(input.homePath, "config.toml"), "private");
  await mkdir(join(input.homePath, "memories"));
  await writeFile(join(input.homePath, "memories", "retained.bin"), new Uint8Array([0, 255, 3]));
  const checkpoint = await createOpenAiNativeCheckpoint(input);
  const saved = await readNativeCheckpoint({ cwd: input.cwd, checkpoint });
  expect(saved.manifest.files.map((file) => file.path)).toEqual([
    "memories/retained.bin",
    historyPath,
  ]);
  expect((await saved.readFile(historyPath)).toString()).toBe(completed);
  await writeFile(join(input.homePath, historyPath), "live drift");
  await writeFile(join(input.homePath, "state_5.sqlite"), "stale SQLite projection");
  await writeFile(join(input.homePath, "thread_history_1.sqlite-wal"), "stale WAL");
  await writeFile(join(input.homePath, "logs_2.sqlite"), "unrelated logging");
  await restoreOpenAiNativeCheckpoint(resumePayload(input.payload, checkpoint), signal);
  expect(await readFile(join(input.homePath, historyPath), "utf8")).toBe(completed);
  expect(await readFile(join(input.homePath, "memories/retained.bin"))).toEqual(
    Buffer.from([0, 255, 3]),
  );
  const homeEntries = await readdir(input.homePath);
  expect(homeEntries).not.toContain("state_5.sqlite");
  expect(homeEntries).not.toContain("thread_history_1.sqlite-wal");
  expect(homeEntries).toContain("logs_2.sqlite");
  expect(homeEntries.some((name) => name.startsWith(".checkpoint-restore-"))).toBe(false);
});

test.each([
  [
    "missing completion",
    JSON.stringify({ type: "session_meta", payload: { id: threadId } }) + "\n",
  ],
  ["failed completion", rollout({ message: "native failed" })],
  ["wrong turn", rollout().replace(turnId, "another-turn")],
  ["partial line", rollout().trimEnd()],
])("rejects %s before publishing a checkpoint", async (_name, contents) => {
  const input = await fixture(contents);
  await expect(createOpenAiNativeCheckpoint(input)).rejects.toThrow();
  expect(await readdir(join(input.cwd, ".state/native-checkpoints"))).toEqual([".gitignore"]);
});

test("rejects ambiguous current rollouts and symlinked source histories", async () => {
  const input = await fixture();
  const otherPath = join(input.homePath, "sessions/duplicate.jsonl");
  await writeFile(otherPath, rollout());
  await expect(createOpenAiNativeCheckpoint(input)).rejects.toThrow("one matching rollout");
  await rm(otherPath);
  const outside = join(input.cwd, "outside");
  await writeFile(outside, "outside");
  await symlink(outside, otherPath);
  await expect(createOpenAiNativeCheckpoint(input)).rejects.toThrow();
  expect(await readFile(outside, "utf8")).toBe("outside");
});

test("requires a matching checkpoint and rejects provider-unowned bundle paths", async () => {
  const input = await fixture();
  await expect(
    restoreOpenAiNativeCheckpoint(resumePayload(input.payload, null), signal),
  ).rejects.toThrow("required");
  const checkpoint = await createNativeCheckpoint({
    ...input,
    nativeRef,
    async write(stage) {
      await writeFile(join(stage, "auth.json"), "private");
    },
  });
  await expect(
    restoreOpenAiNativeCheckpoint(resumePayload(input.payload, checkpoint), signal),
  ).rejects.toThrow("unsupported file");
  expect(await readFile(join(input.homePath, historyPath), "utf8")).toBe(rollout());
  expect(await readdir(join(input.cwd, getNativeCheckpointRelativePath(input.runId)))).toContain(
    "manifest.json",
  );
});

test("rejects a symlinked restore destination without changing its target", async () => {
  const input = await fixture();
  const checkpoint = await createOpenAiNativeCheckpoint(input);
  await rm(join(input.homePath, "sessions"), { recursive: true });
  const outside = join(input.cwd, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "marker"), "preserved");
  await symlink(outside, join(input.homePath, "sessions"));
  await expect(
    restoreOpenAiNativeCheckpoint(resumePayload(input.payload, checkpoint), signal),
  ).rejects.toThrow("real directory");
  expect(await readFile(join(outside, "marker"), "utf8")).toBe("preserved");
});

test.each(["rename failure", "abort", "sync failure"])(
  "preserves the complete previous native home after a restore %s",
  async (failureKind) => {
    const input = await fixture();
    const checkpoint = await createOpenAiNativeCheckpoint(input);
    const directories = ["sessions", "archived_sessions", "memories", "memories_extensions"];
    for (const name of directories) {
      await mkdir(join(input.homePath, name), { recursive: true });
      await writeFile(join(input.homePath, name, "previous"), `previous ${name}`);
    }
    await writeFile(join(input.homePath, historyPath), "previous rollout");
    const projections = ["state_5.sqlite", "thread_history_1.sqlite-wal"];
    for (const name of projections) await writeFile(join(input.homePath, name), name);
    const controller = new AbortController();
    const failure = new Error(`Injected restore ${failureKind}`);
    const rename = fs.rename;
    let installed = false;
    let failed = false;
    const renameSpy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (
        failureKind === "rename failure" &&
        !failed &&
        typeof from === "string" &&
        typeof to === "string" &&
        basename(from) === "memories" &&
        basename(to) === "memories"
      ) {
        failed = true;
        throw failure;
      }
      await rename(from, to);
      if (
        !installed &&
        typeof from === "string" &&
        typeof to === "string" &&
        basename(from) === "sessions" &&
        basename(to) === "sessions"
      ) {
        installed = true;
        if (failureKind === "abort") controller.abort(failure);
      }
    });
    await using home = await fs.open(input.homePath, "r");
    const homeStats = await home.stat();
    const prototype = Object.getPrototypeOf(home) as FileHandle;
    const sync = prototype.sync;
    const syncSpy = spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
      if (failureKind === "sync failure" && installed && !failed) {
        const stats = await this.stat();
        if (stats.dev === homeStats.dev && stats.ino === homeStats.ino) {
          failed = true;
          throw failure;
        }
      }
      await sync.call(this);
    });
    try {
      await expect(
        restoreOpenAiNativeCheckpoint(resumePayload(input.payload, checkpoint), controller.signal),
      ).rejects.toThrow(failure.message);
      expect(installed).toBe(true);
      expect(await readFile(join(input.homePath, historyPath), "utf8")).toBe("previous rollout");
      for (const name of directories) {
        expect(await readFile(join(input.homePath, name, "previous"), "utf8")).toBe(
          `previous ${name}`,
        );
      }
      for (const name of projections) {
        expect(await readFile(join(input.homePath, name), "utf8")).toBe(name);
      }
      expect((await readdir(input.homePath)).sort()).toEqual(
        [...directories, ...projections].sort(),
      );
    } finally {
      renameSpy.mockRestore();
      syncSpy.mockRestore();
    }
  },
);

test("retains original native files when restoring the previous home also fails", async () => {
  const input = await fixture();
  const checkpoint = await createOpenAiNativeCheckpoint(input);
  await writeFile(join(input.homePath, historyPath), "previous rollout");
  const rename = fs.rename;
  let installationFailed = false;
  let rollbackFailed = false;
  const renameSpy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (typeof from === "string" && typeof to === "string") {
      if (basename(from) === "memories" && basename(to) === "memories") {
        installationFailed = true;
        throw new Error("Injected installation failure");
      }
      if (installationFailed && basename(from) === "sessions" && basename(to) === "sessions") {
        rollbackFailed = true;
        throw new Error("Injected rollback failure");
      }
    }
    await rename(from, to);
  });
  try {
    const failure = await restoreOpenAiNativeCheckpoint(
      resumePayload(input.payload, checkpoint),
      signal,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual(
      expect.arrayContaining(["Injected installation failure", "Injected rollback failure"]),
    );
    expect(rollbackFailed).toBe(true);
    const retainedStage = (await readdir(input.homePath)).find((name) =>
      name.startsWith(".checkpoint-restore-"),
    );
    expect(retainedStage).toBeDefined();
    expect(
      await readFile(
        join(
          input.homePath,
          retainedStage!,
          "sessions.previous",
          historyPath.slice("sessions/".length),
        ),
        "utf8",
      ),
    ).toBe("previous rollout");
  } finally {
    renameSpy.mockRestore();
  }
});
