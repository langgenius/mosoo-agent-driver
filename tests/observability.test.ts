import { describe, expect, test } from "bun:test";

import { createBufferedSinkLogger } from "../src/observability";

describe("buffered sink lifecycle", () => {
  test("every concurrent destroy waits for the final flush", async () => {
    const sinkEntered = Promise.withResolvers<void>();
    const releaseSink = Promise.withResolvers<void>();
    const logger = createBufferedSinkLogger({
      level: "debug",
      service: "buffered-sink-lifecycle-test",
      sink: async () => {
        sinkEntered.resolve();
        await releaseSink.promise;
      },
    });

    logger.info("before destroy");
    const firstDestroy = logger.destroy();
    await sinkEntered.promise;
    const secondDestroy = logger.destroy();
    let secondSettled = false;
    void secondDestroy.then(() => {
      secondSettled = true;
    });
    await Bun.sleep(0);

    expect(secondSettled).toBe(false);
    releaseSink.resolve();
    await expect(Promise.all([firstDestroy, secondDestroy])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  test("does not retry or accept logs after destruction", async () => {
    let attempts = 0;
    const logger = createBufferedSinkLogger({
      flushIntervalMs: 5,
      level: "debug",
      service: "buffered-sink-lifecycle-test",
      sink: async () => {
        attempts += 1;
        throw new Error("sink unavailable");
      },
    });

    logger.info("before destroy");
    await logger.destroy();
    logger.info("after destroy");
    await Bun.sleep(20);
    await logger.destroy();

    expect(attempts).toBe(1);
  });
});
