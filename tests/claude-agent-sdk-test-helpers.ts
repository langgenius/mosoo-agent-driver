import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createDisabledLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import { ClaudeAgentSdkMessageTranslator } from "../src/runtimes/claude/agent-sdk-message-translator";
import { isRecord } from "../src/runtimes/claude/agent-sdk-json";
import { driverStartInput as bootPayload } from "./driver-boot-payload-fixture";

export { isRecord } from "../src/runtimes/claude/agent-sdk-json";

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

  return {
    context,
    events: () => driverEvents,
    nativeSessionIds,
    nativeSessionResets,
    translator,
  };
}

export function messageText(events: readonly DriverEventInput[], messageId: unknown): string {
  let text = "";

  for (const event of events) {
    if (!isRecord(event.payload) || event.payload["messageId"] !== messageId) {
      continue;
    }

    if (event.kind === "message.added") {
      const content = event.payload["content"];
      text = Array.isArray(content)
        ? content
            .flatMap((block) =>
              isRecord(block) && typeof block["text"] === "string" ? [block["text"]] : [],
            )
            .join("")
        : typeof content === "string"
          ? content
          : "";
    } else if (
      event.kind === "message.delta" &&
      typeof event.payload["contentDelta"] === "string"
    ) {
      text += event.payload["contentDelta"];
    }
  }

  return text;
}
