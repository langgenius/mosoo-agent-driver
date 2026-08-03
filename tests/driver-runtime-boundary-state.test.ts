import { describe, expect, test } from "bun:test";

import { DriverRuntimeStateMachine } from "../src/core/driver-runtime-state";
import { createTimingEvent } from "../src/core/driver-runtime-timing";
import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import { parseDriverEventEnvelope } from "../src/protocol/events";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import type { RuntimeCommand } from "../src/runtime-command";
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
    const [envelope] = toDriverEventEnvelopes(driverBootPayload, draft, DRIVER_TEST_IDS.runId);

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
    const [envelope] = toDriverEventEnvelopes(driverBootPayload, draft, DRIVER_TEST_IDS.runId);

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
      toDriverEventEnvelopes(
        driverBootPayload,
        draft as unknown as DriverEventInput,
        DRIVER_TEST_IDS.secondRunId,
      ),
    ).toThrow("Run ID must be a valid ULID.");
  });

  test("driver socket rejects provider turn ids outside an active platform run", () => {
    const draft = {
      kind: "run.started",
      payload: {
        startedAt: new Date(1_000).toISOString(),
      },
      runId: "provider-turn-1",
    } as const;

    expect(() =>
      toDriverEventEnvelopes(driverBootPayload, draft as unknown as DriverEventInput, null),
    ).toThrow("Run ID must be a valid ULID.");
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
    const [event] = toDriverEventEnvelopes(driverBootPayload, draft, DRIVER_TEST_IDS.secondRunId);

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
    const [envelope] = toDriverEventEnvelopes(driverBootPayload, draft, DRIVER_TEST_IDS.runId);

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
    const [first] = toDriverEventEnvelopes(driverBootPayload, draft, DRIVER_TEST_IDS.runId);
    const [second] = toDriverEventEnvelopes(driverBootPayload, draft, DRIVER_TEST_IDS.runId);

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
      (draft) => toDriverEventEnvelopes(driverBootPayload, draft, DRIVER_TEST_IDS.runId)[0],
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

  test("does not replay an MCP effect after terminal receipt delivery is lost", async () => {
    const command: RuntimeCommand = {
      argumentsJson: '{"title":"once"}',
      commandId: "persistent-effect",
      kind: "mcp.execute",
      requestId: "request-persistent-effect",
      serverId: "mcp-linear",
      toolName: "createIssue",
    };
    let providerCalls = 0;
    let effectResult: {
      outputText: string;
      requestId: string;
      serverId: string;
      toolName: string;
    } | null = null;
    const effectPersisted = Promise.withResolvers<void>();

    class LossySocket extends FakeDriverRuntimeIo {
      override async claimExternalToolEffect(): Promise<
        | { attempt: number; effectId: string; idempotencyKey: string; kind: "execute" }
        | { effectId: string; kind: "completed"; result: NonNullable<typeof effectResult> }
      > {
        return effectResult === null
          ? { attempt: 1, effectId: "effect-1", idempotencyKey: "effect-1", kind: "execute" }
          : { effectId: "effect-1", kind: "completed", result: effectResult };
      }

      override async completeExternalToolEffect(input: {
        commandId: string;
        result: NonNullable<typeof effectResult>;
      }): Promise<void> {
        effectResult = input.result;
        effectPersisted.resolve();
      }

      override async commandUpdate(
        input: Parameters<FakeDriverRuntimeIo["commandUpdate"]>[0],
        signal: AbortSignal,
      ): Promise<void> {
        if (input.status === "completed") {
          throw new Error("control connection lost after effect receipt persisted");
        }

        await super.commandUpdate(input, signal);
      }
    }

    const firstSocket = new LossySocket([command]);
    const first = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => firstSocket.isDrained(),
      mcpExecute: async (request) => {
        providerCalls += 1;
        return {
          outputText: "created A-1",
          requestId: request.requestId,
          serverId: request.serverId,
          toolName: request.toolName,
        };
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await first.dispatcher.run(firstSocket, first.logger);
    await effectPersisted.promise;
    await first.logger.destroy();

    const secondSocket = new FakeDriverRuntimeIo([structuredClone(command)]);
    const second = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => secondSocket.isDrained(),
      mcpExecute: async () => {
        providerCalls += 1;
        throw new Error("provider must not run during terminal redelivery");
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    // The default fixture ledger has no cross-process state, so carry the
    // persisted effect receipt through the fresh Dispatcher explicitly.
    secondSocket.claimExternalToolEffect = async () => ({
      effectId: "effect-1",
      kind: "completed" as const,
      result: effectResult!,
    });
    await second.dispatcher.run(secondSocket, second.logger);
    await second.logger.destroy();

    expect(providerCalls).toBe(1);
    expect(secondSocket.updates).toEqual([
      { commandId: command.commandId, status: "accepted" },
      { commandId: command.commandId, result: effectResult, status: "completed" },
    ]);
  });

  test("blocks an unknown MCP effect without another provider call", async () => {
    const command: RuntimeCommand = {
      argumentsJson: '{"title":"do not duplicate"}',
      commandId: "unknown-effect-command",
      kind: "mcp.execute",
      requestId: "unknown-effect-request",
      serverId: "mcp-linear",
      toolName: "createIssue",
    };
    const socket = new FakeDriverRuntimeIo([command]);
    socket.claimExternalToolEffect = async () => ({
      effectId: "01J0000000000000000000000Z",
      kind: "unknown" as const,
    });
    let providerCalls = 0;
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async () => {
        providerCalls += 1;
        throw new Error("provider must not run for an unknown effect");
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await runtime.dispatcher.run(socket, runtime.logger);
    await runtime.logger.destroy();

    expect(providerCalls).toBe(0);
    expect(socket.updates).toMatchObject([
      { commandId: command.commandId, status: "accepted" },
      {
        commandId: command.commandId,
        error: {
          code: "driver.command_failed.mcp.execute",
          message: expect.stringContaining("01J0000000000000000000000Z"),
          retryable: false,
        },
        status: "failed",
      },
    ]);
  });

  test("fences an in-flight MCP effect with a live signal when a turn is cancelled", async () => {
    const mcpCommand: RuntimeCommand = {
      argumentsJson: '{"title":"cancel safely"}',
      commandId: "cancelled-effect-command",
      kind: "mcp.execute",
      requestId: "cancelled-effect-request",
      serverId: "mcp-linear",
      toolName: "createIssue",
    };
    const cancelCommand: RuntimeCommand = {
      commandId: "cancelled-effect-turn",
      kind: "turn.cancel",
      reason: "viewer.cancelled",
    };
    const mcpStarted = Promise.withResolvers<void>();

    class CancellationSocket extends FakeDriverRuntimeIo {
      readonly #nextCommand = Promise.withResolvers<RuntimeCommand>();
      #readFirstCommand = true;
      #drained = false;
      fenceSignalAborted: boolean | null = null;
      fencedCommandId: string | null = null;

      constructor() {
        super([]);
      }

      override isDrained(): boolean {
        return this.#drained;
      }

      override async markExternalToolEffectUnknown(
        input: { commandId: string },
        signal: AbortSignal,
      ): Promise<void> {
        this.fencedCommandId = input.commandId;
        this.fenceSignalAborted = signal.aborted;
      }

      override nextCommand(_signal: AbortSignal): Promise<RuntimeCommand | null> {
        if (this.#readFirstCommand) {
          this.#readFirstCommand = false;
          return Promise.resolve(mcpCommand);
        }

        return this.#nextCommand.promise;
      }

      sendCancellation(): void {
        this.#drained = true;
        this.#nextCommand.resolve(cancelCommand);
      }
    }

    const socket = new CancellationSocket();
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async (_command, signal) => {
        mcpStarted.resolve();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });
    const runTask = runtime.dispatcher.run(socket, runtime.logger);

    await mcpStarted.promise;
    socket.sendCancellation();
    await runTask;
    await runtime.logger.destroy();

    expect(socket.fenceSignalAborted).toBe(false);
    expect(socket.fencedCommandId).toBe(mcpCommand.commandId);
    expect(socket.updates).toMatchObject([
      { commandId: mcpCommand.commandId, status: "accepted" },
      { commandId: cancelCommand.commandId, status: "accepted" },
      { commandId: mcpCommand.commandId, status: "cancelled" },
      { commandId: cancelCommand.commandId, status: "completed" },
    ]);
  });

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
});
