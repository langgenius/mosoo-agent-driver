import { mkdir } from "node:fs/promises";

import { query, startup } from "@anthropic-ai/claude-agent-sdk";
import type { Query, WarmQuery } from "@anthropic-ai/claude-agent-sdk";

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
} from "../../infrastructure/logging/driver-debug";
import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import type { DriverRuntime } from "../../protocol/runtime";
import type { DriverStartInput } from "../../protocol/start";
import type { RuntimeCommandInput } from "../../runtime-command";
import { raceWithAbort } from "../../utils/async";
import type { AgentDriverBackend, AgentDriverContext } from "../agent-driver-backend";
import { DriverEventPublisher } from "../driver-event-publisher";
import { computeRuntimeBootstrapDigest, writeSkillBootstrapArtifacts } from "../skill-bootstrap";
import { readProcessEnvString, toErrorMessage } from "./agent-sdk-json";
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

interface ClaudePrewarm {
  readonly abortController: AbortController;
  readonly detach: () => void;
  query: WarmQuery | null;
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

const CLAUDE_PREWARM_ENV = "AGENT_DRIVER_CLAUDE_PREWARM";

/**
 * Prewarm the Claude CLI subprocess during backend start. OPT-IN (default off).
 *
 * Prewarm pre-spawns a SECOND native Claude CLI process via `startup()` to cut
 * first-token latency. On a memory-constrained container (e.g. the CF "basic"
 * instance, ~1 GiB) that extra process can OOM-kill the driver before it signals
 * `ready`, surfacing as RUN FAILED "Driver instance <id> closed before ready".
 * So it is disabled by default and must be explicitly enabled only on an
 * instance with headroom for a second CLI via AGENT_DRIVER_CLAUDE_PREWARM=1.
 * It is also fired non-blocking (see start()) so it never delays `ready`.
 */
function isClaudePrewarmEnabled(): boolean {
  return readProcessEnvString(CLAUDE_PREWARM_ENV) === "1";
}

function isTurnCancelled(turn: ActiveClaudeTurn): boolean {
  return turn.state === "cancelled";
}

export class ClaudeAgentSdkDriverBackend implements AgentDriverBackend {
  readonly runtime: DriverRuntime = "claude-agent-sdk";
  readonly #dependencies: ClaudeAgentSdkDriverBackendDependencies;
  readonly #eventPublisher = new DriverEventPublisher(this.runtime, () => this.#nativeSessionId);
  readonly #messageTranslator: ClaudeAgentSdkMessageTranslator;
  readonly #payload: DriverStartInput;
  #activeTurn: ActiveClaudeTurn | null = null;
  #nativeSessionId: string | null = null;
  #prewarm: ClaudePrewarm | null = null;
  #prewarmTask: Promise<void> | null = null;
  #stopRequested = false;
  #stopTask: Promise<void> | null = null;

  constructor(
    payload: DriverStartInput,
    dependencies: Partial<ClaudeAgentSdkDriverBackendDependencies> = {},
  ) {
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    this.#payload = payload;
    this.#nativeSessionId = readClaudeNativeResumeSessionId(payload);
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

    // Fire prewarm non-blocking: it must NOT gate the driver's `ready` handshake
    // (start() is awaited before socket.ready()). If the first turn arrives
    // before prewarm finishes, handleInput cold-spawns (warmQuery is still null).
    const prewarmTask = this.#prewarmQuery(context, signal);
    this.#prewarmTask = prewarmTask;
    const releasePrewarmTask = () => {
      if (this.#prewarmTask === prewarmTask) {
        this.#prewarmTask = null;
      }
    };
    void prewarmTask.then(releasePrewarmTask, releasePrewarmTask);
  }

  /**
   * Pre-spawn the CLI so the first turn writes to a ready process. Best-effort:
   * a prewarm failure (e.g. missing CLI in a constrained environment) is logged
   * and the runtime falls back to lazy spawn on the first `query()`.
   */
  async #prewarmQuery(context: AgentDriverContext, signal: AbortSignal): Promise<void> {
    if (!isClaudePrewarmEnabled()) {
      return;
    }

    const startedAtMs = Date.now();
    const abortController = new AbortController();
    const onAbort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    const prewarm: ClaudePrewarm = {
      abortController,
      detach: () => signal.removeEventListener("abort", onAbort),
      query: null,
    };
    this.#prewarm = prewarm;

    try {
      const options = await this.#dependencies.createQueryOptions({
        abortController: prewarm.abortController,
        context,
        nativeSessionId: this.#nativeSessionId,
        payload: this.#payload,
      });

      if (
        this.#stopRequested ||
        prewarm.abortController.signal.aborted ||
        this.#prewarm !== prewarm
      ) {
        return;
      }

      const warmQuery = await this.#dependencies.startup({ options });

      if (
        this.#stopRequested ||
        prewarm.abortController.signal.aborted ||
        this.#prewarm !== prewarm
      ) {
        warmQuery.close();
        return;
      }

      prewarm.query = warmQuery;
      context.logger.debug("driver.claude.prewarm.ready", {
        prewarmMs: Date.now() - startedAtMs,
      });
    } catch (error) {
      if (!prewarm.abortController.signal.aborted && !this.#stopRequested) {
        context.logger.debug("driver.claude.prewarm.failed", {
          message: toErrorMessage(error, "Claude prewarm failed."),
        });
      }
    } finally {
      prewarm.detach();
      if (this.#prewarm === prewarm && prewarm.query === null) {
        this.#prewarm = null;
      }
    }
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

    const prewarm = this.#prewarm;
    this.#prewarm = null;
    prewarm?.detach();
    let abortController: AbortController;
    let warmQuery: WarmQuery | null;
    if (prewarm?.query) {
      abortController = prewarm.abortController;
      warmQuery = prewarm.query;
    } else {
      prewarm?.abortController.abort("driver.claude.prewarm.superseded");
      abortController = new AbortController();
      warmQuery = null;
    }
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
    const prewarm = this.#prewarm;
    const prewarmTask = this.#prewarmTask;
    this.#prewarm = null;
    prewarm?.detach();
    prewarm?.abortController.abort(reason);
    try {
      prewarm?.query?.close();
    } catch (error) {
      context.logger.debug("driver.claude.prewarm.close_failed", {
        message: toErrorMessage(error, "prewarm close failed"),
        reason,
      });
    }
    await this.cancelActiveTurn(context, reason);
    if (prewarmTask === null) {
      signal.throwIfAborted();
      return;
    }

    await raceWithAbort(prewarmTask, signal);
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
