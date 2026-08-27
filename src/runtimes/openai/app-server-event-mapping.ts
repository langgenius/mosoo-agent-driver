import type { ProtocolError } from "../../contract";
import { isRecord, readString } from "./app-server-json";
import type { JsonObject } from "./app-server-json";

const retryableCodexErrors = new Set<string>([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "internalServerError",
  "responseStreamDisconnected",
]);
const MAX_OPENAI_ERROR_TEXT_BYTES = 16 * 1_024;

function boundOpenAiErrorText(
  text: string,
  label: string,
): {
  readonly text: string;
  readonly utf8Bytes: number | null;
} {
  const utf8Bytes = Buffer.byteLength(text, "utf8");

  return utf8Bytes <= MAX_OPENAI_ERROR_TEXT_BYTES
    ? { text, utf8Bytes: null }
    : {
        text: `${label} was omitted because it contained ${String(utf8Bytes)} UTF-8 bytes.`,
        utf8Bytes,
      };
}

function readNonNegativeNumber(value: JsonObject | null, key: string): number | null {
  const entry = value?.[key];

  return typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 ? entry : null;
}

function toOpenAiErrorMessage(
  message: string,
  additionalDetails: string | null | undefined,
): string {
  const details = additionalDetails?.trim();

  if (!details || details === message) {
    return message;
  }

  return `${message}\n${details}`;
}

function classifyOpenAiError(info: unknown): {
  codexErrorInfo?: string;
  httpStatusCode?: number;
  retryable: boolean;
  turnKind?: string;
} {
  if (info == null) {
    return { retryable: false };
  }

  const [codexErrorInfo, metadata] =
    typeof info === "string"
      ? [info, null]
      : (Object.entries(isRecord(info) ? info : {})[0] ?? ["unknown", null]);
  const metadataRecord = isRecord(metadata) ? metadata : null;
  const httpStatusCode = readNonNegativeNumber(metadataRecord, "httpStatusCode");
  const turnKind = metadataRecord?.["turnKind"];

  return {
    codexErrorInfo,
    ...(httpStatusCode === null ? {} : { httpStatusCode }),
    retryable: retryableCodexErrors.has(codexErrorInfo),
    ...(typeof turnKind === "string" ? { turnKind } : {}),
  };
}

export function toOpenAiProtocolError(error: JsonObject | null): ProtocolError {
  if (error === null) {
    return {
      code: "openai.turn_failed",
      message: "OpenAI turn failed.",
      retryable: false,
    };
  }

  const rawMessage = readString(error, "message") ?? "OpenAI turn failed.";
  const rawAdditionalDetails = readString(error, "additionalDetails");
  const message = boundOpenAiErrorText(rawMessage, "OpenAI provider error message");
  const additionalDetails =
    rawAdditionalDetails === null
      ? null
      : boundOpenAiErrorText(rawAdditionalDetails, "OpenAI provider error details");
  const { retryable, ...classification } = classifyOpenAiError(error["codexErrorInfo"]);
  const details = {
    ...(additionalDetails === null ? {} : { additionalDetails: additionalDetails.text }),
    ...(additionalDetails?.utf8Bytes === null || additionalDetails === null
      ? {}
      : { additionalDetailsUtf8Bytes: additionalDetails.utf8Bytes }),
    ...classification,
    ...(message.utf8Bytes === null ? {} : { messageUtf8Bytes: message.utf8Bytes }),
  };

  return {
    code: "openai.turn_failed",
    ...(Object.keys(details).length === 0 ? {} : { details }),
    message: toOpenAiErrorMessage(message.text, additionalDetails?.text),
    retryable,
  };
}

export function toOpenAiSessionUsageSummary(input: {
  contextWindow: number | null;
  usage: JsonObject | null;
  used: number | null;
}) {
  const { usage } = input;

  return {
    cachedReadTokens: readNonNegativeNumber(usage, "cachedInputTokens"),
    cachedWriteTokens: readNonNegativeNumber(usage, "cacheWriteInputTokens"),
    costAmount: null,
    costCurrency: null,
    inputTokens: readNonNegativeNumber(usage, "inputTokens"),
    outputTokens: readNonNegativeNumber(usage, "outputTokens"),
    size: input.contextWindow,
    source: "session_update" as const,
    thoughtTokens: readNonNegativeNumber(usage, "reasoningOutputTokens"),
    totalTokens: readNonNegativeNumber(usage, "totalTokens"),
    usageContract: "openai_runtime_total_with_cached_breakdown" as const,
    used: input.used,
  };
}

export function toOpenAiPlanStatus(status: string | null): "pending" | "in_progress" | "completed" {
  if (status === "inProgress") {
    return "in_progress";
  }

  if (status === "completed") {
    return "completed";
  }

  return "pending";
}
