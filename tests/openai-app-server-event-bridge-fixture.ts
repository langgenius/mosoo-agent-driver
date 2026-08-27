import { expect } from "bun:test";

import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createDisabledLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import { OpenAiAppServerEventBridge } from "../src/runtimes/openai/app-server-event-bridge";
import { DRIVER_TEST_IDS, driverStartInput as bootPayload } from "./driver-boot-payload-fixture";

interface EventBatch {
  events: DriverEventInput[];
  reason: string;
}

export function readEventPayloadString(event: DriverEventInput, field: string): string | null {
  const payload = event.payload;

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

export function readAssistantMessageId(events: readonly DriverEventInput[]): string {
  for (const event of events) {
    const messageId =
      readEventPayloadString(event, "messageId") ??
      readEventPayloadString(event, "parentMessageId");

    if (messageId !== null) {
      expect(isDriverId(messageId)).toBe(true);
      return messageId;
    }
  }

  throw new Error("Expected a platform assistant message ID.");
}

export function createOpenAiBridgeHarness(
  options: {
    failNativeResumePublish?: boolean;
    failReasonOnce?: string;
    failTerminalOnce?: boolean;
    holdFailedTerminalOnce?: boolean;
    holdReason?: string;
  } = {},
) {
  const batches: EventBatch[] = [];
  const attempts: EventBatch[] = [];
  const terminalAttempts: Array<{
    closures: readonly DriverEventInput[];
    terminal: DriverEventInput;
  }> = [];
  let failedReason = false;
  let failedTerminal = false;
  const heldPush = Promise.withResolvers<void>();
  const releasePush = Promise.withResolvers<void>();
  const terminalHeld = Promise.withResolvers<void>();
  const releaseTerminal = Promise.withResolvers<void>();
  const context: AgentDriverContext = createAgentDriverContext({
    eventSink: {
      currentRunId: () => DRIVER_TEST_IDS.runId,
      pushEvents: async () => ({ accepted: [] }),
    },
    logger: createDisabledLogger(),
    payload: bootPayload,
    permission: {
      request: async () => "allow_once",
    },
  });
  const push = async (_context: AgentDriverContext, reason: string, events: DriverEventInput[]) => {
    attempts.push({ events, reason });
    if (!failedReason && reason === options.failReasonOnce) {
      failedReason = true;
      throw new Error("event sink rejected the first attempt");
    }
    batches.push({ events, reason });
    if (reason === options.holdReason) {
      heldPush.resolve();
      await releasePush.promise;
    }
    if (
      options.failNativeResumePublish === true &&
      reason === "driver.openai.native_resume_ref.updated"
    ) {
      throw new Error("event sink unavailable");
    }
  };
  const bridge = new OpenAiAppServerEventBridge({
    push,
    pushSession: push,
    pushTerminal: async (pushContext, reason, closures, terminal) => {
      terminalAttempts.push({ closures, terminal });
      if (!failedTerminal && options.failTerminalOnce === true) {
        failedTerminal = true;
        if (options.holdFailedTerminalOnce === true) {
          terminalHeld.resolve();
          await releaseTerminal.promise;
        }
        throw new Error("terminal sink rejected the first attempt");
      }
      for (const closure of closures) {
        await push(pushContext, `${reason}.items`, [closure]);
      }
      await push(pushContext, reason, [terminal]);
    },
    requireThreadId: () => "thread-1",
  });

  return {
    attempts,
    batches,
    bridge,
    context,
    events: () => batches.flatMap((batch) => batch.events),
    heldPush: heldPush.promise,
    releasePush: releasePush.resolve,
    releaseTerminal: releaseTerminal.resolve,
    terminalHeld: terminalHeld.promise,
    terminalAttempts,
  };
}
