import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunId } from "../src/protocol/id";
import { readNativeCheckpoint } from "../src/runtimes/native-checkpoint";
import {
  exportOpenCodeCheckpoint,
  readOpenCodeUsage,
  restoreOpenCodeCheckpoint,
} from "../src/runtimes/acp/opencode-checkpoint";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

function git(args: string[], cwd: string, input?: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-checkpoint-"));
  const dataPath = join(cwd, "native");
  await mkdir(dataPath);
  const database = new Database(join(dataPath, "opencode.db"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE event (id TEXT PRIMARY KEY, data TEXT);
    INSERT INTO session VALUES ('session-1', NULL), ('subagent-1', 'session-1'), ('unrelated', NULL);
    INSERT INTO message VALUES ('message-1', 'session-1', '{"role":"assistant","content":"preserved history"}');
    INSERT INTO event VALUES ('event-1', '{"native":"metadata"}');
  `);
  let nextPart = 0;
  const step = (session: string, input: number, output: number, cost: number) => {
    database.query("INSERT INTO part VALUES (?, ?, ?)").run(
      `part-${++nextPart}`,
      session,
      JSON.stringify({
        type: "step-finish",
        cost,
        tokens: { input, output, reasoning: 1, cache: { read: 2, write: 3 } },
      }),
    );
  };
  return {
    cwd,
    dataPath,
    database,
    step,
    async destroy() {
      database.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

const signal = () => new AbortController().signal;
const runId = DRIVER_TEST_IDS.runId as RunId;

describe("OpenCode native checkpoints", () => {
  test("seals a live WAL database and restores all native tables in a clean home", async () => {
    const state = await fixture();
    try {
      state.step("session-1", 100, 40, 1);
      state.step("subagent-1", 60, 30, 0.5);
      const baseline = readOpenCodeUsage(state.dataPath, "session-1");
      state.step("session-1", 5, 2, 0.02);
      state.step("session-1", 7, 3, 0.03);
      state.step("subagent-1", 11, 4, 0.04);
      state.step("unrelated", 900, 900, 100);
      await mkdir(join(state.dataPath, "tool-output"));
      await writeFile(join(state.dataPath, "tool-output", "tool-1"), "complete tool output");
      await mkdir(join(state.dataPath, "plans"));
      await writeFile(join(state.dataPath, "plans", "plan-1.md"), "native plan");
      await mkdir(join(state.dataPath, "storage", "session_diff"), { recursive: true });
      await writeFile(join(state.dataPath, "storage", "session_diff", "session-1.json"), "[]");
      await writeFile(join(state.dataPath, "auth.json"), "private provider credential");
      const exported = await exportOpenCodeCheckpoint({
        ...state,
        sessionId: "session-1",
        runId,
        baseline,
        signal: signal(),
      });
      expect(exported.usage).toMatchObject({
        inputTokens: 23,
        outputTokens: 9,
        thoughtTokens: 3,
        cachedReadTokens: 6,
        cachedWriteTokens: 9,
        totalTokens: 50,
      });
      expect(exported.usage.costAmount).toBeCloseTo(0.09);
      const saved = await readNativeCheckpoint({ cwd: state.cwd, checkpoint: exported.checkpoint });
      expect(saved.manifest.files.map((file) => file.path)).toEqual([
        "opencode.db",
        "plans/plan-1.md",
        "storage/session_diff/session-1.json",
        "tool-output/tool-1",
      ]);
      state.step("session-1", 1000, 1000, 5);
      const retry = await exportOpenCodeCheckpoint({
        ...state,
        sessionId: "session-1",
        runId,
        baseline,
        signal: signal(),
      });
      expect(retry).toEqual(exported);
      const restoredPath = join(state.cwd, "restored-native");
      await restoreOpenCodeCheckpoint({
        cwd: state.cwd,
        dataPath: restoredPath,
        checkpoint: exported.checkpoint,
        signal: signal(),
      });
      using restored = new Database(join(restoredPath, "opencode.db"), { readonly: true });
      expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(restored.query("SELECT data FROM message WHERE id = 'message-1'").get()).toEqual({
        data: '{"role":"assistant","content":"preserved history"}',
      });
      expect(restored.query("SELECT data FROM event").get()).toEqual({
        data: '{"native":"metadata"}',
      });
      expect(restored.query("SELECT count(*) AS count FROM part").get()).toEqual({ count: 6 });
      expect(await readFile(join(restoredPath, "tool-output", "tool-1"), "utf8")).toBe(
        "complete tool output",
      );
      expect(await readFile(join(restoredPath, "plans", "plan-1.md"), "utf8")).toBe("native plan");
      expect(
        await readFile(join(restoredPath, "storage", "session_diff", "session-1.json"), "utf8"),
      ).toBe("[]");
    } finally {
      await state.destroy();
    }
  });

  test("preserves dangling snapshot trees and borrowed Git objects without the original repository", async () => {
    const state = await fixture();
    try {
      const source = join(state.cwd, "source");
      await mkdir(source);
      git(["init", "--quiet"], source);
      await writeFile(join(source, "history.txt"), "native snapshot contents");
      git(["add", "history.txt"], source);
      const tree = git(["write-tree"], source);
      const unrelatedBlob = git(
        ["hash-object", "-w", "--stdin"],
        source,
        "unrelated historical content",
      );
      state.database
        .query("INSERT INTO part VALUES ('snapshot-part', 'session-1', ?)")
        .run(JSON.stringify({ type: "step-start", snapshot: tree }));
      const snapshot = join(state.dataPath, "snapshot", "project-1", "worktree-1");
      await mkdir(snapshot, { recursive: true });
      git(["init", "--quiet", "--bare", snapshot], state.cwd);
      await mkdir(join(snapshot, "objects", "info"), { recursive: true });
      await writeFile(
        join(snapshot, "objects", "info", "alternates"),
        `${join(source, ".git", "objects")}\n`,
      );
      expect(git(["--git-dir", snapshot, "show", `${tree}:history.txt`], state.cwd)).toBe(
        "native snapshot contents",
      );
      const baseline = readOpenCodeUsage(state.dataPath, "session-1");
      const exported = await exportOpenCodeCheckpoint({
        ...state,
        sessionId: "session-1",
        runId,
        baseline,
        signal: signal(),
      });
      await rm(source, { recursive: true });
      await rm(join(state.dataPath, "snapshot"), { recursive: true });
      const restoredPath = join(state.cwd, "restored-native");
      await restoreOpenCodeCheckpoint({
        cwd: state.cwd,
        dataPath: restoredPath,
        checkpoint: exported.checkpoint,
        signal: signal(),
      });
      expect(
        git(
          [
            "--git-dir",
            join(restoredPath, "snapshot", "project-1", "worktree-1"),
            "show",
            `${tree}:history.txt`,
          ],
          state.cwd,
        ),
      ).toBe("native snapshot contents");
      expect(() =>
        git(
          [
            "--git-dir",
            join(restoredPath, "snapshot", "project-1", "worktree-1"),
            "cat-file",
            "-e",
            unrelatedBlob,
          ],
          state.cwd,
        ),
      ).toThrow();
    } finally {
      await state.destroy();
    }
  });

  test("rejects native histories with invalid accounting instead of publishing zero usage", async () => {
    const state = await fixture();
    try {
      state.step("session-1", -1, 2, 0.01);
      expect(() => readOpenCodeUsage(state.dataPath, "session-1")).toThrow("invalid token count");
    } finally {
      await state.destroy();
    }
  });
});
