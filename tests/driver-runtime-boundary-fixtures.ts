import type { AgentDriverBackend, AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { DriverCommandDispatcher } from "../src/core/driver-command-dispatcher";
import { DriverPermissionBroker } from "../src/core/driver-permission-broker";
import {
  assertIsolatedRunTerminalBatch,
  withSourceEventIds,
  type DriverRuntimeIo,
} from "../src/core/driver-runtime-io";
import type { DriverRunTerminalBarrier } from "../src/core/driver-runtime-io";
import type { DriverRuntimeStateMachine } from "../src/core/driver-runtime-state";
import {
  DriverTerminalStateMachine,
  type DriverRunTicket,
} from "../src/core/driver-terminal-state";
import type { AgentDriverMcpPort } from "../src/host-ports";
import { createDisabledLogger } from "../src/observability";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import type { RunId } from "../src/protocol/id";
import type {
  McpExecuteCommand,
  McpExternalToolEffectExecution,
  McpExternalToolExecutionResult,
  RuntimeCommand,
} from "../src/runtime-command";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

export { DRIVER_TEST_IDS };

export const bootPayload = createDriverStartInputFromBootPayload(driverBootPayload);

export class FakeDriverRuntimeIo implements DriverRuntimeIo {
  readonly completedRunReasons: string[] = [];
  readonly failedRuns: Parameters<DriverRuntimeIo["failRun"]>[0][] = [];
  readonly pushedEvents: Parameters<DriverRuntimeIo["pushEvents"]>[0][] = [];
  readonly updates: Parameters<DriverRuntimeIo["commandUpdate"]>[0][] = [];
  readonly #commands: readonly RuntimeCommand[];
  #activeRunTicket: DriverRunTicket | null = null;
  #commandIndex = 0;
  #runTerminalBarrier: DriverRunTerminalBarrier | null = null;
  readonly #terminalState = new DriverTerminalStateMachine();

  constructor(commands: readonly RuntimeCommand[], activeRunId?: RunId) {
    this.#commands = commands;
    if (activeRunId !== undefined) {
      this.beginRun(activeRunId);
    }
  }

  beginRun(runId: Parameters<DriverRuntimeIo["beginRun"]>[0]): DriverRunTicket {
    const ticket = this.#terminalState.beginRun(runId);
    this.#activeRunTicket = ticket;
    return ticket;
  }

  claimRunCancellation(
    ticket: DriverRunTicket,
    reason: string,
  ): ReturnType<DriverRuntimeIo["claimRunCancellation"]> {
    return this.#terminalState.claimCancellation(ticket, reason);
  }

  currentRunId(): ReturnType<DriverRuntimeIo["currentRunId"]> {
    return this.#terminalState.currentRunId();
  }

  releaseRun(ticket: DriverRunTicket, reason: "command_acked" | "driver_failing"): void {
    this.#terminalState.releaseRun(ticket, reason);
    if (this.#activeRunTicket === ticket) {
      this.#activeRunTicket = null;
    }
  }

  runSnapshot(runId?: Parameters<DriverRuntimeIo["runSnapshot"]>[0]) {
    return this.#terminalState.snapshotRun(runId);
  }

  settleRunInput(
    ticket: DriverRunTicket,
    outcome: Parameters<DriverRuntimeIo["settleRunInput"]>[1],
  ): ReturnType<DriverRuntimeIo["settleRunInput"]> {
    return this.#terminalState.settleInput(ticket, outcome);
  }

  async heartbeat(): ReturnType<DriverRuntimeIo["heartbeat"]> {
    return {
      heartbeatCount: 1,
      ok: true as const,
    };
  }

  async nextCommand(_signal: AbortSignal): Promise<RuntimeCommand | null> {
    const command = this.#commands[this.#commandIndex] ?? null;

    if (command !== null) {
      this.#commandIndex += 1;
    }

    return command;
  }

  async claimExternalToolEffect(
    input: Parameters<DriverRuntimeIo["claimExternalToolEffect"]>[0],
    _signal: AbortSignal,
  ): ReturnType<DriverRuntimeIo["claimExternalToolEffect"]> {
    return {
      attempt: 1,
      effectId: `test-effect-${input.commandId}`,
      idempotencyKey: `test-effect-${input.commandId}`,
      kind: "claimed",
    };
  }

  async observeExternalToolEffect(
    input: Parameters<DriverRuntimeIo["observeExternalToolEffect"]>[0],
    _signal: AbortSignal,
  ): ReturnType<DriverRuntimeIo["observeExternalToolEffect"]> {
    return { effectId: `test-effect-${input.commandId}`, kind: "intent" };
  }

  isDrained(): boolean {
    return this.#commandIndex >= this.#commands.length;
  }

  async commandUpdate(
    input: Parameters<DriverRuntimeIo["commandUpdate"]>[0],
    _signal: AbortSignal,
  ): Promise<void> {
    this.updates.push(input);
  }

  async completeRun(_signal?: AbortSignal): Promise<void> {
    const runId = this.#terminalState.terminalRunId(DRIVER_TEST_IDS.runId);
    if (runId === null) {
      throw new Error("Driver run terminal requires an exact run ID.");
    }
    const terminal = { runId, status: "completed" } as const;
    if (this.#terminalState.selectInstanceTerminal(terminal) === "acked") {
      return;
    }
    this.completedRunReasons.push("completed");
    this.#terminalState.ackInstanceTerminal(terminal);
  }

  async settleExternalToolEffect(
    input: Parameters<DriverRuntimeIo["settleExternalToolEffect"]>[0],
    _signal: AbortSignal,
  ): ReturnType<DriverRuntimeIo["settleExternalToolEffect"]> {
    return input.settlement.kind === "succeeded"
      ? {
          effectId: input.effectId,
          kind: "succeeded",
          result: structuredClone(input.settlement.result),
        }
      : { effectId: input.effectId, kind: "unknown" };
  }

  async failRun(
    error: Parameters<DriverRuntimeIo["failRun"]>[0],
    _signal?: AbortSignal,
  ): Promise<void> {
    const runId = this.#terminalState.terminalRunId(DRIVER_TEST_IDS.runId);
    if (runId === null) {
      throw new Error("Driver run terminal requires an exact run ID.");
    }
    const terminal = { error, runId, status: "failed" } as const;
    if (this.#terminalState.selectInstanceTerminal(terminal) === "acked") {
      return;
    }
    this.failedRuns.push(error);
    this.#terminalState.ackInstanceTerminal(terminal);
  }

  async pushEvents(
    input: Parameters<DriverRuntimeIo["pushEvents"]>[0],
  ): ReturnType<DriverRuntimeIo["pushEvents"]> {
    input.signal?.throwIfAborted();
    const events = structuredClone(withSourceEventIds(input.events));
    assertIsolatedRunTerminalBatch(events);
    const barrier = this.#runTerminalBarrier;
    if (barrier !== null) {
      const pending = barrier(events);
      if (pending !== undefined) {
        await pending;
      }
    }
    this.pushedEvents.push({ ...input, events });
    const ticket = this.#activeRunTicket;
    const terminalEvent = events.find(
      (event) =>
        event.kind === "run.cancelled" ||
        event.kind === "run.completed" ||
        event.kind === "run.failed",
    );
    if (terminalEvent !== undefined && ticket !== null) {
      const status = terminalEvent.kind.slice("run.".length) as
        | "cancelled"
        | "completed"
        | "failed";
      const selected = this.#terminalState.selectRunTerminal(ticket, {
        event: terminalEvent,
        runId: ticket.runId,
        sourceEventId: terminalEvent.sourceEventId!,
        status,
      });
      if (selected === "cancelled") {
        throw new Error("Driver completed terminal lost the cancellation race.");
      }
    }
    const accepted = events.map((event, index) => ({
      eventId: event.sourceEventId!,
      seq: index + 1,
      type: event.kind,
    }));
    if (terminalEvent !== undefined && ticket !== null) {
      this.#terminalState.ackRunTerminal(ticket, accepted.at(-1)!);
    }
    return {
      accepted,
    };
  }

  registerRunTerminalBarrier(barrier: DriverRunTerminalBarrier): () => void {
    if (this.#runTerminalBarrier !== null) {
      throw new Error("Driver run terminal barrier is already registered.");
    }

    this.#runTerminalBarrier = barrier;
    return () => {
      if (this.#runTerminalBarrier === barrier) {
        this.#runTerminalBarrier = null;
      }
    };
  }
}

export interface RecordingBackend extends AgentDriverBackend {
  readonly cancelledReasons: string[];
  readonly handledInputs: AgentDriverContext["payload"]["execution"]["session"][];
  failInput: boolean;
}

export function createBackend(): RecordingBackend {
  return {
    cancelledReasons: [],
    failInput: false,
    handledInputs: [],
    runtime: "openai-runtime",
    async cancelActiveTurn(_context, reason) {
      this.cancelledReasons.push(reason);
    },
    async handleInput(context, _input, runId) {
      if (this.failInput) {
        throw new Error("backend rejected input");
      }

      this.handledInputs.push(context.payload.execution.session);
      await context.ports.eventSink.pushEvents({
        events: [
          {
            kind: "run.completed",
            payload: { status: "completed" },
            runId,
            sourceEventId: `test.run.completed:${runId}`,
          },
        ],
      });
    },
    async start(_context, signal) {
      signal.throwIfAborted();
    },
    async stop(_context, _reason, signal) {
      signal.throwIfAborted();
    },
  };
}

export async function settleBackendInput(
  context: AgentDriverContext,
  runId: RunId,
  signal?: AbortSignal,
): Promise<void> {
  const status = signal?.aborted ? "cancelled" : "completed";
  await context.ports.eventSink.pushEvents({
    events: [
      {
        kind: `run.${status}`,
        payload: { status },
        runId,
        sourceEventId: `test.run.${status}:${runId}`,
      },
    ],
  });
  signal?.throwIfAborted();
}

export function createDispatcher(input: {
  backend: AgentDriverBackend;
  isShuttingDown?: () => boolean;
  mcpExecute?: (
    command: McpExecuteCommand,
    effect: McpExternalToolEffectExecution,
  ) => Promise<McpExternalToolExecutionResult>;
  mcpPrepare?: AgentDriverMcpPort["prepare"];
  permissionRequest?: AgentDriverContext["ports"]["permission"]["request"];
  permissionRequests?: DriverPermissionBroker;
  rememberRunFailure?: (error: Parameters<DriverRuntimeIo["failRun"]>[0]) => void;
  runtimeState: DriverRuntimeStateMachine;
  shutdownSignal?: AbortSignal;
  shutdown?: (socket: DriverRuntimeIo, reason: string) => Promise<void>;
}) {
  const logger = createDisabledLogger();
  const commandReads = {
    count: 0,
  };
  const permissions = input.permissionRequests ?? new DriverPermissionBroker(() => logger);
  let pendingRunFailure: Parameters<DriverRuntimeIo["failRun"]>[0] | null = null;
  let runFailureDelivered = false;
  const shutdownCalls: string[] = [];
  const dispatcher = new DriverCommandDispatcher({
    backend: input.backend,
    driverInstanceId: DRIVER_TEST_IDS.driverInstanceId,
    isShuttingDown: input.isShuttingDown ?? (() => false),
    permissionRequests: permissions,
    rememberRunFailure: (error) => {
      if (input.rememberRunFailure !== undefined) {
        input.rememberRunFailure(error);
        return;
      }
      pendingRunFailure ??= structuredClone(error);
    },
    runtimeContextFactory: (socket, runtimeLogger) =>
      createAgentDriverContext({
        eventSink: socket,
        logger: runtimeLogger,
        payload: bootPayload,
        permission: {
          request: input.permissionRequest ?? (async () => "reject_once"),
        },
        ports: {
          commandSource: {
            nextCommand: async (signal) => {
              commandReads.count += 1;
              return socket.nextCommand(signal);
            },
          },
          mcp: {
            prepare:
              input.mcpPrepare ??
              (async (command) => ({
                execute: (effect) =>
                  (
                    input.mcpExecute ??
                    (async () => ({
                      outputText: `ran ${command.toolName}`,
                      requestId: command.requestId,
                      serverId: command.serverId,
                      toolName: command.toolName,
                    }))
                  )(command, effect),
                async [Symbol.asyncDispose]() {},
              })),
          },
        },
      }),
    runtimeState: input.runtimeState,
    sandboxId: DRIVER_TEST_IDS.sandboxId,
    shutdownSignal: input.shutdownSignal ?? new AbortController().signal,
    shutdown: async (socket, reason) => {
      if (input.shutdown === undefined) {
        shutdownCalls.push(reason);
      } else {
        await input.shutdown(socket, reason);
      }
      if (pendingRunFailure !== null && !runFailureDelivered) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await socket.failRun(pendingRunFailure);
            runFailureDelivered = true;
            break;
          } catch {
            /* The owner retries control delivery without reopening the cleanup barrier. */
          }
        }
      }
    },
  });

  return {
    commandReads,
    dispatcher,
    logger,
    shutdownCalls,
  };
}

export async function waitForUpdate(
  socket: FakeDriverRuntimeIo,
  predicate: (update: Parameters<DriverRuntimeIo["commandUpdate"]>[0]) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (socket.updates.some(predicate)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for command update.");
}
