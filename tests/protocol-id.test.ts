import { describe, expect, test } from "bun:test";

import {
  createDriverIdFromBytes,
  driverIdTimeMs,
  isDriverId,
  normalizeDriverId,
  parseDriverId,
} from "../src/protocol/id";
import { createRuntimeAssistantMessageId } from "../src/runtimes/runtime-turn-transcript";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

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

  test("encodes deterministic 128-bit identities as canonical Driver IDs", () => {
    expect(createDriverIdFromBytes(new Uint8Array(16))).toBe("00000000000000000000000000");
    expect(createDriverIdFromBytes(new Uint8Array(16).fill(0xff))).toBe(
      "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
    );
    expect(driverIdTimeMs(parseDriverId("7ZZZZZZZZZ0000000000000000"))).toBe(281_474_976_710_655);
    expect(() => createDriverIdFromBytes(new Uint8Array(15))).toThrow("exactly 16 bytes");
  });

  test("domain-separates deterministic runtime message identities", () => {
    const key = 'item:["a","b:c"]';
    const messageId = createRuntimeAssistantMessageId(
      DRIVER_TEST_IDS.sessionId,
      "openai-message",
      key,
    );

    expect(messageId).toBe("10DF94GHQDTF5928TMBEZSWHQ4");
    expect(
      createRuntimeAssistantMessageId(DRIVER_TEST_IDS.sessionId, "openai-reasoning", key),
    ).not.toBe(messageId);
    expect(
      createRuntimeAssistantMessageId(DRIVER_TEST_IDS.sessionId, "openai-message", `${key}:next`),
    ).not.toBe(messageId);
  });
});
