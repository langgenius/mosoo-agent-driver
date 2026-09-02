import { createHash } from "node:crypto";

const MAX_PUBLIC_NATIVE_ID_BYTES = 256;
const HASHED_PUBLIC_ID_PATTERN = /^rid1_[A-Za-z0-9_-]{43}$/u;
const HASH_DOMAIN = "mosoo.runtime-public-id/v1";
const SOURCE_EVENT_HASH_DOMAIN = "mosoo.runtime-source-event-id/v1";

type RuntimePublicIdNamespace =
  | "claude-agent"
  | "claude-task"
  | "claude-tool"
  | "openai-item"
  | "openai-thread"
  | "openai-turn";

export function toRuntimePublicId(nativeId: string, namespace: RuntimePublicIdNamespace): string {
  if (
    Buffer.byteLength(nativeId, "utf8") <= MAX_PUBLIC_NATIVE_ID_BYTES &&
    !HASHED_PUBLIC_ID_PATTERN.test(nativeId)
  ) {
    return nativeId;
  }

  const digest = createHash("sha256")
    .update(JSON.stringify([HASH_DOMAIN, namespace, nativeId]))
    .digest("base64url");
  return `rid1_${digest}`;
}

export function createRuntimeSourceEventId(
  scope: string,
  ...identity: readonly (number | string)[]
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([SOURCE_EVENT_HASH_DOMAIN, scope, ...identity]))
    .digest("base64url");
  return `${scope}:sid1_${digest}`;
}
