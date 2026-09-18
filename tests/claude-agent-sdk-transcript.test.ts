import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitForClaudeTranscript } from "../src/runtimes/claude/agent-sdk-transcript";

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
      content: "x".repeat(70 * 1_024),
    })}\n`,
  );
  expect(await waitForClaudeTranscript(root, cursor, AbortSignal.timeout(3_000))).toBe(false);
});

test("cancellation interrupts the persistence wait", async () => {
  const { root } = await fixture();
  await expect(
    waitForClaudeTranscript(root, cursor, AbortSignal.timeout(30)),
  ).rejects.toMatchObject({ name: "AbortError" });
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
});
