import { describe, expect, test } from "bun:test";

import { DriverRuntimeStateMachine } from "../src/core/driver-runtime-state";
import { createMcpExecuteFailedEventIdentity } from "../src/events";
import type { DriverEventInput } from "../src/protocol/events";
import { driverRuntimeRpcSchemas } from "../src/protocol/orpc";
import type {
  McpExecuteCommand,
  McpExternalToolEffectState,
  McpExternalToolExecutionResult,
} from "../src/runtime-command";
import { RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES } from "../src/runtime-command";
import {
  DRIVER_TEST_IDS,
  FakeDriverRuntimeIo,
  createBackend,
  createDispatcher,
  waitForUpdate,
} from "./driver-runtime-boundary-fixtures";

function command(commandId: string): McpExecuteCommand {
  return {
    argumentsJson: '{"title":"once"}',
    commandId,
    kind: "mcp.execute",
    requestId: `request-${commandId}`,
    runId: DRIVER_TEST_IDS.runId,
    serverId: "mcp-linear",
    toolCallId: `tool-${commandId}`,
    toolName: "createIssue",
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(0);
  }
  throw new Error("Timed out waiting for Driver MCP state.");
}

describe("durable external MCP effect protocol v3", () => {
  test("exports the canonical failed MCP event identity", () => {
    expect(
      createMcpExecuteFailedEventIdentity({
        toolCallId: "tool-canonical",
        title: "createIssue",
        rawOutput: "provider rejected the request",
        rawInput: '{"issue":"A-1"}',
        commandId: "command-canonical",
      }),
    ).toEqual({
      payload: {
        kind: "mcp",
        rawInput: '{"issue":"A-1"}',
        rawOutput: "provider rejected the request",
        status: "failed",
        title: "createIssue",
        toolCallId: "tool-canonical",
      },
      sourceEventId:
        "mcp.execute.failed:807e9e02d3b2c37d2d77db8d1ad473b0db1e1e37f98c85556227baa8873ea62a",
    });
  });

  test("exposes only the schema-first v3 wire", () => {
    const claimToken = "00000000-0000-4000-8000-000000000001";
    const result = {
      outputText: "stored",
      requestId: "request-schema",
      serverId: "server-schema",
      toolName: "lookup",
    };

    expect(
      driverRuntimeRpcSchemas.driver.observeExternalToolEffect.output.parse({
        effectId: "effect-schema",
        kind: "intent",
      }),
    ).toEqual({ effectId: "effect-schema", kind: "intent" });
    expect(
      driverRuntimeRpcSchemas.driver.claimExternalToolEffect.output.parse({
        attempt: 1,
        effectId: "effect-schema",
        idempotencyKey: "idempotency-schema",
        kind: "claimed",
      }),
    ).toMatchObject({ kind: "claimed" });
    expect(
      driverRuntimeRpcSchemas.driver.settleExternalToolEffect.input.parse({
        claimToken,
        commandId: "command-schema",
        driverInstanceId: "driver-schema",
        effectId: "effect-schema",
        settlement: { kind: "succeeded", providerReceiptJson: null, result },
      }),
    ).toMatchObject({ settlement: { kind: "succeeded", result } });
    for (const invalidClaimToken of [
      "",
      "not-a-uuid",
      "00000000-0000-4000-8000-ABCDEFABCDEF",
      "00000000-0000-f000-8000-000000000001",
      "00000000-0000-4000-c000-000000000001",
    ]) {
      expect(
        driverRuntimeRpcSchemas.driver.claimExternalToolEffect.input.safeParse({
          claimToken: invalidClaimToken,
          commandId: "command-schema",
          driverInstanceId: "driver-schema",
        }).success,
      ).toBeFalse();
      expect(
        driverRuntimeRpcSchemas.driver.settleExternalToolEffect.input.safeParse({
          claimToken: invalidClaimToken,
          commandId: "command-schema",
          driverInstanceId: "driver-schema",
          effectId: "effect-schema",
          settlement: { kind: "unknown" },
        }).success,
      ).toBeFalse();
    }
    expect(
      driverRuntimeRpcSchemas.driver.claimExternalToolEffect.output.safeParse({
        attempt: 1,
        effectId: "effect-schema",
        idempotencyKey: "idempotency-schema",
        kind: "execute",
      }).success,
    ).toBeFalse();
    expect("completeExternalToolEffect" in driverRuntimeRpcSchemas.driver).toBeFalse();
    expect("markExternalToolEffectUnknown" in driverRuntimeRpcSchemas.driver).toBeFalse();
  });

  test.each([
    ["stale", DRIVER_TEST_IDS.secondRunId, DRIVER_TEST_IDS.runId],
    ["future", DRIVER_TEST_IDS.runId, DRIVER_TEST_IDS.secondRunId],
  ] as const)(
    "rejects a %s-run command before observing an external effect",
    async (_case, activeRunId, commandRunId) => {
      const input = { ...command(`wrong-run-${_case}`), runId: commandRunId };
      const socket = new FakeDriverRuntimeIo([input], activeRunId);
      let claims = 0;
      let observations = 0;
      let preparations = 0;
      socket.claimExternalToolEffect = async () => {
        claims += 1;
        throw new Error("unexpected claim");
      };
      socket.observeExternalToolEffect = async () => {
        observations += 1;
        throw new Error("unexpected observation");
      };
      const runtime = createDispatcher({
        backend: createBackend(),
        isShuttingDown: () => socket.isDrained(),
        mcpPrepare: async () => {
          preparations += 1;
          throw new Error("unexpected preparation");
        },
        runtimeState: new DriverRuntimeStateMachine("ready"),
      });

      await runtime.dispatcher.run(socket, runtime.logger);

      expect({ claims, observations, preparations }).toEqual({
        claims: 0,
        observations: 0,
        preparations: 0,
      });
      expect(socket.updates.at(-1)).toMatchObject({
        commandId: input.commandId,
        error: { code: "driver.command_failed.mcp.execute" },
        status: "failed",
      });
    },
  );

  test("normalizes an oversized MCP failure before emitting its tool event", async () => {
    const input = command("oversized-failure");
    const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpPrepare: async () => {
        throw new Error("界".repeat(500_000));
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await runtime.dispatcher.run(socket, runtime.logger);
    await waitForUpdate(socket, (update) => update.status === "failed");

    const terminal = socket.updates.at(-1);
    const failedToolEvent = socket.pushedEvents
      .flatMap(({ events }) => events)
      .find(
        (event) =>
          event.kind === "tool.call.updated" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          Reflect.get(event.payload, "status") === "failed",
      );
    expect(terminal).toMatchObject({
      error: { code: "driver.error_oversized" },
      status: "failed",
    });
    expect(failedToolEvent).toMatchObject({
      payload: { rawOutput: terminal?.status === "failed" ? terminal.error.message : undefined },
    });
  });

  test("runs the protocol in durable order and completes from canonical settlement", async () => {
    const input = command("ordered");
    const trace: string[] = [];
    const claims: Parameters<FakeDriverRuntimeIo["claimExternalToolEffect"]>[0][] = [];
    const settlements: Parameters<FakeDriverRuntimeIo["settleExternalToolEffect"]>[0][] = [];

    class OrderedSocket extends FakeDriverRuntimeIo {
      override async observeExternalToolEffect() {
        trace.push("observe");
        return { effectId: "effect-ordered", kind: "intent" as const };
      }

      override async claimExternalToolEffect(
        claim: Parameters<FakeDriverRuntimeIo["claimExternalToolEffect"]>[0],
      ) {
        trace.push("claim");
        claims.push(structuredClone(claim));
        return {
          attempt: 1,
          effectId: "effect-ordered",
          idempotencyKey: "idempotency-ordered",
          kind: "claimed" as const,
        };
      }

      override async settleExternalToolEffect(
        settlement: Parameters<FakeDriverRuntimeIo["settleExternalToolEffect"]>[0],
      ) {
        trace.push("settle");
        settlements.push(structuredClone(settlement));
        return settlement.settlement.kind === "succeeded"
          ? {
              effectId: settlement.effectId,
              kind: "succeeded" as const,
              result: settlement.settlement.result,
            }
          : { effectId: settlement.effectId, kind: "unknown" as const };
      }

      override async pushEvents(
        batch: Parameters<FakeDriverRuntimeIo["pushEvents"]>[0],
      ): ReturnType<FakeDriverRuntimeIo["pushEvents"]> {
        for (const event of batch.events) {
          if (
            event.kind === "tool.call.updated" &&
            typeof event.payload === "object" &&
            event.payload !== null &&
            "status" in event.payload &&
            typeof event.payload.status === "string"
          ) {
            trace.push(event.payload.status);
          }
        }
        return super.pushEvents(batch);
      }
    }

    const socket = new OrderedSocket([input], DRIVER_TEST_IDS.runId);
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpPrepare: async () => {
        trace.push("prepare");
        return {
          async execute() {
            trace.push("execute");
            return {
              outputText: "created A-1",
              providerReceiptJson: '{"receipt":"A-1"}',
              requestId: input.requestId,
              serverId: input.serverId,
              toolName: input.toolName,
            };
          },
          async [Symbol.asyncDispose]() {
            trace.push("cleanup");
          },
        };
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await runtime.dispatcher.run(socket, runtime.logger);
    await waitForUpdate(socket, (update) => update.status === "completed");

    expect(trace).toEqual([
      "running",
      "observe",
      "prepare",
      "claim",
      "execute",
      "settle",
      "cleanup",
      "completed",
    ]);
    expect(claims[0]?.claimToken).toMatch(/^[0-9a-f-]{36}$/u);
    expect(settlements[0]).toMatchObject({
      claimToken: claims[0]?.claimToken,
      commandId: input.commandId,
      effectId: "effect-ordered",
      settlement: {
        kind: "succeeded",
        providerReceiptJson: '{"receipt":"A-1"}',
      },
    });
    expect(
      socket.pushedEvents
        .flatMap(({ events }) => events)
        .filter((event) => event.kind === "tool.call.updated")
        .map(({ correlationId }) => correlationId),
    ).toEqual([input.commandId, input.commandId]);
  });

  test("settles a known oversized provider result as bounded succeeded data", async () => {
    const input = command("bounded-success");
    const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    const settlements: Parameters<FakeDriverRuntimeIo["settleExternalToolEffect"]>[0][] = [];
    socket.settleExternalToolEffect = async (next) => {
      settlements.push(structuredClone(next));
      return next.settlement.kind === "succeeded"
        ? {
            effectId: next.effectId,
            kind: "succeeded",
            result: next.settlement.result,
          }
        : { effectId: next.effectId, kind: "unknown" };
    };
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async () => ({
        outputText: "界".repeat(RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES),
        providerReceiptJson: JSON.stringify({ diagnostic: "unused" }),
        requestId: input.requestId,
        serverId: input.serverId,
        toolName: input.toolName,
      }),
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await runtime.dispatcher.run(socket, runtime.logger);
    await waitForUpdate(socket, (update) => update.status === "completed");

    expect(settlements[0]?.settlement).toEqual({
      kind: "succeeded",
      result: {
        isError: true,
        outputText:
          "MCP tool output was omitted because its durable settlement exceeded the 1044480-byte limit.",
        requestId: input.requestId,
        serverId: input.serverId,
        toolName: input.toolName,
      },
    });
    expect(socket.updates.at(-1)).toMatchObject({
      result: { isError: true, outputText: expect.stringContaining("output was omitted") },
      status: "completed",
    });
  });

  test("rejects an oversized command before acknowledgement, claim, or provider preparation", async () => {
    const input = {
      ...command("oversized-identity"),
      requestId: "r".repeat(RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES),
    };
    const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    let claims = 0;
    let preparations = 0;
    socket.claimExternalToolEffect = async (...arguments_) => {
      claims += 1;
      return FakeDriverRuntimeIo.prototype.claimExternalToolEffect.apply(socket, arguments_);
    };
    const runtime = createDispatcher({
      backend: createBackend(),
      mcpPrepare: async () => {
        preparations += 1;
        throw new Error("oversized identity must not prepare the provider");
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await expect(runtime.dispatcher.run(socket, runtime.logger)).rejects.toThrow(
      "Runtime command exceeds",
    );

    expect(claims).toBe(0);
    expect(preparations).toBe(0);
    expect(socket.updates).toEqual([]);
  });

  test("replays a durable succeeded effect after completed event delivery fails", async () => {
    const input = command("completed-event-replay");
    const result = {
      outputText: "created once",
      requestId: input.requestId,
      serverId: input.serverId,
      toolName: input.toolName,
    };
    let state: McpExternalToolEffectState = {
      effectId: `test-effect-${input.commandId}`,
      kind: "intent",
    };
    let executions = 0;
    const firstEventIds: string[] = [];
    const firstSocket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    firstSocket.observeExternalToolEffect = async () => state;
    firstSocket.settleExternalToolEffect = async (settlement) => {
      state = { effectId: settlement.effectId, kind: "succeeded", result };
      return state;
    };
    const firstPush = firstSocket.pushEvents.bind(firstSocket);
    firstSocket.pushEvents = async (batch) => {
      const completed = batch.events.find(
        (event) =>
          event.kind === "tool.call.updated" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          Reflect.get(event.payload, "status") === "completed",
      );
      if (completed !== undefined) {
        firstEventIds.push(completed.sourceEventId!);
        throw new Error("completed event acknowledgement lost");
      }
      return firstPush(batch);
    };
    let firstRuntime!: ReturnType<typeof createDispatcher>;
    firstRuntime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => firstRuntime.shutdownCalls.length > 0,
      mcpExecute: async () => {
        executions += 1;
        return result;
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    const firstRun = firstRuntime.dispatcher.run(firstSocket, firstRuntime.logger);
    await waitFor(() => firstRuntime.shutdownCalls.includes("driver.mcp_task_failed"));
    await firstRun.catch(() => {});

    expect(executions).toBe(1);
    expect(firstSocket.updates).toEqual([{ commandId: input.commandId, status: "accepted" }]);
    expect(firstEventIds).toEqual([`mcp.execute.completed:${input.commandId}`]);

    const replacementEventIds: string[] = [];
    const replacementSocket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    replacementSocket.observeExternalToolEffect = async () => state;
    const replacementPush = replacementSocket.pushEvents.bind(replacementSocket);
    replacementSocket.pushEvents = async (batch) => {
      for (const event of batch.events) {
        if (
          event.kind === "tool.call.updated" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          Reflect.get(event.payload, "status") === "completed"
        ) {
          replacementEventIds.push(event.sourceEventId!);
        }
      }
      return replacementPush(batch);
    };
    const replacement = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => replacementSocket.isDrained(),
      mcpPrepare: async () => {
        throw new Error("durable succeeded effect must not re-execute");
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await replacement.dispatcher.run(replacementSocket, replacement.logger);
    await waitForUpdate(replacementSocket, (update) => update.status === "completed");

    expect(executions).toBe(1);
    expect(replacementEventIds).toEqual(firstEventIds);
    expect(replacementSocket.updates.at(-1)).toMatchObject({
      result,
      status: "completed",
    });
  });

  test("keeps an MCP command accepted when its failed tool event is not durable", async () => {
    const input = command("failed-event-unavailable");
    const eventIds: string[] = [];
    const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    const push = socket.pushEvents.bind(socket);
    socket.pushEvents = async (batch) => {
      const failed = batch.events.find(
        (event) =>
          event.kind === "tool.call.updated" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          Reflect.get(event.payload, "status") === "failed",
      );
      if (failed !== undefined) {
        eventIds.push(failed.sourceEventId!);
        throw new Error("failed event unavailable");
      }
      return push(batch);
    };
    let runtime!: ReturnType<typeof createDispatcher>;
    runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => runtime.shutdownCalls.length > 0,
      mcpPrepare: async () => {
        throw new Error("provider preparation failed");
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    const run = runtime.dispatcher.run(socket, runtime.logger);
    await waitFor(() => runtime.shutdownCalls.includes("driver.mcp_task_failed"));
    await run.catch(() => {});

    expect(eventIds).toHaveLength(1);
    expect(eventIds[0]).toMatch(/^mcp\.execute\.failed:[0-9a-f]{64}$/u);
    expect(socket.updates).toEqual([{ commandId: input.commandId, status: "accepted" }]);
  });

  test("content-addresses changed MCP failures across an ACK-lost instance replay", async () => {
    const input = command("failed-event-cross-instance");
    const persisted = new Map<string, string>();

    const observeFailure = async (message: string, loseAck: boolean) => {
      const observed = Promise.withResolvers<DriverEventInput>();
      const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
      const push = socket.pushEvents.bind(socket);
      socket.pushEvents = async (batch) => {
        const failed = batch.events.find(
          (event) =>
            event.kind === "tool.call.updated" &&
            typeof event.payload === "object" &&
            event.payload !== null &&
            Reflect.get(event.payload, "status") === "failed",
        );
        if (failed === undefined) {
          return push(batch);
        }

        const sourceEventId = failed.sourceEventId!;
        const content = JSON.stringify(failed);
        const previous = persisted.get(sourceEventId);
        expect(previous === undefined || previous === content).toBeTrue();
        persisted.set(sourceEventId, content);
        observed.resolve(structuredClone(failed));
        const result = await push(batch);
        if (loseAck) {
          throw new Error("failed event ACK lost after persistence");
        }
        return result;
      };
      let runtime!: ReturnType<typeof createDispatcher>;
      runtime = createDispatcher({
        backend: createBackend(),
        isShuttingDown: () => (loseAck ? runtime.shutdownCalls.length > 0 : socket.isDrained()),
        mcpPrepare: async () => {
          throw new Error(message);
        },
        runtimeState: new DriverRuntimeStateMachine("ready"),
      });

      const run = runtime.dispatcher.run(socket, runtime.logger);
      const event = await observed.promise;
      await waitFor(() =>
        loseAck
          ? runtime.shutdownCalls.includes("driver.mcp_task_failed")
          : socket.updates.some(
              ({ commandId, status }) => commandId === input.commandId && status === "failed",
            ),
      );
      await run.catch(() => {});
      return event;
    };

    const first = await observeFailure("same failure", true);
    const replay = await observeFailure("same failure", false);
    const changed = await observeFailure("changed failure", false);

    expect(replay.sourceEventId).toBe(first.sourceEventId);
    expect(changed.sourceEventId).not.toBe(first.sourceEventId);
    expect([first, replay, changed].map(({ correlationId }) => correlationId)).toEqual([
      input.commandId,
      input.commandId,
      input.commandId,
    ]);
    expect(persisted.size).toBe(2);
  });

  test("keeps an aborted MCP command accepted when its cancelled tool event is not durable", async () => {
    const input = command("cancelled-event-unavailable");
    const observed = Promise.withResolvers<void>();
    const eventIds: string[] = [];
    const shutdown = new AbortController();
    const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    socket.observeExternalToolEffect = async (_command, signal) => {
      observed.resolve();
      return new Promise<McpExternalToolEffectState>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const push = socket.pushEvents.bind(socket);
    socket.pushEvents = async (batch) => {
      const cancelled = batch.events.find(
        (event) =>
          event.kind === "tool.call.updated" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          Reflect.get(event.payload, "status") === "cancelled",
      );
      if (cancelled !== undefined) {
        eventIds.push(cancelled.sourceEventId!);
        throw new Error("cancelled event unavailable");
      }
      return push(batch);
    };
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => shutdown.signal.aborted,
      runtimeState: new DriverRuntimeStateMachine("ready"),
      shutdownSignal: shutdown.signal,
    });
    const run = runtime.dispatcher.run(socket, runtime.logger);

    await observed.promise;
    shutdown.abort(new Error("stop before claim"));
    await run.catch(() => {});

    expect(eventIds).toEqual([`mcp.execute.cancelled:${input.commandId}`]);
    expect(socket.updates).toEqual([{ commandId: input.commandId, status: "accepted" }]);
  });

  test("rechecks exact run ownership after preparation and before claim", async () => {
    const input = command("run-changed-before-claim");
    let currentRunId = DRIVER_TEST_IDS.runId;
    let claims = 0;
    let executions = 0;
    class RunChangingSocket extends FakeDriverRuntimeIo {
      override currentRunId() {
        return currentRunId;
      }
    }
    const socket = new RunChangingSocket([input], DRIVER_TEST_IDS.runId);
    socket.claimExternalToolEffect = async (...arguments_) => {
      claims += 1;
      return FakeDriverRuntimeIo.prototype.claimExternalToolEffect.apply(socket, arguments_);
    };
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpPrepare: async () => {
        currentRunId = DRIVER_TEST_IDS.secondRunId;
        return {
          async execute() {
            executions += 1;
            throw new Error("stale run must not execute");
          },
          async [Symbol.asyncDispose]() {},
        };
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await runtime.dispatcher.run(socket, runtime.logger);
    await waitForUpdate(socket, (update) => update.status === "failed");

    expect(claims).toBe(0);
    expect(executions).toBe(0);
    expect(socket.updates.map(({ status }) => status)).toEqual(["accepted", "failed"]);
  });

  test.each(["succeeded", "unknown", "claimed"] as const)(
    "does not prepare an already-%s effect",
    async (kind) => {
      const input = command(`observed-${kind}`);
      const result = {
        outputText: "stored result",
        requestId: input.requestId,
        serverId: input.serverId,
        toolName: input.toolName,
      };
      const state: McpExternalToolEffectState =
        kind === "succeeded"
          ? { effectId: "effect-observed", kind, result }
          : kind === "claimed"
            ? {
                attempt: 2,
                effectId: "effect-observed",
                idempotencyKey: "idempotency-observed",
                kind,
              }
            : { effectId: "effect-observed", kind };
      const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
      socket.observeExternalToolEffect = async () => state;
      let preparations = 0;
      let claims = 0;
      socket.claimExternalToolEffect = async (...arguments_) => {
        claims += 1;
        return FakeDriverRuntimeIo.prototype.claimExternalToolEffect.apply(socket, arguments_);
      };
      const runtime = createDispatcher({
        backend: createBackend(),
        isShuttingDown: () => socket.isDrained(),
        mcpPrepare: async () => {
          preparations += 1;
          throw new Error("observed effects must not be prepared");
        },
        runtimeState: new DriverRuntimeStateMachine("ready"),
      });

      const run = runtime.dispatcher.run(socket, runtime.logger);
      if (kind === "succeeded") {
        await waitForUpdate(socket, (update) => update.status === "completed");
        expect(socket.updates.at(-1)).toEqual({
          commandId: input.commandId,
          result,
          status: "completed",
        });
      } else if (kind === "unknown") {
        await waitForUpdate(socket, (update) => update.status === "failed");
        expect(socket.updates.at(-1)).toMatchObject({
          error: {
            code: "driver.external_tool_effect_unknown",
            details: {
              commandId: input.commandId,
              effectId: "effect-observed",
              requestId: input.requestId,
              serverId: input.serverId,
              toolName: input.toolName,
            },
            retryable: false,
          },
          status: "failed",
        });
      } else {
        await waitFor(() => runtime.shutdownCalls.includes("driver.mcp_task_failed"));
        expect(socket.updates).toEqual([{ commandId: input.commandId, status: "accepted" }]);
      }
      await run.catch(() => {});
      expect(preparations).toBe(0);
      expect(claims).toBe(0);
    },
  );

  test.each([
    ["observe", "requestId", 0, 0],
    ["claim", "serverId", 1, 0],
    ["settle", "toolName", 1, 1],
  ] as const)(
    "fail-closes a canonical result with a mismatched identity from %s",
    async (source, mismatchedField, expectedPreparations, expectedExecutions) => {
      const input = command(`mismatched-${source}`);
      const effectId = `test-effect-${input.commandId}`;
      const matchingResult = {
        outputText: "canonical result",
        requestId: input.requestId,
        serverId: input.serverId,
        toolName: input.toolName,
      };
      const mismatchedState: McpExternalToolEffectState = {
        effectId,
        kind: "succeeded",
        result: { ...matchingResult, [mismatchedField]: `wrong-${mismatchedField}` },
      };
      const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
      if (source === "observe") {
        socket.observeExternalToolEffect = async () => mismatchedState;
      } else if (source === "claim") {
        socket.claimExternalToolEffect = async () => mismatchedState;
      } else {
        socket.settleExternalToolEffect = async () => mismatchedState;
      }

      let executions = 0;
      let preparations = 0;
      const runtime = createDispatcher({
        backend: createBackend(),
        isShuttingDown: () => socket.isDrained(),
        mcpPrepare: async () => {
          preparations += 1;
          return {
            async execute() {
              executions += 1;
              return matchingResult;
            },
            async [Symbol.asyncDispose]() {},
          };
        },
        runtimeState: new DriverRuntimeStateMachine("ready"),
      });

      const run = runtime.dispatcher.run(socket, runtime.logger);
      await waitFor(() => runtime.shutdownCalls.includes("driver.mcp_task_failed"));
      await run.catch(() => {});

      expect(preparations).toBe(expectedPreparations);
      expect(executions).toBe(expectedExecutions);
      expect(socket.updates).toEqual([{ commandId: input.commandId, status: "accepted" }]);
    },
  );

  test("retries a lost claim acknowledgement with the same token", async () => {
    const input = command("claim-retry");
    const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    const claims: Parameters<FakeDriverRuntimeIo["claimExternalToolEffect"]>[0][] = [];
    socket.claimExternalToolEffect = async (claim) => {
      claims.push(structuredClone(claim));
      if (claims.length === 1) {
        throw new Error("claim acknowledgement lost");
      }
      return {
        attempt: 1,
        effectId: `test-effect-${input.commandId}`,
        idempotencyKey: "claim-retry-key",
        kind: "claimed",
      };
    };
    let executions = 0;
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async () => {
        executions += 1;
        return {
          outputText: "created once",
          requestId: input.requestId,
          serverId: input.serverId,
          toolName: input.toolName,
        };
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await runtime.dispatcher.run(socket, runtime.logger);
    await waitForUpdate(socket, (update) => update.status === "completed");

    expect(claims).toHaveLength(2);
    expect(claims[1]).toEqual(claims[0]);
    expect(executions).toBe(1);
  });

  test("leaves the command accepted when both claim responses are unreachable", async () => {
    const input = command("claim-unreachable");
    const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    const claims: Parameters<FakeDriverRuntimeIo["claimExternalToolEffect"]>[0][] = [];
    let disposals = 0;
    let executions = 0;
    let settlements = 0;
    socket.claimExternalToolEffect = async (claim) => {
      claims.push(structuredClone(claim));
      throw new Error("claim response unreachable");
    };
    socket.settleExternalToolEffect = async (...arguments_) => {
      settlements += 1;
      return FakeDriverRuntimeIo.prototype.settleExternalToolEffect.apply(socket, arguments_);
    };
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpPrepare: async () => ({
        async execute() {
          executions += 1;
          throw new Error("unreachable claim must not execute");
        },
        async [Symbol.asyncDispose]() {
          disposals += 1;
        },
      }),
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    const run = runtime.dispatcher.run(socket, runtime.logger);
    await waitFor(() => runtime.shutdownCalls.includes("driver.mcp_task_failed"));
    await run.catch(() => {});

    expect(claims).toHaveLength(2);
    expect(claims[1]).toEqual(claims[0]);
    expect(executions).toBe(0);
    expect(settlements).toBe(0);
    expect(disposals).toBe(1);
    expect(socket.updates).toEqual([{ commandId: input.commandId, status: "accepted" }]);
  });

  test("settles provider failure as unknown instead of cancelling the command", async () => {
    const input = command("provider-unknown");
    const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    const settlements: Parameters<FakeDriverRuntimeIo["settleExternalToolEffect"]>[0][] = [];
    socket.settleExternalToolEffect = async (settlement, signal) => {
      expect(signal.aborted).toBeFalse();
      settlements.push(structuredClone(settlement));
      return { effectId: settlement.effectId, kind: "unknown" };
    };
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async () => {
        throw new Error("provider response lost");
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await runtime.dispatcher.run(socket, runtime.logger);
    await waitForUpdate(socket, (update) => update.status === "failed");

    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.settlement).toEqual({ kind: "unknown" });
    expect(socket.updates.some((update) => update.status === "cancelled")).toBeFalse();
    const terminal = socket.updates.at(-1);
    expect(terminal?.status === "failed" ? terminal.error.code : undefined).toBe(
      "driver.external_tool_effect_unknown",
    );
  });

  test.each(["succeeded", "unknown"] as const)(
    "treats a resolved claim as the commit point for a %s provider outcome",
    async (outcome) => {
      const input = command(`claim-commit-${outcome}`);
      const claimStarted = Promise.withResolvers<void>();
      const releaseClaim = Promise.withResolvers<void>();
      class CommitPointSocket extends FakeDriverRuntimeIo {
        #reads = 0;

        override async nextCommand(signal: AbortSignal) {
          this.#reads += 1;
          if (this.#reads === 2) {
            await claimStarted.promise;
          }
          return super.nextCommand(signal);
        }
      }
      const socket = new CommitPointSocket(
        [
          input,
          {
            commandId: `cancel-${input.commandId}`,
            kind: "turn.cancel",
            reason: "cancel immediately after claim",
            runId: DRIVER_TEST_IDS.runId,
          },
        ],
        DRIVER_TEST_IDS.runId,
      );
      const settlements: Parameters<FakeDriverRuntimeIo["settleExternalToolEffect"]>[0][] = [];
      const settlementSignals: boolean[] = [];
      let disposals = 0;
      let executions = 0;

      socket.claimExternalToolEffect = async () => {
        claimStarted.resolve();
        await releaseClaim.promise;
        return {
          attempt: 1,
          effectId: `test-effect-${input.commandId}`,
          idempotencyKey: `test-effect-${input.commandId}`,
          kind: "claimed",
        };
      };
      socket.settleExternalToolEffect = async (settlement, signal) => {
        settlements.push(structuredClone(settlement));
        settlementSignals.push(signal.aborted);
        return settlement.settlement.kind === "succeeded"
          ? {
              effectId: settlement.effectId,
              kind: "succeeded",
              result: settlement.settlement.result,
            }
          : { effectId: settlement.effectId, kind: "unknown" };
      };
      const runtime = createDispatcher({
        backend: createBackend(),
        isShuttingDown: () => socket.isDrained(),
        mcpPrepare: async (_command, prepareSignal) => {
          prepareSignal.addEventListener("abort", () => releaseClaim.resolve(), { once: true });
          return {
            async execute() {
              executions += 1;
              expect(prepareSignal.aborted).toBeTrue();
              if (outcome === "unknown") {
                throw new Error("provider response lost");
              }
              return {
                outputText: "committed result",
                requestId: input.requestId,
                serverId: input.serverId,
                toolName: input.toolName,
              };
            },
            async [Symbol.asyncDispose]() {
              disposals += 1;
            },
          };
        },
        runtimeState: new DriverRuntimeStateMachine("ready"),
      });

      await runtime.dispatcher.run(socket, runtime.logger);

      expect(executions).toBe(1);
      expect(disposals).toBe(1);
      expect(settlements).toHaveLength(1);
      expect(settlements[0]?.settlement.kind).toBe(outcome);
      expect(settlementSignals).toEqual([false]);
      expect(
        socket.updates.some(
          (update) => update.commandId === input.commandId && update.status === "cancelled",
        ),
      ).toBeFalse();
      expect(
        socket.updates.findLast(
          (update) => update.commandId === input.commandId && update.status !== "accepted",
        ),
      ).toMatchObject(
        outcome === "succeeded"
          ? { result: { outputText: "committed result" }, status: "completed" }
          : {
              error: { code: "driver.external_tool_effect_unknown", retryable: false },
              status: "failed",
            },
      );
    },
  );

  test("uses a fresh settlement budget after cancellation claims the effect", async () => {
    const input = command("cancel-after-claim");
    const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    const entered = Promise.withResolvers<void>();
    const execution = Promise.withResolvers<McpExternalToolExecutionResult>();
    const shutdown = new AbortController();
    const settlementSignals: boolean[] = [];
    socket.settleExternalToolEffect = async (settlement, signal) => {
      settlementSignals.push(signal.aborted);
      return { effectId: settlement.effectId, kind: "unknown" };
    };
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => shutdown.signal.aborted,
      mcpExecute: async () => {
        entered.resolve();
        return execution.promise;
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
      shutdownSignal: shutdown.signal,
    });
    const run = runtime.dispatcher.run(socket, runtime.logger);

    await entered.promise;
    shutdown.abort(new Error("test shutdown"));
    execution.reject(new Error("provider response lost"));
    await run;

    expect(settlementSignals).toEqual([false]);
    expect(socket.updates.some((update) => update.status === "cancelled")).toBeFalse();
    const terminal = socket.updates.at(-1);
    expect(terminal?.status === "failed" ? terminal.error.code : undefined).toBe(
      "driver.external_tool_effect_unknown",
    );
  });

  test("retries the identical settlement and trusts its stored result", async () => {
    const input = command("settlement-retry");
    const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    const settlements: Parameters<FakeDriverRuntimeIo["settleExternalToolEffect"]>[0][] = [];
    const storedResult = {
      outputText: "stored canonical result",
      requestId: input.requestId,
      serverId: input.serverId,
      toolName: input.toolName,
    };
    socket.settleExternalToolEffect = async (settlement) => {
      settlements.push(structuredClone(settlement));
      if (settlements.length === 1) {
        throw new Error("settlement acknowledgement lost");
      }
      return { effectId: settlement.effectId, kind: "succeeded", result: storedResult };
    };
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async () => ({
        outputText: "provider result",
        requestId: input.requestId,
        serverId: input.serverId,
        toolName: input.toolName,
      }),
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await runtime.dispatcher.run(socket, runtime.logger);
    await waitForUpdate(socket, (update) => update.status === "completed");

    expect(settlements).toHaveLength(2);
    expect(settlements[1]).toEqual(settlements[0]);
    const terminal = socket.updates.at(-1);
    expect(terminal?.status === "completed" ? terminal.result : undefined).toEqual(storedResult);
  });

  test("leaves a successfully invoked effect accepted when settlement is unreachable", async () => {
    const input = command("settlement-unreachable");
    const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    let executions = 0;
    let settlements = 0;
    socket.settleExternalToolEffect = async () => {
      settlements += 1;
      throw new Error("settlement unreachable");
    };
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async () => {
        executions += 1;
        return {
          outputText: "provider result",
          requestId: input.requestId,
          serverId: input.serverId,
          toolName: input.toolName,
        };
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    const run = runtime.dispatcher.run(socket, runtime.logger);
    await waitFor(() => runtime.shutdownCalls.includes("driver.mcp_task_failed"));
    await run.catch(() => {});

    expect(executions).toBe(1);
    expect(settlements).toBe(2);
    expect(socket.updates).toEqual([{ commandId: input.commandId, status: "accepted" }]);
  });

  test("treats MCP cleanup failure as diagnostic-only", async () => {
    const input = command("cleanup-diagnostic");
    const socket = new FakeDriverRuntimeIo([input], DRIVER_TEST_IDS.runId);
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpPrepare: async () => ({
        async execute() {
          return {
            outputText: "durable result",
            requestId: input.requestId,
            serverId: input.serverId,
            toolName: input.toolName,
          };
        },
        async [Symbol.asyncDispose]() {
          throw new Error("cleanup failed");
        },
      }),
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await runtime.dispatcher.run(socket, runtime.logger);
    await waitForUpdate(socket, (update) => update.status === "completed");

    expect(socket.updates.at(-1)).toMatchObject({
      commandId: input.commandId,
      status: "completed",
    });
    expect(runtime.shutdownCalls).toEqual([]);
  });
});
