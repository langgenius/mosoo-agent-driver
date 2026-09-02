import type { ProtocolError } from "../../contract";
import { isRecord, readString } from "./app-server-json";
import type { JsonObject } from "./app-server-json";

const retryableCodexErrors = new Set<string>([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "internalServerError",
  "rateLimitExceeded",
  "responseStreamDisconnected",
]);
const MAX_OPENAI_ERROR_TEXT_BYTES = 16 * 1_024;

type OpenAiMisalignmentDetails = {
  readonly misalignmentDetailedExplanation?: string;
  readonly misalignmentDetailedExplanationUtf8Bytes?: number;
  readonly misalignmentErrorType?: string;
  readonly misalignmentErrorTypeUtf8Bytes?: number;
  readonly misalignmentSteerMessage?: string;
  readonly misalignmentSteerMessageUtf8Bytes?: number;
};

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

function toOpenAiMisalignmentDetails(error: JsonObject): OpenAiMisalignmentDetails | null {
  const misalignment = isRecord(error["misalignment"]) ? error["misalignment"] : null;
  if (misalignment === null) {
    return null;
  }

  const errorType = readString(misalignment, "errorType");
  const detailedExplanation = readString(misalignment, "detailedExplanation");
  const steer = isRecord(misalignment["steer"]) ? misalignment["steer"] : null;
  const steerMessage = readString(steer, "message");
  const boundedErrorType =
    errorType === null ? null : boundOpenAiErrorText(errorType, "OpenAI misalignment error type");
  const boundedExplanation =
    detailedExplanation === null
      ? null
      : boundOpenAiErrorText(detailedExplanation, "OpenAI misalignment explanation");
  const boundedSteerMessage =
    steerMessage === null
      ? null
      : boundOpenAiErrorText(steerMessage, "OpenAI misalignment steering message");
  const details: OpenAiMisalignmentDetails = {
    ...(boundedErrorType?.utf8Bytes === null
      ? { misalignmentErrorType: boundedErrorType.text }
      : {}),
    ...(boundedErrorType === null || boundedErrorType.utf8Bytes === null
      ? {}
      : { misalignmentErrorTypeUtf8Bytes: boundedErrorType.utf8Bytes }),
    ...(boundedExplanation?.utf8Bytes === null
      ? { misalignmentDetailedExplanation: boundedExplanation.text }
      : {}),
    ...(boundedExplanation === null || boundedExplanation.utf8Bytes === null
      ? {}
      : { misalignmentDetailedExplanationUtf8Bytes: boundedExplanation.utf8Bytes }),
    ...(boundedSteerMessage?.utf8Bytes === null
      ? { misalignmentSteerMessage: boundedSteerMessage.text }
      : {}),
    ...(boundedSteerMessage === null || boundedSteerMessage.utf8Bytes === null
      ? {}
      : { misalignmentSteerMessageUtf8Bytes: boundedSteerMessage.utf8Bytes }),
  };

  return Object.keys(details).length === 0 ? null : details;
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
  const misalignment = toOpenAiMisalignmentDetails(error);
  const details = {
    ...(additionalDetails === null ? {} : { additionalDetails: additionalDetails.text }),
    ...(additionalDetails?.utf8Bytes === null || additionalDetails === null
      ? {}
      : { additionalDetailsUtf8Bytes: additionalDetails.utf8Bytes }),
    ...classification,
    ...misalignment,
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
