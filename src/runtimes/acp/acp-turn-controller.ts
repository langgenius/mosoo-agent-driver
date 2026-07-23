import { methods as acpMethods } from "@agentclientprotocol/sdk";
import type { ClientContext } from "@agentclientprotocol/sdk";

import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { ACTIVE_TURN_CANCEL_GRACE_MS } from "../../core/driver-command-dispatcher";
import {
  DriverTurnCancellationCleanupError,
  DriverTurnCancelledError,
} from "../../core/driver-runtime-state";
import { summarizeRuntimeCommandInput } from "../../observability/driver-debug";
import type { DriverEventInput } from "../../protocol/events";
import type { DriverHostIntegrationSnapshot } from "../../protocol/host-integration";
import { createDriverId } from "../../protocol/id";
import type { MessageId, RunId } from "../../protocol/id";
import type { RuntimeCommandInput } from "../../runtime-command";
import { raceWithAbort } from "../../utils/async";
import type { AcpClientRequestHandler } from "./acp-client-request-handler";
import { toRequestMeta } from "./acp-configuration";
import { AcpTurnEventState, toPromptStartEvents } from "./acp-event-translator";

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
  readonly providerPromptSettled: ReturnType<typeof Promise.withResolvers<boolean>>;
  readonly runId: RunId;
  terminalStarted: boolean;
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

function readFatal(active: ActiveAcpTurn): ActiveAcpTurn["fatal"] {
  return active.fatal;
}

export type AcpTurnEventPush = (
  context: AgentDriverContext,
  reason: string,
  events: DriverEventInput[],
) => Promise<void>;

export type AcpCancelledTurnBarrier = (context: AgentDriverContext) => Promise<void>;

export class AcpTurnController {
  #active: ActiveAcpTurn | null = null;
  readonly #cancelledTurnBarrier: AcpCancelledTurnBarrier;
  readonly events = new AcpTurnEventState();
  readonly #push: AcpTurnEventPush;

  constructor(
    push: AcpTurnEventPush,
    cancelledTurnBarrier: AcpCancelledTurnBarrier = async () => {},
  ) {
    this.#push = push;
    this.#cancelledTurnBarrier = cancelledTurnBarrier;
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

  failActive(error: Error, cleanup: Promise<void>): boolean {
    const active = this.#active;
    if (active === null || active.terminalStarted) {
      return false;
    }

    active.fatal ??= { cleanup, error };
    active.cancellation.abort(error);
    void cleanup.catch(() => {});
    return true;
  }

  async handleInput(
    context: AgentDriverContext,
    input: RuntimeCommandInput,
    runId: RunId,
    connection: ClientContext,
    sessionId: string,
    hostSnapshot: DriverHostIntegrationSnapshot,
    clientRequests: AcpClientRequestHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#active !== null) {
      throw new Error("ACP driver backend already has an active turn.");
    }

    const messageId = createDriverId() as MessageId;
    const active = {
      cancellation: new AbortController(),
      cancellationBarrier: null,
      cancellationReason: null,
      cancellationRequest: null,
      cancelRequested: false,
      drainCancellation: new AbortController(),
      drainDeadline: null,
      fatal: null,
      providerPromptAdmitted: false,
      providerPromptSettled: Promise.withResolvers<boolean>(),
      runId,
      terminalStarted: false,
    };
    this.#active = active;
    this.events.begin({ messageId, runId, sessionId });
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
    clientRequests.openTurnUpdateIngress();
    let drainTask: Promise<void> | null = null;
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
        clientRequests.closePermissionIngress();
        clientRequests.closeTurnUpdateIngress();
        await drain();
        await this.#publishCancellationRequest(
          context,
          active,
          active.cancellationReason ?? "ACP driver backend turn was cancelled.",
        );
        active.terminalStarted = true;
        await this.#push(
          context,
          "driver.acp.prompt.cancelled",
          this.events.completePrompt("cancelled", null),
        );
        throw new DriverTurnCancelledError("ACP driver backend turn was cancelled.");
      }

      active.providerPromptAdmitted = true;
      const promptResult = await connection.request(acpMethods.agent.session.prompt, {
        _meta: {
          ...toRequestMeta({ sessionContext: hostSnapshot.sessionContext }),
          "mosoo.ai/messageId": messageId,
        },
        prompt: [{ text: input.text, type: "text" }],
        sessionId,
      });
      active.providerPromptSettled.resolve(true);
      clientRequests.closePermissionIngress();
      clientRequests.closeTurnUpdateIngress();
      if (promptResult.stopReason === "cancelled") {
        requestCancellation(active, "ACP provider cancelled the turn.");
      }
      await drain();
      const stopReason = active.cancelRequested ? "cancelled" : promptResult.stopReason;
      const promptCancelled = active.cancelRequested || promptResult.stopReason === "cancelled";
      if (promptCancelled) {
        await this.#crossCancelledTurnBarrier(context, active);
      }
      const completionEvents = this.events.completePrompt(stopReason, promptResult.usage);
      const promptFailed = completionEvents.some((event) => event.kind === "run.failed");

      active.terminalStarted = true;
      await this.#push(
        context,
        promptCancelled
          ? "driver.acp.prompt.cancelled"
          : promptFailed
            ? "driver.acp.prompt.failed"
            : "driver.acp.prompt.completed",
        completionEvents,
      );
      context.logger.info(
        promptFailed ? "driver.acp.prompt.failed" : "driver.acp.prompt.completed",
        { sessionId, stopReason: promptResult.stopReason },
      );

      if (promptCancelled) {
        throw new DriverTurnCancelledError("ACP driver backend turn was cancelled.");
      }

      if (promptFailed) {
        throw new AcpPromptTerminalError(stopReason);
      }
    } catch (error) {
      active.providerPromptSettled.resolve(active.providerPromptAdmitted && active.cancelRequested);
      clientRequests.closePermissionIngress();
      clientRequests.closeTurnUpdateIngress();
      const fatal = readFatal(active);
      const fatalCleanup =
        fatal === null
          ? null
          : Promise.allSettled([fatal.cleanup, clientRequests.stopTerminals(context)]);
      await drain();

      if (fatal !== null && fatalCleanup !== null) {
        const cleanupResults = await fatalCleanup;
        const cleanupFailure = cleanupResults.find((result) => result.status === "rejected");
        if (cleanupFailure?.status === "rejected") {
          throw new AggregateError(
            [fatal.error, cleanupFailure.reason],
            "ACP provider failure cleanup failed.",
          );
        }

        active.terminalStarted = true;
        await this.#push(
          context,
          "driver.acp.provider.failed",
          this.events.failPrompt({
            code: "acp.provider_failed",
            message: fatal.error.message,
          }),
        );
        throw fatal.error;
      }

      if (error instanceof DriverTurnCancelledError || error instanceof AcpPromptTerminalError) {
        throw error;
      }

      if (error instanceof DriverTurnCancellationCleanupError) {
        active.terminalStarted = true;
        await this.#push(
          context,
          "driver.acp.prompt.failed",
          this.events.failPrompt({
            code: "acp.cancel_cleanup_failed",
            message: error.message,
          }),
        );
        throw error;
      }

      if (active.cancelRequested) {
        try {
          await this.#crossCancelledTurnBarrier(context, active);
        } catch (cleanupError) {
          active.terminalStarted = true;
          await this.#push(
            context,
            "driver.acp.prompt.failed",
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
        const events =
          this.events.activeRunId() === null ? [] : this.events.completePrompt("cancelled", null);
        active.terminalStarted = true;
        await this.#push(context, "driver.acp.prompt.cancelled", events);
        throw new DriverTurnCancelledError("ACP driver backend turn was cancelled.");
      }

      const message = error instanceof Error ? error.message : "ACP driver backend turn failed.";
      active.terminalStarted = true;
      await this.#push(
        context,
        "driver.acp.prompt.failed",
        this.events.failPrompt({ code: "acp.turn_failed", message }),
      );
      throw error;
    } finally {
      clientRequests.closePermissionIngress();
      clientRequests.closeTurnUpdateIngress();
      if (active.drainDeadline !== null) {
        clearTimeout(active.drainDeadline);
      }
      signal?.removeEventListener("abort", onAbort);
      active.providerPromptSettled.resolve(false);
      this.#active = null;
      this.events.clear();
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

  async #crossCancelledTurnBarrier(
    context: AgentDriverContext,
    active: ActiveAcpTurn,
  ): Promise<void> {
    if (!active.providerPromptAdmitted) {
      return;
    }

    try {
      await (active.cancellationBarrier ??= this.#cancelledTurnBarrier(context));
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
