import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBufferedSinkLogger } from "../src/observability";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import {
  createClaudeQueryOptions,
  mergeClaudeQueryOptions,
  toClaudeBuiltInTools,
} from "../src/runtimes/claude/agent-sdk-query-options";
import { driverBootPayload } from "./driver-boot-payload-fixture";

let runtimeHomes: string[] = [];

async function createRuntimeHome(): Promise<string> {
  const runtimeHome = await mkdtemp(join(tmpdir(), "mosoo-claude-query-options-"));
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

function createTestLogger() {
  return createBufferedSinkLogger({
    level: "debug",
    service: "claude-agent-sdk-query-options-test",
    sink: async () => {},
  });
}

afterEach(async () => {
  await Promise.all(
    runtimeHomes.map((runtimeHome) => rm(runtimeHome, { force: true, recursive: true })),
  );
  runtimeHomes = [];
});

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

  test("maps Mosoo built-in tool toggles into Claude SDK tool names", () => {
    const payload = createDriverStartInputFromBootPayload({
      ...driverBootPayload,
      execution: {
        ...driverBootPayload.execution,
        builtInTools: driverBootPayload.execution.builtInTools.map((tool) =>
          tool.name === "bash" || tool.name === "web_search"
            ? { enabled: false, name: tool.name }
            : tool,
        ),
      },
    });

    expect(toClaudeBuiltInTools(payload)).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
    ]);
  });

  test("passes reasoning effort, turn budget, and tools into Claude SDK query options", async () => {
    const runtimeHome = await createRuntimeHome();
    const payload = createDriverStartInputFromBootPayload({
      ...driverBootPayload,
      execution: {
        ...driverBootPayload.execution,
        builtInTools: driverBootPayload.execution.builtInTools.map((tool) =>
          tool.name === "bash" || tool.name === "web_search"
            ? { enabled: false, name: tool.name }
            : tool,
        ),
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        providerOptions: {
          effort: "max",
          maxTurns: 7,
        },
        session: {
          ...driverBootPayload.execution.session,
          context: {
            ...driverBootPayload.execution.session.context,
            homePath: runtimeHome,
            sessionOrganizationPath: runtimeHome,
          },
          cwd: runtimeHome,
        },
      },
      runtime: "claude-agent-sdk",
      runtimeTransport: "claude-agent-sdk",
    });
    const logger = createTestLogger();
    const context = createAgentDriverContext({
      eventSink: {
        pushEvents: async () => {},
      },
      logger,
      payload,
      permission: {
        request: async () => "allow_once",
      },
    });

    const options = await createClaudeQueryOptions({
      abortController: new AbortController(),
      context,
      nativeSessionId: null,
      payload,
    });
    await logger.destroy();

    expect(options).toMatchObject({
      effort: "max",
      maxTurns: 7,
      model: "claude-sonnet-4-5",
      permissionMode: "default",
      tools: ["Read", "Write", "Edit", "Glob", "Grep", "WebFetch"],
    });
  });
});
