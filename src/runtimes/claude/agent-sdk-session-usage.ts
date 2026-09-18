import type { ModelUsage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { isRecord, toCostAmount, toTokenCount } from "./agent-sdk-json";

const COUNTERS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "webSearchRequests",
  "costUSD",
] as const satisfies readonly (keyof ModelUsage)[];

/** SDK modelUsage/cost are process totals; the Driver publishes Run totals. */
export class ClaudeSessionUsage {
  #cost = 0;
  readonly #models = new Map<string, ModelUsage>();

  reset(): void {
    this.#cost = 0;
    this.#models.clear();
  }

  difference(message: SDKResultMessage): SDKResultMessage {
    const entries: [string, ModelUsage][] = [];
    const models: Record<string, ModelUsage> = isRecord(message.modelUsage)
      ? message.modelUsage
      : {};
    for (const [model, current] of Object.entries(models)) {
      if (!isRecord(current)) continue;
      const previous = this.#models.get(model);
      const delta = { ...current };
      const next = { ...current };
      for (const counter of COUNTERS) {
        const value =
          counter === "costUSD" ? toCostAmount(current[counter]) : toTokenCount(current[counter]);
        const baseline = previous?.[counter] ?? 0;
        // Preserve invalid values for the existing event validator to drop,
        // without corrupting the last known cumulative accounting baseline.
        if (value === null) {
          next[counter] = baseline;
        } else {
          delta[counter] = Math.max(0, value - baseline);
        }
      }
      const thinking = toTokenCount(current.thinkingTokens);
      if (thinking !== null) {
        delta.thinkingTokens = Math.max(0, thinking - (previous?.thinkingTokens ?? 0));
      } else if (previous?.thinkingTokens !== undefined) {
        next.thinkingTokens = previous.thinkingTokens;
      }
      entries.push([model, delta]);
      this.#models.set(model, next);
    }
    const cost = toCostAmount(message.total_cost_usd);
    const totalCost = cost === null ? message.total_cost_usd : Math.max(0, cost - this.#cost);
    if (cost !== null) this.#cost = cost;
    return { ...message, modelUsage: Object.fromEntries(entries), total_cost_usd: totalCost };
  }
}
