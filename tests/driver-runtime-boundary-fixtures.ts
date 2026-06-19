import { DriverCommandDispatcher } from "../src/core/driver-command-dispatcher";
import { DriverPermissionBroker } from "../src/core/driver-permission-broker";
import type { DriverRuntimeIo } from "../src/core/driver-runtime-io";
import type { DriverRuntimeStateMachine } from "../src/core/driver-runtime-state";
import { createBufferedSinkLogger } from "../src/observability";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import type { RuntimeCommand } from "../src/runtime-command";
import type { AgentDriverBackend, AgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
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

  async nextCommand(): Promise<RuntimeCommand | null> {
    const command = this.#commands[this.#commandIndex] ?? null;

    if (command !== null) {
      this.#commandIndex += 1;
    }

    return command;
  }

  isDrained(): boolean {
    return this.#commandIndex >= this.#commands.length;
  }

  async commandUpdate(input: Parameters<DriverRuntimeIo["commandUpdate"]>[0]): Promise<void> {
    this.updates.push(input);
  }

  async completeRun(): Promise<void> {
    this.completedRunReasons.push("completed");
  }

  async failRun(error: Parameters<DriverRuntimeIo["failRun"]>[0]): Promise<void> {
    this.failedRuns.push(error);
  }

  async pushEvents(input: Parameters<DriverRuntimeIo["pushEvents"]>[0]): Promise<void> {
    this.pushedEvents.push(input);
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
    async handleMcpExecute(_context, command) {
      return {
        outputText: `ran ${command.toolName}`,
        requestId: command.requestId,
        serverId: command.serverId,
        toolName: command.toolName,
      };
    },
    async start() {},
    async stop() {},
  };
}

export function createDispatcher(input: {
  backend: AgentDriverBackend;
  isShuttingDown?: () => boolean;
  runtimeState: DriverRuntimeStateMachine;
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
  const permissions = new DriverPermissionBroker(() => logger);
  const shutdownCalls: string[] = [];
  const dispatcher = new DriverCommandDispatcher({
    backend: input.backend,
    driverInstanceId: DRIVER_TEST_IDS.driverInstanceId,
    isShuttingDown: input.isShuttingDown ?? (() => false),
    permissionRequests: permissions,
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
            nextCommand: async () => {
              commandReads.count += 1;
              return socket.nextCommand();
            },
          },
          mcp: {
            execute: async (command) => ({
              outputText: `ran ${command.toolName}`,
              requestId: command.requestId,
              serverId: command.serverId,
              toolName: command.toolName,
            }),
          },
        },
      }),
    runtimeState: input.runtimeState,
    sandboxId: DRIVER_TEST_IDS.sandboxId,
    shutdown:
      input.shutdown ??
      (async (_socket, reason) => {
        shutdownCalls.push(reason);
      }),
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
