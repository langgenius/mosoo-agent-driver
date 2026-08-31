import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { toRuntimePublicId } from "../runtime-public-id";
import { isRecord, readString } from "./agent-sdk-json";
import type { JsonObject } from "./agent-sdk-json";

const CANCELLED_TOOL_OUTCOMES = new Set(["cancelled", "interrupted"]);
const NON_EXECUTION_KINDS = new Set([
  "automode-blocked",
  "automode-parsing-error",
  "automode-unavailable",
  "cancelled",
  "interrupted",
  "permission-rule",
  "user-rejected",
]);
const RETRYABLE_ASSISTANT_ERRORS = new Set(["overloaded", "rate_limit", "server_error"]);

export type ClaudeAssistantOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "completed" }
  | {
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly status: "failed";
    };

export interface ClaudePermissionDenial {
  readonly input: JsonObject;
  readonly message: string;
  readonly name: string;
  readonly toolCallId: string;
}

export interface ClaudePermissionDenialAdvisory {
  readonly agentId?: string;
  readonly decisionReason?: string;
  readonly decisionReasonType?: string;
  readonly message: string;
  readonly toolCallId: string;
}

export interface ClaudeToolOutcome {
  readonly nonExecutionKind?: string;
  readonly status: "cancelled" | "completed" | "failed";
  readonly userFeedback?: string;
}

export function claudeAssistantOutcome(
  message: Extract<SDKMessage, { type: "assistant" }>,
): ClaudeAssistantOutcome {
  if (message.aborted === true) {
    return { status: "cancelled" };
  }

  if (message.error === undefined) {
    return { status: "completed" };
  }

  return {
    code: message.error,
    message: `Assistant message failed: ${message.error}.`,
    retryable: RETRYABLE_ASSISTANT_ERRORS.has(message.error),
    status: "failed",
  };
}

export function claudePermissionDenials(
  message: Extract<SDKMessage, { type: "result" }>,
): ClaudePermissionDenial[] {
  const denials = Array.isArray(message.permission_denials) ? message.permission_denials : [];

  return denials.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const name = readString(entry, "tool_name");
    const toolCallId = readString(entry, "tool_use_id");
    const input = entry["tool_input"];

    if (name === null || toolCallId === null || !isRecord(input)) {
      return [];
    }

    return [
      {
        input,
        message: `Permission denied for ${name}; the tool was not executed.`,
        name,
        toolCallId,
      },
    ];
  });
}

export function claudePermissionDenialAdvisory(
  message: Extract<SDKMessage, { type: "system" }>,
): ClaudePermissionDenialAdvisory | null {
  if (message.subtype !== "permission_denied") {
    return null;
  }

  return {
    ...(message.agent_id === undefined
      ? {}
      : { agentId: toRuntimePublicId(message.agent_id, "claude-agent") }),
    ...(message.decision_reason === undefined ? {} : { decisionReason: message.decision_reason }),
    ...(message.decision_reason_type === undefined
      ? {}
      : { decisionReasonType: message.decision_reason_type }),
    message: message.message,
    toolCallId: message.tool_use_id,
  };
}

export function claudeResultErrorDetails(
  message: Extract<SDKMessage, { type: "result" }>,
): Record<string, null | number | string> | undefined {
  const apiErrorStatus = message.subtype === "success" ? message.api_error_status : undefined;

  if (apiErrorStatus === undefined && message.terminal_reason === undefined) {
    return undefined;
  }

  return {
    ...(apiErrorStatus === undefined ? {} : { apiErrorStatus }),
    ...(message.terminal_reason === undefined ? {} : { terminalReason: message.terminal_reason }),
  };
}

export function isClaudeResultRetryable(message: Extract<SDKMessage, { type: "result" }>): boolean {
  const apiErrorStatus = message.subtype === "success" ? message.api_error_status : undefined;

  if (apiErrorStatus !== null && apiErrorStatus !== undefined) {
    return (
      apiErrorStatus === 408 ||
      apiErrorStatus === 409 ||
      apiErrorStatus === 429 ||
      apiErrorStatus >= 500
    );
  }

  return (
    message.terminal_reason === "api_error" ||
    message.terminal_reason === "model_error" ||
    message.terminal_reason === "blocking_limit" ||
    message.terminal_reason === "rapid_refill_breaker"
  );
}

export function isClaudeResultSuccessful(
  message: Extract<SDKMessage, { type: "result" }>,
): boolean {
  return message.subtype === "success" && !message.is_error;
}

export function claudeToolOutcome(
  message: Extract<SDKMessage, { type: "user" }>,
  block: JsonObject,
): ClaudeToolOutcome {
  const toolCallId = readString(block, "tool_use_id");
  const rawMetadata = (message as unknown as JsonObject)["tool_result_meta"];
  const metadata: unknown[] = Array.isArray(rawMetadata) ? rawMetadata : [];
  const match = metadata.find((entry) => isRecord(entry) && readString(entry, "id") === toolCallId);
  const metadataEntry = isRecord(match) ? match : null;
  const nonExecutionKind = readString(metadataEntry, "non_execution_kind");

  if (nonExecutionKind !== null && NON_EXECUTION_KINDS.has(nonExecutionKind)) {
    const userFeedback = readString(metadataEntry, "user_feedback");
    return {
      nonExecutionKind,
      status: CANCELLED_TOOL_OUTCOMES.has(nonExecutionKind) ? "cancelled" : "failed",
      ...(userFeedback === null ? {} : { userFeedback }),
    };
  }

  return { status: block["is_error"] === true ? "failed" : "completed" };
}

export function isClaudeResultCancelled(message: Extract<SDKMessage, { type: "result" }>): boolean {
  return (
    message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools"
  );
}
