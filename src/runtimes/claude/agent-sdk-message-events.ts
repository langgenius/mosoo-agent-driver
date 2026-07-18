import type { SDKFilesPersistedEvent, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { DriverEventInput } from "../../protocol/events";
import { isRecord, readString, sumTokenCounts, toCostAmount, toTokenCount } from "./agent-sdk-json";
import type { JsonObject } from "./agent-sdk-json";

export function toClaudeFilesPersistedEvents(message: SDKFilesPersistedEvent): DriverEventInput[] {
  const events: DriverEventInput[] = message.files.map((file) => ({
    actor: "tool",
    kind: "file.change.updated",
    origin: "file",
    payload: {
      changes: [
        {
          change: "upsert",
          path: file.filename,
        },
      ],
      status: "completed",
    },
  }));

  if (message.failed.length > 0) {
    events.push({
      kind: "diagnostic.reported",
      payload: {
        failed: message.failed,
        message: "Claude file persistence failed.",
        severity: "warn",
      },
      visibility: "owner_debug",
    });
  }

  return events;
}

export function toClaudeDiagnosticEvent(message: SDKMessage): JsonObject {
  const record = isRecord(message) ? message : {};

  return {
    kind: "claude.diagnostic",
    sessionIdPresent: Boolean(readString(record, "session_id")),
    subtype: readString(record, "subtype"),
    type: readString(record, "type"),
  };
}

export function toClaudeUsageUpdatedEvents(
  usage: JsonObject | null,
  costAmount: number | null,
): DriverEventInput[] {
  const inputTokens = toTokenCount(usage?.["input_tokens"]);
  const outputTokens = toTokenCount(usage?.["output_tokens"]);
  const cacheReadTokens = toTokenCount(usage?.["cache_read_input_tokens"]);
  const cacheCreationTokens = toTokenCount(usage?.["cache_creation_input_tokens"]);
  const totalTokens = sumTokenCounts(inputTokens, outputTokens);
  const cost = toCostAmount(costAmount);

  if (
    inputTokens === null &&
    outputTokens === null &&
    cacheReadTokens === null &&
    cacheCreationTokens === null &&
    cost === null
  ) {
    return [];
  }

  return [
    {
      kind: "usage.updated",
      payload: {
        cachedReadTokens: cacheReadTokens,
        cachedWriteTokens: cacheCreationTokens,
        costAmount: cost,
        costCurrency: cost === null ? null : "USD",
        inputTokens,
        outputTokens,
        size: null,
        source: "session_update",
        thoughtTokens: null,
        totalTokens,
        usageContract: "anthropic_bucketed",
        used: null,
      },
    },
  ];
}
