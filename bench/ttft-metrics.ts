import type { DriverEventInput } from "../src/protocol/events";

export interface StreamingMetrics {
  interChunkMax: number | null;
  interChunkP50: number | null;
  interChunkP95: number | null;
  outputTokensPerSecond: number | null;
  pauseOver250MsCount: number;
  pauseOver500MsCount: number;
  timePerOutputTokenMs: number | null;
}

export function percentile(values: number[], percentage: number): number | null {
  const clean = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);

  if (clean.length === 0) {
    return null;
  }

  const index = Math.min(
    clean.length - 1,
    Math.max(0, Math.ceil((percentage / 100) * clean.length) - 1),
  );
  return clean[index] ?? null;
}

export function readOutputTokens(event: DriverEventInput): number | null {
  if (
    event.kind !== "usage.updated" ||
    typeof event.payload !== "object" ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    return null;
  }

  const outputTokens = (event.payload as Record<string, unknown>)["outputTokens"];
  return typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0
    ? outputTokens
    : null;
}

export function summarizeStreaming(input: {
  firstTextMs: number | null;
  outputTokens: number | null;
  textDeltaTimestamps: number[];
  totalMs: number | null;
}): StreamingMetrics {
  const gaps = input.textDeltaTimestamps
    .slice(1)
    .map((timestamp, index) => timestamp - (input.textDeltaTimestamps[index] ?? timestamp));
  const streamedMs =
    input.firstTextMs === null || input.totalMs === null
      ? null
      : Math.max(0, input.totalMs - input.firstTextMs);
  const generatedIntervals =
    input.outputTokens === null || input.outputTokens <= 1 ? null : input.outputTokens - 1;
  const timePerOutputTokenMs =
    streamedMs === null || streamedMs <= 0 || generatedIntervals === null
      ? null
      : streamedMs / generatedIntervals;

  return {
    interChunkMax: gaps.length === 0 ? null : Math.max(...gaps),
    interChunkP50: percentile(gaps, 50),
    interChunkP95: percentile(gaps, 95),
    outputTokensPerSecond: timePerOutputTokenMs === null ? null : 1000 / timePerOutputTokenMs,
    pauseOver250MsCount: gaps.filter((gap) => gap > 250).length,
    pauseOver500MsCount: gaps.filter((gap) => gap > 500).length,
    timePerOutputTokenMs,
  };
}
