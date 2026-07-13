import { describe, expect, test } from "bun:test";

import { DriverHeartbeatLoop } from "../src/core/driver-heartbeat-loop";
import type { DriverRuntimeHeartbeatPort } from "../src/core/driver-runtime-io";
import { createBufferedSinkLogger } from "../src/observability";
import { promiseWithTimeout, sleepPromise } from "../src/utils/async";

function createTestLogger() {
  return createBufferedSinkLogger({
    level: "debug",
    service: "driver-heartbeat-loop-test",
    sink: async () => {},
  });
}

describe("DriverHeartbeatLoop", () => {
  test("clamps a huge negotiated interval only when scheduling the timer", async () => {
    const logger = createTestLogger();
    const scheduledDelays: number[] = [];
    const nativeSetTimeout = globalThis.setTimeout;
    const loop = new DriverHeartbeatLoop({
      driverInstanceId: "driver-1",
      isShuttingDown: () => false,
    });

    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      scheduledDelays.push(Number(args[1]));
      return nativeSetTimeout(() => {}, 60_000);
    }) as typeof setTimeout;

    try {
      loop.start(
        {
          heartbeat: async () => ({ heartbeatCount: 1, ok: true }),
        },
        logger,
        Number.MAX_SAFE_INTEGER,
        () => {},
      );
      await Promise.resolve();

      expect(scheduledDelays).toContain(2_147_483_647);
    } finally {
      loop.stop(logger, "test.complete");
      globalThis.setTimeout = nativeSetTimeout;
      await logger.destroy();
    }
  });

  test("never overlaps heartbeat requests", async () => {
    const heartbeat = Promise.withResolvers<{ heartbeatCount: number; ok: true }>();
    const logger = createTestLogger();
    let heartbeatCalls = 0;
    const socket: DriverRuntimeHeartbeatPort = {
      heartbeat: async () => {
        heartbeatCalls += 1;
        return heartbeat.promise;
      },
    };
    const loop = new DriverHeartbeatLoop({
      driverInstanceId: "driver-1",
      isShuttingDown: () => false,
    });

    loop.start(socket, logger, 5, () => {});
    await sleepPromise(30);
    loop.stop(logger, "test.complete");
    heartbeat.resolve({ heartbeatCount: 1, ok: true });
    await sleepPromise(0);
    await logger.destroy();

    expect(heartbeatCalls).toBe(1);
  });

  test("reports one failed heartbeat to the supervisor and stops", async () => {
    const failed = Promise.withResolvers<unknown>();
    const logger = createTestLogger();
    let heartbeatCalls = 0;
    const socket: DriverRuntimeHeartbeatPort = {
      heartbeat: async () => {
        heartbeatCalls += 1;
        throw new Error("control socket failed");
      },
    };
    const loop = new DriverHeartbeatLoop({
      driverInstanceId: "driver-1",
      isShuttingDown: () => false,
    });

    loop.start(socket, logger, 1, (error) => failed.resolve(error));
    const error = await promiseWithTimeout(failed.promise, {
      label: "Heartbeat failure callback",
      timeoutMs: 100,
    });
    await sleepPromise(10);
    await logger.destroy();

    expect(error).toBeInstanceOf(Error);
    expect(heartbeatCalls).toBe(1);
  });

  test.each(["explicit stop", "supervised shutdown"] as const)(
    "suppresses an in-flight heartbeat failure after %s",
    async (termination) => {
      const heartbeatEntered = Promise.withResolvers<void>();
      const heartbeatResult = Promise.withResolvers<{ heartbeatCount: number; ok: true }>();
      const logger = createTestLogger();
      const failures: unknown[] = [];
      let shuttingDown = false;
      const loop = new DriverHeartbeatLoop({
        driverInstanceId: "driver-1",
        isShuttingDown: () => shuttingDown,
      });
      const socket: DriverRuntimeHeartbeatPort = {
        heartbeat: async () => {
          heartbeatEntered.resolve();
          return heartbeatResult.promise;
        },
      };

      loop.start(socket, logger, 1, (error) => failures.push(error));
      await heartbeatEntered.promise;

      if (termination === "explicit stop") {
        loop.stop(logger, "test.complete");
      } else {
        shuttingDown = true;
      }

      heartbeatResult.reject(new Error("late heartbeat failure"));
      await sleepPromise(0);
      loop.stop(logger, "test.cleanup");
      await logger.destroy();

      expect(failures).toEqual([]);
    },
  );
});
