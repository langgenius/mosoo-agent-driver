import { describe, expect, test } from "bun:test";

import { readNumber } from "../src/runtimes/claude/agent-sdk-json";
import { toClaudeUsageUpdatedEvents } from "../src/runtimes/claude/agent-sdk-message-events";

const nonFiniteNumbers = [
  { label: "Infinity", value: Infinity },
  { label: "-Infinity", value: -Infinity },
  { label: "NaN", value: Number.NaN },
] as const;

const finiteNumbers = [
  { label: "negative max", value: -Number.MAX_VALUE },
  { label: "negative fraction", value: -1.5 },
  { label: "zero", value: 0 },
  { label: "positive fraction", value: 1.5 },
  { label: "positive max", value: Number.MAX_VALUE },
] as const;

const invalidTokenCounts = [
  { label: "negative", value: -1 },
  { label: "fractional", value: 1.5 },
  { label: "unsafe", value: Number.MAX_SAFE_INTEGER + 1 },
  ...nonFiniteNumbers,
] as const;

const invalidCosts = [{ label: "negative", value: -0.01 }, ...nonFiniteNumbers] as const;

describe("Claude Agent SDK number reader", () => {
  test.each(nonFiniteNumbers)("ignores non-finite runtime value $label", ({ value }) => {
    expect(readNumber({ value }, "value")).toBeNull();
  });

  test.each(finiteNumbers)("retains finite runtime value $label", ({ value }) => {
    expect(readNumber({ value }, "value")).toBe(value);
  });

  test.each(invalidTokenCounts)(
    "drops $label token counts and sums the retained fields",
    ({ value }) => {
      expect(
        toClaudeUsageUpdatedEvents({ input_tokens: value, output_tokens: 2 }, null),
      ).toMatchObject([
        {
          kind: "usage.updated",
          payload: { inputTokens: null, outputTokens: 2, totalTokens: 2 },
        },
      ]);
    },
  );

  test("drops individually invalid MAX_VALUE token fields", () => {
    expect(
      toClaudeUsageUpdatedEvents(
        { input_tokens: Number.MAX_VALUE, output_tokens: Number.MAX_VALUE },
        null,
      ),
    ).toEqual([]);
  });

  test("drops a derived total that exceeds the safe integer range", () => {
    expect(
      toClaudeUsageUpdatedEvents({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }, null),
    ).toMatchObject([
      {
        payload: {
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: 1,
          totalTokens: null,
        },
      },
    ]);
  });

  test.each(invalidCosts)("drops $label costs", ({ value }) => {
    expect(toClaudeUsageUpdatedEvents({ input_tokens: 1, output_tokens: 2 }, value)).toMatchObject([
      {
        payload: { costAmount: null, costCurrency: null, totalTokens: 3 },
      },
    ]);
  });

  test("retains a finite nonnegative fractional cost", () => {
    expect(toClaudeUsageUpdatedEvents(null, 0.01)).toMatchObject([
      {
        payload: { costAmount: 0.01, costCurrency: "USD" },
      },
    ]);
  });
});
