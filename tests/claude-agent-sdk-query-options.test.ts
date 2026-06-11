import { describe, expect, test } from "bun:test";

import { mergeClaudeQueryOptions } from "../src/runtimes/claude/agent-sdk-query-options";

describe("Claude Agent SDK query options", () => {
  test("deep-merges advanced provider options into generated query options", () => {
    const base = {
      env: {
        BASE: "1",
      },
      mcpServers: {
        linear: {
          headers: {
            Authorization: "Bearer generated",
          },
          type: "http",
          url: "https://mcp-proxy.example/linear",
        },
      },
      model: "claude-sonnet-4",
      permissionMode: "default",
      persistSession: true,
    };

    const merged = mergeClaudeQueryOptions(base, {
      env: {
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
      },
      mcpServers: {
        linear: {
          headers: {
            "X-Debug": "enabled",
          },
        },
      },
      permissionMode: "acceptEdits",
    });

    expect(merged).toEqual({
      env: {
        BASE: "1",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
      },
      mcpServers: {
        linear: {
          headers: {
            Authorization: "Bearer generated",
            "X-Debug": "enabled",
          },
          type: "http",
          url: "https://mcp-proxy.example/linear",
        },
      },
      model: "claude-sonnet-4",
      permissionMode: "acceptEdits",
      persistSession: true,
    });
    expect(base.env).toEqual({ BASE: "1" });
  });
});
