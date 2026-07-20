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
import { raceWithAbort } from "../../utils/async";
import type { AgentDriverBackend, AgentDriverContext } from "../../core/agent-driver-backend";
import { DriverEventPublisher } from "../driver-event-publisher";
import { computeRuntimeBootstrapDigest, writeSkillBootstrapArtifacts } from "../skill-bootstrap";
import { readProcessEnvString, toErrorMessage } from "./agent-sdk-json";
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
import { readClaudeNativeResumeSessionId } from "./agent-sdk-resume";

interface ActiveClaudeTurn {
  abortController: AbortController;
  cancelReason: string | null;
  query: Query | null;
  queryClosed: boolean;
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

function isTurnCancelled(turn: ActiveClaudeTurn): boolean {
  return turn.state === "cancelled";
}

export class ClaudeAgentSdkDriverBackend implements AgentDriverBackend {
  readonly runtime: DriverRuntime = "claude-agent-sdk";
  readonly #dependencies: ClaudeAgentSdkDriverBackendDependencies;
  readonly #eventPublisher = new DriverEventPublisher(this.runtime, () => this.#nativeSessionId);
  readonly #messageTranslator: ClaudeAgentSdkMessageTranslator;
  readonly #payload: DriverStartInput;
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
      startup: async (input) => this.#dependencies.startup(input),
    });
    this.#messageTranslator = new ClaudeAgentSdkMessageTranslator({
      push: async (context, reason, events) => this.#push(context, reason, events),
      recordNativeSessionId: async (context, sessionId) =>
        this.#recordNativeSessionId(context, sessionId),
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

    const { abortController, warmQuery } = this.#prewarm.take();
    const activeTurn: ActiveClaudeTurn = {
      abortController,
      cancelReason: null,
      query: null,
      queryClosed: false,
      runId,
      state: "running",
    };
    this.#activeTurn = activeTurn;

    const queryStartedAtMs = Date.now();
    let queryOptionsMs = 0;

    try {
      let activeQuery: Query;

      try {
        if (warmQuery !== null) {
          activeQuery = warmQuery.query(input.text);
        } else {
          const optionsStartedAtMs = Date.now();
          const queryOptions = await this.#dependencies.createQueryOptions({
            abortController,
            context,
            nativeSessionId: this.#nativeSessionId,
            payload: this.#payload,
          });
          queryOptionsMs = Date.now() - optionsStartedAtMs;

          if (isTurnCancelled(activeTurn)) {
            throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
          }

          activeQuery = this.#dependencies.query({
            options: queryOptions,
            prompt: input.text,
          });
        }

        activeTurn.query = activeQuery;
        if (isTurnCancelled(activeTurn)) {
          this.#closeQuery(context, activeTurn, activeTurn.cancelReason ?? "turn.cancelled");
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
        textLength: input.text.length,
      });
      context.logger.debug("driver.claude.prompt.requested", {
        input: summarizeRuntimeCommandInput(input),
        nativeSessionIdPresent: Boolean(this.#nativeSessionId),
      });

      await this.#push(context, "driver.claude.turn.started", [
        {
          kind: "run.started",
          payload: { startedAt: new Date().toISOString() },
          runId,
        },
      ]);

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
          this.#closeQuery(context, activeTurn, "provider.result");
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
      if (isTurnCancelled(activeTurn)) {
        await this.#messageTranslator.finishTurn(context, "failed").catch(() => {});
        await this.#push(context, "driver.claude.turn.cancelled", [
          {
            kind: "run.cancelled",
            payload: {
              reason: activeTurn.cancelReason ?? "turn.cancelled",
              requestedBy: "user",
              stopReason: "cancelled",
            },
            runId,
          },
        ]);
        throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
      }

      activeTurn.state = "finalizing";
      this.#closeQuery(context, activeTurn, "turn.failed");
      await this.#messageTranslator.finishTurn(context, "failed").catch(() => {});

      if (error instanceof ClaudeTerminalWriteError) {
        throw error.cause;
      }

      const message = toErrorMessage(error, "Claude Agent SDK turn failed.");
      await this.#push(context, "driver.claude.turn.failed", [
        {
          kind: "run.failed",
          payload: {
            error: { code: "claude.turn_failed", message },
            recoverable: false,
          },
          runId,
        },
      ]);
      throw error;
    } finally {
      this.#closeQuery(context, activeTurn, "turn.finished");
      if (this.#activeTurn === activeTurn) {
        this.#activeTurn = null;
      }
    }
  }

  async cancelActiveTurn(context: AgentDriverContext, reason: string): Promise<void> {
    const activeTurn = this.#activeTurn;

    if (!activeTurn || activeTurn.state !== "running") {
      return;
    }

    activeTurn.state = "cancelled";
    activeTurn.cancelReason = reason;
    activeTurn.abortController.abort(reason);
    this.#closeQuery(context, activeTurn, reason);
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
    const prewarmStop = this.#prewarm.stop(context, reason, signal);
    await this.cancelActiveTurn(context, reason);
    await prewarmStop;
  }

  async #recordNativeSessionId(context: AgentDriverContext, sessionId: string): Promise<void> {
    if (sessionId.trim().length === 0) {
      throw new Error("Claude Agent SDK message has an empty native session ID.");
    }

    if (this.#nativeSessionId === sessionId) {
      return;
    }

    if (this.#nativeSessionId !== null) {
      throw new Error("Claude Agent SDK message belongs to a different native session.");
    }

    this.#nativeSessionId = sessionId;
    await this.#publishNativeResumeRef(context);
  }

  #closeQuery(context: AgentDriverContext, turn: ActiveClaudeTurn, reason: string): void {
    if (turn.query === null || turn.queryClosed) {
      return;
    }

    turn.queryClosed = true;
    try {
      turn.query.close();
    } catch (error) {
      context.logger.debug("driver.claude.turn.close_failed", {
        message: toErrorMessage(error, "query close failed"),
        reason,
        runId: turn.runId,
      });
    }
  }

  async #publishNativeResumeRef(context: AgentDriverContext): Promise<void> {
    if (!this.#nativeSessionId) {
      throw new Error("Claude native session id is required before publishing resume ref.");
    }

    await this.#push(context, "driver.claude.native_resume_ref.updated", [
      {
        kind: "runtime.resume.updated",
        payload: {
          resumePointer: this.#nativeSessionId,
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
