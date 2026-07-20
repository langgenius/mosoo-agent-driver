import type { InitializeResponse } from "@agentclientprotocol/sdk";

import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import { isRecord, readNumber, readRecord, readString } from "./acp-types";
import type { JsonObject } from "./acp-types";
import {
  toCapabilityEvents,
  toConfigEvents,
  toModeEvents,
  toModelEvents,
} from "./acp-session-update-events";

const ACP_USAGE_CONTRACT = "openai_total_with_cached_breakdown";

export function toInitializeEvents(result: InitializeResponse): DriverEventInput[] {
  const events: DriverEventInput[] = [
    {
      kind: "runtime.capabilities.updated",
      payload: {
        capabilities: result.agentCapabilities ?? {},
        protocolVersion: result.protocolVersion,
      },
      visibility: "owner_debug",
    },
  ];

  if (result.authMethods !== undefined && result.authMethods.length > 0) {
    events.push({
      kind: "auth.methods.updated",
      payload: {
        methods: result.authMethods,
      },
      visibility: "owner_debug",
    });
  }

  return events;
}

export function toPromptStartEvents(input: {
  messageId: string;
  runId: RunId;
  text: string;
}): DriverEventInput[] {
  return [
    {
      actor: "user",
      kind: "message.added",
      origin: "viewer",
      payload: {
        content: [
          {
            text: input.text,
            type: "text",
          },
        ],
        messageId: input.messageId,
        role: "user",
      },
      runId: input.runId,
    },
    {
      actor: "api",
      kind: "run.dispatched",
      origin: "api",
      payload: {
        inputSummary: input.text.slice(0, 240),
        userMessageId: input.messageId,
      },
      runId: input.runId,
    },
    {
      kind: "run.started",
      payload: {
        inputItemIds: [input.messageId],
        startedAt: new Date().toISOString(),
      },
      runId: input.runId,
    },
  ];
}

export function toSessionReadyEvents(input: {
  mode: "created" | "loaded" | "resumed";
  nativeSessionId: string;
  setup: JsonObject;
}): DriverEventInput[] {
  return [
    {
      kind: input.mode === "created" ? "session.created" : "session.resumed",
      payload:
        input.mode === "created"
          ? {
              mode: "acp",
              topology: "stdio",
            }
          : {
              reason: input.mode,
              resumePointer: input.nativeSessionId,
            },
    },
    {
      kind: "runtime.resume.updated",
      payload: {
        resumePointer: input.nativeSessionId,
      },
      visibility: "owner_debug",
    },
    ...toModeEvents(input.setup),
    ...toModelEvents(input.setup),
    ...toConfigEvents(input.setup),
    ...toCapabilityEvents(input.setup),
  ];
}

export function toAuthEvent(input: {
  methodId: string;
  status: "authenticated" | "failed";
}): DriverEventInput {
  return {
    kind: "auth.session.updated",
    payload: {
      methodId: input.methodId,
      status: input.status,
    },
    visibility: "owner_debug",
  };
}

export function shouldIgnoreReplay(params: unknown): boolean {
  const record = isRecord(params) ? params : {};
  const update = readRecord(record, "update");

  switch (readString(update, "sessionUpdate")) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "plan":
    case "tool_call":
    case "tool_call_update":
    case "user_message_chunk": {
      return true;
    }
    default: {
      return false;
    }
  }
}

export function normalizePromptUsage(raw: unknown): JsonObject | null {
  if (!isRecord(raw)) {
    return null;
  }

  const rawTotal = readNumber(raw, "totalTokens") ?? readNumber(raw, "total_tokens");
  const rawInput = readNumber(raw, "inputTokens") ?? readNumber(raw, "input_tokens");
  const rawOutput = readNumber(raw, "outputTokens") ?? readNumber(raw, "output_tokens");
  const totalTokens =
    rawTotal !== null && Number.isSafeInteger(rawTotal) && rawTotal >= 0 ? rawTotal : null;
  const inputTokens =
    rawInput !== null && Number.isSafeInteger(rawInput) && rawInput >= 0 ? rawInput : null;
  const outputTokens =
    rawOutput !== null && Number.isSafeInteger(rawOutput) && rawOutput >= 0 ? rawOutput : null;

  if (totalTokens === null && inputTokens === null && outputTokens === null) {
    return null;
  }

  return {
    ...(inputTokens === null ? {} : { inputTokens }),
    ...(outputTokens === null ? {} : { outputTokens }),
    raw,
    source: "prompt_response",
    ...(totalTokens === null ? {} : { totalTokens }),
    usageContract: ACP_USAGE_CONTRACT,
  };
}
