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

  test("driver socket preserves explicit session scope during an active turn", () => {
    const [event] = toDriverEventEnvelopes(
      driverBootPayload,
      {
        kind: "agent.task.updated",
        payload: { active: false, status: "completed", taskId: "agent-1" },
        runId: null,
      },
      DRIVER_TEST_IDS.secondRunId,
    );

    expect(event?.event.runId).toBeUndefined();
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
      (update) =>
        update.commandId === "input-1" &&
        update.status === "completed" &&
        runtimeState.status() === "ready",
    );

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
      backend.handleInput = async (context, _input, runId) => {
        calls += 1;
        started.resolve();
        await release.promise;
        await context.ports.eventSink.pushEvents({
          events: [
            {
              kind: "run.completed",
              payload: { status: "completed" },
              runId,
              sourceEventId: `active-replay.completed:${runId}`,
            },
          ],
        });
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
              runId: DRIVER_TEST_IDS.runId,
              serverId: "mcp-linear",
              toolCallId: "tool-replay",
              toolName: "createIssue",
            };
      const socket = new FakeDriverRuntimeIo(
        [command, structuredClone(command)],
        kind === "mcp" ? DRIVER_TEST_IDS.runId : undefined,
      );
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

      expect(calls).toBe(1);
      expect(socket.updates.filter((update) => update.status === "accepted")).toHaveLength(2);
      expect(socket.updates.filter((update) => update.status === "completed")).toHaveLength(1);
    },
  );

  test.each([
    [
      "changed content",
      {
        commandId: "reused-command",
        kind: "turn.cancel",
        reason: "second reason",
        runId: DRIVER_TEST_IDS.runId,
      },
    ],
    [
      "changed kind",
      {
        commandId: "reused-command",
        decision: "reject_once",
        kind: "permission.resolve",
        requestId: "permission-1",
        runId: DRIVER_TEST_IDS.runId,
      },
    ],
  ] satisfies readonly (readonly [string, RuntimeCommand])[])(
    "rejects a completed command ID replay with %s",
    async (_case, replay) => {
      const backend = createBackend();
      const socket = new FakeDriverRuntimeIo(
        [
          {
            commandId: "reused-command",
            kind: "turn.cancel",
            reason: "first reason",
            runId: DRIVER_TEST_IDS.runId,
          },
          replay,
        ],
        DRIVER_TEST_IDS.runId,
      );
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const { dispatcher, logger } = createDispatcher({ backend, runtimeState });

      await expect(dispatcher.run(socket, logger)).rejects.toThrow(
        "replayed with changed identity or content",
      );

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
    backend.handleInput = async (context, _input, runId) => {
      handledInputCount += 1;
      backend.handledInputs.push(context.payload.execution.session);

      if (handledInputCount === 1) {
        firstInputStarted.resolve();
        await firstInputCanFinish.promise;
      }
      await context.ports.eventSink.pushEvents({
        events: [
          {
            kind: "run.completed",
            payload: { status: "completed" },
            runId,
            sourceEventId: `queued-input.completed:${runId}`,
          },
        ],
      });
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
    await waitForUpdate(
      socket,
      (update) =>
        update.commandId === "input-2" &&
        update.status === "completed" &&
        runtimeState.status() === "ready",
    );

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
