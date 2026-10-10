import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFile, link, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitForClaudeTranscript } from "../src/runtimes/claude/agent-sdk-transcript";
import { settlePromiseWithTimeout } from "../src/utils/async";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-"));
  roots.push(root);
  const project = join(root, "projects", "-workspace");
  await mkdir(project, { recursive: true });
  return { root, path: join(project, "session-1.jsonl") };
}

const cursor = {
  sessionId: "session-1",
  messageId: "assistant-1",
  contentJson: JSON.stringify("OK"),
};
const entry = JSON.stringify({
  type: "assistant",
  uuid: cursor.messageId,
  message: { content: "OK" },
});

test("waits for a complete assistant record, ignoring matching IDs inside user content", async () => {
  const { root, path } = await fixture();
  await writeFile(path, `${JSON.stringify({ type: "user", content: entry })}\n`);
  let settled = false;
  const pending = waitForClaudeTranscript(root, cursor, AbortSignal.timeout(3_000)).then(
    (value) => {
      settled = true;
      return value;
    },
  );
  await Bun.sleep(40);
  expect(settled).toBe(false);
  await appendFile(path, entry);
  await Bun.sleep(40);
  expect(settled).toBe(false);
  await appendFile(path, "\n");
  expect(await pending).toBe(true);
});

test("finds the latest record after a large history without requiring earlier records", async () => {
  const { root, path } = await fixture();
  await writeFile(path, `${"x".repeat(2 * 1_024 * 1_024)}\n${entry}\n`);
  expect(await waitForClaudeTranscript(root, cursor, new AbortController().signal)).toBe(true);
});

test.each([true, false])(
  "finds the assistant before a large trailing attachment (complete=%s)",
  async (complete) => {
    const { root, path } = await fixture();
    const attachment = JSON.stringify({
      type: "attachment",
      content: "x".repeat(2 * 1_024 * 1_024),
    });
    await writeFile(path, `${entry}\n${attachment}${complete ? "\n" : ""}`);
    expect(await waitForClaudeTranscript(root, cursor, AbortSignal.timeout(3_000))).toBe(true);
  },
);

test("reassembles a complete assistant record split across read chunks", async () => {
  const { root, path } = await fixture();
  const content = "开始😀结束".repeat(100);
  const record = JSON.stringify({
    type: "assistant",
    uuid: cursor.messageId,
    message: { content },
  });
  const attachment = JSON.stringify({ type: "attachment", content: "" });
  const padding = 64 * 1_024 - Math.floor(Buffer.byteLength(record) / 2) - attachment.length - 1;
  await writeFile(
    path,
    `${record}\n${JSON.stringify({ type: "attachment", content: "x".repeat(padding) })}\n`,
  );
  expect(
    await waitForClaudeTranscript(
      root,
      { ...cursor, contentJson: JSON.stringify(content) },
      AbortSignal.timeout(3_000),
    ),
  ).toBe(true);
});

test("an earlier assistant revision with the same UUID is not a complete checkpoint", async () => {
  const { root, path } = await fixture();
  await writeFile(
    path,
    `${JSON.stringify({ type: "assistant", uuid: cursor.messageId, message: { content: "O" } })}\n`,
  );
  let settled = false;
  const pending = waitForClaudeTranscript(root, cursor, AbortSignal.timeout(3_000)).then(
    (value) => {
      settled = true;
      return value;
    },
  );
  await Bun.sleep(40);
  expect(settled).toBe(false);
  await appendFile(path, `${entry}\n`);
  expect(await pending).toBe(true);
});

test("missing transcripts time out to the query-close fallback", async () => {
  const { root } = await fixture();
  expect(await waitForClaudeTranscript(root, cursor, AbortSignal.timeout(3_000))).toBe(false);
});

test("oversized final records conservatively use the query-close fallback", async () => {
  const { root, path } = await fixture();
  await writeFile(
    path,
    `${JSON.stringify({
      type: "assistant",
      uuid: cursor.messageId,
      message: { content: "OK" },
      metadata: "x".repeat(70 * 1_024),
    })}\n`,
  );
  expect(await waitForClaudeTranscript(root, cursor, AbortSignal.timeout(3_000))).toBe(false);
});

test("cancellation interrupts the persistence wait", async () => {
  const { root } = await fixture();
  const cancellation = new AbortController();
  const reason = new Error("test.cancel");
  const waiting = waitForClaudeTranscript(root, cursor, cancellation.signal);
  await Bun.sleep(30);
  cancellation.abort(reason);
  await expect(waiting).rejects.toBe(reason);
});

test("cancellation interrupts a scan through an oversized record", async () => {
  const { root, path } = await fixture();
  await using file = await open(path, "w");
  await file.truncate(256 * 1_024 * 1_024);
  const cancellation = new AbortController();
  const reason = new Error("test.cancel.scan");
  const waiting = waitForClaudeTranscript(root, cursor, cancellation.signal);
  await Bun.sleep(5);
  cancellation.abort(reason);
  await expect(waiting).rejects.toBe(reason);
});

test.each(["deadline", "cancellation"])(
  "%s returns while a stalled read retains its eventual file cleanup",
  async (mode) => {
    const { root, path } = await fixture();
    await writeFile(path, `${entry}\n`);
    const handle = await open(path, "r");
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let readingFd: number | null = null;
    const readSpy = spyOn(prototype, "read").mockImplementation(async function (this: FileHandle) {
      readingFd = this.fd;
      entered.resolve();
      await release.promise;
      return { bytesRead: 0, buffer: Buffer.alloc(0) };
    });
    const originalClose = handle.close;
    const closeSpy = spyOn(prototype, "close").mockImplementation(
      async function (this: FileHandle) {
        const fd = this.fd;
        await originalClose.call(this);
        if (fd === readingFd) closed.resolve();
      },
    );
    const cancellation = new AbortController();
    const reason = new Error("test.cancel.stalled");
    try {
      const waiting = waitForClaudeTranscript(root, cursor, cancellation.signal);
      await entered.promise;
      if (mode === "cancellation") cancellation.abort(reason);
      expect(
        await settlePromiseWithTimeout(waiting, {
          label: "stalled transcript read",
          timeoutMs: 1_500,
        }),
      ).toEqual(
        mode === "cancellation"
          ? { status: "failed", error: reason }
          : { status: "completed", value: false },
      );
    } finally {
      release.resolve();
      await closed.promise;
      readSpy.mockRestore();
      closeSpy.mockRestore();
    }
  },
);

test.each(["symlink", "hardlink", "directory", "fifo"])(
  "a transcript %s cannot be read or block the persistence wait",
  async (kind) => {
    const { root, path } = await fixture();
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, `${entry}\n`);
    if (kind === "symlink") await symlink(outside, path);
    else if (kind === "hardlink") await link(outside, path);
    else if (kind === "directory") await mkdir(path);
    else expect(spawnSync("mkfifo", [path]).status).toBe(0);
    expect(await waitForClaudeTranscript(root, cursor, AbortSignal.timeout(500))).toBe(false);
  },
);

test("symlinked transcript ancestors cannot select an outside transcript", async () => {
  const { root, path } = await fixture();
  await writeFile(path, `${entry}\n`);
  const alias = join(root, "config-alias");
  await symlink(root, alias);
  expect(await waitForClaudeTranscript(alias, cursor, AbortSignal.timeout(500))).toBe(false);
});

test("absent cursors and unsafe session IDs cannot select a transcript", async () => {
  const { root } = await fixture();
  expect(await waitForClaudeTranscript(root, null, new AbortController().signal)).toBe(false);
  expect(
    await waitForClaudeTranscript(
      root,
      { ...cursor, sessionId: "../session-1" },
      new AbortController().signal,
    ),
  ).toBe(false);
  expect(
    await waitForClaudeTranscript(
      root,
      { ...cursor, contentJson: JSON.stringify("x".repeat(70 * 1_024)) },
      new AbortController().signal,
    ),
  ).toBe(false);
});
