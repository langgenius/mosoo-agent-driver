import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { DriverEventRejectedError } from "../src/core/driver-runtime-io";
import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-event-envelope";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import type { JsonObject } from "../src/protocol/json";
import { parseNativeCheckpoint } from "../src/protocol/native-checkpoint";
import { readNativeCheckpoint } from "../src/runtimes/native-checkpoint";
import { PiDriverBackend } from "../src/runtimes/pi/pi-driver-backend";
import { raceWithAbort } from "../src/utils/async";
import {
  driverBootPayload,
  driverStartInput,
  DRIVER_TEST_IDS,
} from "./driver-boot-payload-fixture";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

async function harness(nativeText = "done") {
  const root = await mkdtemp(join(tmpdir(), "mosoo-pi-lifecycle-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "pi");
  const sessionFile = join(home, "sessions", "native.jsonl");
  await mkdir(join(home, "sessions"), { recursive: true });
  const payload = {
    ...driverStartInput,
    runtime: "pi" as const,
    runtimeTransport: "pi-rpc" as const,
    execution: {
      ...driverStartInput.execution,
      model: "test-model",
      session: { ...driverStartInput.execution.session, homePath: root, cwd: root },
    },
  };
  const events: DriverEventInput[] = [];
  const commands: string[] = [];
  let seq = 0;
  let runId: RunId | null = null;
  let onRecord!: (record: JsonObject) => Promise<void>;
  let onFailure!: (error: Error) => void;
  const hooks = {
    push: async (_events: readonly DriverEventInput[], _signal?: AbortSignal) => {},
    request: async (_type: string): Promise<void> => {},
    stop: async (): Promise<void> => {},
    permission: async (_signal?: AbortSignal): Promise<"allow_once"> => "allow_once",
  };
  let stopped = 0;
  const prompt = Promise.withResolvers<void>();
  const context = createAgentDriverContext({
    payload,
    logger: createBufferedSinkLogger({ level: "error", service: "pi-test", sink: async () => {} }),
    eventSink: {
      currentRunId: () => runId,
      pushEvents: async ({ events: batch, signal }) => {
        for (const event of batch) {
          toDriverEventEnvelopes(
            { ...driverBootPayload, runtime: "pi", runtimeTransport: "pi-rpc" },
            event,
            runId,
          );
        }
        await hooks.push(batch, signal);
        events.push(...batch);
        return {
          accepted: batch.map((event) => ({
            eventId: event.sourceEventId!,
            seq: ++seq,
            type: event.kind,
          })),
        };
      },
    },
    permission: { request: async (_request, signal) => hooks.permission(signal) },
    ports: { skill: { materialize: async () => [] } },
  });
  const backend = new PiDriverBackend(payload, {
    prepare: async () => ({ args: [], command: "unused", cwd: root, env: {}, home }),
    createClient: (_config, receive, fail) => {
      onRecord = receive;
      onFailure = fail;
      return {
        request: async (type) => {
          commands.push(type);
          await hooks.request(type);
          if (type === "get_state")
            return { model: { id: "test-model", provider: "mosoo" }, sessionFile };
          if (type === "prompt") {
            prompt.resolve();
            return { disposition: "started" };
          }
          if (type === "abort") await onRecord({ type: "agent_settled" });
          return {};
        },
        send: async () => {},
        stop: async () => {
          stopped++;
          await hooks.stop();
        },
      };
    },
  });
  cleanup.push(() => backend.stop(context, "cleanup", AbortSignal.timeout(2_000)));
  await backend.start(context, AbortSignal.timeout(2_000));
  const nativeMessage: JsonObject = {
    role: "assistant",
    content: [{ type: "text", text: nativeText }],
    stopReason: "stop",
    timestamp: 1,
  };
  return {
    backend,
    commands,
    context,
    events,
    hooks,
    prompt,
    root,
    sessionFile,
    stopped: () => stopped,
    fail: (error: Error) => onFailure(error),
    emit: (record: JsonObject) => onRecord(record),
    turn: async (id = DRIVER_TEST_IDS.runId) => {
      runId = id;
      try {
        await backend.handleInput(context, { text: "test" }, id);
      } finally {
        runId = null;
      }
    },
    complete: async (persist = true) => {
      await prompt.promise;
      await onRecord({ type: "message_start", message: nativeMessage });
      await onRecord({ type: "message_end", message: nativeMessage });
      if (persist)
        await writeFile(
          sessionFile,
          [
            {
              type: "session",
              version: 3,
              id: "session",
              timestamp: "2026-10-10T00:00:00.000Z",
              cwd: root,
            },
            {
              type: "message",
              id: "message",
              parentId: null,
              timestamp: "2026-10-10T00:00:00.000Z",
              message: nativeMessage,
            },
          ]
            .map((record) => JSON.stringify(record))
            .join("\n") + "\n",
        );
      await onRecord({ type: "agent_settled" });
    },
  };
}

test("does not dispatch native work before the run start receipt, including cancellation", async () => {
  const run = await harness();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  run.hooks.push = async (events) => {
    if (events.some((event) => event.kind === "run.started")) {
      entered.resolve();
      await release.promise;
    }
  };
  const outcome = run.turn().catch((error: unknown) => error);
  await entered.promise;
  const cancel = run.backend.cancelActiveTurn(run.context, "cancel before start ACK");
  expect(run.commands).toEqual(["get_state"]);
  release.resolve();
  await cancel;
  expect(await outcome).toMatchObject({ name: "DriverTurnCancelledError" });
  expect(run.commands).toEqual(["get_state"]);
  expect(
    run.events.filter((event) => event.kind.startsWith("run.")).map((event) => event.kind),
  ).toEqual(["run.started", "run.cancel.requested", "run.cancelled"]);
});

test("creates an independently readable checkpoint before completed delivery and waits for its receipt", async () => {
  const run = await harness();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  run.hooks.push = async (events) => {
    const terminal = events.find((event) => event.kind === "run.completed");
    if (terminal) {
      const checkpoint = parseNativeCheckpoint((terminal.payload as JsonObject)["checkpoint"]);
      const saved = await readNativeCheckpoint({ cwd: run.root, checkpoint });
      expect((await saved.readFile("session.jsonl")).toString()).toBe(
        await readFile(run.sessionFile, "utf8"),
      );
      entered.resolve();
      await release.promise;
    }
  };
  let returned = false;
  const outcome = run.turn().then(() => {
    returned = true;
  });
  await run.complete();
  await entered.promise;
  expect(returned).toBe(false);
  release.resolve();
  await outcome;
  expect(run.events.filter((event) => event.kind === "run.completed")).toHaveLength(1);
});

test("completes an empty native answer without referencing a missing message snapshot", async () => {
  const run = await harness("");
  const outcome = run.turn();
  await run.complete();
  await outcome;
  const completed = run.events.find((event) => event.kind === "run.completed");
  expect(completed?.payload).not.toHaveProperty("finalMessageId");
  expect(completed?.payload).toHaveProperty("checkpoint");
  expect(run.events.some((event) => event.kind === "message.added")).toBe(false);
});

test("cancellation during completed delivery does not send a late abort to the reusable process", async () => {
  const run = await harness();
  const entered = Promise.withResolvers<void>();
  run.hooks.push = async (events, signal) => {
    if (events.some((event) => event.kind === "run.completed")) {
      entered.resolve();
      await raceWithAbort(new Promise<void>(() => {}), signal);
    }
  };
  const outcome = run.turn().catch((error: unknown) => error);
  await run.complete();
  await entered.promise;
  await run.backend.cancelActiveTurn(run.context, "cancel before completion ACK");
  expect(await outcome).toMatchObject({ name: "DriverTurnCancelledError" });
  expect(run.commands).not.toContain("abort");
  expect(run.stopped()).toBe(0);
  expect(run.events.filter((event) => event.kind === "run.cancelled")).toHaveLength(1);
  expect(run.events.filter((event) => event.kind === "run.completed")).toHaveLength(0);
});

test("rejects completion without a persisted native transcript", async () => {
  const run = await harness();
  const outcome = run.turn().catch((error: unknown) => error);
  await run.complete(false);
  expect(await outcome).toBeInstanceOf(Error);
  expect(run.events.filter((event) => event.kind === "run.completed")).toHaveLength(0);
  expect(run.events.filter((event) => event.kind === "run.failed")).toHaveLength(1);
  expect(run.stopped()).toBe(1);
});

test("preserves a rejected completed terminal without publishing a competing failure", async () => {
  const run = await harness();
  run.hooks.push = async (events) => {
    const terminal = events.find((event) => event.kind === "run.completed");
    if (terminal)
      throw new DriverEventRejectedError(terminal.sourceEventId!, new Error("completion rejected"));
  };
  const outcome = run.turn().catch((error: unknown) => error);
  await run.complete();
  expect(await outcome).toBeInstanceOf(DriverEventRejectedError);
  expect(
    run.events.filter((event) =>
      ["run.failed", "run.completed", "run.cancelled"].includes(event.kind),
    ),
  ).toHaveLength(0);
  expect(run.stopped()).toBe(1);
});

test.each(["stale assistant", "foreign workspace"])(
  "rejects a %s transcript even when its JSONL is valid",
  async (damage) => {
    const run = await harness();
    run.hooks.request = async (type) => {
      if (type === "get_state") {
        const content = await readFile(run.sessionFile, "utf8");
        await writeFile(
          run.sessionFile,
          damage === "stale assistant"
            ? content.replace('"text":"done"', '"text":"old answer"')
            : content.replace(JSON.stringify(run.root), JSON.stringify(join(run.root, "pi"))),
        );
      }
    };
    const outcome = run.turn().catch((error: unknown) => error);
    await run.complete();
    expect(await outcome).toMatchObject({
      message:
        damage === "stale assistant"
          ? "Pi transcript does not contain the completed native assistant message."
          : "Pi transcript belongs to another workspace.",
    });
    expect(run.events.filter((event) => event.kind === "run.completed")).toHaveLength(0);
    expect(run.events.filter((event) => event.kind === "run.failed")).toHaveLength(1);
  },
);

test("native failure cancels permission waits before draining the failed turn", async () => {
  const run = await harness();
  const permissionEntered = Promise.withResolvers<void>();
  let permissionCancelled = false;
  run.hooks.permission = async (signal) => {
    permissionEntered.resolve();
    try {
      await raceWithAbort(new Promise<void>(() => {}), signal);
    } finally {
      permissionCancelled = true;
    }
    return "allow_once";
  };
  const outcome = run.turn().catch((error: unknown) => error);
  await run.prompt.promise;
  const permission = run.emit({
    type: "extension_ui_request",
    id: "permission",
    method: "confirm",
    title: "mosoo.tool_permission",
    message: JSON.stringify({ toolCallId: "tool", toolName: "write" }),
  });
  await permissionEntered.promise;
  run.fail(new Error("native process exited"));
  expect(await outcome).toMatchObject({ message: "native process exited" });
  await permission;
  expect(permissionCancelled).toBe(true);
  expect(run.events.filter((event) => event.kind === "run.failed")).toHaveLength(1);
});

test("waits for native cancellation when cancellation event delivery is rejected", async () => {
  const run = await harness();
  const abortEntered = Promise.withResolvers<void>();
  const releaseAbort = Promise.withResolvers<void>();
  run.hooks.request = async (type) => {
    if (type === "abort") {
      abortEntered.resolve();
      await releaseAbort.promise;
    }
  };
  run.hooks.push = async (events) => {
    const event = events.find((item) => item.kind === "run.cancel.requested");
    if (event)
      throw new DriverEventRejectedError(event.sourceEventId!, new Error("cancel rejected"));
  };
  let returned = false;
  const outcome = run.turn().catch((error: unknown) => {
    returned = true;
    return error;
  });
  await run.prompt.promise;
  const cancel = run.backend
    .cancelActiveTurn(run.context, "cancel")
    .catch((error: unknown) => error);
  await abortEntered.promise;
  await Bun.sleep(0);
  expect(returned).toBe(false);
  releaseAbort.resolve();
  expect(await cancel).toBeInstanceOf(DriverEventRejectedError);
  expect(await outcome).toBeInstanceOf(DriverEventRejectedError);
  expect(run.stopped()).toBe(1);
  expect(run.events.filter((event) => event.kind === "run.cancelled")).toHaveLength(0);
  expect(run.events.filter((event) => event.kind === "run.failed")).toHaveLength(1);
});

test("retries failed native cleanup when stop is called again", async () => {
  const run = await harness();
  run.hooks.stop = async () => {
    if (run.stopped() === 1) throw new Error("cleanup failed");
  };
  await expect(run.backend.stop(run.context, "stop", AbortSignal.timeout(2_000))).rejects.toThrow(
    "cleanup failed",
  );
  await expect(
    run.backend.stop(run.context, "retry", AbortSignal.timeout(2_000)),
  ).resolves.toBeUndefined();
  expect(run.stopped()).toBe(2);
});

test("keeps cleanup available without publishing a terminal when native stop fails", async () => {
  const run = await harness();
  run.hooks.stop = async () => {
    if (run.stopped() === 1) throw new Error("process still running");
  };
  const outcome = run.turn().catch((error: unknown) => error);
  await run.prompt.promise;
  run.fail(new Error("native failed"));
  expect(await outcome).toMatchObject({ name: "DriverTurnCancellationCleanupError" });
  expect(
    run.events.filter((event) =>
      ["run.failed", "run.completed", "run.cancelled"].includes(event.kind),
    ),
  ).toHaveLength(0);
  await run.backend.stop(run.context, "retry cleanup", AbortSignal.timeout(2_000));
  expect(run.stopped()).toBe(2);
});

test("stop retries checkpoint cleanup after completion ACK without another terminal", async () => {
  const run = await harness();
  const directory = join(run.root, ".state", "native-checkpoints");
  const retained = `${directory}.retained`;
  run.hooks.push = async (events) => {
    if (events.some((event) => event.kind === "run.completed")) {
      await rename(directory, retained);
      await writeFile(directory, "blocks checkpoint cleanup");
    }
  };
  const outcome = run.turn().catch((error: unknown) => error);
  await run.complete();
  expect(await outcome).toMatchObject({ name: "DriverNativeCheckpointCleanupError" });
  await expect(
    run.backend.stop(run.context, "stop", AbortSignal.timeout(2_000)),
  ).rejects.toMatchObject({ name: "DriverNativeCheckpointCleanupError" });
  await rm(directory);
  await rename(retained, directory);
  await run.backend.stop(run.context, "retry cleanup", AbortSignal.timeout(2_000));
  expect(
    run.events
      .filter((event) => ["run.failed", "run.completed", "run.cancelled"].includes(event.kind))
      .map((event) => event.kind),
  ).toEqual(["run.completed"]);
});
