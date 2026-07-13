import { isDriverFullAccess } from "../../core/driver-permission-policy";
import { DriverTurnCancelledError } from "../../core/driver-runtime-state";
import {
  createDriverRuntimeTimingEvent,
  createDriverRuntimeTimingPhase,
  toDriverDurationMs,
} from "../../core/driver-runtime-timing";
import type { AgentDriverMaterializedSkill } from "../../host-ports";
import {
  summarizePath,
  summarizeRuntimeCommandInput,
} from "../../infrastructure/logging/driver-debug";
import type { RunId } from "../../protocol/id";
import type { DriverRuntime } from "../../protocol/runtime";
import type { DriverStartInput } from "../../protocol/start";
import type { McpExecuteCommand, RuntimeCommandInput } from "../../runtime-command";
import type { AgentDriverBackend, AgentDriverContext } from "../agent-driver-backend";
import { DriverEventPublisher } from "../driver-event-publisher";
import {
  buildNativeRuntimeSystemPrompt,
  computeRuntimeBootstrapDigest,
  writeSkillBootstrapArtifacts,
} from "../skill-bootstrap";
import { OpenAiAppServerClient } from "./app-server-client";
import { MOSOO_OPENAI_RUNTIME_SANDBOX_MODE } from "./app-server-env";
import { OpenAiAppServerEventBridge } from "./app-server-event-bridge";
import type {
  ApprovalPolicy,
  JsonObject,
  ThreadResumeParams,
  ThreadStartParams,
  ThreadStartResponse,
  TurnStatus,
  TurnStartParams,
  TurnStartResponse,
} from "./generated/app-server-protocol";

/**
 * Codex app-server approval policy per driver permission policy.
 *
 * `never` = "Never ask the user to approve commands" (== the CLI
 * `--dangerously-bypass-approvals-and-sandbox` posture). The runtime sandbox is
 * already `danger-full-access` (see MOSOO_OPENAI_RUNTIME_SANDBOX_MODE), so under
 * full_access this makes Codex fully autonomous. Supervised keeps `on-request`
 * so exec/patch approvals surface to the control plane.
 */
function resolveOpenAiApprovalPolicy(payload: DriverStartInput): ApprovalPolicy {
  return isDriverFullAccess(payload) ? "never" : "on-request";
}

interface OpenAiTurnStartInput {
  readonly approvalPolicy: ApprovalPolicy;
  readonly cwd: string;
  readonly model: string;
  readonly text: string;
  readonly threadId: string;
}

function readOpenAiNativeResumeThreadId(payload: DriverStartInput): string | null {
  const { nativeResumeRef } = payload.execution.session;

  if (nativeResumeRef === null) {
    return null;
  }

  if (
    nativeResumeRef.runtimeId !== "openai-runtime" ||
    nativeResumeRef.kind !== "openai_thread_id"
  ) {
    throw new Error("OpenAI runtime received an incompatible native resume ref.");
  }

  if (nativeResumeRef.value.length === 0) {
    throw new Error("OpenAI runtime received an empty native resume thread id.");
  }

  return nativeResumeRef.value;
}

function isTerminalOpenAiTurnStatus(status: TurnStatus | undefined): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function isMissingOpenAiRollout(error: unknown, threadId: string): boolean {
  return error instanceof Error && error.message === `no rollout found for thread id ${threadId}`;
}

function toOpenAiRecoveryItems(
  messages: DriverStartInput["execution"]["session"]["recoveryMessages"],
): JsonObject[] {
  return messages.map((message) => ({
    content: [
      {
        text: message.content,
        type: message.role === "user" ? "input_text" : "output_text",
      },
    ],
    role: message.role,
    type: "message",
  }));
}

export function createOpenAiTurnStartParams(input: OpenAiTurnStartInput): TurnStartParams {
  return {
    approvalPolicy: input.approvalPolicy,
    cwd: input.cwd,
    input: [
      {
        text: input.text,
        text_elements: [],
        type: "text",
      },
    ],
    model: input.model,
    threadId: input.threadId,
  };
}

async function interruptOpenAiTurn(input: {
  client: OpenAiAppServerClient;
  context: AgentDriverContext;
  reason: string;
  threadId: string;
  turnId: string;
}): Promise<void> {
  try {
    await input.client.request("turn/interrupt", {
      threadId: input.threadId,
      turnId: input.turnId,
    });
  } catch (error) {
    input.context.logger.debug("driver.openai.turn.interrupt.failed", {
      message: error instanceof Error ? error.message : "interrupt failed",
      reason: input.reason,
      turnId: input.turnId,
    });
  }
}

export class OpenAiAppServerDriverBackend implements AgentDriverBackend {
  readonly runtime: DriverRuntime = "openai-runtime";
  readonly #payload: DriverStartInput;
  readonly #runtimeBootstrapDigest: string | null;
  readonly #eventPublisher = new DriverEventPublisher(this.runtime, () => this.#threadId);
  #client: OpenAiAppServerClient | null = null;
  #materializedSkills: readonly AgentDriverMaterializedSkill[] = [];
  #pendingTurnStartCancellationReason: string | null = null;
  #threadId: string | null = null;
  #turnStartInFlight = false;
  readonly #events = new OpenAiAppServerEventBridge({
    push: async (context, reason, events) => this.#eventPublisher.push(context, reason, events),
    requireThreadId: () => this.#requireThreadId(),
  });

  constructor(payload: DriverStartInput) {
    this.#payload = payload;
    this.#runtimeBootstrapDigest = computeRuntimeBootstrapDigest(payload.execution);
  }

  async start(context: AgentDriverContext): Promise<void> {
    const startupStartedAtMs = Date.now();
    const startupPhases: ReturnType<typeof createDriverRuntimeTimingPhase>[] = [];
    const measureStartupPhase = async <T>(name: string, task: () => Promise<T>): Promise<T> => {
      const startedAtMs = Date.now();

      try {
        return await task();
      } finally {
        startupPhases.push(createDriverRuntimeTimingPhase(name, toDriverDurationMs(startedAtMs)));
      }
    };

    const client = new OpenAiAppServerClient(this.#payload, {
      ...context,
      handleNotification: async (method, params) =>
        this.#events.handleNotification(context, method, params),
      handleProtocolError: async (error) => {
        this.#events.rejectActiveTurns(error);
      },
    });
    this.#client = client;
    const clientStartPromise = (async () => {
      const startedAtMs = Date.now();
      const result = await client.start();
      startupPhases.push(
        createDriverRuntimeTimingPhase("app_server.start", toDriverDurationMs(startedAtMs)),
        ...result.phases.map((phase) =>
          createDriverRuntimeTimingPhase(phase.name, phase.durationMs),
        ),
      );
    })();
    const skillBootstrapPromise = (async () => {
      this.#materializedSkills = await measureStartupPhase("skills.materialize", () =>
        context.ports.skill.materialize(this.#payload.execution),
      );
      return measureStartupPhase("skills.bootstrap", () =>
        writeSkillBootstrapArtifacts(this.#payload.execution),
      );
    })();
    let bootstrapArtifacts: Awaited<typeof skillBootstrapPromise>;

    try {
      [, bootstrapArtifacts] = await Promise.all([clientStartPromise, skillBootstrapPromise]);
    } catch (error) {
      client.stop();
      throw error;
    }

    const developerInstructions = buildNativeRuntimeSystemPrompt(this.#payload.execution);
    const nativeResumeThreadId = readOpenAiNativeResumeThreadId(this.#payload);
    const baseThreadParams = {
      approvalPolicy: resolveOpenAiApprovalPolicy(this.#payload),
      cwd: this.#payload.execution.session.cwd,
      model: this.#payload.execution.model,
      modelProvider: this.#payload.execution.provider,
      sandbox: MOSOO_OPENAI_RUNTIME_SANDBOX_MODE,
    } satisfies ThreadStartParams;
    const threadStartParams = {
      ...baseThreadParams,
      ...(developerInstructions === null ? {} : { developerInstructions }),
      sessionStartSource: "startup",
    } satisfies ThreadStartParams;
    let threadResult: ThreadStartResponse;

    if (nativeResumeThreadId === null) {
      threadResult = await measureStartupPhase("thread.start", () =>
        client.request("thread/start", threadStartParams),
      );
    } else {
      try {
        threadResult = await measureStartupPhase("thread.resume", () =>
          client.request("thread/resume", {
            ...baseThreadParams,
            ...(developerInstructions === null ? {} : { developerInstructions }),
            threadId: nativeResumeThreadId,
          } satisfies ThreadResumeParams),
        );
      } catch (error) {
        if (!isMissingOpenAiRollout(error, nativeResumeThreadId)) {
          throw error;
        }

        context.logger.warn("driver.openai.native_resume_ref.missing_rollout", {
          nativeResumeRefPresent: true,
        });
        threadResult = await measureStartupPhase("thread.start_after_missing_rollout", () =>
          client.request("thread/start", threadStartParams),
        );
        const recoveryItems = toOpenAiRecoveryItems(
          this.#payload.execution.session.recoveryMessages,
        );

        if (recoveryItems.length > 0) {
          await measureStartupPhase("thread.inject_recovery_items", () =>
            client.request("thread/inject_items", {
              items: recoveryItems,
              threadId: threadResult.thread.id,
            }),
          );
        }

        context.logger.warn("driver.openai.native_resume_ref.semantic_recovery", {
          recoveryMessageCount: recoveryItems.length,
        });
      }
    }
    this.#threadId = threadResult.thread.id;
    void this.#emitStartupTimingEvent(context, startupStartedAtMs, startupPhases);

    context.logger.info("driver.openai.runtime.started", {
      bootstrapArtifacts,
      bootstrapDigest: this.#runtimeBootstrapDigest,
      execution: {
        cwd: summarizePath(this.#payload.execution.session.cwd),
        homePath: summarizePath(this.#payload.execution.session.homePath),
        sharedRootPath: summarizePath(this.#payload.execution.session.sharedRootPath),
      },
      nativeResumeRefPresent: Boolean(nativeResumeThreadId),
      skillCount: this.#materializedSkills.length,
      threadIdPresent: Boolean(this.#threadId),
    });
  }

  async #emitStartupTimingEvent(
    context: AgentDriverContext,
    startedAtMs: number,
    phases: readonly ReturnType<typeof createDriverRuntimeTimingPhase>[],
  ): Promise<void> {
    try {
      await context.ports.eventSink.pushEvents({
        events: [
          createDriverRuntimeTimingEvent({
            path: this.#payload.execution.run.runId === null ? "prewarm" : "cold",
            phases,
            runId: this.#payload.execution.run.runId,
            sessionId: this.#payload.execution.run.sessionId,
            stage: "driver_backend",
            startedAtMs,
          }),
        ],
      });
    } catch (error) {
      context.logger.error("driver.openai.startup_timing.failed", error, {
        driverInstanceId: this.#payload.driverInstanceId,
      });
    }
  }

  async handleInput(
    context: AgentDriverContext,
    input: RuntimeCommandInput,
    runId: RunId,
  ): Promise<void> {
    const client = this.#requireClient();
    const threadId = this.#requireThreadId();

    context.logger.info("driver.openai.prompt.sending", {
      textLength: input.text.length,
      threadIdPresent: true,
    });
    context.logger.debug("driver.openai.prompt.requested", {
      input: summarizeRuntimeCommandInput(input),
      threadIdPresent: true,
    });

    this.#turnStartInFlight = true;
    this.#pendingTurnStartCancellationReason = null;

    let turnResult: TurnStartResponse;
    const turnStartRequestedAtMs = Date.now();

    try {
      turnResult = await client.request(
        "turn/start",
        createOpenAiTurnStartParams({
          approvalPolicy: resolveOpenAiApprovalPolicy(this.#payload),
          cwd: this.#payload.execution.session.cwd,
          model: this.#payload.execution.model,
          text: input.text,
          threadId,
        }),
      );
    } catch (error) {
      const pendingCancellationReason = this.#pendingTurnStartCancellationReason;
      this.#pendingTurnStartCancellationReason = null;

      if (pendingCancellationReason !== null) {
        throw new DriverTurnCancelledError(pendingCancellationReason);
      }

      throw error;
    } finally {
      this.#turnStartInFlight = false;
    }

    const turnId = turnResult.turn.id;
    const turnStartedAtMs = Date.now();

    await this.#eventPublisher.push(context, "driver.openai.provider.turn_start", [
      createDriverRuntimeTimingEvent({
        completedAtMs: turnStartedAtMs,
        path: "unknown",
        phases: [
          createDriverRuntimeTimingPhase(
            "provider.turn_start",
            toDriverDurationMs(turnStartRequestedAtMs, turnStartedAtMs),
          ),
        ],
        runId,
        sessionId: context.payload.execution.run.sessionId,
        sourceEventId: `openai.provider.turn_start:${turnId}`,
        stage: "driver_turn",
        startedAtMs: turnStartRequestedAtMs,
        native: {
          eventName: "provider.turn_start",
          provider: "openai",
          turnId,
        },
      }),
    ]);
    const pendingCancellationReason = this.#pendingTurnStartCancellationReason;
    this.#pendingTurnStartCancellationReason = null;

    if (pendingCancellationReason !== null) {
      this.#events.markTurnCancelled(turnId, pendingCancellationReason);
      void interruptOpenAiTurn({
        client,
        context,
        reason: pendingCancellationReason,
        threadId,
        turnId,
      });
      throw new DriverTurnCancelledError(pendingCancellationReason);
    }

    const completion = this.#events.trackTurn(turnId, runId);

    if (isTerminalOpenAiTurnStatus(turnResult.turn.status)) {
      await this.#events.handleNotification(context, "turn/completed", {
        threadId,
        turn: turnResult.turn,
      });
    }

    await this.#events.publishRunStarted(context, { runId, turnId });
    await completion;
  }

  async cancelActiveTurn(context: AgentDriverContext, reason: string): Promise<void> {
    const client = this.#client;
    const threadId = this.#threadId;

    if (client === null || threadId === null) {
      return;
    }

    if (this.#turnStartInFlight) {
      this.#pendingTurnStartCancellationReason = reason;
    }

    for (const turnId of this.#events.activeTurnIds()) {
      this.#events.markTurnCancelled(turnId, reason);
      this.#events.rejectTurn(turnId, new DriverTurnCancelledError(reason));
      void interruptOpenAiTurn({ client, context, reason, threadId, turnId });
    }
  }

  async handleMcpExecute(
    context: AgentDriverContext,
    command: McpExecuteCommand,
  ): Promise<{ outputText: string; requestId: string; serverId: string; toolName: string }> {
    context.logger.info("driver.openai.mcp.execute.started", {
      serverId: command.serverId,
      toolName: command.toolName,
    });

    const result = await context.ports.mcp.execute(command);

    context.logger.info("driver.openai.mcp.execute.completed", {
      outputLength: result.outputText.length,
      serverId: command.serverId,
      toolName: command.toolName,
    });

    return result;
  }

  async stop(context: AgentDriverContext, reason: string): Promise<void> {
    const client = this.#client;

    await this.cancelActiveTurn(context, reason);
    this.#events.clearActiveTurns();
    client?.stop();
    this.#client = null;
  }

  #requireClient(): OpenAiAppServerClient {
    if (this.#client === null) {
      throw new Error("OpenAI runtime app-server is not initialized.");
    }

    return this.#client;
  }

  #requireThreadId(): string {
    if (this.#threadId === null) {
      throw new Error("OpenAI runtime app-server thread is not initialized.");
    }

    return this.#threadId;
  }
}
