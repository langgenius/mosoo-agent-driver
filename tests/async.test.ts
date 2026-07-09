import { describe, expect, test } from "bun:test";

import {
  promiseWithTimeout,
  raceWithAbort,
  settlePromiseWithTimeout,
  sleepPromise,
} from "../src/utils/async";

describe("async lifecycle utilities", () => {
  const failure = new Error("operation failed");

  test.each([
    {
      expectedStatus: "completed",
      operation: () => Promise.resolve("value"),
    },
    {
      expectedStatus: "failed",
      operation: () => Promise.reject(failure),
    },
    {
      expectedStatus: "timed_out",
      operation: () => new Promise<string>(() => {}),
    },
  ] as const)("classifies a settled operation as $expectedStatus", async (testCase) => {
    const result = await settlePromiseWithTimeout(testCase.operation(), {
      label: "test operation",
      timeoutMs: 5,
    });

    expect(result.status).toBe(testCase.expectedStatus);

    if (result.status === "completed") {
      expect(result.value).toBe("value");
    } else if (result.status === "failed") {
      expect(result.error).toBe(failure);
    } else {
      expect(result.error).toMatchObject({
        label: "test operation",
        timeoutMs: 5,
      });
    }
  });

  test("classifies an observed operation's own timeout as a failure", async () => {
    const inner = promiseWithTimeout(new Promise<void>(() => {}), {
      label: "inner operation",
      timeoutMs: 5,
    });
    const result = await settlePromiseWithTimeout(inner, {
      label: "outer observation",
      timeoutMs: 50,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toMatchObject({
        label: "inner operation",
        timeoutMs: 5,
      });
    }
  });

  test.each(["resolve", "reject"] as const)(
    "absorbs a late %s after an already-aborted race",
    async (lateOutcome) => {
      const controller = new AbortController();
      const reason = new Error("already cancelled");
      const pending = Promise.withResolvers<void>();
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      controller.abort(reason);
      process.on("unhandledRejection", onUnhandled);

      try {
        await expect(raceWithAbort(pending.promise, controller.signal)).rejects.toBe(reason);

        if (lateOutcome === "resolve") {
          pending.resolve();
        } else {
          pending.reject(new Error("late failure"));
        }
        await Bun.sleep(0);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        pending.resolve();
      }
    },
  );

  test("propagates an operation failure while an abort race is active", async () => {
    const failure = new Error("operation failed first");

    await expect(
      raceWithAbort(Promise.reject(failure), new AbortController().signal),
    ).rejects.toBe(failure);
  });

  test.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
  ] as const)("rejects a %s timeout value", async (_label, timeoutMs) => {
    await expect(
      promiseWithTimeout(Promise.resolve(), {
        label: "test operation",
        timeoutMs,
      }),
    ).rejects.toThrow("finite non-negative");
  });

  test("accepts a timeout beyond the platform timer range", async () => {
    await expect(
      promiseWithTimeout(Promise.resolve("done"), {
        label: "long operation",
        timeoutMs: 2_147_483_648,
      }),
    ).resolves.toBe("done");
  });

  test("cancels a pending sleep", async () => {
    const controller = new AbortController();
    const reason = new Error("sleep cancelled");
    const sleep = sleepPromise(10_000, controller.signal);

    controller.abort(reason);

    await expect(sleep).rejects.toBe(reason);
  });

  test("cancels a pending deadline without waiting for its timeout", async () => {
    const controller = new AbortController();
    const reason = new Error("operation cancelled");
    const operation = promiseWithTimeout(new Promise<void>(() => {}), {
      label: "pending operation",
      signal: controller.signal,
      timeoutMs: 10_000,
    });

    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
  });
});
