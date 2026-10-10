import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  createDriverStartInputFromBootPayload,
  type DriverStartInput,
} from "../src/protocol/start";
import {
  getNativeCheckpointRelativePath,
  type NativeCheckpoint,
} from "../src/protocol/native-checkpoint";
import { createNativeCheckpoint, readNativeCheckpoint } from "../src/runtimes/native-checkpoint";
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
  return { cwd, homePath, payload, runId: DRIVER_TEST_IDS.runId, threadId, turnId, signal };
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
