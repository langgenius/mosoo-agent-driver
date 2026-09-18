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
import type { DriverRuntime } from "../../protocol/runtime";
import type { DriverStartInput } from "../../protocol/start";
import type { RuntimeCommandInput } from "../../runtime-command";
import { raceWithAbort, settlePromiseWithTimeout } from "../../utils/async";
import type { AgentDriverBackend, AgentDriverContext } from "../../core/agent-driver-backend";
import {
  DriverCompletedTerminalSupersededError,
  DriverEventPublisher,
} from "../driver-event-publisher";
import { toRuntimePublicId } from "../runtime-public-id";
import { computeRuntimeBootstrapDigest, writeSkillBootstrapArtifacts } from "../skill-bootstrap";
import { readProcessEnvString, toErrorMessage } from "./agent-sdk-json";
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
  readonly createQueryOptions: typeof createClaudeQueryOptions;
  readonly query: typeof query;
  readonly startup: typeof startup;
  readonly waitForTranscript: typeof waitForClaudeTranscript;
}

const DEFAULT_DEPENDENCIES: ClaudeAgentSdkDriverBackendDependencies = {
  createQueryOptions: createClaudeQueryOptions,
  query,
  startup,
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
  readonly #prewarm: ClaudeAgentSdkPrewarm;
  #activeTurn: ActiveClaudeTurn | null = null;
  #idleTurn: ActiveClaudeTurn | null = null;
  #nativeSessionId: string | null = null;
  #stopRequested = false;
  #stopTask: Promise<void> | null = null;

  constructor(
    payload: DriverStartInput,
    dependencies: Partial<ClaudeAgentSdkDriverBackendDependencies> = {},
  ) {
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    this.#payload = payload;
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
      replaceNativeSessionId: async (context, previousSessionId, nextSessionId) =>
        this.#replaceNativeSessionId(context, previousSessionId, nextSessionId),
      sessionId: payload.execution.run.sessionId,
    });
  }

  async start(context: AgentDriverContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#stopRequested) {
      throw new Error("Claude Agent SDK backend cannot restart after stopping.");
    }

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

    this.#messageTranslator.resetTurnMessageState();

    // With no native session to resume, every query starts a fresh provider
    // session, so the bounded platform-history replay must ride the prompt of
    // whichever turn first establishes one.
    const recoveryMessages =
      this.#nativeSessionId === null ? this.#payload.execution.session.recoveryMessages : [];
    const promptText = buildClaudeRecoveryPrompt(recoveryMessages, input.text);

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

    try {
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
        if (
          activeTurn.stream !== null &&
          (!activeTurn.stream.reusable || idleTurn?.context !== context)
        ) {
          // An idle EOF/crash is recoverable through the last durable native cursor.
          await this.#closeQuery(context, activeTurn, "session.exited");
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
        const streamInput = this.#canReuseQuery();
        const createQuery = (create: (prompt: string | AsyncIterable<SDKUserMessage>) => Query) => {
          if (!streamInput) {
            activeTurn.query = create(promptText);
            return activeTurn.query;
          }
          activeTurn.stream = new ClaudeStreamingQuery({
            createQuery: create,
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
                  true,
                );
              } else {
                context.logger.debug("driver.claude.session.idle_message", { type: message.type });
              }
            },
          });
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
      terminalOutcome = await this.#messageTranslator.publishPreparedResult(
        context,
        preparedResult,
      );
    } catch (error) {
      if (!runStarted) {
        throw error;
      }

      if (error instanceof ClaudeTerminalWriteError) {
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
      throw error;
    } finally {
      const retainQuery =
        terminalOutcome?.kind === "run.completed" &&
        activeTurn.stream?.reusable === true &&
        activeTurn.queryCloseTask === null &&
        !activeTurn.abortController.signal.aborted &&
        !this.#stopRequested;
      try {
        if (retainQuery) {
          this.#idleTurn = activeTurn;
          activeTurn.stream?.releaseTurn();
        } else {
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
  }

  #canReuseQuery(): boolean {
    // These SDK limits belong to a query/process. Keep the existing per-Run budgets.
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
    sessionScoped = false,
  ): Promise<void> {
    requireClaudeNativeSessionId(previousSessionId);
    requireClaudeNativeSessionId(nextSessionId);

    if (this.#nativeSessionId === nextSessionId) {
      return;
    }

    if (this.#nativeSessionId !== null && this.#nativeSessionId !== previousSessionId) {
      throw new Error("Claude conversation reset belongs to a different native session.");
    }

    const retainedSessionId = this.#nativeSessionId;
    this.#nativeSessionId = nextSessionId;
    try {
      await this.#publishNativeResumeRef(context, nextSessionId, sessionScoped);
    } catch (error) {
      if (this.#nativeSessionId === nextSessionId) {
        this.#nativeSessionId = retainedSessionId;
      }
      throw error;
    }
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
  ): Promise<void> {
    await this.#push(context, "driver.claude.native_resume_ref.updated", [
      {
        kind: "runtime.resume.updated",
        ...(sessionScoped ? { runId: null } : {}),
        payload: {
          resumePointer: nativeSessionId,
          threadId: null,
        },
        visibility: "owner_debug",
      },
    ]);
  }

  #push(context: AgentDriverContext, reason: string, events: DriverEventInput[]): Promise<void> {
    return this.#eventPublisher.push(context, reason, events);
  }
}
