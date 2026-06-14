import { DriverTurnCancelledError } from "../../core/driver-runtime-state";
import type { AgentDriverMaterializedSkill } from "../../host-ports";
import {
  summarizeAppAccessSnapshot,
  summarizePath,
  summarizePathCollection,
  summarizeRuntimeCommandInput,
} from "../../infrastructure/logging/driver-debug";
import type { DriverAppAccessSnapshotOutput } from "../../protocol/boot";
import type { DriverEventInput } from "../../protocol/events";
import type { DriverHostIntegrationSnapshot } from "../../protocol/host-integration";
import { createDriverId } from "../../protocol/id";
import type { MessageId, RunId } from "../../protocol/id";
import type { DriverRuntime } from "../../protocol/runtime";
import type { DriverStartInput } from "../../protocol/start";
import type { McpExecuteCommand, RuntimeCommandInput } from "../../runtime-command";
import type { AgentDriverBackend, AgentDriverContext } from "../agent-driver-backend";
import { DriverEventPublisher } from "../driver-event-publisher";
import {
  buildRuntimeBootstrapText,
  computeRuntimeBootstrapDigest,
  writeSkillBootstrapArtifacts,
} from "../skill-bootstrap";
import { startAcpAgentProcess, stopAcpAgentProcess } from "./acp-agent-process";
import type { AcpAgentProcess } from "./acp-agent-process";
import { AcpClientRequestHandler } from "./acp-client-request-handler";
import {
  ACP_PROTOCOL_VERSION,
  buildAcpChildProcessEnv,
  buildAcpClientCapabilities,
  enforceAcpProtocolVersion,
  readAcpNativeResumeSessionId,
  resolveAcpAuthMethodId,
  supportsAcpSessionClose,
  toAcpRequestMeta,
} from "./acp-configuration";
import {
  AcpTurnEventState,
  toAcpAuthSessionEvent,
  toAcpInitializeEvents,
  toAcpPromptStartEvents,
  toAcpSessionReadyEvents,
} from "./acp-event-translator";
import { AcpJsonRpcConnection } from "./acp-json";
import { setupAcpSession } from "./acp-session-setup";
import { parseAcpInitializeResult, parseAcpPromptResult } from "./acp-types";
import type { AcpInitializeResult, AcpPromptStopReason, JsonObject } from "./acp-types";

interface ActiveAcpTurn {
  cancelRequested: boolean;
  readonly runId: RunId;
}

class AcpPromptTerminalError extends Error {
  constructor(stopReason: AcpPromptStopReason) {
    super(`ACP prompt stopped with terminal stop reason: ${stopReason}.`);
    this.name = "AcpPromptTerminalError";
  }
}

export class AcpDriverBackend implements AgentDriverBackend {
  readonly runtime: DriverRuntime = "acp-fallback";
  #activeTurn: ActiveAcpTurn | null = null;
  #agentCapabilities: JsonObject | null = null;
  #agentProcess: AcpAgentProcess | null = null;
  readonly #clientRequests: AcpClientRequestHandler;
  #connection: AcpJsonRpcConnection | null = null;
  readonly #eventPublisher = new DriverEventPublisher(this.runtime, () => this.#nativeSessionId);
  #hostSnapshot: DriverHostIntegrationSnapshot | null = null;
  #materializedSkills: readonly AgentDriverMaterializedSkill[] = [];
  #nativeSessionId: string | null = null;
  #appAccessSnapshot: DriverAppAccessSnapshotOutput | null = null;
  readonly #payload: DriverStartInput;
  readonly #runtimeBootstrapDigest: string | null;
  readonly #runtimeBootstrapText: string;
  readonly #turnEvents = new AcpTurnEventState();

  constructor(payload: DriverStartInput) {
    this.#payload = payload;
    this.#nativeSessionId = readAcpNativeResumeSessionId(payload);
    this.#runtimeBootstrapDigest = computeRuntimeBootstrapDigest(payload.execution);
    this.#runtimeBootstrapText = buildRuntimeBootstrapText(payload.execution);
    this.#clientRequests = new AcpClientRequestHandler({
      allowedRoots: payload.execution.session.additionalDirectories,
      cwd: payload.execution.session.cwd,
      isTurnCancelRequested: () => this.#activeTurn?.cancelRequested ?? false,
      nativeSessionId: () => this.#nativeSessionId,
      push: async (context, reason, events) => this.#push(context, reason, events),
      turnEvents: this.#turnEvents,
    });
  }

  async start(context: AgentDriverContext): Promise<void> {
    const hostSnapshot = await context.ports.hostIntegration.snapshot();

    if (hostSnapshot === null) {
      throw new Error("ACP fallback requires a host integration snapshot.");
    }

    this.#hostSnapshot = hostSnapshot;
    this.#appAccessSnapshot = hostSnapshot.sessionContext.appAccessSnapshot;
    this.#materializedSkills = await context.ports.skill.materialize(this.#payload.execution);
    const bootstrapArtifacts = await writeSkillBootstrapArtifacts(this.#payload.execution);
    const env = buildAcpChildProcessEnv(this.#payload);
    const agentProcess = await startAcpAgentProcess(context, this.#payload, env);
    this.#agentProcess = agentProcess;
    this.#connection = new AcpJsonRpcConnection({
      onInvalidMessage: (error, line) => {
        context.logger.warn("driver.acp.message.invalid", {
          line,
          message: error.message,
        });
      },
      onNotification: async (notification) =>
        this.#clientRequests.handleNotification(context, notification),
      onRequest: async (request) => this.#clientRequests.handleRequest(context, request),
      onTransportError: (error) => {
        context.logger.error("driver.acp.transport.failed", error, {});
      },
      stdin: agentProcess.stdin,
      stdout: agentProcess.stdout,
    });

    const initResult = parseAcpInitializeResult(
      await this.#connection.request("initialize", {
        clientCapabilities: buildAcpClientCapabilities(),
        clientInfo: {
          name: "mosoo-driver",
          title: "Mosoo Driver",
          version: "0.1.0",
        },
        protocolVersion: ACP_PROTOCOL_VERSION,
      }),
    );
    enforceAcpProtocolVersion(initResult);
    this.#agentCapabilities = initResult.agentCapabilities;
    await this.#push(context, "driver.acp.initialize", toAcpInitializeEvents(initResult));
    await this.#authenticateIfConfigured(context, initResult, env);
    const setup = await this.#setupSession();

    await this.#push(
      context,
      `driver.acp.session.${setup.mode}`,
      toAcpSessionReadyEvents({
        mode: setup.mode,
        nativeSessionId: setup.sessionId,
        setup: setup.raw,
      }),
    );

    if (setup.mode === "created") {
      await this.#applyRuntimeBootstrap(context);
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
        mountAliasCount: this.#payload.execution.session.mountAliases.length,
        sharedRootPath: summarizePath(this.#payload.execution.session.sharedRootPath),
      },
      nativeResumeRefPresent: this.#nativeSessionId !== null,
      skillCount: this.#materializedSkills.length,
    });
  }

  async handleInput(
    context: AgentDriverContext,
    input: RuntimeCommandInput,
    runId: RunId,
  ): Promise<void> {
    const connection = this.#requireConnection();
    const sessionId = this.#requireNativeSessionId();
    const messageId = createDriverId() as MessageId;

    if (this.#activeTurn !== null) {
      throw new Error("ACP driver backend already has an active turn.");
    }

    this.#activeTurn = {
      cancelRequested: false,
      runId,
    };
    this.#turnEvents.begin({ messageId, runId, sessionId });
    const hostSnapshot = this.#requireHostSnapshot();
    const appAccessSnapshot = this.#requireAppAccessSnapshot();

    context.logger.info("driver.acp.prompt.sending", {
      sessionId,
      textLength: input.text.length,
    });
    context.logger.debug("driver.acp.prompt.requested", {
      input: summarizeRuntimeCommandInput(input),
      appAccessSnapshot: summarizeAppAccessSnapshot(appAccessSnapshot),
      sessionId,
    });

    await this.#push(
      context,
      "driver.acp.prompt.started",
      toAcpPromptStartEvents({ messageId, runId, text: input.text }),
    );

    try {
      const promptResult = parseAcpPromptResult(
        await connection.request("session/prompt", {
          _meta: toAcpRequestMeta({
            appAccessSnapshot,
            sessionContext: hostSnapshot.sessionContext,
          }),
          messageId,
          prompt: [{ text: input.text, type: "text" }],
          sessionId,
        }),
      );
      const stopReason = this.#activeTurn.cancelRequested ? "cancelled" : promptResult.stopReason;
      const completionEvents = this.#turnEvents.completePrompt(stopReason, promptResult.usage);
      const promptCancelled =
        this.#activeTurn.cancelRequested || promptResult.stopReason === "cancelled";
      const promptFailed = stopReason === "max_turn_requests";

      await this.#push(
        context,
        promptCancelled
          ? "driver.acp.prompt.cancelled"
          : promptFailed
            ? "driver.acp.prompt.failed"
            : "driver.acp.prompt.completed",
        completionEvents,
      );

      context.logger.info(
        promptFailed ? "driver.acp.prompt.failed" : "driver.acp.prompt.completed",
        {
          sessionId,
          stopReason: promptResult.stopReason,
        },
      );

      if (promptCancelled) {
        throw new DriverTurnCancelledError("ACP driver backend turn was cancelled.");
      }

      if (promptFailed) {
        throw new AcpPromptTerminalError(stopReason);
      }
    } catch (error) {
      if (error instanceof DriverTurnCancelledError || error instanceof AcpPromptTerminalError) {
        throw error;
      }

      if (this.#activeTurn?.cancelRequested) {
        const events =
          this.#turnEvents.activeRunId() === null
            ? []
            : this.#turnEvents.completePrompt("cancelled", null);
        await this.#push(context, "driver.acp.prompt.cancelled", events);
        throw new DriverTurnCancelledError("ACP driver backend turn was cancelled.");
      }

      const message = error instanceof Error ? error.message : "ACP driver backend turn failed.";
      await this.#push(
        context,
        "driver.acp.prompt.failed",
        this.#turnEvents.failPrompt({
          code: "acp.turn_failed",
          message,
        }),
      );
      throw error;
    } finally {
      this.#activeTurn = null;
      this.#turnEvents.clear();
    }
  }

  async cancelActiveTurn(context: AgentDriverContext, reason: string): Promise<void> {
    const activeTurn = this.#activeTurn;
    const sessionId = this.#nativeSessionId;
    const connection = this.#connection;

    if (activeTurn === null || sessionId === null || connection === null) {
      return;
    }

    if (!activeTurn.cancelRequested) {
      activeTurn.cancelRequested = true;
      await this.#push(context, "driver.acp.turn.cancel.requested", [
        {
          kind: "run.cancel.requested",
          payload: {
            reason,
            requestedBy: "user",
            targetRunId: activeTurn.runId,
          },
          runId: activeTurn.runId,
        },
      ]);
    }

    await connection.notify("session/cancel", { sessionId });
  }

  async handleMcpExecute(
    context: AgentDriverContext,
    command: McpExecuteCommand,
  ): Promise<{ outputText: string; requestId: string; serverId: string; toolName: string }> {
    context.logger.info("driver.acp.mcp.execute.started", {
      serverId: command.serverId,
      toolName: command.toolName,
    });
    const result = await context.ports.mcp.execute(command);
    context.logger.info("driver.acp.mcp.execute.completed", {
      outputLength: result.outputText.length,
      serverId: command.serverId,
      toolName: command.toolName,
    });
    return result;
  }

  async refreshAppAccess(
    context: AgentDriverContext,
    snapshot: DriverAppAccessSnapshotOutput,
  ): Promise<void> {
    this.#appAccessSnapshot = snapshot;
    context.logger.debug("driver.acp.app-access.refreshed", {
      appAccessSnapshot: summarizeAppAccessSnapshot(snapshot),
      sessionId: this.#nativeSessionId,
    });
  }

  async stop(context: AgentDriverContext, reason: string): Promise<void> {
    await this.cancelActiveTurn(context, reason);
    await this.#clientRequests.stopTerminals(context);

    const sessionId = this.#nativeSessionId;
    const connection = this.#connection;

    if (connection !== null && sessionId !== null) {
      if (supportsAcpSessionClose(this.#agentCapabilities)) {
        await connection.request("session/close", { sessionId }).catch((error: unknown) => {
          context.logger.warn("driver.acp.session.close.failed", {
            message: error instanceof Error ? error.message : "session close failed",
            reason,
            sessionId,
          });
        });
      } else {
        await connection.notify("session/cancel", { sessionId }).catch((error: unknown) => {
          context.logger.warn("driver.acp.session.cancel.failed", {
            message: error instanceof Error ? error.message : "session cancel failed",
            reason,
            sessionId,
          });
        });
      }
      connection.close("ACP driver backend stopped.");
    }

    if (this.#agentProcess !== null) {
      await stopAcpAgentProcess(context, this.#agentProcess, reason);
      this.#agentProcess = null;
    }

    this.#connection = null;
  }

  async #applyRuntimeBootstrap(context: AgentDriverContext): Promise<void> {
    if (this.#runtimeBootstrapText.trim().length === 0) {
      return;
    }

    const connection = this.#requireConnection();
    const sessionId = this.#requireNativeSessionId();

    await this.#clientRequests.withSuppressedSessionUpdates(async () => {
      context.logger.info("driver.acp.bootstrap.sending", {
        bootstrapDigest: this.#runtimeBootstrapDigest,
        sessionId,
        textLength: this.#runtimeBootstrapText.length,
      });
      await connection.request("session/prompt", {
        prompt: [{ text: this.#runtimeBootstrapText, type: "text" }],
        sessionId,
      });
      context.logger.info("driver.acp.bootstrap.completed", {
        bootstrapDigest: this.#runtimeBootstrapDigest,
        sessionId,
      });
    });
  }

  async #authenticateIfConfigured(
    context: AgentDriverContext,
    result: AcpInitializeResult,
    env: Record<string, string>,
  ): Promise<void> {
    const methodId = resolveAcpAuthMethodId(result.authMethods, env);

    if (methodId === null) {
      return;
    }

    try {
      await this.#requireConnection().request("authenticate", { methodId });
      await this.#push(context, "driver.acp.auth.authenticated", [
        toAcpAuthSessionEvent({ methodId, status: "authenticated" }),
      ]);
    } catch (error) {
      await this.#push(context, "driver.acp.auth.failed", [
        toAcpAuthSessionEvent({ methodId, status: "failed" }),
      ]);
      throw error;
    }
  }

  async #push(
    context: AgentDriverContext,
    reason: string,
    events: DriverEventInput[],
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await this.#eventPublisher.push(context, reason, events);
  }

  #requireConnection(): AcpJsonRpcConnection {
    if (this.#connection === null) {
      throw new Error("ACP driver backend connection is not initialized.");
    }

    return this.#connection;
  }

  #requireNativeSessionId(): string {
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

  #requireAppAccessSnapshot(): DriverAppAccessSnapshotOutput {
    if (this.#appAccessSnapshot === null) {
      throw new Error("ACP driver backend App access snapshot is not initialized.");
    }

    return this.#appAccessSnapshot;
  }

  async #setupSession(): Promise<Awaited<ReturnType<typeof setupAcpSession>>> {
    const hostSnapshot = this.#requireHostSnapshot();
    const setup = await setupAcpSession({
      agentCapabilities: this.#agentCapabilities,
      connection: this.#requireConnection(),
      currentSessionId: this.#nativeSessionId,
      appAccessSnapshot: this.#requireAppAccessSnapshot(),
      payload: this.#payload,
      sessionContext: hostSnapshot.sessionContext,
      replaySession: async (operation) => this.#clientRequests.withSessionReplay(operation),
    });
    this.#nativeSessionId = setup.sessionId;

    return setup;
  }
}
