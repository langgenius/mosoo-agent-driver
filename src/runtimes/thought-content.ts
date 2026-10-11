import type { DriverEventInput } from "../protocol/events";
import { MAX_THOUGHT_CONTENT_BYTES, MAX_THOUGHT_UPDATE_BYTES } from "../protocol/events";
import { chunkJsonText } from "./provider-json";

export { MAX_THOUGHT_CONTENT_BYTES };

export function thoughtContentBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

export function thoughtContentDeltaBytes(previous: string, delta: string): number {
  const last = previous.slice(-1);
  return thoughtContentBytes(last + delta) - thoughtContentBytes(last);
}

export function createThoughtContentEvents(
  thoughtId: string,
  text: string,
  sourcePrefix?: string,
): DriverEventInput[] {
  if (thoughtContentBytes(text) > MAX_THOUGHT_CONTENT_BYTES) {
    throw new Error("Thought content exceeds the byte limit.");
  }
  const event = (content: string, offset: number, index: number): DriverEventInput => ({
    kind: "thought.updated",
    delivery: "lossless",
    payload: { thoughtId, content, offset },
    ...(sourcePrefix === undefined ? {} : { sourceEventId: `${sourcePrefix}:${index}` }),
  });
  // Leave room for the canonical envelope added by the transport.
  const bytes =
    MAX_THOUGHT_UPDATE_BYTES -
    1_024 -
    Buffer.byteLength(JSON.stringify(event("", text.length, text.length)), "utf8");
  if (bytes < 6) throw new Error("Thought identity exceeds the event byte limit.");
  let offset = 0;
  return chunkJsonText(text, bytes).map((content, index) => {
    const update = event(content, offset, index);
    offset += content.length;
    return update;
  });
}
