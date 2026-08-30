import { describe, expect, test } from "bun:test";

import { ACTIVE_TURN_CANCEL_GRACE_MS } from "../src/core/driver-command-dispatcher";
import { DRIVER_EVENT_DELIVERY_TIMEOUT_MS } from "../src/core/driver-runtime-io";
import { DriverRuntimeStateMachine } from "../src/core/driver-runtime-state";
import type { McpExternalToolExecutionResult, RuntimeCommand } from "../src/runtime-command";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import {
  FakeDriverRuntimeIo,
  createBackend,
  createDispatcher,
  settleBackendInput,
  waitForUpdate,
} from "./driver-runtime-boundary-fixtures";

describe("driver runtime boundary", () => {
  test("allows cancellation cleanup to consume the public event delivery deadline", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-with-lossless-terminal",
        input: { text: "wait" },
        kind: "input.start",
        requestId: "request-with-lossless-terminal",
        runId: DRIVER_TEST_IDS.runId,
      },
      {
        commandId: "cancel-with-lossless-terminal",
        kind: "turn.cancel",
        reason: "test.cancel",
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
    const nativeSetTimeout = globalThis.setTimeout;
    const delay = (milliseconds: number) =>
      new Promise<void>((resolve) => nativeSetTimeout(resolve, milliseconds));
    const recordEvents = socket.pushEvents.bind(socket);
    socket.pushEvents = async (input) => {
      await delay(90);
      return recordEvents(input);
    };
    backend.handleInput = async (context, _input, runId, signal) => {
      inputEntered.resolve();
      await new Promise<void>((resolve) => {
        signal!.addEventListener("abort", () => nativeSetTimeout(resolve, 30), { once: true });
      });
      await settleBackendInput(context, runId, signal);
    };
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () =>
        socket.updates.some(
          (update) =>
            update.commandId === "cancel-with-lossless-terminal" && update.status === "completed",
        ),
      runtimeState,
    });
    const acceleratedSetTimeout = (
      callback: (...args: unknown[]) => void,
      timeout?: number,
      ...arguments_: unknown[]
    ) =>
      nativeSetTimeout(
        callback,
        timeout === 5_000
          ? 20
          : timeout === DRIVER_EVENT_DELIVERY_TIMEOUT_MS
            ? 100
            : timeout === ACTIVE_TURN_CANCEL_GRACE_MS + DRIVER_EVENT_DELIVERY_TIMEOUT_MS
              ? 200
              : timeout,
        ...arguments_,
      );
    globalThis.setTimeout = acceleratedSetTimeout as typeof setTimeout;

    try {
      const run = dispatcher.run(socket, logger);
      await inputEntered.promise;
      await expect(run).resolves.toBeUndefined();
      expect(runtimeState.status()).toBe("ready");
      expect(socket.failedRuns).toEqual([]);
      expect(socket.pushedEvents).toMatchObject([{ events: [{ kind: "run.cancelled" }] }]);
      expect(socket.updates).toContainEqual({
        commandId: "cancel-with-lossless-terminal",
        status: "completed",
      });
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("external shutdown cancels local input and command polling immediately", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const backend = createBackend();
    backend.handleInput = async (context, _input, runId, signal) => {
      entered.resolve();
      await release.promise;
      await settleBackendInput(context, runId, signal);
    };
    const shutdown = new AbortController();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-external-shutdown",
        input: { text: "hello" },
        kind: "input.start",
        requestId: "request-external-shutdown",
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
    const { dispatcher, logger } = createDispatcher({
      backend,
      runtimeState,
      shutdownSignal: shutdown.signal,
    });
    const run = dispatcher.run(socket, logger);

    await entered.promise;
    shutdown.abort(new Error("external shutdown"));
    release.resolve();

    const outcome = await settlePromiseWithTimeout(run, {
      label: "externally stopped command loop",
      timeoutMs: 100,
    });

    expect(outcome.status).toBe("completed");
    expect(socket.updates).toContainEqual({
      commandId: "input-external-shutdown",
      status: "cancelled",
    });
    expect(socket.updates).not.toContainEqual({
      commandId: "input-external-shutdown",
      result: { requestId: "request-external-shutdown" },
      status: "completed",
    });
  });

  test.each([
    ["poll", "resolve"],
    ["poll", "reject"],
    ["accepted ACK", "resolve"],
    ["accepted ACK", "reject"],
  ] as const)(
    "external shutdown bounds a non-compliant %s and absorbs its late %s",
    async (boundary, late) => {
      const backend = createBackend();
      const shutdown = new AbortController();
      const entered = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<void>();
      const runtimeState = new DriverRuntimeStateMachine("ready");
      let boundarySignal: AbortSignal | undefined;
      const socket = new FakeDriverRuntimeIo(
        boundary === "poll"
          ? []
          : [
              {
                commandId: "accepted-never-settles",
                kind: "turn.cancel",
                runId: DRIVER_TEST_IDS.runId,
              },
            ],
        boundary === "poll" ? undefined : DRIVER_TEST_IDS.runId,
      );
      if (boundary === "poll") {
        socket.nextCommand = async (signal) => {
          boundarySignal = signal;
          entered.resolve();
          await pending.promise;
          return null;
        };
      } else {
        socket.commandUpdate = async (_update, signal) => {
          boundarySignal = signal;
          entered.resolve();
          await pending.promise;
        };
      }
      const { dispatcher, logger } = createDispatcher({
        backend,
        runtimeState,
        shutdownSignal: shutdown.signal,
      });
      const run = dispatcher.run(socket, logger);

      await entered.promise;
      shutdown.abort(new Error("external shutdown"));
      const outcome = await settlePromiseWithTimeout(run, {
        label: `non-compliant ${boundary} shutdown`,
        timeoutMs: 100,
      });
      expect(outcome.status).toBe("completed");
      expect(boundarySignal?.aborted).toBe(true);
      expect(boundarySignal?.reason).toMatchObject({ message: "external shutdown" });

      if (late === "resolve") {
        pending.resolve();
      } else {
        pending.reject(new Error("late transport failure"));
      }
      await Bun.sleep(0);

      expect(socket.failedRuns).toEqual([]);
    },
  );

  test.each(["resolve", "reject"] as const)(
    "fails within the accepted ACK deadline and absorbs a late %s",
    async (lateOutcome) => {
      const backend = createBackend();
      const entered = Promise.withResolvers<void>();
      const late = Promise.withResolvers<void>();
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const socket = new FakeDriverRuntimeIo(
        [
          {
            commandId: "accepted-timeout",
            kind: "turn.cancel",
            reason: "must not run",
            runId: DRIVER_TEST_IDS.runId,
          },
        ],
        DRIVER_TEST_IDS.runId,
      );
      let acceptedSignal: AbortSignal | undefined;
      socket.commandUpdate = async (update, signal) => {
        if (update.status === "accepted") {
          acceptedSignal = signal;
          entered.resolve();
          await late.promise;
        }
      };
      const { dispatcher, logger, shutdownCalls } = createDispatcher({
        backend,
        runtimeState,
      });
      const run = dispatcher.run(socket, logger);

      await entered.promise;
      const outcome = await settlePromiseWithTimeout(run, {
        label: "accepted ACK fail-stop",
        timeoutMs: 1_500,
      });

      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") {
        throw new Error(`Expected accepted ACK failure, received ${outcome.status}.`);
      }
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toContain("accepted status delivery timed out");
      expect(acceptedSignal?.aborted).toBe(true);
      expect(acceptedSignal?.reason).toMatchObject({
        message: expect.stringContaining("accepted status delivery timed out"),
      });
      expect(backend.cancelledReasons).toEqual(["must not run"]);
      expect(runtimeState.status()).toBe("failed");
      expect(socket.failedRuns).toHaveLength(1);
      expect(shutdownCalls).toEqual(["driver.command_loop_failed"]);

      if (lateOutcome === "resolve") {
        late.resolve();
      } else {
        late.reject(new Error("late accepted ACK failure"));
      }
      await Bun.sleep(0);
    },
  );

  test("keeps MCP commands explicit at the API boundary", async () => {
    const backend = createBackend();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo(
      [
        {
          argumentsJson: '{"issue":"A-1"}',
          commandId: "mcp-1",
          kind: "mcp.execute",
          requestId: "mcp-request-1",
          runId: DRIVER_TEST_IDS.runId,
          serverId: "mcp-linear",
          toolCallId: "tool-mcp-1",
          toolName: "createIssue",
        },
      ],
      DRIVER_TEST_IDS.runId,
    );
    const { commandReads, dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () =>
        socket.updates.some(
          (update) => update.commandId === "mcp-1" && update.status === "completed",
        ),
      runtimeState,
    });

    await dispatcher.run(socket, logger);

    expect(runtimeState.status()).toBe("ready");
    expect(commandReads.count).toBeGreaterThanOrEqual(1);
    expect(socket.updates).toEqual([
      {
        commandId: "mcp-1",
        status: "accepted",
      },
      {
        commandId: "mcp-1",
        result: {
          outputText: "ran createIssue",
          requestId: "mcp-request-1",
          serverId: "mcp-linear",
          toolName: "createIssue",
        },
        status: "completed",
      },
    ]);
    expect(socket.pushedEvents).toMatchObject([
      {
        events: [
          {
            kind: "tool.call.updated",
            payload: {
              rawInput: '{"issue":"A-1"}',
              status: "running",
              title: "createIssue",
              toolCallId: "tool-mcp-1",
            },
          },
        ],
      },
      {
        events: [
          {
            kind: "tool.call.updated",
            payload: {
              rawOutput: "ran createIssue",
              status: "completed",
              toolCallId: "tool-mcp-1",
            },
          },
        ],
      },
    ]);
  });

  test("fences remote MCP execute failures as unknown diagnostics", async () => {
    const backend = createBackend();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo(
      [
        {
          argumentsJson: '{"issue":"A-1"}',
          commandId: "mcp-1",
          kind: "mcp.execute",
          requestId: "mcp-request-1",
          runId: DRIVER_TEST_IDS.runId,
          serverId: "mcp-linear",
          toolCallId: "tool-mcp-1",
          toolName: "createIssue",
        },
      ],
      DRIVER_TEST_IDS.runId,
    );
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () =>
        socket.updates.some((update) => update.commandId === "mcp-1" && update.status === "failed"),
      mcpExecute: async () => {
        throw new Error("MCP upstream failed");
      },
      runtimeState,
    });

    await dispatcher.run(socket, logger);

    expect(socket.updates).toMatchObject([
      {
        commandId: "mcp-1",
        status: "accepted",
      },
      {
        commandId: "mcp-1",
        error: {
          code: "driver.external_tool_effect_unknown",
          details: {
            commandId: "mcp-1",
            effectId: "test-effect-mcp-1",
            requestId: "mcp-request-1",
            serverId: "mcp-linear",
            toolName: "createIssue",
          },
          message: expect.stringContaining("unknown outcome"),
          retryable: false,
        },
        status: "failed",
      },
    ]);
    expect(socket.pushedEvents).toMatchObject([
      {
        events: [
          {
            kind: "tool.call.updated",
            payload: {
              status: "running",
              toolCallId: "tool-mcp-1",
            },
          },
        ],
      },
      {
        events: [
          {
            kind: "tool.call.updated",
            payload: {
              rawOutput: expect.stringContaining("unknown outcome"),
              status: "failed",
              toolCallId: "tool-mcp-1",
            },
          },
        ],
      },
      {
        events: [
          {
            kind: "diagnostic.reported",
            payload: {
              code: "driver.mcp_execute_failed",
              details: {
                commandId: "mcp-1",
                requestId: "mcp-request-1",
                serverId: "mcp-linear",
                toolName: "createIssue",
              },
              message: expect.stringContaining("unknown outcome"),
              severity: "error",
              source: "core",
            },
          },
        ],
      },
    ]);
  });

  test("lets session stop preempt polling and join a committed MCP effect", async () => {
    const backend = createBackend();
    const entered = Promise.withResolvers<void>();
    const execution = Promise.withResolvers<McpExternalToolExecutionResult>();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo(
      [
        {
          argumentsJson: "{}",
          commandId: "mcp-stuck",
          kind: "mcp.execute",
          requestId: "mcp-request-stuck",
          runId: DRIVER_TEST_IDS.runId,
          serverId: "mcp-linear",
          toolCallId: "tool-mcp-stuck",
          toolName: "waitForever",
        },
        {
          commandId: "stop-1",
          kind: "session.stop",
          reason: "test.stop",
        },
      ],
      DRIVER_TEST_IDS.runId,
    );
    const { dispatcher, logger, shutdownCalls } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async () => {
        entered.resolve();
        return execution.promise;
      },
      runtimeState,
    });

    const run = dispatcher.run(socket, logger);
    await entered.promise;
    await waitForUpdate(
      socket,
      (update) => update.commandId === "stop-1" && update.status === "accepted",
    );
    expect(await Promise.race([run.then(() => true), Bun.sleep(10).then(() => false)])).toBe(false);
    execution.reject(new Error("provider response lost"));

    await run;
    await waitForUpdate(
      socket,
      (update) => update.commandId === "mcp-stuck" && update.status === "failed",
    );

    expect(runtimeState.status()).toBe("stopped");
    expect(shutdownCalls).toEqual(["test.stop"]);
    expect(socket.updates).toEqual(
      expect.arrayContaining([
        { commandId: "mcp-stuck", status: "accepted" },
        {
          commandId: "mcp-stuck",
          error: {
            code: "driver.external_tool_effect_unknown",
            details: {
              commandId: "mcp-stuck",
              effectId: "test-effect-mcp-stuck",
              requestId: "mcp-request-stuck",
              runId: DRIVER_TEST_IDS.runId,
              serverId: "mcp-linear",
              toolName: "waitForever",
            },
            message: expect.stringContaining("unknown outcome"),
            retryable: false,
          },
          status: "failed",
        },
        { commandId: "stop-1", status: "accepted" },
        { commandId: "stop-1", status: "completed" },
      ]),
    );
  });

  test("does not report a command-loop failure when shutdown aborts an acknowledgement", async () => {
    const backend = createBackend();
    const updateEntered = Promise.withResolvers<void>();
    const updateResult = Promise.withResolvers<void>();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo(
      [
        {
          commandId: "cancel-during-shutdown",
          kind: "turn.cancel",
          reason: "test.cancel",
          runId: DRIVER_TEST_IDS.runId,
        },
      ],
      DRIVER_TEST_IDS.runId,
    );
    socket.commandUpdate = async () => {
      updateEntered.resolve();
      await updateResult.promise;
    };
    let shuttingDown = false;
    const { dispatcher, logger, shutdownCalls } = createDispatcher({
      backend,
      isShuttingDown: () => shuttingDown,
      runtimeState,
    });
    const run = dispatcher.run(socket, logger);

    await updateEntered.promise;
    shuttingDown = true;
    runtimeState.enter("stopping");
    updateResult.reject(new Error("shutdown abort"));

    await expect(run).resolves.toBeUndefined();
    expect(socket.failedRuns).toEqual([]);
    expect(socket.pushedEvents).toEqual([]);
    expect(shutdownCalls).toEqual([]);
  });

  test("bounds concurrent MCP commands and still accepts stop", async () => {
    const backend = createBackend();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const commands: RuntimeCommand[] = [
      ...Array.from({ length: 33 }, (_, index) => ({
        argumentsJson: "{}",
        commandId: `mcp-${index}`,
        kind: "mcp.execute" as const,
        requestId: `mcp-request-${index}`,
        runId: DRIVER_TEST_IDS.runId,
        serverId: "mcp-linear",
        toolCallId: `tool-mcp-${index}`,
        toolName: "waitForever",
      })),
      {
        commandId: "stop-after-mcp-limit",
        kind: "session.stop",
        reason: "test.stop",
      },
    ];
    const socket = new FakeDriverRuntimeIo(commands, DRIVER_TEST_IDS.runId);
    let executeCalls = 0;
    const releaseExecutions = Promise.withResolvers<void>();
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async (command) => {
        executeCalls += 1;
        await releaseExecutions.promise;
        return {
          outputText: "finished after stop",
          requestId: command.requestId,
          serverId: command.serverId,
          toolName: command.toolName,
        };
      },
      runtimeState,
    });

    const run = dispatcher.run(socket, logger);
    await waitForUpdate(
      socket,
      (update) => update.commandId === "stop-after-mcp-limit" && update.status === "accepted",
    );
    releaseExecutions.resolve();
    await run;
    await waitForUpdate(
      socket,
      (update) => update.commandId === "mcp-32" && update.status === "failed",
    );

    expect(executeCalls).toBe(32);
    expect(runtimeState.status()).toBe("stopped");
    expect(socket.updates).toContainEqual({
      commandId: "stop-after-mcp-limit",
      status: "completed",
    });
  });

  test("fails the run and shuts down when the backend rejects a turn", async () => {
    const backend = createBackend();
    backend.failInput = true;
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-1",
        input: {
          text: "hello",
        },
        kind: "input.start",
        requestId: "request-1",
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
    const { dispatcher, logger, shutdownCalls } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
    });

    await dispatcher.run(socket, logger);
    await waitForUpdate(
      socket,
      (update) => update.commandId === "input-1" && update.status === "failed",
    );

    expect(runtimeState.status()).toBe("failed");
    expect(socket.failedRuns).toHaveLength(1);
    expect(socket.failedRuns[0]).toMatchObject({
      details: {
        commandId: "input-1",
        commandKind: "input.start",
      },
      retryable: false,
    });
    expect(socket.pushedEvents).toMatchObject([
      {
        events: [
          {
            kind: "diagnostic.reported",
            payload: {
              code: "driver.command_failed",
              details: {
                commandId: "input-1",
                commandKind: "input.start",
              },
              message: "backend rejected input",
              severity: "error",
              source: "core",
            },
          },
        ],
      },
    ]);
    expect(shutdownCalls).toHaveLength(1);
  });
});
