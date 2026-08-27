import { describe, expect, test } from "bun:test";

import { DriverRuntimeStateMachine } from "../src/core/driver-runtime-state";
import { createTimingEvent } from "../src/core/driver-runtime-timing";
import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import type { CredentialId, McpServerId } from "../src/protocol/boot";
import { parseDriverEventEnvelope } from "../src/protocol/events";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import type { DriverStartInput } from "../src/protocol/start";
import type { McpExecuteCommand, RuntimeCommand } from "../src/runtime-command";
import { prepareRemoteHttpMcpCommand } from "../src/runtimes/mcp/remote-http-mcp-executor";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";
import {
  FakeDriverRuntimeIo,
  bootPayload,
  createBackend,
  createDispatcher,
  waitForUpdate,
} from "./driver-runtime-boundary-fixtures";

const MCP_PREFLIGHT_SERVER_ID = "01J00000000000000000000020" as McpServerId;
const MCP_PREFLIGHT_CREDENTIAL_ID = "01J00000000000000000000021" as CredentialId;

function withMcpServers(
  mcpServers: DriverStartInput["execution"]["session"]["mcpServers"],
): DriverStartInput {
  return {
    ...bootPayload,
    execution: {
      ...bootPayload.execution,
      session: {
        ...bootPayload.execution.session,
        mcpServers,
      },
    },
  };
}

class EffectLedgerRecordingSocket extends FakeDriverRuntimeIo {
  claimCount = 0;
  unknownCount = 0;

  override async claimExternalToolEffect(
    input: Parameters<FakeDriverRuntimeIo["claimExternalToolEffect"]>[0],
    signal: AbortSignal,
  ): ReturnType<FakeDriverRuntimeIo["claimExternalToolEffect"]> {
    this.claimCount += 1;
    return super.claimExternalToolEffect(input, signal);
  }

  override async markExternalToolEffectUnknown(): Promise<void> {
    this.unknownCount += 1;
  }
}

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
              toolCallId: "tool-replay",
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
      toolCallId: "tool-persistent-effect",
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
    let secondClaims = 0;
    let secondPreparations = 0;
    const second = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => secondSocket.isDrained(),
      mcpPrepare: async () => {
        secondPreparations += 1;
        return {
          async execute() {
            throw new Error("completed effect must not execute");
          },
          async [Symbol.asyncDispose]() {},
        };
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    // The default fixture ledger has no cross-process state, so carry the
    // persisted effect receipt through the fresh Dispatcher explicitly.
    secondSocket.claimExternalToolEffect = async () => {
      secondClaims += 1;
      return {
        effectId: "effect-1",
        kind: "completed" as const,
        result: effectResult!,
      };
    };
    await second.dispatcher.run(secondSocket, second.logger);
    await second.logger.destroy();

    expect(providerCalls).toBe(1);
    expect(secondPreparations).toBe(1);
    expect(secondClaims).toBe(1);
    expect(secondSocket.updates).toEqual([
      { commandId: command.commandId, status: "accepted" },
      { commandId: command.commandId, result: effectResult, status: "completed" },
    ]);
    expect(secondSocket.pushedEvents).toMatchObject([
      {
        events: [{ kind: "tool.call.updated", payload: { toolCallId: command.toolCallId } }],
      },
      {
        events: [{ kind: "tool.call.updated", payload: { toolCallId: command.toolCallId } }],
      },
    ]);
  });

  test("blocks an unknown MCP effect without another provider call", async () => {
    const command: RuntimeCommand = {
      argumentsJson: '{"title":"do not duplicate"}',
      commandId: "unknown-effect-command",
      kind: "mcp.execute",
      requestId: "unknown-effect-request",
      serverId: "mcp-linear",
      toolCallId: "tool-unknown-effect",
      toolName: "createIssue",
    };
    const socket = new FakeDriverRuntimeIo([command]);
    let claims = 0;
    let executions = 0;
    let preparations = 0;
    socket.claimExternalToolEffect = async () => {
      claims += 1;
      return {
        effectId: "01J0000000000000000000000Z",
        kind: "unknown" as const,
      };
    };
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpPrepare: async () => {
        preparations += 1;
        return {
          async execute() {
            executions += 1;
            throw new Error("unknown effect must not execute");
          },
          async [Symbol.asyncDispose]() {},
        };
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await runtime.dispatcher.run(socket, runtime.logger);
    await runtime.logger.destroy();

    expect(preparations).toBe(1);
    expect(claims).toBe(1);
    expect(executions).toBe(0);
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

  test("disposes MCP preparation when the claim CAS observes a completed effect", async () => {
    const command: McpExecuteCommand = {
      argumentsJson: "{}",
      commandId: "claim-race-completed",
      kind: "mcp.execute",
      requestId: "claim-race-request",
      serverId: MCP_PREFLIGHT_SERVER_ID,
      toolCallId: "claim-race-tool",
      toolName: "lookup",
    };
    const result = {
      outputText: "already completed",
      requestId: command.requestId,
      serverId: command.serverId,
      toolName: command.toolName,
    };
    const socket = new FakeDriverRuntimeIo([command]);
    socket.claimExternalToolEffect = async () => ({
      effectId: "claim-race-effect",
      kind: "completed" as const,
      result,
    });
    let disposals = 0;
    let executions = 0;
    const disposed = Promise.withResolvers<void>();
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpPrepare: async () => ({
        async execute() {
          executions += 1;
          throw new Error("completed claim must not execute");
        },
        async [Symbol.asyncDispose]() {
          disposals += 1;
          disposed.resolve();
        },
      }),
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await runtime.dispatcher.run(socket, runtime.logger);
    await disposed.promise;
    await runtime.logger.destroy();

    expect(executions).toBe(0);
    expect(disposals).toBe(1);
    expect(socket.updates).toContainEqual({
      commandId: command.commandId,
      result,
      status: "completed",
    });
  });

  test.each(["executed", "completed claim"] as const)(
    "keeps a durable %s MCP result completed when its event publication fails",
    async (settlement) => {
      const command: McpExecuteCommand = {
        argumentsJson: "{}",
        commandId: `durable-event-failure-${settlement.replaceAll(" ", "-")}`,
        kind: "mcp.execute",
        requestId: "durable-event-failure-request",
        serverId: MCP_PREFLIGHT_SERVER_ID,
        toolCallId: "durable-event-failure-tool",
        toolName: "lookup",
      };
      const result = {
        outputText: "durable result",
        requestId: command.requestId,
        serverId: command.serverId,
        toolName: command.toolName,
      };
      const durable = Promise.withResolvers<void>();
      const completedEventEntered = Promise.withResolvers<void>();
      const releaseCompletedEvent = Promise.withResolvers<void>();

      class FailingCompletedEventSocket extends FakeDriverRuntimeIo {
        unknownCount = 0;

        override async claimExternalToolEffect(): ReturnType<
          FakeDriverRuntimeIo["claimExternalToolEffect"]
        > {
          if (settlement === "completed claim") {
            durable.resolve();
            return { effectId: "durable-effect", kind: "completed", result };
          }
          return {
            attempt: 1,
            effectId: "durable-effect",
            idempotencyKey: "durable-effect",
            kind: "execute",
          };
        }

        override async completeExternalToolEffect(): Promise<void> {
          durable.resolve();
        }

        override async markExternalToolEffectUnknown(): Promise<void> {
          this.unknownCount += 1;
        }

        override async pushEvents(
          input: Parameters<FakeDriverRuntimeIo["pushEvents"]>[0],
        ): ReturnType<FakeDriverRuntimeIo["pushEvents"]> {
          if (
            input.events.some(
              (event) =>
                event.kind === "tool.call.updated" &&
                typeof event.payload === "object" &&
                event.payload !== null &&
                "status" in event.payload &&
                event.payload.status === "completed",
            )
          ) {
            completedEventEntered.resolve();
            await releaseCompletedEvent.promise;
            throw new Error("completed tool event delivery failed");
          }
          return super.pushEvents(input);
        }
      }

      const socket = new FailingCompletedEventSocket([command]);
      let providerCalls = 0;
      const runtime = createDispatcher({
        backend: createBackend(),
        isShuttingDown: () => socket.isDrained(),
        mcpExecute: async () => {
          providerCalls += 1;
          return result;
        },
        runtimeState: new DriverRuntimeStateMachine("ready"),
      });
      const runTask = runtime.dispatcher.run(socket, runtime.logger);

      await durable.promise;
      await completedEventEntered.promise;
      expect(socket.updates.filter(({ status }) => status !== "accepted")).toEqual([]);
      releaseCompletedEvent.resolve();
      await runTask;
      await waitForUpdate(
        socket,
        (update) => update.commandId === command.commandId && update.status === "completed",
      );
      await runtime.logger.destroy();

      expect(providerCalls).toBe(settlement === "executed" ? 1 : 0);
      expect(socket.unknownCount).toBe(0);
      expect(socket.updates.filter(({ status }) => status !== "accepted")).toEqual([
        { commandId: command.commandId, result, status: "completed" },
      ]);
    },
  );

  test.each([
    [
      "invalid arguments",
      withMcpServers([
        {
          authType: "bearer",
          authorizationState: "active",
          credentialId: MCP_PREFLIGHT_CREDENTIAL_ID,
          credentialScope: "session",
          credentialStatus: "active",
          name: "Test MCP",
          proxyGrantId: "test-grant",
          proxyUrl: "https://mcp.invalid.test",
          serverId: MCP_PREFLIGHT_SERVER_ID,
        },
      ]),
      "{",
      MCP_PREFLIGHT_SERVER_ID,
      "Invalid MCP tool arguments",
    ],
    ["missing server", withMcpServers([]), "{}", MCP_PREFLIGHT_SERVER_ID, "not configured"],
    [
      "disabled server",
      withMcpServers([
        {
          authType: "bearer",
          authorizationState: "disabled",
          credentialScope: "session",
          credentialStatus: "disabled",
          name: "Test MCP",
          serverId: MCP_PREFLIGHT_SERVER_ID,
        },
      ]),
      "{}",
      MCP_PREFLIGHT_SERVER_ID,
      "disabled for this session",
    ],
  ] as const)(
    "rejects %s before claiming an external effect",
    async (_name, payload, argumentsJson, serverId, message) => {
      const command: McpExecuteCommand = {
        argumentsJson,
        commandId: `preflight-${_name.replaceAll(" ", "-")}`,
        kind: "mcp.execute",
        requestId: "preflight-request",
        serverId,
        toolCallId: "preflight-tool",
        toolName: "lookup",
      };

      const socket = new EffectLedgerRecordingSocket([command]);
      const runtime = createDispatcher({
        backend: createBackend(),
        isShuttingDown: () => socket.isDrained(),
        mcpPrepare: (input, signal) => prepareRemoteHttpMcpCommand(payload, input, signal),
        runtimeState: new DriverRuntimeStateMachine("ready"),
      });

      await runtime.dispatcher.run(socket, runtime.logger);
      await waitForUpdate(
        socket,
        (update) => update.commandId === command.commandId && update.status === "failed",
      );
      await runtime.logger.destroy();
      const failure = socket.updates.find(
        (update) => update.commandId === command.commandId && update.status === "failed",
      );

      expect(failure?.error?.message).toContain(message);
      expect(socket.claimCount).toBe(0);
      expect(socket.unknownCount).toBe(0);
    },
  );

  test("does not claim an external effect when MCP connection setup fails", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requestCount += 1;
        return new Response("unavailable", { status: 503 });
      },
    });
    const payload = withMcpServers([
      {
        authType: "bearer",
        authorizationState: "active",
        credentialId: MCP_PREFLIGHT_CREDENTIAL_ID,
        credentialScope: "session",
        credentialStatus: "active",
        name: "Test MCP",
        proxyGrantId: "test-grant",
        proxyUrl: `http://${server.hostname}:${server.port}`,
        serverId: MCP_PREFLIGHT_SERVER_ID,
      },
    ]);
    const command: McpExecuteCommand = {
      argumentsJson: "{}",
      commandId: "preflight-connect-failure",
      kind: "mcp.execute",
      requestId: "preflight-connect-request",
      serverId: MCP_PREFLIGHT_SERVER_ID,
      toolCallId: "preflight-connect-tool",
      toolName: "lookup",
    };
    const socket = new EffectLedgerRecordingSocket([command]);
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpPrepare: (input, signal) => prepareRemoteHttpMcpCommand(payload, input, signal),
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    try {
      await runtime.dispatcher.run(socket, runtime.logger);
      await waitForUpdate(
        socket,
        (update) => update.commandId === command.commandId && update.status === "failed",
      );
      const failure = socket.updates.find(
        (update) => update.commandId === command.commandId && update.status === "failed",
      );

      expect(requestCount).toBeGreaterThan(0);
      expect(failure?.error?.message).toContain("HTTP 503");
      expect(socket.claimCount).toBe(0);
      expect(socket.unknownCount).toBe(0);
    } finally {
      await runtime.logger.destroy();
      await server.stop(true);
    }
  });

  test.each([
    ["before prepare", 0, 0],
    ["during prepare", 0, 0],
    ["during claim", 1, 1],
  ] as const)("linearizes MCP cancellation %s", async (stage, expectedClaims, expectedUnknowns) => {
    const command: McpExecuteCommand = {
      argumentsJson: "{}",
      commandId: `cancel-${stage.replace(" ", "-")}`,
      kind: "mcp.execute",
      requestId: "cancel-preparation-request",
      serverId: MCP_PREFLIGHT_SERVER_ID,
      toolCallId: "cancel-preparation-tool",
      toolName: "lookup",
    };
    const boundaryEntered = Promise.withResolvers<void>();
    const releaseBoundary = Promise.withResolvers<void>();

    class CancellationSocket extends EffectLedgerRecordingSocket {
      #blocked = false;

      override async claimExternalToolEffect(
        input: Parameters<FakeDriverRuntimeIo["claimExternalToolEffect"]>[0],
        signal: AbortSignal,
      ): ReturnType<FakeDriverRuntimeIo["claimExternalToolEffect"]> {
        if (stage !== "during claim") {
          return super.claimExternalToolEffect(input, signal);
        }
        this.claimCount += 1;
        boundaryEntered.resolve();
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }

      override async pushEvents(
        input: Parameters<FakeDriverRuntimeIo["pushEvents"]>[0],
      ): ReturnType<FakeDriverRuntimeIo["pushEvents"]> {
        if (stage === "before prepare" && !this.#blocked) {
          this.#blocked = true;
          boundaryEntered.resolve();
          await releaseBoundary.promise;
        }
        return super.pushEvents(input);
      }
    }

    const socket = new CancellationSocket([command]);
    const shutdown = new AbortController();
    let executions = 0;
    let preparations = 0;
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => shutdown.signal.aborted,
      mcpPrepare: async () => {
        preparations += 1;
        if (stage === "during prepare") {
          boundaryEntered.resolve();
          await releaseBoundary.promise;
        }
        return {
          async execute() {
            executions += 1;
            throw new Error("cancelled preparation must not execute");
          },
          async [Symbol.asyncDispose]() {},
        };
      },
      runtimeState: new DriverRuntimeStateMachine("ready"),
      shutdownSignal: shutdown.signal,
    });
    const runTask = runtime.dispatcher.run(socket, runtime.logger);

    await boundaryEntered.promise;
    shutdown.abort(new Error("test cancellation"));
    releaseBoundary.resolve();
    await runTask;
    await runtime.logger.destroy();

    expect(preparations).toBe(stage === "before prepare" ? 0 : 1);
    expect(executions).toBe(0);
    expect(socket.claimCount).toBe(expectedClaims);
    expect(socket.unknownCount).toBe(expectedUnknowns);
    expect(socket.updates).toContainEqual({
      commandId: command.commandId,
      status: "cancelled",
    });
  });

  test("fences an MCP claim when its acknowledgement is lost", async () => {
    const command: McpExecuteCommand = {
      argumentsJson: "{}",
      commandId: "lost-claim-ack",
      kind: "mcp.execute",
      requestId: "lost-claim-request",
      serverId: MCP_PREFLIGHT_SERVER_ID,
      toolCallId: "lost-claim-tool",
      toolName: "lookup",
    };

    class LostClaimSocket extends FakeDriverRuntimeIo {
      fenceSignalAborted: boolean | null = null;
      unknownCount = 0;

      override async claimExternalToolEffect(): ReturnType<
        FakeDriverRuntimeIo["claimExternalToolEffect"]
      > {
        throw new Error("claim acknowledgement lost");
      }

      override async markExternalToolEffectUnknown(
        _input: Parameters<FakeDriverRuntimeIo["markExternalToolEffectUnknown"]>[0],
        signal: AbortSignal,
      ): Promise<void> {
        this.unknownCount += 1;
        this.fenceSignalAborted = signal.aborted;
      }
    }

    const socket = new LostClaimSocket([command]);
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      runtimeState: new DriverRuntimeStateMachine("ready"),
    });

    await runtime.dispatcher.run(socket, runtime.logger);
    await waitForUpdate(
      socket,
      (update) => update.commandId === command.commandId && update.status === "failed",
    );
    await runtime.logger.destroy();

    expect(socket.unknownCount).toBe(1);
    expect(socket.fenceSignalAborted).toBe(false);
  });

  test("fences an in-flight MCP effect after the shutdown signal aborts", async () => {
    const mcpCommand: RuntimeCommand = {
      argumentsJson: '{"title":"cancel safely"}',
      commandId: "cancelled-effect-command",
      kind: "mcp.execute",
      requestId: "cancelled-effect-request",
      serverId: "mcp-linear",
      toolCallId: "tool-cancelled-effect",
      toolName: "createIssue",
    };
    const mcpStarted = Promise.withResolvers<void>();

    class CancellationSocket extends FakeDriverRuntimeIo {
      readonly #nextCommand = Promise.withResolvers<RuntimeCommand | null>();
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

      stop(): void {
        this.#drained = true;
        this.#nextCommand.resolve(null);
      }
    }

    const socket = new CancellationSocket();
    const shutdown = new AbortController();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async (_command, signal) => {
        mcpStarted.resolve();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      runtimeState,
      shutdownSignal: shutdown.signal,
    });
    const runTask = runtime.dispatcher.run(socket, runtime.logger);

    await mcpStarted.promise;
    runtimeState.enter("stopping");
    socket.stop();
    shutdown.abort(new Error("test shutdown"));
    await runTask;
    await runtime.logger.destroy();

    expect(socket.fenceSignalAborted).toBe(false);
    expect(socket.fencedCommandId).toBe(mcpCommand.commandId);
    expect(socket.updates).toMatchObject([
      { commandId: mcpCommand.commandId, status: "accepted" },
      { commandId: mcpCommand.commandId, status: "cancelled" },
    ]);
  });

  test("persists a known MCP result after shutdown with a fresh retry budget", async () => {
    const command: McpExecuteCommand = {
      argumentsJson: "{}",
      commandId: "known-result-during-shutdown",
      kind: "mcp.execute",
      requestId: "known-result-request",
      serverId: MCP_PREFLIGHT_SERVER_ID,
      toolCallId: "known-result-tool",
      toolName: "lookup",
    };
    const providerStarted = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();

    class CompletionSocket extends FakeDriverRuntimeIo {
      readonly #nextCommand = Promise.withResolvers<RuntimeCommand | null>();
      #readFirstCommand = true;
      #drained = false;
      completionAttempts = 0;
      readonly completionSignals: boolean[] = [];
      unknownCount = 0;

      constructor() {
        super([]);
      }

      override isDrained(): boolean {
        return this.#drained;
      }

      override nextCommand(_signal: AbortSignal): Promise<RuntimeCommand | null> {
        if (this.#readFirstCommand) {
          this.#readFirstCommand = false;
          return Promise.resolve(command);
        }

        return this.#nextCommand.promise;
      }

      override async completeExternalToolEffect(
        _input: Parameters<FakeDriverRuntimeIo["completeExternalToolEffect"]>[0],
        signal: AbortSignal,
      ): Promise<void> {
        this.completionAttempts += 1;
        this.completionSignals.push(signal.aborted);
        if (this.completionAttempts === 1) {
          throw new Error("completion acknowledgement lost");
        }
      }

      override async markExternalToolEffectUnknown(): Promise<void> {
        this.unknownCount += 1;
      }

      stop(): void {
        this.#drained = true;
        this.#nextCommand.resolve(null);
      }
    }

    const socket = new CompletionSocket();
    const shutdown = new AbortController();
    const runtimeState = new DriverRuntimeStateMachine("ready");
    const runtime = createDispatcher({
      backend: createBackend(),
      isShuttingDown: () => socket.isDrained(),
      mcpExecute: async (input) => {
        providerStarted.resolve();
        await releaseProvider.promise;
        return {
          outputText: "known result",
          requestId: input.requestId,
          serverId: input.serverId,
          toolName: input.toolName,
        };
      },
      runtimeState,
      shutdownSignal: shutdown.signal,
    });
    const runTask = runtime.dispatcher.run(socket, runtime.logger);

    await providerStarted.promise;
    runtimeState.enter("stopping");
    socket.stop();
    shutdown.abort(new Error("test shutdown"));
    releaseProvider.resolve();
    await runTask;
    await runtime.logger.destroy();

    expect(socket.completionAttempts).toBe(2);
    expect(socket.completionSignals).toEqual([false, false]);
    expect(socket.unknownCount).toBe(0);
    expect(socket.updates).toMatchObject([
      { commandId: command.commandId, status: "accepted" },
      {
        commandId: command.commandId,
        result: {
          outputText: "known result",
          requestId: command.requestId,
          serverId: command.serverId,
          toolName: command.toolName,
        },
        status: "completed",
      },
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
