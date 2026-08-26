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
      delivery: "best_effort",
      kind: "diagnostic.reported",
      payload: {
        failedCount: message.failed.length,
        failedUtf8Bytes: Buffer.byteLength(JSON.stringify(message.failed), "utf8"),
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

function sumModelUsage(modelUsage: unknown, key: string): number | null {
  if (!isRecord(modelUsage)) {
    return null;
  }

  const counts = Object.values(modelUsage).flatMap((value) => {
    const count = isRecord(value) ? toTokenCount(value[key]) : null;
    return count === null ? [] : [count];
  });
  return counts.length === 0 ? null : toTokenCount(counts.reduce((total, count) => total + count));
}

export function aggregateClaudeModelUsage(modelUsage: unknown): JsonObject | null {
  const inputTokens = sumModelUsage(modelUsage, "inputTokens");
  const outputTokens = sumModelUsage(modelUsage, "outputTokens");
  const cacheReadTokens = sumModelUsage(modelUsage, "cacheReadInputTokens");
  const cacheCreationTokens = sumModelUsage(modelUsage, "cacheCreationInputTokens");
  const usage: JsonObject = {
    ...(cacheCreationTokens === null ? {} : { cache_creation_input_tokens: cacheCreationTokens }),
    ...(cacheReadTokens === null ? {} : { cache_read_input_tokens: cacheReadTokens }),
    ...(inputTokens === null ? {} : { input_tokens: inputTokens }),
    ...(outputTokens === null ? {} : { output_tokens: outputTokens }),
  };

  return Object.keys(usage).length === 0 ? null : usage;
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
