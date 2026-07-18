import { createBufferedSinkLogger } from "../observability";
import type { Logger } from "../observability";
import type { DriverEventInput } from "../protocol/events";
import { createDriverId, type RunId } from "../protocol/id";
import type { DriverEventBatchOutput } from "../protocol/orpc";
import type { DriverStartInput } from "../protocol/start";
import { parseRuntimeCommand } from "../runtime-command";
import type { RunError, RuntimeCommand, RuntimeCommandResult } from "../runtime-command";
import type {
  AgentDriverBackend,
  AgentDriverBackendFactory,
  AgentDriverContext,
  AgentDriverContextPortOverrides,
} from "../runtimes/agent-driver-backend";
import { createAgentDriverContext } from "../runtimes/agent-driver-backend";
import { promiseWithTimeout } from "../utils/async";
import { DriverCommandDispatcher } from "./driver-command-dispatcher";
import { DriverPermissionBroker } from "./driver-permission-broker";
import { createDriverPermissionRequestHandler } from "./driver-permission-policy";
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

const KERNEL_SHUTDOWN_TIMEOUT_MS = 5_000;
const KERNEL_START_TIMEOUT_MS = 60_000;
const KERNEL_QUEUE_MAX_SIZE = 1_024;
const KERNEL_QUEUE_MAX_BYTES = 32 * 1_024 * 1_024;
const KERNEL_TERMINAL_QUEUE_MAX_SIZE = 1;
const KERNEL_TERMINAL_QUEUE_MAX_BYTES = 1_024 * 1_024;

export interface AsyncValueQueueReserve {
  readonly maxBytes: number;
  readonly maxSize: number;
}

interface BufferedValue<T> {
  readonly bytes: number;
  readonly reserved: boolean;
  readonly value: T;
}

export class AsyncValueQueue<T> {
  readonly #label: string;
  readonly #maxBytes: number;
  readonly #maxSize: number;
  readonly #measure: (value: T) => number;
  readonly #reserve: AsyncValueQueueReserve | undefined;
  readonly #values: BufferedValue<T>[] = [];
  readonly #waiters: PromiseWithResolvers<IteratorResult<T>>[] = [];
  #bytes = 0;
  #closed = false;
  #reservedBytes = 0;
  #reservedSize = 0;
  #size = 0;

  constructor(
    label: string,
    maxSize: number,
    maxBytes = Number.POSITIVE_INFINITY,
    measure: (value: T) => number = () => 0,
    reserve?: AsyncValueQueueReserve,
  ) {
    this.#label = label;
    this.#maxBytes = maxBytes;
    this.#maxSize = maxSize;
    this.#measure = measure;
    this.#reserve = reserve;
  }

  close(options: { readonly discard?: boolean } = {}): void {
    if (options.discard) {
      this.#values.length = 0;
      this.#bytes = 0;
      this.#reservedBytes = 0;
      this.#reservedSize = 0;
      this.#size = 0;
    }

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
    const buffered = this.#values.shift();

    if (buffered !== undefined) {
      if (buffered.reserved) {
        this.#reservedBytes -= buffered.bytes;
        this.#reservedSize -= 1;
      } else {
        this.#bytes -= buffered.bytes;
        this.#size -= 1;
      }
      return Promise.resolve({
        done: false,
        value: buffered.value,
      });
    }

    if (this.#closed) {
      return Promise.resolve({
        done: true,
        value: undefined,
      });
    }

    const waiter = Promise.withResolvers<IteratorResult<T>>();
    this.#waiters.push(waiter);
    return waiter.promise;
  }

  push(value: T): void {
    this.pushMany([value]);
  }

  pushReserved(value: T): void {
    if (this.#closed) {
      throw new Error("Driver kernel queue is closed.");
    }
    if (this.#reserve === undefined) {
      throw new Error(`Driver kernel ${this.#label} queue has no reserve.`);
    }

    const buffered = this.#buffer(value, true);
    if (buffered.bytes > this.#reserve.maxBytes) {
      throw new Error(
        `Driver kernel ${this.#label} queue reserve exceeds ${this.#reserve.maxBytes} UTF-8 JSON bytes.`,
      );
    }

    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }

    if (this.#reservedSize >= this.#reserve.maxSize) {
      throw new Error(
        `Driver kernel ${this.#label} queue reserve exceeds ${this.#reserve.maxSize} items.`,
      );
    }
    if (buffered.bytes > this.#reserve.maxBytes - this.#reservedBytes) {
      throw new Error(
        `Driver kernel ${this.#label} queue reserve exceeds ${this.#reserve.maxBytes} UTF-8 JSON bytes.`,
      );
    }

    this.#values.push(buffered);
    this.#reservedBytes += buffered.bytes;
    this.#reservedSize += 1;
  }

  pushMany(values: readonly T[]): void {
    if (this.#closed) {
      throw new Error("Driver kernel queue is closed.");
    }

    const directCount = Math.min(values.length, this.#waiters.length);
    const buffered = values.slice(directCount).map((value) => this.#buffer(value));

    if (this.#size + buffered.length > this.#maxSize) {
      throw new Error(`Driver kernel ${this.#label} queue exceeds ${this.#maxSize} items.`);
    }
    const addedBytes = buffered.reduce((sum, entry) => sum + entry.bytes, 0);
    if (addedBytes > this.#maxBytes - this.#bytes) {
      throw new Error(
        `Driver kernel ${this.#label} queue exceeds ${this.#maxBytes} UTF-8 JSON bytes.`,
      );
    }

    for (const value of values.slice(0, directCount)) {
      const waiter = this.#waiters.shift();
      waiter?.resolve({ done: false, value });
    }
    this.#values.push(...buffered);
    this.#bytes += addedBytes;
    this.#size += buffered.length;
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

  #buffer(value: T, reserved = false): BufferedValue<T> {
    const bytes = this.#measure(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError(`Driver kernel ${this.#label} queue measured invalid bytes.`);
    }
    return { bytes, reserved, value };
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
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
  readonly #commandResults = new Map<string, PromiseWithResolvers<KernelCommandResult>>();
  readonly #commands = new AsyncValueQueue<RuntimeCommand>(
    "command",
    KERNEL_QUEUE_MAX_SIZE,
    KERNEL_QUEUE_MAX_BYTES,
    jsonBytes,
  );
  readonly #events = new AsyncValueQueue<AgentDriverRuntimeEvent>(
    "event",
    KERNEL_QUEUE_MAX_SIZE,
    KERNEL_QUEUE_MAX_BYTES,
    jsonBytes,
    {
      maxBytes: KERNEL_TERMINAL_QUEUE_MAX_BYTES,
      maxSize: KERNEL_TERMINAL_QUEUE_MAX_SIZE,
    },
  );
  readonly #hostPorts: AgentDriverContextPortOverrides | undefined;
  readonly #logger: Logger;
  readonly #permissionBroker: DriverPermissionBroker;
  readonly #runtimeState = new DriverRuntimeStateMachine("created");
  readonly #shutdownController = new AbortController();
  #activeRunId: RunId | null = null;
  #backend: AgentDriverBackend | null = null;
  #backendFinalStopTask: Promise<void> | null = null;
  #backendStartController: AbortController | null = null;
  #backendStartTask: Promise<void> | null = null;
  #backendStopNeedsReplay = false;
  #backendStopController: AbortController | null = null;
  #backendStopTask: Promise<void> | null = null;
  #payload: DriverStartInput | null = null;
  #pushedEventSeq = 0;
  #runTask: Promise<void> | null = null;
  #runTerminal: "completed" | "failed" | null = null;
  #shutdownTask: Promise<void> | null = null;
  #stopTask: Promise<void> | null = null;
  #terminalCause: { error: unknown } | null = null;

  constructor(options: AgentDriverKernelOptions) {
    this.#backendFactory = options.backendFactory;
    this.#hostPorts = options.hostPorts;
    this.#logger = options.logger ?? createKernelLogger();
    this.#permissionBroker = new DriverPermissionBroker(() => this.#logger);
  }

  beginRun(runId: RunId): void {
    this.#activeRunId = runId;
    this.#runTerminal = null;
  }

  async cancel(reason: string): Promise<void> {
    await this.dispatch({
      commandId: createDriverId(),
      kind: "turn.cancel",
      reason,
    });
  }

  async commandUpdate(
    input: {
      commandId: string;
      error?: RunError;
      result?: RuntimeCommandResult;
      status: "accepted" | "cancelled" | "completed" | "failed";
    },
    _signal: AbortSignal,
  ): Promise<void> {
    const update = structuredClone(input);
    if (update.status === "accepted") {
      return;
    }

    const result = this.#commandResults.get(update.commandId);
    const command = this.#commandsById.get(update.commandId);

    if (!result || !command) {
      return;
    }

    this.#commandsById.delete(update.commandId);
    this.#commandResults.delete(update.commandId);

    if (update.status === "failed") {
      result.reject(toDispatchError(update.error, command));
      return;
    }

    result.resolve(update.result === undefined ? undefined : update.result);
  }

  async completeRun(): Promise<void> {
    if (this.#runTerminal !== null) {
      return;
    }
    this.#pushTerminalEvent({
      kind: "run.completed",
      payload: {
        stopReason: "end_turn",
      },
    });
    this.#runTerminal = "completed";
  }

  async dispatch(command: RuntimeCommand): Promise<KernelCommandResult> {
    this.#ensureStarted();
    const admitted = parseRuntimeCommand(command);

    if (this.#commandResults.has(admitted.commandId)) {
      throw new Error(`Driver command ${admitted.commandId} is already pending.`);
    }

    const result = Promise.withResolvers<KernelCommandResult>();
    this.#commands.push(admitted);
    this.#commandsById.set(admitted.commandId, admitted);
    this.#commandResults.set(admitted.commandId, result);
    return result.promise;
  }

  endRun(runId: RunId): void {
    if (this.#activeRunId === runId) {
      this.#activeRunId = null;
    }
  }

  events(): AsyncIterable<AgentDriverRuntimeEvent> {
    return this.#events.values();
  }

  async failRun(error: RunError): Promise<void> {
    if (this.#runTerminal !== null) {
      return;
    }
    this.#pushTerminalEvent({
      kind: "run.failed",
      payload: {
        error,
        recoverable: false,
      },
      ...(this.#activeRunId === null ? {} : { runId: this.#activeRunId }),
    });
    this.#runTerminal = "failed";
  }

  async heartbeat(
    _input: Parameters<DriverRuntimeIo["heartbeat"]>[0],
  ): ReturnType<DriverRuntimeIo["heartbeat"]> {
    return {
      heartbeatCount: 1,
      ok: true as const,
    };
  }

  async nextCommand(_signal: AbortSignal): Promise<RuntimeCommand | null> {
    const result = await this.#commands.next();
    return result.done ? null : result.value;
  }

  async pushEvents(input: { events: DriverEventInput[] }): Promise<DriverEventBatchOutput> {
    const events = structuredClone(input.events);
    this.#events.pushMany(events);
    const accepted = events.map((event) => {
      this.#pushedEventSeq += 1;

      return {
        seq: this.#pushedEventSeq,
        type: event.kind,
      };
    });

    return { accepted };
  }

  async start(input: AgentDriverKernelStartInput): Promise<void> {
    if (this.#runtimeState.status() !== "created") {
      throw new Error("Driver kernel has already started.");
    }

    const admitted = structuredClone(input);
    this.#runtimeState.enter("starting");
    await this.#start(admitted);
  }

  stop(reason: string): Promise<void> {
    return (this.#stopTask ??= this.#stop(reason).catch((error: unknown) => {
      this.#stopTask = null;
      throw error;
    }));
  }

  async #start(input: AgentDriverKernelStartInput): Promise<void> {
    this.#payload = input;
    const context = this.#createContext(input);

    try {
      const backend = this.#backendFactory(input);
      this.#backend = backend;
      const backendStartController = new AbortController();
      this.#backendStartController = backendStartController;
      const backendStartTask = Promise.resolve().then(() => {
        this.#shutdownController.signal.throwIfAborted();
        return backend.start(context, backendStartController.signal);
      });
      this.#backendStartTask = backendStartTask;
      void backendStartTask.then(
        () => {
          if (this.#backendStartTask === backendStartTask) {
            this.#backendStartTask = null;
            this.#backendStartController = null;
          }
        },
        () => {
          if (this.#backendStartTask === backendStartTask) {
            this.#backendStartTask = null;
            this.#backendStartController = null;
          }
        },
      );

      try {
        await promiseWithTimeout(backendStartTask, {
          label: "Driver kernel backend startup",
          signal: this.#shutdownController.signal,
          timeoutMs: KERNEL_START_TIMEOUT_MS,
        });
      } catch (error) {
        backendStartController.abort(error);
        if (this.#shutdownController.signal.aborted && this.#terminalCause === null) {
          return;
        }

        throw this.#terminalCause?.error ?? error;
      }

      if (this.#runtimeState.status() !== "starting") {
        this.#throwTerminalCause();
        return;
      }

      this.#runtimeState.enter("ready");
      const dispatcher = new DriverCommandDispatcher({
        backend,
        driverInstanceId: input.driverInstanceId,
        isShuttingDown: () => this.#runtimeState.isShuttingDown(),
        permissionRequests: this.#permissionBroker,
        runtimeContextFactory: () => context,
        runtimeState: this.#runtimeState,
        sandboxId: input.sandboxId,
        shutdownSignal: this.#shutdownController.signal,
        shutdown: async (_runtimeIo, reason) => this.#shutdown(reason),
      });

      this.#runTask = dispatcher
        .run(this, this.#logger)
        .catch(async (error: unknown) => {
          this.#rememberTerminalCause(error);
          if (
            this.#runtimeState.status() !== "failed" &&
            this.#runtimeState.status() !== "stopped"
          ) {
            this.#runtimeState.enter("failed");
          }
          this.#rejectPendingCommands(this.#terminalCause?.error ?? error);
          await this.#shutdown("driver.command_loop_failed").catch((shutdownError: unknown) => {
            this.#logger.error("driver.kernel.shutdown.failed", shutdownError, {});
          });
        })
        .finally(() => {
          this.#rejectPendingCommands(
            this.#terminalCause?.error ?? new Error("Driver kernel stopped."),
          );
        });
    } catch (error) {
      this.#rememberTerminalCause(error);
      if (
        this.#runtimeState.status() !== "failed" &&
        this.#runtimeState.status() !== "stopped" &&
        this.#runtimeState.status() !== "stopping"
      ) {
        this.#runtimeState.enter("failed");
      }
      this.#rejectPendingCommands(this.#terminalCause?.error ?? error);
      await this.#shutdown("driver.start_failed").catch((stopError: unknown) => {
        this.#logger.error("driver.kernel.start_cleanup.failed", stopError, {});
      });
      this.#throwTerminalCause();
    }
  }

  async #stop(reason: string): Promise<void> {
    const status = this.#runtimeState.status();

    if (status === "failed" || status === "stopping") {
      try {
        await (this.#shutdownTask ?? this.#shutdown(reason));
      } catch (error) {
        if (this.#terminalCause === null) {
          throw error;
        }

        this.#logger.error("driver.kernel.shutdown.failed", error, {});
      }
      await this.#runTask;
      this.#throwTerminalCause();
      return;
    }

    if (status === "stopped") {
      return;
    }

    if (status === "created" || status === "starting") {
      await this.#shutdown(reason);
      return;
    }

    try {
      await this.dispatch({
        commandId: createDriverId(),
        kind: "session.stop",
        reason,
      });
    } catch (error) {
      if (this.#runtimeState.status() === "failed" || this.#shutdownTask !== null) {
        this.#throwTerminalCause();
        throw error;
      }

      this.#logger.warn("driver.kernel.stop.command_bypassed", {
        message: error instanceof Error ? error.message : "Kernel stop command failed.",
      });
      let terminalFailure: { error: unknown } | null = null;

      try {
        await this.completeRun();
      } catch (error) {
        terminalFailure = { error };
      }
      await this.#shutdown(reason);

      if (terminalFailure !== null) {
        throw terminalFailure.error;
      }
    }

    await this.#runTask;
    this.#throwTerminalCause();
  }

  #createContext(payload: DriverStartInput): AgentDriverContext {
    return createAgentDriverContext({
      eventSink: this,
      ...(this.#hostPorts === undefined ? {} : { ports: this.#hostPorts }),
      lifecycle: {
        fail: (error) => this.#onBackendFailure(error),
      },
      payload,
      logger: this.#logger,
      permission: {
        request: createDriverPermissionRequestHandler({
          payload,
          supervised: async (input, signal) => {
            const generation = this.#runtimeState.beginApproval();

            try {
              return await this.#permissionBroker.request(this, input, signal);
            } finally {
              this.#runtimeState.endApproval(generation);
            }
          },
        }),
      },
    });
  }

  #ensureStarted(): void {
    const status = this.#runtimeState.status();

    if (status === "created" || status === "starting") {
      throw new Error("Driver kernel has not started.");
    }

    if (this.#runtimeState.isShuttingDown()) {
      throw new Error(`Driver kernel is not accepting commands: ${status}.`);
    }
  }

  #onBackendFailure(error: Error): void {
    this.#logger.error("driver.kernel.backend.failed", error, {});

    if (this.#runtimeState.isShuttingDown()) {
      return;
    }

    this.#rememberTerminalCause(error);
    this.#runtimeState.enter("failed");
    this.#rejectPendingCommands(error);

    if (this.#activeRunId !== null) {
      void this.failRun({
        code: "driver.runtime_failed",
        details: {},
        message: error.message,
        retryable: false,
      }).catch((eventError: unknown) => {
        this.#logger.error("driver.kernel.run_failure_event.failed", eventError, {});
      });
    }

    void this.#shutdown("driver.backend_failed").catch((shutdownError: unknown) => {
      this.#logger.error("driver.kernel.shutdown.failed", shutdownError, {});
    });
  }

  #rejectPendingCommands(error: unknown): void {
    for (const result of this.#commandResults.values()) {
      result.reject(error);
    }

    this.#commandResults.clear();
    this.#commandsById.clear();
  }

  #rememberTerminalCause(error: unknown): void {
    this.#terminalCause ??= { error };
  }

  #pushTerminalEvent(event: AgentDriverRuntimeEvent): void {
    this.#events.pushReserved(structuredClone(event));
  }

  #stopBackend(
    backend: AgentDriverBackend,
    payload: DriverStartInput,
    reason: string,
  ): Promise<void> {
    const controller = new AbortController();
    const task = Promise.resolve().then(() =>
      backend.stop(this.#createContext(payload), reason, controller.signal),
    );
    this.#backendStopController = controller;
    this.#backendStopTask = task;
    void task.then(undefined, () => {
      if (this.#backendStopTask === task) {
        this.#backendStopController = null;
        this.#backendStopTask = null;
      }
    });
    return task;
  }

  #scheduleFinalStop(
    startTask: Promise<void>,
    backend: AgentDriverBackend,
    payload: DriverStartInput,
    reason: string,
  ): void {
    if (this.#backendFinalStopTask !== null) {
      return;
    }

    let stopTask: Promise<void> | null = null;
    let task!: Promise<void>;
    task = startTask
      .catch(() => {})
      .then(async () => {
        if (this.#backendFinalStopTask !== task || !this.#backendStopNeedsReplay) {
          return;
        }

        this.#backendStopNeedsReplay = false;
        stopTask = this.#stopBackend(backend, payload, reason);
        await promiseWithTimeout(stopTask, {
          label: "Driver kernel deferred backend shutdown",
          timeoutMs: KERNEL_SHUTDOWN_TIMEOUT_MS,
        });

        if (this.#backendFinalStopTask === task && this.#backendStopTask === stopTask) {
          this.#backend = null;
          this.#backendStopController = null;
          this.#backendStopTask = null;
          this.#events.close();
        }
      });
    this.#backendFinalStopTask = task;
    void task.then(
      () => {
        if (this.#backendFinalStopTask === task) {
          this.#backendFinalStopTask = null;
        }
      },
      (error: unknown) => {
        if (this.#backendFinalStopTask === task) {
          this.#backendFinalStopTask = null;
        }
        if (stopTask !== null && this.#backendStopTask === stopTask) {
          this.#backendStopController?.abort(error);
          this.#backendStopController = null;
          this.#backendStopTask = null;
        }
        this.#logger.error("driver.kernel.deferred_shutdown.failed", error, {});
      },
    );
  }

  #throwTerminalCause(): void {
    if (this.#terminalCause !== null) {
      throw this.#terminalCause.error;
    }
  }

  #shutdown(reason: string): Promise<void> {
    return (this.#shutdownTask ??= this.#runShutdown(reason).catch((error: unknown) => {
      this.#shutdownTask = null;
      throw error;
    }));
  }

  async #runShutdown(reason: string): Promise<void> {
    if (this.#runtimeState.status() === "stopped") {
      return;
    }

    if (this.#runtimeState.status() !== "failed") {
      this.#runtimeState.enter("stopping");
    }
    this.#shutdownController.abort(new Error(reason));
    this.#commands.close({ discard: true });
    this.#permissionBroker.rejectAll();
    const backend = this.#backend;
    const payload = this.#payload;
    const backendStartTask = this.#backendStartTask;
    const backendFinalStopTask = this.#backendFinalStopTask;

    if (backendStartTask !== null) {
      this.#backendStartController?.abort(new Error(reason));
    }

    try {
      if (backendStartTask !== null) {
        this.#backendStopNeedsReplay = true;
      }

      if (backend && payload && this.#backendStopTask === null) {
        if (backendStartTask === null) {
          this.#backendStopNeedsReplay = false;
        }
        this.#stopBackend(backend, payload, reason);
      }

      const shutdownTasks: Promise<unknown>[] = [];

      if (this.#backendStopTask !== null) {
        shutdownTasks.push(this.#backendStopTask);
      }
      if (backendStartTask !== null) {
        shutdownTasks.push(backendStartTask.catch(() => {}));
      }
      if (backendFinalStopTask !== null) {
        shutdownTasks.push(backendFinalStopTask);
      }

      await promiseWithTimeout(Promise.all(shutdownTasks), {
        label: "Driver kernel backend shutdown",
        timeoutMs: KERNEL_SHUTDOWN_TIMEOUT_MS,
      });

      if (backend && payload && this.#backendStopNeedsReplay) {
        this.#backendStopNeedsReplay = false;
        await promiseWithTimeout(this.#stopBackend(backend, payload, reason), {
          label: "Driver kernel final backend shutdown",
          timeoutMs: KERNEL_SHUTDOWN_TIMEOUT_MS,
        });
      }

      if (this.#runtimeState.status() === "stopping") {
        this.#runtimeState.enter("stopped");
      }
      this.#backend = null;
      this.#backendFinalStopTask = null;
      this.#backendStartController = null;
      this.#backendStopController = null;
      this.#backendStopTask = null;
      this.#events.close();
    } catch (error) {
      this.#backendStopController?.abort(error);
      this.#backendStopController = null;
      this.#backendStopTask = null;
      if (this.#backendFinalStopTask === backendFinalStopTask) {
        this.#backendFinalStopTask = null;
      }
      if (backend && payload && backendStartTask && this.#backendStopNeedsReplay) {
        this.#scheduleFinalStop(backendStartTask, backend, payload, reason);
      }
      if (this.#runtimeState.status() === "stopping") {
        this.#runtimeState.enter("failed");
      }
      throw error;
    }
  }
}
