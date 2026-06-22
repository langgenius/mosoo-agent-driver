import { createBufferedSinkLogger } from "../observability";
import type { Logger } from "../observability";
import type { DriverEventInput } from "../protocol/events";
import type { DriverEventBatchOutput } from "../protocol/orpc";
import type { DriverStartInput } from "../protocol/start";
import type { RunError, RuntimeCommand, RuntimeCommandResult } from "../runtime-command";
import type {
  AgentDriverBackend,
  AgentDriverBackendFactory,
  AgentDriverContext,
  AgentDriverContextPortOverrides,
} from "../runtimes/agent-driver-backend";
import { createAgentDriverContext } from "../runtimes/agent-driver-backend";
import { createPromiseDeferred } from "../utils/async";
import type { PromiseDeferred } from "../utils/async";
import { DriverCommandDispatcher } from "./driver-command-dispatcher";
import { DriverPermissionBroker } from "./driver-permission-broker";
import type { DriverRuntimeIo } from "./driver-runtime-io";
import { DriverRuntimeStateMachine } from "./driver-runtime-state";

export type AgentDriverKernelStartInput = DriverStartInput;
export type AgentDriverRuntimeEvent = DriverEventInput;

export interface AgentDriverKernel {
  cancel(reason: string): Promise<void>;
  dispatch(command: RuntimeCommand): Promise<RuntimeCommandResult | void>;
  events(): AsyncIterable<AgentDriverRuntimeEvent>;
  start(input: AgentDriverKernelStartInput): Promise<void>;
  stop(reason: string): Promise<void>;
}

export interface AgentDriverKernelOptions {
  readonly backendFactory: AgentDriverBackendFactory;
  readonly hostPorts?: AgentDriverContextPortOverrides;
  readonly logger?: Logger;
}

type KernelCommandResult = RuntimeCommandResult | void;

class AsyncValueQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: PromiseDeferred<IteratorResult<T>>[] = [];
  #closed = false;

  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({
        done: true,
        value: undefined,
      });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();

    if (value !== undefined) {
      return Promise.resolve({
        done: false,
        value,
      });
    }

    if (this.#closed) {
      return Promise.resolve({
        done: true,
        value: undefined,
      });
    }

    const waiter = createPromiseDeferred<IteratorResult<T>>();
    this.#waiters.push(waiter);
    return waiter.promise;
  }

  push(value: T): void {
    if (this.#closed) {
      throw new Error("Driver kernel queue is closed.");
    }

    const waiter = this.#waiters.shift();

    if (waiter) {
      waiter.resolve({
        done: false,
        value,
      });
      return;
    }

    this.#values.push(value);
  }

  async *values(): AsyncIterable<T> {
    while (true) {
      const result = await this.next();

      if (result.done) {
        return;
      }

      yield result.value;
    }
  }
}

function createKernelLogger(): Logger {
  return createBufferedSinkLogger({
    level: "debug",
    service: "agent-driver-kernel",
    sink: async () => {},
  });
}

function toDispatchError(error: RunError | undefined, command: RuntimeCommand): Error {
  if (!error) {
    return new Error(`Driver command ${command.kind} failed.`);
  }

  const dispatchError = new Error(error.message);
  dispatchError.name = error.code;
  return dispatchError;
}

export class AgentDriverKernelCore implements AgentDriverKernel, DriverRuntimeIo {
  readonly #backendFactory: AgentDriverBackendFactory;
  readonly #commandsById = new Map<string, RuntimeCommand>();
  readonly #commandResults = new Map<string, PromiseDeferred<KernelCommandResult>>();
  readonly #commands = new AsyncValueQueue<RuntimeCommand>();
  readonly #events = new AsyncValueQueue<AgentDriverRuntimeEvent>();
  readonly #hostPorts: AgentDriverContextPortOverrides | undefined;
  readonly #logger: Logger;
  readonly #permissionBroker: DriverPermissionBroker;
  readonly #runtimeState = new DriverRuntimeStateMachine();
  #backend: AgentDriverBackend | null = null;
  #payload: DriverStartInput | null = null;
  #pushedEventSeq = 0;
  #runTask: Promise<void> | null = null;
  #shuttingDown = false;
  #started = false;

  constructor(options: AgentDriverKernelOptions) {
    this.#backendFactory = options.backendFactory;
    this.#hostPorts = options.hostPorts;
    this.#logger = options.logger ?? createKernelLogger();
    this.#permissionBroker = new DriverPermissionBroker(() => this.#logger);
  }

  beginRun(): void {
    return;
  }

  async cancel(reason: string): Promise<void> {
    await this.dispatch({
      commandId: `kernel-cancel-${Date.now()}`,
      kind: "turn.cancel",
      reason,
    });
  }

  async commandUpdate(input: {
    commandId: string;
    error?: RunError;
    result?: RuntimeCommandResult;
    status: "accepted" | "cancelled" | "completed" | "failed";
  }): Promise<void> {
    if (input.status === "accepted") {
      return;
    }

    const result = this.#commandResults.get(input.commandId);
    const command = this.#commandsById.get(input.commandId);

    if (!result || !command) {
      return;
    }

    this.#commandsById.delete(input.commandId);
    this.#commandResults.delete(input.commandId);

    if (input.status === "failed") {
      result.reject(toDispatchError(input.error, command));
      return;
    }

    result.resolve(input.result ?? undefined);
  }

  async completeRun(): Promise<void> {
    this.#events.push({
      kind: "run.completed",
      payload: {
        stopReason: "end_turn",
      },
    });
  }

  async dispatch(command: RuntimeCommand): Promise<KernelCommandResult> {
    this.#ensureStarted();

    if (this.#commandResults.has(command.commandId)) {
      throw new Error(`Driver command ${command.commandId} is already pending.`);
    }

    const result = createPromiseDeferred<KernelCommandResult>();
    this.#commandsById.set(command.commandId, command);
    this.#commandResults.set(command.commandId, result);
    this.#commands.push(command);
    return result.promise;
  }

  endRun(): void {
    return;
  }

  events(): AsyncIterable<AgentDriverRuntimeEvent> {
    return this.#events.values();
  }

  async failRun(error: RunError): Promise<void> {
    this.#events.push({
      kind: "run.failed",
      payload: {
        error,
        recoverable: false,
      },
    });
  }

  async heartbeat(
    _input: Parameters<DriverRuntimeIo["heartbeat"]>[0],
  ): ReturnType<DriverRuntimeIo["heartbeat"]> {
    return {
      heartbeatCount: 1,
      ok: true as const,
    };
  }

  async nextCommand(): Promise<RuntimeCommand | null> {
    const result = await this.#commands.next();
    return result.done ? null : result.value;
  }

  async pushEvents(input: { events: DriverEventInput[] }): Promise<DriverEventBatchOutput> {
    const accepted = input.events.map((event) => {
      this.#pushedEventSeq += 1;

      return {
        seq: this.#pushedEventSeq,
        type: event.kind,
      };
    });

    for (const event of input.events) {
      this.#events.push(event);
    }

    return { accepted };
  }

  async start(input: AgentDriverKernelStartInput): Promise<void> {
    if (this.#started) {
      throw new Error("Driver kernel has already started.");
    }

    this.#started = true;
    this.#payload = input;
    const backend = await this.#backendFactory(input);
    this.#backend = backend;
    const context = this.#createContext(input);
    await backend.start(context);

    const dispatcher = new DriverCommandDispatcher({
      backend,
      driverInstanceId: input.driverInstanceId,
      isShuttingDown: () => this.#shuttingDown,
      permissionRequests: this.#permissionBroker,
      runtimeContextFactory: () => context,
      runtimeState: this.#runtimeState,
      sandboxId: input.sandboxId,
      shutdown: async (_runtimeIo, reason) => this.#shutdown(reason),
    });

    this.#runTask = dispatcher.run(this, this.#logger).catch((error: unknown) => {
      this.#rejectPendingCommands(error);
      throw error;
    });
  }

  async stop(reason: string): Promise<void> {
    if (!this.#started || this.#shuttingDown) {
      return;
    }

    await this.dispatch({
      commandId: `kernel-stop-${Date.now()}`,
      kind: "session.stop",
      reason,
    });
    await this.#runTask;
  }

  #createContext(payload: DriverStartInput): AgentDriverContext {
    return createAgentDriverContext({
      eventSink: this,
      ...(this.#hostPorts === undefined ? {} : { ports: this.#hostPorts }),
      payload,
      logger: this.#logger,
      permission: {
        request: async (input) => {
          this.#runtimeState.enter("needs_approval");

          try {
            return await this.#permissionBroker.request(this, input);
          } finally {
            if (this.#runtimeState.status() === "needs_approval") {
              this.#runtimeState.enter("running");
            }
          }
        },
      },
    });
  }

  #ensureStarted(): void {
    if (!this.#started) {
      throw new Error("Driver kernel has not started.");
    }

    if (this.#shuttingDown) {
      throw new Error("Driver kernel is shutting down.");
    }
  }

  #rejectPendingCommands(error: unknown): void {
    for (const result of this.#commandResults.values()) {
      result.reject(error);
    }

    this.#commandResults.clear();
    this.#commandsById.clear();
  }

  async #shutdown(reason: string): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }

    this.#shuttingDown = true;
    this.#commands.close();
    this.#permissionBroker.rejectAll();

    if (this.#runtimeState.status() !== "failed" && this.#runtimeState.status() !== "stopped") {
      this.#runtimeState.enter("stopped");
    }

    if (this.#backend && this.#payload) {
      await this.#backend.stop(this.#createContext(this.#payload), reason);
    }

    this.#events.close();
  }
}
