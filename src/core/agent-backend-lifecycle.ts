import { promiseWithTimeout } from "../utils/async";
import type { AgentDriverBackend, AgentDriverContext } from "./agent-driver-backend";

export interface AgentBackendLifecycleOptions {
  readonly backend: AgentDriverBackend;
  readonly createContext: () => AgentDriverContext;
  readonly labels: {
    readonly deferredStop: string;
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
  #finalStopTask: Promise<void> | null = null;
  #startController: AbortController | null = null;
  #startTask: Promise<void> | null = null;
  #stopController: AbortController | null = null;
  #stopNeedsReplay = false;
  #stopTask: Promise<void> | null = null;

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
    const startTask = this.#startTask;
    const finalStopTask = this.#finalStopTask;

    if (startTask !== null) {
      this.#startController?.abort(new Error(reason));
      this.#stopNeedsReplay = true;
    }

    if (this.#stopTask === null) {
      if (startTask === null) {
        this.#stopNeedsReplay = false;
      }
      this.#stop(reason);
    }

    const tasks: Promise<unknown>[] = [];
    if (this.#stopTask !== null) {
      tasks.push(this.#stopTask);
    }
    if (startTask !== null) {
      tasks.push(startTask.catch(() => {}));
    }
    if (finalStopTask !== null) {
      tasks.push(finalStopTask);
    }

    try {
      await promiseWithTimeout(Promise.all(tasks), {
        label: this.#labels.stop,
        timeoutMs: this.#stopTimeoutMs,
      });

      if (this.#stopNeedsReplay) {
        this.#stopNeedsReplay = false;
        await promiseWithTimeout(this.#stop(reason), {
          label: this.#labels.finalStop,
          timeoutMs: this.#stopTimeoutMs,
        });
      }

      this.#clear();
    } catch (error) {
      this.#stopController?.abort(error);
      this.#stopController = null;
      this.#stopTask = null;
      if (this.#finalStopTask === finalStopTask) {
        this.#finalStopTask = null;
      }
      if (startTask !== null && this.#stopNeedsReplay) {
        this.#scheduleFinalStop(startTask, reason);
      }
      throw error;
    }
  }

  #clear(): void {
    this.#finalStopTask = null;
    this.#startController = null;
    this.#stopController = null;
    this.#stopTask = null;
  }

  #clearStart(task: Promise<void>): void {
    if (this.#startTask === task) {
      this.#startController = null;
      this.#startTask = null;
    }
  }

  #stop(reason: string): Promise<void> {
    const controller = new AbortController();
    const task = Promise.resolve().then(() =>
      this.#runStop(this.#backend, this.#createContext(), reason, controller.signal),
    );
    this.#stopController = controller;
    this.#stopTask = task;
    void task.then(undefined, () => {
      if (this.#stopTask === task) {
        this.#stopController = null;
        this.#stopTask = null;
      }
    });
    return task;
  }

  #scheduleFinalStop(startTask: Promise<void>, reason: string): void {
    if (this.#finalStopTask !== null) {
      return;
    }

    let stopTask: Promise<void> | null = null;
    let task!: Promise<void>;
    task = startTask
      .catch(() => {})
      .then(async () => {
        if (this.#finalStopTask !== task || !this.#stopNeedsReplay) {
          return;
        }

        this.#stopNeedsReplay = false;
        stopTask = this.#stop(reason);
        await promiseWithTimeout(stopTask, {
          label: this.#labels.deferredStop,
          timeoutMs: this.#stopTimeoutMs,
        });

        if (this.#finalStopTask === task && this.#stopTask === stopTask) {
          this.#clear();
          this.#onDeferredStopComplete?.();
        }
      });
    this.#finalStopTask = task;
    void task.then(
      () => {
        if (this.#finalStopTask === task) {
          this.#finalStopTask = null;
        }
      },
      (error: unknown) => {
        if (this.#finalStopTask === task) {
          this.#finalStopTask = null;
        }
        if (stopTask !== null && this.#stopTask === stopTask) {
          this.#stopController?.abort(error);
          this.#stopController = null;
          this.#stopTask = null;
        }
        this.#onDeferredStopError?.(error);
      },
    );
  }
}
