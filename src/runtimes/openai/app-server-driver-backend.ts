import { isDriverFullAccess } from "../../core/driver-permission-policy";
import { pushLosslessEvents } from "../../core/driver-runtime-io";
import {
  DriverTurnCancelledError,
  DriverTurnCancellationCleanupError,
} from "../../core/driver-runtime-state";
import {
  createTimingEvent,
  createTimingPhase,
  toDurationMs,
} from "../../core/driver-runtime-timing";
import { summarizePath, summarizeRuntimeCommandInput } from "../../observability/driver-debug";
import type { RunId } from "../../protocol/id";
import type { DriverRuntime } from "../../protocol/runtime";
import type { DriverStartInput } from "../../protocol/start";
import type { RuntimeCommandInput } from "../../runtime-command";
import { raceWithAbort, settlePromiseWithTimeout } from "../../utils/async";
import type { AgentDriverBackend, AgentDriverContext } from "../../core/agent-driver-backend";
import { DriverEventPublisher } from "../driver-event-publisher";
import {
  buildNativeRuntimeSystemPrompt,
  computeRuntimeBootstrapDigest,
  writeSkillBootstrapArtifacts,
} from "../skill-bootstrap";
import { OpenAiAppServerClient } from "./app-server-client";
import { openAiAgentTasksClosedEvent } from "./app-server-agent-task-events";
import { MOSOO_OPENAI_RUNTIME_SANDBOX_MODE } from "./app-server-env";
import { OpenAiAppServerEventBridge } from "./app-server-event-bridge";
import { toOpenAiProtocolError } from "./app-server-event-mapping";
import type {
  ApprovalPolicy,
  ThreadInjectItemsParams,
  ThreadResumeParams,
  ThreadStartParams,
  ThreadStartResponse,
  TurnStatus,
  TurnStartParams,
} from "./app-server-protocol";

/**
 * App-server approval policy derived from the driver permission policy.
 *
 * `never` = "Never ask the user to approve commands" (== the CLI
 * `--dangerously-bypass-approvals-and-sandbox` posture). The runtime sandbox is
 * already `danger-full-access` (see MOSOO_OPENAI_RUNTIME_SANDBOX_MODE), so
 * `full_access` makes the runtime fully autonomous. `supervised` uses the
 * strictest native policy so provider-selected exec/patch approvals surface to
 * the control plane.
 */
function resolveApprovalPolicy(payload: DriverStartInput): ApprovalPolicy {
  return isDriverFullAccess(payload) ? "never" : "untrusted";
}

interface OpenAiTurnStartInput {
  readonly approvalPolicy: ApprovalPolicy;
  readonly cwd: string;
  readonly model: string;
  readonly text: string;
  readonly threadId: string;
}

interface OpenAiPhaseMeasure {
  <T>(name: string, task: () => Promise<T>): Promise<T>;
}

const OPENAI_CLIENT_STOP_TIMEOUT_MS = 500;
const OPENAI_SERVER_REQUEST_CANCEL_TIMEOUT_MS = 1_500;
const OPENAI_TURN_CANCEL_EVENT_TIMEOUT_MS = 250;
const OPENAI_BACKGROUND_TERMINAL_CLEAN_TIMEOUT_MS = 500;
const MAX_OPENAI_NATIVE_THREAD_ID_BYTES = 256;

function validateOpenAiNativeThreadId(threadId: string): string {
  const utf8Bytes = Buffer.byteLength(threadId, "utf8");

  if (utf8Bytes === 0 || utf8Bytes > MAX_OPENAI_NATIVE_THREAD_ID_BYTES) {
    throw new RangeError(
      `OpenAI native thread ID must contain 1-${String(MAX_OPENAI_NATIVE_THREAD_ID_BYTES)} UTF-8 bytes (received ${String(utf8Bytes)}).`,
    );
  }

  return threadId;
}

function validateOpenAiThreadResponse(response: ThreadStartResponse): ThreadStartResponse {
  validateOpenAiNativeThreadId(response.thread.id);
  return response;
}

async function joinCancellationCleanup(tasks: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failure = results.find((result) => result.status === "rejected");

  if (failure?.status === "rejected") {
    throw failure.reason;
  }
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

  return validateOpenAiNativeThreadId(nativeResumeRef.value);
}

function isTerminalTurn(status: TurnStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function isUnmaterializedRollout(error: unknown, threadId: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message === `no rollout found for thread id ${threadId}` ||
    (error.message.includes("rollout at ") && error.message.endsWith(" is empty"))
  );
}

function toRecoveryItems(
  messages: DriverStartInput["execution"]["session"]["recoveryMessages"],
): ThreadInjectItemsParams["items"] {
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

function createTurnParams(input: OpenAiTurnStartInput): TurnStartParams {
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

export class OpenAiAppServerDriverBackend implements AgentDriverBackend {
  readonly runtime: DriverRuntime = "openai-runtime";
  readonly #payload: DriverStartInput;
  readonly #eventPublisher = new DriverEventPublisher(this.runtime, () => this.#threadId);
  #client: OpenAiAppServerClient | null = null;
  #clientStartupCancellation: AbortController | null = null;
  #clientStopRequested = false;
  #pendingTurnStartCleanup: Promise<void> | null = null;
  #pendingTurnStartCancellationEvent = false;
  #pendingTurnStartCancellationReason: string | null = null;
  #pendingTurnStartServerRequests: Promise<void> | null = null;
  #pendingTurnStartUpdates: Promise<void> | null = null;
  #restartThreadId: string | null = null;
  #stopping = false;
  #threadId: string | null = null;
  #turnStartInFlight = false;
  #turnStartRunId: RunId | null = null;
  readonly #events = new OpenAiAppServerEventBridge({
    beforeInterruptedTurn: async (context) => {
      const client = this.#client;
      if (client !== null) {
        const reason = "provider interrupted";
        await joinCancellationCleanup([
          this.#boundServerRequestCancellation(
            context,
            client.abortServerRequests(new DriverTurnCancelledError(reason)),
            reason,
          ),
          this.#closeClientForCancellation(context, client, this.#threadId, reason),
        ]);
      }
    },
    push: async (context, reason, events) => this.#eventPublisher.push(context, reason, events),
    pushSession: async (context, reason, events) =>
      this.#eventPublisher.pushSession(context, reason, events),
    pushTerminal: async (context, reason, closures, terminal) =>
      this.#eventPublisher.pushTerminal(context, reason, closures, terminal),
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

    const client = this.#createClient(context);
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
        context.ports.skill.materialize(this.#payload.execution, signal),
      );
      const artifacts = await measureStartupPhase("skills.bootstrap", () =>
        writeSkillBootstrapArtifacts(this.#payload.execution, materializedSkills, signal),
      );
      return { artifacts, count: materializedSkills.length };
    })();
    let bootstrapArtifacts: Awaited<typeof skillBootstrapPromise>;

    try {
      [, bootstrapArtifacts] = await Promise.all([clientStartPromise, skillBootstrapPromise]);
    } catch (error) {
      await this.#cleanupFailedClient(context, client, "driver.openai.startup.cleanup.failed");
      await this.#publishAgentTasksClosed(context, "driver.openai.startup.failed");
      signal.throwIfAborted();
      throw error;
    }

    let nativeResumeThreadId: string | null;
    let threadResult: ThreadStartResponse;
    try {
      signal.throwIfAborted();
      if (this.#client !== client) {
        throw new Error("OpenAi app-server backend stopped during startup.");
      }
      nativeResumeThreadId = readResumeThreadId(this.#payload);
      threadResult = await this.#startThread(
        context,
        client,
        signal,
        nativeResumeThreadId,
        measureStartupPhase,
      );
    } catch (error) {
      await this.#cleanupFailedClient(context, client, "driver.openai.startup.cleanup.failed");
      await this.#publishAgentTasksClosed(context, "driver.openai.startup.failed");
      signal.throwIfAborted();
      throw error;
    }
    if (signal.aborted) {
      await this.#publishAgentTasksClosed(context, "driver.openai.startup.cancelled");
      signal.throwIfAborted();
    }
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

  #createClient(context: AgentDriverContext): OpenAiAppServerClient {
    return new OpenAiAppServerClient(this.#payload, {
      ...context,
      handleNotification: async (method, params) =>
        this.#events.handleNotification(context, method, params),
      handleProtocolError: async (error) => {
        const boundedError = new Error(toOpenAiProtocolError({ message: error.message }).message);

        try {
          if (await this.#events.failActiveTurns(context, error)) {
            return;
          }
          if (await this.#failTurnStart(context, error)) {
            return;
          }
        } catch (projectionError) {
          this.#events.rejectActiveTurns(boundedError);
          context.lifecycle.fail(boundedError);
          throw projectionError;
        }

        context.lifecycle.fail(boundedError);
      },
      mapToolCallId: (toolCallId) => this.#events.mapToolCallId(toolCallId),
    });
  }

  async #cleanupFailedClient(
    context: AgentDriverContext,
    client: OpenAiAppServerClient,
    logEvent: string,
  ): Promise<void> {
    if (this.#client !== client) {
      return;
    }

    this.#clientStopRequested = true;
    try {
      await client.stop();
    } catch (cleanupError) {
      context.logger.error(logEvent, cleanupError, {});
      throw cleanupError;
    }
    if (this.#client === client) {
      this.#client = null;
    }
  }

  async #publishAgentTasksClosed(
    context: AgentDriverContext,
    reason: string,
    runId = context.ports.eventSink.currentRunId(),
  ): Promise<void> {
    if (runId === null) {
      return;
    }

    await this.#eventPublisher.push(context, reason, [
      {
        ...openAiAgentTasksClosedEvent(),
        runId,
        sourceEventId: `${reason}:${runId}`,
      },
    ]);
    this.#events.releaseTurnState();
  }

  async #startThread(
    context: AgentDriverContext,
    client: OpenAiAppServerClient,
    signal: AbortSignal,
    resumeThreadId: string | null,
    measure: OpenAiPhaseMeasure,
  ): Promise<ThreadStartResponse> {
    const developerInstructions = buildNativeRuntimeSystemPrompt(this.#payload.execution);
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
      historyMode: "paginated",
      sessionStartSource: "startup",
    } satisfies ThreadStartParams;

    if (resumeThreadId === null) {
      return validateOpenAiThreadResponse(
        await measure("thread.start", () =>
          client.request("thread/start", threadStartParams, signal),
        ),
      );
    }

    try {
      return validateOpenAiThreadResponse(
        await measure("thread.resume", () =>
          client.request(
            "thread/resume",
            {
              ...baseThreadParams,
              ...(developerInstructions === null ? {} : { developerInstructions }),
              excludeTurns: true,
              threadId: resumeThreadId,
            } satisfies ThreadResumeParams,
            signal,
          ),
        ),
      );
    } catch (error) {
      if (!isUnmaterializedRollout(error, resumeThreadId)) {
        throw error;
      }
    }

    context.logger.warn("driver.openai.native_resume_ref.missing_rollout", {
      nativeResumeRefPresent: true,
    });
    const threadResult = validateOpenAiThreadResponse(
      await measure("thread.start_after_missing_rollout", () =>
        client.request("thread/start", threadStartParams, signal),
      ),
    );
    const recoveryItems = toRecoveryItems(this.#payload.execution.session.recoveryMessages);

    if (recoveryItems.length > 0) {
      await measure("thread.inject_recovery_items", () =>
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
    return threadResult;
  }

  async #ensureClient(context: AgentDriverContext): Promise<void> {
    const existingClient = this.#client;
    if (existingClient !== null) {
      if (!this.#clientStopRequested && this.#threadId !== null) {
        return;
      }

      await existingClient.stop();
      if (this.#client === existingClient) {
        this.#client = null;
      }
    }
    if (this.#stopping) {
      throw new Error("OpenAI runtime app-server is stopping.");
    }

    const client = this.#createClient(context);
    const startupCancellation = new AbortController();
    const resumeThreadId = this.#restartThreadId ?? this.#threadId;
    this.#client = client;
    this.#clientStartupCancellation = startupCancellation;
    this.#clientStopRequested = false;

    try {
      await client.start(startupCancellation.signal);
      const threadResult = await this.#startThread(
        context,
        client,
        startupCancellation.signal,
        resumeThreadId,
        async (_name, task) => raceWithAbort(task(), startupCancellation.signal),
      );
      startupCancellation.signal.throwIfAborted();
      if (this.#client !== client) {
        throw new DriverTurnCancelledError(
          this.#pendingTurnStartCancellationReason ?? "turn.cancelled",
        );
      }

      this.#threadId = threadResult.thread.id;
      this.#restartThreadId = null;
      context.logger.info("driver.openai.runtime.restarted", {
        resumedThread: resumeThreadId !== null,
        threadIdPresent: true,
      });
    } catch (error) {
      await this.#cleanupFailedClient(context, client, "driver.openai.restart.cleanup.failed");
      throw error;
    } finally {
      if (this.#clientStartupCancellation === startupCancellation) {
        this.#clientStartupCancellation = null;
      }
    }
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
    this.#turnStartInFlight = true;
    this.#turnStartRunId = runId;
    this.#pendingTurnStartCleanup = null;
    this.#pendingTurnStartCancellationEvent = false;
    this.#pendingTurnStartCancellationReason = null;
    this.#pendingTurnStartServerRequests = null;
    this.#pendingTurnStartUpdates = null;

    let completion: Promise<void>;

    try {
      await this.#ensureClient(context);
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

      const turnStartRequestedAtMs = Date.now();
      const accepted = await client.requestAtWireBarrier(
        "turn/start",
        createTurnParams({
          approvalPolicy: resolveApprovalPolicy(this.#payload),
          cwd: this.#payload.execution.session.cwd,
          model: this.#payload.execution.model,
          text: input.text,
          threadId,
        }),
        {
          accept: async (turnResult) => {
            const turnId = turnResult.turn.id;
            const publicTurnId = this.#events.publicTurnId(turnId);
            const turnCompletion = this.#events.trackTurn(turnId, runId);
            void turnCompletion.catch(() => {});
            this.#claimTurnStartResponse();

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
                sourceEventId: `openai.provider.turn_start:${publicTurnId}`,
                stage: "driver_turn",
                startedAt: new Date(turnStartRequestedAtMs).toISOString(),
                native: {
                  eventName: "provider.turn_start",
                  provider: "openai",
                  turnId: publicTurnId,
                },
              }),
            ]);

            await this.#events.publishRunStarted(context, { runId, turnId });

            if (isTerminalTurn(turnResult.turn.status)) {
              await this.#events.handleNotification(context, "turn/completed", {
                threadId,
                turn: turnResult.turn,
              });
            }

            return { completion: turnCompletion };
          },
          reject: async (error) => {
            this.#claimTurnStartResponse();
            await this.#publishTurnStartFailure(context, runId, error);
          },
        },
      );
      completion = accepted.completion;
    } catch (error) {
      const publishCancellation = this.#pendingTurnStartCancellationEvent;
      const pendingCancellationReason = this.#pendingTurnStartCancellationReason;
      const failure = error instanceof Error ? error : new Error("OpenAI turn start failed.");

      if (pendingCancellationReason !== null) {
        await this.#finishPendingTurnStartCancellation(
          context,
          runId,
          pendingCancellationReason,
          publishCancellation,
        );
        this.#events.releaseTurnState();
        this.#turnStartInFlight = false;
        this.#turnStartRunId = null;
        this.#pendingTurnStartCancellationEvent = false;
        this.#pendingTurnStartCancellationReason = null;
        throw new DriverTurnCancelledError(pendingCancellationReason);
      }

      try {
        await this.#failTurnStart(context, failure);
      } finally {
        this.#turnStartInFlight = false;
        this.#turnStartRunId = null;
      }
      throw new Error(toOpenAiProtocolError({ message: failure.message }).message);
    }

    await completion;
  }

  async #failTurnStart(context: AgentDriverContext, error: Error): Promise<boolean> {
    const runId = this.#turnStartRunId;
    if (!this.#turnStartInFlight || runId === null) {
      return false;
    }
    this.#turnStartRunId = null;
    await this.#publishTurnStartFailure(context, runId, error);
    return true;
  }

  #claimTurnStartResponse(): void {
    this.#turnStartInFlight = false;
    this.#turnStartRunId = null;
    this.#pendingTurnStartCancellationEvent = false;
    this.#pendingTurnStartCancellationReason = null;
  }

  async #publishTurnStartFailure(
    context: AgentDriverContext,
    runId: RunId,
    error: Error,
  ): Promise<void> {
    const protocolError = {
      ...toOpenAiProtocolError({ message: error.message }),
      code: "openai.provider_failed",
    } as const;
    const [taskClosure, ...itemClosures] = this.#events.turnStartTerminalEvents({
      error: protocolError,
      kind: "failed",
    });

    await this.#eventPublisher.pushTerminal(
      context,
      "driver.openai.provider.failed",
      [
        {
          ...taskClosure,
          runId,
          sourceEventId: `openai.provider.failed.closure:${runId}:0`,
        },
        {
          kind: "run.started",
          payload: {
            startedAt: new Date().toISOString(),
          },
          runId,
          sourceEventId: `openai.provider.failed.started:${runId}`,
        },
        ...itemClosures.map((event, index) => ({
          ...event,
          runId,
          sourceEventId:
            event.sourceEventId ?? `openai.provider.failed.closure:${runId}:${String(index + 1)}`,
        })),
      ],
      {
        kind: "run.failed",
        payload: {
          error: {
            ...protocolError,
          },
          recoverable: false,
        },
        runId,
        sourceEventId: `openai.provider.failed.terminal:${runId}`,
      },
    );
    this.#events.releaseTurnState();
  }

  async #publishTurnStartCancellation(
    context: AgentDriverContext,
    runId: RunId,
    reason: string,
  ): Promise<void> {
    const [taskClosure, ...itemClosures] = this.#events.turnStartTerminalEvents({
      kind: "cancelled",
    });
    await this.#eventPublisher.pushTerminal(
      context,
      "driver.openai.turn_start.cancelled",
      [
        {
          ...taskClosure,
          runId,
          sourceEventId: `openai.turn_start.cancelled.closure:${runId}:0`,
        },
        {
          kind: "run.started",
          payload: {
            startedAt: new Date().toISOString(),
          },
          runId,
          sourceEventId: `openai.turn_start.cancelled.started:${runId}`,
        },
        {
          kind: "run.cancel.requested",
          payload: {
            reason,
            requestedBy: "user",
            targetRunId: runId,
          },
          runId,
          sourceEventId: `openai.turn_start.cancelled.requested:${runId}`,
        },
        ...itemClosures.map((event, index) => ({
          ...event,
          runId,
          sourceEventId:
            event.sourceEventId ??
            `openai.turn_start.cancelled.closure:${runId}:${String(index + 1)}`,
        })),
      ],
      {
        kind: "run.cancelled",
        payload: {
          requestedBy: "user",
          stopReason: "cancelled",
        },
        runId,
        sourceEventId: `openai.turn_start.cancelled.terminal:${runId}`,
      },
    );
  }

  async #finishPendingTurnStartCancellation(
    context: AgentDriverContext,
    runId: RunId,
    reason: string,
    publish: boolean,
  ): Promise<void> {
    try {
      await this.#waitPendingTurnStartCleanup();
      await this.#waitPendingTurnStartServerRequests();
      await this.#waitPendingTurnStartUpdates();
      if (publish) {
        await this.#publishTurnStartCancellation(context, runId, reason);
      }
    } catch (error) {
      throw new DriverTurnCancellationCleanupError(
        `OpenAI pending turn cancellation cleanup failed: ${
          error instanceof Error ? error.message : "unknown cleanup error"
        }`,
        error,
      );
    }
  }

  async #waitPendingTurnStartServerRequests(): Promise<void> {
    const pending = this.#pendingTurnStartServerRequests;
    this.#pendingTurnStartServerRequests = null;
    if (pending !== null) {
      await pending;
    }
  }

  async #waitPendingTurnStartCleanup(): Promise<void> {
    const pending = this.#pendingTurnStartCleanup;
    this.#pendingTurnStartCleanup = null;
    if (pending !== null) {
      await pending;
    }
  }

  async #waitPendingTurnStartUpdates(): Promise<void> {
    const pending = this.#pendingTurnStartUpdates;
    this.#pendingTurnStartUpdates = null;
    if (pending !== null) {
      await pending;
    }
  }

  async cancelActiveTurn(context: AgentDriverContext, reason: string): Promise<void> {
    try {
      await this.#cancelActiveTurn(context, reason, true);
    } catch (error) {
      if (error instanceof DriverTurnCancellationCleanupError) {
        throw error;
      }

      throw new DriverTurnCancellationCleanupError(
        `OpenAI cancelled turn cleanup failed: ${
          error instanceof Error ? error.message : "unknown cleanup error"
        }`,
        error,
      );
    }
  }

  async #cancelActiveTurn(
    context: AgentDriverContext,
    reason: string,
    publishTurnStartCancellation: boolean,
  ): Promise<void> {
    const client = this.#client;
    const threadId = this.#threadId;

    if (client === null) {
      return;
    }

    const serverRequests = this.#boundServerRequestCancellation(
      context,
      client.abortServerRequests(new DriverTurnCancelledError(reason)),
      reason,
    );
    void serverRequests.catch(() => {});

    if (this.#turnStartInFlight) {
      if (!publishTurnStartCancellation) {
        await this.#publishAgentTasksClosed(
          context,
          "driver.openai.turn_start.stopped",
          this.#turnStartRunId,
        );
      }
      this.#pendingTurnStartCancellationEvent = publishTurnStartCancellation;
      this.#pendingTurnStartCancellationReason = reason;
      this.#pendingTurnStartServerRequests = serverRequests;
      const cleanup = this.#closeClientForCancellation(context, client, threadId, reason);
      this.#pendingTurnStartCleanup = cleanup;
      this.#pendingTurnStartUpdates = cleanup.then(() => client.drainServerMessages());
      void this.#pendingTurnStartUpdates.catch(() => {});
      await cleanup;
      return;
    }

    if (threadId === null) {
      await serverRequests;
      return;
    }

    const activeTurnIds = this.#events.activeTurnIds();

    if (activeTurnIds.length === 0) {
      try {
        await client.request(
          "thread/backgroundTerminals/clean",
          { threadId },
          AbortSignal.timeout(OPENAI_BACKGROUND_TERMINAL_CLEAN_TIMEOUT_MS),
        );
        await serverRequests;
        await client.drainServerMessages();
      } catch (error) {
        context.logger.warn("driver.openai.background_terminals.clean.failed", {
          message: error instanceof Error ? error.message : "background terminal clean failed",
          reason,
        });
        await joinCancellationCleanup([
          serverRequests,
          this.#closeClientForCancellation(context, client, threadId, reason),
        ]);
      }
      this.#events.releaseTurnState();
      return;
    }

    try {
      await joinCancellationCleanup([
        serverRequests,
        this.#closeClientForCancellation(context, client, threadId, reason),
      ]);
    } catch (error) {
      const cleanupError = new DriverTurnCancellationCleanupError(
        `OpenAI cancelled turn cleanup failed: ${
          error instanceof Error ? error.message : "unknown cleanup error"
        }`,
        error,
      );
      this.#events.rejectActiveTurns(cleanupError);
      throw cleanupError;
    }
    const updatesDrained = client.drainServerMessages();
    const cancellationEvents = Promise.all(
      activeTurnIds.map((turnId) =>
        this.#events.cancelTurn(context, turnId, reason, () => updatesDrained),
      ),
    ).catch((error: unknown) => {
      const cleanupError = new DriverTurnCancellationCleanupError(
        `OpenAI cancellation event delivery failed: ${
          error instanceof Error ? error.message : "unknown delivery error"
        }`,
        error,
      );
      this.#events.rejectActiveTurns(cleanupError);
      throw cleanupError;
    });
    void cancellationEvents.catch(() => {});
    const cancellationSettlement = await settlePromiseWithTimeout(cancellationEvents, {
      label: "OpenAI turn cancellation event delivery",
      timeoutMs: OPENAI_TURN_CANCEL_EVENT_TIMEOUT_MS,
    });

    if (cancellationSettlement.status === "failed") {
      throw cancellationSettlement.error;
    }

    if (cancellationSettlement.status === "timed_out") {
      context.logger.warn("driver.openai.turn.cancellation_event.pending", {
        message: cancellationSettlement.error.message,
        reason,
      });
    }
  }

  #boundServerRequestCancellation(
    context: AgentDriverContext,
    cancellation: Promise<void>,
    reason: string,
  ): Promise<void> {
    return raceWithAbort(
      cancellation,
      AbortSignal.timeout(OPENAI_SERVER_REQUEST_CANCEL_TIMEOUT_MS),
    ).catch((error: unknown) => {
      context.logger.warn("driver.openai.server_requests.cancel.failed", {
        message: error instanceof Error ? error.message : "server request cancellation failed",
        reason,
      });
      throw error;
    });
  }

  async #closeClientForCancellation(
    context: AgentDriverContext,
    client: OpenAiAppServerClient,
    threadId: string | null,
    reason: string,
  ): Promise<void> {
    const isCurrentClient = this.#client === client;
    if (isCurrentClient) {
      this.#restartThreadId = threadId;
      this.#clientStopRequested = true;
    }
    this.#clientStartupCancellation?.abort(new DriverTurnCancelledError(reason));

    try {
      await client.stop(AbortSignal.timeout(OPENAI_CLIENT_STOP_TIMEOUT_MS));
      if (isCurrentClient && this.#client === client) {
        this.#client = null;
      }
    } catch (error) {
      context.logger.error("driver.openai.cancel.client_stop.failed", error, { reason });
      throw error;
    }
  }

  async stop(context: AgentDriverContext, reason: string, signal: AbortSignal): Promise<void> {
    this.#stopping = true;
    const client = this.#client;
    let clientStopped = client === null;

    try {
      signal.throwIfAborted();
      if (!this.#clientStopRequested) {
        await raceWithAbort(this.#cancelActiveTurn(context, reason, false), signal);
      }
    } finally {
      this.#events.rejectActiveTurns(new DriverTurnCancelledError(reason));

      try {
        if (client !== null) {
          this.#clientStopRequested = true;
          await client.stop(signal);
          clientStopped = true;
        }
      } finally {
        this.#events.clearActiveTurns();

        if (clientStopped && this.#client === client) {
          this.#client = null;
        }
      }
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
