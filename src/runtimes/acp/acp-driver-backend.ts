import { Readable, Writable } from "node:stream";

import {
  client as createAcpClient,
  methods as acpMethods,
  ndJsonStream,
  RequestError,
} from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  ClientConnection,
  ClientContext,
  InitializeResponse,
} from "@agentclientprotocol/sdk";

import type { AgentDriverBackend, AgentDriverContext } from "../../core/agent-driver-backend";
import { AGENT_DRIVER_VERSION } from "../../core/version";
import { summarizePath, summarizePathCollection } from "../../observability/driver-debug";
import type { DriverEventInput } from "../../protocol/events";
import type { DriverHostIntegrationSnapshot } from "../../protocol/host-integration";
import type { RunId } from "../../protocol/id";
import type { DriverRuntime } from "../../protocol/runtime";
import type { DriverStartInput } from "../../protocol/start";
import type { RuntimeCommandInput } from "../../runtime-command";
import { raceWithAbort, settlePromiseWithTimeout } from "../../utils/async";
import { DriverEventPublisher } from "../driver-event-publisher";
import {
  buildRuntimeBootstrapText,
  computeRuntimeBootstrapDigest,
  writeNativeRuntimeSystemPrompt,
  writeSkillBootstrapArtifacts,
} from "../skill-bootstrap";
import { startAcpAgentProcess, stopAcpAgentProcess } from "./acp-agent-process";
import type { AcpAgentProcess } from "./acp-agent-process";
import { AcpClientRequestHandler } from "./acp-client-request-handler";
import {
  ACP_PROTOCOL_VERSION,
  appendOpenCodeInstruction,
  buildChildEnv,
  buildClientCapabilities,
  assertProtocolVersion,
  isOpenCodeCommand,
  readFallbackCommand,
  readResumeId,
  resolveAuthMethod,
  supportsSessionClose,
} from "./acp-configuration";
import { toAuthEvent, toInitializeEvents, toSessionReadyEvents } from "./acp-event-translator";
import { limitAcpInput } from "./acp-input-limit";
import { setupAcpSession } from "./acp-session-setup";
import { withAcpStartupStage } from "./acp-startup";
import { AcpTurnController } from "./acp-turn-controller";

const ACP_STOP_BUDGET_MS = 4_000;
const ACP_SESSION_SHUTDOWN_TIMEOUT_MS = 750;
const ACP_UPDATE_DRAIN_TIMEOUT_MS = 750;

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export { limitAcpInput } from "./acp-input-limit";

export class AcpDriverBackend implements AgentDriverBackend {
  readonly runtime: DriverRuntime = "acp-fallback";
  #agentCapabilities: AgentCapabilities | null = null;
  #agentProcess: AcpAgentProcess | null = null;
  readonly #childProcessEnv: Record<string, string>;
  readonly #clientRequests: AcpClientRequestHandler;
  #connection: ClientConnection | null = null;
  readonly #eventPublisher = new DriverEventPublisher(this.runtime, () => this.#nativeSessionId);
  #hostSnapshot: DriverHostIntegrationSnapshot | null = null;
  #nativeSessionId: string | null = null;
  readonly #payload: DriverStartInput;
  readonly #runtimeBootstrapDigest: string | null;
  readonly #runtimeBootstrapText: string;
  #stopRequested = false;
  #stopTask: Promise<void> | null = null;
  readonly #turnController: AcpTurnController;

  constructor(payload: DriverStartInput) {
    this.#payload = payload;
    this.#childProcessEnv = buildChildEnv(payload);
    this.#nativeSessionId = readResumeId(payload);
    this.#runtimeBootstrapDigest = computeRuntimeBootstrapDigest(payload.execution);
    this.#runtimeBootstrapText = buildRuntimeBootstrapText(payload.execution);
    this.#turnController = new AcpTurnController((context, reason, events) =>
      this.#push(context, reason, events),
    );
    this.#clientRequests = new AcpClientRequestHandler({
      allowedRoots: payload.execution.session.additionalDirectories,
      cwd: payload.execution.session.cwd,
      env: this.#childProcessEnv,
      isCancelling: () => this.#turnController.isCancelling(),
      nativeSessionId: () => this.#nativeSessionId,
      onUpdateFailure: (error) => this.#connection?.close(error),
      push: async (context, reason, events) => this.#push(context, reason, events),
      turnEvents: this.#turnController.events,
    });
  }

  async start(context: AgentDriverContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#stopRequested) {
      throw new Error("ACP driver backend cannot restart after stopping.");
    }

    const hostSnapshot = await raceWithAbort(context.ports.hostIntegration.snapshot(), signal);

    if (hostSnapshot === null) {
      throw new Error("ACP fallback requires a host integration snapshot.");
    }

    this.#hostSnapshot = hostSnapshot;
    const materializedSkills = await raceWithAbort(
      context.ports.skill.materialize(this.#payload.execution),
      signal,
    );
    const bootstrapArtifacts = await raceWithAbort(
      writeSkillBootstrapArtifacts(this.#payload.execution),
      signal,
    );
    const command = readFallbackCommand();
    const nativeInstructionPath = isOpenCodeCommand(command)
      ? await raceWithAbort(writeNativeRuntimeSystemPrompt(this.#payload.execution), signal)
      : null;

    if (this.#stopRequested || signal.aborted) {
      signal.throwIfAborted();
      throw new Error("ACP driver backend stopped during startup.");
    }

    const env =
      nativeInstructionPath === null
        ? this.#childProcessEnv
        : appendOpenCodeInstruction(this.#childProcessEnv, nativeInstructionPath);
    const agentProcess = await startAcpAgentProcess(context, this.#payload, env, signal);
    this.#agentProcess = agentProcess;

    try {
      signal.throwIfAborted();
      if (this.#stopRequested) {
        throw new Error("ACP driver backend stopped during startup.");
      }

      const app = createAcpClient({ name: "mosoo-driver" })
        .onNotification(acpMethods.client.session.update, ({ params }) =>
          this.#clientRequests.enqueueUpdate(context, params),
        )
        .onRequest(acpMethods.client.session.requestPermission, ({ params, requestId, signal }) =>
          this.#serveRequest(signal, (requestSignal) =>
            this.#clientRequests.requestPermission(context, requestId, params, requestSignal),
          ),
        )
        .onRequest(acpMethods.client.fs.readTextFile, ({ params, signal }) =>
          this.#serveRequest(signal, (requestSignal) =>
            this.#clientRequests.readTextFile(params, requestSignal),
          ),
        )
        .onRequest(acpMethods.client.fs.writeTextFile, ({ params, signal }) =>
          this.#serveRequest(signal, (requestSignal) =>
            this.#clientRequests.writeTextFile(context, params, requestSignal),
          ),
        )
        .onRequest(acpMethods.client.terminal.create, ({ params, signal }) =>
          this.#serveRequest(signal, (requestSignal) =>
            this.#clientRequests.createTerminal(context, params, requestSignal),
          ),
        )
        .onRequest(acpMethods.client.terminal.kill, ({ params, signal }) =>
          this.#serveRequest(signal, (requestSignal) =>
            this.#clientRequests.killTerminal(context, params, requestSignal),
          ),
        )
        .onRequest(acpMethods.client.terminal.output, ({ params, signal }) =>
          this.#serveRequest(signal, (requestSignal) =>
            this.#clientRequests.terminalOutput(params, requestSignal),
          ),
        )
        .onRequest(acpMethods.client.terminal.release, ({ params, signal }) =>
          this.#serveRequest(signal, (requestSignal) =>
            this.#clientRequests.releaseTerminal(context, params, requestSignal),
          ),
        )
        .onRequest(acpMethods.client.terminal.waitForExit, ({ params, signal }) =>
          this.#serveRequest(signal, (requestSignal) =>
            this.#clientRequests.waitForTerminalExit(params, requestSignal),
          ),
        );
      const output = Writable.toWeb(agentProcess.stdin) as WritableStream<Uint8Array>;
      const input = limitAcpInput(
        Readable.toWeb(agentProcess.stdout) as unknown as ReadableStream<Uint8Array>,
      );
      const connection = app.connect(ndJsonStream(output, input));
      this.#connection = connection;
      void connection.closed.then(() => {
        if (this.#stopRequested || this.#connection !== connection) {
          return;
        }

        const reason = connection.signal.reason;
        const error =
          reason instanceof Error ? reason : new Error("ACP transport closed unexpectedly.");
        context.logger.error("driver.acp.transport.failed", error, {});
        context.lifecycle.fail(error);
      });

      const initResult = await withAcpStartupStage(
        "ACP initialize",
        () =>
          connection.agent.request(
            acpMethods.agent.initialize,
            {
              clientCapabilities: buildClientCapabilities(),
              clientInfo: {
                name: "mosoo-driver",
                title: "mosoo Driver",
                version: AGENT_DRIVER_VERSION,
              },
              protocolVersion: ACP_PROTOCOL_VERSION,
            },
            { cancellationSignal: signal },
          ),
        signal,
      );
      assertProtocolVersion(initResult);
      this.#agentCapabilities = initResult.agentCapabilities ?? null;
      await withAcpStartupStage(
        "ACP initialize event push",
        () => this.#push(context, "driver.acp.initialize", toInitializeEvents(initResult)),
        signal,
      );
      await withAcpStartupStage(
        "ACP authentication",
        () => this.#authenticate(context, initResult, env, signal),
        signal,
      );
      const setup = await withAcpStartupStage(
        "ACP session setup",
        () => this.#setupSession(signal),
        signal,
      );

      if (setup.droppedAdditionalDirectories.length > 0) {
        context.logger.warn("driver.acp.session.additional_directories_dropped", {
          count: setup.droppedAdditionalDirectories.length,
          reason: "agent_capability_missing",
        });
      }

      await withAcpStartupStage(
        "ACP session ready event push",
        () =>
          this.#push(
            context,
            `driver.acp.session.${setup.mode}`,
            toSessionReadyEvents({
              mode: setup.mode,
              nativeSessionId: setup.sessionId,
              setup: setup.raw,
            }),
          ),
        signal,
      );

      if (setup.mode === "created" && nativeInstructionPath === null) {
        await withAcpStartupStage(
          "ACP runtime bootstrap",
          () => this.#applyBootstrap(context, signal),
          signal,
        );
      }

      context.logger.info("driver.acp.runtime.started", {
        bootstrapArtifacts,
        bootstrapDigest: this.#runtimeBootstrapDigest,
        execution: {
          additionalDirectories: summarizePathCollection(
            this.#payload.execution.session.additionalDirectories,
          ),
          cwd: summarizePath(this.#payload.execution.session.cwd),
          homePath: summarizePath(this.#payload.execution.session.homePath),
          sharedRootPath: summarizePath(this.#payload.execution.session.sharedRootPath),
        },
        nativeInstructions: nativeInstructionPath !== null,
        nativeResumeRefPresent: this.#nativeSessionId !== null,
        skillCount: materializedSkills.length,
      });
    } catch (error) {
      if (signal.aborted) {
        this.#stopRequested = true;
        this.#connection?.close(
          signal.reason instanceof Error ? signal.reason : new Error("ACP startup aborted."),
        );
        signal.throwIfAborted();
      }

      await this.stop(context, "startup.failed", signal).catch((cleanupError: unknown) => {
        context.logger.warn("driver.acp.startup.cleanup.failed", {
          message: toErrorMessage(cleanupError, "startup cleanup failed"),
        });
      });
      throw error;
    }
  }

  async handleInput(
    context: AgentDriverContext,
    input: RuntimeCommandInput,
    runId: RunId,
  ): Promise<void> {
    await this.#turnController.handleInput(
      context,
      input,
      runId,
      this.#requireConnection(),
      this.#requireSessionId(),
      this.#requireHostSnapshot(),
      this.#clientRequests,
    );
  }

  async cancelActiveTurn(context: AgentDriverContext, reason: string): Promise<void> {
    await this.#turnController.cancel(
      context,
      reason,
      this.#connection?.agent ?? null,
      this.#nativeSessionId,
    );
  }

  stop(context: AgentDriverContext, reason: string, signal: AbortSignal): Promise<void> {
    this.#stopRequested = true;
    if (this.#stopTask !== null) {
      return this.#stopTask;
    }

    const task = this.#performStop(context, reason, signal).finally(() => {
      if (this.#stopTask === task) {
        this.#stopTask = null;
      }
    });
    this.#stopTask = task;
    return task;
  }

  async #performStop(
    context: AgentDriverContext,
    reason: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + ACP_STOP_BUDGET_MS;
    this.#turnController.abort("ACP driver backend stopped.");
    const terminalCleanupTask = settlePromiseWithTimeout(
      this.#clientRequests.stopTerminals(context),
      {
        label: "ACP terminal cleanup",
        signal,
        timeoutMs: this.#remainingStopMs(deadline),
      },
    );
    const sessionId = this.#nativeSessionId;
    const transport = this.#connection;
    const connection = transport?.agent;

    if (connection !== undefined && transport !== null && sessionId !== null) {
      const closeSupported = supportsSessionClose(this.#agentCapabilities);
      const shutdownTimeoutMs = Math.min(
        ACP_SESSION_SHUTDOWN_TIMEOUT_MS,
        this.#remainingStopMs(deadline),
      );
      const shutdown = async () => {
        if (closeSupported) {
          await connection.request(
            acpMethods.agent.session.close,
            { sessionId },
            {
              cancellationSignal: AbortSignal.any([signal, AbortSignal.timeout(shutdownTimeoutMs)]),
            },
          );
          return;
        }

        await connection.notify(acpMethods.agent.session.cancel, { sessionId });
      };
      const result = await settlePromiseWithTimeout(shutdown(), {
        label: "ACP session shutdown",
        signal,
        timeoutMs: shutdownTimeoutMs,
      });

      if (result.status !== "completed") {
        context.logger.warn(
          closeSupported ? "driver.acp.session.close.failed" : "driver.acp.session.cancel.failed",
          {
            message: toErrorMessage(result.error, "session shutdown failed"),
            reason,
            sessionId,
          },
        );
      }
    }

    const updateDrain = await settlePromiseWithTimeout(this.#clientRequests.closeUpdates(), {
      label: "ACP update drain",
      signal,
      timeoutMs: Math.min(ACP_UPDATE_DRAIN_TIMEOUT_MS, this.#remainingStopMs(deadline)),
    });

    if (updateDrain.status !== "completed") {
      context.logger.warn("driver.acp.updates.drain.failed", {
        message: toErrorMessage(updateDrain.error, "update drain failed"),
        reason,
      });
    }

    transport?.close(new Error("ACP driver backend stopped."));
    if (this.#connection === transport) {
      this.#connection = null;
    }
    const agentProcess = this.#agentProcess;
    let processFailure: { error: unknown } | null = null;

    try {
      if (agentProcess !== null) {
        await stopAcpAgentProcess(context, agentProcess, reason, deadline, signal);
      }

      if (this.#agentProcess === agentProcess) {
        this.#agentProcess = null;
      }
    } catch (error) {
      processFailure = { error };
    }

    const terminalCleanup = await terminalCleanupTask;

    if (terminalCleanup.status !== "completed") {
      context.logger.warn("driver.acp.terminals.stop.failed", {
        message: toErrorMessage(terminalCleanup.error, "terminal cleanup failed"),
        reason,
      });
    }

    if (processFailure !== null) {
      throw processFailure.error;
    }

    if (updateDrain.status !== "completed") {
      throw updateDrain.error;
    }

    if (terminalCleanup.status !== "completed") {
      throw terminalCleanup.error;
    }
  }

  async #applyBootstrap(context: AgentDriverContext, signal: AbortSignal): Promise<void> {
    if (this.#runtimeBootstrapText.trim().length === 0) {
      return;
    }

    const connection = this.#requireConnection();
    const sessionId = this.#requireSessionId();

    await this.#clientRequests.suppressUpdates(async () => {
      signal.throwIfAborted();
      context.logger.info("driver.acp.bootstrap.sending", {
        bootstrapDigest: this.#runtimeBootstrapDigest,
        sessionId,
        textLength: this.#runtimeBootstrapText.length,
      });
      await connection.request(
        acpMethods.agent.session.prompt,
        {
          prompt: [{ text: this.#runtimeBootstrapText, type: "text" }],
          sessionId,
        },
        { cancellationSignal: signal },
      );
      signal.throwIfAborted();
      context.logger.info("driver.acp.bootstrap.completed", {
        bootstrapDigest: this.#runtimeBootstrapDigest,
        sessionId,
      });
    });
  }

  async #authenticate(
    context: AgentDriverContext,
    result: InitializeResponse,
    env: Record<string, string>,
    signal: AbortSignal,
  ): Promise<void> {
    const methodId = resolveAuthMethod(result.authMethods ?? [], env);

    if (methodId === null) {
      return;
    }

    try {
      signal.throwIfAborted();
      await this.#requireConnection().request(
        acpMethods.agent.authenticate,
        { methodId },
        { cancellationSignal: signal },
      );
      signal.throwIfAborted();
      await this.#push(context, "driver.acp.auth.authenticated", [
        toAuthEvent({ methodId, status: "authenticated" }),
      ]);
    } catch (error) {
      signal.throwIfAborted();
      await this.#push(context, "driver.acp.auth.failed", [
        toAuthEvent({ methodId, status: "failed" }),
      ]);
      throw error;
    }
  }

  #push(context: AgentDriverContext, reason: string, events: DriverEventInput[]): Promise<void> {
    return this.#eventPublisher.push(context, reason, events);
  }

  #requireConnection(): ClientContext {
    if (this.#connection === null) {
      throw new Error("ACP driver backend connection is not initialized.");
    }

    return this.#connection.agent;
  }

  #requireSessionId(): string {
    if (this.#nativeSessionId === null) {
      throw new Error("ACP driver backend session is not initialized.");
    }

    return this.#nativeSessionId;
  }

  #requireHostSnapshot(): DriverHostIntegrationSnapshot {
    if (this.#hostSnapshot === null) {
      throw new Error("ACP driver backend host integration snapshot is not initialized.");
    }

    return this.#hostSnapshot;
  }

  #remainingStopMs(deadline: number): number {
    return Math.max(0, deadline - Date.now());
  }

  #requestSignal(signal: AbortSignal): AbortSignal {
    const turnSignal = this.#turnController.activeSignal();
    return turnSignal === undefined ? signal : AbortSignal.any([signal, turnSignal]);
  }

  async #serveRequest<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T> | T,
  ): Promise<T> {
    const requestSignal = this.#requestSignal(signal);

    try {
      return await operation(requestSignal);
    } catch (error) {
      if (requestSignal.aborted) {
        throw RequestError.requestCancelled();
      }

      throw error;
    }
  }

  async #setupSession(signal: AbortSignal): Promise<Awaited<ReturnType<typeof setupAcpSession>>> {
    const hostSnapshot = this.#requireHostSnapshot();
    signal.throwIfAborted();
    const setup = await raceWithAbort(
      setupAcpSession({
        agentCapabilities: this.#agentCapabilities,
        connection: this.#requireConnection(),
        currentSessionId: this.#nativeSessionId,
        payload: this.#payload,
        sessionContext: hostSnapshot.sessionContext,
        replaySession: async (operation) => this.#clientRequests.withSessionReplay(operation),
      }),
      signal,
    );
    signal.throwIfAborted();
    this.#nativeSessionId = setup.sessionId;
    await raceWithAbort(this.#clientRequests.drainUpdates(), signal);

    return setup;
  }
}
