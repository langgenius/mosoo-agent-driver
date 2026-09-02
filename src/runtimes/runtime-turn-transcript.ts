import { createHash } from "node:crypto";

import { createDriverIdFromBytes } from "../protocol/id";
import type { MessageId, SessionId } from "../protocol/id";

type RuntimeAssistantMessageNamespace =
  | "claude-assistant"
  | "claude-auxiliary"
  | "openai-message"
  | "openai-reasoning";

export function createRuntimeAssistantMessageId(
  sessionId: SessionId,
  namespace: RuntimeAssistantMessageNamespace,
  key: string,
): MessageId {
  const digest = createHash("sha256")
    .update(JSON.stringify(["mosoo.runtime-assistant-message-id/v1", sessionId, namespace, key]))
    .digest();
  return createDriverIdFromBytes(digest.subarray(0, 16)) as MessageId;
}
