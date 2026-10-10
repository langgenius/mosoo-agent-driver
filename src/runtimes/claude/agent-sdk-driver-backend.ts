import { mkdir } from "node:fs/promises";

import { query, startup } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { DriverTurnCancelledError } from "../../core/driver-runtime-state";
import {
  createTimingEvent,
  createTimingPhase,
  toDurationMs,
} from "../../core/driver-runtime-timing";
import {
  summarizePath,
  summarizePathCollection,
  summarizeRuntimeCommandInput,
} from "../../observability/driver-debug";
import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import type { NativeCheckpoint } from "../../protocol/native-checkpoint";
import type { DriverRuntime } from "../../protocol/runtime";
import type { DriverStartInput } from "../../protocol/start";
import type { RuntimeCommandInput } from "../../runtime-command";
import { raceWithAbort, settlePromiseWithTimeout } from "../../utils/async";
import type { AgentDriverBackend, AgentDriverContext } from "../../core/agent-driver-backend";
import {
  DriverCompletedTerminalSupersededError,
  DriverEventPublisher,
  DriverNativeCheckpointCleanupError,
} from "../driver-event-publisher";
import { createRuntimeSourceEventId, toRuntimePublicId } from "../runtime-public-id";
import { computeRuntimeBootstrapDigest, writeSkillBootstrapArtifacts } from "../skill-bootstrap";
import { isRecord, readProcessEnvString, toErrorMessage } from "./agent-sdk-json";
import { ClaudeDurableEventTooLargeError } from "./agent-sdk-event-writer";
import { ClaudeAgentSdkPrewarm } from "./agent-sdk-prewarm";
import {
  ClaudeAgentSdkMessageTranslator,
  ClaudeTerminalWriteError,
  type ClaudePreparedResult,
  type ClaudeTerminalOutcome,
} from "./agent-sdk-message-translator";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  createClaudeQueryOptions,
  resolveClaudeConfigDir,
} from "./agent-sdk-query-options";
import { buildClaudeRecoveryPrompt } from "./agent-sdk-recovery-context";
import { readClaudeNativeResumeSessionId, requireClaudeNativeSessionId } from "./agent-sdk-resume";
import { drainClaudeTasks } from "./agent-sdk-tasks";
import { ClaudeStreamingQuery } from "./agent-sdk-streaming-query";
import { waitForClaudeTranscript } from "./agent-sdk-transcript";
import type { ClaudeTranscriptCursor } from "./agent-sdk-transcript";
import {
  createClaudeNativeCheckpoint,
  restoreClaudeNativeCheckpoint,
} from "./agent-sdk-checkpoint";

interface ActiveClaudeTurn {
  abortController: AbortController;
  readonly context: AgentDriverContext;
  cancelReason: string | null;
  permissionDrainTask: Promise<void> | null;
  permissionTasks: Set<Promise<unknown>>;
  processTasks: Set<Promise<void>>;
  query: Query | null;
  queryCloseTask: Promise<void> | null;
  stream: ClaudeStreamingQuery | null;
  runId: RunId;
  runSignal: AbortSignal | null;
  readonly settled: ReturnType<typeof Promise.withResolvers<void>>;
  state: "running" | "finalizing" | "cancelled";
}

interface ClaudeAgentSdkDriverBackendDependencies {
  readonly createNativeCheckpoint: typeof createClaudeNativeCheckpoint;
  readonly createQueryOptions: typeof createClaudeQueryOptions;
  readonly query: typeof query;
  readonly startup: typeof startup;
  readonly restoreNativeCheckpoint: typeof restoreClaudeNativeCheckpoint;
  readonly waitForTranscript: typeof waitForClaudeTranscript;
}

const DEFAULT_DEPENDENCIES: ClaudeAgentSdkDriverBackendDependencies = {
  createNativeCheckpoint: createClaudeNativeCheckpoint,
  createQueryOptions: createClaudeQueryOptions,
  query,
  startup,
  restoreNativeCheckpoint: restoreClaudeNativeCheckpoint,
  waitForTranscript: waitForClaudeTranscript,
};

const CLAUDE_QUERY_RETURN_TIMEOUT_MS = 2_500;

function isTurnCancelled(turn: ActiveClaudeTurn): boolean {
  return turn.state === "cancelled" || turn.runSignal?.aborted === true;
}

function turnCancellationReason(turn: ActiveClaudeTurn): string {
  return (
    turn.cancelReason ??
    toErrorMessage(turn.runSignal?.reason, "Claude Agent SDK turn was cancelled.")
  );
}

export class ClaudeAgentSdkDriverBackend implements AgentDriverBackend {
  readonly runtime: DriverRuntime = "claude-agent-sdk";
  readonly #dependencies: ClaudeAgentSdkDriverBackendDependencies;
  readonly #eventPublisher = new DriverEventPublisher(this.runtime, () => this.#nativeSessionId);
  readonly #messageTranslator: ClaudeAgentSdkMessageTranslator;
  readonly #payload: DriverStartInput;
  readonly #pendingProcessTasks = new Set<Promise<void>>();
  readonly #pendingControlStreams = new Set<ClaudeStreamingQuery>();
  readonly #pendingTerminalReleases = new Set<ClaudeStreamingQuery>();
  readonly #prewarm: ClaudeAgentSdkPrewarm;
  #activeTurn: ActiveClaudeTurn | null = null;
  #idleTurn: ActiveClaudeTurn | null = null;
  #nativeSessionId: string | null = null;
  #committedCheckpoint: NativeCheckpoint | null;
  #pendingReset: DriverEventInput | null = null;
  #stopRequested = false;
  #stopTask: Promise<void> | null = null;

  constructor(
    payload: DriverStartInput,
    dependencies: Partial<ClaudeAgentSdkDriverBackendDependencies> = {},
  ) {
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    this.#payload = payload;
    this.#committedCheckpoint = payload.execution.session.nativeCheckpoint;
    this.#nativeSessionId = readClaudeNativeResumeSessionId(payload);
    this.#prewarm = new ClaudeAgentSdkPrewarm({
      createQueryOptions: this.#dependencies.createQueryOptions,
      getNativeSessionId: () => this.#nativeSessionId,
      payload,
      publicToolCallId: (nativeToolCallId) => toRuntimePublicId(nativeToolCallId, "claude-tool"),
      startup: async (input) => this.#dependencies.startup(input),
    });
    this.#messageTranslator = new ClaudeAgentSdkMessageTranslator({
      publicToolCallId: (nativeToolCallId) => toRuntimePublicId(nativeToolCallId, "claude-tool"),
      push: async (context, reason, events) => this.#push(context, reason, events),
      pushTerminal: async (context, reason, closures, terminal) => {
        const activeTurn = this.#activeTurn;
        await this.#eventPublisher.pushTerminal(
          context,
          reason,
          closures,
          terminal,
          terminal.kind === "run.completed" ? (activeTurn?.runSignal ?? undefined) : undefined,
        );
      },
      recordNativeSessionId: async (context, sessionId) =>
        this.#recordNativeSessionId(context, sessionId),
      replaceNativeSessionId: async (context, previousSessionId, nextSessionId, messageId) =>
        this.#replaceNativeSessionId(
          context,
          previousSessionId,
          nextSessionId,
          createRuntimeSourceEventId(
            "claude.session.reset",
            this.#payload.execution.run.sessionId,
            messageId,
          ),
        ),
      sessionId: payload.execution.run.sessionId,
    });
  }

  async start(context: AgentDriverContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#stopRequested) {
      throw new Error("Claude Agent SDK backend cannot restart after stopping.");
    }

    await this.#eventPublisher.initializeNativeCheckpointRoot(context, signal);
    await this.#dependencies.restoreNativeCheckpoint(this.#payload, signal);
    const materializedSkills = await context.ports.skill.materialize(
      this.#payload.execution,
      signal,
    );
    const bootstrapArtifacts = await writeSkillBootstrapArtifacts(
      this.#payload.execution,
      materializedSkills,
      signal,
    );
    const { homePath } = this.#payload.execution.session;
    const claudeConfigDir = resolveClaudeConfigDir(this.#payload);
    await raceWithAbort(mkdir(claudeConfigDir, { recursive: true }), signal);

    if (this.#stopRequested || signal.aborted) {
      signal.throwIfAborted();
      throw new Error("Claude Agent SDK backend stopped during startup.");
    }

    context.logger.info("driver.claude.runtime.started", {
      bootstrapArtifacts,
      bootstrapDigest: computeRuntimeBootstrapDigest(this.#payload.execution),
      execution: {
        additionalDirectories: summarizePathCollection(
          this.#payload.execution.session.additionalDirectories,
        ),
        claudeCodeExecutable: summarizePath(readProcessEnvString(CLAUDE_CODE_EXECUTABLE_ENV)),
        claudeConfigDir: summarizePath(claudeConfigDir),
        cwd: summarizePath(this.#payload.execution.session.cwd),
        homePath: summarizePath(homePath),
        model: this.#payload.execution.model,
        provider: this.#payload.execution.provider,
        sharedRootPath: summarizePath(this.#payload.execution.session.sharedRootPath),
      },
      nativeResumeRefPresent: Boolean(this.#nativeSessionId),
      skillCount: materializedSkills.length,
    });

    this.#prewarm.start(context, signal);
  }

  async handleInput(
    context: AgentDriverContext,
    input: RuntimeCommandInput,
    runId: RunId,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#activeTurn) {
      throw new Error("Claude Agent SDK already has an active turn.");
    }

    if (this.#stopRequested) {
      throw new Error("Claude Agent SDK backend has stopped.");
    }

    const idleTurn = this.#idleTurn;
    this.#idleTurn = null;
    const { abortController, permissionTasks, processTasks, warmQuery } =
      idleTurn === null ? this.#prewarm.take() : { ...idleTurn, warmQuery: null };
    const activeTurn: ActiveClaudeTurn = {
      abortController,
      context,
      cancelReason: null,
      permissionDrainTask: null,
      permissionTasks,
      processTasks,
      query: idleTurn?.query ?? null,
      queryCloseTask: null,
      stream: idleTurn?.stream ?? null,
      runId,
      runSignal: signal ?? null,
      settled: Promise.withResolvers<void>(),
      state: "running",
    };
    this.#activeTurn = activeTurn;
    let turnSignal =
      activeTurn.runSignal === null
        ? activeTurn.abortController.signal
        : AbortSignal.any([activeTurn.abortController.signal, activeTurn.runSignal]);

    let queryStartedAtMs = Date.now();
    let queryOptionsMs = 0;
    let runStarted = false;

    let preparedResult: ClaudePreparedResult | null = null;
    let terminalOutcome: ClaudeTerminalOutcome | null = null;
    let terminalAcknowledged = false;
    const transcriptCursors = new Map<string, ClaudeTranscriptCursor>();

    try {
      await this.#flushSessionControls(context);
      this.#messageTranslator.resetTurnMessageState();

      // Replay platform history only until a native session has been established.
      const recoveryMessages =
        this.#nativeSessionId === null ? this.#payload.execution.session.recoveryMessages : [];
      const promptText = buildClaudeRecoveryPrompt(recoveryMessages, input.text);

      await this.#push(context, "driver.claude.turn.started", [
        {
          kind: "run.started",
          payload: { startedAt: new Date().toISOString() },
          runId,
        },
      ]);
      runStarted = true;
      queryStartedAtMs = Date.now();

      if (isTurnCancelled(activeTurn)) {
        throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
      }

      let activeQuery: AsyncIterator<SDKMessage>;

      try {
        await activeTurn.stream?.flushControls();
        if (isTurnCancelled(activeTurn) || this.#stopRequested) {
          throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
        }
        if (
          activeTurn.stream !== null &&
          (!activeTurn.stream.reusable || idleTurn?.context !== context)
        ) {
          // An idle EOF/crash is recoverable through the last durable native cursor.
          await this.#closeQuery(context, activeTurn, "session.exited");
          await activeTurn.stream.flushControls();
          if (isTurnCancelled(activeTurn) || this.#stopRequested) {
            throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
          }
          Object.assign(activeTurn, {
            abortController: new AbortController(),
            permissionDrainTask: null,
            permissionTasks: new Set<Promise<unknown>>(),
            processTasks: new Set<Promise<void>>(),
            query: null,
            queryCloseTask: null,
            stream: null,
          });
          turnSignal =
            signal === undefined
              ? activeTurn.abortController.signal
              : AbortSignal.any([activeTurn.abortController.signal, signal]);
        }
        const createQuery = (create: (prompt: AsyncIterable<SDKUserMessage>) => Query) => {
          activeTurn.stream = new ClaudeStreamingQuery({
            createQuery: create,
            reuse: this.#canReuseQuery(),
            onFailure: (error) => {
              context.logger.debug("driver.claude.session.reader_failed", {
                message: toErrorMessage(error, "Claude session reader failed."),
              });
              activeTurn.abortController.abort(error);
            },
            onIdleMessage: async (message) => {
              if (message.type === "conversation_reset") {
                await this.#replaceNativeSessionId(
                  context,
                  message.session_id,
                  message.new_conversation_id,
                  createRuntimeSourceEventId(
                    "claude.session.reset",
                    this.#payload.execution.run.sessionId,
                    message.uuid,
                  ),
                );
              } else {
                context.logger.debug("driver.claude.session.idle_message", { type: message.type });
              }
            },
          });
          this.#pendingControlStreams.add(activeTurn.stream);
          activeTurn.processTasks.add(activeTurn.stream.finished);
          activeTurn.query = activeTurn.stream.query;
          return activeTurn.stream.submit(promptText);
        };
        if (activeTurn.stream !== null) {
          activeQuery = activeTurn.stream.submit(promptText);
        } else if (warmQuery !== null) {
          activeQuery = createQuery((prompt) => warmQuery.query(prompt));
        } else {
          const optionsStartedAtMs = Date.now();
          const queryOptions = await raceWithAbort(
            this.#dependencies.createQueryOptions({
              abortController: activeTurn.abortController,
              context,
              nativeSessionId: this.#nativeSessionId,
              payload: this.#payload,
              permissionTasks: activeTurn.permissionTasks,
              processTasks: activeTurn.processTasks,
              publicToolCallId: (nativeToolCallId) =>
                toRuntimePublicId(nativeToolCallId, "claude-tool"),
            }),
            turnSignal,
          );
          queryOptionsMs = Date.now() - optionsStartedAtMs;

          if (isTurnCancelled(activeTurn)) {
            throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
          }

          activeQuery = createQuery((prompt) =>
            this.#dependencies.query({
              options: queryOptions,
              prompt,
            }),
          );
        }

        if (isTurnCancelled(activeTurn)) {
          await this.#closeQuery(context, activeTurn, turnCancellationReason(activeTurn));
          throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
        }
      } catch (error) {
        if (warmQuery !== null && activeTurn.query === null) {
          try {
            warmQuery.close();
          } catch {}
        }

        if (isTurnCancelled(activeTurn)) {
          throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
        }

        await this.#push(context, "driver.claude.query.create_failed", [
          {
            kind: "diagnostic.reported",
            payload: {
              message: "Claude Agent SDK query creation failed.",
              raw: {
                message: toErrorMessage(error, "Claude Agent SDK query creation failed."),
                nativeSessionIdPresent: Boolean(this.#nativeSessionId),
              },
              severity: "error",
            },
            visibility: "owner_debug",
          },
        ]);
        throw error;
      }

      const queryCreateMs = Date.now() - queryStartedAtMs;
      context.logger.info("driver.claude.prompt.sending", {
        nativeSessionIdPresent: Boolean(this.#nativeSessionId),
        queryReused: idleTurn !== null && activeTurn.stream === idleTurn.stream,
        recoveryMessageCount: recoveryMessages.length,
        textLength: promptText.length,
      });
      context.logger.debug("driver.claude.prompt.requested", {
        input: summarizeRuntimeCommandInput(input),
        nativeSessionIdPresent: Boolean(this.#nativeSessionId),
      });

      let firstProviderEventPublished = false;
      const providerStartedAtMs = Date.now();
      for (;;) {
        let iteration: IteratorResult<SDKMessage>;
        try {
          iteration = await raceWithAbort(activeQuery.next(), turnSignal);
        } catch (error) {
          if (
            preparedResult !== null &&
            activeTurn.state === "finalizing" &&
            !isTurnCancelled(activeTurn) &&
            activeTurn.abortController.signal.aborted
          ) {
            break;
          }
          throw error;
        }
        if (iteration.done) {
          break;
        }
        const message = iteration.value;

        if (message.type === "conversation_reset") {
          transcriptCursors.clear();
        } else if (message.type === "assistant") {
          transcriptCursors.set(message.uuid, {
            sessionId: message.session_id,
            messageId: message.uuid,
            contentJson: JSON.stringify(message.message.content),
          });
        }

        if (isTurnCancelled(activeTurn)) {
          throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
        }

        if (!firstProviderEventPublished) {
          firstProviderEventPublished = true;
          const firstProviderEventAtMs = Date.now();

          await this.#push(context, "driver.claude.provider.first_event", [
            createTimingEvent({
              completedAt: new Date(firstProviderEventAtMs).toISOString(),
              path: "unknown",
              phases: [
                createTimingPhase("createQueryOptions", queryOptionsMs),
                createTimingPhase("query.create", queryCreateMs),
                createTimingPhase(
                  "provider.first_event",
                  toDurationMs(providerStartedAtMs, firstProviderEventAtMs),
                ),
              ],
              runId,
              sessionId: context.payload.execution.run.sessionId,
              stage: "driver_turn",
              startedAt: new Date(queryStartedAtMs).toISOString(),
            }),
          ]);
        }

        if (isTurnCancelled(activeTurn)) {
          throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
        }

        if (preparedResult !== null) {
          if (message.type === "result") {
            throw new Error("Claude Agent SDK emitted multiple result frames.");
          }
          if (
            message.type === "assistant" ||
            message.type === "stream_event" ||
            message.type === "user"
          ) {
            throw new Error("Claude Agent SDK emitted turn content after its result frame.");
          }
          await this.#messageTranslator.handleSdkMessage(context, message, runId, true);
          continue;
        }

        if (message.type === "result") {
          activeTurn.state = "finalizing";
          preparedResult = await this.#messageTranslator.prepareResult(context, message, runId);
          continue;
        }

        await this.#messageTranslator.handleSdkMessage(context, message, runId);
      }

      if (preparedResult === null && isTurnCancelled(activeTurn)) {
        throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
      }

      if (preparedResult === null) {
        throw new Error("Claude Agent SDK query ended before a result frame.");
      }

      activeTurn.stream?.throwIfFailed();
      if (activeTurn.stream?.reusable && preparedResult.terminal.kind === "run.completed") {
        activeTurn.permissionDrainTask = drainClaudeTasks(activeTurn.permissionTasks);
        await activeTurn.permissionDrainTask;
        const persisted = await this.#dependencies
          .waitForTranscript(
            resolveClaudeConfigDir(this.#payload),
            activeTurn.stream.transcriptCursor,
            turnSignal,
          )
          .catch((error: unknown) => {
            // Cancellation after result selection closes/flushes the query but
            // retains that result, as on the original one-shot path.
            if (
              activeTurn.queryCloseTask !== null &&
              activeTurn.abortController.signal.aborted &&
              !isTurnCancelled(activeTurn)
            )
              return false;
            throw error;
          });
        if (!persisted) {
          context.logger.debug("driver.claude.session.transcript_unconfirmed", {});
          activeTurn.stream.closeInput();
          if (activeTurn.queryCloseTask === null) {
            // EOF flushes the CLI transcript. Do not kill the process before
            // that graceful drain when persistence could not be confirmed.
            const drained = await settlePromiseWithTimeout(activeTurn.stream.finished, {
              label: "Claude transcript drain",
              timeoutMs: CLAUDE_QUERY_RETURN_TIMEOUT_MS,
            });
            if (drained.status !== "completed") throw drained.error;
            activeTurn.stream.throwIfFailed();
          }
        }
      }
      if (
        !activeTurn.stream?.reusable ||
        preparedResult.terminal.kind !== "run.completed" ||
        activeTurn.queryCloseTask !== null ||
        activeTurn.abortController.signal.aborted ||
        this.#stopRequested
      ) {
        await this.#closeQuery(context, activeTurn, "provider.result");
      }
      let checkpoint: NativeCheckpoint | null = null;
      if (preparedResult.terminal.kind === "run.completed") {
        const terminalPayload = preparedResult.terminal.payload;
        if (!isRecord(terminalPayload)) {
          throw new Error("Claude completion requires an object payload.");
        }
        if (this.#nativeSessionId === null) {
          throw new Error("Claude completion requires a native session.");
        }
        const checkpointStartedAt = Date.now();
        checkpoint = await this.#dependencies.createNativeCheckpoint({
          payload: this.#payload,
          runId,
          sessionId: this.#nativeSessionId,
          expectedTranscriptCursors: [...transcriptCursors.values()],
          signal: activeTurn.runSignal ?? new AbortController().signal,
        });
        // The host requires this Run's cursor even when the native session ID is unchanged.
        await this.#publishNativeResumeRef(context, this.#nativeSessionId);
        preparedResult = {
          ...preparedResult,
          terminal: {
            ...preparedResult.terminal,
            payload: { ...terminalPayload, checkpoint },
          },
        };
        await this.#push(context, "driver.claude.native_checkpoint.created", [
          createTimingEvent({
            phases: [createTimingPhase("native.checkpoint", toDurationMs(checkpointStartedAt))],
            path: "unknown",
            runId,
            sessionId: this.#payload.execution.run.sessionId,
            stage: "driver_turn",
            startedAt: new Date(checkpointStartedAt).toISOString(),
          }),
        ]);
      }
      terminalOutcome = await this.#messageTranslator.publishPreparedResult(
        context,
        preparedResult,
      );
      terminalAcknowledged = true;
      if (checkpoint !== null) {
        this.#committedCheckpoint = checkpoint;
      }
    } catch (error) {
      if (!runStarted) {
        throw error;
      }

      if (error instanceof ClaudeTerminalWriteError) {
        if (error.cause instanceof DriverNativeCheckpointCleanupError) {
          terminalAcknowledged = true;
          this.#committedCheckpoint = error.cause.checkpoint;
          if (activeTurn.stream !== null) {
            this.#pendingTerminalReleases.add(activeTurn.stream);
          }
          throw error.cause;
        }
        const replaceableCompletion =
          error.terminalKind === "run.completed" &&
          (error.cause === activeTurn.runSignal?.reason ||
            (error.cause instanceof DriverCompletedTerminalSupersededError &&
              error.cause.cause === activeTurn.runSignal?.reason));
        if (!replaceableCompletion) {
          throw error.cause;
        }
      }

      if (isTurnCancelled(activeTurn)) {
        const cancellationReason = turnCancellationReason(activeTurn);
        await this.#closeQuery(context, activeTurn, cancellationReason);
        await this.#messageTranslator.cancelTurn(context, runId, cancellationReason);
        terminalAcknowledged = true;
        throw new DriverTurnCancelledError(cancellationReason);
      }

      activeTurn.state = "finalizing";
      await this.#closeQuery(context, activeTurn, "turn.failed");

      if (error instanceof ClaudeTerminalWriteError) {
        throw error.cause;
      }

      const message = toErrorMessage(error, "Claude Agent SDK turn failed.");
      await this.#messageTranslator.failTurn(
        context,
        runId,
        error instanceof ClaudeDurableEventTooLargeError ? error.code : "claude.turn_failed",
        message,
      );
      terminalAcknowledged = true;
      throw error;
    } finally {
      let retainQuery = false;
      try {
        if (
          terminalAcknowledged &&
          (activeTurn.stream === null || !this.#pendingTerminalReleases.has(activeTurn.stream))
        ) {
          await activeTurn.stream?.releaseTurn();
        }
        retainQuery =
          terminalOutcome?.kind === "run.completed" &&
          activeTurn.stream?.reusable === true &&
          activeTurn.queryCloseTask === null &&
          !activeTurn.abortController.signal.aborted &&
          !this.#stopRequested;
        if (retainQuery) {
          this.#idleTurn = activeTurn;
        }
      } finally {
        try {
          if (!retainQuery) {
            await this.#closeQuery(context, activeTurn, "turn.finished");
          }
        } finally {
          if (!retainQuery) {
            this.#retainProcessTasks(activeTurn);
          }
          if (this.#activeTurn === activeTurn) {
            this.#activeTurn = null;
          }
          activeTurn.settled.resolve();
        }
      }
    }

    if (terminalOutcome.kind === "run.cancelled") {
      throw new DriverTurnCancelledError(
        terminalOutcome.payload.reason ?? "Claude Agent SDK turn was cancelled by the provider.",
      );
    }
    if (terminalOutcome.kind === "run.failed") {
      throw new Error(terminalOutcome.payload.error.message);
    }
  }

  async cancelActiveTurn(context: AgentDriverContext, reason: string): Promise<void> {
    const activeTurn = this.#activeTurn;

    if (!activeTurn) {
      return;
    }

    if (activeTurn.state === "finalizing") {
      activeTurn.abortController.abort(reason);
      void this.#closeQuery(context, activeTurn, reason).catch(() => {});
      return;
    }

    if (activeTurn.state === "cancelled") {
      return;
    }

    activeTurn.state = "cancelled";
    activeTurn.cancelReason = reason;
    activeTurn.abortController.abort(reason);
    void this.#closeQuery(context, activeTurn, reason).catch(() => {});
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
    const activeTurn = this.#activeTurn;
    const prewarmStop = this.#prewarm.stop(context, reason, signal);
    const idleTurn = this.#idleTurn;
    const idleCleanup =
      idleTurn === null
        ? Promise.resolve()
        : raceWithAbort(
            this.#closeQuery(context, idleTurn, reason).finally(() => {
              this.#retainProcessTasks(idleTurn);
              if (this.#idleTurn === idleTurn) {
                this.#idleTurn = null;
              }
            }),
            signal,
          );
    const activeCleanup =
      activeTurn === null
        ? Promise.resolve()
        : raceWithAbort(
            (async () => {
              await this.cancelActiveTurn(context, reason);
              const [closeResult] = await Promise.allSettled([
                this.#closeQuery(context, activeTurn, reason),
                activeTurn.settled.promise,
              ]);
              if (closeResult.status === "rejected") {
                throw closeResult.reason;
              }
            })(),
            signal,
          );
    const [activeResult, prewarmResult, pendingResult, idleResult] = await Promise.allSettled([
      activeCleanup,
      prewarmStop,
      raceWithAbort(drainClaudeTasks(this.#pendingProcessTasks), signal),
      idleCleanup,
    ]);

    if (activeResult.status === "rejected") {
      throw activeResult.reason;
    }

    if (prewarmResult.status === "rejected") {
      throw prewarmResult.reason;
    }

    if (pendingResult.status === "rejected") {
      throw pendingResult.reason;
    }
    if (idleResult.status === "rejected") {
      throw idleResult.reason;
    }
    await raceWithAbort(this.#flushSessionControls(context), signal);
  }

  async #flushSessionControls(context: AgentDriverContext): Promise<void> {
    await this.#eventPublisher.finishTerminalCleanup(context);
    for (const stream of this.#pendingTerminalReleases) {
      await stream.releaseTurn();
      this.#pendingTerminalReleases.delete(stream);
    }
    await this.#flushPendingReset(context);
    for (const stream of this.#pendingControlStreams) {
      await stream.flushControls();
      if (!stream.reusable && !stream.hasPendingControls) {
        this.#pendingControlStreams.delete(stream);
      }
    }
  }

  #canReuseQuery(): boolean {
    // maxBudgetUsd spans messages; retain one query per Run for all explicit budgets.
    const options = this.#payload.execution.providerOptions;
    return (
      options["maxBudgetUsd"] === undefined &&
      options["maxTurns"] === undefined &&
      options["taskBudget"] === undefined
    );
  }

  #retainProcessTasks(turn: ActiveClaudeTurn): void {
    for (const task of turn.processTasks) {
      this.#pendingProcessTasks.add(task);
    }
    turn.processTasks.clear();
  }

  async #recordNativeSessionId(context: AgentDriverContext, sessionId: string): Promise<void> {
    requireClaudeNativeSessionId(sessionId);

    if (this.#nativeSessionId === sessionId) {
      return;
    }

    if (this.#nativeSessionId !== null) {
      throw new Error("Claude Agent SDK message belongs to a different native session.");
    }

    const previousSessionId = this.#nativeSessionId;
    this.#nativeSessionId = sessionId;
    try {
      await this.#publishNativeResumeRef(context, sessionId);
    } catch (error) {
      if (this.#nativeSessionId === sessionId) {
        this.#nativeSessionId = previousSessionId;
      }
      throw error;
    }
  }

  async #replaceNativeSessionId(
    context: AgentDriverContext,
    previousSessionId: string,
    nextSessionId: string,
    sourceEventId: string,
  ): Promise<void> {
    requireClaudeNativeSessionId(previousSessionId);
    requireClaudeNativeSessionId(nextSessionId);

    if (this.#nativeSessionId === nextSessionId && this.#pendingReset === null) {
      return;
    }

    if (
      this.#nativeSessionId !== null &&
      this.#nativeSessionId !== previousSessionId &&
      this.#nativeSessionId !== nextSessionId
    ) {
      throw new Error("Claude conversation reset belongs to a different native session.");
    }

    if (this.#pendingReset !== null && this.#pendingReset.sourceEventId !== sourceEventId) {
      throw new Error("Claude session reset is awaiting durable acknowledgement.");
    }
    this.#pendingReset ??= {
      kind: "runtime.session.reset",
      sourceEventId,
      payload: {
        previousCheckpoint: this.#committedCheckpoint,
        previousNativeRef: {
          kind: "claude_session_id",
          runtimeId: this.runtime,
          value: previousSessionId,
        },
        newNativeRef: {
          kind: "claude_session_id",
          runtimeId: this.runtime,
          value: nextSessionId,
        },
      },
      visibility: "owner_debug",
    };
    // Native identity changes immediately; a rejected receipt must retain the same reset event.
    this.#nativeSessionId = nextSessionId;
    await this.#flushPendingReset(context);
  }

  async #flushPendingReset(context: AgentDriverContext): Promise<void> {
    if (this.#pendingReset === null) {
      return;
    }
    await this.#eventPublisher.pushSession(context, "driver.claude.session.reset", [
      this.#pendingReset,
    ]);
    this.#committedCheckpoint = null;
    this.#pendingReset = null;
  }

  async #closeQuery(
    context: AgentDriverContext,
    turn: ActiveClaudeTurn,
    reason: string,
  ): Promise<void> {
    if (turn.queryCloseTask === null) {
      turn.stream?.closeInput();
      const query = turn.query;
      turn.queryCloseTask = (async () => {
        if (query !== null) {
          try {
            query.close();
          } catch (error) {
            turn.abortController.abort(reason);
            context.logger.debug("driver.claude.turn.close_failed", {
              message: toErrorMessage(error, "query close failed"),
              reason,
              runId: turn.runId,
            });
          }

          const returned = await settlePromiseWithTimeout(
            Promise.resolve().then(() => query.return()),
            {
              label: "Claude Agent SDK query return",
              timeoutMs: CLAUDE_QUERY_RETURN_TIMEOUT_MS,
            },
          );
          if (returned.status !== "completed") {
            turn.abortController.abort(reason);
            context.logger.debug("driver.claude.turn.return_failed", {
              message: toErrorMessage(returned.error, "query return failed"),
              reason,
              runId: turn.runId,
            });
          }
        }

        const cleanup = await Promise.allSettled([
          turn.permissionDrainTask,
          drainClaudeTasks(turn.permissionTasks, turn.processTasks),
        ]);
        for (const result of cleanup) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
      })();
    }

    await turn.queryCloseTask;
  }

  async #publishNativeResumeRef(
    context: AgentDriverContext,
    nativeSessionId: string,
    sessionScoped = false,
    sourceEventId?: string,
  ): Promise<void> {
    const events: DriverEventInput[] = [
      {
        kind: "runtime.resume.updated",
        ...(sourceEventId === undefined ? {} : { sourceEventId }),
        payload: {
          resumePointer: nativeSessionId,
          threadId: null,
        },
        visibility: "owner_debug",
      },
    ];
    if (sessionScoped) {
      await this.#eventPublisher.pushSession(
        context,
        "driver.claude.native_resume_ref.updated",
        events,
      );
    } else {
      await this.#push(context, "driver.claude.native_resume_ref.updated", events);
    }
  }

  #push(context: AgentDriverContext, reason: string, events: DriverEventInput[]): Promise<void> {
    return this.#eventPublisher.push(context, reason, events);
  }
}
