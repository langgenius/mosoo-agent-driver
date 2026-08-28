import { describe, expect, test } from "bun:test";

import { isDriverId, normalizeDriverId, parseDriverId } from "../src/protocol/id";

describe("Driver IDs", () => {
  test("accepts the full ULID range and canonicalizes lowercase input", () => {
    const maximum = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ";

    expect(parseDriverId(maximum)).toBe(maximum);
    expect(normalizeDriverId(maximum.toLowerCase())).toBe(maximum);
    expect(isDriverId(maximum)).toBe(true);
  });

  test.each(["80000000000000000000000000", "Z0000000000000000000000000"])(
    "rejects an overflowing ULID %s",
    (value) => {
      expect(() => parseDriverId(value)).toThrow("must be a valid ULID");
      expect(isDriverId(value)).toBe(false);
    },
  );
});
