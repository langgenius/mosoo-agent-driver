import { describe, expect, test } from "bun:test";

import { createSessionEventFactory, parseSessionEvent } from "../src/contract";
import type { SessionEventFactory } from "../src/contract";
import { createDriverId } from "../src/protocol/id";

/**
 * Conformance evidence for docs/contract.md: representative native payloads
 * from Codex app-server v2 and ACP v2 map onto the contract WITHOUT losing a
 * field. These are the mappings the future protocol adapters implement.
 */

const SESSION_ID = "01J0000000000000000000000K";
const TURN_ID = "01J0000000000000000000000N";

function factory(): SessionEventFactory {
  return createSessionEventFactory({ sessionId: SESSION_ID, createId: () => createDriverId() });
}

describe("codex app-server v2 granularity", () => {
  test("item/started commandExecution keeps every codex field", () => {
    // Native: item/started { item: { type: "commandExecution", ... } }
    const native = {
      id: "item_3",
      command: "rg --files -g '*.rs' | head",
      cwd: "/workspace/codex",
      processId: "pty-11",
      source: "agent",
      status: "inProgress",
      commandActions: [{ type: "search", command: "rg --files -g '*.rs'" }],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };

    const event = factory().emit(
      "item.started",
      {
        item: {
          kind: "command",
          itemId: native.id,
          command: native.command,
          cwd: native.cwd,
          processId: native.processId,
          source: "agent",
          status: "in_progress",
          actions: [{ type: "search", command: "rg --files -g '*.rs'" }],
        },
      },
      {
        turnId: TURN_ID,
        native: { provider: "openai-app-server", eventName: "item/started", itemId: native.id },
      },
    );

    expect(event.payload.item).toMatchObject({
      command: native.command,
      cwd: native.cwd,
      processId: native.processId,
    });
    expect(event.native?.eventName).toBe("item/started");
  });

  test("reasoning summary/content deltas keep their part indices", () => {
    const events = factory();
    // Native: item/reasoning/summaryTextDelta { itemId, delta, summaryIndex: 1 }
    const summary = events.emit(
      "item.delta",
      { itemId: "item_5", stream: "reasoning_summary", index: 1, delta: "Weighing options…" },
      { turnId: TURN_ID },
    );
    // Native: item/reasoning/textDelta { itemId, delta, contentIndex: 0 } —
    // the old contract DROPPED this stream entirely.
    const raw = events.emit(
      "item.delta",
      { itemId: "item_5", stream: "reasoning", index: 0, delta: "The allocator must…" },
      { turnId: TURN_ID },
    );

    expect(summary.payload.index).toBe(1);
    expect(raw.payload.stream).toBe("reasoning");
  });

  test("command approval request keeps codex decision granularity via options", () => {
    // Native: item/commandExecution/requestApproval with proposed amendments
    // and availableDecisions [accept, acceptForSession,
    // acceptWithExecpolicyAmendment, decline, cancel].
    const event = factory().emit(
      "permission.requested",
      {
        requestId: "req_9",
        itemId: "item_3",
        title: "Run `cargo test`?",
        description: "Requires network access",
        detail: {
          type: "command",
          command: "cargo test",
          cwd: "/workspace/codex",
          reason: "network access",
        },
        options: [
          { optionId: "accept", name: "Allow once", kind: "allow_once" },
          { optionId: "acceptForSession", name: "Allow for session", kind: "allow_always" },
          {
            optionId: "acceptWithExecpolicyAmendment",
            name: "Always allow cargo test",
            kind: "allow_always",
            meta: { execpolicyAmendment: ["cargo", "test"] },
          },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
          {
            optionId: "cancel",
            name: "Cancel turn",
            kind: "reject_once",
            meta: { interrupts: true },
          },
        ],
      },
      { turnId: TURN_ID },
    );

    expect(event.payload.options).toHaveLength(5);
    expect(event.payload.options[2]?.meta).toEqual({ execpolicyAmendment: ["cargo", "test"] });
  });

  test("request_user_input maps onto input.requested without loss", () => {
    // Native: item/tool/requestUserInput { questions: [{ id, header, question,
    // isSecret, options }] }
    const event = factory().emit(
      "input.requested",
      {
        requestId: "req_12",
        itemId: "item_8",
        questions: [
          {
            questionId: "q_env",
            header: "Environment",
            question: "Which environment should I deploy to?",
            options: [
              { label: "staging", description: "safe" },
              { label: "production", description: "careful" },
            ],
            allowFreeform: false,
            secret: false,
          },
        ],
      },
      { turnId: TURN_ID },
    );

    expect(event.payload.questions[0]).toMatchObject({ header: "Environment" });
  });

  test("codex items outside the typed core survive as extension items", () => {
    // Native: item/completed { item: { type: "webSearch", id, query, action } }
    const event = factory().emit(
      "item.completed",
      {
        item: {
          kind: "x_codex_web_search",
          itemId: "item_9",
          status: "completed",
          payload: { query: "bun ffi", action: { type: "openPage", url: "https://bun.sh" } },
        },
      },
      { turnId: TURN_ID },
    );

    expect(event.payload.item).toMatchObject({
      payload: { action: { type: "openPage", url: "https://bun.sh" } },
    });
  });

  test("thread/tokenUsage/updated keeps total + last breakdowns and context window", () => {
    const event = factory().emit("usage.updated", {
      tokens: { input: 5000, cachedInput: 4000, output: 800, reasoningOutput: 300, total: 5800 },
      lastTokens: { input: 900, cachedInput: 700, output: 120, reasoningOutput: 40, total: 1020 },
      context: { usedTokens: 5800, maxTokens: 272000 },
    });

    expect(event.payload.lastTokens?.reasoningOutput).toBe(40);
    expect(event.payload.context?.maxTokens).toBe(272000);
  });

  test("turn failure carries codexErrorInfo-grade detail", () => {
    const event = factory().emit(
      "turn.completed",
      {
        status: "failed",
        error: {
          code: "codex.response_stream_connection_failed",
          message: "stream disconnected",
          retryable: true,
          detail: { httpStatusCode: 502 },
        },
      },
      { turnId: TURN_ID },
    );

    expect(event.payload.error?.detail).toEqual({ httpStatusCode: 502 });
  });
});

describe("ACP v2 granularity", () => {
  test("tool_call_update upsert maps to item.updated with full field fidelity", () => {
    // Native: session/update { sessionUpdate: "tool_call_update", toolCallId,
    // title, kind, status, locations, rawInput }
    const event = factory().emit(
      "item.updated",
      {
        itemId: "call_001",
        kind: "tool_call",
        patch: {
          title: "Reading configuration",
          category: "read",
          status: "in_progress",
          locations: [{ path: "/workspace/config.toml", line: 12 }],
          input: { path: "/workspace/config.toml" },
        },
      },
      { turnId: TURN_ID, native: { provider: "acp", eventName: "tool_call_update" } },
    );

    expect(event.payload.patch).toMatchObject({
      category: "read",
      locations: [{ path: "/workspace/config.toml", line: 12 }],
    });
  });

  test("structured content blocks survive end to end (no string flattening)", () => {
    // Native: agent_message_chunk { content: { type: "image", data, mimeType } }
    const event = factory().emit(
      "item.completed",
      {
        item: {
          kind: "message",
          itemId: "msg_2",
          role: "agent",
          content: [
            { type: "text", text: "rendered chart:" },
            { type: "image", mimeType: "image/png", data: "aGk=" },
            {
              type: "resource",
              resource: { uri: "file:///w/report.md", mimeType: "text/markdown", text: "# Report" },
            },
          ],
        },
      },
      { turnId: TURN_ID },
    );

    const item = event.payload.item;
    expect(item.kind).toBe("message");

    if (item.kind === "message") {
      expect(item.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(item.content[2]).toMatchObject({ resource: { text: "# Report" } });
    }
  });

  test("ACP v2 structured diffs map to file_change items", () => {
    // Native: tool_call content { type: "diff", changes: [...], patch: { format:
    // "git_patch", diff } }
    const event = factory().emit(
      "item.completed",
      {
        item: {
          kind: "file_change",
          itemId: "call_7",
          status: "completed",
          changes: [
            { path: "/w/old_file.txt", op: "delete", fileType: "text" },
            { path: "/w/renamed.ts", op: "move", oldPath: "/w/original.ts", fileType: "text" },
            { path: "/w/logo.png", op: "add", fileType: "binary", diff: null },
          ],
          meta: { patchFormat: "git_patch" },
        },
      },
      { turnId: TURN_ID },
    );

    expect(event.payload.item).toMatchObject({
      changes: [{ op: "delete" }, { oldPath: "/w/original.ts" }, { fileType: "binary" }],
    });
  });

  test("plan_update replaces entries per plan id", () => {
    const event = factory().emit(
      "item.updated",
      {
        itemId: "plan_main",
        kind: "plan",
        patch: {
          entries: [
            { content: "Check for syntax errors", status: "completed", priority: "high" },
            { content: "Identify the root cause", status: "in_progress", priority: "high" },
          ],
        },
      },
      { turnId: TURN_ID },
    );

    expect(event.payload.patch["entries"]).toHaveLength(2);
  });

  test("session config options and available commands round-trip", () => {
    const events = factory();
    const config = events.emit("session.config.updated", {
      options: [
        {
          configId: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValueId: "code",
          options: [
            { valueId: "ask", name: "Ask" },
            { valueId: "code", name: "Code" },
          ],
        },
      ],
    });
    const commands = events.emit("session.commands.updated", {
      commands: [{ name: "web", description: "Search the web", inputHint: "query" }],
    });

    expect(config.payload.options[0]).toMatchObject({ currentValueId: "code" });
    expect(commands.payload.commands[0]).toMatchObject({ name: "web" });
  });

  test("state_update stop reasons survive on turn.completed", () => {
    const event = factory().emit(
      "turn.completed",
      { status: "completed", stopReason: "max_turns" },
      { turnId: TURN_ID },
    );

    expect(event.payload.stopReason).toBe("max_turns");
  });

  test("unknown ACP session updates flow through as extension events", () => {
    // Native: a future or _vendor sessionUpdate discriminant the driver does
    // not know. Adapters forward it without interpretation.
    const raw = {
      id: createDriverId(),
      seq: 40,
      sessionId: SESSION_ID,
      at: "2026-07-13T00:00:00.000Z",
      kind: "x_acp_session_update",
      payload: { sessionUpdate: "_zed_prediction", confidence: 0.9 },
      native: { provider: "acp", eventName: "_zed_prediction" },
    };

    const event = parseSessionEvent(raw);

    expect(event.payload).toMatchObject({ confidence: 0.9 });
  });
});
