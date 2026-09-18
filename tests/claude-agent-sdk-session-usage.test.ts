import { expect, test } from "bun:test";
import type { ModelUsage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeSessionUsage } from "../src/runtimes/claude/agent-sdk-session-usage";

function modelUsage(count: number): ModelUsage {
  return {
    cacheCreationInputTokens: count,
    cacheReadInputTokens: count * 2,
    contextWindow: 200_000,
    costUSD: count / 10,
    inputTokens: count * 10,
    maxOutputTokens: 1_024,
    outputTokens: count * 5,
    thinkingTokens: count,
    webSearchRequests: count,
  };
}

function result(models: Record<string, ModelUsage>, cost: number): SDKResultMessage {
  return {
    modelUsage: models,
    total_cost_usd: cost,
    usage: { input_tokens: 5 },
  } as unknown as SDKResultMessage;
}

test("differences cumulative counters by model while preserving limits and per-turn usage", () => {
  const usage = new ClaudeSessionUsage();
  usage.difference(result({ first: modelUsage(1) }, 0.1));
  const next = usage.difference(result({ first: modelUsage(3), second: modelUsage(1) }, 0.4));
  expect(next.modelUsage["first"]).toMatchObject({
    ...modelUsage(2),
    costUSD: expect.closeTo(0.2),
  });
  expect(next.modelUsage["second"]).toEqual(modelUsage(1));
  expect(next.total_cost_usd).toBeCloseTo(0.3);
  expect(next.usage).toEqual({ input_tokens: 5 });
});

test("a conversation reset starts a fresh accounting epoch", () => {
  const usage = new ClaudeSessionUsage();
  usage.difference(result({ first: modelUsage(3) }, 0.3));
  usage.reset();
  const next = result({ first: modelUsage(1) }, 0.1);
  expect(usage.difference(next)).toEqual(next);
});

test("zeroed crash results do not produce negative usage", () => {
  const usage = new ClaudeSessionUsage();
  usage.difference(result({ first: modelUsage(3) }, 0.3));
  const next = result({ first: modelUsage(0) }, 0);
  expect(usage.difference(next)).toEqual(next);
});

test("invalid cumulative samples do not corrupt the next valid accounting delta", () => {
  const usage = new ClaudeSessionUsage();
  usage.difference(result({ first: modelUsage(1) }, 0.1));
  usage.difference(
    result({ first: { ...modelUsage(1), inputTokens: -5, outputTokens: Infinity } }, NaN),
  );
  const next = usage.difference(result({ first: modelUsage(3) }, 0.3));
  expect(next.modelUsage["first"]?.inputTokens).toBe(20);
  expect(next.modelUsage["first"]?.outputTokens).toBe(10);
  expect(next.total_cost_usd).toBeCloseTo(0.2);
});
