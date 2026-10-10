import type { ModelUsage, Query, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { isRecord, readRecord, toCostAmount, toTokenCount } from "./agent-sdk-json";
import type { JsonObject } from "./agent-sdk-json";
import { aggregateClaudeModelUsage } from "./agent-sdk-message-events";

const COUNTERS = [
  "inputTokens",
  "outputTokens",
  "thinkingTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "webSearchRequests",
  "costUSD",
] as const satisfies readonly (keyof ModelUsage)[];

type ClaudeUsageCounters = Partial<Record<(typeof COUNTERS)[number], number | null>>;

/** SDK totals include restored history; the Driver publishes only the current Run. */
export class ClaudeSessionUsage {
  #cost: number | null = 0;
  #unseenModelBaseline: 0 | null = 0;
  readonly #models = new Map<string, ClaudeUsageCounters>();

  async initialize(query: Query): Promise<void> {
    await query.initializationResult();
    const response = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    });
    const session = readRecord(response, "session");
    const cost = toCostAmount(session?.["total_cost_usd"]);
    const models = readRecord(session, "model_usage");
    if (cost === null || models === null) {
      throw new Error("Claude did not return a complete native usage baseline.");
    }
    const entries: [string, ClaudeUsageCounters][] = [];
    for (const [model, current] of Object.entries(models)) {
      if (!isRecord(current)) throw new Error("Claude native model usage baseline is invalid.");
      const counters: ClaudeUsageCounters = {};
      for (const counter of COUNTERS) {
        if (counter === "thinkingTokens" && current[counter] === undefined) {
          counters[counter] = null;
          continue;
        }
        const value =
          counter === "costUSD" ? toCostAmount(current[counter]) : toTokenCount(current[counter]);
        if (value === null) throw new Error(`Claude native ${counter} baseline is invalid.`);
        counters[counter] = value;
      }
      entries.push([model, counters]);
    }
    this.reset();
    this.#cost = cost;
    for (const [model, counters] of entries) this.#models.set(model, counters);
  }

  reset(): void {
    this.#cost = 0;
    this.#unseenModelBaseline = 0;
    this.#models.clear();
  }

  difference(message: SDKResultMessage): SDKResultMessage {
    const entries: [string, ModelUsage][] = [];
    const models: Record<string, ModelUsage> = isRecord(message.modelUsage)
      ? message.modelUsage
      : {};
    for (const model of new Set([...this.#models.keys(), ...Object.keys(models)])) {
      const current = models[model];
      const previous = this.#models.get(model);
      const delta = { ...current } as ModelUsage;
      const next: ClaudeUsageCounters = {};
      for (const counter of COUNTERS) {
        const raw = isRecord(current) ? current[counter] : undefined;
        const value = counter === "costUSD" ? toCostAmount(raw) : toTokenCount(raw);
        const baseline =
          previous?.[counter] === undefined ? this.#unseenModelBaseline : previous[counter];
        // An unknown Run boundary must not assign its consumption to the next Run.
        delta[counter] = value === null || baseline === null ? NaN : Math.max(0, value - baseline);
        next[counter] = value;
      }
      entries.push([model, delta]);
      this.#models.set(model, next);
    }
    this.#unseenModelBaseline = isRecord(message.modelUsage) ? 0 : null;
    const cost = toCostAmount(message.total_cost_usd);
    const totalCost = cost === null || this.#cost === null ? NaN : Math.max(0, cost - this.#cost);
    this.#cost = cost;
    return { ...message, modelUsage: Object.fromEntries(entries), total_cost_usd: totalCost };
  }
}

const RESPONSE_COUNTERS = {
  input_tokens: "inputTokens",
  output_tokens: "outputTokens",
  thinking_tokens: "thinkingTokens",
  cache_read_input_tokens: "cacheReadInputTokens",
  cache_creation_input_tokens: "cacheCreationInputTokens",
} as const;

function sumUsage(samples: readonly (JsonObject | null)[]): JsonObject | null {
  const result: JsonObject = {};
  for (const counter of Object.keys(RESPONSE_COUNTERS)) {
    const values = samples.flatMap((sample) => {
      const value = toTokenCount(sample?.[counter]);
      return value === null ? [] : [value];
    });
    const total = toTokenCount(values.reduce((sum, value) => sum + value, 0));
    if (values.length > 0 && total !== null) result[counter] = total;
  }
  return Object.keys(result).length === 0 ? null : result;
}

/** Response samples accumulate per native message; result totals replace their native epoch. */
export class ClaudeRunUsage {
  readonly #responses = new Map<string, JsonObject>();
  #result: JsonObject | null = null;
  #previousEpochs: JsonObject | null = null;
  #cost: number | null = null;
  #previousCost: number | null = null;

  reset(): void {
    this.#responses.clear();
    this.#result = null;
    this.#previousEpochs = null;
    this.#cost = null;
    this.#previousCost = null;
  }

  startEpoch(): void {
    const snapshot = this.snapshot();
    this.reset();
    this.#previousEpochs = snapshot.usage;
    this.#previousCost = snapshot.cost;
  }

  updateResponse(id: string, usage: JsonObject | null): void {
    const previous = this.#responses.get(id) ?? {};
    const next = { ...previous };
    for (const counter of Object.keys(RESPONSE_COUNTERS)) {
      const value = toTokenCount(
        counter === "thinking_tokens"
          ? (usage?.[counter] ?? readRecord(usage, "output_tokens_details")?.[counter])
          : usage?.[counter],
      );
      if (value !== null) {
        // Samples of the same response may replay or arrive after a newer stream delta.
        next[counter] = Math.max(toTokenCount(previous[counter]) ?? 0, value);
      }
    }
    this.#responses.set(id, next);
  }

  updateResult(message: SDKResultMessage): void {
    // The result replaces this epoch's response samples, including unseen subagent usage.
    const totals = aggregateClaudeModelUsage(message.modelUsage);
    if (totals !== null) {
      const models = Object.values(message.modelUsage);
      for (const [counter, nativeCounter] of Object.entries(RESPONSE_COUNTERS)) {
        if (
          models.some((model) => !isRecord(model) || toTokenCount(model[nativeCounter]) === null)
        ) {
          delete totals[counter];
        }
      }
      this.#result = { ...this.#result, ...totals };
    }
    this.#cost = toCostAmount(message.total_cost_usd) ?? this.#cost;
  }

  snapshot(): { usage: JsonObject | null; cost: number | null } {
    return {
      usage: sumUsage([
        this.#previousEpochs,
        { ...sumUsage([...this.#responses.values()]), ...this.#result },
      ]),
      cost:
        this.#previousCost === null && this.#cost === null
          ? null
          : toCostAmount((this.#previousCost ?? 0) + (this.#cost ?? 0)),
    };
  }
}
