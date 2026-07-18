import { summarizeDriverBootPayload } from "../infrastructure/logging/driver-debug";
import {
  createDriverLogger,
  runWithDriverLogContext,
} from "../infrastructure/logging/driver-logger";
import type { DriverLogUplink } from "../infrastructure/logging/driver-logger";
import { DriverInstanceSocket } from "../infrastructure/runtime/driver-instance-socket";
import type { Logger } from "../observability";
import { DRIVER_PROTOCOL_VERSION } from "../protocol/boot";
import type { DriverBootPayload } from "../protocol/boot";
import { createDriverHostIntegrationSnapshotFromBootExecution } from "../protocol/host-integration";
import type { DriverHostIntegrationSnapshot } from "../protocol/host-integration";
import { parseDriverId } from "../protocol/id";
import type { RunId } from "../protocol/id";
import { createDriverStartInputFromBootPayload } from "../protocol/start";
import type { DriverStartInput } from "../protocol/start";
import type {
  AgentDriverBackend,
  AgentDriverBackendFactory,
  AgentDriverContext,
} from "../runtimes/agent-driver-backend";
import { createAgentDriverContext } from "../runtimes/agent-driver-backend";
import { executeRemoteHttpMcpCommand } from "../runtimes/mcp/remote-http-mcp-executor";
import {
  AGENT_DRIVER_PROVIDER_REGISTRY,
  createAgentDriverProviderCapabilities,
} from "../runtimes/provider-registry";
import { materializeResolvedSkills } from "../runtimes/skill-materialization";
import { promiseWithTimeout } from "../utils/async";
import { DriverCommandDispatcher } from "./driver-command-dispatcher";
import { pushDriverDiagnosticEvent } from "./driver-diagnostics";
import { DriverHeartbeatLoop } from "./driver-heartbeat-loop";
import { DriverPermissionBroker } from "./driver-permission-broker";
import { createDriverPermissionRequestHandler } from "./driver-permission-policy";
import { pushLosslessEvents } from "./driver-runtime-io";
import type { DriverRuntimeEventPort, DriverRuntimeRunPort } from "./driver-runtime-io";
import { DriverRuntimeStateMachine } from "./driver-runtime-state";
import { createTimingEvent, createTimingPhase, toDurationMs } from "./driver-runtime-timing";

const DRIVER_VERSION = "0.1.0";
const DRIVER_BACKEND_START_TIMEOUT_MS = 60_000;
const DRIVER_SHUTDOWN_TIMEOUT_MS = 5_000;

function parseNullableRunId(value: string | null): RunId | null {
  return value === null ? null : (parseDriverId(value, "Run ID") as RunId);
}

export class DriverProcess {
  readonly #startedAt = new Date().toISOString();
  readonly #backendFactory: AgentDriverBackendFactory;
  readonly #heartbeatLoop: DriverHeartbeatLoop;
  #backend: AgentDriverBackend | null = null;
  #logger: Logger | null = null;
  #logUplink: DriverLogUplink | null = null;
  private readonly payload: DriverBootPayload;
  readonly #permissionBroker: DriverPermissionBroker;
  readonly #shutdownController = new AbortController();
  readonly #hostSnapshot: DriverHostIntegrationSnapshot;
  readonly #runtimeState = new DriverRuntimeStateMachine("created");
  readonly #startInput: DriverStartInput;
  #backendFinalStopTask: Promise<void> | null = null;
  #backendStartController: AbortController | null = null;
  #backendStartTask: Promise<void> | null = null;
  #backendStopNeedsReplay = false;
  #backendStopController: AbortController | null = null;
  #backendStopTask: Promise<void> | null = null;
  #shutdownReason: string | null = null;
  #shutdownTask: Promise<void> | null = null;
  #terminalCause: { error: unknown } | null = null;
  #unregisterSignals: (() => void) | null = null;

  constructor(
    payload: DriverBootPayload,
    backendFactory: AgentDriverBackendFactory = (input) =>
      AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(input),
  ) {
    this.#backendFactory = backendFactory;
    this.payload = payload;
    this.#hostSnapshot = createDriverHostIntegrationSnapshotFromBootExecution(payload.execution);
    this.#startInput = createDriverStartInputFromBootPayload(payload);
    this.#permissionBroker = new DriverPermissionBroker(() => this.#logger);
    this.#heartbeatLoop = new DriverHeartbeatLoop({
      driverInstanceId: payload.driverInstanceId,
      isShuttingDown: () => this.#runtimeState.isShuttingDown(),
    });
  }

  async run(): Promise<void> {
    this.#runtimeState.enter("starting");
    const provider = AGENT_DRIVER_PROVIDER_REGISTRY.getByStartInput(this.#startInput);
    const capabilities = createAgentDriverProviderCapabilities({
      permissionRequestStatus: this.#permissionBroker.capabilityStatus(),
      provider,
    });
    let socket!: DriverInstanceSocket;

    socket = new DriverInstanceSocket(this.payload, {
      onClose: (_code, reason) => {
        if (this.#shutdownReason !== null) {
          return;
        }

        void this.shutdown(socket, reason || "runtime.socket.closed").catch(() => {});
      },
    });

    this.registerSignals(socket);
    try {
      await socket.connect();
      this.#shutdownController.signal.throwIfAborted();

      const { logger, uplink } = createDriverLogger(this.payload, socket);
      this.#logger = logger;
      this.#logUplink = uplink;

      await runWithDriverLogContext(this.payload, async () => {
        logger.debug("driver.runtime.boot.loaded", summarizeDriverBootPayload(this.payload));
        logger.debug("driver.runtime.socket.connected", {
          driverInstanceId: this.payload.driverInstanceId,
          runtime: this.payload.runtime,
        });

        logger.debug("driver.runtime.hello.sending", {
          capabilities: [...capabilities],
          driverVersion: DRIVER_VERSION,
          protocolVersion: DRIVER_PROTOCOL_VERSION,
          startedAt: this.#startedAt,
        });

        const helloStartedAtMs = Date.now();
        const hello = await logger.span("runtime.socket.hello", async () =>
          socket.hello({
            capabilities: [...capabilities],
            driverVersion: DRIVER_VERSION,
            protocolVersion: DRIVER_PROTOCOL_VERSION,
            startedAt: this.#startedAt,
          }),
        );
        const initialRunId = parseNullableRunId(hello.runId);
        // The server accepts pushLogs only after hello commits; release the
        // buffered boot logs now instead of racing the handshake round-trip.
        uplink.open();
        const helloDurationMs = toDurationMs(helloStartedAtMs);

        logger.info("driver.runtime.hello.completed", {
          connectionId: hello.connectionId,
          runId: initialRunId,
        });
        logger.debug("driver.runtime.hello.received", {
          acceptedCapabilities: hello.acceptedCapabilities,
          connectionId: hello.connectionId,
          driverInstanceId: hello.driverInstanceId,
          heartbeatIntervalMs: hello.heartbeatIntervalMs,
          runConfig: hello.runConfig,
          runId: initialRunId,
        });

        const runtimeContext = this.createAgentDriverContext(socket, logger);

        const backendLoadStartedAtMs = Date.now();
        const backend = await logger.span("driver.backend.load", async () => {
          this.#shutdownController.signal.throwIfAborted();
          const loadedBackend = this.#backendFactory(this.#startInput);
          this.#backend = loadedBackend;
          return loadedBackend;
        });

        if (this.#runtimeState.isShuttingDown()) {
          this.throwTerminalCause();
          return;
        }

        const backendLoadDurationMs = toDurationMs(backendLoadStartedAtMs);
        const backendStartedAtMs = Date.now();
        const backendStartController = new AbortController();
        this.#backendStartController = backendStartController;
        const backendStartTask = Promise.resolve().then(() => {
          this.#shutdownController.signal.throwIfAborted();
          return logger.span("driver.backend.start", async () =>
            backend.start(runtimeContext, backendStartController.signal),
          );
        });
        this.#backendStartTask = backendStartTask;
        void backendStartTask.then(
          () => {
            if (this.#backendStartTask === backendStartTask) {
              this.#backendStartController = null;
              this.#backendStartTask = null;
            }
          },
          () => {
            if (this.#backendStartTask === backendStartTask) {
              this.#backendStartController = null;
              this.#backendStartTask = null;
            }
          },
        );

        try {
          await promiseWithTimeout(backendStartTask, {
            label: "Driver backend startup",
            signal: this.#shutdownController.signal,
            timeoutMs: DRIVER_BACKEND_START_TIMEOUT_MS,
          });
        } catch (error) {
          backendStartController.abort(error);
          throw error;
        }

        if (this.#runtimeState.isShuttingDown()) {
          this.throwTerminalCause();
          return;
        }

        const backendDurationMs = toDurationMs(backendStartedAtMs);
        await logger.span("runtime.socket.ready", async () =>
          socket.ready({ at: new Date().toISOString() }),
        );

        if (this.#runtimeState.isShuttingDown()) {
          this.throwTerminalCause();
          return;
        }

        this.#runtimeState.enter("ready");
        void this.emitDriverBackendTimingEvent(socket, logger, {
          backendDurationMs,
          backendLoadDurationMs,
          completedAt: new Date().toISOString(),
          helloDurationMs,
          initialRunId,
          startedAt: new Date(helloStartedAtMs).toISOString(),
        });

        logger.info("driver.runtime.ready", {
          driverInstanceId: this.payload.driverInstanceId,
          runtime: this.payload.runtime,
        });

        this.#heartbeatLoop.start(socket, logger, hello.heartbeatIntervalMs, (error) => {
          this.rememberTerminalCause(error);
          if (!this.#runtimeState.isShuttingDown()) {
            this.#runtimeState.enter("failed");
          }
          void this.shutdown(socket, "runtime.heartbeat.failed").catch(() => {});
        });
        const commandDispatcher = new DriverCommandDispatcher({
          backend,
          driverInstanceId: this.payload.driverInstanceId,
          isShuttingDown: () => this.#runtimeState.isShuttingDown(),
          permissionRequests: this.#permissionBroker,
          runtimeContextFactory: (_runtimeSocket, runtimeLogger) =>
            this.createAgentDriverContext(socket, runtimeLogger),
          runtimeState: this.#runtimeState,
          sandboxId: this.#startInput.sandboxId,
          shutdownSignal: this.#shutdownController.signal,
          shutdown: async (_runtimeSocket, reason) => this.shutdown(socket, reason),
        });
        await commandDispatcher.run(socket, logger);
        this.throwTerminalCause();
      });
    } catch (error) {
      const shutdownAbort =
        this.#shutdownController.signal.aborted &&
        this.#terminalCause === null &&
        error instanceof Error &&
        error.message === this.#shutdownReason;

      if (!shutdownAbort) {
        this.rememberTerminalCause(error);
        if (!this.#runtimeState.isShuttingDown()) {
          this.#runtimeState.enter("failed");
        }
        await this.reportRunFailure(socket, this.#terminalCause?.error ?? error);
      }
    }

    try {
      await this.finalize(socket);
    } catch (error) {
      if (this.#terminalCause === null) {
        throw error;
      }

      this.#logger?.error("driver.runtime.finalize.failed", error, {
        driverInstanceId: this.payload.driverInstanceId,
      });
    }

    this.throwTerminalCause();
  }

  private registerSignals(socket: DriverInstanceSocket): void {
    const onSigint = () => {
      void this.shutdown(socket, "signal.sigint").catch(() => {});
    };
    const onSigterm = () => {
      void this.shutdown(socket, "signal.sigterm").catch(() => {});
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    this.#unregisterSignals = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
  }

  private shutdown(socket: DriverInstanceSocket, reason: string): Promise<void> {
    return (this.#shutdownTask ??= this.runShutdown(socket, reason).catch((error: unknown) => {
      this.#shutdownTask = null;
      throw error;
    }));
  }

  private async runShutdown(socket: DriverInstanceSocket, reason: string): Promise<void> {
    this.#shutdownReason = reason;
    if (this.#runtimeState.status() !== "failed" && this.#runtimeState.status() !== "stopped") {
      this.#runtimeState.enter("stopping");
    }
    this.#shutdownController.abort(new Error(reason));
    socket.abortConnect(reason);
    socket.abortPendingRequests(reason);

    // If hello never completed, a gated flush may still be pending; open the
    // gate so log teardown cannot hang shutdown.
    this.#logUplink?.open();
    this.#logger?.debug("driver.runtime.shutdown.requested", {
      driverInstanceId: this.payload.driverInstanceId,
      reason,
    });

    this.#heartbeatLoop.stop(this.#logger, reason);
    this.#permissionBroker.rejectAll();

    const logger = this.#logger;
    const backend = this.#backend;
    const backendStartTask = this.#backendStartTask;
    const backendFinalStopTask = this.#backendFinalStopTask;

    if (backendStartTask !== null) {
      this.#backendStartController?.abort(new Error(reason));
      this.#backendStopNeedsReplay = true;
    }

    if (logger && backend && this.#backendStopTask === null) {
      if (backendStartTask === null) {
        this.#backendStopNeedsReplay = false;
      }
      this.stopBackend(socket, logger, backend, reason);
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

    try {
      await promiseWithTimeout(Promise.all(shutdownTasks), {
        label: "Driver backend shutdown",
        timeoutMs: DRIVER_SHUTDOWN_TIMEOUT_MS,
      });

      if (logger && backend && this.#backendStopNeedsReplay) {
        this.#backendStopNeedsReplay = false;
        await promiseWithTimeout(this.stopBackend(socket, logger, backend, reason), {
          label: "Driver final backend shutdown",
          timeoutMs: DRIVER_SHUTDOWN_TIMEOUT_MS,
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
    } catch (error) {
      this.#backendStopController?.abort(error);
      this.#backendStopController = null;
      this.#backendStopTask = null;
      if (this.#backendFinalStopTask === backendFinalStopTask) {
        this.#backendFinalStopTask = null;
      }
      if (logger && backend && backendStartTask && this.#backendStopNeedsReplay) {
        this.scheduleFinalStop(socket, logger, backendStartTask, backend, reason);
      }
      if (this.#runtimeState.status() === "stopping") {
        this.#runtimeState.enter("failed");
      }
      throw error;
    }
  }

  private stopBackend(
    socket: DriverInstanceSocket,
    logger: Logger,
    backend: AgentDriverBackend,
    reason: string,
  ): Promise<void> {
    const controller = new AbortController();
    const task = logger.span("driver.backend.stop", async () => {
      await backend.stop(this.createAgentDriverContext(socket, logger), reason, controller.signal);
    });
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

  private scheduleFinalStop(
    socket: DriverInstanceSocket,
    logger: Logger,
    startTask: Promise<void>,
    backend: AgentDriverBackend,
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
        stopTask = this.stopBackend(socket, logger, backend, reason);
        await promiseWithTimeout(stopTask, {
          label: "Driver deferred backend shutdown",
          timeoutMs: DRIVER_SHUTDOWN_TIMEOUT_MS,
        });

        if (this.#backendFinalStopTask === task && this.#backendStopTask === stopTask) {
          this.#backend = null;
          this.#backendStopController = null;
          this.#backendStopTask = null;
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
        logger.error("driver.runtime.deferred_shutdown.failed", error, {
          driverInstanceId: this.payload.driverInstanceId,
        });
      },
    );
  }

  private async emitDriverBackendTimingEvent(
    socket: DriverRuntimeEventPort,
    logger: Logger,
    input: {
      backendDurationMs: number;
      backendLoadDurationMs: number;
      completedAt: string;
      helloDurationMs: number;
      initialRunId: RunId | null;
      startedAt: string;
    },
  ): Promise<void> {
    try {
      await pushLosslessEvents(socket, [
        createTimingEvent({
          completedAt: input.completedAt,
          path: input.initialRunId === null ? "prewarm" : "cold",
          phases: [
            createTimingPhase("hello", input.helloDurationMs),
            createTimingPhase("backend.load", input.backendLoadDurationMs),
            createTimingPhase("backend.start", input.backendDurationMs),
          ],
          runId: input.initialRunId,
          sessionId: this.#startInput.execution.run.sessionId,
          stage: "driver_backend",
          startedAt: input.startedAt,
        }),
      ]);
    } catch (error) {
      logger.error("driver.runtime.timing_event.failed", error, {
        driverInstanceId: this.payload.driverInstanceId,
      });
    }
  }

  private async reportRunFailure(
    socket: DriverRuntimeEventPort & DriverRuntimeRunPort,
    error: unknown,
  ): Promise<void> {
    if (
      !this.#logger ||
      (this.#shutdownTask !== null &&
        this.#shutdownReason !== "driver.backend_failed" &&
        this.#shutdownReason !== "runtime.heartbeat.failed")
    ) {
      return;
    }

    const message = error instanceof Error ? error.message : "Driver runtime failed.";
    const code = "driver.runtime_failed";
    this.#shutdownReason = code;

    this.#logger.error("driver.runtime.failed", error, {
      driverInstanceId: this.payload.driverInstanceId,
    });

    try {
      await pushDriverDiagnosticEvent(
        socket,
        {
          code,
          details: {
            driverInstanceId: this.payload.driverInstanceId,
          },
          message,
          severity: "error",
          source: "process",
        },
        this.#logger,
      );
      await socket.failRun({
        code,
        details: {},
        message,
        retryable: false,
      });
    } catch (failureError) {
      this.#logger.error("driver.runtime.failure_report_failed", failureError, {
        driverInstanceId: this.payload.driverInstanceId,
      });
    }
  }

  private async finalize(socket: DriverInstanceSocket): Promise<void> {
    let shutdownFailure: { error: unknown } | null = null;
    const shutdownTask = this.#shutdownTask;
    const retrying = shutdownTask === null && this.#shutdownController.signal.aborted;

    try {
      await (shutdownTask ??
        this.shutdown(socket, this.#shutdownReason ?? "runtime.socket.closed"));
    } catch (error) {
      if (retrying) {
        shutdownFailure = { error };
      } else {
        try {
          await this.shutdown(socket, this.#shutdownReason ?? "runtime.socket.closed");
        } catch (retryError) {
          shutdownFailure = { error: retryError };
        }
      }
    }

    try {
      if (this.#logger) {
        this.#logger.debug("driver.runtime.finalizing", {
          driverInstanceId: this.payload.driverInstanceId,
          shutdownReason: this.#shutdownReason ?? "runtime.socket.closed",
        });
        await promiseWithTimeout(this.#logger.destroy(), {
          label: "Driver logger shutdown",
          timeoutMs: DRIVER_SHUTDOWN_TIMEOUT_MS,
        }).catch(() => {});
      }
    } finally {
      this.#unregisterSignals?.();
      this.#unregisterSignals = null;
      socket.close(1000, this.#shutdownReason ?? "runtime.socket.closed");
    }

    if (shutdownFailure !== null) {
      throw shutdownFailure.error;
    }
  }

  private createAgentDriverContext(
    socket: DriverInstanceSocket,
    logger: Logger,
  ): AgentDriverContext {
    return createAgentDriverContext({
      eventSink: socket,
      lifecycle: {
        fail: (error) => this.onBackendFailure(socket, logger, error),
      },
      payload: this.#startInput,
      logger,
      permission: {
        request: createDriverPermissionRequestHandler({
          payload: this.#startInput,
          supervised: async (input, signal) => {
            const generation = this.#runtimeState.beginApproval();

            try {
              return await this.#permissionBroker.request(socket, input, signal);
            } finally {
              this.#runtimeState.endApproval(generation);
            }
          },
        }),
      },
      ports: {
        mcp: {
          execute: async (command, signal) =>
            executeRemoteHttpMcpCommand(this.#startInput, command, signal),
        },
        hostIntegration: {
          snapshot: async () => this.#hostSnapshot,
        },
        skill: {
          materialize: async (execution) => materializeResolvedSkills(execution, logger),
        },
      },
    });
  }

  private onBackendFailure(socket: DriverInstanceSocket, logger: Logger, error: Error): void {
    logger.error("driver.runtime.backend.failed", error, {
      driverInstanceId: this.payload.driverInstanceId,
    });

    if (this.#runtimeState.isShuttingDown()) {
      return;
    }

    this.rememberTerminalCause(error);
    this.#runtimeState.enter("failed");
    void this.shutdown(socket, "driver.backend_failed").catch(() => {});
  }

  private rememberTerminalCause(error: unknown): void {
    this.#terminalCause ??= { error };
  }

  private throwTerminalCause(): void {
    if (this.#terminalCause !== null) {
      throw this.#terminalCause.error;
    }
  }
}
