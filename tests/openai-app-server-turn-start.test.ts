import { describe, expect, test } from "bun:test";

import { createOpenAiTurnStartParams } from "../src/runtimes/openai/app-server-driver-backend";

describe("OpenAI app-server turn start params", () => {
  test("carries the provided approval policy with every user turn", () => {
    expect(
      createOpenAiTurnStartParams({
        approvalPolicy: "on-request",
        cwd: "/workspace",
        model: "gpt-5.4",
        text: "Run pwd",
        threadId: "thread-1",
      }),
    ).toEqual({
      approvalPolicy: "on-request",
      cwd: "/workspace",
      input: [
        {
          text: "Run pwd",
          text_elements: [],
          type: "text",
        },
      ],
      model: "gpt-5.4",
      threadId: "thread-1",
    });
  });

  test("forwards the auto-approve (never) policy for headless turns", () => {
    expect(
      createOpenAiTurnStartParams({
        approvalPolicy: "never",
        cwd: "/workspace",
        model: "gpt-5.4",
        text: "Run pwd",
        threadId: "thread-1",
      }).approvalPolicy,
    ).toBe("never");
  });
});
