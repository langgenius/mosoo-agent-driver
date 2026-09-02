import type { AgentDriverBackendFactory, AgentDriverContext } from "../core/agent-driver-backend";
import { createAgentDriverContext } from "../core/agent-driver-backend";
import { AgentBackendLifecycle } from "../core/agent-backend-lifecycle";
import { DriverCommandDispatcher } from "../core/driver-command-dispatcher";
import { deliverRunTerminal } from "../core/driver-command-delivery";
import type { RunTerminalUpdate } from "../core/driver-command-delivery";
import { pushDriverDiagnosticEvent } from "../core/driver-diagnostics";
import { DriverHeartbeatLoop } from "../core/driver-heartbeat-loop";
import { DriverPermissionBroker } from "../core/driver-permission-broker";
import { createDriverPermissionRequestHandler } from "../core/driver-permission-policy";
import { pushLosslessEvents } from "../core/driver-runtime-io";
import type { DriverRuntimeEventPort } from "../core/driver-runtime-io";
import { DriverRuntimeStateMachine } from "../core/driver-runtime-state";
import { createTimingEvent, createTimingPhase, toDurationMs } from "../core/driver-runtime-timing";
import { AGENT_DRIVER_VERSION } from "../core/version";
import {
  createDriverLogger,
  runWithDriverLogContext,
} from "../infrastructure/logging/driver-logger";
import type { DriverLogUplink } from "../infrastructure/logging/driver-logger";
import { DriverInstanceSocket } from "../infrastructure/runtime/driver-instance-socket";
import type { Logger } from "../observability";
import { summarizeDriverBootPayload } from "../observability/driver-debug";
import { DRIVER_PROTOCOL_VERSION } from "../protocol/boot";
import type { DriverBootPayload } from "../protocol/boot";
import { parseRunId } from "../protocol/id";
import type { RunId } from "../protocol/id";
import { createDriverStartInputFromBootPayload } from "../protocol/start";
import type { DriverStartInput } from "../protocol/start";
import type { RunError } from "../runtime-command";
import { prepareRemoteHttpMcpCommand } from "../runtimes/mcp/remote-http-mcp-executor";
import {
  AGENT_DRIVER_PROVIDER_REGISTRY,
  createAgentDriverProviderCapabilities,
} from "../runtimes/provider-registry";
import { materializeResolvedSkills } from "../runtimes/skill-materialization";
import { promiseWithTimeout } from "../utils/async";

const DRIVER_BACKEND_START_TIMEOUT_MS = 60_000;
const DRIVER_SHUTDOWN_TIMEOUT_MS = 5_000;

export class DriverProcess {
  readonly #startedAt = new Date().toISOString();
  readonly #backendFactory: AgentDriverBackendFactory;
  readonly #heartbeatLoop: DriverHeartbeatLoop;
  #backendLifecycle: AgentBackendLifecycle | null = null;
  #logger: Logger | null = null;
  #logUplink: DriverLogUplink | null = null;
  #pendingRunTerminal: RunTerminalUpdate | null = null;
  private readonly payload: DriverBootPayload;
  readonly #permissionBroker: DriverPermissionBroker;
  readonly #shutdownController = new AbortController();
  readonly #runtimeState = new DriverRuntimeStateMachine("created");
  readonly #startInput: DriverStartInput;
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

        this.rememberTerminalCause(new Error(reason || "runtime.socket.closed"));
        if (!this.#runtimeState.isShuttingDown()) {
          this.#runtimeState.enter("failed");
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
          driverVersion: AGENT_DRIVER_VERSION,
          protocolVersion: DRIVER_PROTOCOL_VERSION,
          startedAt: this.#startedAt,
        });

        const helloStartedAtMs = Date.now();
        const hello = await logger.span("runtime.socket.hello", async () =>
          socket.hello({
            capabilities: [...capabilities],
            driverVersion: AGENT_DRIVER_VERSION,
            protocolVersion: DRIVER_PROTOCOL_VERSION,
            startedAt: this.#startedAt,
          }),
        );
        const initialRunId = hello.runId === null ? null : parseRunId(hello.runId);
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

        const backendLoadStartedAtMs = Date.now();
        const backend = await logger.span("driver.backend.load", async () => {
          this.#shutdownController.signal.throwIfAborted();
          return this.#backendFactory(this.#startInput);
        });

        if (this.#runtimeState.isShuttingDown()) {
          this.throwTerminalCause();
          return;
        }

        const backendLoadDurationMs = toDurationMs(backendLoadStartedAtMs);
        const backendStartedAtMs = Date.now();
        const lifecycle = new AgentBackendLifecycle({
          backend,
          createContext: () => this.createAgentDriverContext(socket, logger),
          labels: {
            finalStop: "Driver final backend shutdown",
            start: "Driver backend startup",
            stop: "Driver backend shutdown",
          },
          onDeferredStopError: (error) => {
            logger.error("driver.runtime.deferred_shutdown.failed", error, {
              driverInstanceId: this.payload.driverInstanceId,
            });
          },
          runStart: (loadedBackend, context, signal) =>
            logger.span("driver.backend.start", async () => loadedBackend.start(context, signal)),
          runStop: (loadedBackend, context, reason, signal) =>
            logger.span("driver.backend.stop", async () =>
              loadedBackend.stop(context, reason, signal),
            ),
          shutdownSignal: this.#shutdownController.signal,
          startTimeoutMs: DRIVER_BACKEND_START_TIMEOUT_MS,
          stopTimeoutMs: DRIVER_SHUTDOWN_TIMEOUT_MS,
        });
        this.#backendLifecycle = lifecycle;
        await lifecycle.start();

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
          rememberRunFailure: (error) => {
            this.rememberPendingRunTerminal({ error, status: "failed" });
            this.rememberTerminalCause(new Error(error.message, { cause: error }));
          },
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
        const failure = this.#terminalCause?.error ?? error;
        this.rememberPendingRunTerminal({
          error: {
            code: "driver.runtime_failed",
            details: {},
            message: failure instanceof Error ? failure.message : "Driver runtime failed.",
            retryable: false,
          },
          status: "failed",
        });
        if (!this.#runtimeState.isShuttingDown()) {
          this.#runtimeState.enter("failed");
        }
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
    if (
      socket.currentRunId() !== null &&
      (reason === "signal.sigint" || reason === "signal.sigterm")
    ) {
      this.rememberPendingRunTerminal({ status: "completed" });
    }
    if (this.#runtimeState.status() !== "failed" && this.#runtimeState.status() !== "stopped") {
      this.#runtimeState.enter("stopping");
    }
    const permissionCancellation = this.#permissionBroker.rejectAllAndWait();
    this.#shutdownController.abort(new Error(reason));
    socket.abortConnect(reason);
    // Backend cleanup owns lossless terminal and committed-file reports, so the
    // RPC lane remains open until that ownership barrier settles.

    // If hello never completed, a gated flush may still be pending; open the
    // gate so log teardown cannot hang shutdown.
    this.#logUplink?.open();
    this.#logger?.debug("driver.runtime.shutdown.requested", {
      driverInstanceId: this.payload.driverInstanceId,
      reason,
    });

    this.#heartbeatLoop.stop(this.#logger, reason);

    try {
      const [permissionResult] = await Promise.allSettled([permissionCancellation]);
      const [backendResult] = await Promise.allSettled([this.#backendLifecycle?.shutdown(reason)]);
      socket.abortPendingRequests(reason);

      if (permissionResult.status === "rejected") {
        throw permissionResult.reason;
      }
      if (backendResult.status === "rejected") {
        throw backendResult.reason;
      }

      if (this.#runtimeState.status() === "stopping") {
        this.#runtimeState.enter("stopped");
      }
      this.#backendLifecycle = null;
    } catch (error) {
      if (this.#runtimeState.status() === "stopping") {
        this.#runtimeState.enter("failed");
      }
      throw error;
    }
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

  private async reportRunFailure(socket: DriverInstanceSocket, error: RunError): Promise<void> {
    if (!this.#logger) {
      return;
    }

    this.#shutdownReason = error.code;
    this.#logger.error("driver.runtime.failed", error, {
      driverInstanceId: this.payload.driverInstanceId,
    });

    try {
      await pushDriverDiagnosticEvent(
        socket,
        {
          code: "driver.runtime_failed",
          details: {
            driverInstanceId: this.payload.driverInstanceId,
          },
          message: error.message,
          severity: "error",
          source: "process",
        },
        this.#logger,
      );
    } catch (failureError) {
      this.#logger.error("driver.runtime.failure_report_failed", failureError, {
        driverInstanceId: this.payload.driverInstanceId,
      });
    }
    await deliverRunTerminal(socket, {
      error: structuredClone(error),
      status: "failed",
    });
  }

  private async finalize(socket: DriverInstanceSocket): Promise<void> {
    let shutdownFailure: { error: unknown } | null = null;
    let terminalFailure: { error: unknown } | null = null;
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

    if (this.#pendingRunTerminal !== null && shutdownFailure === null) {
      try {
        if (this.#pendingRunTerminal.status === "failed") {
          await this.reportRunFailure(socket, this.#pendingRunTerminal.error);
        } else {
          await deliverRunTerminal(socket, this.#pendingRunTerminal);
        }
      } catch (error) {
        terminalFailure = { error };
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
    if (terminalFailure !== null) {
      throw terminalFailure.error;
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
            if (generation === null) {
              return "reject_once";
            }

            try {
              return await this.#permissionBroker.request(socket, input, signal, () =>
                this.#runtimeState.ownsRun(generation),
              );
            } finally {
              this.#runtimeState.endApproval(generation);
            }
          },
        }),
      },
      ports: {
        mcp: {
          prepare: (command, signal) =>
            prepareRemoteHttpMcpCommand(this.#startInput, command, signal, logger),
        },
        skill: {
          materialize: async (execution, signal) =>
            materializeResolvedSkills(execution, logger, signal),
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

  private rememberPendingRunTerminal(terminal: RunTerminalUpdate): void {
    if (this.#pendingRunTerminal?.status === "failed") {
      return;
    }
    this.#pendingRunTerminal = structuredClone(terminal);
  }

  private throwTerminalCause(): void {
    if (this.#terminalCause !== null) {
      throw this.#terminalCause.error;
    }
  }
}
