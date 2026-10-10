import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createDisabledLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import type { NativeCheckpoint } from "../src/protocol/native-checkpoint";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import {
  DriverEventPublisher,
  DriverNativeCheckpointCleanupError,
} from "../src/runtimes/driver-event-publisher";
import {
  createNativeCheckpoint,
  pinNativeCheckpointRoot,
  readNativeCheckpoint,
} from "../src/runtimes/native-checkpoint";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function checkpoint(cwd: string, runId: RunId): Promise<NativeCheckpoint> {
  return createNativeCheckpoint({
    root: await pinNativeCheckpointRoot(cwd),
    nativeRef: { kind: "openai_thread_id", runtimeId: "openai-runtime", value: "thread-1" },
    runId,
    signal: new AbortController().signal,
    write: (directory) => writeFile(join(directory, "session.jsonl"), `${runId} history\n`),
  });
}

async function fixture(beforeAck: () => Promise<void> = async () => {}, useCwdAlias = false) {
  const cwd = await mkdtemp(join(tmpdir(), "publisher-checkpoints-"));
  roots.push(cwd);
  const configuredCwd = useCwdAlias ? join(cwd, "alias") : cwd;
  if (useCwdAlias) await symlink(cwd, configuredCwd);
  const previous = await checkpoint(cwd, DRIVER_TEST_IDS.runId);
  const candidate = await checkpoint(cwd, DRIVER_TEST_IDS.secondRunId);
  const directory = join(cwd, ".state/native-checkpoints");
  const state = { activeRunId: DRIVER_TEST_IDS.secondRunId };
  const attempts: DriverEventInput[][] = [];
  let sequence = 0;
  const context = createAgentDriverContext({
    eventSink: {
      currentRunId: () => state.activeRunId,
      pushEvents: async ({ events }) => {
        attempts.push(events);
        await beforeAck();
        return {
          accepted: events.map((event) => ({
            eventId: event.sourceEventId!,
            seq: ++sequence,
            type: event.kind,
          })),
        };
      },
    },
    logger: createDisabledLogger(),
    payload: createDriverStartInputFromBootPayload({
      ...structuredClone(driverBootPayload),
      execution: {
        ...structuredClone(driverBootPayload.execution),
        configRevision: {
          ...driverBootPayload.execution.configRevision,
          runId: state.activeRunId,
        },
        session: {
          ...structuredClone(driverBootPayload.execution.session),
          cwd: configuredCwd,
          nativeCheckpoint: previous,
          nativeResumeRef: previous.nativeRef,
        },
      },
    }),
    permission: { request: async () => "reject_once" },
  });
  const publisher = new DriverEventPublisher("openai-runtime", () => candidate.nativeRef.value);
  await publisher.initializeNativeCheckpointRoot(context);
  const terminal = {
    kind: "run.completed",
    payload: { checkpoint: candidate },
    runId: candidate.runId,
  } satisfies DriverEventInput;

  return {
    attempts,
    candidate,
    context,
    configuredCwd,
    cwd,
    directory,
    list: async () => (await readdir(directory)).filter((name) => name !== ".gitignore").sort(),
    previous,
    publisher,
    state,
    terminal,
  };
}

function incompleteTerminal(kind: "run.cancelled" | "run.failed", runId: RunId): DriverEventInput {
  return {
    kind,
    payload:
      kind === "run.cancelled"
        ? { requestedBy: "user", stopReason: "cancelled" }
        : {
            error: { code: "test.failed", details: {}, message: "failed", retryable: false },
            recoverable: false,
          },
    runId,
  };
}

describe("DriverEventPublisher checkpoint retention", () => {
  test("requires startup initialization before exposing the checkpoint root", async () => {
    const publisher = new DriverEventPublisher("openai-runtime", () => null);
    await expect(publisher.getNativeCheckpointRoot()).rejects.toThrow("not been initialized");
  });

  test("creates and acknowledges checkpoints in the same pinned root after an alias changes", async () => {
    const f = await fixture(async () => {}, true);
    const outside = await mkdtemp(join(tmpdir(), "publisher-checkpoints-outside-"));
    roots.push(outside);
    await rm(f.configuredCwd);
    await symlink(outside, f.configuredCwd);
    const candidate = await createNativeCheckpoint({
      root: await f.publisher.getNativeCheckpointRoot(),
      nativeRef: f.candidate.nativeRef,
      runId: DRIVER_TEST_IDS.thirdRunId,
      signal: new AbortController().signal,
      write: (directory) => writeFile(join(directory, "session.jsonl"), "pinned history\n"),
    });
    f.state.activeRunId = candidate.runId;

    await f.publisher.pushTerminal(f.context, "complete", [], {
      kind: "run.completed",
      payload: { checkpoint: candidate },
      runId: candidate.runId,
    });

    expect(await f.list()).toEqual([candidate.runId]);
    expect(await readdir(outside)).toEqual([]);
    const saved = await readNativeCheckpoint({ cwd: f.cwd, checkpoint: candidate });
    expect((await saved.readFile("session.jsonl")).toString()).toBe("pinned history\n");
  });

  test("prunes checkpoints through a cwd alias pinned before model work", async () => {
    const f = await fixture(async () => {}, true);

    await f.publisher.pushTerminal(f.context, "complete", [], f.terminal);

    expect(await f.list()).toEqual([f.candidate.runId]);
  });

  test("does not redirect checkpoint cleanup when the cwd alias changes before ACK", async () => {
    const outside = await mkdtemp(join(tmpdir(), "publisher-checkpoints-outside-"));
    roots.push(outside);
    const outsideCheckpoint = await checkpoint(outside, DRIVER_TEST_IDS.runId);
    let configuredCwd = "";
    const f = await fixture(async () => {
      await rm(configuredCwd);
      await symlink(outside, configuredCwd);
    }, true);
    configuredCwd = f.configuredCwd;

    await f.publisher.pushTerminal(f.context, "complete", [], f.terminal);

    expect(await f.list()).toEqual([f.candidate.runId]);
    expect((await readdir(join(outside, ".state/native-checkpoints"))).sort()).toEqual([
      ".gitignore",
      outsideCheckpoint.runId,
    ]);
    expect(
      await readFile(
        join(outside, ".state/native-checkpoints", outsideCheckpoint.runId, "session.jsonl"),
        "utf8",
      ),
    ).toBe(`${outsideCheckpoint.runId} history\n`);
  });

  test("keeps old and pending bundles until the terminal ACK, then retries without the old bundle", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture(async () => {
      entered.resolve();
      await release.promise;
    });
    const pending = f.publisher.pushTerminal(f.context, "complete", [], f.terminal);

    try {
      await entered.promise;
      expect(await f.list()).toEqual([f.previous.runId, f.candidate.runId]);
      expect(f.publisher.lastAcceptedSeq()).toBe(0);
    } finally {
      release.resolve();
    }

    await pending;
    expect(await f.list()).toEqual([f.candidate.runId]);
    const saved = await readNativeCheckpoint({ cwd: f.cwd, checkpoint: f.candidate });
    expect((await saved.readFile("session.jsonl")).toString()).toBe(
      `${f.candidate.runId} history\n`,
    );

    await f.publisher.pushTerminal(f.context, "complete.retry", [], f.terminal);
    expect(f.attempts).toHaveLength(1);
    expect(await f.list()).toEqual([f.candidate.runId]);
  });

  test("keeps every bundle after an unknown ACK until the same terminal is acknowledged", async () => {
    let acknowledge = false;
    const f = await fixture(async () => {
      if (!acknowledge) {
        throw new Error("ACK response lost");
      }
    });

    await expect(f.publisher.pushTerminal(f.context, "complete", [], f.terminal)).rejects.toThrow(
      "ACK response lost",
    );
    expect(await f.list()).toEqual([f.previous.runId, f.candidate.runId]);
    expect(f.publisher.lastAcceptedSeq()).toBe(0);
    const attemptsBeforeCleanup = f.attempts.length;
    await f.publisher.finishTerminalCleanup(f.context);
    expect(f.attempts).toHaveLength(attemptsBeforeCleanup);
    expect(await f.list()).toEqual([f.previous.runId, f.candidate.runId]);

    acknowledge = true;
    await f.publisher.pushTerminal(f.context, "complete.retry", [], f.terminal);
    expect(await f.list()).toEqual([f.candidate.runId]);
    expect(new Set(f.attempts.flat().map((event) => event.sourceEventId)).size).toBe(1);
  });

  test.each(["run.cancelled", "run.failed"] as const)(
    "%s ACK removes an uncommitted candidate and retains the Boot checkpoint",
    async (kind) => {
      const f = await fixture();

      await f.publisher.pushTerminal(
        f.context,
        kind,
        [],
        incompleteTerminal(kind, f.candidate.runId),
      );

      expect(await f.list()).toEqual([f.previous.runId]);
      const saved = await readNativeCheckpoint({ cwd: f.cwd, checkpoint: f.previous });
      expect((await saved.readFile("session.jsonl")).toString()).toBe(
        `${f.previous.runId} history\n`,
      );
    },
  );

  test.each(["run.cancelled", "run.failed"] as const)(
    "%s ACK retains the latest completed checkpoint after another run starts",
    async (kind) => {
      const f = await fixture();
      await f.publisher.pushTerminal(f.context, "complete", [], f.terminal);
      f.state.activeRunId = DRIVER_TEST_IDS.thirdRunId;
      const nextCandidate = await checkpoint(f.cwd, f.state.activeRunId);

      await f.publisher.pushTerminal(
        f.context,
        kind,
        [],
        incompleteTerminal(kind, nextCandidate.runId),
      );

      expect(await f.list()).toEqual([f.candidate.runId]);
      expect(f.context.payload.execution.session.nativeCheckpoint).toEqual(f.previous);
    },
  );

  test("preserves terminal ACK across cleanup failure and retries cleanup before publishing again", async () => {
    const f = await fixture();
    const retainedDirectory = `${f.directory}.retained`;
    await rename(f.directory, retainedDirectory);
    await writeFile(f.directory, "block cleanup");

    const failure = await f.publisher
      .pushTerminal(f.context, "complete", [], f.terminal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DriverNativeCheckpointCleanupError);
    expect(failure).toMatchObject({ checkpoint: f.candidate, runId: f.candidate.runId });
    expect(f.attempts).toHaveLength(1);
    expect(f.publisher.lastAcceptedSeq()).toBe(1);
    expect((await readdir(retainedDirectory)).sort()).toEqual([
      ".gitignore",
      f.previous.runId,
      f.candidate.runId,
    ]);

    await expect(
      f.publisher.pushSession(f.context, "session", [
        { kind: "diagnostic.reported", payload: { code: "test.session" } },
      ]),
    ).rejects.toThrow();
    f.state.activeRunId = DRIVER_TEST_IDS.thirdRunId;
    await expect(
      Promise.resolve().then(() =>
        f.publisher.pushTerminal(
          f.context,
          "next-run",
          [],
          incompleteTerminal("run.cancelled", f.state.activeRunId),
        ),
      ),
    ).rejects.toThrow();
    expect(f.attempts).toHaveLength(1);

    await rm(f.directory);
    await rename(retainedDirectory, f.directory);
    await f.publisher.finishTerminalCleanup(f.context);
    expect(f.attempts).toHaveLength(1);
    expect(await f.list()).toEqual([f.candidate.runId]);
    f.state.activeRunId = f.candidate.runId;
    await f.publisher.pushTerminal(f.context, "complete.retry", [], f.terminal);
    expect(f.attempts).toHaveLength(1);
    expect(await f.list()).toEqual([f.candidate.runId]);

    f.state.activeRunId = DRIVER_TEST_IDS.thirdRunId;
    await f.publisher.pushTerminal(
      f.context,
      "next-run.retry",
      [],
      incompleteTerminal("run.cancelled", f.state.activeRunId),
    );
    expect(f.attempts.flat().map((event) => event.kind)).toEqual([
      "run.completed",
      "run.cancelled",
    ]);
    expect(await f.list()).toEqual([f.candidate.runId]);
  });

  test("joins concurrent stop cleanup retries and retains cleanup when one waiter aborts", async () => {
    const f = await fixture();
    await using parent = await open(f.directory, "r");
    const parentStats = await parent.stat();
    const prototype = Object.getPrototypeOf(parent) as FileHandle;
    const originalSync = prototype.sync;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let syncCalls = 0;
    const sync = spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
      const stats = await this.stat();
      if (stats.dev === parentStats.dev && stats.ino === parentStats.ino) {
        syncCalls += 1;
        if (syncCalls === 1) {
          entered.resolve();
          await release.promise;
          throw new Error("checkpoint directory sync failed");
        }
      }
      await originalSync.call(this);
    });
    try {
      const original = f.publisher
        .pushTerminal(f.context, "complete", [], f.terminal)
        .catch((error: unknown) => error);
      await entered.promise;
      const first = f.publisher.finishTerminalCleanup(f.context);
      const second = f.publisher.finishTerminalCleanup(f.context);
      const controller = new AbortController();
      const aborted = f.publisher.finishTerminalCleanup(f.context, controller.signal);
      controller.abort(new Error("stop deadline"));
      await expect(aborted).rejects.toThrow("stop deadline");
      release.resolve();
      expect(await original).toBeInstanceOf(DriverNativeCheckpointCleanupError);
      await Promise.all([first, second]);
      expect(syncCalls).toBe(2);
      expect(f.attempts).toHaveLength(1);
      expect(await f.list()).toEqual([f.candidate.runId]);
    } finally {
      release.resolve();
      sync.mockRestore();
    }
  });

  test("rejects a symlink during cleanup without deleting files outside the checkpoint directory", async () => {
    const f = await fixture();
    const oldDirectory = join(f.directory, f.previous.runId);
    const outsideDirectory = join(f.cwd, "outside-checkpoints");
    await rename(oldDirectory, outsideDirectory);
    await symlink(outsideDirectory, oldDirectory);

    await expect(f.publisher.pushTerminal(f.context, "complete", [], f.terminal)).rejects.toThrow();
    expect(f.attempts).toHaveLength(1);
    expect(await readFile(join(outsideDirectory, "session.jsonl"), "utf8")).toBe(
      `${f.previous.runId} history\n`,
    );

    await rm(oldDirectory);
    await f.publisher.pushTerminal(f.context, "complete.retry", [], f.terminal);
    expect(f.attempts).toHaveLength(1);
    expect(await f.list()).toEqual([f.candidate.runId]);
    expect(await readFile(join(outsideDirectory, "session.jsonl"), "utf8")).toBe(
      `${f.previous.runId} history\n`,
    );
  });
});
