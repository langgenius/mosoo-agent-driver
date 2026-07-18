import { isDriverFullAccess } from "../../core/driver-permission-policy";
import { pushLosslessEvents } from "../../core/driver-runtime-io";
import { DriverTurnCancelledError } from "../../core/driver-runtime-state";
import {
  createTimingEvent,
  createTimingPhase,
  toDurationMs,
} from "../../core/driver-runtime-timing";
import {
  summarizePath,
  summarizeRuntimeCommandInput,
} from "../../infrastructure/logging/driver-debug";
import type { RunId } from "../../protocol/id";
import type { DriverRuntime } from "../../protocol/runtime";
import type { DriverStartInput } from "../../protocol/start";
import type { RuntimeCommandInput } from "../../runtime-command";
import { raceWithAbort } from "../../utils/async";
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
 * App-server approval policy derived from the driver permission policy.
 *
 * `never` = "Never ask the user to approve commands" (== the CLI
 * `--dangerously-bypass-approvals-and-sandbox` posture). The runtime sandbox is
 * already `danger-full-access` (see MOSOO_OPENAI_RUNTIME_SANDBOX_MODE), so under
 * `full_access` makes the runtime fully autonomous. `supervised` keeps `on-request`
 * so exec/patch approvals surface to the control plane.
 */
function resolveApprovalPolicy(payload: DriverStartInput): ApprovalPolicy {
  return isDriverFullAccess(payload) ? "never" : "on-request";
}

interface OpenAiTurnStartInput {
  readonly approvalPolicy: ApprovalPolicy;
  readonly cwd: string;
  readonly model: string;
  readonly text: string;
  readonly threadId: string;
}

function readResumeThreadId(payload: DriverStartInput): string | null {
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

function isTerminalTurn(status: TurnStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function isMissingRollout(error: unknown, threadId: string): boolean {
  return error instanceof Error && error.message === `no rollout found for thread id ${threadId}`;
}

function toRecoveryItems(
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

export function createTurnParams(input: OpenAiTurnStartInput): TurnStartParams {
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
  readonly #eventPublisher = new DriverEventPublisher(this.runtime, () => this.#threadId);
  #client: OpenAiAppServerClient | null = null;
  #pendingTurnStartCancellationReason: string | null = null;
  #threadId: string | null = null;
  #turnStartInFlight = false;
  readonly #events = new OpenAiAppServerEventBridge({
    push: async (context, reason, events) => this.#eventPublisher.push(context, reason, events),
    requireThreadId: () => this.#requireThreadId(),
  });

  constructor(payload: DriverStartInput) {
    this.#payload = payload;
  }

  async start(context: AgentDriverContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const startupStartedAt = new Date().toISOString();
    const startupPhases: ReturnType<typeof createTimingPhase>[] = [];
    const measureStartupPhase = async <T>(name: string, task: () => Promise<T>): Promise<T> => {
      const startedAtMs = Date.now();

      try {
        signal.throwIfAborted();
        return await raceWithAbort(task(), signal);
      } finally {
        startupPhases.push(createTimingPhase(name, toDurationMs(startedAtMs)));
      }
    };

    const client = new OpenAiAppServerClient(this.#payload, {
      ...context,
      handleNotification: async (method, params) =>
        this.#events.handleNotification(context, method, params),
      handleProtocolError: async (error) => {
        this.#events.rejectActiveTurns(error);
        context.lifecycle.fail(error);
      },
    });
    this.#client = client;
    const clientStartPromise = (async () => {
      const startedAtMs = Date.now();
      const result = await client.start(signal);
      startupPhases.push(
        createTimingPhase("app_server.start", toDurationMs(startedAtMs)),
        ...result.phases.map((phase) => createTimingPhase(phase.name, phase.durationMs)),
      );
    })();
    const skillBootstrapPromise = (async () => {
      const materializedSkills = await measureStartupPhase("skills.materialize", () =>
        context.ports.skill.materialize(this.#payload.execution),
      );
      const artifacts = await measureStartupPhase("skills.bootstrap", () =>
        writeSkillBootstrapArtifacts(this.#payload.execution),
      );
      return { artifacts, count: materializedSkills.length };
    })();
    let bootstrapArtifacts: Awaited<typeof skillBootstrapPromise>;

    try {
      [, bootstrapArtifacts] = await Promise.all([clientStartPromise, skillBootstrapPromise]);
    } catch (error) {
      signal.throwIfAborted();
      await client.stop();
      throw error;
    }

    signal.throwIfAborted();
    if (this.#client !== client) {
      throw new Error("OpenAi app-server backend stopped during startup.");
    }

    const developerInstructions = buildNativeRuntimeSystemPrompt(this.#payload.execution);
    const nativeResumeThreadId = readResumeThreadId(this.#payload);
    const baseThreadParams = {
      approvalPolicy: resolveApprovalPolicy(this.#payload),
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
        client.request("thread/start", threadStartParams, signal),
      );
    } else {
      try {
        threadResult = await measureStartupPhase("thread.resume", () =>
          client.request(
            "thread/resume",
            {
              ...baseThreadParams,
              ...(developerInstructions === null ? {} : { developerInstructions }),
              threadId: nativeResumeThreadId,
            } satisfies ThreadResumeParams,
            signal,
          ),
        );
      } catch (error) {
        if (!isMissingRollout(error, nativeResumeThreadId)) {
          throw error;
        }

        context.logger.warn("driver.openai.native_resume_ref.missing_rollout", {
          nativeResumeRefPresent: true,
        });
        threadResult = await measureStartupPhase("thread.start_after_missing_rollout", () =>
          client.request("thread/start", threadStartParams, signal),
        );
        const recoveryItems = toRecoveryItems(this.#payload.execution.session.recoveryMessages);

        if (recoveryItems.length > 0) {
          await measureStartupPhase("thread.inject_recovery_items", () =>
            client.request(
              "thread/inject_items",
              {
                items: recoveryItems,
                threadId: threadResult.thread.id,
              },
              signal,
            ),
          );
        }

        context.logger.warn("driver.openai.native_resume_ref.semantic_recovery", {
          recoveryMessageCount: recoveryItems.length,
        });
      }
    }
    signal.throwIfAborted();
    this.#threadId = threadResult.thread.id;
    void this.#emitStartupTiming(context, startupStartedAt, startupPhases);

    context.logger.info("driver.openai.runtime.started", {
      bootstrapArtifacts: bootstrapArtifacts.artifacts,
      bootstrapDigest: computeRuntimeBootstrapDigest(this.#payload.execution),
      execution: {
        cwd: summarizePath(this.#payload.execution.session.cwd),
        homePath: summarizePath(this.#payload.execution.session.homePath),
        sharedRootPath: summarizePath(this.#payload.execution.session.sharedRootPath),
      },
      nativeResumeRefPresent: Boolean(nativeResumeThreadId),
      skillCount: bootstrapArtifacts.count,
      threadIdPresent: Boolean(this.#threadId),
    });
  }

  async #emitStartupTiming(
    context: AgentDriverContext,
    startedAt: string,
    phases: readonly ReturnType<typeof createTimingPhase>[],
  ): Promise<void> {
    try {
      await pushLosslessEvents(context.ports.eventSink, [
        createTimingEvent({
          path: this.#payload.execution.run.runId === null ? "prewarm" : "cold",
          phases,
          runId: this.#payload.execution.run.runId,
          sessionId: this.#payload.execution.run.sessionId,
          stage: "driver_backend",
          startedAt,
        }),
      ]);
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
        createTurnParams({
          approvalPolicy: resolveApprovalPolicy(this.#payload),
          cwd: this.#payload.execution.session.cwd,
          model: this.#payload.execution.model,
          text: input.text,
          threadId,
        }),
      );
    } catch (error) {
      this.#turnStartInFlight = false;
      const pendingCancellationReason = this.#pendingTurnStartCancellationReason;
      this.#pendingTurnStartCancellationReason = null;

      if (pendingCancellationReason !== null) {
        throw new DriverTurnCancelledError(pendingCancellationReason);
      }

      throw error;
    }

    const turnId = turnResult.turn.id;
    const completion = this.#events.trackTurn(turnId, runId);
    void completion.catch(() => {});
    this.#turnStartInFlight = false;
    const pendingCancellationReason = this.#pendingTurnStartCancellationReason;
    this.#pendingTurnStartCancellationReason = null;

    if (pendingCancellationReason !== null) {
      await Promise.all([
        this.#events.cancelTurn(context, turnId, pendingCancellationReason, () =>
          client.drainServerMessages(),
        ),
        interruptOpenAiTurn({
          client,
          context,
          reason: pendingCancellationReason,
          threadId,
          turnId,
        }),
      ]);
      await client.drainServerMessages();
      this.#events.releaseTurnState();
      throw new DriverTurnCancelledError(pendingCancellationReason);
    }

    const turnStartedAtMs = Date.now();

    await this.#eventPublisher.push(context, "driver.openai.provider.turn_start", [
      createTimingEvent({
        completedAt: new Date(turnStartedAtMs).toISOString(),
        path: "unknown",
        phases: [
          createTimingPhase(
            "provider.turn_start",
            toDurationMs(turnStartRequestedAtMs, turnStartedAtMs),
          ),
        ],
        runId,
        sessionId: context.payload.execution.run.sessionId,
        sourceEventId: `openai.provider.turn_start:${turnId}`,
        stage: "driver_turn",
        startedAt: new Date(turnStartRequestedAtMs).toISOString(),
        native: {
          eventName: "provider.turn_start",
          provider: "openai",
          turnId,
        },
      }),
    ]);

    if (isTerminalTurn(turnResult.turn.status)) {
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

    client.abortServerRequests(new DriverTurnCancelledError(reason));

    if (this.#turnStartInFlight) {
      this.#pendingTurnStartCancellationReason = reason;
    }

    const activeTurnIds = this.#events.activeTurnIds();

    await Promise.all(
      activeTurnIds.flatMap((turnId) => [
        this.#events.cancelTurn(context, turnId, reason, () => client.drainServerMessages()),
        interruptOpenAiTurn({ client, context, reason, threadId, turnId }),
      ]),
    );
    await client.drainServerMessages();
    this.#events.releaseTurnState();
  }

  async stop(
    context: AgentDriverContext,
    reason: string,
    signal: AbortSignal,
  ): Promise<void> {
    const client = this.#client;
    const cancellation = raceWithAbort(this.cancelActiveTurn(context, reason), signal);

    await Promise.all([cancellation, client?.stop(signal)]);
    this.#events.clearActiveTurns();

    if (this.#client === client) {
      this.#client = null;
    }
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
