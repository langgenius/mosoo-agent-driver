import { mkdir } from "node:fs/promises";

import { query, startup } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { DriverTurnCancelledError } from "../../core/driver-runtime-state";
import {
  createDriverRuntimeTimingEvent,
  createDriverRuntimeTimingPhase,
  toDriverDurationMs,
} from "../../core/driver-runtime-timing";
import { isTruthy } from "../../core/truthiness";
import type { AgentDriverMaterializedSkill } from "../../host-ports";
import {
  summarizePath,
  summarizePathCollection,
  summarizeRuntimeCommandInput,
} from "../../infrastructure/logging/driver-debug";
import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import type { DriverRuntime } from "../../protocol/runtime";
import type { DriverStartInput } from "../../protocol/start";
import type { McpExecuteCommand, RuntimeCommandInput } from "../../runtime-command";
import type { AgentDriverBackend, AgentDriverContext } from "../agent-driver-backend";
import { DriverEventPublisher } from "../driver-event-publisher";
import { computeRuntimeBootstrapDigest, writeSkillBootstrapArtifacts } from "../skill-bootstrap";
import { readProcessEnvString, toErrorMessage } from "./agent-sdk-json";
import { ClaudeAgentSdkMessageTranslator } from "./agent-sdk-message-translator";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  createClaudeQueryOptions,
  resolveClaudeConfigDir,
} from "./agent-sdk-query-options";
import { readClaudeNativeResumeSessionId } from "./agent-sdk-resume";

interface ActiveClaudeTurn {
  abortController: AbortController;
  cancelled: boolean;
  query: ClaudeAgentSdkQuery;
  runId: RunId;
}

interface ClaudeAgentSdkQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
}

interface ClaudeAgentSdkWarmQuery {
  close(): void;
  query(prompt: string): ClaudeAgentSdkQuery;
}

export interface ClaudeAgentSdkRuntimeAdapter {
  query(input: Parameters<typeof query>[0]): ClaudeAgentSdkQuery;
  startup(input?: Parameters<typeof startup>[0]): Promise<ClaudeAgentSdkWarmQuery>;
}

const DEFAULT_CLAUDE_AGENT_SDK_RUNTIME = {
  query,
  startup,
} satisfies ClaudeAgentSdkRuntimeAdapter;

const CLAUDE_PREWARM_ENV = "AGENT_DRIVER_CLAUDE_PREWARM";

/**
 * Prewarm the Claude CLI subprocess during backend start. OPT-IN (default off).
 *
 * Prewarm starts a native Claude CLI process via `startup()` to cut first-token
 * latency. If the first turn arrives before startup finishes, the cold fallback
 * can briefly overlap it with a second CLI process. On a memory-constrained
 * container (e.g. the CF "basic" instance, ~1 GiB), that overlap can OOM-kill
 * the driver around session startup. It is therefore disabled by default and
 * must be explicitly enabled only with headroom for that overlap via
 * AGENT_DRIVER_CLAUDE_PREWARM=1. It is fired non-blocking (see start()) so it
 * never delays `ready`.
 */
function isClaudePrewarmEnabled(): boolean {
  return readProcessEnvString(CLAUDE_PREWARM_ENV) === "1";
}

export class ClaudeAgentSdkDriverBackend implements AgentDriverBackend {
  readonly runtime: DriverRuntime = "claude-agent-sdk";
  readonly #eventPublisher = new DriverEventPublisher(this.runtime, () => this.#nativeSessionId);
  readonly #messageTranslator: ClaudeAgentSdkMessageTranslator;
  readonly #payload: DriverStartInput;
  readonly #runtimeAdapter: ClaudeAgentSdkRuntimeAdapter;
  readonly #runtimeBootstrapDigest: string | null;
  #activeTurn: ActiveClaudeTurn | null = null;
  #materializedSkills: readonly AgentDriverMaterializedSkill[] = [];
  #nativeSessionId: string | null = null;
  #warmQuery: ClaudeAgentSdkWarmQuery | null = null;
  #warmAbortController: AbortController | null = null;
  #prewarmGeneration = 0;

  constructor(
    payload: DriverStartInput,
    runtimeAdapter: ClaudeAgentSdkRuntimeAdapter = DEFAULT_CLAUDE_AGENT_SDK_RUNTIME,
  ) {
    this.#payload = payload;
    this.#runtimeAdapter = runtimeAdapter;
    this.#runtimeBootstrapDigest = computeRuntimeBootstrapDigest(payload.execution);
    this.#nativeSessionId = readClaudeNativeResumeSessionId(payload);
    this.#messageTranslator = new ClaudeAgentSdkMessageTranslator({
      push: async (context, reason, events) => this.#push(context, reason, events),
      recordNativeSessionId: async (context, sessionId) =>
        this.#recordNativeSessionId(context, sessionId),
    });
  }

  async start(context: AgentDriverContext): Promise<void> {
    this.#materializedSkills = await context.ports.skill.materialize(this.#payload.execution);
    const bootstrapArtifacts = await writeSkillBootstrapArtifacts(this.#payload.execution);
    const { homePath } = this.#payload.execution.session;
    const claudeConfigDir = resolveClaudeConfigDir(this.#payload);
    await mkdir(claudeConfigDir, { recursive: true });

    context.logger.info("driver.claude.runtime.started", {
      bootstrapArtifacts,
      bootstrapDigest: this.#runtimeBootstrapDigest,
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
      skillCount: this.#materializedSkills.length,
    });

    // Fire prewarm non-blocking: it must NOT gate the driver's `ready` handshake
    // (start() is awaited before socket.ready()). If the first turn arrives
    // before prewarm finishes, handleInput cold-spawns (warmQuery is still null).
    void this.#prewarmQuery(context);
  }

  /**
   * Pre-spawn the CLI so the first turn writes to a ready process. Best-effort:
   * a prewarm failure (e.g. missing CLI in a constrained environment) is logged
   * and the runtime falls back to lazy spawn on the first `query()`.
   */
  async #prewarmQuery(context: AgentDriverContext): Promise<void> {
    if (!isClaudePrewarmEnabled()) {
      return;
    }

    if (this.#warmAbortController !== null || this.#warmQuery !== null) {
      this.#discardPrewarm(context, "claude.prewarm.replaced");
    }

    const startedAtMs = Date.now();
    const generation = this.#prewarmGeneration + 1;
    const abortController = new AbortController();
    this.#prewarmGeneration = generation;
    this.#warmAbortController = abortController;

    const isCurrentPrewarm = (): boolean =>
      this.#prewarmGeneration === generation &&
      this.#warmAbortController === abortController &&
      !abortController.signal.aborted;

    try {
      const options = await createClaudeQueryOptions({
        abortController,
        context,
        nativeSessionId: this.#nativeSessionId,
        payload: this.#payload,
      });

      if (!isCurrentPrewarm()) {
        return;
      }

      const warmQuery = await this.#runtimeAdapter.startup({ options });

      if (!isCurrentPrewarm()) {
        this.#closeWarmQuery(context, warmQuery, "claude.prewarm.stale");
        return;
      }

      this.#warmQuery = warmQuery;
      context.logger.debug("driver.claude.prewarm.ready", {
        prewarmMs: Date.now() - startedAtMs,
      });
    } catch (error) {
      if (isCurrentPrewarm()) {
        context.logger.debug("driver.claude.prewarm.failed", {
          message: toErrorMessage(error, "Claude prewarm failed."),
        });
      }
    } finally {
      if (this.#prewarmGeneration === generation && this.#warmQuery === null) {
        this.#warmAbortController = null;
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

    this.#messageTranslator.resetTurnMessageState();

    const pendingWarmQuery = this.#warmQuery;
    const pendingWarmAbortController = this.#warmAbortController;
    let abortController = new AbortController();
    let warmQuery: ClaudeAgentSdkWarmQuery | null = null;

    if (
      pendingWarmQuery !== null &&
      pendingWarmAbortController !== null &&
      !pendingWarmAbortController.signal.aborted
    ) {
      abortController = pendingWarmAbortController;
      warmQuery = pendingWarmQuery;
      this.#prewarmGeneration += 1;
      this.#warmQuery = null;
      this.#warmAbortController = null;
    } else {
      this.#discardPrewarm(context, "claude.turn.cold_start");
    }

    const queryStartedAtMs = Date.now();
    let queryOptionsMs = 0;
    let activeQuery: ClaudeAgentSdkQuery;

    try {
      if (warmQuery !== null) {
        // The subprocess is already spawned and initialized; this just writes
        // the prompt, so the spawn cost is not on the turn's critical path.
        activeQuery = warmQuery.query(input.text);
      } else {
        const optionsStartedAtMs = Date.now();
        const queryOptions = await createClaudeQueryOptions({
          abortController,
          context,
          nativeSessionId: this.#nativeSessionId,
          payload: this.#payload,
        });
        queryOptionsMs = Date.now() - optionsStartedAtMs;
        activeQuery = this.#runtimeAdapter.query({
          options: queryOptions,
          prompt: input.text,
        });
      }
    } catch (error) {
      if (warmQuery !== null) {
        abortController.abort("claude.warm_query.create_failed");
        this.#closeWarmQuery(context, warmQuery, "claude.warm_query.create_failed");
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
    this.#activeTurn = {
      abortController,
      cancelled: false,
      query: activeQuery,
      runId,
    };

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
        payload: {
          startedAt: new Date().toISOString(),
        },
        runId,
      },
    ]);

    let completed = false;
    let firstProviderEventPublished = false;
    const providerStartedAtMs = Date.now();

    try {
      for await (const message of activeQuery) {
        if (!firstProviderEventPublished) {
          firstProviderEventPublished = true;
          const firstProviderEventAtMs = Date.now();

          await this.#push(context, "driver.claude.provider.first_event", [
            createDriverRuntimeTimingEvent({
              completedAtMs: firstProviderEventAtMs,
              path: "unknown",
              phases: [
                createDriverRuntimeTimingPhase("createQueryOptions", queryOptionsMs),
                createDriverRuntimeTimingPhase("query.create", queryCreateMs),
                createDriverRuntimeTimingPhase(
                  "provider.first_event",
                  toDriverDurationMs(providerStartedAtMs, firstProviderEventAtMs),
                ),
              ],
              runId,
              sessionId: context.payload.execution.run.sessionId,
              stage: "driver_turn",
              startedAtMs: queryStartedAtMs,
            }),
          ]);
        }
        completed =
          (await this.#messageTranslator.handleSdkMessage(context, message, runId)) || completed;
      }

      if (this.#activeTurn?.runId === runId && this.#activeTurn.cancelled) {
        throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
      }

      if (!completed) {
        await this.#push(context, "driver.claude.turn.completed", [
          {
            kind: "run.completed",
            payload: {
              stopReason: "end_turn",
            },
            runId,
          },
        ]);
      }
    } catch (error) {
      await this.#messageTranslator.endActiveThought(context).catch(() => {});

      if (this.#activeTurn?.runId === runId && this.#activeTurn.cancelled) {
        throw new DriverTurnCancelledError("Claude Agent SDK turn was cancelled.");
      }

      const message = toErrorMessage(error, "Claude Agent SDK turn failed.");
      await this.#push(context, "driver.claude.turn.failed", [
        {
          kind: "run.failed",
          payload: {
            error: {
              code: "claude.turn_failed",
              message,
            },
            recoverable: false,
          },
        },
      ]);
      throw error;
    } finally {
      if (this.#activeTurn?.runId === runId) {
        this.#activeTurn = null;
      }
    }
  }

  async handleMcpExecute(
    context: AgentDriverContext,
    command: McpExecuteCommand,
  ): Promise<{ outputText: string; requestId: string; serverId: string; toolName: string }> {
    context.logger.info("driver.claude.mcp.execute.started", {
      serverId: command.serverId,
      toolName: command.toolName,
    });

    const result = await context.ports.mcp.execute(command);

    context.logger.info("driver.claude.mcp.execute.completed", {
      outputLength: result.outputText.length,
      serverId: command.serverId,
      toolName: command.toolName,
    });

    return result;
  }

  async cancelActiveTurn(context: AgentDriverContext, reason: string): Promise<void> {
    const activeTurn = this.#activeTurn;

    if (!activeTurn) {
      return;
    }

    activeTurn.cancelled = true;
    activeTurn.abortController.abort(reason);
    await activeTurn.query.interrupt().catch((error: unknown) => {
      context.logger.debug("driver.claude.turn.interrupt.failed", {
        message: toErrorMessage(error, "interrupt failed"),
        reason,
        runId: activeTurn.runId,
      });
    });
  }

  async stop(context: AgentDriverContext, reason: string): Promise<void> {
    this.#discardPrewarm(context, reason);

    const activeTurn = this.#activeTurn;

    if (!activeTurn) {
      return;
    }

    await this.cancelActiveTurn(context, reason);
  }

  #discardPrewarm(context: AgentDriverContext, reason: string): void {
    this.#prewarmGeneration += 1;

    const abortController = this.#warmAbortController;
    const warmQuery = this.#warmQuery;
    this.#warmAbortController = null;
    this.#warmQuery = null;

    if (abortController !== null && !abortController.signal.aborted) {
      abortController.abort(reason);
    }

    if (warmQuery !== null) {
      this.#closeWarmQuery(context, warmQuery, reason);
    }
  }

  #closeWarmQuery(
    context: AgentDriverContext,
    warmQuery: ClaudeAgentSdkWarmQuery,
    reason: string,
  ): void {
    try {
      warmQuery.close();
    } catch (error) {
      context.logger.debug("driver.claude.prewarm.close_failed", {
        message: toErrorMessage(error, "Claude prewarm close failed."),
        reason,
      });
    }
  }

  async #recordNativeSessionId(context: AgentDriverContext, sessionId: string): Promise<void> {
    if (this.#nativeSessionId === sessionId) {
      return;
    }

    this.#nativeSessionId = sessionId;
    await this.#publishNativeResumeRef(context);
  }

  async #publishNativeResumeRef(context: AgentDriverContext): Promise<void> {
    if (!isTruthy(this.#nativeSessionId)) {
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
}
