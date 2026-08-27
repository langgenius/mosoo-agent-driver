import type { WarmQuery } from "@anthropic-ai/claude-agent-sdk";

import type { DriverStartInput } from "../../protocol/start";
import { raceWithAbort } from "../../utils/async";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { readProcessEnvString, toErrorMessage } from "./agent-sdk-json";
import type { createClaudeQueryOptions } from "./agent-sdk-query-options";
import { settleClaudeTasks } from "./agent-sdk-tasks";

const CLAUDE_PREWARM_ENV = "AGENT_DRIVER_CLAUDE_PREWARM";

interface ClaudePrewarmState {
  readonly abortController: AbortController;
  readonly detach: () => void;
  readonly permissionTasks: Set<Promise<unknown>>;
  readonly processTasks: Set<Promise<void>>;
  cleanupTask: Promise<void> | null;
  failure: { readonly error: unknown } | null;
  permanentFailure: { readonly error: unknown } | null;
  query: WarmQuery | null;
  task: Promise<void>;
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
  #state: ClaudePrewarmState | null = null;
  #stopped = false;

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

    const startedAtMs = Date.now();
    const abortController = new AbortController();
    const onAbort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    const state: ClaudePrewarmState = {
      abortController,
      cleanupTask: null,
      detach: () => signal.removeEventListener("abort", onAbort),
      failure: null,
      permissionTasks: new Set(),
      permanentFailure: null,
      processTasks: new Set(),
      query: null,
      task: Promise.resolve(),
    };
    this.#state = state;
    state.task = Promise.resolve().then(() => this.#run(context, state, startedAtMs));
    void state.task.catch(() => {});
  }

  take(): ClaudePrewarmTake {
    const state = this.#state;
    if (state !== null && state.failure !== null) {
      throw state.failure.error;
    }

    if (state !== null && state.query !== null) {
      this.#state = null;
      state.detach();
      return {
        abortController: state.abortController,
        permissionTasks: state.permissionTasks,
        processTasks: state.processTasks,
        warmQuery: state.query,
      };
    }

    // A superseded startup still owns every task it may create until cleanup succeeds.
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
    if (state === null) {
      signal.throwIfAborted();
      return;
    }

    state.detach();
    state.abortController.abort(reason);
    this.#close(context, state, reason);

    const settlement =
      state.failure !== null
        ? this.#cleanup(state)
        : state.task.then(() => (this.#state === state ? this.#cleanup(state) : Promise.resolve()));
    await raceWithAbort(settlement, signal);
  }

  async #run(
    context: AgentDriverContext,
    state: ClaudePrewarmState,
    startedAtMs: number,
  ): Promise<void> {
    try {
      const options = await this.#createQueryOptions({
        abortController: state.abortController,
        context,
        nativeSessionId: this.#getNativeSessionId(),
        payload: this.#payload,
        permissionTasks: state.permissionTasks,
        processTasks: state.processTasks,
        publicToolCallId: this.#publicToolCallId,
      });

      if (this.#stopped || state.abortController.signal.aborted || this.#state !== state) {
        return;
      }

      const warmQuery = await this.#startup({ options });

      if (this.#stopped || state.abortController.signal.aborted || this.#state !== state) {
        this.#closeQuery(context, warmQuery, "driver.claude.prewarm.superseded");
        return;
      }

      state.query = warmQuery;
      context.logger.debug("driver.claude.prewarm.ready", {
        prewarmMs: Date.now() - startedAtMs,
      });
    } catch (error) {
      if (!state.abortController.signal.aborted && !this.#stopped) {
        context.logger.debug("driver.claude.prewarm.failed", {
          message: toErrorMessage(error, "Claude prewarm failed."),
        });
      }
    } finally {
      try {
        if (state.query === null || state.abortController.signal.aborted || this.#stopped) {
          this.#close(context, state, "driver.claude.prewarm.finished");
          await this.#cleanup(state);
        }
      } finally {
        state.detach();
      }
    }
  }

  #cleanup(state: ClaudePrewarmState): Promise<void> {
    if (state.cleanupTask !== null) {
      return state.cleanupTask;
    }

    const task = (async () => {
      const result = await settleClaudeTasks(state.processTasks);
      if (result.status === "failed") {
        state.failure = { error: result.firstFailure };
        state.permanentFailure ??= result.firstPermanentFailure;
        throw result.firstFailure;
      }

      state.failure = null;
      if (state.permanentFailure !== null) {
        state.failure = state.permanentFailure;
        throw state.permanentFailure.error;
      }
      if (this.#state === state) {
        this.#state = null;
      }
    })().finally(() => {
      if (state.cleanupTask === task) {
        state.cleanupTask = null;
      }
    });
    state.cleanupTask = task;
    return task;
  }

  #close(context: AgentDriverContext, state: ClaudePrewarmState, reason: string): void {
    const query = state.query;
    state.query = null;
    if (query !== null) {
      this.#closeQuery(context, query, reason);
    }
  }

  #closeQuery(context: AgentDriverContext, query: WarmQuery, reason: string): void {
    try {
      query.close();
    } catch (error) {
      context.logger.debug("driver.claude.prewarm.close_failed", {
        message: toErrorMessage(error, "prewarm close failed"),
        reason,
      });
    }
  }
}
