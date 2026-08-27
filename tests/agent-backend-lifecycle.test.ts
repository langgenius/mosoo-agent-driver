import { describe, expect, jest, test } from "bun:test";

import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { AgentBackendLifecycle } from "../src/core/agent-backend-lifecycle";
import { createBackend } from "./driver-runtime-boundary-fixtures";

describe("AgentBackendLifecycle", () => {
  test("shares a failed stop owner and retries only after it settles", async () => {
    const firstStopEntered = Promise.withResolvers<void>();
    const releaseFirstStop = Promise.withResolvers<void>();
    const firstFailure = new Error("first stop failed");
    const backend = createBackend();
    let activeStops = 0;
    let maxActiveStops = 0;
    let stopCount = 0;
    backend.stop = async () => {
      stopCount += 1;
      activeStops += 1;
      maxActiveStops = Math.max(maxActiveStops, activeStops);

      try {
        if (stopCount === 1) {
          firstStopEntered.resolve();
          await releaseFirstStop.promise;
          throw firstFailure;
        }
      } finally {
        activeStops -= 1;
      }
    };
    const lifecycle = new AgentBackendLifecycle({
      backend,
      createContext: () => ({}) as AgentDriverContext,
      labels: {
        finalStop: "test final stop",
        start: "test start",
        stop: "test stop",
      },
      shutdownSignal: new AbortController().signal,
      startTimeoutMs: 1_000,
      stopTimeoutMs: 1_000,
    });

    const first = lifecycle.shutdown("first");
    await firstStopEntered.promise;
    const concurrent = lifecycle.shutdown("concurrent");
    expect(stopCount).toBe(1);

    releaseFirstStop.resolve();
    const results = await Promise.allSettled([first, concurrent]);
    expect(results).toEqual([
      { reason: firstFailure, status: "rejected" },
      { reason: firstFailure, status: "rejected" },
    ]);

    await expect(lifecycle.shutdown("retry")).resolves.toBeUndefined();
    expect(stopCount).toBe(2);
    expect(maxActiveStops).toBe(1);
  });

  test("bounds a final stop and serializes its retry behind late cleanup", async () => {
    const backend = createBackend();
    const startEntered = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    const firstStopEntered = Promise.withResolvers<void>();
    const finalStopEntered = Promise.withResolvers<void>();
    const finalStopAborted = Promise.withResolvers<void>();
    const releaseFinalStop = Promise.withResolvers<void>();
    const deferredComplete = Promise.withResolvers<void>();
    let activeStops = 0;
    let maxActiveStops = 0;
    let stopCount = 0;
    backend.start = async () => {
      startEntered.resolve();
      await releaseStart.promise;
    };
    backend.stop = async (_context, _reason, signal) => {
      stopCount += 1;
      activeStops += 1;
      maxActiveStops = Math.max(maxActiveStops, activeStops);
      try {
        if (stopCount === 1) {
          firstStopEntered.resolve();
          return;
        }
        if (stopCount === 2) {
          finalStopEntered.resolve();
          signal.addEventListener("abort", () => finalStopAborted.resolve(), { once: true });
          await releaseFinalStop.promise;
        }
      } finally {
        activeStops -= 1;
      }
    };
    const lifecycle = new AgentBackendLifecycle({
      backend,
      createContext: () => ({}) as AgentDriverContext,
      labels: {
        finalStop: "test final stop",
        start: "test start",
        stop: "test stop",
      },
      onDeferredStopComplete: deferredComplete.resolve,
      shutdownSignal: new AbortController().signal,
      startTimeoutMs: 10_000,
      stopTimeoutMs: 1_000,
    });
    jest.useFakeTimers({ now: 0 });

    try {
      const start = lifecycle.start();
      await startEntered.promise;
      const shutdown = lifecycle.shutdown("test shutdown");
      await firstStopEntered.promise;
      jest.setSystemTime(400);
      releaseStart.resolve();
      await start;
      await finalStopEntered.promise;
      jest.advanceTimersByTime(600);

      await finalStopAborted.promise;
      await expect(shutdown).rejects.toThrow("test final stop timed out after 600ms");
      const retry = lifecycle.shutdown("retry");
      await Promise.resolve();
      expect(stopCount).toBe(2);
      releaseFinalStop.resolve();
      await expect(retry).resolves.toBeUndefined();
      await deferredComplete.promise;
      expect(stopCount).toBe(3);
      expect(maxActiveStops).toBe(1);
    } finally {
      releaseStart.resolve();
      releaseFinalStop.resolve();
      jest.useRealTimers();
    }
  });
});
