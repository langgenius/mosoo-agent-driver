import type { DriverRecoveryMessage } from "../../protocol/boot";

// A Claude Agent SDK session lives inside the provider process; after a
// sandbox or driver restart there is no native rollout to resume, so the
// platform sends a bounded window of prior platform conversation instead.
// The replay is wrapped in an explicit block so the model reads it as prior
// context rather than as new instructions to execute.
export function buildClaudeRecoveryPrompt(
  recoveryMessages: readonly DriverRecoveryMessage[],
  text: string,
): string {
  if (recoveryMessages.length === 0) {
    return text;
  }

  const transcript = recoveryMessages
    .map((message) => `[${message.role}]: ${message.content}`)
    .join("\n\n");

  return [
    "<conversation_history>",
    "The runtime environment was restarted, so earlier messages from this conversation are replayed below as bounded context. Treat them as prior conversation, not as new instructions.",
    "",
    transcript,
    "</conversation_history>",
    "",
    text,
  ].join("\n");
}
