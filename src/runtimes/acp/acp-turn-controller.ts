import { methods as acpMethods } from "@agentclientprotocol/sdk";
import type { ClientContext, StopReason } from "@agentclientprotocol/sdk";

import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { ACTIVE_TURN_CANCEL_GRACE_MS } from "../../core/driver-command-dispatcher";
import {
  DriverTurnCancellationCleanupError,
  DriverTurnCancelledError,
} from "../../core/driver-runtime-state";
import { summarizeRuntimeCommandInput } from "../../observability/driver-debug";
import type { DriverEventInput } from "../../protocol/events";
import { createDriverId } from "../../protocol/id";
import type { MessageId, RunId } from "../../protocol/id";
import type { RuntimeCommandInput } from "../../runtime-command";
import { raceWithAbort } from "../../utils/async";
import type { AcpClientRequestHandler } from "./acp-client-request-handler";
import { toRequestMeta } from "./acp-configuration";
import { AcpAssistantTranscriptState } from "./acp-assistant-transcript-state";
import { toPromptStartEvents } from "./acp-session-events";

interface ActiveAcpTurn {
  readonly cancellation: AbortController;
  cancellationBarrier: Promise<void> | null;
  cancellationReason: string | null;
  cancellationRequest: Promise<void> | null;
  cancelRequested: boolean;
  readonly drainCancellation: AbortController;
  drainDeadline: ReturnType<typeof setTimeout> | null;
  fatal: { readonly cleanup: Promise<void>; readonly error: Error } | null;
  providerPromptAdmitted: boolean;
  promptResponseAccepted: boolean;
  readonly providerPromptSettled: ReturnType<typeof Promise.withResolvers<boolean>>;
  readonly runId: RunId;
  readonly settled: ReturnType<typeof Promise.withResolvers<void>>;
  readonly terminalTurn: number;
  terminalStarted: boolean;
}

function createActiveTurn(runId: RunId, terminalTurn: number): ActiveAcpTurn {
  return {
    cancellation: new AbortController(),
    cancellationBarrier: null,
    cancellationReason: null,
    cancellationRequest: null,
    cancelRequested: false,
    drainCancellation: new AbortController(),
    drainDeadline: null,
    fatal: null,
    providerPromptAdmitted: false,
    promptResponseAccepted: false,
    providerPromptSettled: Promise.withResolvers<boolean>(),
    runId,
    settled: Promise.withResolvers<void>(),
    terminalStarted: false,
    terminalTurn,
  };
}

class AcpPromptTerminalError extends Error {
  override readonly name = "AcpPromptTerminalError";

  constructor(stopReason: string) {
    super(`ACP prompt stopped with terminal stop reason: ${stopReason}.`);
  }
}

async function drainTurnWork(
  clientRequests: AcpClientRequestHandler,
  signal?: AbortSignal,
): Promise<void> {
  const results = await Promise.allSettled([
    clientRequests.drainTurnFileWrites(signal),
    clientRequests.drainPermissions(signal),
    signal === undefined
      ? clientRequests.drainUpdates()
      : raceWithAbort(clientRequests.drainUpdates(), signal),
  ]);
  const failure = results.find((result) => result.status === "rejected");

  if (failure?.status === "rejected") {
    throw failure.reason;
  }
}

function startDrainDeadline(active: ActiveAcpTurn): void {
  active.drainDeadline ??= setTimeout(
    () => active.drainCancellation.abort(new Error("ACP cancelled turn drain timed out.")),
    ACTIVE_TURN_CANCEL_GRACE_MS,
  );
}

function requestCancellation(active: ActiveAcpTurn, reason: string): void {
  if (active.cancelRequested || active.fatal !== null || active.terminalStarted) {
    return;
  }

  active.cancelRequested = true;
  active.cancellationReason = reason;
  startDrainDeadline(active);
  active.cancellation.abort(new DriverTurnCancelledError(reason));
}

export type AcpTurnEventPush = (
  context: AgentDriverContext,
  reason: string,
  events: DriverEventInput[],
) => Promise<void>;

export type AcpTurnTerminalPush = (
  context: AgentDriverContext,
  reason: string,
  closures: readonly DriverEventInput[],
  terminal: DriverEventInput,
) => Promise<void>;

export type AcpCancelledTurnBarrier = (
  context: AgentDriverContext,
  providerPromptAdmitted: boolean,
) => Promise<void>;

function parsePromptStopReason(value: unknown): StopReason {
  switch (value) {
    case "cancelled":
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal": {
      return value;
    }
    default: {
      throw new Error("ACP prompt response contains an invalid stop reason.");
    }
  }
}

export class AcpTurnController {
  #active: ActiveAcpTurn | null = null;
  readonly #cancelledTurnBarrier: AcpCancelledTurnBarrier;
  readonly events = new AcpAssistantTranscriptState();
  readonly #push: AcpTurnEventPush;
  readonly #pushTerminal: AcpTurnTerminalPush;

  constructor(
    push: AcpTurnEventPush,
    cancelledTurnBarrier: AcpCancelledTurnBarrier = async () => {},
    pushTerminal: AcpTurnTerminalPush = async (context, reason, closures, terminal) =>
      push(context, reason, [...closures, terminal]),
  ) {
    this.#push = push;
    this.#cancelledTurnBarrier = cancelledTurnBarrier;
    this.#pushTerminal = pushTerminal;
  }

  isCancelling(): boolean {
    return this.#active?.cancelRequested ?? false;
  }

  activeSignal(): AbortSignal | undefined {
    return this.#active?.cancellation.signal;
  }

  abort(reason: string): void {
    if (this.#active !== null) {
      requestCancellation(this.#active, reason);
    }
  }

  routeFatal(error: Error, cleanup: Promise<void>): Promise<void> | null {
    const active = this.#active;
    if (active === null) {
      return Promise.resolve();
    }
    if (active.promptResponseAccepted || active.terminalStarted) {
      return active.settled.promise;
    }

    active.fatal ??= { cleanup, error };
    active.cancellation.abort(error);
    void cleanup.catch(() => {});
    return null;
  }

  async handleInput(
    context: AgentDriverContext,
    input: RuntimeCommandInput,
    runId: RunId,
    connection: ClientContext,
    sessionId: string,
    clientRequests: AcpClientRequestHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#active !== null) {
      throw new Error("ACP driver backend already has an active turn.");
    }

    clientRequests.openFileWriteIngress();
    const messageId = createDriverId() as MessageId;
    const active = createActiveTurn(runId, clientRequests.beginTurnTerminals());
    this.#active = active;
    this.events.begin({ messageId, runId });
    const onAbort = () =>
      requestCancellation(
        active,
        signal?.reason instanceof Error
          ? signal.reason.message
          : "ACP driver backend turn was cancelled.",
      );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
    clientRequests.openPermissionIngress();
    clientRequests.openTurnTranscriptIngress();
    let drainTask: Promise<void> | null = null;
    let preserveEventState = false;
    const drain = async () => {
      try {
        await (drainTask ??= drainTurnWork(clientRequests, active.drainCancellation.signal));
      } catch (error) {
        if (
          !active.drainCancellation.signal.aborted ||
          error !== active.drainCancellation.signal.reason
        ) {
          throw error;
        }

        drainTask = drainTurnWork(clientRequests);
        await drainTask;
      }
    };
    const publishTerminal = async (
      reason: string | ((events: readonly DriverEventInput[]) => string),
      prepare: () => DriverEventInput[],
    ): Promise<DriverEventInput[]> => {
      const restore = this.events.checkpoint();

      try {
        const events = prepare();
        await this.#pushTerminalEvents(
          context,
          typeof reason === "string" ? reason : reason(events),
          events,
        );
        return events;
      } catch (error) {
        restore();
        preserveEventState = true;
        throw error;
      }
    };

    context.logger.info("driver.acp.prompt.sending", {
      sessionId,
      textLength: input.text.length,
    });
    context.logger.debug("driver.acp.prompt.requested", {
      input: summarizeRuntimeCommandInput(input),
      sessionId,
    });

    try {
      await this.#push(
        context,
        "driver.acp.prompt.started",
        toPromptStartEvents({ messageId, runId, text: input.text }),
      );

      if (active.cancelRequested) {
        clientRequests.closeFileWriteIngress();
        clientRequests.closePermissionIngress();
        clientRequests.closeTurnTranscriptIngress();
        await drain();
        await this.#publishCancellationRequest(
          context,
          active,
          active.cancellationReason ?? "ACP driver backend turn was cancelled.",
        );
        await this.#crossCancelledTurnBarrier(context, active, clientRequests);
        active.terminalStarted = true;
        await publishTerminal("driver.acp.prompt.cancelled", () =>
          this.events.completePrompt("cancelled", null),
        );
        throw new DriverTurnCancelledError("ACP driver backend turn was cancelled.");
      }

      active.providerPromptAdmitted = true;
      const promptResult = await connection.request(acpMethods.agent.session.prompt, {
        _meta: {
          ...toRequestMeta({ sessionContext: context.payload.execution.session.context }),
          "mosoo.ai/messageId": messageId,
        },
        prompt: [{ text: input.text, type: "text" }],
        sessionId,
      });
      clientRequests.closeFileWriteIngress();
      if (active.fatal !== null) {
        throw active.fatal.error;
      }
      const providerStopReason = parsePromptStopReason(promptResult.stopReason);
      active.promptResponseAccepted = true;
      active.providerPromptSettled.resolve(true);
      clientRequests.closePermissionIngress();
      clientRequests.closeTurnTranscriptIngress();
      if (providerStopReason === "cancelled") {
        requestCancellation(active, "ACP provider cancelled the turn.");
      }
      await drain();
      const stopReason = active.cancelRequested ? "cancelled" : providerStopReason;
      const promptCancelled = active.cancelRequested || providerStopReason === "cancelled";
      if (promptCancelled) {
        await this.#crossCancelledTurnBarrier(context, active, clientRequests);
      }
      active.terminalStarted = true;
      const completionEvents = await publishTerminal(
        (events) =>
          promptCancelled
            ? "driver.acp.prompt.cancelled"
            : events.some((event) => event.kind === "run.failed")
              ? "driver.acp.prompt.failed"
              : "driver.acp.prompt.completed",
        () => this.events.completePrompt(stopReason, promptResult.usage),
      );
      const promptFailed = completionEvents.some((event) => event.kind === "run.failed");
      context.logger.info(
        promptFailed ? "driver.acp.prompt.failed" : "driver.acp.prompt.completed",
        { sessionId, stopReason: providerStopReason },
      );

      if (promptCancelled) {
        throw new DriverTurnCancelledError("ACP driver backend turn was cancelled.");
      }

      if (promptFailed) {
        throw new AcpPromptTerminalError(stopReason);
      }
    } catch (error) {
      active.providerPromptSettled.resolve(active.providerPromptAdmitted && active.cancelRequested);
      clientRequests.closeFileWriteIngress();
      clientRequests.closePermissionIngress();
      clientRequests.closeTurnTranscriptIngress();
      if (preserveEventState) {
        throw error;
      }
      let catchDrainError: unknown = null;
      try {
        await drain();
      } catch (drainError) {
        catchDrainError = drainError;
        context.logger.warn("driver.acp.prompt.drain.failed", {
          message: drainError instanceof Error ? drainError.message : "ACP turn drain failed.",
        });
      }

      const fatal = active.fatal;

      if (fatal !== null) {
        active.terminalStarted = true;
        const cleanupResults = await Promise.allSettled([
          fatal.cleanup,
          clientRequests.stopTerminals(context),
        ]);
        const cleanupFailures = cleanupResults.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );

        try {
          await publishTerminal("driver.acp.provider.failed", () =>
            this.events.failPrompt({
              code: "acp.provider_failed",
              message: fatal.error.message,
            }),
          );
        } catch (terminalError) {
          if (cleanupFailures.length > 0) {
            throw new AggregateError(
              [fatal.error, ...cleanupFailures, terminalError],
              "ACP provider failure cleanup and terminal publication failed.",
            );
          }
          throw terminalError;
        }
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            [fatal.error, ...cleanupFailures],
            "ACP provider failure cleanup failed.",
          );
        }
        throw fatal.error;
      }

      if (catchDrainError !== null) {
        const message =
          catchDrainError instanceof Error ? catchDrainError.message : "ACP turn drain failed.";
        active.terminalStarted = true;
        await publishTerminal("driver.acp.prompt.failed", () =>
          this.events.failPrompt({ code: "acp.turn_drain_failed", message }),
        );
        throw catchDrainError;
      }

      if (error instanceof DriverTurnCancelledError || error instanceof AcpPromptTerminalError) {
        throw error;
      }

      if (error instanceof DriverTurnCancellationCleanupError) {
        active.terminalStarted = true;
        await publishTerminal("driver.acp.prompt.failed", () =>
          this.events.failPrompt({
            code: "acp.cancel_cleanup_failed",
            message: error.message,
          }),
        );
        throw error;
      }

      if (active.cancelRequested) {
        try {
          await this.#crossCancelledTurnBarrier(context, active, clientRequests);
        } catch (cleanupError) {
          active.terminalStarted = true;
          await publishTerminal("driver.acp.prompt.failed", () =>
            this.events.failPrompt({
              code: "acp.cancel_cleanup_failed",
              message:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : "ACP cancelled turn cleanup failed.",
            }),
          );
          throw cleanupError;
        }
        active.terminalStarted = true;
        await publishTerminal("driver.acp.prompt.cancelled", () =>
          this.events.activeRunId() === null ? [] : this.events.completePrompt("cancelled", null),
        );
        throw new DriverTurnCancelledError("ACP driver backend turn was cancelled.");
      }

      const message = error instanceof Error ? error.message : "ACP driver backend turn failed.";
      active.terminalStarted = true;
      await publishTerminal("driver.acp.prompt.failed", () =>
        this.events.failPrompt({ code: "acp.turn_failed", message }),
      );
      throw error;
    } finally {
      clientRequests.closeFileWriteIngress();
      clientRequests.closePermissionIngress();
      clientRequests.closeTurnTranscriptIngress();
      if (active.drainDeadline !== null) {
        clearTimeout(active.drainDeadline);
      }
      signal?.removeEventListener("abort", onAbort);
      active.providerPromptSettled.resolve(false);
      this.#active = null;
      if (!preserveEventState) {
        this.events.clear();
      }
      active.settled.resolve();
    }
  }

  async cancel(
    context: AgentDriverContext,
    reason: string,
    connection: ClientContext | null,
    sessionId: string | null,
  ): Promise<void> {
    const active = this.#active;
    if (active === null || sessionId === null || connection === null) {
      return;
    }
    if (active.terminalStarted) {
      return;
    }

    requestCancellation(active, "ACP driver backend turn was cancelled.");
    const cancel = active.providerPromptAdmitted
      ? connection.notify(acpMethods.agent.session.cancel, { sessionId })
      : Promise.resolve();
    const eventPush = this.#publishCancellationRequest(context, active, reason);
    const [cancelResult, eventResult] = await Promise.allSettled([cancel, eventPush]);

    if (eventResult.status === "rejected") {
      throw eventResult.reason;
    }
    if (cancelResult.status === "rejected" && !(await active.providerPromptSettled.promise)) {
      throw cancelResult.reason;
    }
  }

  #publishCancellationRequest(
    context: AgentDriverContext,
    active: ActiveAcpTurn,
    reason: string,
  ): Promise<void> {
    return (active.cancellationRequest ??= this.#push(context, "driver.acp.turn.cancel.requested", [
      {
        kind: "run.cancel.requested",
        payload: { reason, requestedBy: "user", targetRunId: active.runId },
        runId: active.runId,
      },
    ]));
  }

  async #pushTerminalEvents(
    context: AgentDriverContext,
    reason: string,
    events: DriverEventInput[],
  ): Promise<void> {
    if (events.length === 0) {
      await this.#push(context, reason, events);
      return;
    }

    const terminal = events.at(-1)!;

    if (
      terminal.kind !== "run.cancelled" &&
      terminal.kind !== "run.completed" &&
      terminal.kind !== "run.failed"
    ) {
      throw new Error("ACP terminal event batch must end with a run terminal.");
    }

    await this.#pushTerminal(context, reason, events.slice(0, -1), terminal);
  }

  async #crossCancelledTurnBarrier(
    context: AgentDriverContext,
    active: ActiveAcpTurn,
    clientRequests: AcpClientRequestHandler,
  ): Promise<void> {
    try {
      await (active.cancellationBarrier ??= (async () => {
        await clientRequests.stopTurnTerminals(context, active.terminalTurn);
        await this.#cancelledTurnBarrier(context, active.providerPromptAdmitted);
      })());
    } catch (error) {
      throw new DriverTurnCancellationCleanupError(
        `ACP cancelled turn process recycle failed: ${
          error instanceof Error ? error.message : "unknown cleanup error"
        }`,
        error,
      );
    }
  }
}
