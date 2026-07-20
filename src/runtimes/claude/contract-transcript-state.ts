import { asJsonValue } from "../contract-projection";

export interface ToolInputBuffer {
  readonly bytes: number;
  readonly overflowed: boolean;
  readonly text: string;
}

export class ClaudeContractTranscriptState {
  readonly #authoritativeToolInputs = new Set<string>();
  readonly #blockToolIds = new Map<string, string>();
  readonly #createId: () => string;
  readonly #ids = new Map<string, Map<string, string>>();
  readonly #maxToolInputBytes: number;
  readonly #textEncoder = new TextEncoder();
  #toolInputBytes = 0;
  readonly #toolInputFragments = new Map<string, ToolInputBuffer>();

  constructor(createId: () => string, maxToolInputBytes: number) {
    this.#createId = createId;
    this.#maxToolInputBytes = maxToolInputBytes;
  }

  id(runId: string, kind: string, nativeId: string): string {
    const candidate = nativeId.length > 0 ? `${kind}:${nativeId}` : "";

    if (candidate.length > 0 && candidate.length <= 256) {
      return candidate;
    }

    let ids = this.#ids.get(runId);

    if (ids === undefined) {
      ids = new Map();
      this.#ids.set(runId, ids);
    }

    const key = `${kind}:${nativeId}`;
    let id = ids.get(key);

    if (id === undefined) {
      id = this.#createId();
      ids.set(key, id);
    }

    return id;
  }

  reasoningId(runId: string, messageId: string): string {
    return this.id(runId, "reasoning", `${messageId}:reasoning`);
  }

  hasAuthoritativeToolInput(key: string): boolean {
    return this.#authoritativeToolInputs.has(key);
  }

  markAuthoritativeToolInput(runId: string, itemId: string): void {
    this.#authoritativeToolInputs.add(`${runId}:${itemId}`);
  }

  setBlockToolId(key: string, toolId: string): void {
    this.#blockToolIds.set(key, toolId);
  }

  blockToolId(key: string): string | undefined {
    return this.#blockToolIds.get(key);
  }

  deleteBlockToolId(key: string): void {
    this.#blockToolIds.delete(key);
  }

  deleteBlockToolIdsForTool(toolId: string): void {
    for (const [key, value] of this.#blockToolIds) {
      if (value === toolId) {
        this.#blockToolIds.delete(key);
      }
    }
  }

  appendToolInput(key: string, fragment: string): void {
    const current = this.#toolInputFragments.get(key) ?? {
      bytes: 0,
      overflowed: false,
      text: "",
    };

    if (current.overflowed) {
      return;
    }

    const addedBytes = this.#textEncoder.encode(fragment).byteLength;

    if (addedBytes > this.#maxToolInputBytes - this.#toolInputBytes) {
      this.#toolInputBytes -= current.bytes;
      this.#toolInputFragments.set(key, { bytes: 0, overflowed: true, text: "" });
      return;
    }

    this.#toolInputBytes += addedBytes;
    this.#toolInputFragments.set(key, {
      bytes: current.bytes + addedBytes,
      overflowed: false,
      text: current.text + fragment,
    });
  }

  toolInputBuffer(key: string): ToolInputBuffer | undefined {
    return this.#toolInputFragments.get(key);
  }

  dropToolInput(key: string): void {
    const buffer = this.#toolInputFragments.get(key);

    if (buffer !== undefined) {
      this.#toolInputBytes -= buffer.bytes;
      this.#toolInputFragments.delete(key);
    }
  }

  toolInput(value: unknown) {
    const input = asJsonValue(value);

    if (
      input !== undefined &&
      this.#textEncoder.encode(JSON.stringify(input)).byteLength > this.#maxToolInputBytes
    ) {
      throw new RangeError("Claude tool input exceeds its byte limit.");
    }

    return input;
  }

  releaseRun(runId: string): void {
    this.#ids.delete(runId);

    for (const key of this.#authoritativeToolInputs) {
      if (key.startsWith(`${runId}:`)) {
        this.#authoritativeToolInputs.delete(key);
      }
    }
    for (const key of this.#blockToolIds.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.#blockToolIds.delete(key);
      }
    }
    for (const key of this.#toolInputFragments.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.dropToolInput(key);
      }
    }
  }

  dispose(): void {
    this.#authoritativeToolInputs.clear();
    this.#blockToolIds.clear();
    this.#ids.clear();
    this.#toolInputBytes = 0;
    this.#toolInputFragments.clear();
  }
}
