import { describe, expect, spyOn, test } from "bun:test";

import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import { ACTIVE_INPUT_SETTLE_GRACE_MS } from "../src/core/driver-command-dispatcher";
import type { DriverEventInput } from "../src/protocol/events";
import type { DriverCommandUpdate, RuntimeCommand } from "../src/runtime-command";
import { settlePromiseWithTimeout } from "../src/utils/async";
import {
  DRIVER_TEST_IDS,
  bootPayload,
  createBackend,
  settleBackendInput,
} from "./driver-runtime-boundary-fixtures";

const firstCommand = {
  commandId: "first-input",
  input: { text: "first" },
  kind: "input.start",
  requestId: "first-request",
  runId: DRIVER_TEST_IDS.runId,
} as const satisfies RuntimeCommand;
const nextCommand = {
  commandId: "next-input",
  input: { text: "next" },
  kind: "input.start",
  requestId: "next-request",
  runId: DRIVER_TEST_IDS.secondRunId,
} as const satisfies RuntimeCommand;

function createHarness(boundary: "event" | "cleanup" | "command" = "event") {
  const backend = createBackend();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  const inputCalls: string[] = [];
  const events: DriverEventInput[] = [];
  const updates: DriverCommandUpdate[] = [];
  const accepted = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  let startedContext: AgentDriverContext;
  let holdSecond = false;
  let beforeUpdate = async (_update: DriverCommandUpdate) => {};
  let beforeEvents = async (_events: DriverEventInput[]) => {};
  backend.start = async (context) => {
    startedContext = context;
  };
  backend.handleInput = async (context, _input, runId, signal) => {
    inputCalls.push(runId);
    if (runId === nextCommand.runId) {
      secondEntered.resolve();
      if (holdSecond) await releaseSecond.promise;
    }
    await settleBackendInput(context, runId, signal);
    if (runId === firstCommand.runId && boundary === "cleanup") {
      entered.resolve();
      await release.promise;
    }
  };
  const kernel = new AgentDriverKernelCore({
    backendFactory: () => backend,
    hostPorts: {
      eventSink: {
        currentRunId: () => null,
        commandUpdate: async (update) => {
          if (
            boundary === "command" &&
            update.commandId === firstCommand.commandId &&
            update.status === "completed"
          ) {
            entered.resolve();
            await release.promise;
          }
          await beforeUpdate(update);
          updates.push(structuredClone(update));
          if (update.status === "accepted") {
            accepted.get(update.commandId)?.resolve();
          }
        },
        pushEvents: async ({ events: batch }) => {
          if (
            boundary === "event" &&
            batch.some(
              (event) => event.runId === firstCommand.runId && event.kind === "run.completed",
            )
          ) {
            entered.resolve();
            await release.promise;
          }
          await beforeEvents(batch);
          events.push(...structuredClone(batch));
          return {
            accepted: batch.map((event, index) => ({
              eventId: event.sourceEventId!,
              seq: index + 1,
              type: event.kind,
            })),
          };
        },
      },
    },
  });
  return {
    backend,
    entered: entered.promise,
    events,
    inputCalls,
    kernel,
    release,
    releaseSecond,
    secondEntered: secondEntered.promise,
    updates,
    fail: (error: Error) => startedContext.lifecycle.fail(error),
    holdSecond: () => {
      holdSecond = true;
    },
    beforeUpdate: (callback: typeof beforeUpdate) => {
      beforeUpdate = callback;
    },
    beforeEvents: (callback: typeof beforeEvents) => {
      beforeEvents = callback;
    },
    waitForAcceptance(commandId: string) {
      if (
        updates.some((update) => update.commandId === commandId && update.status === "accepted")
      ) {
        return Promise.resolve();
      }
      const completion = Promise.withResolvers<void>();
      accepted.set(commandId, completion);
      return completion.promise;
    },
    async close() {
      release.resolve();
      releaseSecond.resolve();
      await kernel.stop("test complete").catch(() => {});
    },
  };
}

describe("AgentDriverKernelCore input handoff", () => {
  test.each(["event", "cleanup", "command"] as const)(
    "waits for the previous %s boundary before invoking the next input",
    async (boundary) => {
      const harness = createHarness(boundary);
      try {
        await harness.kernel.start(bootPayload);
        const first = harness.kernel.dispatch(firstCommand);
        await harness.entered;
        const next = harness.kernel.dispatch(nextCommand);
        await harness.waitForAcceptance(nextCommand.commandId);
        expect(harness.inputCalls).toEqual([firstCommand.runId]);
        expect(harness.kernel.currentRunId()).toBe(firstCommand.runId);
        expect(harness.kernel.runSnapshot()?.terminal?.phase).toBe(
          boundary === "event" ? "selected" : "acked",
        );

        harness.release.resolve();
        await expect(Promise.all([first, next])).resolves.toEqual([
          { requestId: firstCommand.requestId },
          { requestId: nextCommand.requestId },
        ]);
        expect(harness.inputCalls).toEqual([firstCommand.runId, nextCommand.runId]);
        expect(
          harness.events
            .filter((event) => event.kind === "run.completed")
            .map((event) => event.runId),
        ).toEqual([firstCommand.runId, nextCommand.runId]);
      } finally {
        await harness.close();
      }
    },
  );

  test("keeps only one pending input and rejects its unrelated run commands", async () => {
    const harness = createHarness();
    try {
      await harness.kernel.start(bootPayload);
      const first = harness.kernel.dispatch(firstCommand);
      await harness.entered;
      const next = harness.kernel.dispatch(nextCommand);
      await harness.waitForAcceptance(nextCommand.commandId);
      await expect(
        harness.kernel.dispatch({ ...nextCommand, commandId: "third-input" }),
      ).rejects.toThrow("cannot replace the pending run");
      await expect(
        harness.kernel.dispatch({
          commandId: "pending-permission",
          decision: "allow_once",
          kind: "permission.resolve",
          requestId: "unissued-permission",
          runId: nextCommand.runId,
        }),
      ).rejects.toThrow("does not target the active run");
      expect(harness.inputCalls).toEqual([firstCommand.runId]);
      harness.release.resolve();
      await Promise.all([first, next]);
    } finally {
      await harness.close();
    }
  });

  test.each(["turn.cancel", "session.stop"] as const)(
    "cancels pending input before the %s acknowledgement returns",
    async (kind) => {
      const harness = createHarness();
      const controlAccepted = Promise.withResolvers<void>();
      const releaseControl = Promise.withResolvers<void>();
      harness.beforeUpdate(async (update) => {
        if (update.commandId === "cancel-pending" && update.status === "accepted") {
          controlAccepted.resolve();
          await releaseControl.promise;
        }
      });
      try {
        await harness.kernel.start(bootPayload);
        const first = harness.kernel.dispatch(firstCommand);
        await harness.entered;
        const next = harness.kernel.dispatch(nextCommand);
        await harness.waitForAcceptance(nextCommand.commandId);
        const control = harness.kernel.dispatch({
          commandId: "cancel-pending",
          kind,
          reason: "cancel before execution",
          ...(kind === "turn.cancel" ? { runId: nextCommand.runId } : {}),
        } as RuntimeCommand);
        await controlAccepted.promise;
        harness.release.resolve();
        await expect(first).resolves.toEqual({ requestId: firstCommand.requestId });
        await expect(next).resolves.toBeUndefined();
        expect(harness.inputCalls).toEqual([firstCommand.runId]);
        expect(harness.backend.cancelledReasons).toEqual([]);
        expect(
          harness.events
            .filter((event) => event.kind === "run.cancelled")
            .map((event) => event.runId),
        ).toEqual([nextCommand.runId]);
        expect(harness.updates).toContainEqual({
          commandId: nextCommand.commandId,
          status: "cancelled",
        });
        releaseControl.resolve();
        await expect(control).resolves.toBeUndefined();
      } finally {
        releaseControl.resolve();
        await harness.close();
      }
    },
  );

  test("processes session.stop after cancelling a pending run while the old ACK is delayed", async () => {
    const harness = createHarness();
    try {
      await harness.kernel.start(bootPayload);
      const first = harness.kernel.dispatch(firstCommand);
      await harness.entered;
      const next = harness.kernel.dispatch(nextCommand);
      await harness.waitForAcceptance(nextCommand.commandId);
      await expect(
        harness.kernel.dispatch({
          commandId: "cancel-pending",
          kind: "turn.cancel",
          reason: "do not start",
          runId: nextCommand.runId,
        }),
      ).resolves.toBeUndefined();
      const stop = harness.kernel.dispatch({
        commandId: "stop-pending",
        kind: "session.stop",
        reason: "stop while waiting",
      });
      await harness.waitForAcceptance("stop-pending");
      expect(harness.inputCalls).toEqual([firstCommand.runId]);
      harness.release.resolve();
      await expect(Promise.all([first, next, stop])).resolves.toEqual([
        { requestId: firstCommand.requestId },
        undefined,
        undefined,
      ]);
      expect(harness.inputCalls).toEqual([firstCommand.runId]);
    } finally {
      await harness.close();
    }
  });

  test("cancelling the previous completed run does not wait for or cancel the next run", async () => {
    const harness = createHarness();
    harness.holdSecond();
    try {
      await harness.kernel.start(bootPayload);
      const first = harness.kernel.dispatch(firstCommand);
      await harness.entered;
      const next = harness.kernel.dispatch(nextCommand);
      await harness.waitForAcceptance(nextCommand.commandId);
      const cancel = harness.kernel.dispatch({
        commandId: "cancel-previous",
        kind: "turn.cancel",
        reason: "already completed",
        runId: firstCommand.runId,
      });
      await harness.waitForAcceptance("cancel-previous");
      harness.release.resolve();
      await harness.secondEntered;
      await expect(
        settlePromiseWithTimeout(cancel, {
          label: "previous run cancellation",
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(harness.backend.cancelledReasons).toEqual([]);
      harness.releaseSecond.resolve();
      await Promise.all([first, next]);
    } finally {
      await harness.close();
    }
  });

  test.each(["cleanup", "shutdown"] as const)(
    "fails the pending input if the previous %s fails",
    async (failureKind) => {
      const harness = createHarness("cleanup");
      try {
        await harness.kernel.start(bootPayload);
        const first = harness.kernel.dispatch(firstCommand);
        void first.catch(() => {});
        await harness.entered;
        const next = harness.kernel.dispatch(nextCommand);
        void next.catch(() => {});
        await harness.waitForAcceptance(nextCommand.commandId);
        const failure = new Error("provider cannot be reused");
        if (failureKind === "cleanup") harness.release.reject(failure);
        else {
          harness.fail(failure);
          harness.release.resolve();
        }
        await expect(next).rejects.toBeInstanceOf(Error);
        await Promise.allSettled([first]);
        expect(harness.inputCalls).toEqual([firstCommand.runId]);
        expect(
          harness.events
            .filter((event) => event.kind === "run.completed")
            .map((event) => event.runId),
        ).toEqual([firstCommand.runId]);
      } finally {
        await harness.close();
      }
    },
  );

  test.each(["previous cleanup", "pending cancellation"] as const)(
    "bounds %s with the existing input settlement deadline",
    async (boundary) => {
      const harness = createHarness("cleanup");
      const releaseCancellation = Promise.withResolvers<void>();
      if (boundary === "pending cancellation") {
        harness.beforeEvents(async (events) => {
          if (
            events.some(
              (event) => event.runId === nextCommand.runId && event.kind === "run.cancelled",
            )
          ) {
            await releaseCancellation.promise;
          }
        });
      }
      const nativeSetTimeout = globalThis.setTimeout;
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        nativeSetTimeout(
          callback,
          delay === ACTIVE_INPUT_SETTLE_GRACE_MS ? 10 : delay,
          ...args,
        )) as typeof setTimeout);
      try {
        await harness.kernel.start(bootPayload);
        const first = harness.kernel.dispatch(firstCommand);
        void first.catch(() => {});
        await harness.entered;
        const next = harness.kernel.dispatch(nextCommand);
        if (boundary === "pending cancellation") {
          void next.catch(() => {});
          await harness.waitForAcceptance(nextCommand.commandId);
          await harness.kernel.dispatch({
            commandId: "cancel-pending",
            kind: "turn.cancel",
            reason: "do not start",
            runId: nextCommand.runId,
          });
          harness.release.resolve();
        }
        await expect(next).rejects.toThrow("Previous driver run input timed out");
        expect(harness.inputCalls).toEqual([firstCommand.runId]);
        harness.release.resolve();
        await Promise.allSettled([first]);
      } finally {
        releaseCancellation.resolve();
        timer.mockRestore();
        await harness.close();
      }
    },
  );

  test("fails the driver when the pending cancellation terminal cannot be acknowledged", async () => {
    const harness = createHarness();
    harness.beforeEvents(async (events) => {
      if (
        events.some((event) => event.runId === nextCommand.runId && event.kind === "run.cancelled")
      ) {
        throw new Error("cancellation receipt lost");
      }
    });
    try {
      await harness.kernel.start(bootPayload);
      const first = harness.kernel.dispatch(firstCommand);
      await harness.entered;
      const next = harness.kernel.dispatch(nextCommand);
      void next.catch(() => {});
      await harness.waitForAcceptance(nextCommand.commandId);
      await harness.kernel.dispatch({
        commandId: "cancel-pending",
        kind: "turn.cancel",
        reason: "do not start",
        runId: nextCommand.runId,
      });
      harness.release.resolve();
      await first;
      await expect(next).rejects.toThrow("cancellation receipt lost");
      expect(harness.inputCalls).toEqual([firstCommand.runId]);
      expect(harness.updates).toContainEqual(
        expect.objectContaining({ commandId: nextCommand.commandId, status: "failed" }),
      );
    } finally {
      await harness.close();
    }
  });
});
