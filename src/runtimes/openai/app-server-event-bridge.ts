import { DriverTurnCancelledError } from "../../core/driver-runtime-state";
import type { DriverEventInput } from "../../protocol/events";
import { createDriverId, driverIdTimeMs, type RunId } from "../../protocol/id";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { toOpenAiProtocolError } from "./app-server-event-mapping";
import {
  OpenAiItemState,
  OpenAiMessageState,
  OpenAiPlanState,
  OpenAiSessionUsageState,
  OpenAiToolState,
  type OpenAiTerminalOutcome,
} from "./app-server-event-state";
import { createRuntimeSourceEventId, toRuntimePublicId } from "../runtime-public-id";
import { DriverCompletedTerminalSupersededError } from "../driver-event-publisher";
import { chunkOpenAiText, OpenAiAppServerItemEventBridge } from "./app-server-item-events";
import { isRecord, readArray, readNonEmptyString, readRecord, readString } from "./app-server-json";
import type { JsonObject } from "./app-server-json";
import { OpenAiTurnTracker, type OpenAiTurnAdmission } from "./app-server-turn-tracker";
import type { ServerNotificationMethod } from "./app-server-protocol";

interface OpenAiAppServerEventBridgeOptions {
  beforeInterruptedTurn?(context: AgentDriverContext, turnId: string): Promise<void>;
  push(context: AgentDriverContext, reason: string, events: DriverEventInput[]): Promise<void>;
  pushSession(
    context: AgentDriverContext,
    reason: string,
    events: DriverEventInput[],
  ): Promise<void>;
  pushTerminal(
    context: AgentDriverContext,
    reason: string,
    closures: readonly DriverEventInput[],
    terminal: DriverEventInput,
    cancellationSignal?: AbortSignal,
  ): Promise<void>;
  requireThreadId(): string;
}

const MAX_OPENAI_TELEMETRY_FIELD_BYTES = 4 * 1_024;
const MAX_WORLD_WRITABLE_SAMPLE_PATHS = 16;

function jsonUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function toBoundedOpenAiTelemetry(payload: JsonObject, fields: readonly string[]): JsonObject {
  const summary: JsonObject = { utf8Bytes: jsonUtf8Bytes(payload) };

  for (const field of fields) {
    const value = payload[field];

    if (typeof value === "string") {
      const utf8Bytes = Buffer.byteLength(value, "utf8");
      if (utf8Bytes <= MAX_OPENAI_TELEMETRY_FIELD_BYTES) {
        summary[field] = value;
      } else {
        summary[`${field}Utf8Bytes`] = utf8Bytes;
      }
      continue;
    }

    if (Array.isArray(value)) {
      const utf8Bytes = jsonUtf8Bytes(value);
      if (utf8Bytes <= MAX_OPENAI_TELEMETRY_FIELD_BYTES) {
        summary[field] = value;
      } else {
        summary[`${field}Count`] = value.length;
        summary[`${field}Utf8Bytes`] = utf8Bytes;
      }
      continue;
    }

    if (isRecord(value)) {
      const utf8Bytes = jsonUtf8Bytes(value);
      if (utf8Bytes <= MAX_OPENAI_TELEMETRY_FIELD_BYTES) {
        summary[field] = value;
      } else {
        summary[`${field}Utf8Bytes`] = utf8Bytes;
      }
      continue;
    }

    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      summary[field] = value;
    }
  }

  return summary;
}

function toOpenAiUserFacingEvents(
  method:
    | "guardianWarning"
    | "modelProvider/authRecoveryCompleted"
    | "modelProvider/authRecoveryStarted"
    | "warning",
  message: string,
  details: JsonObject = {},
): DriverEventInput[] {
  const chunks = chunkOpenAiText(message);
  const warning = method === "guardianWarning" || method === "warning";

  return chunks.map((content, index) => ({
    delivery: warning ? "lossless" : "best_effort",
    kind: "message.added",
    payload: {
      ...details,
      ...(chunks.length === 1 ? {} : { chunkCount: chunks.length, chunkIndex: index }),
      content,
      level: warning ? "warning" : "info",
      messageId: createDriverId(),
      role: "agent",
      subtype:
        method === "guardianWarning"
          ? "guardian_warning"
          : method === "warning"
            ? "warning"
            : method === "modelProvider/authRecoveryStarted"
              ? "model_provider_auth_recovery_started"
              : "model_provider_auth_recovery_completed",
    },
  }));
}

function turnEventId(eventName: string, publicTurnId: string): string {
  return `openai.${eventName}:${publicTurnId}`;
}

function turnEventFields(input: {
  eventName: string;
  publicTurnId: string;
  runId?: RunId | undefined;
}): {
  native: { eventName: string; provider: string; turnId: string };
  runId?: RunId | undefined;
  sourceEventId: string;
} {
  return {
    native: {
      eventName: input.eventName,
      provider: "openai",
      turnId: input.publicTurnId,
    },
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    sourceEventId: turnEventId(input.eventName, input.publicTurnId),
  };
}

function turnClosureEvents(input: {
  eventName: string;
  events: readonly DriverEventInput[];
  publicTurnId: string;
  runId?: RunId | undefined;
}): DriverEventInput[] {
  const sourcePrefix = createRuntimeSourceEventId(
    `openai.${input.eventName}.closure`,
    "turn",
    input.publicTurnId,
  );
  return input.events.map((event, index) => {
    const scopedEvent = {
      ...event,
      ...(event.runId === undefined && input.runId !== undefined ? { runId: input.runId } : {}),
    };
    return {
      ...scopedEvent,
      sourceEventId:
        event.sourceEventId ??
        createRuntimeSourceEventId(
          "openai.derived",
          sourcePrefix,
          index,
          JSON.stringify(scopedEvent),
        ),
    };
  });
}

export class OpenAiAppServerEventBridge {
  readonly #itemEvents: OpenAiAppServerItemEventBridge;
  readonly #items = new OpenAiItemState();
  readonly #messages = new OpenAiMessageState();
  readonly #options: OpenAiAppServerEventBridgeOptions;
  readonly #plans = new OpenAiPlanState();
  readonly #tools = new OpenAiToolState();
  readonly #turnStarts = new Map<string, Promise<void>>();
  readonly #turns = new OpenAiTurnTracker();
  readonly #usage = new OpenAiSessionUsageState();

  constructor(options: OpenAiAppServerEventBridgeOptions) {
    this.#options = options;
    this.#itemEvents = new OpenAiAppServerItemEventBridge({
      items: this.#items,
      messages: this.#messages,
      plans: this.#plans,
      push: (context, reason, events) => this.#push(context, reason, events),
      pushSession: options.pushSession,
      tools: this.#tools,
    });
  }

  activeTurnIds(): string[] {
    return this.#turns.activeTurnIds();
  }

  beginTurnAdmission(runId: RunId, signal?: AbortSignal): OpenAiTurnAdmission {
    return this.#turns.admitRootTurn(runId, signal);
  }

  bindTurnAdmission(admission: OpenAiTurnAdmission, turnId: string): void {
    this.#turns.bindRootTurn(admission, turnId);
  }

  armTurnAdmission(admission: OpenAiTurnAdmission): void {
    this.#turns.armRootTurn(admission);
  }

  claimTurnAdmission(
    admission: OpenAiTurnAdmission,
    turnId: string,
    runId: RunId,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#turns.claimRootTurn(admission, turnId, runId, signal);
  }

  releaseTurnAdmission(admission: OpenAiTurnAdmission): void {
    this.#turns.releaseRootTurn(admission);
  }

  releaseTurnAdmissionSelection(admission: OpenAiTurnAdmission): void {
    this.#turns.releaseRootTurnSelection(admission);
  }

  admittedTurnId(admission: OpenAiTurnAdmission): string | null {
    return this.#turns.admittedTurnId(admission);
  }

  hasTerminalTurn(turnId: string): boolean {
    return this.#turns.hasTerminal(turnId);
  }

  hasAdmittedTerminalTurn(): boolean {
    return this.#turns.hasAdmittedTerminalTurn();
  }

  mapToolCallId(toolCallId: string): string {
    return this.#items.publicId(toolCallId);
  }

  publicTurnId(turnId: string): string {
    return this.#items.publicId(turnId, "turn");
  }

  clearActiveTurns(): void {
    this.#turnStarts.clear();
    this.#turns.clearActiveTurns();
    this.#itemEvents.reset();
    this.#usage.reset();
  }

  async cancelTurn(
    context: AgentDriverContext,
    turnId: string,
    reason: string,
    drainUpdates?: () => Promise<void>,
  ): Promise<void> {
    await drainUpdates?.();
    const runId = this.#turns.activeRunId(turnId);

    if (runId === null) {
      return;
    }

    if (!this.#turns.beginSettlement(turnId)) {
      return;
    }
    const publicTurnId = this.publicTurnId(turnId);
    const completionClosuresCommitted = this.#turns.completionClosuresCommitted(turnId);
    const cancelledClosures = completionClosuresCommitted
      ? []
      : this.#itemEvents.terminalEvents({ kind: "cancelled" });
    const [taskClosure, ...itemClosures] = cancelledClosures;

    try {
      await this.#options.pushTerminal(
        context,
        "driver.openai.turn.cancelled",
        turnClosureEvents({
          eventName: "turn.cancelled",
          events: [
            ...(taskClosure === undefined ? [] : [taskClosure]),
            {
              ...turnEventFields({ eventName: "turn.cancel.requested", publicTurnId, runId }),
              kind: "run.cancel.requested",
              payload: {
                reason,
                requestedBy: "user",
                targetRunId: runId,
              },
            },
            ...itemClosures,
          ],
          publicTurnId,
          runId,
        }),
        {
          ...turnEventFields({ eventName: "turn.cancelled", publicTurnId, runId }),
          kind: "run.cancelled",
          payload: {
            requestedBy: "user",
            stopReason: "cancelled",
          },
        },
      );
      this.#finishSettlement(turnId, {
        error: new DriverTurnCancelledError(reason),
        kind: "failed",
      });
    } catch (pushError) {
      this.#turns.cancelSettlement(turnId);
      throw pushError;
    }
  }

  rejectTurn(turnId: string, error: Error): void {
    this.#turns.rejectTurn(turnId, error);
    this.#usage.release(turnId);
  }

  rejectActiveTurns(error: Error): void {
    this.#turns.rejectActiveTurns(error);
    this.#itemEvents.reset();
    this.#usage.reset();
  }

  async failActiveTurns(context: AgentDriverContext, error: Error): Promise<boolean> {
    let failed = false;

    for (const turnId of this.#turns.activeTurnIds()) {
      const runId = this.#turns.activeRunId(turnId);
      if (runId === null || !this.#turns.beginSettlement(turnId)) {
        continue;
      }

      try {
        const publicTurnId = this.publicTurnId(turnId);
        const protocolError = {
          ...toOpenAiProtocolError({ message: error.message }),
          code: "openai.provider_failed",
        };
        await this.#options.pushTerminal(
          context,
          "driver.openai.provider.failed",
          turnClosureEvents({
            eventName: "provider.failed",
            events: this.#itemEvents.terminalEvents({ error: protocolError, kind: "failed" }),
            publicTurnId,
            runId,
          }),
          {
            ...turnEventFields({ eventName: "provider.failed", publicTurnId, runId }),
            kind: "run.failed",
            payload: {
              error: protocolError,
              recoverable: false,
            },
          },
        );
        this.#finishSettlement(turnId, { error: new Error(protocolError.message), kind: "failed" });
        failed = true;
      } catch (pushError) {
        this.#turns.cancelSettlement(turnId);
        throw pushError;
      }
    }

    return failed;
  }

  releaseTurnState(): void {
    this.#itemEvents.reset();
  }

  turnStartTerminalEvents(
    outcome: OpenAiTerminalOutcome,
  ): [DriverEventInput, ...DriverEventInput[]] {
    return this.#itemEvents.terminalEvents(outcome);
  }

  async trackTurn(turnId: string, runId: RunId, signal?: AbortSignal): Promise<void> {
    return this.#turns.track(turnId, runId, signal);
  }

  async handleNotification(
    context: AgentDriverContext,
    method: ServerNotificationMethod,
    params: JsonObject,
  ): Promise<void> {
    const payload = isRecord(params) ? params : {};
    const turnId =
      readNonEmptyString(payload, "turnId") ??
      readNonEmptyString(readRecord(payload, "turn"), "id");
    const notificationMethod = method;

    // Native Codex subagents own child threads and turns. Their direct message
    // and lifecycle frames are provider-internal activity, not authoritative
    // mutations of the Mosoo Run attached to the root app-server thread. Root
    // collabAgentToolCall/subAgentActivity items still arrive on the root thread
    // and continue through the normal item projection below.
    if (
      turnId !== null &&
      readNonEmptyString(payload, "threadId") !== this.#options.requireThreadId()
    ) {
      return;
    }
    const item = readRecord(payload, "item");
    const postTerminalSubAgentActivity =
      notificationMethod === "item/completed" &&
      readString(item, "type") === "subAgentActivity" &&
      (readString(item, "kind") === "completed" || readString(item, "kind") === "interrupted");

    if (turnId !== null && this.#turns.hasTerminal(turnId)) {
      if (postTerminalSubAgentActivity) {
        await this.#itemEvents.onPostTerminalSubAgentActivity(context, payload);
      }
      return;
    }
    if (
      turnId !== null &&
      (!(await this.#turns.awaitRootTurnAdmission(turnId)) || !this.#turns.acceptsRootTurn(turnId))
    ) {
      return;
    }

    switch (notificationMethod) {
      case "configWarning": {
        this.#onConfigWarning(context, payload);
        return;
      }
      case "warning":
      case "guardianWarning": {
        await this.#onWarning(context, payload, notificationMethod);
        return;
      }
      case "modelProvider/authRecoveryStarted":
      case "modelProvider/authRecoveryCompleted": {
        const message = readString(payload, "message");
        if (message !== null) {
          await this.#push(
            context,
            "driver.openai.model_provider.auth_recovery",
            toOpenAiUserFacingEvents(
              notificationMethod,
              message,
              toBoundedOpenAiTelemetry(payload, ["provider"]),
            ),
          );
        }
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
      case "hook/started":
      case "hook/completed": {
        await this.#onHook(context, payload, notificationMethod);
        return;
      }
      case "item/started": {
        await this.#itemEvents.onItemStarted(context, payload);
        return;
      }
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        await this.#onAutoApprovalReview(context, payload, notificationMethod);
        return;
      }
      case "autoApprovalReview/strictReviewRequired": {
        await this.#push(context, "driver.openai.autoApprovalReview.strictReviewRequired", [
          {
            delivery: "lossless",
            kind: "message.added",
            payload: {
              ...toBoundedOpenAiTelemetry(payload, ["startedAtMs"]),
              content:
                "This request requires additional safety checks; tool calls may take longer.",
              level: "warning",
              messageId: createDriverId(),
              role: "agent",
              subtype: "strict_review_required",
            },
          },
        ]);
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
        // Raw reasoning is intentionally private; summary notifications own visible thought output.
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
      case "item/commandExecution/terminalInteraction": {
        await this.#onTerminalInteraction(context, payload);
        return;
      }
      case "item/mcpToolCall/progress": {
        await this.#onMcpToolProgress(context, payload);
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
      case "mcpServer/startupStatus/updated": {
        await this.#push(context, "driver.openai.mcp.server.updated", [
          {
            delivery: "best_effort",
            kind: "mcp.server.updated",
            payload: toBoundedOpenAiTelemetry(payload, [
              "error",
              "failureReason",
              "name",
              "status",
              "threadId",
            ]),
          },
        ]);
        return;
      }
      case "model/rerouted":
      case "model/safetyBuffering/updated": {
        await this.#push(context, "driver.openai.model.routing_updated", [
          {
            delivery: "best_effort",
            kind: "model.routing.updated",
            payload: toBoundedOpenAiTelemetry(payload, [
              "fasterModel",
              "fromModel",
              "model",
              "reason",
              "reasons",
              "showBufferingUi",
              "threadId",
              "toModel",
              "turnId",
              "useCases",
            ]),
          },
        ]);
        return;
      }
      case "model/verification": {
        await this.#push(context, "driver.openai.model.verification", [
          {
            delivery: "best_effort",
            kind: "model.verification.updated",
            payload: toBoundedOpenAiTelemetry(payload, ["threadId", "turnId", "verifications"]),
          },
        ]);
        return;
      }
      case "error": {
        this.#onRuntimeError(context, payload);
        return;
      }
      case "deprecationNotice": {
        const message =
          readString(payload, "summary") ??
          readString(payload, "message") ??
          "OpenAI app-server warning.";
        const messageUtf8Bytes = Buffer.byteLength(message, "utf8");
        context.logger.warn("driver.openai.notification.warning", {
          method: notificationMethod,
          ...(messageUtf8Bytes <= MAX_OPENAI_TELEMETRY_FIELD_BYTES ? { message } : {}),
          messageUtf8Bytes,
        });
        return;
      }
      case "windows/worldWritableWarning": {
        await this.#onWorldWritableWarning(context, payload);
        return;
      }
      case "turn/moderationMetadata":
      case "skills/changed":
      case "thread/name/updated":
      case "thread/goal/updated":
      case "thread/goal/cleared":
      case "thread/reverted":
      case "thread/queue/changed":
      case "project/changed":
      case "thread/project/updated":
      case "thread/environment/connected":
      case "thread/environment/disconnected":
      case "account/updated":
      case "account/rateLimits/updated":
      case "windowsSandbox/setupCompleted": {
        context.logger.debug("driver.openai.notification.handled_without_public_event", {
          method: notificationMethod,
        });
        return;
      }
      case "thread/archived":
      case "thread/deleted":
      case "thread/unarchived":
      case "thread/closed":
      case "command/exec/outputDelta":
      case "process/outputDelta":
      case "process/exited":
      case "serverRequest/resolved":
      case "mcpServer/oauthLogin/completed":
      case "mcpServer/event/stream/notification":
      case "app/list/updated":
      case "externalAgentConfig/import/progress":
      case "externalAgentConfig/import/completed":
      case "fs/changed":
      case "thread/compacted":
      case "fuzzyFileSearch/sessionUpdated":
      case "fuzzyFileSearch/sessionCompleted":
      case "thread/realtime/started":
      case "thread/realtime/itemAdded":
      case "thread/realtime/item/started":
      case "thread/realtime/item/transcript/delta":
      case "thread/realtime/item/completed":
      case "thread/realtime/transcript/delta":
      case "thread/realtime/transcript/done":
      case "thread/realtime/outputAudio/delta":
      case "thread/realtime/sdp":
      case "thread/realtime/error":
      case "thread/realtime/closed":
      case "account/login/completed":
        // Explicitly unsupported request surfaces, deprecated duplicates, or transport bookkeeping.
        return;
      default: {
        const exhaustive: never = notificationMethod;
        return exhaustive;
      }
    }
  }

  async publishNativeResumeRef(context: AgentDriverContext): Promise<void> {
    const threadId = this.#options.requireThreadId();
    const publicThreadId = toRuntimePublicId(threadId, "openai-thread");
    await this.#push(context, "driver.openai.native_resume_ref.updated", [
      {
        kind: "runtime.resume.updated",
        payload: {
          resumePointer: this.#options.requireThreadId(),
          threadId: publicThreadId,
        },
        visibility: "owner_debug",
      },
    ]);
  }

  async publishRunStarted(
    context: AgentDriverContext,
    input: { runId?: RunId | undefined; turnId: string },
  ): Promise<void> {
    const identityRunId = input.runId ?? context.ports.eventSink.currentRunId();
    if (identityRunId === null) {
      return;
    }
    if (this.#turns.hasTurnStarted(input.turnId) || this.#turns.hasTerminal(input.turnId)) {
      return;
    }

    const existing = this.#turnStarts.get(input.turnId);
    if (existing !== undefined) {
      await existing;
      return;
    }

    const starting = (async () => {
      await this.#push(context, "driver.openai.turn.started", [
        {
          ...turnEventFields({
            eventName: "turn.started",
            publicTurnId: this.publicTurnId(input.turnId),
            runId: input.runId,
          }),
          kind: "run.started",
          payload: {
            startedAt: new Date(driverIdTimeMs(identityRunId)).toISOString(),
          },
        },
      ]);
      this.#turns.markTurnStarted(input.turnId);
    })();
    this.#turnStarts.set(input.turnId, starting);

    try {
      await starting;
    } finally {
      if (this.#turnStarts.get(input.turnId) === starting) {
        this.#turnStarts.delete(input.turnId);
      }
    }
  }

  async #onAutoApprovalReview(
    context: AgentDriverContext,
    params: JsonObject,
    method: "item/autoApprovalReview/completed" | "item/autoApprovalReview/started",
  ): Promise<void> {
    const turnId = readNonEmptyString(params, "turnId");
    const runId = turnId === null ? null : this.#turns.activeRunId(turnId);
    const action = readRecord(params, "action");
    const review = readRecord(params, "review");
    const targetItemId = readNonEmptyString(params, "targetItemId");
    const actionSummary =
      action === null
        ? null
        : {
            ...toBoundedOpenAiTelemetry(action, [
              "approvalId",
              "argv",
              "command",
              "cwd",
              "files",
              "host",
              "permissions",
              "port",
              "processId",
              "program",
              "protocol",
              "reason",
              "server",
              "source",
              "target",
              "toolName",
              "toolTitle",
              "connectorId",
              "connectorName",
              "type",
            ]),
            ...(typeof action["stdin"] === "string"
              ? { stdinUtf8Bytes: Buffer.byteLength(action["stdin"], "utf8") }
              : {}),
          };

    await this.#push(context, `driver.openai.${method.replaceAll("/", ".")}`, [
      {
        delivery: "best_effort",
        kind:
          method === "item/autoApprovalReview/started"
            ? "permission.review.started"
            : "permission.review.completed",
        payload: {
          ...toBoundedOpenAiTelemetry(params, [
            "completedAtMs",
            "decisionSource",
            "reviewId",
            "startedAtMs",
            "threadId",
            "turnId",
          ]),
          ...(targetItemId === null ? {} : { targetItemId: this.mapToolCallId(targetItemId) }),
          ...(actionSummary === null ? {} : { action: actionSummary }),
          ...(review === null
            ? {}
            : {
                review: toBoundedOpenAiTelemetry(review, [
                  ...(readString(action, "type") === "writeStdin" ? [] : ["rationale"]),
                  "riskLevel",
                  "status",
                  "userAuthorization",
                ]),
              }),
        },
        ...(runId === null ? {} : { runId }),
      },
    ]);
  }

  async #onHook(
    context: AgentDriverContext,
    params: JsonObject,
    method: "hook/completed" | "hook/started",
  ): Promise<void> {
    const turnId = readNonEmptyString(params, "turnId");
    const runId = turnId === null ? null : this.#turns.activeRunId(turnId);
    const run = readRecord(params, "run");

    await this.#push(context, `driver.openai.${method.replace("/", ".")}`, [
      {
        delivery: "best_effort",
        kind: method === "hook/started" ? "hook.started" : "hook.completed",
        payload: {
          ...toBoundedOpenAiTelemetry(params, ["threadId", "turnId"]),
          ...(run === null
            ? {}
            : {
                run: {
                  ...toBoundedOpenAiTelemetry(run, [
                    "completedAt",
                    "displayOrder",
                    "durationMs",
                    "eventName",
                    "executionMode",
                    "handlerType",
                    "id",
                    "scope",
                    "source",
                    "sourcePath",
                    "startedAt",
                    "status",
                    "statusMessage",
                  ]),
                  entriesCount: readArray(run, "entries").length,
                },
              }),
        },
        ...(runId === null ? {} : { runId }),
      },
    ]);
  }

  async #onMcpToolProgress(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const itemId = readNonEmptyString(params, "itemId");
    const message = readString(params, "message");

    if (itemId === null || message === null) {
      return;
    }
    const publicToolCallId = this.#tools.publicToolCallId(itemId);

    if (publicToolCallId === null) {
      return;
    }
    const parentMessageId = this.#tools.parentMessage(itemId);
    await this.#push(context, "driver.openai.mcp_tool.progress", [
      {
        delivery: "best_effort",
        kind: "tool.call.updated",
        payload: {
          ...(parentMessageId === null ? {} : { messageId: parentMessageId }),
          ...toBoundedOpenAiTelemetry({ rawOutput: message }, ["rawOutput"]),
          status: "running",
          toolCallId: publicToolCallId,
        },
      },
    ]);
  }

  async #onTerminalInteraction(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const itemId = readNonEmptyString(params, "itemId");
    const processId = readNonEmptyString(params, "processId");
    const threadId = readNonEmptyString(params, "threadId");
    const turnId = readNonEmptyString(params, "turnId");

    if (itemId === null || processId === null || threadId === null || turnId === null) {
      return;
    }
    const publicItemId = this.#tools.publicToolCallId(itemId);

    if (publicItemId === null) {
      return;
    }

    await this.#push(context, "driver.openai.terminal.interaction", [
      {
        delivery: "best_effort",
        kind: "shell.command.updated",
        payload: {
          ...toBoundedOpenAiTelemetry({ processId }, ["processId"]),
          itemId: publicItemId,
          status: "running",
          threadId: toRuntimePublicId(threadId, "openai-thread"),
          turnId: this.publicTurnId(turnId),
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

  async #onWarning(
    context: AgentDriverContext,
    params: JsonObject,
    method: "guardianWarning" | "warning",
  ): Promise<void> {
    const message = readString(params, "message") ?? "OpenAi app-server warning.";
    const messageUtf8Bytes = Buffer.byteLength(message, "utf8");

    context.logger.warn("driver.openai.warning", {
      ...(messageUtf8Bytes <= MAX_OPENAI_TELEMETRY_FIELD_BYTES ? { message } : {}),
      messageUtf8Bytes,
      threadIdPresent: readString(params, "threadId") !== null,
    });

    await this.#push(context, `driver.openai.${method}`, toOpenAiUserFacingEvents(method, message));
  }

  async #onWorldWritableWarning(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const rawSamplePaths = Array.isArray(params["samplePaths"])
      ? params["samplePaths"].filter((path): path is string => typeof path === "string")
      : [];
    const samplePaths: string[] = [];
    let omittedSampleCount = 0;

    for (const path of rawSamplePaths) {
      if (
        samplePaths.length < MAX_WORLD_WRITABLE_SAMPLE_PATHS &&
        Buffer.byteLength(path, "utf8") <= MAX_OPENAI_TELEMETRY_FIELD_BYTES
      ) {
        samplePaths.push(path);
      } else {
        omittedSampleCount += 1;
      }
    }
    const rawExtraCount = params["extraCount"];
    const providerExtraCount =
      typeof rawExtraCount === "number" && Number.isSafeInteger(rawExtraCount) && rawExtraCount >= 0
        ? rawExtraCount
        : 0;
    const extraCount = Math.min(Number.MAX_SAFE_INTEGER, providerExtraCount + omittedSampleCount);
    const failedScan = params["failedScan"] === true;
    const content = [
      "Windows sandbox protection is incomplete because world-writable directories were found.",
      samplePaths.length === 0 ? null : `Affected paths:\n${samplePaths.join("\n")}`,
      extraCount === 0 ? null : `${String(extraCount)} additional affected paths were omitted.`,
      failedScan ? "The world-writable directory scan did not complete." : null,
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");

    context.logger.warn("driver.openai.windows.world_writable", {
      extraCount,
      failedScan,
      samplePaths,
    });
    await this.#push(context, "driver.openai.windows.world_writable", [
      {
        delivery: "lossless",
        kind: "message.added",
        payload: {
          content,
          extraCount,
          failedScan,
          level: "warning",
          messageId: createDriverId(),
          role: "agent",
          samplePaths,
          subtype: "windows_world_writable_warning",
        },
      },
    ]);
  }

  #onRuntimeError(context: AgentDriverContext, params: JsonObject): void {
    const error = readRecord(params, "error");
    const turnId = readString(params, "turnId");
    const willRetry = params["willRetry"] === true;

    context.logger.warn("driver.openai.error.awaiting_turn_completion", {
      ...toBoundedOpenAiTelemetry(error ?? params, ["additionalDetails", "message"]),
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

    const pendingTurn = this.#turns.pendingTurnContext(turnId);
    if (pendingTurn !== null && !this.#turns.hasTurnStarted(turnId)) {
      throw new Error("OpenAi turn/completed arrived before its turn/started notification.");
    }
    const runId = this.#turns.activeRunId(turnId) ?? pendingTurn?.runId;
    const cancellationSignal =
      this.#turns.cancellationSignal(turnId) ?? pendingTurn?.cancellationSignal ?? null;

    await this.publishRunStarted(context, { runId, turnId });
    await this.#itemEvents.onTurnItems(context, params, turnId);
    const authoritativeFinalMessage = await this.#itemEvents.resolveFinalMessage(
      context,
      params,
      turnId,
    );
    const authoritativeFinalSnapshot =
      authoritativeFinalMessage !== null && authoritativeFinalMessage.text.trim().length > 0
        ? authoritativeFinalMessage
        : null;
    if (!this.#turns.beginSettlement(turnId)) {
      return;
    }
    const publicTurnId = this.publicTurnId(turnId);

    try {
      if (status === "interrupted") {
        await this.#options.beforeInterruptedTurn?.(context, turnId);
        await this.#options.pushTerminal(
          context,
          "driver.openai.turn.interrupted",
          turnClosureEvents({
            eventName: "turn.interrupted",
            events: this.#itemEvents.terminalEvents({ kind: "cancelled" }),
            publicTurnId,
            runId,
          }),
          {
            ...turnEventFields({ eventName: "turn.interrupted", publicTurnId, runId }),
            kind: "run.cancelled",
            payload: {
              requestedBy: "provider",
              stopReason: "cancelled",
            },
          },
        );
        this.#finishSettlement(turnId, {
          error: new DriverTurnCancelledError("OpenAI turn was interrupted."),
          kind: "failed",
        });
        return;
      }

      if (status === "failed") {
        const error = toOpenAiProtocolError(readRecord(turn, "error"));
        await this.#options.pushTerminal(
          context,
          "driver.openai.turn.failed",
          turnClosureEvents({
            eventName: "turn.failed",
            events: this.#itemEvents.terminalEvents({ error, kind: "failed" }),
            publicTurnId,
            runId,
          }),
          {
            ...turnEventFields({
              eventName: "turn.failed",
              publicTurnId,
              runId,
            }),
            kind: "run.failed",
            payload: {
              error,
              recoverable: error.retryable,
            },
          },
        );
        this.#finishSettlement(turnId, {
          error: new Error(error.message),
          kind: "failed",
        });
        return;
      }

      // A fresh app-server thread may not have a rollout until its first successful
      // turn is materialized. Resume metadata must never turn that successful turn
      // into a failure.
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

      await this.#options.pushTerminal(
        context,
        "driver.openai.turn.completed",
        turnClosureEvents({
          eventName: "turn.completed",
          events: this.#itemEvents.terminalEvents({ kind: "completed" }),
          publicTurnId,
          runId,
        }),
        {
          ...turnEventFields({
            eventName: "turn.completed",
            publicTurnId,
            runId,
          }),
          kind: "run.completed",
          payload: {
            ...(authoritativeFinalSnapshot === null
              ? {}
              : { finalMessageId: authoritativeFinalSnapshot.id }),
            stopReason: "end_turn",
          },
        },
        cancellationSignal ?? undefined,
      );
      this.#finishSettlement(turnId, { kind: "completed" });
    } catch (pushError) {
      this.#turns.cancelSettlement(turnId);
      if (
        status === "completed" &&
        cancellationSignal?.aborted === true &&
        (pushError === cancellationSignal.reason ||
          (pushError instanceof DriverCompletedTerminalSupersededError &&
            pushError.cause === cancellationSignal.reason))
      ) {
        if (pushError instanceof DriverCompletedTerminalSupersededError) {
          this.#turns.markCompletionClosuresCommitted(turnId);
        }
        return;
      }
      throw pushError;
    }
  }

  async #onTurnDiff(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const turnId = readNonEmptyString(params, "turnId");
    const diff = readString(params, "diff");

    if (turnId === null || diff === null) {
      return;
    }
    const runId = this.#turns.activeRunId(turnId);

    if (runId === null) {
      return;
    }

    await this.#push(context, "driver.openai.turn.diff.updated", [
      {
        delivery: "best_effort",
        kind: "diagnostic.reported",
        payload: {
          details: {
            utf8Bytes: Buffer.byteLength(diff, "utf8"),
          },
          message: "OpenAI turn diff updated.",
          severity: "info",
          turnId: this.publicTurnId(turnId),
        },
        runId,
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

    const runId = this.#turns.activeRunId(turnId) ?? this.#turns.pendingTurnContext(turnId)?.runId;

    await this.publishRunStarted(context, { runId, turnId });
  }

  async #onUsage(context: AgentDriverContext, params: JsonObject): Promise<void> {
    const turnId = readNonEmptyString(params, "turnId");

    if (turnId === null) {
      return;
    }
    const runId = this.#turns.activeRunId(turnId);
    const update = this.#usage.prepareUpdate(runId === null ? null : turnId, params);

    if (runId === null || update.usage === null) {
      update.commit();
      return;
    }

    await this.#push(context, "driver.openai.usage.updated", [
      {
        kind: "usage.updated",
        payload: update.usage,
        runId,
      },
    ]);
    update.commit();
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
    this.#usage.release(turnId);
  }
}
