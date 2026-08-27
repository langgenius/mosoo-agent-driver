import type { InitializeResponse } from "@agentclientprotocol/sdk";

import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import {
  ACP_USAGE_CONTRACT,
  assertBoundedLosslessEvents,
  isRecord,
  readNumber,
  readRecord,
  readString,
} from "./acp-types";
import type { JsonObject } from "./acp-types";
import { toConfigEvents, toModeEvents } from "./acp-session-update-events";

export function toInitializeEvents(result: InitializeResponse): DriverEventInput[] {
  const events: DriverEventInput[] = [
    {
      delivery: "best_effort",
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
      delivery: "best_effort",
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
  return assertBoundedLosslessEvents([
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
  ]);
}

export function toSessionReadyEvents(input: {
  mode: "created" | "loaded" | "resumed";
  nativeSessionId: string;
  setup: JsonObject;
}): DriverEventInput[] {
  return assertBoundedLosslessEvents([
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
    ...toModeEvents(readRecord(input.setup, "modes")),
    ...toConfigEvents(input.setup),
  ]);
}

export function toAuthEvent(input: {
  methodId: string;
  status: "authenticated" | "failed";
}): DriverEventInput {
  return assertBoundedLosslessEvents([
    {
      kind: "auth.session.updated",
      payload: {
        methodId: input.methodId,
        status: input.status,
      },
      visibility: "owner_debug",
    },
  ])[0]!;
}

export function isTurnScopedSessionUpdate(params: unknown): boolean {
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

  const totalTokens = readTokenCount(raw, "totalTokens", "total_tokens");
  const inputTokens = readTokenCount(raw, "inputTokens", "input_tokens");
  const outputTokens = readTokenCount(raw, "outputTokens", "output_tokens");
  const cachedReadTokens = readTokenCount(raw, "cachedReadTokens", "cached_read_tokens");
  const cachedWriteTokens = readTokenCount(raw, "cachedWriteTokens", "cached_write_tokens");
  const thoughtTokens = readTokenCount(raw, "thoughtTokens", "thought_tokens");

  if (
    totalTokens === null &&
    inputTokens === null &&
    outputTokens === null &&
    cachedReadTokens === null &&
    cachedWriteTokens === null
  ) {
    return null;
  }

  // Prompt usage is emitted in the same lossless batch as every open-item
  // closure. Keep only the bounded canonical counters; ACP extension metadata
  // is arbitrary JSON and cannot safely participate in that atomic batch.
  return {
    ...(cachedReadTokens === null ? {} : { cachedReadTokens }),
    ...(cachedWriteTokens === null ? {} : { cachedWriteTokens }),
    ...(inputTokens === null ? {} : { inputTokens }),
    ...(outputTokens === null ? {} : { outputTokens }),
    source: "prompt_response",
    ...(thoughtTokens === null ? {} : { thoughtTokens }),
    ...(totalTokens === null ? {} : { totalTokens }),
    usageContract: ACP_USAGE_CONTRACT,
  };
}

function readTokenCount(raw: JsonObject, key: string, snakeCaseKey: string): number | null {
  const value = readNumber(raw, key) ?? readNumber(raw, snakeCaseKey);

  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
