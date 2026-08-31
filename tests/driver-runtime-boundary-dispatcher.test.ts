import { describe, expect, test } from "bun:test";

import {
  DriverPermissionBroker,
  PermissionEventDeliveryError,
} from "../src/core/driver-permission-broker";
import {
  DriverRuntimeStateMachine,
  DriverTurnCancellationCleanupError,
  DriverTurnCancelledError,
} from "../src/core/driver-runtime-state";
import type { RuntimeCommand } from "../src/runtime-command";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import {
  FakeDriverRuntimeIo,
  createBackend,
  createDispatcher,
  waitForUpdate,
} from "./driver-runtime-boundary-fixtures";

describe("driver runtime boundary", () => {
  test("parses a custom command source before acknowledgement or business side effects", async () => {
    const backend = createBackend();
    const invalid = {
      argumentsJson: "{}",
      commandId: "invalid-custom-source",
      extra: true,
      kind: "mcp.execute",
      requestId: "invalid-custom-source-request",
      runId: DRIVER_TEST_IDS.runId,
      serverId: "mcp-linear",
      toolCallId: "invalid-custom-source-tool",
      toolName: "createIssue",
    } as unknown as RuntimeCommand;
    const socket = new FakeDriverRuntimeIo([invalid], DRIVER_TEST_IDS.runId);
    let preparations = 0;
    const { dispatcher, logger } = createDispatcher({
      backend,
      mcpPrepare: async () => {
        preparations += 1;
        throw new Error("invalid command reached MCP preparation");
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await expect(dispatcher.run(socket, logger)).rejects.toThrow(
      "runtime command.extra is not allowed",
    );

    expect(socket.updates).toEqual([]);
    expect(preparations).toBe(0);
  });

  test("projects durable attachment provenance to provider-neutral text", async () => {
    const backend = createBackend();
    const providerInputs: unknown[] = [];
    backend.handleInput = async (context, input, runId) => {
      providerInputs.push(structuredClone(input));
      await context.ports.eventSink.pushEvents({
        events: [
          {
            kind: "run.completed",
            payload: { status: "completed" },
            runId,
            sourceEventId: `attachment-projection.completed:${runId}`,
          },
        ],
      });
    };
    const command = {
      commandId: "attachment-projection",
      input: { attachmentIds: ["file-1"], text: "materialized attachment" },
      kind: "input.start",
      requestId: "attachment-projection-request",
      runId: DRIVER_TEST_IDS.runId,
    } as unknown as RuntimeCommand;
    const socket = new FakeDriverRuntimeIo([command]);
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await dispatcher.run(socket, logger);
    await waitForUpdate(
      socket,
      (update) => update.commandId === "attachment-projection" && update.status === "completed",
    );

    expect(providerInputs).toEqual([{ text: "materialized attachment" }]);
  });

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
    backend.handleInput = async (context, _input, runId) => {
      permission = permissions.request(socket, {
        rawInput: null,
        requestId: "stop-permission",
        title: "Allow test tool?",
        toolCallId: "tool-stop",
        toolKind: "test",
      });
      await permission;
      await context.ports.eventSink.pushEvents({
        events: [
          {
            kind: "run.cancelled",
            payload: { reason: "test.stop", status: "cancelled" },
            runId,
            sourceEventId: `stop-permission.cancelled:${runId}`,
          },
        ],
      });
      throw new DriverTurnCancelledError("test.stop");
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
    expect(
      order
        .filter((kind) =>
          ["permission.resolved", "run.cancelled", "cleanup", "control.completeRun"].includes(kind),
        )
        .filter((kind, index, values) => index === 0 || kind !== values[index - 1]),
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
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
    });

    await expect(dispatcher.run(socket, logger)).resolves.toBeUndefined();

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
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
    });

    await expect(dispatcher.run(socket, logger)).resolves.toBeUndefined();

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
    backend.handleInput = async (context, _input, runId, signal) => {
      providerAdmission.resolve();
      await releaseProviderAdmission.promise;
      if (signal?.aborted) {
        await context.ports.eventSink.pushEvents({
          events: [
            {
              kind: "run.cancelled",
              payload: { reason: "test cancellation", status: "cancelled" },
              runId,
              sourceEventId: `eager-cancel.cancelled:${runId}`,
            },
          ],
        });
        signal.throwIfAborted();
      }
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
        runId: DRIVER_TEST_IDS.runId,
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

  test("rejects stale run commands before acknowledgement or side effects", async () => {
    const backend = createBackend();
    const permissions = new DriverPermissionBroker(() => null);
    const socket = new FakeDriverRuntimeIo(
      [
        {
          commandId: "stale-cancel",
          kind: "turn.cancel",
          reason: "must not cancel",
          runId: DRIVER_TEST_IDS.runId,
        },
        {
          commandId: "stale-permission",
          decision: "allow_once",
          kind: "permission.resolve",
          requestId: "active-permission",
          runId: DRIVER_TEST_IDS.runId,
        },
        {
          argumentsJson: "{}",
          commandId: "stale-mcp",
          kind: "mcp.execute",
          requestId: "stale-mcp-request",
          runId: DRIVER_TEST_IDS.runId,
          serverId: "stale-server",
          toolCallId: "stale-tool-call",
          toolName: "mustNotRun",
        },
        {
          commandId: "stale-input",
          input: { text: "must not run" },
          kind: "input.start",
          requestId: "stale-input-request",
          runId: DRIVER_TEST_IDS.runId,
        },
      ],
      DRIVER_TEST_IDS.secondRunId,
    );
    const permission = permissions.request(socket, {
      rawInput: null,
      requestId: "active-permission",
      title: "Allow active run?",
      toolCallId: "active-tool-call",
      toolKind: "test",
    });
    let mcpPreparations = 0;
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      mcpPrepare: async () => {
        mcpPreparations += 1;
        throw new Error("stale MCP command reached preparation");
      },
      permissionRequests: permissions,
      runtimeState,
    });

    await dispatcher.run(socket, logger);

    expect(socket.updates).toHaveLength(4);
    expect(socket.updates).toEqual(
      expect.arrayContaining(
        ["stale-cancel", "stale-permission", "stale-mcp", "stale-input"].map((commandId) =>
          expect.objectContaining({
            commandId,
            status: "failed",
          }),
        ),
      ),
    );
    expect(socket.updates.some((update) => update.status === "accepted")).toBe(false);
    expect(socket.currentRunId()).toBe(DRIVER_TEST_IDS.secondRunId);
    expect(backend.cancelledReasons).toEqual([]);
    expect(backend.handledInputs).toEqual([]);
    expect(mcpPreparations).toBe(0);
    expect(permissions.hasPending()).toBe(false);
    await expect(permission).resolves.toBe("reject_once");
  });

  test("rechecks permission ownership after the accepted acknowledgement", async () => {
    let currentRunId = DRIVER_TEST_IDS.runId;
    class RunSwitchingSocket extends FakeDriverRuntimeIo {
      override currentRunId() {
        return currentRunId;
      }

      override async commandUpdate(
        update: Parameters<FakeDriverRuntimeIo["commandUpdate"]>[0],
        signal: AbortSignal,
      ) {
        await super.commandUpdate(update, signal);
        if (update.status === "accepted") {
          currentRunId = DRIVER_TEST_IDS.secondRunId;
        }
      }
    }
    const command: RuntimeCommand = {
      commandId: "permission-run-switch",
      decision: "allow_once",
      kind: "permission.resolve",
      requestId: "permission-run-switch-request",
      runId: DRIVER_TEST_IDS.runId,
    };
    const socket = new RunSwitchingSocket([command], DRIVER_TEST_IDS.runId);
    const permissions = new DriverPermissionBroker(() => null);
    const pending = permissions.request(socket, {
      rawInput: null,
      requestId: command.requestId,
      title: "Allow test tool?",
      toolCallId: "permission-run-switch-tool",
      toolKind: "test",
    });
    const { dispatcher, logger } = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      permissionRequests: permissions,
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await dispatcher.run(socket, logger);

    expect(socket.updates.map(({ status }) => status)).toEqual(["accepted", "failed"]);
    expect(permissions.hasPending()).toBeFalse();
    await expect(pending).resolves.toBe("reject_once");
  });

  test.each(["session.stop"] as const)(
    "rejects provider permission requests after the terminal before %s",
    async (controlKind) => {
      const permissionPending = Promise.withResolvers<void>();
      const permissionSettled = Promise.withResolvers<void>();
      const controlAccepted = Promise.withResolvers<void>();
      const releaseControlAccepted = Promise.withResolvers<void>();
      const backendCancelled = Promise.withResolvers<void>();
      let cancellationRequests = 0;
      let mcpPreparations = 0;
      let permissionDecision: "allow_once" | "reject_once" | null = null;
      let providerSignal: AbortSignal | undefined;
      const permissions = new DriverPermissionBroker(() => null);
      const backend = createBackend();
      backend.handleInput = async (context, _input, _runId, signal) => {
        providerSignal = signal;
        await context.ports.eventSink.pushEvents({
          events: [
            {
              kind: "run.completed",
              payload: { stopReason: "end_turn" },
              sourceEventId: "terminal-wins-cancel-race",
            },
          ],
        });
        const permission = permissions.request(
          socket,
          {
            rawInput: null,
            requestId: "terminal-first-permission",
            title: "Allow terminal-first test?",
            toolCallId: "terminal-first-permission-tool",
            toolKind: "test",
          },
          signal,
        );
        permissionPending.resolve();
        permissionDecision = await permission;
        permissionSettled.resolve();
      };
      backend.cancelActiveTurn = async () => {
        cancellationRequests += 1;
        backendCancelled.resolve();
      };
      const control: RuntimeCommand =
        controlKind === "turn.cancel"
          ? {
              commandId: "terminal-first-control",
              kind: "turn.cancel",
              reason: "too late",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              commandId: "terminal-first-control",
              kind: "session.stop",
              reason: "stop after terminal",
            };
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const socket = new FakeDriverRuntimeIo([
        {
          commandId: "input-terminal-first",
          input: { text: "finish" },
          kind: "input.start",
          requestId: "request-terminal-first",
          runId: DRIVER_TEST_IDS.runId,
        },
        {
          argumentsJson: "{}",
          commandId: "mcp-after-terminal",
          kind: "mcp.execute",
          requestId: "request-mcp-after-terminal",
          runId: DRIVER_TEST_IDS.runId,
          serverId: "mcp-linear",
          toolCallId: "tool-mcp-after-terminal",
          toolName: "createIssue",
        },
        control,
      ]);
      const nextCommand = socket.nextCommand.bind(socket);
      let reads = 0;
      socket.nextCommand = async (signal) => {
        reads += 1;
        if (reads === 2) {
          await permissionPending.promise;
        }
        return nextCommand(signal);
      };
      const commandUpdate = socket.commandUpdate.bind(socket);
      socket.commandUpdate = async (update, signal) => {
        await commandUpdate(update, signal);
        if (update.commandId === control.commandId && update.status === "accepted") {
          controlAccepted.resolve();
          await releaseControlAccepted.promise;
        }
      };
      const { dispatcher, logger } = createDispatcher({
        backend,
        isShuttingDown: () =>
          socket.updates.some(
            (update) => update.commandId === control.commandId && update.status === "completed",
          ),
        mcpPrepare: async () => {
          mcpPreparations += 1;
          throw new Error("MCP command crossed the run terminal fence");
        },
        permissionRequests: permissions,
        runtimeState,
      });

      const run = dispatcher.run(socket, logger);
      await controlAccepted.promise;
      const pendingAtAcceptance = permissions.hasPending();
      releaseControlAccepted.resolve();
      await permissionSettled.promise;

      expect(providerSignal?.aborted).toBe(false);
      expect(pendingAtAcceptance).toBe(false);
      expect(mcpPreparations).toBe(0);
      expect(
        socket.updates.some(
          (update) => update.commandId === "mcp-after-terminal" && update.status === "accepted",
        ),
      ).toBe(false);

      if (controlKind === "session.stop") {
        await backendCancelled.promise;
        expect(cancellationRequests).toBe(1);
        expect(permissions.hasPending()).toBe(false);
      } else {
        expect(cancellationRequests).toBe(0);
      }
      await run;

      expect(permissionDecision).toBe("reject_once");
      expect(socket.updates).toContainEqual({
        commandId: "input-terminal-first",
        result: { requestId: "request-terminal-first" },
        status: "completed",
      });
      expect(socket.updates).toContainEqual(
        expect.objectContaining({
          commandId: "mcp-after-terminal",
          status: "failed",
        }),
      );
      expect(socket.updates.at(-1)).toEqual({
        commandId: control.commandId,
        status: "completed",
      });
    },
  );

  test("closes a pending custom-backend permission before publishing the run terminal", async () => {
    const resolutionPersisted = Promise.withResolvers<void>();
    const releaseResolutionAck = Promise.withResolvers<void>();
    const permissions = new DriverPermissionBroker(() => null);
    let permissionOutcome: Promise<"allow_once" | "reject_once"> | null = null;
    let requestedAttempts = 0;
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-with-pending-permission",
        input: { text: "finish while permission is pending" },
        kind: "input.start",
        requestId: "input-with-pending-permission-request",
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
    const pushEvents = socket.pushEvents.bind(socket);
    socket.pushEvents = async (input) => {
      const result = await pushEvents(input);
      if (input.events.some(({ kind }) => kind === "permission.requested")) {
        requestedAttempts += 1;
        if (requestedAttempts === 1) {
          throw new Error("permission.requested ACK lost after persistence");
        }
      }
      if (input.events.some(({ kind }) => kind === "permission.resolved")) {
        resolutionPersisted.resolve();
        await releaseResolutionAck.promise;
      }
      return result;
    };
    const backend = createBackend();
    backend.handleInput = async (context, _input, runId) => {
      const permission = context.ports.permission.request({
        rawInput: null,
        requestId: "pending-custom-permission",
        title: "Allow custom backend action?",
        toolCallId: "pending-custom-permission-tool",
        toolKind: "test",
      });
      await context.ports.eventSink.pushEvents({
        events: [
          {
            kind: "run.completed",
            payload: { stopReason: "end_turn" },
            runId,
            sourceEventId: `permission-barrier.completed:${runId}`,
          },
        ],
      });
      await permission;
    };
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () =>
        socket.updates.some(
          ({ commandId, status }) =>
            commandId === "input-with-pending-permission" && status === "completed",
        ),
      permissionRequest: (input, signal) => {
        permissionOutcome = permissions.request(socket, input, signal);
        return permissionOutcome;
      },
      permissionRequests: permissions,
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    const run = dispatcher.run(socket, logger);
    await resolutionPersisted.promise;
    expect(permissions.hasPending()).toBe(true);
    expect(
      socket.pushedEvents.flatMap(({ events }) => events.map(({ kind }) => kind)),
    ).not.toContain("run.completed");

    releaseResolutionAck.resolve();
    await run;

    const kinds = socket.pushedEvents.flatMap(({ events }) => events.map(({ kind }) => kind));
    expect(requestedAttempts).toBe(2);
    expect(permissionOutcome).not.toBeNull();
    await expect(permissionOutcome!).resolves.toBe("reject_once");
    expect(kinds.indexOf("permission.resolved")).toBeLessThan(kinds.indexOf("run.completed"));
    expect(kinds.slice(kinds.indexOf("run.completed") + 1)).not.toContain("permission.resolved");
  });

  test("blocks the terminal until an orphaned permission ACK lifecycle recovers", async () => {
    const permissions = new DriverPermissionBroker(() => null);
    const socket = new FakeDriverRuntimeIo([], DRIVER_TEST_IDS.runId);
    const pushEvents = socket.pushEvents.bind(socket);
    let failPermissionDelivery = true;
    let permissionAttempts = 0;
    socket.pushEvents = async (input) => {
      if (
        failPermissionDelivery &&
        input.events.some(({ kind }) => kind === "permission.requested")
      ) {
        permissionAttempts += 1;
        if (permissionAttempts === 1) {
          await pushEvents(input);
        }
        throw new Error("permission ACK permanently unavailable");
      }
      return pushEvents(input);
    };

    await expect(
      permissions.request(socket, {
        rawInput: null,
        requestId: "orphaned-permission",
        title: "Allow unavailable action?",
        toolCallId: "orphaned-permission-tool",
        toolKind: "test",
      }),
    ).rejects.toBeInstanceOf(PermissionEventDeliveryError);
    expect(permissions.hasPending()).toBe(false);
    socket.registerRunTerminalBarrier((events) =>
      events.some(({ kind }) => kind === "run.completed")
        ? permissions.rejectRunAndWait(DRIVER_TEST_IDS.runId)
        : undefined,
    );

    await expect(
      socket.pushEvents({
        events: [
          {
            kind: "run.completed",
            payload: { stopReason: "end_turn" },
            runId: DRIVER_TEST_IDS.runId,
            sourceEventId: "blocked-by-permission-failure",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(PermissionEventDeliveryError);
    expect(socket.runSnapshot(DRIVER_TEST_IDS.runId)?.terminal).toBeNull();
    failPermissionDelivery = false;
    await expect(
      socket.pushEvents({
        events: [
          {
            kind: "run.completed",
            payload: { stopReason: "end_turn" },
            runId: DRIVER_TEST_IDS.runId,
            sourceEventId: "blocked-by-permission-failure",
          },
        ],
      }),
    ).resolves.toMatchObject({ accepted: [{ type: "run.completed" }] });
    expect(socket.pushedEvents.flatMap(({ events }) => events.map(({ kind }) => kind))).toEqual([
      "permission.requested",
      "permission.requested",
      "permission.resolved",
      "diagnostic.reported",
      "run.completed",
    ]);
  });

  test("waits for an admitted MCP command before publishing the run terminal", async () => {
    const acceptedEntered = Promise.withResolvers<void>();
    const releaseAccepted = Promise.withResolvers<void>();
    const executionEntered = Promise.withResolvers<void>();
    const releaseExecution = Promise.withResolvers<void>();
    const terminalEntered = Promise.withResolvers<void>();
    const commands: RuntimeCommand[] = [
      {
        commandId: "input-with-mcp-barrier",
        input: { text: "finish after MCP" },
        kind: "input.start",
        requestId: "input-with-mcp-barrier-request",
        runId: DRIVER_TEST_IDS.runId,
      },
      {
        argumentsJson: "{}",
        commandId: "mcp-before-terminal-fence",
        kind: "mcp.execute",
        requestId: "mcp-before-terminal-fence-request",
        runId: DRIVER_TEST_IDS.runId,
        serverId: "mcp-linear",
        toolCallId: "tool-before-terminal-fence",
        toolName: "createIssue",
      },
      {
        argumentsJson: "{}",
        commandId: "mcp-after-terminal-fence",
        kind: "mcp.execute",
        requestId: "mcp-after-terminal-fence-request",
        runId: DRIVER_TEST_IDS.runId,
        serverId: "mcp-linear",
        toolCallId: "tool-after-terminal-fence",
        toolName: "updateIssue",
      },
    ];
    const socket = new FakeDriverRuntimeIo(commands);
    const order: string[] = [];
    const pushedEvents = socket.pushEvents.bind(socket);
    socket.pushEvents = async (input) => {
      const result = await pushedEvents(input);
      order.push(...input.events.map((event) => `event:${event.kind}`));
      return result;
    };
    const commandUpdate = socket.commandUpdate.bind(socket);
    socket.commandUpdate = async (update, signal) => {
      await commandUpdate(update, signal);
      order.push(`command:${update.commandId}:${update.status}`);
      if (update.commandId === "mcp-before-terminal-fence" && update.status === "accepted") {
        acceptedEntered.resolve();
        await releaseAccepted.promise;
      }
    };
    const backend = createBackend();
    backend.handleInput = async (_context, _input, runId) => {
      await acceptedEntered.promise;
      terminalEntered.resolve();
      await socket.pushEvents({
        events: [
          {
            kind: "run.completed",
            payload: { status: "completed" },
            runId,
            sourceEventId: `mcp-barrier.completed:${runId}`,
          },
        ],
      });
    };
    const preparedCommands: string[] = [];
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () =>
        socket.updates.some(
          (update) =>
            update.commandId === "input-with-mcp-barrier" && update.status === "completed",
        ),
      mcpPrepare: async (command) => {
        preparedCommands.push(command.commandId);
        return {
          execute: async () => {
            executionEntered.resolve();
            await releaseExecution.promise;
            return {
              outputText: "created",
              requestId: command.requestId,
              serverId: command.serverId,
              toolName: command.toolName,
            };
          },
          async [Symbol.asyncDispose]() {},
        };
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    const run = dispatcher.run(socket, logger);
    await terminalEntered.promise;
    await Bun.sleep(0);
    expect(order).not.toContain("event:run.completed");
    expect(preparedCommands).toEqual([]);

    releaseAccepted.resolve();
    await executionEntered.promise;
    await waitForUpdate(
      socket,
      (update) => update.commandId === "mcp-after-terminal-fence" && update.status === "failed",
    );
    expect(
      socket.updates.some(
        (update) => update.commandId === "mcp-after-terminal-fence" && update.status === "accepted",
      ),
    ).toBe(false);
    expect(preparedCommands).toEqual(["mcp-before-terminal-fence"]);
    expect(order).not.toContain("event:run.completed");

    releaseExecution.resolve();
    await expect(
      settlePromiseWithTimeout(run, {
        label: "same-run MCP terminal barrier",
        timeoutMs: 1_500,
      }),
    ).resolves.toMatchObject({ status: "completed" });

    const mcpCompleted = order.indexOf("command:mcp-before-terminal-fence:completed");
    const runCompleted = order.indexOf("event:run.completed");
    expect(mcpCompleted).toBeGreaterThan(-1);
    expect(runCompleted).toBeGreaterThan(mcpCompleted);
  });

  test("publishes run.failed without self-waiting after an MCP task fails", async () => {
    const executionEntered = Promise.withResolvers<void>();
    const releaseExecution = Promise.withResolvers<void>();
    const terminalEntered = Promise.withResolvers<void>();
    const shutdown = new AbortController();
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-with-failed-mcp",
        input: { text: "fail after MCP" },
        kind: "input.start",
        requestId: "input-with-failed-mcp-request",
        runId: DRIVER_TEST_IDS.runId,
      },
      {
        argumentsJson: "{}",
        commandId: "mcp-terminal-delivery-failure",
        kind: "mcp.execute",
        requestId: "mcp-terminal-delivery-failure-request",
        runId: DRIVER_TEST_IDS.runId,
        serverId: "mcp-linear",
        toolCallId: "tool-terminal-delivery-failure",
        toolName: "createIssue",
      },
    ]);
    const pushEvents = socket.pushEvents.bind(socket);
    socket.pushEvents = async (input) => {
      if (
        input.events.some(
          (event) =>
            event.kind === "tool.call.updated" &&
            event.sourceEventId === "mcp.execute.completed:mcp-terminal-delivery-failure",
        )
      ) {
        throw new Error("MCP terminal event unavailable");
      }
      return pushEvents(input);
    };
    const backend = createBackend();
    backend.handleInput = async (context, _input, runId) => {
      await executionEntered.promise;
      terminalEntered.resolve();
      await context.ports.eventSink.pushEvents({
        events: [
          {
            kind: "run.completed",
            payload: { status: "completed" },
            runId,
            sourceEventId: `failed-mcp.completed:${runId}`,
          },
        ],
      });
    };
    let rememberedFailure: Parameters<FakeDriverRuntimeIo["failRun"]>[0] | null = null;
    let shutdownTask: Promise<void> | null = null;
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => shutdown.signal.aborted,
      mcpPrepare: async (command) => ({
        execute: async () => {
          executionEntered.resolve();
          await releaseExecution.promise;
          return {
            outputText: "created",
            requestId: command.requestId,
            serverId: command.serverId,
            toolName: command.toolName,
          };
        },
        async [Symbol.asyncDispose]() {},
      }),
      rememberRunFailure: (error) => {
        rememberedFailure ??= structuredClone(error);
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
      shutdown: async () => {
        shutdownTask ??= (async () => {
          const error = rememberedFailure ?? {
            code: "driver.mcp_task_failed",
            details: {},
            message: "Driver MCP task failed.",
            retryable: false,
          };
          await socket.pushEvents({
            events: [
              {
                kind: "run.failed",
                payload: { error, recoverable: error.retryable, status: "failed" },
                runId: DRIVER_TEST_IDS.runId,
                sourceEventId: `failed-mcp.failed:${DRIVER_TEST_IDS.runId}`,
              },
            ],
          });
          shutdown.abort(new Error("driver.mcp_task_failed"));
        })();
        await shutdownTask;
      },
      shutdownSignal: shutdown.signal,
    });

    const run = dispatcher.run(socket, logger);
    await terminalEntered.promise;
    releaseExecution.resolve();
    const outcome = await settlePromiseWithTimeout(run, {
      label: "failed MCP run terminal",
      timeoutMs: 1_500,
    });

    expect(outcome.status).toBe("completed");
    expect(
      socket.pushedEvents
        .flatMap(({ events }) => events)
        .filter((event) => event.kind === "run.failed"),
    ).toHaveLength(1);
    expect(
      socket.pushedEvents
        .flatMap(({ events }) => events)
        .some((event) => event.kind === "run.completed"),
    ).toBe(false);
    expect(socket.updates).toContainEqual({
      commandId: "mcp-terminal-delivery-failure",
      status: "accepted",
    });
    expect(
      socket.updates.some(
        (update) =>
          update.commandId === "mcp-terminal-delivery-failure" && update.status !== "accepted",
      ),
    ).toBe(false);
  });

  test.each([
    {
      events: [
        {
          kind: "run.completed",
          payload: { status: "completed" },
          runId: DRIVER_TEST_IDS.runId,
          sourceEventId: "multiple-terminal.completed",
        },
        {
          kind: "run.failed",
          payload: {
            error: { code: "test", details: {}, message: "failed", retryable: false },
            recoverable: false,
            status: "failed",
          },
          runId: DRIVER_TEST_IDS.runId,
          sourceEventId: "multiple-terminal.failed",
        },
      ],
      message: "cannot contain multiple run terminals",
      name: "multiple terminals",
    },
    {
      events: [
        {
          kind: "run.completed",
          payload: { status: "completed" },
          runId: DRIVER_TEST_IDS.runId,
          sourceEventId: "non-final-terminal.completed",
        },
        {
          kind: "diagnostic.reported",
          payload: { message: "must not cross terminal" },
          runId: DRIVER_TEST_IDS.runId,
          sourceEventId: "non-final-terminal.diagnostic",
        },
      ],
      message: "must be the only event",
      name: "an event after the terminal",
    },
  ] as const)("rejects $name before event delivery", async ({ events, message }) => {
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: `input-${events[0].sourceEventId}`,
        input: { text: "validate terminal batch" },
        kind: "input.start",
        requestId: `request-${events[0].sourceEventId}`,
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
    let rejection: unknown;
    const backend = createBackend();
    backend.handleInput = async (_context, _input, runId) => {
      try {
        await socket.pushEvents({ events: structuredClone(events) });
      } catch (error) {
        rejection = error;
      }
      await socket.pushEvents({
        events: [
          {
            kind: "run.completed",
            payload: { status: "completed" },
            runId,
            sourceEventId: `valid-terminal:${runId}`,
          },
        ],
      });
    };
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await dispatcher.run(socket, logger);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain(message);
    expect(socket.pushedEvents).toHaveLength(1);
    expect(socket.pushedEvents[0]?.events[0]?.sourceEventId).toBe(
      `valid-terminal:${DRIVER_TEST_IDS.runId}`,
    );
  });

  test("keeps an ordinary late provider rejection failed after cancellation wins", async () => {
    const inputEntered = Promise.withResolvers<void>();
    const rejectInput = Promise.withResolvers<void>();
    const backend = createBackend();
    backend.handleInput = async () => {
      inputEntered.resolve();
      await rejectInput.promise;
      throw new Error("ordinary late rejection");
    };
    backend.cancelActiveTurn = async () => {
      await inputEntered.promise;
      rejectInput.resolve();
    };
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-late-reject",
        input: { text: "wait" },
        kind: "input.start",
        requestId: "request-late-reject",
        runId: DRIVER_TEST_IDS.runId,
      },
      {
        commandId: "cancel-before-reject",
        kind: "turn.cancel",
        reason: "cancel",
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
    });

    await dispatcher.run(socket, logger);

    expect(socket.updates).toContainEqual(
      expect.objectContaining({ commandId: "input-late-reject", status: "failed" }),
    );
    expect(socket.updates).not.toContainEqual({
      commandId: "input-late-reject",
      status: "cancelled",
    });
    expect(runtimeState.status()).toBe("failed");
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
                runId: DRIVER_TEST_IDS.runId,
                serverId: "mcp-linear",
                toolCallId: "tool-terminal-failure",
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
      backend.handleInput = async (context, _input, runId) => {
        sideEffects += 1;
        await context.ports.eventSink.pushEvents({
          events: [
            {
              kind: "run.completed",
              payload: { status: "completed" },
              runId,
              sourceEventId: `slow-terminal.completed:${runId}`,
            },
          ],
        });
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
              runId: DRIVER_TEST_IDS.runId,
              serverId: "mcp-linear",
              toolCallId: "tool-ack-blocked",
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
      const socket = new FakeDriverRuntimeIo(
        [first, next],
        kind === "mcp" ? DRIVER_TEST_IDS.runId : undefined,
      );
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
      runId: DRIVER_TEST_IDS.runId,
    }));
    commands.push(structuredClone(commands[0]!));
    const socket = new FakeDriverRuntimeIo(commands, DRIVER_TEST_IDS.runId);
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
    });

    await expect(dispatcher.run(socket, logger)).rejects.toThrow("history capacity");

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
