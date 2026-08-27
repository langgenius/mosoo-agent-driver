import { promiseWithTimeout, settlePromiseWithTimeout } from "../utils/async";
import type { AgentDriverBackend, AgentDriverContext } from "./agent-driver-backend";

export interface AgentBackendLifecycleOptions {
  readonly backend: AgentDriverBackend;
  readonly createContext: () => AgentDriverContext;
  readonly labels: {
    readonly finalStop: string;
    readonly start: string;
    readonly stop: string;
  };
  readonly onDeferredStopComplete?: () => void;
  readonly onDeferredStopError?: (error: unknown) => void;
  readonly runStart?: (
    backend: AgentDriverBackend,
    context: AgentDriverContext,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly runStop?: (
    backend: AgentDriverBackend,
    context: AgentDriverContext,
    reason: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly shutdownSignal: AbortSignal;
  readonly startTimeoutMs: number;
  readonly stopTimeoutMs: number;
}

type CleanupOwner = {
  deadline: number;
  deferred: DeferredCleanup | null;
  task: Promise<void>;
};

type DeferredCleanup =
  | { after: Promise<void>; kind: "final_stop" }
  | { generation: number; kind: "late_stop"; task: Promise<void> };

type StopOperation = {
  settled: Promise<void>;
};

export class AgentBackendLifecycle {
  readonly #backend: AgentDriverBackend;
  readonly #createContext: () => AgentDriverContext;
  readonly #labels: AgentBackendLifecycleOptions["labels"];
  readonly #onDeferredStopComplete: (() => void) | undefined;
  readonly #onDeferredStopError: ((error: unknown) => void) | undefined;
  readonly #runStart: NonNullable<AgentBackendLifecycleOptions["runStart"]>;
  readonly #runStop: NonNullable<AgentBackendLifecycleOptions["runStop"]>;
  readonly #shutdownSignal: AbortSignal;
  readonly #startTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  #cleanupOwner: CleanupOwner | null = null;
  #inFlightStop: StopOperation | null = null;
  #startController: AbortController | null = null;
  #startupStopTask: Promise<void> | null = null;
  #startTask: Promise<void> | null = null;
  #stopGeneration = 0;
  #stopped = false;

  constructor(options: AgentBackendLifecycleOptions) {
    this.#backend = options.backend;
    this.#createContext = options.createContext;
    this.#labels = options.labels;
    this.#onDeferredStopComplete = options.onDeferredStopComplete;
    this.#onDeferredStopError = options.onDeferredStopError;
    this.#runStart =
      options.runStart ?? ((backend, context, signal) => backend.start(context, signal));
    this.#runStop =
      options.runStop ??
      ((backend, context, reason, signal) => backend.stop(context, reason, signal));
    this.#shutdownSignal = options.shutdownSignal;
    this.#startTimeoutMs = options.startTimeoutMs;
    this.#stopTimeoutMs = options.stopTimeoutMs;
  }

  async start(): Promise<void> {
    if (this.#startTask !== null) {
      return this.#startTask;
    }

    const controller = new AbortController();
    const task = Promise.resolve().then(() => {
      this.#shutdownSignal.throwIfAborted();
      return this.#runStart(this.#backend, this.#createContext(), controller.signal);
    });
    this.#startController = controller;
    this.#startTask = task;
    void task.then(
      () => this.#clearStart(task),
      () => this.#clearStart(task),
    );

    try {
      await promiseWithTimeout(task, {
        label: this.#labels.start,
        signal: this.#shutdownSignal,
        timeoutMs: this.#startTimeoutMs,
      });
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  }

  async shutdown(reason: string): Promise<void> {
    if (this.#stopped) {
      return;
    }

    await (this.#cleanupOwner ?? this.#createCleanupOwner(reason)).task;
  }

  #clearStart(task: Promise<void>): void {
    if (this.#startTask === task) {
      this.#startController = null;
      this.#startTask = null;
    }
  }

  #createCleanupOwner(reason: string): CleanupOwner {
    const startTask = this.#startTask;
    this.#startController?.abort(new Error(reason));

    const owner: CleanupOwner = {
      deadline: Date.now() + this.#stopTimeoutMs,
      deferred: null,
      task: Promise.resolve(),
    };
    owner.task = this.#runCleanup(owner, reason, startTask).then(
      () => {
        this.#stopped = true;
        if (this.#cleanupOwner === owner) {
          this.#cleanupOwner = null;
        }
      },
      (error: unknown) => {
        if (this.#cleanupOwner === owner) {
          this.#cleanupOwner = null;
        }
        if (owner.deferred !== null) {
          this.#watchDeferredCleanup(owner.deferred, reason);
        }
        throw error;
      },
    );
    this.#cleanupOwner = owner;
    return owner;
  }

  async #runCleanup(
    owner: CleanupOwner,
    reason: string,
    startTask: Promise<void> | null,
  ): Promise<void> {
    if (startTask === null) {
      await this.#stop(owner, reason, this.#labels.stop, true);
      return;
    }

    if (this.#startupStopTask !== startTask) {
      this.#startupStopTask = startTask;
      await this.#stop(owner, reason, this.#labels.stop, false).catch(() => {});
    }

    const startResult = await settlePromiseWithTimeout(startTask, {
      label: this.#labels.stop,
      timeoutMs: this.#remaining(owner),
    });
    if (startResult.status === "timed_out") {
      const stopSettled = this.#inFlightStop?.settled ?? Promise.resolve();
      owner.deferred = {
        after: Promise.allSettled([startTask, stopSettled]).then(() => {}),
        kind: "final_stop",
      };
      throw startResult.error;
    }

    await this.#stop(owner, reason, this.#labels.finalStop, true);
  }

  #remaining(owner: CleanupOwner): number {
    return Math.max(0, owner.deadline - Date.now());
  }

  async #stop(owner: CleanupOwner, reason: string, label: string, final: boolean): Promise<void> {
    const previous = this.#inFlightStop;
    if (previous !== null) {
      const previousResult = await settlePromiseWithTimeout(previous.settled, {
        label,
        timeoutMs: this.#remaining(owner),
      });
      if (previousResult.status !== "completed") {
        if (final && previousResult.status === "timed_out") {
          owner.deferred = { after: previous.settled, kind: "final_stop" };
        }
        throw previousResult.error;
      }
    }

    const controller = new AbortController();
    const generation = (this.#stopGeneration += 1);
    const task = Promise.resolve().then(() =>
      this.#runStop(this.#backend, this.#createContext(), reason, controller.signal),
    );
    const operation: StopOperation = {
      settled: Promise.resolve(),
    };
    operation.settled = task.then(
      () => this.#clearStop(operation),
      () => this.#clearStop(operation),
    );
    this.#inFlightStop = operation;

    const result = await settlePromiseWithTimeout(task, {
      label,
      timeoutMs: this.#remaining(owner),
    });
    if (result.status === "completed") {
      return;
    }
    if (result.status === "timed_out") {
      controller.abort(result.error);
      if (final) {
        owner.deferred = { generation, kind: "late_stop", task };
      }
    }
    throw result.error;
  }

  #clearStop(operation: StopOperation): void {
    if (this.#inFlightStop === operation) {
      this.#inFlightStop = null;
    }
  }

  #watchDeferredCleanup(deferred: DeferredCleanup, reason: string): void {
    if (deferred.kind === "final_stop") {
      void deferred.after.then(() => this.#runDeferredCleanup(reason));
      return;
    }

    void deferred.task.then(
      () => this.#acceptLateStop(deferred.generation),
      (error: unknown) => this.#onDeferredStopError?.(error),
    );
  }

  async #runDeferredCleanup(reason: string): Promise<void> {
    try {
      await this.shutdown(reason);
      this.#onDeferredStopComplete?.();
    } catch (error) {
      this.#onDeferredStopError?.(error);
    }
  }

  async #acceptLateStop(generation: number): Promise<void> {
    const owner = this.#cleanupOwner;
    if (owner !== null) {
      try {
        await owner.task;
        this.#onDeferredStopComplete?.();
        return;
      } catch (error) {
        if (generation !== this.#stopGeneration || this.#inFlightStop !== null) {
          this.#onDeferredStopError?.(error);
          return;
        }
      }
    }

    if (generation !== this.#stopGeneration) {
      return;
    }

    this.#stopped = true;
    this.#onDeferredStopComplete?.();
  }
}
