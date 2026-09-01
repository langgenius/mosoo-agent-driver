import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createDisabledLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import { ClaudeAgentSdkMessageTranslator } from "../src/runtimes/claude/agent-sdk-message-translator";
import { driverStartInput as bootPayload } from "./driver-boot-payload-fixture";

export { isRecord } from "../src/runtimes/claude/agent-sdk-json";
export { messageText } from "./driver-event-test-helpers";

export function createClaudeAgentSdkHarness(
  publicToolCallId: (nativeToolCallId: string) => string = (id) => id,
) {
  const driverEvents: DriverEventInput[] = [];
  const nativeSessionIds: string[] = [];
  const nativeSessionResets: Array<readonly [string, string]> = [];
  const context: AgentDriverContext = createAgentDriverContext({
    eventSink: {
      currentRunId: () => "run-1" as RunId,
      pushEvents: async () => ({ accepted: [] }),
    },
    logger: createDisabledLogger(),
    payload: bootPayload,
    permission: { request: async () => "allow_once" },
  });
  const translator = new ClaudeAgentSdkMessageTranslator({
    publicToolCallId,
    push: async (_context, _reason, events) => {
      driverEvents.push(...events);
    },
    pushTerminal: async (_context, _reason, closures, terminal) => {
      driverEvents.push(...closures, terminal);
    },
    recordNativeSessionId: async (_context, sessionId) => {
      nativeSessionIds.push(sessionId);
    },
    replaceNativeSessionId: async (_context, previousSessionId, nextSessionId) => {
      nativeSessionResets.push([previousSessionId, nextSessionId]);
    },
    sessionId: context.payload.execution.run.sessionId,
  });
  const handleMessages = async (
    messages: readonly SDKMessage[],
    runId: RunId = "run-1" as RunId,
  ): Promise<void> => {
    for (const message of messages) {
      await translator.handleSdkMessage(context, message, runId);
    }
  };

  return {
    context,
    events: () => driverEvents,
    handleMessages,
    nativeSessionIds,
    nativeSessionResets,
    translator,
  };
}
