import type { DriverStartInput } from "../../protocol/start";

const MAX_CLAUDE_NATIVE_SESSION_ID_BYTES = 256;

export function requireClaudeNativeSessionId(sessionId: string): string {
  const bytes = Buffer.byteLength(sessionId, "utf8");

  if (sessionId.trim().length === 0 || bytes > MAX_CLAUDE_NATIVE_SESSION_ID_BYTES) {
    throw new RangeError(
      `Claude native session ID must contain 1-${String(MAX_CLAUDE_NATIVE_SESSION_ID_BYTES)} UTF-8 bytes (received ${String(bytes)}).`,
    );
  }

  return sessionId;
}

export function readClaudeNativeResumeSessionId(payload: DriverStartInput): string | null {
  const { nativeResumeRef } = payload.execution.session;

  if (!nativeResumeRef) {
    return null;
  }

  if (
    nativeResumeRef.runtimeId !== "claude-agent-sdk" ||
    nativeResumeRef.kind !== "claude_session_id"
  ) {
    throw new Error("Claude runtime received an incompatible native resume ref.");
  }

  return requireClaudeNativeSessionId(nativeResumeRef.value);
}
