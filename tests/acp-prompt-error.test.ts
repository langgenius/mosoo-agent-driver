import { describe, expect, test } from "bun:test";

import { RequestError } from "@agentclientprotocol/sdk";

import { toAcpPromptError } from "../src/runtimes/acp/acp-prompt-error";

const BLOCKED = "The content you provided or machine outputted is blocked.";

describe("ACP prompt rejection", () => {
  test.each([BLOCKED, `Internal error: ${BLOCKED}`])(
    "classifies the observed provider rejection without claiming an input/output stage: %s",
    (message) => {
      const failure = toAcpPromptError(
        new RequestError(-32603, message, { prompt: "must not be copied into diagnostics" }),
      );

      expect(failure).toMatchObject({
        code: "acp.content_blocked",
        details: { acpErrorCode: -32603, category: "content_policy", stage: "unknown" },
        recoverable: false,
      });
      expect(failure.message).toContain("will not be retried automatically");
      expect(JSON.stringify(failure)).not.toContain("must not be copied");
    },
  );

  test.each([
    new Error(BLOCKED),
    new RequestError(-32603, "Internal error: network request blocked."),
    new RequestError(-32603, `Tool output mentioned: ${BLOCKED}`),
    new RequestError(-32603, "Internal error: provider unavailable."),
  ])("leaves unrelated failures unchanged: %s", (error) => {
    expect(toAcpPromptError(error)).toEqual({ code: "acp.turn_failed", message: error.message });
  });
});
