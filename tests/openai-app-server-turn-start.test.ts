import { describe, expect, test } from "bun:test";

import { createTurnParams } from "../src/runtimes/openai/app-server-driver-backend";

describe("OpenAI app-server turn start params", () => {
  test("carries the resolved approval policy with every user turn", () => {
    expect(
      createTurnParams({
        approvalPolicy: "never",
        cwd: "/workspace",
        model: "gpt-5.4",
        text: "Run pwd",
        threadId: "thread-1",
      }),
    ).toEqual({
      approvalPolicy: "never",
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
});
