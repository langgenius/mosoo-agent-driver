import { RequestError } from "@agentclientprotocol/sdk";

export interface AcpPromptError {
  readonly code: string;
  readonly details?: Record<string, string | number | boolean | null>;
  readonly message: string;
  readonly recoverable?: boolean;
}

export function toAcpPromptError(error: unknown): AcpPromptError {
  const message = error instanceof Error ? error.message : "ACP driver backend turn failed.";

  // OpenCode forwards this provider rejection as an ACP internal error. Match
  // only the observed rejection, never arbitrary mentions of blocked content
  // in local exceptions, tool output, or an assistant's response.
  if (
    error instanceof RequestError &&
    /^(?:Internal error: )?The content you provided or machine outputted is blocked\.$/.test(
      message,
    )
  ) {
    return {
      code: "acp.content_blocked",
      details: { acpErrorCode: error.code, category: "content_policy", stage: "unknown" },
      message:
        "The model provider blocked this turn under its content policy. It did not identify whether the input or output was blocked. This run will not be retried automatically.",
      recoverable: false,
    };
  }

  return { code: "acp.turn_failed", message };
}
