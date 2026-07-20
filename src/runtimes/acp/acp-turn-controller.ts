import { methods as acpMethods } from "@agentclientprotocol/sdk";
import type { ClientContext } from "@agentclientprotocol/sdk";

import { DriverTurnCancelledError } from "../../core/driver-runtime-state";
import { summarizeRuntimeCommandInput } from "../../observability/driver-debug";
import type { DriverEventInput } from "../../protocol/events";
import type { DriverHostIntegrationSnapshot } from "../../protocol/host-integration";
import { createDriverId } from "../../protocol/id";
import type { MessageId, RunId } from "../../protocol/id";
import type { RuntimeCommandInput } from "../../runtime-command";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import type { AcpClientRequestHandler } from "./acp-client-request-handler";
import { toRequestMeta } from "./acp-configuration";
import { AcpTurnEventState, toPromptStartEvents } from "./acp-event-translator";

interface ActiveAcpTurn {
  readonly cancellation: AbortController;
  cancelRequested: boolean;
  readonly runId: RunId;
}

class AcpPromptTerminalError extends Error {
  override readonly name = "AcpPromptTerminalError";

  constructor(stopReason: string) {
    super(`ACP prompt stopped with terminal stop reason: ${stopReason}.`);
  }
}

export type AcpTurnEventPush = (
  context: AgentDriverContext,
  reason: string,
  events: DriverEventInput[],
) => Promise<void>;

export class AcpTurnController {
  #active: ActiveAcpTurn | null = null;
  readonly events = new AcpTurnEventState();
  readonly #push: AcpTurnEventPush;

  constructor(push: AcpTurnEventPush) {
    this.#push = push;
  }

  isCancelling(): boolean {
    return this.#active?.cancelRequested ?? false;
  }

  activeSignal(): AbortSignal | undefined {
    return this.#active?.cancellation.signal;
  }

  abort(reason: string): void {
    this.#active?.cancellation.abort(new DriverTurnCancelledError(reason));
  }

  async handleInput(
    context: AgentDriverContext,
    input: RuntimeCommandInput,
    runId: RunId,
    connection: ClientContext,
    sessionId: string,
    hostSnapshot: DriverHostIntegrationSnapshot,
    clientRequests: AcpClientRequestHandler,
  ): Promise<void> {
    if (this.#active !== null) {
      throw new Error("ACP driver backend already has an active turn.");
    }

    const messageId = createDriverId() as MessageId;
    const active = {
      cancellation: new AbortController(),
      cancelRequested: false,
      runId,
    };
    this.#active = active;
    this.events.begin({ messageId, runId, sessionId });

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
        await this.#push(
          context,
          "driver.acp.prompt.cancelled",
          this.events.completePrompt("cancelled", null),
        );
        throw new DriverTurnCancelledError("ACP driver backend turn was cancelled.");
      }

      const promptResult = await connection.request(acpMethods.agent.session.prompt, {
        _meta: {
          ...toRequestMeta({ sessionContext: hostSnapshot.sessionContext }),
          "mosoo.ai/messageId": messageId,
        },
        prompt: [{ text: input.text, type: "text" }],
        sessionId,
      });
      await clientRequests.drainUpdates();
      const stopReason = active.cancelRequested ? "cancelled" : promptResult.stopReason;
      const completionEvents = this.events.completePrompt(stopReason, promptResult.usage);
      const promptCancelled = active.cancelRequested || promptResult.stopReason === "cancelled";
      const promptFailed = completionEvents.some((event) => event.kind === "run.failed");

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
      let failure = error;

      try {
        await clientRequests.drainUpdates();
      } catch (updateError) {
        failure = updateError;
      }

      if (
        failure instanceof DriverTurnCancelledError ||
        failure instanceof AcpPromptTerminalError
      ) {
        throw failure;
      }

      if (active.cancelRequested) {
        const events =
          this.events.activeRunId() === null ? [] : this.events.completePrompt("cancelled", null);
        await this.#push(context, "driver.acp.prompt.cancelled", events);
        throw new DriverTurnCancelledError("ACP driver backend turn was cancelled.");
      }

      const message =
        failure instanceof Error ? failure.message : "ACP driver backend turn failed.";
      await this.#push(
        context,
        "driver.acp.prompt.failed",
        this.events.failPrompt({ code: "acp.turn_failed", message }),
      );
      throw failure;
    } finally {
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

    if (!active.cancelRequested) {
      active.cancelRequested = true;
      active.cancellation.abort(
        new DriverTurnCancelledError("ACP driver backend turn was cancelled."),
      );
      const cancel = connection.notify(acpMethods.agent.session.cancel, { sessionId });
      const eventPush = this.#push(context, "driver.acp.turn.cancel.requested", [
        {
          kind: "run.cancel.requested",
          payload: { reason, requestedBy: "user", targetRunId: active.runId },
          runId: active.runId,
        },
      ]);
      await Promise.all([cancel, eventPush]);
      return;
    }

    await connection.notify(acpMethods.agent.session.cancel, { sessionId });
  }
}
