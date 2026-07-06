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
import { DriverCommandDispatcher } from "./driver-command-dispatcher";
import { pushDriverDiagnosticEvent } from "./driver-diagnostics";
import { DriverHeartbeatLoop } from "./driver-heartbeat-loop";
import { DriverPermissionBroker } from "./driver-permission-broker";
import { createDriverPermissionRequestHandler } from "./driver-permission-policy";
import type { DriverRuntimeEventPort, DriverRuntimeRunPort } from "./driver-runtime-io";
import { DriverRuntimeStateMachine } from "./driver-runtime-state";
import {
  createDriverRuntimeTimingEvent,
  createDriverRuntimeTimingPhase,
  toDriverDurationMs,
} from "./driver-runtime-timing";

const DRIVER_VERSION = "0.1.0";

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
  readonly #hostSnapshot: DriverHostIntegrationSnapshot;
  readonly #runtimeState = new DriverRuntimeStateMachine();
  readonly #startInput: DriverStartInput;
  #shutdownReason: string | null = null;
  #shuttingDown = false;

  constructor(payload: DriverBootPayload, backendFactory: AgentDriverBackendFactory) {
    this.#backendFactory = backendFactory;
    this.payload = payload;
    this.#hostSnapshot = createDriverHostIntegrationSnapshotFromBootExecution(payload.execution);
    this.#startInput = createDriverStartInputFromBootPayload(payload);
    this.#permissionBroker = new DriverPermissionBroker(() => this.#logger);
    this.#heartbeatLoop = new DriverHeartbeatLoop({
      driverInstanceId: payload.driverInstanceId,
      isShuttingDown: () => this.#shuttingDown,
    });
  }

  async run(): Promise<void> {
    const provider = AGENT_DRIVER_PROVIDER_REGISTRY.getByStartInput(this.#startInput);
    const capabilities = createAgentDriverProviderCapabilities({
      permissionRequestStatus: this.#permissionBroker.capabilityStatus(),
      provider,
    });
    let socket!: DriverInstanceSocket;

    socket = new DriverInstanceSocket(this.payload, {
      onClose: (_code, reason) => {
        void this.shutdown(socket, reason || "runtime.socket.closed");
      },
    });

    this.registerSignals(socket);
    await socket.connect();
    const { logger, uplink } = createDriverLogger(this.payload, socket);
    this.#logger = logger;
    this.#logUplink = uplink;

    try {
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
        const helloDurationMs = toDriverDurationMs(helloStartedAtMs);

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
        this.#heartbeatLoop.start(socket, logger, hello.heartbeatIntervalMs);

        const backendLoadStartedAtMs = Date.now();
        const backend = await logger.span("driver.backend.load", async () =>
          this.#backendFactory(this.#startInput),
        );
        this.#backend = backend;
        const backendLoadDurationMs = toDriverDurationMs(backendLoadStartedAtMs);
        const backendStartedAtMs = Date.now();
        await logger.span("driver.backend.start", async () => backend.start(runtimeContext));
        const backendDurationMs = toDriverDurationMs(backendStartedAtMs);
        await logger.span("runtime.socket.ready", async () =>
          socket.ready({ at: new Date().toISOString() }),
        );
        void this.emitDriverBackendTimingEvent(socket, logger, {
          backendDurationMs,
          backendLoadDurationMs,
          completedAtMs: Date.now(),
          helloDurationMs,
          initialRunId,
          startedAtMs: helloStartedAtMs,
        });

        logger.info("driver.runtime.ready", {
          driverInstanceId: this.payload.driverInstanceId,
          runtime: this.payload.runtime,
        });

        const commandDispatcher = new DriverCommandDispatcher({
          backend,
          driverInstanceId: this.payload.driverInstanceId,
          isShuttingDown: () => this.#shuttingDown,
          permissionRequests: this.#permissionBroker,
          runtimeContextFactory: (runtimeSocket, runtimeLogger) =>
            this.createAgentDriverContext(runtimeSocket, runtimeLogger),
          runtimeState: this.#runtimeState,
          sandboxId: this.#startInput.sandboxId,
          shutdown: async (runtimeSocket, reason) => this.shutdown(runtimeSocket, reason),
        });
        await commandDispatcher.run(socket, logger);
      });
    } catch (error) {
      await this.reportRunFailure(socket, error);
      throw error;
    } finally {
      await this.finalize(socket);
    }
  }

  private registerSignals(socket: DriverInstanceSocket): void {
    process.once("SIGINT", () => {
      void this.shutdown(socket, "signal.sigint");
    });

    process.once("SIGTERM", () => {
      void this.shutdown(socket, "signal.sigterm");
    });
  }

  private async shutdown(socket: DriverRuntimeEventPort, reason: string): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }

    this.#shuttingDown = true;
    this.#shutdownReason = reason;
    // If hello never completed, a gated flush may still be pending; open the
    // gate so log teardown cannot hang shutdown.
    this.#logUplink?.open();
    this.#logger?.debug("driver.runtime.shutdown.requested", {
      driverInstanceId: this.payload.driverInstanceId,
      reason,
    });

    this.#heartbeatLoop.stop(this.#logger, reason);
    this.#permissionBroker.rejectAll();
    if (this.#runtimeState.status() !== "failed" && this.#runtimeState.status() !== "stopped") {
      this.#runtimeState.enter("stopped");
    }

    const logger = this.#logger;
    const backend = this.#backend;

    if (logger && backend) {
      await logger.span("driver.backend.stop", async () => {
        await backend.stop(this.createAgentDriverContext(socket, logger), reason);
      });
    }
  }

  private async emitDriverBackendTimingEvent(
    socket: DriverRuntimeEventPort,
    logger: Logger,
    input: {
      backendDurationMs: number;
      backendLoadDurationMs: number;
      completedAtMs: number;
      helloDurationMs: number;
      initialRunId: RunId | null;
      startedAtMs: number;
    },
  ): Promise<void> {
    try {
      await socket.pushEvents({
        events: [
          createDriverRuntimeTimingEvent({
            completedAtMs: input.completedAtMs,
            path: input.initialRunId === null ? "prewarm" : "cold",
            phases: [
              createDriverRuntimeTimingPhase("hello", input.helloDurationMs),
              createDriverRuntimeTimingPhase("backend.load", input.backendLoadDurationMs),
              createDriverRuntimeTimingPhase("backend.start", input.backendDurationMs),
            ],
            runId: input.initialRunId,
            sessionId: this.#startInput.execution.run.sessionId,
            stage: "driver_backend",
            startedAtMs: input.startedAtMs,
          }),
        ],
      });
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
    if (this.#shuttingDown || !this.#logger) {
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
    if (!this.#shuttingDown) {
      await this.shutdown(socket, this.#shutdownReason ?? "runtime.socket.closed");
    }

    if (this.#logger) {
      this.#logger.debug("driver.runtime.finalizing", {
        driverInstanceId: this.payload.driverInstanceId,
        shutdownReason: this.#shutdownReason ?? "runtime.socket.closed",
      });
      await this.#logger.flush();
      await this.#logger.destroy();
    }

    socket.close(1000, this.#shutdownReason ?? "runtime.socket.closed");
  }

  private createAgentDriverContext(
    socket: DriverRuntimeEventPort,
    logger: Logger,
  ): AgentDriverContext {
    return createAgentDriverContext({
      eventSink: socket,
      payload: this.#startInput,
      logger,
      permission: {
        request: createDriverPermissionRequestHandler({
          payload: this.#startInput,
          supervised: async (input) => {
            this.#runtimeState.enter("needs_approval");

            try {
              return await this.#permissionBroker.request(socket, input);
            } finally {
              if (this.#runtimeState.status() === "needs_approval") {
                this.#runtimeState.enter("running");
              }
            }
          },
        }),
      },
      ports: {
        mcp: {
          execute: async (command) => executeRemoteHttpMcpCommand(this.#startInput, command),
        },
        hostIntegration: {
          snapshot: async () => this.#hostSnapshot,
        },
        lifecycle: {
          shutdown: async (reason) => this.shutdown(socket, reason),
        },
        skill: {
          materialize: async (execution) => materializeResolvedSkills(execution, logger),
        },
      },
    });
  }
}
