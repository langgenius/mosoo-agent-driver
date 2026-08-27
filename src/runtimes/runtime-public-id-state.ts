import { createHash } from "node:crypto";

import { createDriverId } from "../protocol/id";

const MAX_PUBLIC_NATIVE_ID_BYTES = 256;

export class RuntimePublicIdState {
  readonly #publicIds = new Map<string, string>();

  publicId(nativeId: string, namespace = "id"): string {
    if (Buffer.byteLength(nativeId, "utf8") <= MAX_PUBLIC_NATIVE_ID_BYTES) {
      return nativeId;
    }

    const key = `${namespace}:${createHash("sha256").update(nativeId).digest("hex")}`;
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
