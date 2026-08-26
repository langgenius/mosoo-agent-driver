import type { WarmQuery } from "@anthropic-ai/claude-agent-sdk";

import type { DriverStartInput } from "../../protocol/start";
import { raceWithAbort } from "../../utils/async";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { readProcessEnvString, toErrorMessage } from "./agent-sdk-json";
import type { createClaudeQueryOptions } from "./agent-sdk-query-options";
import { drainClaudeTasks } from "./agent-sdk-tasks";

const CLAUDE_PREWARM_ENV = "AGENT_DRIVER_CLAUDE_PREWARM";

interface ClaudePrewarmState {
  readonly abortController: AbortController;
  readonly detach: () => void;
  readonly permissionTasks: Set<Promise<unknown>>;
  readonly processTasks: Set<Promise<void>>;
  query: WarmQuery | null;
}

export interface ClaudeAgentSdkPrewarmOptions {
  readonly createQueryOptions: typeof createClaudeQueryOptions;
  readonly getNativeSessionId: () => string | null;
  readonly payload: DriverStartInput;
  readonly publicToolCallId: (nativeToolCallId: string) => string;
  readonly startup: (input: {
    options: Awaited<ReturnType<typeof createClaudeQueryOptions>>;
  }) => Promise<WarmQuery>;
}

export interface ClaudePrewarmTake {
  readonly abortController: AbortController;
  readonly permissionTasks: Set<Promise<unknown>>;
  readonly processTasks: Set<Promise<void>>;
  readonly warmQuery: WarmQuery | null;
}

/**
 * Owns the optional extra CLI process used to reduce first-turn latency.
 * Prewarm remains opt-in because a second CLI can exceed small container limits.
 */
export class ClaudeAgentSdkPrewarm {
  readonly #createQueryOptions: typeof createClaudeQueryOptions;
  readonly #getNativeSessionId: () => string | null;
  readonly #payload: DriverStartInput;
  readonly #publicToolCallId: (nativeToolCallId: string) => string;
  readonly #startup: ClaudeAgentSdkPrewarmOptions["startup"];
  #failure: { readonly error: unknown } | null = null;
  #state: ClaudePrewarmState | null = null;
  #stopped = false;
  #task: Promise<void> | null = null;

  constructor(options: ClaudeAgentSdkPrewarmOptions) {
    this.#createQueryOptions = options.createQueryOptions;
    this.#getNativeSessionId = options.getNativeSessionId;
    this.#payload = options.payload;
    this.#publicToolCallId = options.publicToolCallId;
    this.#startup = options.startup;
  }

  start(context: AgentDriverContext, signal: AbortSignal): void {
    if (readProcessEnvString(CLAUDE_PREWARM_ENV) !== "1" || this.#stopped) {
      return;
    }

    const task = this.#run(context, signal);
    this.#task = task;
    const release = () => {
      if (this.#task === task) {
        this.#task = null;
      }
    };
    void task.then(release, (error) => {
      this.#failure ??= { error };
      release();
    });
  }

  take(): ClaudePrewarmTake {
    if (this.#failure !== null) {
      throw this.#failure.error;
    }

    const state = this.#state;
    this.#state = null;
    state?.detach();

    if (state?.query) {
      return {
        abortController: state.abortController,
        permissionTasks: state.permissionTasks,
        processTasks: state.processTasks,
        warmQuery: state.query,
      };
    }

    state?.abortController.abort("driver.claude.prewarm.superseded");
    return {
      abortController: new AbortController(),
      permissionTasks: new Set(),
      processTasks: new Set(),
      warmQuery: null,
    };
  }

  async stop(context: AgentDriverContext, reason: string, signal: AbortSignal): Promise<void> {
    this.#stopped = true;
    const state = this.#state;
    const task = this.#task;
    state?.detach();
    state?.abortController.abort(reason);
    const warmQuery = state?.query;
    if (state !== null) {
      state.query = null;
    }

    try {
      warmQuery?.close();
    } catch (error) {
      context.logger.debug("driver.claude.prewarm.close_failed", {
        message: toErrorMessage(error, "prewarm close failed"),
        reason,
      });
    }

    if (task !== null) {
      await raceWithAbort(task, signal);
    }
    if (state !== null && state.processTasks.size > 0) {
      const retryingFailedCleanup = this.#failure !== null;
      await raceWithAbort(drainClaudeTasks(state.processTasks), signal);
      if (retryingFailedCleanup) {
        this.#failure = null;
      }
    }
    signal.throwIfAborted();
    if (this.#failure !== null) {
      throw this.#failure.error;
    }
    if (this.#state === state) {
      this.#state = null;
    }
  }

  async #run(context: AgentDriverContext, signal: AbortSignal): Promise<void> {
    const startedAtMs = Date.now();
    const abortController = new AbortController();
    const onAbort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    const state: ClaudePrewarmState = {
      abortController,
      detach: () => signal.removeEventListener("abort", onAbort),
      permissionTasks: new Set(),
      processTasks: new Set(),
      query: null,
    };
    this.#state = state;

    try {
      const options = await this.#createQueryOptions({
        abortController,
        context,
        nativeSessionId: this.#getNativeSessionId(),
        payload: this.#payload,
        permissionTasks: state.permissionTasks,
        processTasks: state.processTasks,
        publicToolCallId: this.#publicToolCallId,
      });

      if (this.#stopped || abortController.signal.aborted || this.#state !== state) {
        return;
      }

      const warmQuery = await this.#startup({ options });

      if (this.#stopped || abortController.signal.aborted || this.#state !== state) {
        warmQuery.close();
        return;
      }

      state.query = warmQuery;
      context.logger.debug("driver.claude.prewarm.ready", {
        prewarmMs: Date.now() - startedAtMs,
      });
    } catch (error) {
      if (!abortController.signal.aborted && !this.#stopped) {
        context.logger.debug("driver.claude.prewarm.failed", {
          message: toErrorMessage(error, "Claude prewarm failed."),
        });
      }
    } finally {
      try {
        if (state.query === null || abortController.signal.aborted || this.#stopped) {
          await drainClaudeTasks(state.processTasks);
        }
      } finally {
        state.detach();
        if (this.#state === state && state.query === null && state.processTasks.size === 0) {
          this.#state = null;
        }
      }
    }
  }
}
