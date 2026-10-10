import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  cp,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { DriverStartInput } from "../src/protocol/start";
import {
  getNativeCheckpointRelativePath,
  type NativeCheckpoint,
} from "../src/protocol/native-checkpoint";
import { pinNativeCheckpointRoot, readNativeCheckpoint } from "../src/runtimes/native-checkpoint";
import {
  createClaudeNativeCheckpoint,
  restoreClaudeNativeCheckpoint,
} from "../src/runtimes/claude/agent-sdk-checkpoint";
import { bootPayload, DRIVER_TEST_IDS } from "./driver-runtime-boundary-fixtures";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-checkpoint-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const project = "-original-workspace";
  const sessionId = "631c3e00-9bc3-4400-ad66-e70f326a028e";
  const projectPath = join(home, "projects", project);
  await mkdir(cwd);
  const checkpointRoot = await pinNativeCheckpointRoot(cwd);
  await mkdir(projectPath, { recursive: true });
  const content = [{ type: "text", text: "saved answer" }];
  const message = {
    type: "assistant",
    uuid: "message-1",
    parentUuid: "user-1",
    isSidechain: false,
    sessionId,
    message: { role: "assistant", content },
  };
  const transcript = `${JSON.stringify({ type: "user", sessionId, uuid: "user-1", parentUuid: null, isSidechain: false, message: { role: "user", content: "hello" } })}\n${JSON.stringify(message)}\n`;
  await writeFile(join(projectPath, `${sessionId}.jsonl`), transcript);
  const payload = {
    ...bootPayload,
    runtime: "claude-agent-sdk",
    runtimeTransport: "claude-agent-sdk",
    execution: {
      ...bootPayload.execution,
      session: {
        ...bootPayload.execution.session,
        cwd,
        homePath: home,
        nativeCheckpoint: null,
        nativeResumeRef: null,
      },
    },
  } as DriverStartInput;
  const cursors = [{ sessionId, messageId: message.uuid, contentJson: JSON.stringify(content) }];
  const create = () =>
    createClaudeNativeCheckpoint({
      payload,
      root: checkpointRoot,
      runId: DRIVER_TEST_IDS.runId,
      sessionId,
      expectedTranscriptCursors: cursors,
      signal: new AbortController().signal,
    });
  const restore = (checkpoint: NativeCheckpoint, homePath = home, cwdPath = cwd) =>
    restoreClaudeNativeCheckpoint(
      {
        ...payload,
        execution: {
          ...payload.execution,
          session: {
            ...payload.execution.session,
            cwd: cwdPath,
            homePath,
            nativeCheckpoint: checkpoint,
            nativeResumeRef: checkpoint.nativeRef,
          },
        },
      },
      new AbortController().signal,
    );
  return {
    root,
    cwd,
    home,
    project,
    projectPath,
    sessionId,
    payload,
    transcript,
    cursors,
    create,
    restore,
  };
}

test("exports all acknowledged assistants and restores the sealed native session over stale projects", async () => {
  const f = await fixture();
  const agent = join(f.projectPath, f.sessionId, "subagents");
  await mkdir(agent, { recursive: true });
  const child = [{ type: "text", text: "child answer" }];
  await writeFile(
    join(agent, "agent-child.jsonl"),
    `${JSON.stringify({ type: "assistant", uuid: "child-1", parentUuid: null, isSidechain: true, sessionId: f.sessionId, message: { role: "assistant", content: child } })}\n`,
  );
  await writeFile(
    join(agent, "agent-child.meta.json"),
    JSON.stringify({ agentType: "fixture-worker", toolUseId: "tool-1" }),
  );
  f.cursors.push({
    sessionId: f.sessionId,
    messageId: "child-1",
    contentJson: JSON.stringify(child),
  });
  await writeFile(join(f.home, ".credentials.json"), "private authentication");
  await writeFile(join(f.cwd, "work.txt"), "current workspace");
  const checkpoint = await f.create();
  const saved = await readNativeCheckpoint({ cwd: f.cwd, checkpoint });
  expect(saved.manifest.files).toHaveLength(3);
  expect(saved.manifest.files.every((file) => file.path.startsWith(`projects/${f.project}/`))).toBe(
    true,
  );
  await writeFile(join(f.projectPath, `${f.sessionId}.jsonl`), "stale native state");
  await mkdir(join(f.home, "projects", "stale-project"));
  await writeFile(join(f.home, "projects", "stale-project", "other.jsonl"), "stale");
  await restoreClaudeNativeCheckpoint(
    {
      ...f.payload,
      execution: {
        ...f.payload.execution,
        session: {
          ...f.payload.execution.session,
          nativeCheckpoint: checkpoint,
          nativeResumeRef: checkpoint.nativeRef,
        },
      },
    },
    new AbortController().signal,
  );
  expect(await readFile(join(f.projectPath, `${f.sessionId}.jsonl`), "utf8")).toBe(f.transcript);
  expect(await Bun.file(join(f.home, "projects", "stale-project", "other.jsonl")).exists()).toBe(
    false,
  );
  expect(await readFile(join(f.home, ".credentials.json"), "utf8")).toBe("private authentication");
  expect(await readFile(join(f.cwd, "work.txt"), "utf8")).toBe("current workspace");
  expect(await readFile(join(agent, "agent-child.meta.json"), "utf8")).toContain("fixture-worker");
});

test("creates and validates a checkpoint in the pinned workspace after its cwd alias changes", async () => {
  const f = await fixture();
  const alias = join(f.root, "workspace-alias");
  const elsewhere = join(f.root, "elsewhere");
  await mkdir(elsewhere);
  await symlink(f.cwd, alias);
  const payload = {
    ...f.payload,
    execution: {
      ...f.payload.execution,
      session: { ...f.payload.execution.session, cwd: alias },
    },
  };
  const root = await pinNativeCheckpointRoot(alias);
  await rm(alias);
  await symlink(elsewhere, alias);

  const checkpoint = await createClaudeNativeCheckpoint({
    root,
    payload,
    runId: DRIVER_TEST_IDS.runId,
    sessionId: f.sessionId,
    expectedTranscriptCursors: f.cursors,
    signal: new AbortController().signal,
  });
  const saved = await readNativeCheckpoint({ cwd: f.cwd, checkpoint });

  expect(saved.directory).toBe(join(f.cwd, getNativeCheckpointRelativePath(checkpoint.runId)));
  expect((await saved.readFile(`projects/${f.project}/${f.sessionId}.jsonl`)).toString()).toBe(
    f.transcript,
  );
  expect(await readdir(elsewhere)).toEqual([]);
});

test("restores tool results to their original native home after that home is removed", async () => {
  const f = await fixture();
  const toolDirectory = join(f.projectPath, f.sessionId, "tool-results");
  const toolPath = join(toolDirectory, "tool-output.txt");
  const toolBytes = Buffer.from("complete tool output\n精确恢复\n");
  await mkdir(toolDirectory, { recursive: true });
  await writeFile(toolPath, toolBytes);
  const checkpoint = await f.create();
  const saved = await readNativeCheckpoint({ cwd: f.cwd, checkpoint });
  expect(await saved.readFile("native-home.json")).toEqual(
    Buffer.from(JSON.stringify({ configDir: f.home })),
  );
  expect(
    await saved.readFile(`projects/${f.project}/${f.sessionId}/tool-results/tool-output.txt`),
  ).toEqual(toolBytes);

  await rm(f.home, { recursive: true });
  await f.restore(checkpoint);

  expect(await readFile(toolPath)).toEqual(toolBytes);
  expect(await readFile(join(f.projectPath, `${f.sessionId}.jsonl`), "utf8")).toBe(f.transcript);
  expect((await readdir(f.home)).sort()).toEqual(["file-history", "projects"]);
});

test("rejects tool result recovery to another native home before changing its projects", async () => {
  const f = await fixture();
  const toolDirectory = join(f.projectPath, f.sessionId, "tool-results");
  await mkdir(toolDirectory, { recursive: true });
  await writeFile(join(toolDirectory, "tool-output.txt"), "tool output");
  const checkpoint = await f.create();
  const otherHome = join(f.root, "another-home");
  const otherProject = join(otherHome, "projects", "existing-project");
  await mkdir(otherProject, { recursive: true });
  await writeFile(join(otherProject, "preserve.jsonl"), "existing native state");

  await expect(f.restore(checkpoint, otherHome)).rejects.toThrow("original native home path");

  expect(await readFile(join(otherProject, "preserve.jsonl"), "utf8")).toBe(
    "existing native state",
  );
  expect(await readdir(otherHome)).toEqual(["projects"]);
  expect(await readdir(join(otherHome, "projects"))).toEqual(["existing-project"]);
  expect(await readFile(join(f.projectPath, `${f.sessionId}.jsonl`), "utf8")).toBe(f.transcript);
});

test("restores native file history bytes and modes after the native home is removed", async () => {
  const f = await fixture();
  const backupDirectory = join(f.home, "file-history", f.sessionId);
  const backupName = "0123456789abcdef@v1";
  const backupPath = join(backupDirectory, backupName);
  const backupBytes = Buffer.from("#!/bin/sh\nprintf 'original workspace bytes\\n'\n");
  await mkdir(backupDirectory, { recursive: true });
  await writeFile(backupPath, backupBytes, { mode: 0o751 });
  const timestamp = "2026-10-10T00:00:00.000Z";
  const snapshot = {
    type: "file-history-snapshot",
    messageId: "user-1",
    snapshot: {
      messageId: "user-1",
      trackedFileBackups: {
        "original.sh": {
          backupFileName: backupName,
          version: 1,
          backupTime: timestamp,
          realParentDir: f.cwd,
        },
      },
      timestamp,
    },
    isSnapshotUpdate: false,
  };
  const transcript = `${f.transcript}${JSON.stringify(snapshot)}\n`;
  await writeFile(join(f.projectPath, `${f.sessionId}.jsonl`), transcript);
  const checkpoint = await f.create();
  const saved = await readNativeCheckpoint({ cwd: f.cwd, checkpoint });
  expect(await saved.readFile(`file-history/${f.sessionId}/${backupName}`)).toEqual(backupBytes);

  await rm(f.home, { recursive: true });
  await f.restore(checkpoint);

  expect(await readFile(backupPath)).toEqual(backupBytes);
  expect((await stat(backupPath)).mode & 0o777).toBe(0o751);
  expect(await readFile(join(f.projectPath, `${f.sessionId}.jsonl`), "utf8")).toBe(transcript);
});

test("native file history permits a new home at the same workspace path", async () => {
  const f = await fixture();
  const backupDirectory = join(f.home, "file-history", f.sessionId);
  const backupName = "0123456789abcdef@v1";
  await mkdir(backupDirectory, { recursive: true });
  await writeFile(join(backupDirectory, backupName), "original workspace bytes", { mode: 0o751 });
  const checkpoint = await f.create();
  const otherHome = join(f.root, "another-home");
  await rm(f.home, { recursive: true });

  await f.restore(checkpoint, otherHome);

  const restoredBackup = join(otherHome, "file-history", f.sessionId, backupName);
  expect(await readFile(restoredBackup, "utf8")).toBe("original workspace bytes");
  expect((await stat(restoredBackup)).mode & 0o777).toBe(0o751);
  expect(
    await readFile(join(otherHome, "projects", f.project, `${f.sessionId}.jsonl`), "utf8"),
  ).toBe(f.transcript);
});

test("rejects native file history recovery at a different workspace before changing native state", async () => {
  const f = await fixture();
  const backupDirectory = join(f.home, "file-history", f.sessionId);
  const backupPath = join(backupDirectory, "0123456789abcdef@v1");
  await mkdir(backupDirectory, { recursive: true });
  await writeFile(backupPath, "checkpoint backup");
  const checkpoint = await f.create();
  const otherCwd = join(f.root, "another-workspace");
  const checkpointPath = getNativeCheckpointRelativePath(checkpoint.runId);
  await cp(join(f.cwd, checkpointPath), join(otherCwd, checkpointPath), { recursive: true });
  const transcriptPath = join(f.projectPath, `${f.sessionId}.jsonl`);
  await writeFile(transcriptPath, "existing native state");
  await writeFile(backupPath, "existing backup");

  await expect(f.restore(checkpoint, f.home, otherCwd)).rejects.toThrow(
    /original.*(?:cwd|workspace)/,
  );

  expect(await readFile(transcriptPath, "utf8")).toBe("existing native state");
  expect(await readFile(backupPath, "utf8")).toBe("existing backup");
  expect((await readdir(f.home)).sort()).toEqual(["file-history", "projects"]);
});

test.each(["unexpected.txt", "0123456789abcde@v1", "0123456789abcdef@v1.json"])(
  "rejects a native file history backup named %s",
  async (backupName) => {
    const f = await fixture();
    const backupDirectory = join(f.home, "file-history", f.sessionId);
    await mkdir(backupDirectory, { recursive: true });
    await writeFile(join(backupDirectory, backupName), "unsupported recovery data");

    await expect(f.create()).rejects.toThrow("unsupported recovery files");
    expect(
      await Bun.file(
        join(f.cwd, getNativeCheckpointRelativePath(DRIVER_TEST_IDS.runId), "manifest.json"),
      ).exists(),
    ).toBe(false);
  },
);

test.each(["symlink", "hardlink"] as const)(
  "rejects a native file history backup that is a %s",
  async (kind) => {
    const f = await fixture();
    const backupDirectory = join(f.home, "file-history", f.sessionId);
    await mkdir(backupDirectory, { recursive: true });
    const outside = join(f.root, "outside-backup");
    await writeFile(outside, "private source bytes");
    await (kind === "symlink" ? symlink : link)(
      outside,
      join(backupDirectory, "0123456789abcdef@v1"),
    );

    await expect(f.create()).rejects.toThrow();
    expect(
      await Bun.file(
        join(f.cwd, getNativeCheckpointRelativePath(DRIVER_TEST_IDS.runId), "manifest.json"),
      ).exists(),
    ).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("private source bytes");
  },
);

test("rolls back projects and file history if the second native tree cannot be installed", async () => {
  const f = await fixture();
  const backupDirectory = join(f.home, "file-history", f.sessionId);
  const backupPath = join(backupDirectory, "0123456789abcdef@v1");
  await mkdir(backupDirectory, { recursive: true });
  await writeFile(backupPath, "checkpoint backup");
  const checkpoint = await f.create();
  const transcriptPath = join(f.projectPath, `${f.sessionId}.jsonl`);
  await writeFile(transcriptPath, "existing native state");
  await writeFile(backupPath, "existing backup");
  const rename = fs.rename;
  let projectsInstalled = false;
  let historyInstallFailed = false;
  const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (
      typeof source === "string" &&
      typeof destination === "string" &&
      basename(source) === "file-history" &&
      basename(destination) === "file-history"
    ) {
      historyInstallFailed = true;
      throw new Error("Injected native file history installation failure");
    }
    await rename(source, destination);
    if (
      typeof source === "string" &&
      typeof destination === "string" &&
      basename(source) === "projects" &&
      basename(destination) === "projects"
    ) {
      projectsInstalled = true;
    }
  });
  try {
    await expect(f.restore(checkpoint)).rejects.toThrow(
      "Injected native file history installation failure",
    );
    expect(projectsInstalled).toBe(true);
    expect(historyInstallFailed).toBe(true);
    expect(await readFile(transcriptPath, "utf8")).toBe("existing native state");
    expect(await readFile(backupPath, "utf8")).toBe("existing backup");
    expect((await readdir(f.home)).sort()).toEqual(["file-history", "projects"]);
  } finally {
    renameSpy.mockRestore();
  }
});

test("requires complete files for tool outputs referenced by native history", async () => {
  const f = await fixture();
  const toolDirectory = join(f.projectPath, f.sessionId, "tool-results");
  const toolPath = join(toolDirectory, "tool-output.txt");
  const toolBytes = Buffer.from("complete tool output\n精确恢复\n");
  const entries = f.transcript
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  entries[1].parentUuid = "tool-result";
  entries.splice(
    1,
    0,
    {
      type: "assistant",
      uuid: "tool-call",
      sessionId: f.sessionId,
      parentUuid: "user-1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "example" } }],
      },
    },
    {
      type: "user",
      uuid: "tool-result",
      sessionId: f.sessionId,
      parentUuid: "tool-call",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Output saved to disk" }],
      },
      toolUseResult: {
        persistedOutputPath: toolPath,
        persistedOutputSize: toolBytes.length,
      },
    },
  );
  await writeFile(
    join(f.projectPath, `${f.sessionId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  await expect(f.create()).rejects.toThrow("missing a complete persisted tool output");

  await mkdir(toolDirectory, { recursive: true });
  await writeFile(toolPath, toolBytes.subarray(0, toolBytes.length - 1));
  await expect(f.create()).rejects.toThrow("missing a complete persisted tool output");

  await writeFile(toolPath, toolBytes);
  await expect(f.create()).resolves.toMatchObject({ nativeRef: { value: f.sessionId } });
});

test.each(["precompact.json", "custom-title.json"])(
  "skips optional native metadata %s",
  async (name) => {
    const f = await fixture();
    const sessionDirectory = join(f.projectPath, f.sessionId);
    await mkdir(sessionDirectory);
    await writeFile(
      join(sessionDirectory, name),
      JSON.stringify(
        name === "precompact.json" ? { summaryText: "cached" } : { customTitle: "display only" },
      ),
    );

    const checkpoint = await f.create();
    const saved = await readNativeCheckpoint({ cwd: f.cwd, checkpoint });

    expect(saved.manifest.files.map(({ path }) => path)).toEqual([
      `projects/${f.project}/${f.sessionId}.jsonl`,
    ]);
  },
);

test.each(["symlink", "hardlink"] as const)(
  "rejects a precomputed summary that is a %s",
  async (kind) => {
    const f = await fixture();
    const sessionDirectory = join(f.projectPath, f.sessionId);
    await mkdir(sessionDirectory);
    const outside = join(f.root, "outside-summary.json");
    await writeFile(outside, "private source bytes");
    await (kind === "symlink" ? symlink : link)(outside, join(sessionDirectory, "precompact.json"));

    await expect(f.create()).rejects.toThrow(
      kind === "symlink" ? "unsupported session directory" : "no hard links",
    );
    expect(
      await Bun.file(
        join(f.cwd, getNativeCheckpointRelativePath(DRIVER_TEST_IDS.runId), "manifest.json"),
      ).exists(),
    ).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("private source bytes");
  },
);

test("rejects replaced restore staging and rolls back the previous projects directory", async () => {
  const f = await fixture();
  const checkpoint = await f.create();
  const transcriptPath = join(f.projectPath, `${f.sessionId}.jsonl`);
  await writeFile(transcriptPath, "existing native state");
  const rename = fs.rename;
  let swapped = false;
  const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    await rename(source, destination);
    if (
      typeof destination !== "string" ||
      !basename(destination).startsWith(".projects.previous-")
    ) {
      return;
    }
    const stagingName = (await readdir(f.home)).find((name) =>
      name.startsWith(".projects.restore-"),
    );
    if (stagingName === undefined) throw new Error("Restore staging was not created.");
    const stagingPath = join(f.home, stagingName);
    await rename(stagingPath, join(f.root, "displaced-staging"));
    await mkdir(stagingPath);
    await writeFile(join(stagingPath, "injected.txt"), "untrusted replacement");
    swapped = true;
  });
  try {
    await expect(f.restore(checkpoint)).rejects.toThrow(
      "changed while managed files were being written",
    );
    expect(swapped).toBe(true);
    expect(await readFile(transcriptPath, "utf8")).toBe("existing native state");
    expect(await Bun.file(join(f.home, "projects", "injected.txt")).exists()).toBe(false);
    expect((await readdir(f.home)).some((name) => name.startsWith(".projects.previous-"))).toBe(
      false,
    );
  } finally {
    renameSpy.mockRestore();
  }
});

test("a successful provider result cannot seal a transcript missing acknowledged output", async () => {
  const f = await fixture();
  f.cursors.push({ sessionId: f.sessionId, messageId: "not-written", contentJson: "[]" });
  await expect(f.create()).rejects.toThrow("missing an acknowledged assistant record");
  expect(
    await Bun.file(
      join(f.cwd, getNativeCheckpointRelativePath(DRIVER_TEST_IDS.runId), "manifest.json"),
    ).exists(),
  ).toBe(false);
});

test("acknowledged assistants must belong to the native resume chain", async () => {
  const f = await fixture();
  const path = join(f.projectPath, `${f.sessionId}.jsonl`);
  const entries = f.transcript
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  entries[1].isSidechain = true;
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await expect(f.create()).rejects.toThrow("outside the native resume chain");
  entries[1].isSidechain = false;
  entries.push({ ...entries[1], uuid: "different-leaf" });
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await expect(f.create()).rejects.toThrow("outside the native resume chain");
});

test("rejects missing and cyclic ancestors of acknowledged output", async () => {
  const f = await fixture();
  const path = join(f.projectPath, `${f.sessionId}.jsonl`);
  const entries = f.transcript
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  await writeFile(path, `${JSON.stringify(entries[1])}\n`);
  await expect(f.create()).rejects.toThrow(/parent message/);

  entries[0].parentUuid = "message-1";
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await expect(f.create()).rejects.toThrow(/parent message/);
});

test("native compaction preserves earlier acknowledged output in the stored history", async () => {
  const f = await fixture();
  const content = [{ type: "text", text: "after compaction" }];
  const entries = [
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "compact",
      parentUuid: null,
      logicalParentUuid: "message-1",
      sessionId: f.sessionId,
      compactMetadata: { trigger: "auto", preTokens: 1000 },
    },
    {
      type: "user",
      uuid: "summary",
      parentUuid: "compact",
      sessionId: f.sessionId,
      isCompactSummary: true,
      message: { role: "user", content: "previous context" },
    },
    {
      type: "assistant",
      uuid: "message-2",
      parentUuid: "summary",
      sessionId: f.sessionId,
      message: { role: "assistant", content },
    },
  ];
  await writeFile(
    join(f.projectPath, `${f.sessionId}.jsonl`),
    f.transcript + `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  f.cursors.push({
    sessionId: f.sessionId,
    messageId: "message-2",
    contentJson: JSON.stringify(content),
  });
  const checkpoint = await f.create();
  const saved = await readNativeCheckpoint({ cwd: f.cwd, checkpoint });
  expect((await saved.readFile(`projects/${f.project}/${f.sessionId}.jsonl`)).toString()).toContain(
    "saved answer",
  );
});

test("accepts compacted preserved history whose original parent was pruned by the CLI", async () => {
  const f = await fixture();
  const previous = JSON.parse(f.transcript.trim().split("\n")[1]!);
  const content = [{ type: "text", text: "after preserved history" }];
  const entries = [
    previous,
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "compact",
      parentUuid: null,
      sessionId: f.sessionId,
      compactMetadata: {
        trigger: "auto",
        preTokens: 1000,
        preservedMessages: { anchorUuid: "compact", uuids: ["message-1"] },
      },
    },
    {
      type: "user",
      uuid: "summary",
      parentUuid: "compact",
      sessionId: f.sessionId,
      isCompactSummary: true,
      message: { role: "user", content: "previous context" },
    },
    {
      type: "assistant",
      uuid: "message-2",
      parentUuid: "summary",
      sessionId: f.sessionId,
      message: { role: "assistant", content },
    },
  ];
  const transcript = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(join(f.projectPath, `${f.sessionId}.jsonl`), transcript);
  f.cursors.push({
    sessionId: f.sessionId,
    messageId: "message-2",
    contentJson: JSON.stringify(content),
  });

  const checkpoint = await f.create();
  const saved = await readNativeCheckpoint({ cwd: f.cwd, checkpoint });

  expect((await saved.readFile(`projects/${f.project}/${f.sessionId}.jsonl`)).toString()).toBe(
    transcript,
  );
});

test("retries use the first immutable checkpoint when live native state has advanced", async () => {
  const f = await fixture();
  const first = await f.create();
  await writeFile(join(f.projectPath, `${f.sessionId}.jsonl`), "broken live state");
  expect(await f.create()).toEqual(first);
  const saved = await readNativeCheckpoint({ cwd: f.cwd, checkpoint: first });
  expect((await saved.readFile(`projects/${f.project}/${f.sessionId}.jsonl`)).toString()).toBe(
    f.transcript,
  );
});

test("rejects source symlinks and unsupported credential files instead of packaging them", async () => {
  const f = await fixture();
  const transcript = join(f.projectPath, `${f.sessionId}.jsonl`);
  await writeFile(join(f.root, "outside.jsonl"), f.transcript);
  await rm(transcript);
  await symlink(join(f.root, "outside.jsonl"), transcript);
  await expect(f.create()).rejects.toThrow("regular file without links");
  await rm(transcript);
  await writeFile(transcript, f.transcript);
  await mkdir(join(f.projectPath, f.sessionId));
  await writeFile(join(f.projectPath, f.sessionId, "credentials.json"), "secret");
  await expect(f.create()).rejects.toThrow("unsupported session directory");
});

test("rejects incomplete records and mismatched session IDs", async () => {
  const f = await fixture();
  const path = join(f.projectPath, `${f.sessionId}.jsonl`);
  await writeFile(path, f.transcript.trimEnd());
  await expect(f.create()).rejects.toThrow("incomplete record");
  await writeFile(path, f.transcript.replaceAll(f.sessionId, "different-session"));
  await expect(f.create()).rejects.toThrow("different native session");
});

test("restore rejects a changed bundle before touching existing native state", async () => {
  const f = await fixture();
  const checkpoint = await f.create();
  await writeFile(
    join(
      f.cwd,
      getNativeCheckpointRelativePath(checkpoint.runId),
      "projects",
      f.project,
      `${f.sessionId}.jsonl`,
    ),
    "tampered",
  );
  await expect(
    restoreClaudeNativeCheckpoint(
      {
        ...f.payload,
        execution: {
          ...f.payload.execution,
          session: {
            ...f.payload.execution.session,
            nativeCheckpoint: checkpoint,
            nativeResumeRef: checkpoint.nativeRef,
          },
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("manifest");
  expect(await readFile(join(f.projectPath, `${f.sessionId}.jsonl`), "utf8")).toBe(f.transcript);
});

test("restore cannot follow a native home symlink or an unmatched resume ref", async () => {
  const f = await fixture();
  const checkpoint = await f.create();
  const session = {
    ...f.payload.execution.session,
    nativeCheckpoint: checkpoint,
    nativeResumeRef: checkpoint.nativeRef,
  };
  const restore = (replacement: typeof session) =>
    restoreClaudeNativeCheckpoint(
      { ...f.payload, execution: { ...f.payload.execution, session: replacement } },
      new AbortController().signal,
    );
  await expect(
    restore({ ...session, nativeResumeRef: { ...checkpoint.nativeRef, value: "other" } }),
  ).rejects.toThrow("does not match");
  const link = join(f.root, "linked-home");
  await symlink(f.home, link);
  await expect(restore({ ...session, homePath: link })).rejects.toThrow("real directory");
  expect(await readFile(join(f.projectPath, `${f.sessionId}.jsonl`), "utf8")).toBe(f.transcript);
});
