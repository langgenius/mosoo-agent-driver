import { mkdir } from "node:fs/promises";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

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
  query: Query;
  runId: RunId;
}

export class ClaudeAgentSdkDriverBackend implements AgentDriverBackend {
  readonly runtime: DriverRuntime = "claude-agent-sdk";
  readonly #eventPublisher = new DriverEventPublisher(this.runtime, () => this.#nativeSessionId);
  readonly #messageTranslator: ClaudeAgentSdkMessageTranslator;
  readonly #payload: DriverStartInput;
  readonly #runtimeBootstrapDigest: string | null;
  #activeTurn: ActiveClaudeTurn | null = null;
  #materializedSkills: readonly AgentDriverMaterializedSkill[] = [];
  #nativeSessionId: string | null = null;

  constructor(payload: DriverStartInput) {
    this.#payload = payload;
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

    const abortController = new AbortController();
    const optionsStartedAtMs = Date.now();
    const queryOptions = await createClaudeQueryOptions({
      abortController,
      context,
      nativeSessionId: this.#nativeSessionId,
      payload: this.#payload,
    });
    const queryOptionsMs = Date.now() - optionsStartedAtMs;
    const queryStartedAtMs = Date.now();
    let activeQuery: Query;

    try {
      activeQuery = query({
        options: queryOptions,
        prompt: input.text,
      });
    } catch (error) {
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
    const activeTurn = this.#activeTurn;

    if (!activeTurn) {
      return;
    }

    await this.cancelActiveTurn(context, reason);
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
