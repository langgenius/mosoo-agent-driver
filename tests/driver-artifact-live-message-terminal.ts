export const CANONICAL_MESSAGE_TERMINAL_KINDS = [
  "message.cancelled",
  "message.completed",
  "message.failed",
] as const;

export type CanonicalMessageTerminalKind = (typeof CANONICAL_MESSAGE_TERMINAL_KINDS)[number];

export const CANONICAL_THOUGHT_TERMINAL_KINDS = ["thought.cancelled", "thought.completed"] as const;

export type CanonicalThoughtTerminalKind = (typeof CANONICAL_THOUGHT_TERMINAL_KINDS)[number];

export function isCanonicalMessageTerminalKind(
  value: unknown,
): value is CanonicalMessageTerminalKind {
  return (
    typeof value === "string" &&
    (CANONICAL_MESSAGE_TERMINAL_KINDS as readonly string[]).includes(value)
  );
}

export function isCanonicalThoughtTerminalKind(
  value: unknown,
): value is CanonicalThoughtTerminalKind {
  return (
    typeof value === "string" &&
    (CANONICAL_THOUGHT_TERMINAL_KINDS as readonly string[]).includes(value)
  );
}
