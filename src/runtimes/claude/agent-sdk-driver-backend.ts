import { mkdir } from "node:fs/promises";

import { query, startup } from "@anthropic-ai/claude-agent-sdk";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

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

interface ActiveClaudeTurn {
  abortController: AbortController;
  cancelReason: string | null;
  permissionTasks: Set<Promise<unknown>>;
  processTasks: Set<Promise<void>>;
  query: Query | null;
  queryCloseTask: Promise<void> | null;
  runId: RunId;
  runSignal: AbortSignal | null;
  readonly settled: ReturnType<typeof Promise.withResolvers<void>>;
  state: "running" | "finalizing" | "cancelled";
}

interface ClaudeAgentSdkDriverBackendDependencies {
  readonly createQueryOptions: typeof createClaudeQueryOptions;
  readonly query: typeof query;
  readonly startup: typeof startup;
}

const DEFAULT_DEPENDENCIES: ClaudeAgentSdkDriverBackendDependencies = {
  createQueryOptions: createClaudeQueryOptions,
  query,
  startup,
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

    const { abortController, permissionTasks, processTasks, warmQuery } = this.#prewarm.take();
    const activeTurn: ActiveClaudeTurn = {
      abortController,
      cancelReason: null,
      permissionTasks,
      processTasks,
      query: null,
      queryCloseTask: null,
      runId,
      runSignal: signal ?? null,
      settled: Promise.withResolvers<void>(),
      state: "running",
    };
    this.#activeTurn = activeTurn;
    const turnSignal =
      activeTurn.runSignal === null
        ? activeTurn.abortController.signal
        : AbortSignal.any([activeTurn.abortController.signal, activeTurn.runSignal]);

    let queryStartedAtMs = Date.now();
    let queryOptionsMs = 0;
    let runStarted = false;

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

      let activeQuery: Query;

      try {
        if (warmQuery !== null) {
          activeQuery = warmQuery.query(promptText);
        } else {
          const optionsStartedAtMs = Date.now();
          const queryOptions = await raceWithAbort(
            this.#dependencies.createQueryOptions({
              abortController,
              context,
              nativeSessionId: this.#nativeSessionId,
              payload: this.#payload,
              permissionTasks,
              processTasks,
              publicToolCallId: (nativeToolCallId) =>
                toRuntimePublicId(nativeToolCallId, "claude-tool"),
            }),
            turnSignal,
          );
          queryOptionsMs = Date.now() - optionsStartedAtMs;

          if (isTurnCancelled(activeTurn)) {
            throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
          }

          activeQuery = this.#dependencies.query({
            options: queryOptions,
            prompt: promptText,
          });
        }

        activeTurn.query = activeQuery;
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
        const next = await raceWithAbort(activeQuery.next(), turnSignal);
        if (next.done) {
          break;
        }
        const message = next.value;

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

        if (message.type === "result") {
          activeTurn.state = "finalizing";
          await this.#closeQuery(context, activeTurn, "provider.result");
        }

        terminalOutcome = await this.#messageTranslator.handleSdkMessage(context, message, runId);
        if (terminalOutcome !== null) {
          break;
        }
      }

      if (terminalOutcome === null && isTurnCancelled(activeTurn)) {
        throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
      }

      if (terminalOutcome === null) {
        throw new Error("Claude Agent SDK query ended before a result frame.");
      }
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
      try {
        await this.#closeQuery(context, activeTurn, "turn.finished");
      } finally {
        this.#retainProcessTasks(activeTurn);
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
    const [activeResult, prewarmResult, pendingResult] = await Promise.allSettled([
      activeCleanup,
      prewarmStop,
      raceWithAbort(drainClaudeTasks(this.#pendingProcessTasks), signal),
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
      await this.#publishNativeResumeRef(context, nextSessionId);
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

        await drainClaudeTasks(turn.permissionTasks, turn.processTasks);
      })();
    }

    await turn.queryCloseTask;
  }

  async #publishNativeResumeRef(
    context: AgentDriverContext,
    nativeSessionId: string,
  ): Promise<void> {
    await this.#push(context, "driver.claude.native_resume_ref.updated", [
      {
        kind: "runtime.resume.updated",
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
