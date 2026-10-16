import { describe, expect, test } from "bun:test";

import { isCanonicalAcpFallbackUsageMetadata } from "./driver-artifact-live-usage";

describe("ACP live usage metadata predicate", () => {
  test("accepts native OpenCode step totals with the ACP contract", () => {
    expect(isCanonicalAcpFallbackUsageMetadata("native_step_totals", "anthropic_bucketed")).toBe(
      true,
    );
  });

  test.each([
    ["prompt_response", "anthropic_bucketed"],
    ["session_update", "anthropic_bucketed"],
    ["native_step_totals", "openai_runtime_total_with_cached_breakdown"],
    ["unknown", "anthropic_bucketed"],
  ] as const)("rejects %s with %s", (source, usageContract) => {
    expect(isCanonicalAcpFallbackUsageMetadata(source, usageContract)).toBe(false);
  });
});
