import { describe, expect, test } from "bun:test";

import { ACTIVE_TURN_CANCEL_GRACE_MS } from "../src/core/driver-command-dispatcher";
import type {
  AgentDriverContext,
  AgentDriverContextPortOverrides,
} from "../src/core/agent-driver-backend";
import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import { DRIVER_EVENT_DELIVERY_TIMEOUT_MS } from "../src/core/driver-runtime-io";
import type { DriverEventInput } from "../src/protocol/events";
import type { RuntimeCommand } from "../src/runtime-command";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { DRIVER_TEST_IDS, bootPayload, createBackend } from "./driver-runtime-boundary-fixtures";

describe("AgentDriverKernelCore", () => {
  test("does not publish diagnostics after an adapter run terminal", async () => {
    const backend = createBackend();
    const failure = new Error("provider failed");
    backend.handleInput = async (context, _input, runId) => {
      await context.ports.eventSink.pushEvents({
        events: [
          {
            kind: "run.started",
            payload: { startedAt: new Date().toISOString() },
            runId,
          },
          {
            kind: "run.failed",
            payload: {
              error: { code: "provider.failed", message: failure.message },
              recoverable: false,
            },
            runId,
          },
        ],
      });
      throw failure;
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    await kernel.start(bootPayload);
    await expect(
      kernel.dispatch({
        commandId: "provider-failure-input",
        input: { text: "fail" },
        kind: "input.start",
        requestId: "provider-failure-request",
        runId: DRIVER_TEST_IDS.runId,
      }),
    ).rejects.toThrow("provider failed");
    await expect(kernel.stop("join provider failure")).resolves.toBeUndefined();

    const events: DriverEventInput[] = [];
    for await (const event of kernel.events()) {
      events.push(event);
    }
    expect(events.map((event) => event.kind)).toEqual(["run.started", "run.failed"]);
  });

  test("fails closed for late startup permissions before shutdown closes events", async () => {
    const backend = createBackend();
    const startEntered = Promise.withResolvers<void>();
    const startAborted = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    const latePermissionEntered = Promise.withResolvers<void>();
    let latePermission: Promise<unknown> | null = null;
    let startSignal: AbortSignal | undefined;
    backend.start = async (context, signal) => {
      startSignal = signal;
      signal.addEventListener("abort", () => startAborted.resolve(), { once: true });
      startEntered.resolve();
      await releaseStart.promise;
      latePermission = context.ports.permission.request({
        rawInput: null,
        requestId: "late-startup-permission",
        title: "Allow late startup tool?",
        toolCallId: "late-startup-tool",
        toolKind: "test",
      });
      void latePermission.catch(() => {});
      latePermissionEntered.resolve();
      signal.throwIfAborted();
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();
    const payload = {
      ...bootPayload,
      execution: {
        ...bootPayload.execution,
        permissionPolicy: "supervised" as const,
      },
    };
    let start: Promise<void> | null = null;
    let stop: Promise<void> | null = null;

    try {
      start = kernel.start(payload);
      await startEntered.promise;
      stop = kernel.stop("startup stop");
      await startAborted.promise;
      expect(startSignal?.aborted).toBe(true);
      expect(startSignal?.reason).toMatchObject({ message: "startup stop" });
      releaseStart.resolve();
      await latePermissionEntered.promise;
      await expect(start).resolves.toBeUndefined();
      await expect(stop).resolves.toBeUndefined();
      await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
      await expect(latePermission).resolves.toBe("reject_once");
    } finally {
      releaseStart.resolve();
      await Promise.allSettled([start, stop].filter((task) => task !== null));
    }
  });

  test("enforces the command queue UTF-8 JSON byte budget", async () => {
    const backend = createBackend();
    const pollEntered = Promise.withResolvers<void>();
    const failure = new Error("release queued commands");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
      hostPorts: {
        commandSource: {
          nextCommand: async () => {
            pollEntered.resolve();
            return new Promise<never>(() => {});
          },
        },
      },
    });
    const text = "x".repeat(17 * 1_024 * 1_024);

    await kernel.start(bootPayload);
    await pollEntered.promise;
    const first = kernel.dispatch({
      commandId: "large-command-1",
      input: { text },
      kind: "input.start",
      requestId: "large-request-1",
      runId: DRIVER_TEST_IDS.runId,
    });
    void first.catch(() => {});
    await expect(
      kernel.dispatch({
        commandId: "large-command-2",
        input: { text },
        kind: "input.start",
        requestId: "large-request-2",
        runId: DRIVER_TEST_IDS.runId,
      }),
    ).rejects.toThrow("UTF-8 JSON bytes");

    (context as AgentDriverContext | null)?.lifecycle.fail(failure);
    await expect(first).rejects.toBe(failure);
    await expect(kernel.stop("join failure")).rejects.toBe(failure);
  });

  test.each([
    ["poll", "resolve"],
    ["poll", "reject"],
    ["accepted ACK", "resolve"],
    ["accepted ACK", "reject"],
  ] as const)(
    "backend failure bounds a non-compliant %s and absorbs its late %s",
    async (boundary, lateOutcome) => {
      const backend = createBackend();
      const entered = Promise.withResolvers<void>();
      const late = Promise.withResolvers<unknown>();
      const failure = new Error(`provider failed during ${boundary}`);
      let context: AgentDriverContext | null = null;
      backend.start = async (startedContext) => {
        context = startedContext;
      };
      const hostPorts: AgentDriverContextPortOverrides =
        boundary === "poll"
          ? {
              commandSource: {
                nextCommand: async () => {
                  entered.resolve();
                  return late.promise as Promise<RuntimeCommand | null>;
                },
              },
            }
          : {
              eventSink: {
                commandUpdate: async () => {
                  entered.resolve();
                  await late.promise;
                },
                currentRunId: () => null,
                pushEvents: async ({ events }) => ({
                  accepted: events.map((event, index) => ({
                    seq: index + 1,
                    type: event.kind,
                  })),
                }),
              },
            };
      const kernel = new AgentDriverKernelCore({
        backendFactory: () => backend,
        hostPorts,
      });

      await kernel.start(bootPayload);
      const command =
        boundary === "accepted ACK"
          ? kernel
              .dispatch({
                commandId: "blocked-accepted-command",
                kind: "turn.cancel",
                reason: "test.cancel",
              })
              .catch(() => {})
          : null;
      await entered.promise;
      (context as AgentDriverContext | null)?.lifecycle.fail(failure);

      const stopped = await settlePromiseWithTimeout(kernel.stop("join failure"), {
        label: `Kernel ${boundary} failure shutdown`,
        timeoutMs: 100,
      });
      expect(stopped).toEqual({ error: failure, status: "failed" });
      await command;

      if (lateOutcome === "resolve") {
        late.resolve(boundary === "poll" ? null : undefined);
      } else {
        late.reject(new Error("late host port failure"));
      }
      await Bun.sleep(0);
    },
  );

  test("an idle backend failure enters the supervised shutdown path", async () => {
    const backend = createBackend();
    const failure = new Error("provider process exited");
    let context: AgentDriverContext | null = null;
    let stopCount = 0;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    backend.stop = async () => {
      stopCount += 1;
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    (context as AgentDriverContext | null)?.lifecycle.fail(failure);
    await expect(kernel.stop("wait for failure cleanup")).rejects.toBe(failure);

    expect(stopCount).toBe(1);
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("finalizes events only after a late backend stop and the run task settle", async () => {
    type ManualTimer = { active: boolean; run: () => void };

    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    const stopEntered = Promise.withResolvers<void>();
    const stopAborted = Promise.withResolvers<void>();
    const releaseStop = Promise.withResolvers<void>();
    const failure = new Error("backend lifecycle failed");
    let context!: AgentDriverContext;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
    };
    backend.stop = async (_context, _reason, signal) => {
      stopEntered.resolve();
      signal.addEventListener("abort", () => stopAborted.resolve(), { once: true });
      await releaseStop.promise;
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    const input = kernel.dispatch({
      commandId: "late-stop-active-input",
      input: { text: "wait" },
      kind: "input.start",
      requestId: "late-stop-active-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    void input.catch(() => {});
    await inputEntered.promise;

    const nativeClearTimeout = globalThis.clearTimeout;
    const nativeNow = Date.now;
    const nativeSetTimeout = globalThis.setTimeout;
    let shutdownTimer: ManualTimer | null = null;
    Date.now = () => 0;
    globalThis.setTimeout = ((
      callback: (...args: unknown[]) => void,
      delay = 0,
      ...args: unknown[]
    ) => {
      if (delay !== 5_000 || shutdownTimer !== null) {
        return nativeSetTimeout(callback, delay, ...args);
      }

      const timer: ManualTimer = {
        active: true,
        run: () => {
          if (timer.active) {
            callback(...args);
          }
        },
      };
      shutdownTimer = timer;
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      if (handle === (shutdownTimer as unknown as ReturnType<typeof setTimeout>)) {
        if (shutdownTimer !== null) {
          shutdownTimer.active = false;
        }
      } else {
        nativeClearTimeout(handle);
      }
    }) as typeof clearTimeout;

    try {
      context.lifecycle.fail(failure);
      await stopEntered.promise;
      const timer = shutdownTimer as ManualTimer | null;
      expect(timer).not.toBeNull();
      timer?.run();
      await stopAborted.promise;

      const nextEvent = events.next();
      const observed = nextEvent.then((value) => ({ kind: "event" as const, value }));
      releaseStop.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(
        Promise.race([observed, Promise.resolve({ kind: "pending" as const })]),
      ).resolves.toEqual({ kind: "pending" });

      releaseInput.resolve();
      await expect(input).rejects.toBe(failure);
      await expect(observed).resolves.toEqual({
        kind: "event",
        value: {
          done: false,
          value: {
            kind: "run.failed",
            payload: {
              error: {
                code: "driver.runtime_failed",
                details: {},
                message: failure.message,
                retryable: false,
              },
              recoverable: false,
            },
            runId: DRIVER_TEST_IDS.runId,
          },
        },
      });
      await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
      await expect(kernel.stop("join backend failure")).rejects.toBe(failure);
    } finally {
      releaseInput.resolve();
      releaseStop.resolve();
      Date.now = nativeNow;
      globalThis.clearTimeout = nativeClearTimeout;
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("publishes an active backend failure only after input and cleanup settle", async () => {
    const backend = createBackend();
    const cleanupEntered = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    const failure = new Error("provider process exited during input");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
    };
    backend.stop = async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      releaseInput.resolve();
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    const input = kernel.dispatch({
      commandId: "failing-active-input",
      input: { text: "wait" },
      kind: "input.start",
      requestId: "failing-active-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    await inputEntered.promise;
    (context as AgentDriverContext | null)?.lifecycle.fail(failure);

    await expect(input).rejects.toBe(failure);
    const stop = kernel.stop("wait for failure cleanup");
    void stop.catch(() => {});
    await cleanupEntered.promise;
    const terminal = events.next();
    expect(await Promise.race([terminal.then(() => true), Bun.sleep(20).then(() => false)])).toBe(
      false,
    );
    releaseCleanup.resolve();
    await expect(stop).rejects.toBe(failure);
    await expect(terminal).resolves.toMatchObject({
      done: false,
      value: { kind: "run.failed", runId: DRIVER_TEST_IDS.runId },
    });
  });

  test("does not publish a backend failure while cleanup remains failed", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    const failure = new Error("provider process exited during input");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
    };
    backend.stop = async () => {
      releaseInput.resolve();
      throw new Error("cleanup remained failed");
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    const input = kernel.dispatch({
      commandId: "failed-cleanup-input",
      input: { text: "wait" },
      kind: "input.start",
      requestId: "failed-cleanup-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    await inputEntered.promise;
    (context as AgentDriverContext | null)?.lifecycle.fail(failure);

    await expect(input).rejects.toBe(failure);
    await expect(kernel.stop("wait for failed cleanup")).rejects.toBe(failure);
    const terminal = events.next();
    expect(await Promise.race([terminal.then(() => true), Bun.sleep(20).then(() => false)])).toBe(
      false,
    );
  });

  test("drains an active permission before publishing a backend failure terminal", async () => {
    const backend = createBackend();
    const permissionEntered = Promise.withResolvers<void>();
    const cleanupEntered = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const resolutionPublishing = Promise.withResolvers<void>();
    const releaseResolution = Promise.withResolvers<void>();
    const order: string[] = [];
    const failure = new Error("provider failed with a pending permission");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    backend.handleInput = async (inputContext) => {
      const permission = inputContext.ports.permission.request({
        rawInput: null,
        requestId: "backend-failure-permission",
        title: "Allow test tool?",
        toolCallId: "backend-failure-tool",
        toolKind: "test",
      });
      permissionEntered.resolve();
      await permission;
    };
    backend.stop = async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      order.push("cleanup");
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const pushEvents = kernel.pushEvents.bind(kernel);
    kernel.pushEvents = async (input) => {
      if (input.events.some((event) => event.kind === "permission.resolved")) {
        resolutionPublishing.resolve();
        await releaseResolution.promise;
      }

      const result = await pushEvents(input);
      if (input.events.some((event) => event.kind === "permission.resolved")) {
        order.push("permission.resolved");
      }
      return result;
    };
    const events = kernel.events()[Symbol.asyncIterator]();
    const payload = {
      ...bootPayload,
      execution: {
        ...bootPayload.execution,
        permissionPolicy: "supervised" as const,
      },
    };

    await kernel.start(payload);
    const input = kernel.dispatch({
      commandId: "backend-failure-permission-input",
      input: { text: "wait for permission" },
      kind: "input.start",
      requestId: "backend-failure-permission-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    void input.catch(() => {});
    await permissionEntered.promise;
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: "permission.requested",
        runId: DRIVER_TEST_IDS.runId,
      },
    });

    (context as AgentDriverContext | null)?.lifecycle.fail(failure);
    await resolutionPublishing.promise;
    const stop = kernel.stop("wait for failure cleanup");
    void stop.catch(() => {});
    expect(await Promise.race([stop.then(() => true), Bun.sleep(20).then(() => false)])).toBe(
      false,
    );
    const nextEvent = events.next();
    expect(await Promise.race([nextEvent.then(() => true), Bun.sleep(20).then(() => false)])).toBe(
      false,
    );

    releaseResolution.resolve();
    await expect(nextEvent).resolves.toMatchObject({
      done: false,
      value: {
        kind: "permission.resolved",
        runId: DRIVER_TEST_IDS.runId,
      },
    });
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: "diagnostic.reported",
        runId: DRIVER_TEST_IDS.runId,
      },
    });
    await cleanupEntered.promise;
    const terminal = events.next();
    expect(await Promise.race([terminal.then(() => true), Bun.sleep(20).then(() => false)])).toBe(
      false,
    );
    releaseCleanup.resolve();
    await expect(terminal).resolves.toMatchObject({
      done: false,
      value: {
        kind: "run.failed",
        runId: DRIVER_TEST_IDS.runId,
      },
    });
    order.push("control.run.failed");
    expect(order).toEqual(["permission.resolved", "cleanup", "control.run.failed"]);
    await expect(input).rejects.toBe(failure);
    await expect(stop).rejects.toBe(failure);
  });

  test("stop bypasses a full ordinary command queue", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    let stopCount = 0;
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
    };
    backend.stop = async () => {
      stopCount += 1;
      releaseInput.resolve();
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    const pending = [
      kernel
        .dispatch({
          commandId: "blocking-input",
          input: { text: "wait" },
          kind: "input.start",
          requestId: "blocking-request",
          runId: DRIVER_TEST_IDS.runId,
        })
        .catch(() => {}),
    ];
    await inputEntered.promise;
    pending.push(
      kernel
        .dispatch({
          commandId: "queued-input",
          input: { text: "wait again" },
          kind: "input.start",
          requestId: "queued-request",
          runId: DRIVER_TEST_IDS.runId,
        })
        .catch(() => {}),
    );
    await Bun.sleep(0);

    for (let index = 0; index < 1_024; index += 1) {
      pending.push(
        kernel
          .dispatch({
            commandId: `queued-cancel-${index}`,
            kind: "turn.cancel",
            reason: "queued",
          })
          .catch(() => {}),
      );
    }

    await expect(kernel.stop("queue full stop")).resolves.toBeUndefined();
    await Promise.all(pending);
    expect(stopCount).toBe(1);
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "run.completed" },
    });
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("cancels and settles an active input before releasing the backend", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    let stopCount = 0;
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
    };
    backend.cancelActiveTurn = async (_context, reason) => {
      backend.cancelledReasons.push(reason);
      releaseInput.resolve();
    };
    backend.stop = async () => {
      stopCount += 1;
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    await kernel.start(bootPayload);
    const input = kernel.dispatch({
      commandId: "active-input",
      input: { text: "wait" },
      kind: "input.start",
      requestId: "active-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    await inputEntered.promise;
    const stop = kernel.stop("active stop");

    await expect(input).resolves.toBeUndefined();
    await expect(stop).resolves.toBeUndefined();
    expect(backend.cancelledReasons).toEqual(["active stop"]);
    expect(stopCount).toBe(1);
  });

  test("never reports a successful stop while an owned input task is still running", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    let inputSettled = false;
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
      inputSettled = true;
    };
    backend.cancelActiveTurn = async () => {};
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    await kernel.start(bootPayload);
    const input = kernel
      .dispatch({
        commandId: "stuck-input",
        input: { text: "wait" },
        kind: "input.start",
        requestId: "stuck-request",
        runId: DRIVER_TEST_IDS.runId,
      })
      .catch(() => {});
    await inputEntered.promise;
    const nativeSetTimeout = globalThis.setTimeout;
    const acceleratedSetTimeout = (
      callback: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) =>
      nativeSetTimeout(
        callback,
        timeout === ACTIVE_TURN_CANCEL_GRACE_MS + DRIVER_EVENT_DELIVERY_TIMEOUT_MS ? 10 : timeout,
        ...args,
      );
    globalThis.setTimeout = acceleratedSetTimeout as typeof setTimeout;

    try {
      const first = await Promise.allSettled([kernel.stop("first stop")]);
      const second = await Promise.allSettled([kernel.stop("second stop")]);

      expect(first[0]?.status).toBe("rejected");
      expect(second[0]?.status).toBe("rejected");
      expect(inputSettled).toBe(false);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
      releaseInput.resolve();
      await input;
    }
  });

  test("keeps cleanup event delivery available across a transient stop failure", async () => {
    const backend = createBackend();
    let stopCount = 0;
    backend.stop = async (context) => {
      stopCount += 1;

      if (stopCount === 1) {
        throw new Error("cleanup failed");
      }

      await context.ports.eventSink.pushEvents({
        events: [
          {
            kind: "diagnostic.reported",
            payload: {
              code: "cleanup.retried",
              details: {},
              message: "Cleanup retry completed.",
              severity: "info",
              source: "core",
            },
          },
        ],
      });
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    await expect(kernel.stop("first stop")).rejects.toThrow("cleanup failed");
    await expect(kernel.stop("second stop")).resolves.toBeUndefined();

    const received: DriverEventInput[] = [];

    for await (const event of { [Symbol.asyncIterator]: () => events }) {
      received.push(event);
    }

    expect(stopCount).toBe(2);
    expect(received.map((event) => event.kind)).toEqual(["diagnostic.reported", "run.failed"]);
  });

  test.each([
    ["transient", 1, "fulfilled", 2],
    ["two-retry", 2, "fulfilled", 3],
    ["persistent", Number.POSITIVE_INFINITY, "rejected", 3],
  ] as const)(
    "retries %s backend cleanup during and after a stop call",
    async (_name, failures, secondStatus, expectedStops) => {
      const backend = createBackend();
      let stopCount = 0;
      backend.stop = async () => {
        stopCount += 1;

        if (stopCount <= failures) {
          throw new Error("cleanup failed");
        }
      };
      const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
      const events = kernel.events()[Symbol.asyncIterator]();

      await kernel.start(bootPayload);
      await expect(kernel.stop("test.stop")).rejects.toThrow("cleanup failed");
      const [second] = await Promise.allSettled([kernel.stop("test.stop.again")]);

      expect(second?.status).toBe(secondStatus);
      expect(stopCount).toBe(expectedStops);
      if (secondStatus === "fulfilled") {
        await expect(events.next()).resolves.toMatchObject({
          done: false,
          value: { kind: "run.failed" },
        });
        await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
      } else {
        const terminal = events.next();
        expect(
          await Promise.race([terminal.then(() => true), Bun.sleep(20).then(() => false)]),
        ).toBe(false);
      }
      await expect(
        kernel.dispatch({
          commandId: "after-stop-failure",
          kind: "turn.cancel",
          reason: "test",
        }),
      ).rejects.toThrow("not accepting commands: failed");
    },
  );

  test("starts a new cleanup attempt after the previous one times out", async () => {
    const backend = createBackend();
    const firstStopAborted = Promise.withResolvers<void>();
    const stopSignals: AbortSignal[] = [];
    let stopCount = 0;
    backend.stop = async (_context, _reason, signal) => {
      stopCount += 1;
      stopSignals.push(signal);

      if (stopCount === 1) {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              firstStopAborted.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const nativeNow = Date.now;
    const nativeSetTimeout = globalThis.setTimeout;
    const acceleratedSetTimeout = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => nativeSetTimeout(callback, delay === 5_000 ? 10 : delay, ...args);
    Date.now = () => 0;
    globalThis.setTimeout = acceleratedSetTimeout as typeof setTimeout;

    try {
      await kernel.start(bootPayload);
      const firstError = await kernel.stop("first stop").then(
        () => null,
        (error: unknown) => error,
      );
      expect(firstError).toBeInstanceOf(Error);
      expect((firstError as Error).message).toContain("timed out");
      await firstStopAborted.promise;
      expect(stopSignals[0]?.reason).toMatchObject({
        message: "Driver kernel backend shutdown timed out after 5000ms.",
      });
      await expect(kernel.stop("second stop")).resolves.toBeUndefined();
      expect(stopCount).toBe(2);
      expect(stopSignals[1]).not.toBe(stopSignals[0]);
      expect(stopSignals[1]?.aborted).toBe(false);
    } finally {
      Date.now = nativeNow;
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("passes host ports into backend context", async () => {
    const backend = createBackend();
    let mcpOutput: string | null = null;
    let materializedSkillName: string | null = null;
    backend.start = async (context: AgentDriverContext, signal: AbortSignal) => {
      const [skill] = await context.ports.skill.materialize(context.payload.execution, signal);
      materializedSkillName = skill?.skillName ?? null;
    };
    backend.handleInput = async (context: AgentDriverContext) => {
      const command = {
        argumentsJson: '{"ok":true}',
        commandId: "mcp-port-1",
        kind: "mcp.execute" as const,
        requestId: "request-1",
        serverId: "server-1",
        toolCallId: "tool-1",
        toolName: "complete",
      };
      const signal = new AbortController().signal;
      await using prepared = await context.ports.mcp.prepare(command, signal);
      const result = await prepared.execute({
        effectId: "effect-1",
        idempotencyKey: "effect-1",
      });
      mcpOutput = result.outputText;
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
      hostPorts: {
        mcp: {
          prepare: async (command) => ({
            execute: async () => ({
              outputText: `port:${command.toolName}`,
              requestId: command.requestId,
              serverId: command.serverId,
              toolName: command.toolName,
            }),
            async [Symbol.asyncDispose]() {},
          }),
        },
        skill: {
          materialize: async () => [
            {
              mountPath: "/workspace/.mosoo/skill/review",
              skillId: "skill-1",
              skillMarkdownPath: "/workspace/.mosoo/skill/review/SKILL.md",
              skillName: "review",
              snapshotId: "snapshot-1",
            },
          ],
        },
      },
    });

    await kernel.start(bootPayload);
    await kernel.dispatch({
      commandId: "input-ports-1",
      input: {
        text: "hello",
      },
      kind: "input.start",
      requestId: "request-1",
      runId: DRIVER_TEST_IDS.runId,
    });
    await kernel.stop("test.stop");

    expect(mcpOutput).toBe("port:complete");
    expect(materializedSkillName).toBe("review");
  });
});
