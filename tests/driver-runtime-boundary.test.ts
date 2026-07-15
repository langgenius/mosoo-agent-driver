import { describe, expect, test } from "bun:test";

import { DriverRuntimeStateMachine } from "../src/core/driver-runtime-state";
import { createTimingEvent } from "../src/core/driver-runtime-timing";
import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import { parseDriverEventEnvelope } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import type { RuntimeCommand } from "../src/runtime-command";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";
import {
  FakeDriverRuntimeIo,
  createBackend,
  createDispatcher,
  waitForUpdate,
} from "./driver-runtime-boundary-fixtures";

describe("driver runtime boundary", () => {
  test("rejects an invalid runtime transition", () => {
    const state = new DriverRuntimeStateMachine("created");

    expect(() => state.enter("running")).toThrow("created -> running");
    expect(state.status()).toBe("created");
  });

  test("ignores approval completion from a previous run generation", () => {
    const state = new DriverRuntimeStateMachine("ready");
    state.beginRun(1);
    const staleApproval = state.beginApproval();
    state.endRun(1);
    state.beginRun(2);
    const activeApproval = state.beginApproval();

    state.endApproval(staleApproval);
    expect(state.status()).toBe("needs_approval");

    state.endApproval(activeApproval);
    expect(state.status()).toBe("running");
  });

  test.each([
    [
      "normal",
      ["starting", "ready", "running", "needs_approval", "running", "stopping", "stopped"],
    ],
    ["unused", ["stopping", "stopped"]],
    ["startup failure", ["starting", "failed"]],
    ["turn failure", ["starting", "ready", "running", "failed"]],
  ] as const)("runs the %s lifecycle path", (_name, path) => {
    const state = new DriverRuntimeStateMachine("created");

    for (const status of path) {
      state.enter(status);
    }

    expect(state.status()).toBe(path.at(-1));
  });

  test("runtime timing events carry the completed timestamp", () => {
    const startedAt = new Date(1_000).toISOString();
    const completedAt = new Date(1_050).toISOString();
    const draft = createTimingEvent({
      completedAt,
      path: "warm",
      phases: [],
      runId: DRIVER_TEST_IDS.runId,
      sessionId: DRIVER_TEST_IDS.sessionId,
      stage: "driver_turn",
      startedAt,
      traceId: "trace-1",
    });
    const [envelope] = toDriverEventEnvelopes(
      driverBootPayload,
      draft,
      DRIVER_TEST_IDS.runId,
    );

    expect(envelope).toMatchObject({
      occurredAt: completedAt,
      event: {
        kind: "runtime.timing.recorded",
        occurredAt: completedAt,
        payload: {
          completedAt,
          startedAt,
          totalMs: 50,
        },
      },
    });
  });

  test("driver event envelopes carry offset timestamps as strings", () => {
    const draft = {
      kind: "run.started",
      occurredAt: "2026-07-17T16:00:00.000+08:00",
      payload: { startedAt: "2026-07-17T08:00:00.000Z" },
    } as const;
    const [envelope] = toDriverEventEnvelopes(
      driverBootPayload,
      draft,
      DRIVER_TEST_IDS.runId,
    );

    expect(envelope?.occurredAt).toBe(draft.occurredAt);
    expect(parseDriverEventEnvelope(envelope)).toEqual(envelope);

    for (const occurredAt of [Date.parse(draft.occurredAt), "2026-07-17T16:00:00.000"]) {
      expect(() => parseDriverEventEnvelope({ ...envelope, occurredAt })).toThrow(
        "ISO 8601 string with a timezone offset",
      );
    }
  });

  test("driver socket rejects an explicit invalid run id during an active run", () => {
    const draft = {
      kind: "run.started",
      payload: {
        startedAt: new Date(1_000).toISOString(),
      },
      runId: "sdk-internal-run",
    } as const;
    expect(() =>
      toDriverEventEnvelopes(driverBootPayload, draft, DRIVER_TEST_IDS.secondRunId),
    ).toThrow(
      "Run ID must be a valid ULID.",
    );
  });

  test("driver socket rejects provider turn ids outside an active platform run", () => {
    const draft = {
      kind: "run.started",
      payload: {
        startedAt: new Date(1_000).toISOString(),
      },
      runId: "provider-turn-1",
    } as const;

    expect(() => toDriverEventEnvelopes(driverBootPayload, draft, null)).toThrow(
      "Run ID must be a valid ULID.",
    );
  });

  test("driver socket preserves explicit event run ids outside active turns", () => {
    const draft = {
      kind: "run.started",
      payload: {
        startedAt: new Date(1_000).toISOString(),
      },
      runId: DRIVER_TEST_IDS.thirdRunId,
    } as const;
    const [event] = toDriverEventEnvelopes(driverBootPayload, draft, null);

    expect(event?.event.runId).toBe(DRIVER_TEST_IDS.thirdRunId);
  });

  test("driver socket preserves a valid explicit run id during another active turn", () => {
    const draft = {
      kind: "run.started",
      payload: {
        startedAt: new Date(1_000).toISOString(),
      },
      runId: DRIVER_TEST_IDS.thirdRunId,
    } as const;
    const [event] = toDriverEventEnvelopes(
      driverBootPayload,
      draft,
      DRIVER_TEST_IDS.secondRunId,
    );

    expect(event?.event.runId).toBe(DRIVER_TEST_IDS.thirdRunId);
  });

  test("driver event parsing preserves correlation ids", () => {
    const draft = {
      correlationId: "request-1",
      kind: "run.started",
      payload: {
        startedAt: new Date(1_000).toISOString(),
      },
    } as const;
    const [envelope] = toDriverEventEnvelopes(
      driverBootPayload,
      draft,
      DRIVER_TEST_IDS.runId,
    );

    expect(envelope?.event.correlationId).toBe("request-1");
    expect(parseDriverEventEnvelope(envelope).event.correlationId).toBe("request-1");
  });

  test("driver socket assigns a ULID to each draft occurrence", () => {
    const draft = {
      delivery: "best_effort",
      kind: "message.delta",
      payload: {
        contentDelta: "的",
        messageId: "message-1",
        role: "agent",
      },
    } as const;
    const [first] = toDriverEventEnvelopes(
      driverBootPayload,
      draft,
      DRIVER_TEST_IDS.runId,
    );
    const [second] = toDriverEventEnvelopes(
      driverBootPayload,
      draft,
      DRIVER_TEST_IDS.runId,
    );

    expect(isDriverId(first?.event.sourceEventId)).toBe(true);
    expect(isDriverId(second?.event.sourceEventId)).toBe(true);
    expect(second?.event.sourceEventId).not.toBe(first?.event.sourceEventId);
  });

  test("driver socket assigns unique identities to repeated Unicode stream chunks", () => {
    const chunks = [
      "001|中文长文本校验-Aa0-表格字符|END001\\n",
      "002|中文长文本校验-Aa1-表格字符|END002\\n",
      "的",
      "的",
      "| ✅ 😀 | https://example.test/final |",
    ];
    const drafts = chunks.map((contentDelta) => ({
      delivery: "best_effort" as const,
      kind: "message.delta" as const,
      payload: {
        contentDelta,
        messageId: "message-unicode",
        role: "agent" as const,
      },
    }));
    const envelopes = drafts.map(
      (draft) =>
        toDriverEventEnvelopes(driverBootPayload, draft, DRIVER_TEST_IDS.runId)[0],
    );

    expect(new Set(envelopes.map((event) => event?.event.sourceEventId)).size).toBe(chunks.length);
    expect(envelopes.every((event) => isDriverId(event?.event.sourceEventId))).toBe(true);
    expect(
      envelopes
        .map((event) => {
          const payload = event?.event.payload;
          if (
            typeof payload === "object" &&
            payload !== null &&
            "contentDelta" in payload &&
            typeof payload.contentDelta === "string"
          ) {
            return payload.contentDelta;
          }

          return null;
        })
        .join(""),
    ).toBe(chunks.join(""));
  });

  test("driver socket rejects canonical events instead of trusting foreign identity", () => {
    const [canonical] = toDriverEventEnvelopes(
      driverBootPayload,
      {
        kind: "message.completed",
        payload: { messageId: "message-1", stopReason: "end_turn" },
      },
      DRIVER_TEST_IDS.runId,
    );

    expect(canonical).toBeDefined();
    expect(() => toDriverEventEnvelopes(driverBootPayload, canonical!.event, null)).toThrow(
      "accepts drafts only",
    );
  });

  test("runs input commands through the backend and reports completion to API", async () => {
    const backend = createBackend();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-1",
        input: {
          attachmentIds: ["file-1"],
          text: "hello",
        },
        kind: "input.start",
        requestId: "request-1",
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
    const { commandReads, dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
    });

    await dispatcher.run(socket, logger);
    await waitForUpdate(
      socket,
      (update) => update.commandId === "input-1" && update.status === "completed",
    );
    await logger.destroy();

    expect(runtimeState.status()).toBe("ready");
    expect(commandReads.count).toBe(1);
    expect(socket.updates).toEqual([
      {
        commandId: "input-1",
        status: "accepted",
      },
      {
        commandId: "input-1",
        result: {
          requestId: "request-1",
        },
        status: "completed",
      },
    ]);
  });

  test.each(["input", "mcp"] as const)(
    "acknowledges an active %s replay without repeating its side effect",
    async (kind) => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const backend = createBackend();
      let calls = 0;
      backend.handleInput = async () => {
        calls += 1;
        started.resolve();
        await release.promise;
      };
      const command: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "active-replay",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "request-replay",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              argumentsJson: '{"issue":"A-1"}',
              commandId: "active-replay",
              kind: "mcp.execute",
              requestId: "request-replay",
              serverId: "mcp-linear",
              toolName: "createIssue",
            };
      const socket = new FakeDriverRuntimeIo([command, structuredClone(command)]);
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const { dispatcher, logger } = createDispatcher({
        backend,
        isShuttingDown: () =>
          socket.updates.some(
            (update) => update.commandId === command.commandId && update.status === "completed",
          ),
        mcpExecute: async (request) => {
          calls += 1;
          started.resolve();
          await release.promise;
          return {
            outputText: `ran ${request.toolName}`,
            requestId: request.requestId,
            serverId: request.serverId,
            toolName: request.toolName,
          };
        },
        runtimeState,
      });
      const runTask = dispatcher.run(socket, logger);

      await started.promise;
      await waitForUpdate(
        socket,
        () =>
          socket.updates.filter(
            (update) => update.commandId === command.commandId && update.status === "accepted",
          ).length === 2,
      );
      expect(calls).toBe(1);
      release.resolve();
      await waitForUpdate(
        socket,
        (update) => update.commandId === command.commandId && update.status === "completed",
      );
      await runTask;
      await logger.destroy();

      expect(calls).toBe(1);
      expect(socket.updates.filter((update) => update.status === "accepted")).toHaveLength(2);
      expect(socket.updates.filter((update) => update.status === "completed")).toHaveLength(1);
    },
  );

  test.each([
    [
      "changed content",
      { commandId: "reused-command", kind: "turn.cancel", reason: "second reason" },
    ],
    [
      "changed kind",
      {
        commandId: "reused-command",
        decision: "reject_once",
        kind: "permission.resolve",
        requestId: "permission-1",
      },
    ],
  ] satisfies readonly (readonly [string, RuntimeCommand])[])(
    "rejects a completed command ID replay with %s",
    async (_case, replay) => {
      const backend = createBackend();
      const socket = new FakeDriverRuntimeIo([
        { commandId: "reused-command", kind: "turn.cancel", reason: "first reason" },
        replay,
      ]);
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const { dispatcher, logger } = createDispatcher({ backend, runtimeState });

      await expect(dispatcher.run(socket, logger)).rejects.toThrow(
        "replayed with changed identity or content",
      );
      await logger.destroy();

      expect(backend.cancelledReasons).toEqual(["first reason"]);
      expect(socket.updates).toEqual([
        { commandId: "reused-command", status: "accepted" },
        { commandId: "reused-command", status: "completed" },
      ]);
      expect(socket.failedRuns).toMatchObject([
        {
          code: "driver.command_loop_failed",
        },
      ]);
    },
  );

  test("lets a queued input wait for the previous turn command to settle", async () => {
    const firstInputStarted = Promise.withResolvers<void>();
    const firstInputCanFinish = Promise.withResolvers<void>();
    const backend = createBackend();
    let handledInputCount = 0;
    backend.handleInput = async (context) => {
      handledInputCount += 1;
      backend.handledInputs.push(context.payload.execution.session);

      if (handledInputCount === 1) {
        firstInputStarted.resolve();
        await firstInputCanFinish.promise;
      }
    };
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "input-1",
        input: {
          text: "first",
        },
        kind: "input.start",
        requestId: "request-1",
        runId: DRIVER_TEST_IDS.runId,
      },
      {
        commandId: "input-2",
        input: {
          text: "second",
        },
        kind: "input.start",
        requestId: "request-2",
        runId: DRIVER_TEST_IDS.secondRunId,
      },
    ]);
    const { commandReads, dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      runtimeState,
    });
    const runTask = dispatcher.run(socket, logger);

    await firstInputStarted.promise;
    await waitForUpdate(
      socket,
      (update) => update.commandId === "input-1" && update.status === "accepted",
    );
    firstInputCanFinish.resolve();
    await runTask;
    await logger.destroy();

    expect(handledInputCount).toBe(2);
    expect(runtimeState.status()).toBe("ready");
    expect(commandReads.count).toBe(2);
    expect(socket.failedRuns).toEqual([]);
    expect(socket.updates).toEqual(
      expect.arrayContaining([
        {
          commandId: "input-1",
          status: "accepted",
        },
        {
          commandId: "input-2",
          status: "accepted",
        },
        {
          commandId: "input-1",
          result: {
            requestId: "request-1",
          },
          status: "completed",
        },
        {
          commandId: "input-2",
          result: {
            requestId: "request-2",
          },
          status: "completed",
        },
      ]),
    );
    expect(
      socket.updates.findIndex(
        (update) => update.commandId === "input-1" && update.status === "completed",
      ),
    ).toBeLessThan(
      socket.updates.findIndex(
        (update) => update.commandId === "input-2" && update.status === "completed",
      ),
    );
  });

  test("external shutdown cancels local input and command polling immediately", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const backend = createBackend();
    backend.handleInput = async () => {
      entered.resolve();
      await release.promise;
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
    await logger.destroy();

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
          : [{ commandId: "accepted-never-settles", kind: "turn.cancel" }],
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
      await logger.destroy();

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
      const socket = new FakeDriverRuntimeIo([
        {
          commandId: "accepted-timeout",
          kind: "turn.cancel",
          reason: "must not run",
        },
      ]);
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
      expect(backend.cancelledReasons).toEqual([]);
      expect(runtimeState.status()).toBe("failed");
      expect(socket.failedRuns).toHaveLength(1);
      expect(shutdownCalls).toEqual(["driver.command_loop_failed"]);

      if (lateOutcome === "resolve") {
        late.resolve();
      } else {
        late.reject(new Error("late accepted ACK failure"));
      }
      await Bun.sleep(0);
      await logger.destroy();
    },
  );

  test("keeps MCP commands explicit at the API boundary", async () => {
    const backend = createBackend();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        argumentsJson: '{"issue":"A-1"}',
        commandId: "mcp-1",
        kind: "mcp.execute",
        requestId: "mcp-request-1",
        serverId: "mcp-linear",
        toolName: "createIssue",
      },
    ]);
    const { commandReads, dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () =>
        socket.updates.some(
          (update) => update.commandId === "mcp-1" && update.status === "completed",
        ),
      runtimeState,
    });

    await dispatcher.run(socket, logger);
    await logger.destroy();

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
  });

  test("reports remote MCP execute failures as diagnostics", async () => {
    const backend = createBackend();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        argumentsJson: '{"issue":"A-1"}',
        commandId: "mcp-1",
        kind: "mcp.execute",
        requestId: "mcp-request-1",
        serverId: "mcp-linear",
        toolName: "createIssue",
      },
    ]);
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
    await logger.destroy();

    expect(socket.updates).toMatchObject([
      {
        commandId: "mcp-1",
        status: "accepted",
      },
      {
        commandId: "mcp-1",
        error: {
          code: "driver.command_failed.mcp.execute",
          message: "MCP upstream failed",
        },
        status: "failed",
      },
    ]);
    expect(socket.pushedEvents).toMatchObject([
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
              message: "MCP upstream failed",
              severity: "error",
              source: "core",
            },
          },
        ],
      },
    ]);
  });

  test("lets session stop preempt a stuck MCP command", async () => {
    const backend = createBackend();
    const aborted = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const socket = new FakeDriverRuntimeIo([
      {
        argumentsJson: "{}",
        commandId: "mcp-stuck",
        kind: "mcp.execute",
        requestId: "mcp-request-stuck",
        serverId: "mcp-linear",
        toolName: "waitForever",
      },
      {
        commandId: "stop-1",
        kind: "session.stop",
        reason: "test.stop",
      },
    ]);
    const { dispatcher, logger, shutdownCalls } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async (_command, signal) => {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            async () => {
              aborted.resolve();
              await releaseCleanup.promise;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      runtimeState,
    });

    const run = dispatcher.run(socket, logger);
    await aborted.promise;
    expect(await Promise.race([run.then(() => true), Bun.sleep(10).then(() => false)])).toBe(false);
    releaseCleanup.resolve();

    await run;
    await waitForUpdate(
      socket,
      (update) => update.commandId === "mcp-stuck" && update.status === "cancelled",
    );
    await logger.destroy();

    expect(runtimeState.status()).toBe("stopped");
    expect(shutdownCalls).toEqual(["test.stop"]);
    expect(socket.updates).toEqual(
      expect.arrayContaining([
        { commandId: "mcp-stuck", status: "accepted" },
        { commandId: "mcp-stuck", status: "cancelled" },
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
    const socket = new FakeDriverRuntimeIo([
      {
        commandId: "cancel-during-shutdown",
        kind: "turn.cancel",
        reason: "test.cancel",
      },
    ]);
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
    await logger.destroy();
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
        serverId: "mcp-linear",
        toolName: "waitForever",
      })),
      {
        commandId: "stop-after-mcp-limit",
        kind: "session.stop",
        reason: "test.stop",
      },
    ];
    const socket = new FakeDriverRuntimeIo(commands);
    let executeCalls = 0;
    const { dispatcher, logger } = createDispatcher({
      backend,
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async (_command, signal) => {
        executeCalls += 1;
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      runtimeState,
    });

    await dispatcher.run(socket, logger);
    await waitForUpdate(
      socket,
      (update) => update.commandId === "mcp-32" && update.status === "failed",
    );
    await logger.destroy();

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
    await logger.destroy();

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

  test.each(["input", "mcp"] as const)(
    "serializes a replayed %s acceptance before its terminal update",
    async (kind) => {
      const backend = createBackend();
      const releaseEffect = Promise.withResolvers<void>();
      const secondAccepted = Promise.withResolvers<void>();
      const releaseAccepted = Promise.withResolvers<void>();
      let sideEffects = 0;
      let terminalStarted = false;
      backend.handleInput = async () => {
        sideEffects += 1;
        await releaseEffect.promise;
      };
      const command: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "serialized-input-replay",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "serialized-request",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              argumentsJson: "{}",
              commandId: "serialized-mcp-replay",
              kind: "mcp.execute",
              requestId: "serialized-request",
              serverId: "mcp-linear",
              toolName: "createIssue",
            };
      const socket = new FakeDriverRuntimeIo([command, structuredClone(command)]);
      const recordUpdate = socket.commandUpdate.bind(socket);
      let accepted = 0;
      socket.commandUpdate = async (update, signal) => {
        if (update.status === "accepted") {
          accepted += 1;
          if (accepted === 2) {
            secondAccepted.resolve();
            await releaseAccepted.promise;
          }
        } else {
          terminalStarted = true;
        }
        await recordUpdate(update, signal);
      };
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const { dispatcher, logger } = createDispatcher({
        backend,
        isShuttingDown: () =>
          socket.updates.some(
            (update) => update.commandId === command.commandId && update.status === "completed",
          ),
        mcpExecute: async (mcpCommand) => {
          sideEffects += 1;
          await releaseEffect.promise;
          return {
            outputText: "done",
            requestId: mcpCommand.requestId,
            serverId: mcpCommand.serverId,
            toolName: mcpCommand.toolName,
          };
        },
        runtimeState,
      });
      const run = dispatcher.run(socket, logger);

      await secondAccepted.promise;
      releaseEffect.resolve();
      await Bun.sleep(10);
      expect(terminalStarted).toBe(false);
      releaseAccepted.resolve();
      await run;
      await logger.destroy();

      expect(sideEffects).toBe(1);
      expect(socket.updates.map((update) => update.status)).toEqual([
        "accepted",
        "accepted",
        "completed",
      ]);
    },
  );

  test.each(["input", "mcp"] as const)(
    "joins an in-flight %s terminal delivery before idempotently replaying it",
    async (kind) => {
      const backend = createBackend();
      let sideEffects = 0;
      backend.handleInput = async () => {
        sideEffects += 1;
      };
      const command: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "joined-input-replay",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "joined-request",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              argumentsJson: "{}",
              commandId: "joined-mcp-replay",
              kind: "mcp.execute",
              requestId: "joined-request",
              serverId: "mcp-linear",
              toolName: "createIssue",
            };
      const socket = new FakeDriverRuntimeIo([command, structuredClone(command)]);
      const terminalEntered = Promise.withResolvers<void>();
      const releaseTerminal = Promise.withResolvers<void>();
      const nextCommand = socket.nextCommand.bind(socket);
      let reads = 0;
      socket.nextCommand = async (signal) => {
        reads += 1;
        if (reads === 2) {
          await terminalEntered.promise;
        }
        return nextCommand(signal);
      };
      const recordUpdate = socket.commandUpdate.bind(socket);
      let terminalAttempts = 0;
      socket.commandUpdate = async (update, signal) => {
        if (update.status !== "accepted") {
          terminalAttempts += 1;
          if (terminalAttempts === 1) {
            terminalEntered.resolve();
            await releaseTerminal.promise;
          }
        }
        await recordUpdate(update, signal);
      };
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const { commandReads, dispatcher, logger } = createDispatcher({
        backend,
        isShuttingDown: () =>
          socket.updates.filter(
            (update) => update.commandId === command.commandId && update.status === "completed",
          ).length === 2,
        mcpExecute: async (mcpCommand) => {
          sideEffects += 1;
          return {
            outputText: "done",
            requestId: mcpCommand.requestId,
            serverId: mcpCommand.serverId,
            toolName: mcpCommand.toolName,
          };
        },
        runtimeState,
      });
      const run = dispatcher.run(socket, logger);

      await terminalEntered.promise;
      while (commandReads.count < 2) {
        await Bun.sleep(0);
      }
      await Bun.sleep(0);
      expect(terminalAttempts).toBe(1);
      expect(socket.updates.filter((update) => update.status === "accepted")).toHaveLength(1);
      releaseTerminal.resolve();
      await run;
      await logger.destroy();

      expect(sideEffects).toBe(1);
      expect(terminalAttempts).toBe(2);
      expect(socket.updates.map((update) => update.status)).toEqual([
        "accepted",
        "completed",
        "completed",
      ]);
    },
  );

  test.each(["input", "mcp"] as const)(
    "shares a failing in-flight %s terminal delivery with its replay",
    async (kind) => {
      const backend = createBackend();
      let sideEffects = 0;
      backend.handleInput = async () => {
        sideEffects += 1;
      };
      const command: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "failed-joined-input-replay",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "failed-joined-request",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              argumentsJson: "{}",
              commandId: "failed-joined-mcp-replay",
              kind: "mcp.execute",
              requestId: "failed-joined-request",
              serverId: "mcp-linear",
              toolName: "createIssue",
            };
      const socket = new FakeDriverRuntimeIo([command, structuredClone(command)]);
      const terminalEntered = Promise.withResolvers<void>();
      const releaseTerminal = Promise.withResolvers<void>();
      const nextCommand = socket.nextCommand.bind(socket);
      let reads = 0;
      socket.nextCommand = async (signal) => {
        reads += 1;
        if (reads === 2) {
          await terminalEntered.promise;
        }
        return nextCommand(signal);
      };
      const recordUpdate = socket.commandUpdate.bind(socket);
      let released = false;
      let terminalAttempts = 0;
      socket.commandUpdate = async (update, signal) => {
        if (update.status === "accepted") {
          await recordUpdate(update, signal);
          return;
        }

        terminalAttempts += 1;
        if (terminalAttempts === 1) {
          terminalEntered.resolve();
          await releaseTerminal.promise;
        } else if (!released) {
          await recordUpdate(update, signal);
          return;
        }

        throw new Error("terminal transport unavailable");
      };
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const { commandReads, dispatcher, logger } = createDispatcher({
        backend,
        isShuttingDown: () =>
          socket.updates.some(
            (update) => update.commandId === command.commandId && update.status === "completed",
          ),
        mcpExecute: async (mcpCommand) => {
          sideEffects += 1;
          return {
            outputText: "done",
            requestId: mcpCommand.requestId,
            serverId: mcpCommand.serverId,
            toolName: mcpCommand.toolName,
          };
        },
        runtimeState,
      });
      const run = dispatcher.run(socket, logger);

      await terminalEntered.promise;
      while (commandReads.count < 2) {
        await Bun.sleep(0);
      }
      await Bun.sleep(0);
      const attemptsBeforeRelease = terminalAttempts;
      released = true;
      releaseTerminal.resolve();
      const outcome = await settlePromiseWithTimeout(run, {
        label: `${kind} shared terminal failure`,
        timeoutMs: 1_500,
      });
      await logger.destroy();

      expect(attemptsBeforeRelease).toBe(1);
      expect(outcome).toMatchObject({
        error: { message: expect.stringContaining("terminal status could not be delivered") },
        status: "failed",
      });
      expect(sideEffects).toBe(1);
      expect(terminalAttempts).toBe(3);
      expect(socket.updates.map((update) => update.status)).toEqual(["accepted"]);
      expect(runtimeState.status()).toBe("failed");
    },
  );

  test.each(["completed", "failed"] as const)(
    "isolates a cached %s update from synchronous and awaited sink mutation",
    async (terminalStatus) => {
      const backend = createBackend();
      const command: RuntimeCommand = {
        argumentsJson: "{}",
        commandId: `sink-mutation-${terminalStatus}`,
        kind: "mcp.execute",
        requestId: "sink-mutation-request",
        serverId: "mcp-linear",
        toolName: "createIssue",
      };
      const socket = new FakeDriverRuntimeIo([command, structuredClone(command)]);
      const terminalEntered = Promise.withResolvers<void>();
      const releaseTerminal = Promise.withResolvers<void>();
      const nextCommand = socket.nextCommand.bind(socket);
      let reads = 0;
      socket.nextCommand = async (signal) => {
        reads += 1;
        if (reads === 2) {
          await terminalEntered.promise;
        }
        return nextCommand(signal);
      };
      const recordUpdate = socket.commandUpdate.bind(socket);
      const terminalSnapshots: Parameters<typeof recordUpdate>[0][] = [];
      let deliveredTerminals = 0;
      socket.commandUpdate = async (update, signal) => {
        if (update.status === "accepted") {
          await recordUpdate(update, signal);
          return;
        }

        terminalSnapshots.push(structuredClone(update));
        if (terminalSnapshots.length === 1) {
          if (update.result !== undefined && update.result !== null) {
            Reflect.set(update.result, "outputText", "mutated synchronously");
          }
          if (update.error !== undefined) {
            Reflect.set(update.error, "message", "mutated synchronously");
          }
          terminalEntered.resolve();
          await releaseTerminal.promise;

          const debug =
            update.result === undefined || update.result === null
              ? undefined
              : (Reflect.get(update.result, "debug") as { nested?: string } | undefined);
          if (debug !== undefined) {
            debug.nested = "mutated after await";
          }
          if (update.error !== undefined) {
            Reflect.set(update.error.details, "commandId", "mutated after await");
          }
        }

        await recordUpdate(update, signal);
        deliveredTerminals += 1;
      };
      let executeCalls = 0;
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const { dispatcher, logger } = createDispatcher({
        backend,
        isShuttingDown: () => deliveredTerminals === 2,
        mcpExecute: async (mcpCommand) => {
          executeCalls += 1;
          if (terminalStatus === "failed") {
            throw new Error("MCP failed");
          }

          const result = {
            debug: { nested: "original" },
            outputText: "original",
            requestId: mcpCommand.requestId,
            serverId: mcpCommand.serverId,
            toolName: mcpCommand.toolName,
          };
          return result;
        },
        runtimeState,
      });
      const run = dispatcher.run(socket, logger);

      await terminalEntered.promise;
      releaseTerminal.resolve();
      await run;
      await logger.destroy();

      expect(executeCalls).toBe(1);
      expect(terminalSnapshots).toHaveLength(2);
      expect(terminalSnapshots[1]).toEqual(terminalSnapshots[0]);
      expect(terminalSnapshots[1]?.status).toBe(terminalStatus);
    },
  );

  test.each(["input", "mcp"] as const)(
    "keeps retrying a cached %s terminal update without repeating its side effect",
    async (kind) => {
      const backend = createBackend();
      let sideEffects = 0;
      backend.handleInput = async () => {
        sideEffects += 1;
      };
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const command: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "input-report-failure",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "request-report-failure",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              argumentsJson: "{}",
              commandId: "mcp-report-failure",
              kind: "mcp.execute",
              requestId: "request-report-failure",
              serverId: "mcp-linear",
              toolName: "createIssue",
            };
      const socket = new FakeDriverRuntimeIo([
        command,
      ]);
      const recordUpdate = socket.commandUpdate.bind(socket);
      const terminalAttempts: string[] = [];
      socket.commandUpdate = async (update) => {
        if (update.status !== "accepted") {
          terminalAttempts.push(update.status);

          if (terminalAttempts.length <= 2) {
            throw new Error("control socket unavailable");
          }
        }

        await recordUpdate(update);
      };
      const { dispatcher, logger, shutdownCalls } = createDispatcher({
        backend,
        isShuttingDown: () =>
          socket.updates.some(
            (update) => update.commandId === command.commandId && update.status === "completed",
          ),
        mcpExecute: async (mcpCommand) => {
          sideEffects += 1;
          return {
            outputText: `ran ${mcpCommand.toolName}`,
            requestId: mcpCommand.requestId,
            serverId: mcpCommand.serverId,
            toolName: mcpCommand.toolName,
          };
        },
        runtimeState,
      });

      await dispatcher.run(socket, logger);
      await logger.destroy();

      expect(sideEffects).toBe(1);
      expect(terminalAttempts).toEqual(["completed", "completed", "completed"]);
      expect(socket.updates.map((update) => update.status)).toEqual(["accepted", "completed"]);
      expect(shutdownCalls).toEqual([]);
    },
  );

  test("delivers a session.stop terminal update before the command loop returns", async () => {
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
    });

    await dispatcher.run(socket, logger);
    await logger.destroy();

    expect(terminalAttempts).toBe(3);
    expect(shutdownCalls).toEqual(["test.stop"]);
    expect(socket.updates.at(-1)).toEqual({
      commandId: "stop-report-retry",
      status: "completed",
    });
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

    expect(terminalAttempts).toBe(3);
    expect(socket.completedRunReasons).toHaveLength(1);
    expect(socket.failedRuns).toEqual([]);
    expect(runtimeState.status()).toBe("failed");
  });

  test.each(["input", "mcp"] as const)(
    "aborts a hung %s terminal attempt before retrying and settling later work",
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
      const ackEntered = Promise.withResolvers<void>();
      let firstSignal: AbortSignal | undefined;
      let terminalAttempts = 0;
      socket.commandUpdate = async (update, signal) => {
        if (update.commandId === first.commandId && update.status !== "accepted") {
          terminalAttempts += 1;
        }
        if (update.commandId === first.commandId && terminalAttempts === 1) {
          firstSignal = signal;
          ackEntered.resolve();
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
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
                (update) =>
                  update.commandId === next.commandId && update.status === "completed",
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

      await ackEntered.promise;
      const outcome = await settlePromiseWithTimeout(run, {
        label: `${kind} terminal acknowledgement retry`,
        timeoutMs: 1_500,
      });
      await logger.destroy();

      expect(outcome.status).toBe("completed");
      expect(firstSignal?.aborted).toBe(true);
      expect(terminalAttempts).toBe(2);
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
