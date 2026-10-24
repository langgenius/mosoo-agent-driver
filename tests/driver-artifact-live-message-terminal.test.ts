import { describe, expect, test } from "bun:test";

import {
  CANONICAL_MESSAGE_TERMINAL_KINDS,
  CANONICAL_THOUGHT_TERMINAL_KINDS,
  isCanonicalMessageTerminalKind,
  isCanonicalThoughtTerminalKind,
} from "./driver-artifact-live-message-terminal";

describe("packed driver lifecycle terminal predicates", () => {
  test("accepts every canonical message terminal outcome", () => {
    expect(CANONICAL_MESSAGE_TERMINAL_KINDS).toEqual([
      "message.cancelled",
      "message.completed",
      "message.failed",
    ]);

    for (const kind of CANONICAL_MESSAGE_TERMINAL_KINDS) {
      expect(isCanonicalMessageTerminalKind(kind)).toBe(true);
    }
  });

  test.each([
    "message.started",
    "message.delta",
    "message.added",
    "item.completed",
    "run.failed",
    "message.unknown",
  ])('rejects "%s"', (kind) => {
    expect(isCanonicalMessageTerminalKind(kind)).toBe(false);
  });

  test("accepts every canonical thought terminal outcome", () => {
    expect(CANONICAL_THOUGHT_TERMINAL_KINDS).toEqual(["thought.cancelled", "thought.completed"]);

    for (const kind of CANONICAL_THOUGHT_TERMINAL_KINDS) {
      expect(isCanonicalThoughtTerminalKind(kind)).toBe(true);
    }
  });

  test.each(["thought.started", "thought.delta", "message.completed", "run.cancelled"])(
    'rejects "%s" as a thought terminal',
    (kind) => {
      expect(isCanonicalThoughtTerminalKind(kind)).toBe(false);
    },
  );
});
