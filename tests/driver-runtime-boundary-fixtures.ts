import type { AgentDriverBackend, AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { DriverCommandDispatcher } from "../src/core/driver-command-dispatcher";
import { DriverPermissionBroker } from "../src/core/driver-permission-broker";
import type { DriverRuntimeIo } from "../src/core/driver-runtime-io";
import type { DriverRuntimeStateMachine } from "../src/core/driver-runtime-state";
import type { AgentDriverMcpPort } from "../src/host-ports";
import { createBufferedSinkLogger } from "../src/observability";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import type { RuntimeCommand } from "../src/runtime-command";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

export { DRIVER_TEST_IDS };

export const bootPayload = createDriverStartInputFromBootPayload(driverBootPayload);

export class FakeDriverRuntimeIo implements DriverRuntimeIo {
  readonly completedRunReasons: string[] = [];
  readonly failedRuns: Parameters<DriverRuntimeIo["failRun"]>[0][] = [];
  readonly pushedEvents: Parameters<DriverRuntimeIo["pushEvents"]>[0][] = [];
  readonly updates: Parameters<DriverRuntimeIo["commandUpdate"]>[0][] = [];
  readonly #commands: readonly RuntimeCommand[];
  #commandIndex = 0;

  constructor(commands: readonly RuntimeCommand[]) {
    this.#commands = commands;
  }

  beginRun(): void {
    return;
  }

  endRun(): void {
    return;
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
      kind: "execute",
    };
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
    this.completedRunReasons.push("completed");
  }

  async completeExternalToolEffect(
    _input: Parameters<DriverRuntimeIo["completeExternalToolEffect"]>[0],
    _signal: AbortSignal,
  ): Promise<void> {
    return;
  }

  async failRun(
    error: Parameters<DriverRuntimeIo["failRun"]>[0],
    _signal?: AbortSignal,
  ): Promise<void> {
    this.failedRuns.push(error);
  }

  async pushEvents(
    input: Parameters<DriverRuntimeIo["pushEvents"]>[0],
  ): ReturnType<DriverRuntimeIo["pushEvents"]> {
    this.pushedEvents.push(input);
    return {
      accepted: input.events.map((event, index) => ({
        seq: index + 1,
        type: event.kind,
      })),
    };
  }

  async markExternalToolEffectUnknown(
    _input: Parameters<DriverRuntimeIo["markExternalToolEffectUnknown"]>[0],
    _signal: AbortSignal,
  ): Promise<void> {
    return;
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
    async handleInput(context) {
      if (this.failInput) {
        throw new Error("backend rejected input");
      }

      this.handledInputs.push(context.payload.execution.session);
    },
    async start(_context, signal) {
      signal.throwIfAborted();
    },
    async stop(_context, _reason, signal) {
      signal.throwIfAborted();
    },
  };
}

export function createDispatcher(input: {
  backend: AgentDriverBackend;
  isShuttingDown?: () => boolean;
  mcpExecute?: AgentDriverMcpPort["execute"];
  permissionRequests?: DriverPermissionBroker;
  rememberRunFailure?: (error: Parameters<DriverRuntimeIo["failRun"]>[0]) => void;
  runtimeState: DriverRuntimeStateMachine;
  shutdownSignal?: AbortSignal;
  shutdown?: (socket: DriverRuntimeIo, reason: string) => Promise<void>;
}) {
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "driver-runtime-boundary-test",
    sink: async () => {},
  });
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
          request: async () => "reject_once",
        },
        ports: {
          commandSource: {
            nextCommand: async (signal) => {
              commandReads.count += 1;
              return socket.nextCommand(signal);
            },
          },
          mcp: {
            execute:
              input.mcpExecute ??
              (async (command) => ({
                outputText: `ran ${command.toolName}`,
                requestId: command.requestId,
                serverId: command.serverId,
                toolName: command.toolName,
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
