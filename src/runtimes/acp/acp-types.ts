import type { DriverEventInput } from "../../protocol/events";
import type { JsonObject } from "../provider-json";

export const MAX_ACP_LOSSLESS_EVENT_BYTES = 512 * 1_024;

// OpenCode reports cache read/write as separate Anthropic-style buckets.
export const ACP_USAGE_CONTRACT = "anthropic_bucketed";

export function assertBoundedLosslessEvents(events: DriverEventInput[]): DriverEventInput[] {
  for (const event of events) {
    if (
      event.delivery !== "best_effort" &&
      Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_ACP_LOSSLESS_EVENT_BYTES
    ) {
      throw new RangeError(
        `ACP ${event.kind} event exceeds ${MAX_ACP_LOSSLESS_EVENT_BYTES} UTF-8 bytes.`,
      );
    }
  }

  return events;
}

export { raceWithAbort } from "../../utils/async";

export {
  isRecord,
  readArray,
  readNonEmptyString,
  readNumber,
  readRecord,
  readString,
  stringifyForDisplay,
} from "../provider-json";
export type { JsonObject } from "../provider-json";

export function readNullableString(
  value: JsonObject | null,
  key: string,
): string | null | undefined {
  const entry = value?.[key];

  if (entry === null) {
    return null;
  }

  return typeof entry === "string" ? entry : undefined;
}
