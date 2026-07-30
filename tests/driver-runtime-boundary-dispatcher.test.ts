import { describe, expect, test } from "bun:test";

import {
  DriverPermissionBroker,
  PermissionEventDeliveryError,
} from "../src/core/driver-permission-broker";
import {
  DriverRuntimeStateMachine,
  DriverTurnCancellationCleanupError,
} from "../src/core/driver-runtime-state";
import type { RuntimeCommand } from "../src/runtime-command";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import {
  FakeDriverRuntimeIo,
  createBackend,
  createDispatcher,
} from "./driver-runtime-boundary-fixtures";

describe("driver runtime boundary", () => {
  test("delivers a session.stop terminal only after the shutdown barrier", async () => {
    const cleanupEntered = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const order: string[] = [];
    const backend = createBackend();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "stop-report-retry",
        kind: "session.stop",
        reason: "test.stop",
      },
    ]);
    const recordUpdate = socket.commandUpdate.bind(socket);
    const recordComplete = socket.completeRun.bind(socket);
    socket.completeRun = async (signal) => {
      order.push("control.completeRun");
      await recordComplete(signal);
    };
    let terminalAttempts = 0;
    socket.commandUpdate = async (update, signal) => {
      if (update.status !== "accepted") {
        terminalAttempts += 1;
        if (terminalAttempts < 3) {
          throw new Error("control socket unavailable");
        }
      }

      await recordUpdate(update, signal);
    };
    const { dispatcher, logger, shutdownCalls } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
      shutdown: async (_socket, reason) => {
        shutdownCalls.push(reason);
        cleanupEntered.resolve();
        await releaseCleanup.promise;
        order.push("cleanup");
      },
    });

    const run = dispatcher.run(socket, logger);
    await cleanupEntered.promise;
    expect(terminalAttempts).toBe(0);
    expect(socket.completedRunReasons).toEqual([]);
    releaseCleanup.resolve();
    await run;
    await logger.destroy();

    expect(terminalAttempts).toBe(3);
    expect(order).toEqual(["cleanup", "control.completeRun"]);
    expect(shutdownCalls).toEqual(["test.stop"]);
    expect(socket.updates.at(-1)).toEqual({
      commandId: "stop-report-retry",
      status: "completed",
    });
  });

  test("gives session.stop the full permission shutdown delivery budget", async () => {
    const requestedPublishing = Promise.withResolvers<void>();
    const releaseRequested = Promise.withResolvers<void>();
    const order: string[] = [];
    const backend = createBackend();
    backend.cancelActiveTurn = async () => {
      order.push("run.cancelled");
    };
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const permissions = new DriverPermissionBroker(() => null, {
      eventDeliveryTimeoutMs: 10_000,
    });
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-with-permission",
        input: { text: "wait for permission" },
        kind: "input.start",
        requestId: "input-with-permission-request",
        runId: DRIVER_TEST_IDS.runId,
      },
      {
        commandId: "stop-with-permission",
        kind: "session.stop",
        reason: "test.stop",
      },
    ]);
    const pushEvents = socket.pushEvents.bind(socket);
    const completeRun = socket.completeRun.bind(socket);
    socket.completeRun = async (signal) => {
      order.push("control.completeRun");
      await completeRun(signal);
    };
    socket.pushEvents = async (input) => {
      if (input.events.some((event) => event.kind === "permission.requested")) {
        requestedPublishing.resolve();
        await Promise.race([
          releaseRequested.promise,
          new Promise<never>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
              once: true,
            });
          }),
        ]);
      }

      const result = await pushEvents(input);
      order.push(...input.events.map((event) => event.kind));
      return result;
    };
    let permission: Promise<"allow_once" | "reject_once"> | null = null;
    backend.handleInput = async () => {
      permission = permissions.request(socket, {
        rawInput: null,
        requestId: "stop-permission",
        title: "Allow test tool?",
        toolCallId: "tool-stop",
        toolKind: "test",
      });
      await permission;
    };
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      permissionRequests: permissions,
      runtimeState,
      shutdown: async () => {
        order.push("cleanup");
      },
    });
    const run = dispatcher.run(socket, logger);

    await requestedPublishing.promise;
    await Bun.sleep(5_100);
    releaseRequested.resolve();
    await expect(Promise.all([permission!, run])).resolves.toEqual(["reject_once", undefined]);
    await logger.destroy();
    expect(
      order.filter((kind) =>
        ["permission.resolved", "run.cancelled", "cleanup", "control.completeRun"].includes(kind),
      ),
    ).toEqual(["permission.resolved", "run.cancelled", "cleanup", "control.completeRun"]);
    expect(socket.updates.at(-1)).toMatchObject({
      commandId: "stop-with-permission",
      status: "completed",
    });
  }, 8_000);

  test("fails the run when cancellation crosses a permission delivery failure", async () => {
    const inputEntered = Promise.withResolvers<void>();
    const failInput = Promise.withResolvers<void>();
    const deliveryFailure = new PermissionEventDeliveryError(
      "cancelled-permission",
      "resolved",
      new Error("permission transport unavailable"),
    );
    const backend = createBackend();
    backend.handleInput = async () => {
      inputEntered.resolve();
      await failInput.promise;
      throw deliveryFailure;
    };
    backend.cancelActiveTurn = async () => {
      await inputEntered.promise;
      failInput.resolve();
    };
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-before-permission-failure",
        input: { text: "wait for permission" },
        kind: "input.start",
        requestId: "request-before-permission-failure",
        runId: DRIVER_TEST_IDS.runId,
      },
      {
        commandId: "cancel-with-permission-failure",
        kind: "turn.cancel",
        reason: "test cancellation",
      },
    ]);
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
    });

    await expect(dispatcher.run(socket, logger)).resolves.toBeUndefined();
    await logger.destroy();

    expect(socket.failedRuns).toHaveLength(1);
    expect(socket.completedRunReasons).toEqual([]);
    expect(
      socket.pushedEvents.flatMap(({ events }) =>
        events.filter((event) => event.kind === "run.cancelled"),
      ),
    ).toEqual([]);
    expect(socket.updates).toEqual([
      {
        commandId: "input-before-permission-failure",
        status: "accepted",
      },
      {
        commandId: "cancel-with-permission-failure",
        status: "accepted",
      },
      expect.objectContaining({
        commandId: "input-before-permission-failure",
        status: "failed",
      }),
      {
        commandId: "cancel-with-permission-failure",
        status: "completed",
      },
    ]);
    expect(runtimeState.status()).toBe("failed");
  });

  test("fails the run when cancelled provider cleanup fails", async () => {
    const inputEntered = Promise.withResolvers<void>();
    const failInput = Promise.withResolvers<void>();
    const backend = createBackend();
    backend.handleInput = async () => {
      inputEntered.resolve();
      await failInput.promise;
      throw new DriverTurnCancellationCleanupError(
        "provider recycle failed",
        new Error("resume failed"),
      );
    };
    backend.cancelActiveTurn = async () => {
      await inputEntered.promise;
      failInput.resolve();
    };
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-before-cleanup-failure",
        input: { text: "wait for cancellation" },
        kind: "input.start",
        requestId: "request-before-cleanup-failure",
        runId: DRIVER_TEST_IDS.runId,
      },
      {
        commandId: "cancel-with-cleanup-failure",
        kind: "turn.cancel",
        reason: "test cancellation",
      },
    ]);
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
    });

    await expect(dispatcher.run(socket, logger)).resolves.toBeUndefined();
    await logger.destroy();

    expect(socket.failedRuns).toHaveLength(1);
    expect(
      socket.pushedEvents.flatMap(({ events }) =>
        events.filter((event) => event.kind === "run.cancelled"),
      ),
    ).toEqual([]);
    expect(socket.updates).toContainEqual(
      expect.objectContaining({
        commandId: "input-before-cleanup-failure",
        status: "failed",
      }),
    );
    expect(runtimeState.status()).toBe("failed");
  });

  test("cancels admitted input before waiting for the cancel accepted acknowledgement", async () => {
    const providerAdmission = Promise.withResolvers<void>();
    const releaseProviderAdmission = Promise.withResolvers<void>();
    let cancellationRequested = false;
    let sideEffects = 0;
    const backend = createBackend();
    backend.handleInput = async (_context, _input, _runId, signal) => {
      providerAdmission.resolve();
      await releaseProviderAdmission.promise;
      signal?.throwIfAborted();
      sideEffects += 1;
    };
    backend.cancelActiveTurn = async () => {
      cancellationRequested = true;
      releaseProviderAdmission.resolve();
    };
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-before-eager-cancel",
        input: { text: "must not run" },
        kind: "input.start",
        requestId: "request-before-eager-cancel",
        runId: DRIVER_TEST_IDS.runId,
      },
      {
        commandId: "eager-cancel",
        kind: "turn.cancel",
        reason: "test cancellation",
      },
    ]);
    const cancelAccepted = Promise.withResolvers<void>();
    const releaseCancelAccepted = Promise.withResolvers<void>();
    const recordUpdate = socket.commandUpdate.bind(socket);
    socket.commandUpdate = async (update, signal) => {
      if (update.commandId === "eager-cancel" && update.status === "accepted") {
        cancelAccepted.resolve();
        await releaseCancelAccepted.promise;
      }
      await recordUpdate(update, signal);
    };
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
    });
    const run = dispatcher.run(socket, logger);

    await cancelAccepted.promise;
    await providerAdmission.promise;
    await Bun.sleep(0);
    releaseCancelAccepted.resolve();
    await run;
    await logger.destroy();

    expect(cancellationRequested).toBe(true);
    expect(sideEffects).toBe(0);
    expect(socket.updates).toContainEqual({
      commandId: "input-before-eager-cancel",
      status: "cancelled",
    });
    expect(socket.updates.at(-1)).toEqual({
      commandId: "eager-cancel",
      status: "completed",
    });
  });

  test("does not report an input failure before a rejected shutdown barrier", async () => {
    const backend = createBackend();
    backend.failInput = true;
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-with-rejected-cleanup",
        input: { text: "fail" },
        kind: "input.start",
        requestId: "request-with-rejected-cleanup",
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
      shutdown: async () => {
        throw new Error("cleanup remained failed");
      },
    });

    await expect(dispatcher.run(socket, logger)).resolves.toBeUndefined();
    await logger.destroy();

    expect(socket.failedRuns).toEqual([]);
    expect(runtimeState.status()).toBe("failed");
  });

  test("reports an input failure after a cleanup retry succeeds", async () => {
    const backend = createBackend();
    backend.failInput = true;
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-with-cleanup-retry",
        input: { text: "fail" },
        kind: "input.start",
        requestId: "request-with-cleanup-retry",
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
    let cleanupAttempts = 0;
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
      shutdown: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          throw new Error("cleanup failed");
        }
      },
    });

    await expect(dispatcher.run(socket, logger)).resolves.toBeUndefined();
    await logger.destroy();

    expect(cleanupAttempts).toBe(2);
    expect(socket.failedRuns).toHaveLength(1);
  });

  test.each(["completed", "failed"] as const)(
    "retries a transient %s run terminal within the current command",
    async (runStatus) => {
      const backend = createBackend();
      backend.failInput = runStatus === "failed";
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const command: RuntimeCommand =
        runStatus === "completed"
          ? {
              commandId: "stop-run-terminal-retry",
              kind: "session.stop",
              reason: "test.stop",
            }
          : {
              commandId: "input-run-terminal-retry",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "request-run-terminal-retry",
              runId: DRIVER_TEST_IDS.runId,
            };
      const socket = new FakeDriverRuntimeIo([command]);
      let attempts = 0;

      if (runStatus === "completed") {
        const recordTerminal = socket.completeRun.bind(socket);
        socket.completeRun = async (signal) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("run terminal temporarily unavailable");
          }

          await recordTerminal(signal);
        };
      } else {
        const recordTerminal = socket.failRun.bind(socket);
        socket.failRun = async (error, signal) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("run terminal temporarily unavailable");
          }

          await recordTerminal(error, signal);
        };
      }

      const expectedCommandStatus = runStatus === "completed" ? "completed" : "failed";
      const { dispatcher, logger, shutdownCalls } = createDispatcher({
        backend,
        isShuttingDown: () =>
          socket.updates.some(
            (update) =>
              update.commandId === command.commandId && update.status === expectedCommandStatus,
          ),
        runtimeState,
      });

      await dispatcher.run(socket, logger);
      await logger.destroy();

      expect(attempts).toBe(2);
      expect(socket.completedRunReasons).toHaveLength(runStatus === "completed" ? 1 : 0);
      expect(socket.failedRuns).toHaveLength(runStatus === "failed" ? 1 : 0);
      expect(runtimeState.status()).toBe(runStatus === "completed" ? "stopped" : "failed");
      expect(shutdownCalls).toHaveLength(1);
      expect(socket.updates.map(({ status }) => status)).toEqual([
        "accepted",
        expectedCommandStatus,
      ]);
    },
  );

  test.each(["rejects", "hangs"] as const)(
    "bounds a session.stop run terminal that persistently %s",
    async (failureMode) => {
      const backend = createBackend();
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const socket = new FakeDriverRuntimeIo([
        {
          commandId: "stop-run-terminal-failure",
          kind: "session.stop",
          reason: "test.stop",
        },
      ]);
      const signals: AbortSignal[] = [];
      let attempts = 0;
      socket.completeRun = async (signal) => {
        attempts += 1;
        if (signal !== undefined) {
          signals.push(signal);
        }

        if (failureMode === "rejects") {
          throw new Error("run terminal unavailable");
        }

        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      };
      const { dispatcher, logger, shutdownCalls } = createDispatcher({
        backend,
        isShuttingDown: () => socket.isDrained(),
        runtimeState,
      });

      const outcome = await settlePromiseWithTimeout(dispatcher.run(socket, logger), {
        label: `session stop run terminal that ${failureMode}`,
        timeoutMs: 1_500,
      });
      await logger.destroy();

      expect(outcome.status).toBe("completed");
      expect(attempts).toBe(3);
      expect(signals).toHaveLength(3);
      expect(signals.every(({ aborted }) => aborted)).toBe(true);
      expect(socket.completedRunReasons).toEqual([]);
      expect(socket.failedRuns).toEqual([]);
      expect(runtimeState.status()).toBe("failed");
      expect(shutdownCalls).toEqual(["test.stop"]);
      expect(socket.updates.map(({ status }) => status)).toEqual(["accepted", "failed"]);
    },
  );

  test.each(["input", "mcp", "stop"] as const)(
    "fail-stops when a %s terminal update exhausts its retry budget",
    async (kind) => {
      const backend = createBackend();
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const command: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "input-terminal-failure",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "request-terminal-failure",
              runId: DRIVER_TEST_IDS.runId,
            }
          : kind === "mcp"
            ? {
                argumentsJson: "{}",
                commandId: "mcp-terminal-failure",
                kind: "mcp.execute",
                requestId: "request-terminal-failure",
                serverId: "mcp-linear",
                toolName: "createIssue",
              }
            : {
                commandId: "stop-terminal-failure",
                kind: "session.stop",
                reason: "test.stop",
              };
      const socket = new FakeDriverRuntimeIo([command]);
      const shutdown = new AbortController();
      let terminalAttempts = 0;
      const shutdownCalls: string[] = [];
      socket.commandUpdate = async (update) => {
        if (update.status === "accepted") {
          socket.updates.push(update);
          return;
        }

        terminalAttempts += 1;
        throw new Error("control socket unavailable");
      };
      const { dispatcher, logger } = createDispatcher({
        backend,
        isShuttingDown: () => shutdown.signal.aborted,
        ...(kind === "stop" ? { rememberRunFailure: () => {} } : {}),
        runtimeState,
        shutdown: async (_socket, reason) => {
          shutdownCalls.push(reason);
          shutdown.abort(new Error(reason));
        },
        shutdownSignal: shutdown.signal,
      });

      await expect(dispatcher.run(socket, logger)).rejects.toThrow(
        "terminal status could not be delivered",
      );
      await logger.destroy();

      expect(terminalAttempts).toBe(3);
      expect(runtimeState.status()).toBe("failed");
      expect(socket.failedRuns).toHaveLength(kind === "stop" ? 0 : 1);
      expect(socket.completedRunReasons).toHaveLength(kind === "stop" ? 1 : 0);
      expect(shutdownCalls.length).toBeGreaterThan(0);
    },
  );

  test("does not rewrite a completed run when every stop ACK attempt times out", async () => {
    const backend = createBackend();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const shutdown = new AbortController();
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "stop-terminal-timeout",
        kind: "session.stop",
        reason: "test.stop",
      },
    ]);
    const recordUpdate = socket.commandUpdate.bind(socket);
    let terminalAttempts = 0;
    socket.commandUpdate = async (update, signal) => {
      if (update.status === "accepted") {
        await recordUpdate(update, signal);
        return;
      }

      terminalAttempts += 1;
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => shutdown.signal.aborted,
      rememberRunFailure: () => {},
      runtimeState,
      shutdown: async (_runtimeSocket, reason) => {
        shutdown.abort(new Error(reason));
      },
      shutdownSignal: shutdown.signal,
    });

    await expect(dispatcher.run(socket, logger)).rejects.toThrow(
      "terminal status could not be delivered",
    );
    await logger.destroy();

    expect(terminalAttempts).toBe(1);
    expect(socket.completedRunReasons).toHaveLength(1);
    expect(socket.failedRuns).toEqual([]);
    expect(runtimeState.status()).toBe("failed");
  });

  test.each(["input", "mcp"] as const)(
    "accepts a slow %s terminal response before settling later work",
    async (kind) => {
      const backend = createBackend();
      let sideEffects = 0;
      backend.handleInput = async () => {
        sideEffects += 1;
      };
      const first: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "ack-blocked-input",
              input: { text: "first" },
              kind: "input.start",
              requestId: "ack-blocked-request",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              argumentsJson: "{}",
              commandId: "ack-blocked-mcp",
              kind: "mcp.execute",
              requestId: "ack-blocked-request",
              serverId: "mcp-linear",
              toolName: "createIssue",
            };
      const next: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "input-after-blocked-ack",
              input: { text: "second" },
              kind: "input.start",
              requestId: "request-after-blocked-ack",
              runId: DRIVER_TEST_IDS.secondRunId,
            }
          : {
              commandId: "stop-after-blocked-ack",
              kind: "session.stop",
              reason: "test.stop",
            };
      const socket = new FakeDriverRuntimeIo([first, next]);
      const recordUpdate = socket.commandUpdate.bind(socket);
      let terminalAttempts = 0;
      socket.commandUpdate = async (update, signal) => {
        if (update.commandId === first.commandId && update.status !== "accepted") {
          terminalAttempts += 1;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 300);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(signal.reason);
              },
              { once: true },
            );
          });
        }

        await recordUpdate(update, signal);
      };
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const { dispatcher, logger } = createDispatcher({
        backend,
        isShuttingDown: () =>
          kind === "input"
            ? socket.updates.some(
                (update) => update.commandId === next.commandId && update.status === "completed",
              )
            : socket.isDrained(),
        mcpExecute: async (command) => {
          sideEffects += 1;
          return {
            outputText: `ran ${command.toolName}`,
            requestId: command.requestId,
            serverId: command.serverId,
            toolName: command.toolName,
          };
        },
        runtimeState,
      });
      const run = dispatcher.run(socket, logger);

      const outcome = await settlePromiseWithTimeout(run, {
        label: `${kind} slow terminal acknowledgement`,
        timeoutMs: 1_500,
      });
      await logger.destroy();

      expect(outcome.status).toBe("completed");
      expect(terminalAttempts).toBe(1);
      expect(sideEffects).toBe(kind === "input" ? 2 : 1);
    },
  );

  test("fail-stops at the per-worker history limit without evicting replay evidence", async () => {
    const backend = createBackend();
    const commands: RuntimeCommand[] = Array.from({ length: 1_025 }, (_, index) => ({
      commandId: `cancel-${index}`,
      kind: "turn.cancel",
      reason: `reason-${index}`,
    }));
    commands.push(structuredClone(commands[0]!));
    const socket = new FakeDriverRuntimeIo(commands);
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
    });

    await expect(dispatcher.run(socket, logger)).rejects.toThrow("history capacity");
    await logger.destroy();

    expect(backend.cancelledReasons).toHaveLength(1_024);
    expect(backend.cancelledReasons[0]).toBe("reason-0");
    expect(runtimeState.status()).toBe("failed");
  });

  test("stops sessions as terminal commands and reports run completion", async () => {
    const backend = createBackend();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "stop-1",
        kind: "session.stop",
        reason: "viewer.closed",
      },
    ]);
    const { dispatcher, logger, shutdownCalls } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
    });

    await dispatcher.run(socket, logger);
    await logger.destroy();

    expect(runtimeState.status()).toBe("stopped");
    expect(socket.completedRunReasons).toEqual(["completed"]);
    expect(shutdownCalls).toHaveLength(1);
    expect(socket.updates).toEqual([
      {
        commandId: "stop-1",
        status: "accepted",
      },
      {
        commandId: "stop-1",
        status: "completed",
      },
    ]);
  });
});
