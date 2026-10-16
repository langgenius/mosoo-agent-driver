export const OPENAI_RUNTIME_NOTICE_SUBTYPES = [
  "warning",
  "guardian_warning",
  "model_provider_auth_recovery_started",
  "model_provider_auth_recovery_completed",
  "strict_review_required",
  "windows_world_writable_warning",
] as const;

interface RuntimeNoticeEvent {
  readonly actor?: string | undefined;
  readonly kind: string;
  readonly origin?: string | undefined;
  readonly payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenAiRuntimeNotice(event: RuntimeNoticeEvent): boolean {
  if (event.kind !== "message.added" || event.actor !== "driver" || event.origin !== "driver") {
    return false;
  }

  if (!isRecord(event.payload) || event.payload["role"] !== "agent") {
    return false;
  }

  const subtype = event.payload["subtype"];
  return (
    typeof subtype === "string" &&
    (OPENAI_RUNTIME_NOTICE_SUBTYPES as readonly string[]).includes(subtype)
  );
}
