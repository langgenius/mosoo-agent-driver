import { describe, expect, test } from "bun:test";

import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-event-envelope";
import { MAX_THOUGHT_UPDATE_BYTES } from "../src/protocol/events";
import type { DriverEventInput } from "../src/protocol/events";
import { isJsonObject } from "../src/protocol/json";
import { parseRuntimeEventEnvelope } from "../src/runtime-events";
import {
  createThoughtContentEvents,
  MAX_THOUGHT_CONTENT_BYTES,
  thoughtContentBytes,
  thoughtContentDeltaBytes,
} from "../src/runtimes/thought-content";
import { driverBootPayload, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

function canonicalEvent(event: DriverEventInput) {
  const canonical = toDriverEventEnvelopes(
    { ...driverBootPayload, runtime: "pi", runtimeTransport: "pi-rpc" },
    event,
    DRIVER_TEST_IDS.runId,
  )[0]?.event;
  if (canonical === undefined) throw new Error("Missing canonical thought event.");
  return canonical;
}

const payload = { thoughtId: "thought-1", content: "final", offset: 0 };

describe("Authoritative thought content", () => {
  test("counts a surrogate pair split across native deltas as one unicode character", () => {
    let text = "";
    let bytes = 0;
    for (const delta of ["prefix", "\ud83d", "\ude00", "\u0000", '"', "\\"]) {
      bytes += thoughtContentDeltaBytes(text, delta);
      text += delta;
      expect(bytes).toBe(thoughtContentBytes(text));
    }
    expect(text).toBe('prefix😀\u0000"\\');
    expect(thoughtContentDeltaBytes("\ud83d", "\ude00")).toBe(-2);
  });

  test("chunks escaped unicode into bounded events with UTF-16 offsets", () => {
    const text = '\u0000"\\😀'.repeat(100_000);
    const events = createThoughtContentEvents("thought-1", text, "source-1");
    expect(events.length).toBeGreaterThan(1);
    let restored = "";
    for (const [index, event] of events.entries()) {
      expect(event.kind).toBe("thought.updated");
      expect(event.delivery).toBe("lossless");
      expect(event.sourceEventId).toBe(`source-1:${index}`);
      if (!isJsonObject(event.payload)) throw new Error("Missing thought payload.");
      const content = event.payload["content"];
      if (typeof content !== "string") throw new Error("Missing thought content.");
      expect(event.payload["offset"]).toBe(restored.length);
      expect(content.isWellFormed()).toBe(true);
      if (index > 0) {
        expect(event.payload["offset"]).not.toBe(Buffer.byteLength(restored, "utf8"));
      }
      restored += content;
      const canonical = canonicalEvent(event);
      expect(parseRuntimeEventEnvelope(canonical)).toEqual(canonical);
      expect(Buffer.byteLength(JSON.stringify(canonical), "utf8")).toBeLessThanOrEqual(
        MAX_THOUGHT_UPDATE_BYTES,
      );
    }
    expect(restored).toBe(text);
  });

  test("emits an empty replacement so final content can clear a preview", () => {
    const events = createThoughtContentEvents("thought-1", "");
    expect(events).toEqual([
      {
        kind: "thought.updated",
        delivery: "lossless",
        payload: { thoughtId: "thought-1", content: "", offset: 0 },
      },
    ]);
    expect(parseRuntimeEventEnvelope(canonicalEvent(events[0]!)).payload).toEqual({
      thoughtId: "thought-1",
      content: "",
      offset: 0,
    });
  });

  test("limits complete content by escaped JSON bytes before chunking", () => {
    const text = "x".repeat(MAX_THOUGHT_CONTENT_BYTES);
    const events = createThoughtContentEvents("thought-1", text);
    const final = events.at(-1)?.payload;
    if (!isJsonObject(final) || typeof final["content"] !== "string") {
      throw new Error("Missing final thought chunk.");
    }
    expect(Number(final["offset"]) + final["content"].length).toBe(text.length);
    expect(() => createThoughtContentEvents("thought-1", `${text}x`)).toThrow(
      "Thought content exceeds the byte limit.",
    );
    expect(thoughtContentBytes('\u0000"\\😀')).toBe(14);
    expect(() =>
      createThoughtContentEvents("thought-1", "\u0000".repeat(MAX_THOUGHT_CONTENT_BYTES / 6 + 1)),
    ).toThrow("Thought content exceeds the byte limit.");
  });

  test("rejects an identity that leaves no room for a valid chunk", () => {
    const thoughtId = "x".repeat(MAX_THOUGHT_UPDATE_BYTES);
    expect(() => createThoughtContentEvents(thoughtId, "value")).toThrow(
      "Thought identity exceeds the event byte limit.",
    );
  });
});

describe("Canonical thought update validation", () => {
  const canonical = canonicalEvent({ kind: "thought.updated", delivery: "lossless", payload });

  test("rejects lossy delivery", () => {
    expect(() => parseRuntimeEventEnvelope({ ...canonical, delivery: "best_effort" })).toThrow();
  });

  test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "rejects invalid offset %s",
    (offset) => {
      expect(() =>
        parseRuntimeEventEnvelope({ ...canonical, payload: { ...payload, offset } }),
      ).toThrow();
    },
  );

  test.each([undefined, null, 1, {}, []].map((content) => ({ content })))(
    "rejects non-text content $content",
    ({ content }) => {
      expect(() =>
        parseRuntimeEventEnvelope({ ...canonical, payload: { ...payload, content } }),
      ).toThrow();
    },
  );

  test("bounds payload bytes and the end of the complete text", () => {
    const bytes = Buffer.byteLength(JSON.stringify({ ...payload, content: "" }), "utf8");
    const content = "x".repeat(MAX_THOUGHT_UPDATE_BYTES - bytes);
    const atLimit = { ...canonical, payload: { ...payload, content } };
    expect(parseRuntimeEventEnvelope(atLimit).payload).toEqual(atLimit.payload);
    expect(() =>
      parseRuntimeEventEnvelope({
        ...canonical,
        payload: { ...payload, content: `${content}x` },
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeEventEnvelope({
        ...canonical,
        payload: { ...payload, offset: MAX_THOUGHT_CONTENT_BYTES },
      }),
    ).toThrow();
  });
});
