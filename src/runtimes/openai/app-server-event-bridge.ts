import { DriverTurnCancelledError } from "../../core/driver-runtime-state";
import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { toOpenAiErrorMessage, toOpenAiSessionUsageSummary } from "./app-server-event-mapping";
import {
  OpenAiItemState,
  OpenAiMessageState,
  OpenAiPlanState,
  OpenAiToolState,
} from "./app-server-event-state";
import { OpenAiAppServerItemEventBridge } from "./app-server-item-events";
import { isRecord, readNonEmptyString, readRecord, readString } from "./app-server-json";
import type { JsonObject } from "./app-server-json";
import { OpenAiTurnTracker } from "./app-server-turn-tracker";
import type {
  ServerNotificationMethod,
  ServerNotificationParams,
} from "./generated/app-server-protocol";

interface OpenAiAppServerEventBridgeOptions {
  push(context: AgentDriverContext, reason: string, events: DriverEventInput[]): Promise<void>;
  requireThreadId(): string;
}

function turnEventId(eventName: string, turnId: string): string {
  return `openai.${eventName}:${turnId}`;
}

function turnEventFields(input: { eventName: string; runId?: RunId | undefined; turnId: string }): {
  native: { eventName: string; provider: string; turnId: string };
  runId?: RunId | undefined;
  sourceEventId: string;
} {
  return {
    native: {
      eventName: input.eventName,
      provider: "openai",
      turnId: input.turnId,
    },
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    sourceEventId: turnEventId(input.eventName, input.turnId),
  };
}

export class OpenAiAppServerEventBridge {
  readonly #itemEvents: OpenAiAppServerItemEventBridge;
  readonly #items = new OpenAiItemState();
  readonly #messages = new OpenAiMessageState();
  readonly #options: OpenAiAppServerEventBridgeOptions;
  readonly #plans = new OpenAiPlanState();
  readonly #tools = new OpenAiToolState();
  readonly #turns = new OpenAiTurnTracker();

  constructor(options: OpenAiAppServerEventBridgeOptions) {
    this.#options = options;
    this.#itemEvents = new OpenAiAppServerItemEventBridge({
      items: this.#items,
      messages: this.#messages,
      plans: this.#plans,
      push: (context, reason, events) => this.#push(context, reason, events),
      tools: this.#tools,
    });
  }

  activeTurnIds(): string[] {
    return this.#turns.activeTurnIds();
  }

  clearActiveTurns(): void {
    this.#turns.clearActiveTurns();
    this.#itemEvents.reset();
  }

  async cancelTurn(
    context: AgentDriverContext,
    turnId: string,
    reason: string,
    drainUpdates?: () => Promise<void>,
  ): Promise<void> {
    const runId = this.#turns.activeRunId(turnId);

    if (runId === null) {
      return;
    }

    if (!this.#turns.rejectTurn(turnId, new DriverTurnCancelledError(reason))) {
      return;
    }
    await drainUpdates?.();
    await this.#push(context, "driver.openai.turn.cancelled", [
      {
        ...turnEventFields({ eventName: "turn.cancel.requested", runId, turnId }),
        kind: "run.cancel.requested",
        payload: {
          reason,
          requestedBy: "user",
          targetRunId: runId,
        },
      },
      ...this.#itemEvents.finishOpen(),
      {
        ...turnEventFields({ eventName: "turn.cancelled", runId, turnId }),
        kind: "run.cancelled",
        payload: {
          requestedBy: "user",
          stopReason: "cancelled",
        },
      },
    ]);
  }

  rejectTurn(turnId: string, error: Error): void {
    this.#turns.rejectTurn(turnId, error);
  }

  rejectActiveTurns(error: Error): void {
    this.#turns.rejectActiveTurns(error);
    this.#itemEvents.reset();
  }

  releaseTurnState(): void {
    this.#itemEvents.reset();
  }

  async trackTurn(turnId: string, runId: RunId): Promise<void> {
    return this.#turns.track(turnId, runId);
  }

  async handleNotification<M extends ServerNotificationMethod>(
    context: AgentDriverContext,
    method: M,
    params: ServerNotificationParams[M],
  ): Promise<void> {
    const payload = isRecord(params) ? params : {};
    const turnId = readNonEmptyString(payload, "turnId");

    if (turnId !== null && this.#turns.hasTerminal(turnId)) {
      return;
    }

    switch (method) {
      case "configWarning": {
        this.#onConfigWarning(context, payload);
        return;
      }
      case "warning": {
        this.#onWarning(context, payload);
        return;
      }
      case "remoteControl/status/changed": {
        this.#onRemoteControl(context, payload);
        return;
      }
      case "thread/started": {
        this.#onThreadStarted(context, payload);
        return;
      }
      case "thread/status/changed": {
        this.#onThreadStatus(context, payload);
        return;
      }
      case "thread/settings/updated": {
        this.#onThreadSettings(context, payload);
        return;
      }
      case "turn/started": {
        await this.#onTurnStarted(context, payload);
        return;
      }
      case "item/started": {
        await this.#itemEvents.onItemStarted(context, payload);
        return;
      }
      case "item/agentMessage/delta": {
        await this.#itemEvents.onMessageDelta(context, payload);
        return;
      }
      case "item/plan/delta": {
        await this.#itemEvents.onPlanDelta(context, payload);
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        await this.#itemEvents.onReasoningDelta(context, payload);
        return;
      }
      case "item/reasoning/summaryPartAdded": {
        await this.#itemEvents.onReasoningPart(context, payload);
        return;
      }
      case "item/reasoning/textDelta": {
        return;
      }
      case "item/completed": {
        await this.#itemEvents.onItemCompleted(context, payload);
        return;
      }
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        await this.#itemEvents.onToolOutput(context, payload);
        return;
      }
      case "item/fileChange/patchUpdated": {
        await this.#itemEvents.onFilePatch(context, payload);
        return;
      }
      case "thread/tokenUsage/updated": {
        await this.#onUsage(context, payload);
        return;
      }
      case "turn/completed": {
        await this.#onTurnCompleted(context, payload);
        return;
      }
      case "turn/diff/updated": {
        await this.#onTurnDiff(context, payload);
        return;
      }
      case "turn/plan/updated": {
        await this.#itemEvents.onTurnPlan(context, payload);
        return;
      }
      case "error": {
        this.#onRuntimeError(context, payload);
        return;
      }
      default: {
        return;
      }
    }
  }

  async publishNativeResumeRef(context: AgentDriverContext): Promise<void> {
    await this.#push(context, "driver.openai.native_resume_ref.updated", [
      {
        kind: "runtime.resume.updated",
        payload: {
          resumePointer: this.#options.requireThreadId(),
          threadId: this.#options.requireThreadId(),
        },
        visibility: "owner_debug",
      },
    ]);
  }

  async publishRunStarted(
    context: AgentDriverContext,
    input: { runId?: RunId | undefined; turnId: string },
  ): Promise<void> {
    if (!this.#turns.markTurnStarted(input.turnId)) {
      return;
    }

    await this.#push(context, "driver.openai.turn.started", [
      {
        ...turnEventFields({
          eventName: "turn.started",
          runId: input.runId,
          turnId: input.turnId,
        }),
        kind: "run.started",
        payload: {
          startedAt: new Date().toISOString(),
        },
      },
    ]);
  }

  #onConfigWarning(context: AgentDriverContext, params: JsonObject): void {
    context.logger.warn("driver.openai.config.warning", {
      details: readString(params, "details"),
      path: readString(params, "path"),
      range: readRecord(params, "range"),
      summary: readString(params, "summary") ?? "OpenAi app-server configuration warning.",
    });
  }

  #onRemoteControl(context: AgentDriverContext, params: JsonObject): void {
    context.logger.debug("driver.openai.remote_control.status_changed", {
      environmentId: readString(params, "environmentId"),
      installationId: readString(params, "installationId"),
      serverName: readString(params, "serverName"),
      status: readString(params, "status"),
    });
  }

  #onThreadSettings(context: AgentDriverContext, params: JsonObject): void {
    const threadSettings = readRecord(params, "threadSettings");

    context.logger.debug("driver.openai.thread.settings_updated", {
      model: readString(threadSettings, "model"),
      modelProvider: readString(threadSettings, "modelProvider"),
      threadIdPresent: readString(params, "threadId") !== null,
    });
  }

  #onThreadStarted(context: AgentDriverContext, params: JsonObject): void {
    const thread = readRecord(params, "thread");

    context.logger.debug("driver.openai.thread.started", {
      threadIdPresent: readString(thread, "id") !== null,
    });
  }

  #onThreadStatus(context: AgentDriverContext, params: JsonObject): void {
    const status = readRecord(params, "status");
    const statusType = readString(status, "type");

    context.logger.debug("driver.openai.thread.status_changed", {
      status: statusType,
      threadIdPresent: readString(params, "threadId") !== null,
    });

    if (statusType === "systemError") {
      context.logger.warn("driver.openai.thread.system_error.awaiting_turn_completion", {
        threadIdPresent: readString(params, "threadId") !== null,
      });
    }
  }

  #onWarning(context: AgentDriverContext, params: JsonObject): void {
    context.logger.warn("driver.openai.warning", {
      message: readString(params, "message") ?? "OpenAi app-server warning.",
      threadIdPresent: readString(params, "threadId") !== null,
    });
  }

  #onRuntimeError(context: AgentDriverContext, params: JsonObject): void {
    const error = readRecord(params, "error");
    const message =
      readString(error, "message") ?? readString(params, "message") ?? "OpenAi app-server error.";
    const additionalDetails = readString(error, "additionalDetails");
    const turnId = readString(params, "turnId");
    const willRetry = params["willRetry"] === true;

    context.logger.warn("driver.openai.error.awaiting_turn_completion", {
      additionalDetails,
      message,
      threadIdPresent: readString(params, "threadId") !== null,
      turnIdPresent: turnId !== null,
      willRetry,
    });
  }

  async #onTurnCompleted(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const turn = readRecord(params, "turn");
    const turnId = turn === null ? null : readNonEmptyString(turn, "id");

    if (turnId === null || this.#turns.hasTerminal(turnId)) {
      return;
    }

    const status = turn ? readString(turn, "status") : null;

    if (status !== "completed" && status !== "failed" && status !== "interrupted") {
      throw new Error("OpenAi turn/completed requires a terminal turn status.");
    }

    const runId = this.#turns.activeRunId(turnId) ?? undefined;

    await this.publishRunStarted(context, { runId, turnId });
    await this.#itemEvents.onTurnItems(context, params, turnId);
    const authoritativeFinalMessage = await this.#itemEvents.resolveFinalMessage(
      context,
      params,
      turnId,
    );
    if (!this.#turns.beginSettlement(turnId)) {
      return;
    }

    const error = turn ? readRecord(turn, "error") : null;
    try {
      if (status === "interrupted") {
        await this.#push(context, "driver.openai.turn.interrupted", [
          ...this.#itemEvents.finishOpen(),
          {
            ...turnEventFields({ eventName: "turn.interrupted", runId, turnId }),
            kind: "run.cancelled",
            payload: {
              requestedBy: "provider",
              stopReason: "cancelled",
            },
          },
        ]);
        this.#finishSettlement(turnId, {
          error: new DriverTurnCancelledError("OpenAI turn was interrupted."),
          kind: "failed",
        });
        return;
      }

      if (status === "failed") {
        const message = toOpenAiErrorMessage(
          readString(error, "message") ?? "OpenAi turn failed.",
          readString(error, "additionalDetails"),
        );
        await this.#push(context, "driver.openai.turn.failed", [
          ...this.#itemEvents.finishOpen(),
          {
            ...turnEventFields({
              eventName: "turn.failed",
              runId,
              turnId,
            }),
            kind: "run.failed",
            payload: {
              error: {
                code: "openai.turn_failed",
                message,
              },
              recoverable: false,
            },
          },
        ]);
        this.#finishSettlement(turnId, {
          error: new Error(message),
          kind: "failed",
        });
        return;
      }

      await this.#push(context, "driver.openai.turn.completed", [
        ...this.#itemEvents.finishOpen(),
        {
          ...turnEventFields({
            eventName: "turn.completed",
            runId,
            turnId,
          }),
          kind: "run.completed",
          payload: {
            ...(authoritativeFinalMessage === null
              ? {}
              : {
                  finalMessageId: authoritativeFinalMessage.id,
                  finalMessageText: authoritativeFinalMessage.text,
                }),
            stopReason: "end_turn",
          },
        },
      ]);

      // A fresh app-server thread may not have a rollout until its first successful
      // turn is materialized. Resume metadata must never turn that successful turn
      // into a failure, so publish it only after the canonical completion settles.
      try {
        await this.publishNativeResumeRef(context);
      } catch (publishError) {
        context.logger.warn("driver.openai.native_resume_ref.publish_failed", {
          message:
            publishError instanceof Error
              ? publishError.message
              : "Native resume ref publish failed.",
        });
      }
      this.#finishSettlement(turnId, { kind: "completed" });
    } catch (pushError) {
      this.#turns.cancelSettlement(turnId);
      throw pushError;
    }
  }

  async #onTurnDiff(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const turnId = readNonEmptyString(params, "turnId");
    const diff = readString(params, "diff");

    if (turnId === null || diff === null) {
      return;
    }

    await this.#push(context, "driver.openai.turn.diff.updated", [
      {
        kind: "diagnostic.reported",
        payload: {
          diff,
          message: "OpenAI turn diff updated.",
          severity: "info",
          turnId,
        },
        visibility: "owner_debug",
      },
    ]);
  }

  async #onTurnStarted(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const turn = readRecord(params, "turn");
    const turnId = turn === null ? null : readNonEmptyString(turn, "id");

    if (turnId === null) {
      return;
    }

    const runId = this.#turns.activeRunId(turnId) ?? undefined;

    await this.publishRunStarted(context, { runId, turnId });
  }

  async #onUsage(context: AgentDriverContext, params: JsonObject): Promise<void> {
    await this.#push(context, "driver.openai.usage.updated", [
      {
        kind: "usage.updated",
        payload: toOpenAiSessionUsageSummary(params),
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

    await this.#options.push(context, reason, events);
  }

  #finishSettlement(
    turnId: string,
    terminalTurn: Parameters<OpenAiTurnTracker["finishSettlement"]>[1],
  ): void {
    this.#turns.finishSettlement(turnId, terminalTurn);
    this.#itemEvents.reset();
  }
}
