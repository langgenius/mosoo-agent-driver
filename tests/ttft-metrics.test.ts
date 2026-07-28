import { describe, expect, test } from "bun:test";

import { readOutputTokens, summarizeStreaming } from "../bench/ttft-metrics";

describe("TTFT streaming metrics", () => {
  test("measures only visible-text cadence and provider output throughput", () => {
    expect(
      summarizeStreaming({
        firstTextMs: 100,
        outputTokens: 5,
        textDeltaTimestamps: [100, 120, 400, 920],
        totalMs: 1100,
      }),
    ).toEqual({
      interChunkMax: 520,
      interChunkP50: 280,
      interChunkP95: 520,
      outputTokensPerSecond: 4,
      pauseOver250MsCount: 2,
      pauseOver500MsCount: 1,
      timePerOutputTokenMs: 250,
    });
  });

  test("reads output tokens only from valid usage events", () => {
    expect(
      readOutputTokens({
        kind: "usage.updated",
        payload: { outputTokens: 42 },
      }),
    ).toBe(42);
    expect(readOutputTokens({ kind: "message.delta", payload: { outputTokens: 42 } })).toBeNull();
  });
});
