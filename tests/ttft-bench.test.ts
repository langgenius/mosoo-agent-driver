import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { measureRun, stopAndCleanup, type Scenario } from "../bench/ttft-bench";
import type { AgentDriverKernel } from "../src/core/agent-driver-kernel";
import { AsyncValueQueue } from "../src/core/async-value-queue";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverId, parseRunId } from "../src/protocol/id";
import { createNativeCheckpoint, pinNativeCheckpointRoot } from "../src/runtimes/native-checkpoint";

const scenario: Scenario = {
  id: "test",
  prompt: "pong",
  systemPrompt: "test",
  permission: "allow_once",
  expect: "pong",
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("benchmark filters Run identities, waits for settlement, and validates each checkpoint", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ttft-check-"));
  roots.push(cwd);
  const root = await pinNativeCheckpointRoot(cwd);
  const events = new AsyncValueQueue<DriverEventInput>("bench test", 20);
  const identities: string[] = [];
  const kernel: AgentDriverKernel = {
    start: async () => {},
    stop: async () => {},
    cancel: async () => {},
    events: () => events.values(),
    dispatch: async (command) => {
      if (command.kind !== "input.start") throw new Error("unexpected command");
      const runId = parseRunId(command.runId);
      identities.push(runId, command.commandId, command.requestId!);
      const checkpoint = await createNativeCheckpoint({
        root,
        runId,
        nativeRef: { runtimeId: "openai-runtime", kind: "openai_thread_id", value: "native-test" },
        signal: new AbortController().signal,
        write: async (stage) => {
          await writeFile(join(stage, "session.jsonl"), "native history\n");
        },
      });
      const otherRun = parseRunId(createDriverId());
      events.push({
        kind: "message.delta",
        runId: otherRun,
        payload: { contentDelta: "stale output" },
      });
      events.push({ kind: "run.completed", runId: otherRun, payload: {} });
      events.push({
        kind: "message.delta",
        runId,
        payload: { contentDelta: "pong" },
      });
      events.push({ kind: "run.completed", runId, payload: { checkpoint } });
      await Bun.sleep(25);
    },
  };
  const iterator = events.values()[Symbol.asyncIterator]();
  for (const phase of ["cold", "reuse"] as const) {
    const result = await measureRun({
      kernel,
      events: iterator,
      phase,
      bootMs: 0,
      cwd,
      scenario,
      timeoutMs: 500,
      cleanupTimeoutMs: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.outputChars).toBe(4);
    expect(result.deltaCount).toBe(1);
    expect(result.settledMs! - result.terminalMs!).toBeGreaterThanOrEqual(15);
    expect(result.checkpoint?.runId).toBe(result.runId);
    expect(result.checkpointBytes).toBe(15);
  }
  expect(new Set(identities).size).toBe(6);
});

test("a stalled dispatch and cancellation both have deadlines", async () => {
  const events = new AsyncValueQueue<DriverEventInput>("stalled bench", 1);
  let cancels = 0;
  const never = new Promise<void>(() => {});
  const kernel: AgentDriverKernel = {
    start: async () => {},
    stop: async () => {},
    events: () => events.values(),
    dispatch: () => never,
    cancel: () => {
      cancels++;
      return never;
    },
  };
  const start = Date.now();
  const result = await measureRun({
    kernel,
    events: events.values()[Symbol.asyncIterator](),
    phase: "cold",
    bootMs: 0,
    cwd: tmpdir(),
    scenario,
    timeoutMs: 15,
    cleanupTimeoutMs: 15,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("turn_timeout");
  expect(result.error).toContain("cancel_timeout");
  expect(result.error).toContain("settle_timeout");
  expect(result.settledMs).toBeNull();
  expect(cancels).toBe(1);
  expect(Date.now() - start).toBeLessThan(500);
  events.close();
});

test("a cancelled terminal waits for the cancellation command to settle", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ttft-cancel-"));
  roots.push(cwd);
  await writeFile(join(cwd, ".bench-cancel-started"), "started");
  const events = new AsyncValueQueue<DriverEventInput>("cancel bench", 1);
  let cancels = 0;
  let runId: ReturnType<typeof parseRunId>;
  let settleDispatch: () => void = () => {};
  const kernel: AgentDriverKernel = {
    start: async () => {},
    stop: async () => {},
    events: () => events.values(),
    dispatch: (command) => {
      if (command.kind !== "input.start") throw new Error("unexpected command");
      runId = parseRunId(command.runId);
      return new Promise<void>((resolve) => {
        settleDispatch = resolve;
      });
    },
    cancel: () => {
      cancels++;
      events.push({ kind: "run.cancelled", runId, payload: {} });
      settleDispatch();
      return new Promise<void>(() => {});
    },
  };
  const result = await measureRun({
    kernel,
    events: events.values()[Symbol.asyncIterator](),
    phase: "cancel",
    bootMs: 0,
    cwd,
    scenario,
    timeoutMs: 500,
    cleanupTimeoutMs: 20,
  });
  expect(result.terminal).toBe("cancelled");
  expect(result.ok).toBe(false);
  expect(result.error).toContain("cancel_timeout");
  expect(cancels).toBe(1);
  events.close();
});

test("a failed or timed-out stop never removes a possibly live home", async () => {
  let cleaned = 0;
  const cleanup = async () => {
    cleaned++;
  };
  expect(
    await stopAndCleanup(
      {
        stop: async () => {
          throw new Error("still alive");
        },
      },
      cleanup,
      20,
    ),
  ).toBe("still alive");
  expect(await stopAndCleanup({ stop: () => new Promise(() => {}) }, cleanup, 20)).toContain(
    "stop_timeout",
  );
  expect(cleaned).toBe(0);
  expect(await stopAndCleanup({ stop: async () => {} }, cleanup, 20)).toBeNull();
  expect(cleaned).toBe(1);
  expect(await stopAndCleanup({ stop: async () => {} }, () => new Promise(() => {}), 20)).toContain(
    "cleanup_timeout",
  );
});
