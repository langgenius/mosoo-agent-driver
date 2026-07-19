import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ContentBlock, TokenUsage, ToolItem } from "../../contract";
import { asJsonValue } from "../contract-adapter-meta";
import {
  isRecord,
  readRecord,
  readString,
  sumTokenCounts,
  toCostAmount,
  toTokenCount,
} from "./agent-sdk-json";

export function toContentBlocks(value: unknown): ContentBlock[] {
  const values = Array.isArray(value) ? value : [value];

  return values.flatMap<ContentBlock>((entry) => {
    if (typeof entry === "string") {
      return entry.length === 0 ? [] : [{ text: entry, type: "text" }];
    }

    if (!isRecord(entry)) {
      const json = asJsonValue(entry);
      return json === undefined ? [] : [{ type: "json", value: json }];
    }

    if (entry["type"] === "text") {
      const text = readString(entry, "text");
      return text === null ? [] : [{ text, type: "text" }];
    }

    const source = readRecord(entry, "source");

    if (entry["type"] === "image" && source?.["type"] === "base64") {
      const data = readString(source, "data");
      const mediaType = readString(source, "media_type");
      return data === null || mediaType === null ? [] : [{ data, mediaType, type: "inline_blob" }];
    }

    if (entry["type"] === "image" && source?.["type"] === "url") {
      const uri = readString(source, "url");
      return uri !== null && URL.canParse(uri) ? [{ type: "resource_link", uri }] : [];
    }

    const json = asJsonValue(entry);
    return json === undefined ? [] : [{ type: "json", value: json }];
  });
}

export function toolCategory(name: string): ToolItem["category"] {
  const normalized = name.toLowerCase();

  if (normalized === "read") {
    return "read";
  }

  if (["edit", "multiedit", "notebookedit", "write"].includes(normalized)) {
    return "edit";
  }

  if (["glob", "grep"].includes(normalized)) {
    return "search";
  }

  if (normalized === "bash") {
    return "execute";
  }

  if (["webfetch", "websearch"].includes(normalized)) {
    return "fetch";
  }

  if (["agent", "task", "sendmessage"].includes(normalized)) {
    return "agent";
  }

  return "other";
}

export function toUsage(message: Extract<SDKMessage, { type: "result" }>): TokenUsage | undefined {
  const raw = isRecord(message.usage) ? message.usage : null;
  const cachedInput = toTokenCount(raw?.["cache_read_input_tokens"]);
  const input = toTokenCount(raw?.["input_tokens"]);
  const output = toTokenCount(raw?.["output_tokens"]);
  const total = sumTokenCounts(input, output);
  const cost = toCostAmount(message.total_cost_usd);
  const usage = {
    ...(cachedInput === null ? {} : { cachedInput }),
    ...(cost === null ? {} : { cost: { amount: cost, currency: "USD" } }),
    ...(input === null ? {} : { input }),
    ...(output === null ? {} : { output }),
    ...(total === null ? {} : { total }),
  } satisfies TokenUsage;

  return Object.keys(usage).length === 0 ? undefined : usage;
}

export function isLimit(message: Extract<SDKMessage, { type: "result" }>): boolean {
  return (
    message.subtype === "error_max_turns" ||
    message.subtype === "error_max_budget_usd" ||
    message.subtype === "error_max_structured_output_retries" ||
    message.stop_reason === "max_tokens" ||
    message.terminal_reason === "max_turns" ||
    message.terminal_reason === "budget_exhausted" ||
    message.terminal_reason === "structured_output_retry_exhausted"
  );
}

export function finishReason(
  message: Extract<SDKMessage, { type: "result" }>,
): "limit" | "other" | "refusal" | "success" {
  if (message.stop_reason === "refusal") {
    return "refusal";
  }

  if (isLimit(message)) {
    return "limit";
  }

  return message.terminal_reason === "background_requested" ||
    message.terminal_reason === "tool_deferred" ||
    message.terminal_reason === "tool_deferred_unavailable"
    ? "other"
    : "success";
}

export function isRetryable(
  message: Exclude<Extract<SDKMessage, { type: "result" }>, { subtype: "success" }>,
): boolean {
  return (
    message.terminal_reason === "api_error" ||
    message.terminal_reason === "model_error" ||
    message.terminal_reason === "blocking_limit" ||
    message.terminal_reason === "rapid_refill_breaker"
  );
}
