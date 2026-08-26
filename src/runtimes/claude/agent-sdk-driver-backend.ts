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
import { DriverEventPublisher } from "../driver-event-publisher";
import { computeRuntimeBootstrapDigest, writeSkillBootstrapArtifacts } from "../skill-bootstrap";
import { readProcessEnvString, toErrorMessage } from "./agent-sdk-json";
import { ClaudeDurableEventTooLargeError } from "./agent-sdk-event-writer";
import { ClaudeAgentSdkPrewarm } from "./agent-sdk-prewarm";
import {
  ClaudeAgentSdkMessageTranslator,
  ClaudeTerminalWriteError,
} from "./agent-sdk-message-translator";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  createClaudeQueryOptions,
  resolveClaudeConfigDir,
} from "./agent-sdk-query-options";
import { buildClaudeRecoveryPrompt } from "./agent-sdk-recovery-context";
import { readClaudeNativeResumeSessionId, requireClaudeNativeSessionId } from "./agent-sdk-resume";
import { ClaudePublicToolCallIdState } from "./agent-sdk-tool-id";
import { drainClaudeTasks } from "./agent-sdk-tasks";

interface ActiveClaudeTurn {
  abortController: AbortController;
  cancelTask: Promise<void> | null;
  cancelReason: string | null;
  permissionTasks: Set<Promise<unknown>>;
  processTasks: Set<Promise<void>>;
  query: Query | null;
  queryCloseTask: Promise<void> | null;
  runId: RunId;
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

const CLAUDE_INTERRUPT_TIMEOUT_MS = 1_500;

function isTurnCancelled(turn: ActiveClaudeTurn): boolean {
  return turn.state === "cancelled";
}

export class ClaudeAgentSdkDriverBackend implements AgentDriverBackend {
  readonly runtime: DriverRuntime = "claude-agent-sdk";
  readonly #dependencies: ClaudeAgentSdkDriverBackendDependencies;
  readonly #eventPublisher = new DriverEventPublisher(this.runtime, () => this.#nativeSessionId);
  readonly #messageTranslator: ClaudeAgentSdkMessageTranslator;
  readonly #payload: DriverStartInput;
  readonly #pendingProcessTasks = new Set<Promise<void>>();
  readonly #prewarm: ClaudeAgentSdkPrewarm;
  readonly #publicToolCallIds = new ClaudePublicToolCallIdState();
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
      publicToolCallId: (nativeToolCallId) => this.#publicToolCallIds.publicId(nativeToolCallId),
      startup: async (input) => this.#dependencies.startup(input),
    });
    this.#messageTranslator = new ClaudeAgentSdkMessageTranslator({
      publicToolCallId: (nativeToolCallId) => this.#publicToolCallIds.publicId(nativeToolCallId),
      push: async (context, reason, events) => this.#push(context, reason, events),
      pushTerminal: async (context, reason, closures, terminal) =>
        this.#eventPublisher.pushTerminal(context, reason, closures, terminal),
      recordNativeSessionId: async (context, sessionId) =>
        this.#recordNativeSessionId(context, sessionId),
      replaceNativeSessionId: async (context, previousSessionId, nextSessionId) =>
        this.#replaceNativeSessionId(context, previousSessionId, nextSessionId),
    });
  }

  async start(context: AgentDriverContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#stopRequested) {
      throw new Error("Claude Agent SDK backend cannot restart after stopping.");
    }

    const materializedSkills = await raceWithAbort(
      context.ports.skill.materialize(this.#payload.execution),
      signal,
    );
    const bootstrapArtifacts = await raceWithAbort(
      writeSkillBootstrapArtifacts(this.#payload.execution),
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
  ): Promise<void> {
    if (this.#activeTurn) {
      throw new Error("Claude Agent SDK already has an active turn.");
    }

    if (this.#stopRequested) {
      throw new Error("Claude Agent SDK backend has stopped.");
    }

    this.#messageTranslator.resetTurnMessageState();
    this.#publicToolCallIds.reset();

    // With no native session to resume, every query starts a fresh provider
    // session, so the bounded platform-history replay must ride the prompt of
    // whichever turn first establishes one.
    const recoveryMessages =
      this.#nativeSessionId === null ? this.#payload.execution.session.recoveryMessages : [];
    const promptText = buildClaudeRecoveryPrompt(recoveryMessages, input.text);

    const { abortController, permissionTasks, processTasks, warmQuery } = this.#prewarm.take();
    const activeTurn: ActiveClaudeTurn = {
      abortController,
      cancelTask: null,
      cancelReason: null,
      permissionTasks,
      processTasks,
      query: null,
      queryCloseTask: null,
      runId,
      state: "running",
    };
    this.#activeTurn = activeTurn;

    let queryStartedAtMs = Date.now();
    let queryOptionsMs = 0;
    let runStarted = false;

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
          const queryOptions = await this.#dependencies.createQueryOptions({
            abortController,
            context,
            nativeSessionId: this.#nativeSessionId,
            payload: this.#payload,
            permissionTasks,
            processTasks,
            publicToolCallId: (nativeToolCallId) =>
              this.#publicToolCallIds.publicId(nativeToolCallId),
          });
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
          await this.#closeQuery(context, activeTurn, activeTurn.cancelReason ?? "turn.cancelled");
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

      let completed = false;
      let firstProviderEventPublished = false;
      const providerStartedAtMs = Date.now();

      for await (const message of activeQuery) {
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

        completed = await this.#messageTranslator.handleSdkMessage(context, message, runId);
        if (completed) {
          break;
        }
      }

      if (isTurnCancelled(activeTurn)) {
        throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
      }

      if (!completed) {
        throw new Error("Claude Agent SDK query ended before a result frame.");
      }
    } catch (error) {
      if (!runStarted) {
        throw error;
      }

      if (isTurnCancelled(activeTurn)) {
        await this.#closeQuery(context, activeTurn, activeTurn.cancelReason ?? "turn.cancelled");
        await this.#messageTranslator.cancelTurn(
          context,
          runId,
          activeTurn.cancelReason ?? "turn.cancelled",
        );
        throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
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
      }
    }
  }

  async cancelActiveTurn(context: AgentDriverContext, reason: string): Promise<void> {
    const activeTurn = this.#activeTurn;

    if (!activeTurn) {
      return;
    }

    if (activeTurn.cancelTask !== null) {
      await activeTurn.cancelTask;
      return;
    }

    if (activeTurn.state === "finalizing") {
      await this.#closeQuery(context, activeTurn, reason);
      return;
    }

    if (activeTurn.state === "cancelled") {
      return;
    }

    activeTurn.state = "cancelled";
    activeTurn.cancelReason = reason;

    activeTurn.cancelTask = (async () => {
      try {
        if (activeTurn.query !== null) {
          const interrupted = await settlePromiseWithTimeout(
            Promise.resolve().then(() => activeTurn.query?.interrupt()),
            {
              label: "Claude Agent SDK turn interrupt",
              timeoutMs: CLAUDE_INTERRUPT_TIMEOUT_MS,
            },
          );

          if (interrupted.status !== "completed") {
            context.logger.debug("driver.claude.turn.interrupt_failed", {
              message: toErrorMessage(interrupted.error, "Claude turn interrupt failed"),
              reason,
              runId: activeTurn.runId,
            });
          }
        }
      } finally {
        activeTurn.abortController.abort(reason);
        await this.#closeQuery(context, activeTurn, reason);
      }
    })();

    await activeTurn.cancelTask;
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
    const [activeResult, prewarmResult, pendingResult] = await Promise.allSettled([
      this.cancelActiveTurn(context, reason),
      prewarmStop,
      drainClaudeTasks(this.#pendingProcessTasks),
    ]);
    if (activeTurn !== null) {
      this.#retainProcessTasks(activeTurn);
      if (activeResult.status === "rejected" && this.#activeTurn === activeTurn) {
        this.#activeTurn = null;
      }
    }

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
      turn.queryCloseTask = Promise.resolve()
        .then(() => query?.return())
        .then(
          () => {},
          (error) => {
            context.logger.debug("driver.claude.turn.close_failed", {
              message: toErrorMessage(error, "query close failed"),
              reason,
              runId: turn.runId,
            });
          },
        )
        .then(() => drainClaudeTasks(turn.permissionTasks, turn.processTasks));
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
