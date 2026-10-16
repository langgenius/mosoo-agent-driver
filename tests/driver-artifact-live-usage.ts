import { ACP_USAGE_CONTRACT } from "../src/runtimes/acp/acp-types";

export const ACP_FALLBACK_USAGE_METADATA = {
  sources: ["native_step_totals"],
  usageContract: ACP_USAGE_CONTRACT,
} as const;

export function isCanonicalAcpFallbackUsageMetadata(
  source: unknown,
  usageContract: unknown,
): boolean {
  return (
    typeof source === "string" &&
    (ACP_FALLBACK_USAGE_METADATA.sources as readonly string[]).includes(source) &&
    usageContract === ACP_FALLBACK_USAGE_METADATA.usageContract
  );
}
