import { describe, expect, test } from "bun:test";

import {
  isOpenAiRuntimeNotice,
  OPENAI_RUNTIME_NOTICE_SUBTYPES,
} from "./driver-artifact-live-runtime-notice";

interface TestEvent {
  readonly actor: string;
  readonly kind: string;
  readonly origin: string;
  readonly payload: Record<string, unknown>;
}

function runtimeNotice(overrides: Partial<TestEvent> = {}): TestEvent {
  return {
    actor: "driver",
    kind: "message.added",
    origin: "driver",
    payload: {
      content: "A runtime notice.",
      messageId: "message-1",
      role: "agent",
      subtype: "warning",
    },
    ...overrides,
  };
}

describe("OpenAI runtime notice predicate", () => {
  test.each(OPENAI_RUNTIME_NOTICE_SUBTYPES)("recognizes the %s subtype", (subtype) => {
    expect(
      isOpenAiRuntimeNotice(runtimeNotice({ payload: { ...runtimeNotice().payload, subtype } })),
    ).toBe(true);
  });

  test("keeps ordinary agent output in lifecycle pairing", () => {
    expect(
      isOpenAiRuntimeNotice(
        runtimeNotice({
          payload: {
            content: "The answer.",
            messageId: "message-1",
            role: "agent",
          },
        }),
      ),
    ).toBe(false);
  });

  test("allows known runtime notices to remain standalone", () => {
    expect(isOpenAiRuntimeNotice(runtimeNotice())).toBe(true);
  });

  test.each([
    ["actor", { actor: "agent" }],
    ["origin", { origin: "runtime" }],
  ] as const)("rejects a foreign %s", (_label, override) => {
    expect(isOpenAiRuntimeNotice(runtimeNotice(override))).toBe(false);
  });

  test("rejects an unknown subtype", () => {
    expect(
      isOpenAiRuntimeNotice(
        runtimeNotice({ payload: { ...runtimeNotice().payload, subtype: "warning_extra" } }),
      ),
    ).toBe(false);
  });

  test("requires the agent role and message.added kind", () => {
    expect(
      isOpenAiRuntimeNotice(
        runtimeNotice({
          kind: "message.delta",
          payload: { ...runtimeNotice().payload, role: "user" },
        }),
      ),
    ).toBe(false);
  });
});
