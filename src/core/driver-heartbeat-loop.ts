import type { Logger } from "../observability";
import { sleepPromise } from "../utils/async";
import type { DriverRuntimeHeartbeatPort } from "./driver-runtime-io";

interface DriverHeartbeatLoopOptions {
  driverInstanceId: string;
  isShuttingDown(): boolean;
}

export class DriverHeartbeatLoop {
  readonly #driverInstanceId: string;
  readonly #isShuttingDown: () => boolean;
  #controller: AbortController | null = null;

  constructor(options: DriverHeartbeatLoopOptions) {
    this.#driverInstanceId = options.driverInstanceId;
    this.#isShuttingDown = options.isShuttingDown;
  }

  start(
    socket: DriverRuntimeHeartbeatPort,
    logger: Logger,
    heartbeatIntervalMs: number,
    onFailure: (error: unknown) => void,
  ): void {
    this.stop(logger, "restart");

    logger.debug("driver.runtime.heartbeat.started", {
      driverInstanceId: this.#driverInstanceId,
      heartbeatIntervalMs,
    });

    const controller = new AbortController();
    this.#controller = controller;
    void this.#run(socket, logger, heartbeatIntervalMs, controller, onFailure);
  }

  async #run(
    socket: DriverRuntimeHeartbeatPort,
    logger: Logger,
    heartbeatIntervalMs: number,
    controller: AbortController,
    onFailure: (error: unknown) => void,
  ): Promise<void> {
    try {
      while (!controller.signal.aborted && !this.#isShuttingDown()) {
        await sleepPromise(heartbeatIntervalMs, controller.signal);

        if (controller.signal.aborted || this.#isShuttingDown()) {
          return;
        }

        await socket.heartbeat({
          at: new Date().toISOString(),
          reason: "interval",
        });
      }
    } catch (error) {
      if (controller.signal.aborted || this.#isShuttingDown()) {
        return;
      }

      logger.error("driver.runtime.heartbeat-failed", error, {
        driverInstanceId: this.#driverInstanceId,
      });
      onFailure(error);
    } finally {
      if (this.#controller === controller) {
        this.#controller = null;
      }
    }
  }

  stop(logger: Logger | null, reason: string): void {
    if (!this.#controller) {
      return;
    }

    this.#controller.abort(new Error(reason));
    this.#controller = null;
    logger?.debug("driver.runtime.heartbeat.stopped", {
      driverInstanceId: this.#driverInstanceId,
      reason,
    });
  }
}
