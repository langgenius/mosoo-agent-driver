import { createHash } from "node:crypto";

import { createDriverId } from "../../protocol/id";

const MAX_CLAUDE_PUBLIC_TOOL_CALL_ID_BYTES = 256;

function claudeNativeToolCallIdKey(nativeToolCallId: string): string {
  return Buffer.byteLength(nativeToolCallId, "utf8") <= MAX_CLAUDE_PUBLIC_TOOL_CALL_ID_BYTES
    ? nativeToolCallId
    : createHash("sha256").update(nativeToolCallId).digest("hex");
}

export class ClaudePublicToolCallIdState {
  readonly #publicIds = new Map<string, string>();

  publicId(nativeToolCallId: string): string {
    if (Buffer.byteLength(nativeToolCallId, "utf8") <= MAX_CLAUDE_PUBLIC_TOOL_CALL_ID_BYTES) {
      return nativeToolCallId;
    }

    const key = claudeNativeToolCallIdKey(nativeToolCallId);
    const existing = this.#publicIds.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const publicId = createDriverId();
    this.#publicIds.set(key, publicId);
    return publicId;
  }

  reset(): void {
    this.#publicIds.clear();
  }
}
