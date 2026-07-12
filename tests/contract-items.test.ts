import { describe, expect, test } from "bun:test";

import {
  applySessionItemPatch,
  contentBlockText,
  parseSessionItem,
  parseSessionItemPatch,
} from "../src/contract";
import type { MessageItem, ToolCallItem } from "../src/contract";

describe("session items", () => {
  test("message item carries structured content blocks", () => {
    const item = parseSessionItem({
      kind: "message",
      itemId: "m1",
      role: "agent",
      phase: "final",
      content: [
        { type: "text", text: "see the diagram" },
        { type: "image", mimeType: "image/png", data: "aGk=" },
        { type: "resource_link", uri: "file:///workspace/a.ts", name: "a.ts" },
      ],
    }) as MessageItem;

    expect(item.role).toBe("agent");
    expect(item.content).toHaveLength(3);
    expect(contentBlockText(item.content[0])).toBe("see the diagram");
    expect(contentBlockText(item.content[1])).toBe("[image]");
    expect(contentBlockText(item.content[2])).toBe("[resource_link: a.ts]");
  });

  test("image content requires data or uri", () => {
    expect(() =>
      parseSessionItem({
        kind: "message",
        itemId: "m1",
        role: "user",
        content: [{ type: "image", mimeType: "image/png" }],
      }),
    ).toThrow();
  });

  test("reasoning item keeps indexed summary and content parts", () => {
    const item = parseSessionItem({
      kind: "reasoning",
      itemId: "r1",
      summary: ["first section", "second section"],
      content: ["raw chain of thought"],
    });

    expect(item).toMatchObject({ summary: ["first section", "second section"] });
  });

  test("plan item entries carry status and priority", () => {
    const item = parseSessionItem({
      kind: "plan",
      itemId: "p1",
      entries: [
        { content: "read the code", status: "completed", priority: "high" },
        { content: "write the fix", status: "in_progress" },
      ],
    });

    expect(item).toMatchObject({ entries: [{ status: "completed" }, { status: "in_progress" }] });
  });

  test("command item covers codex commandExecution granularity", () => {
    const item = parseSessionItem({
      kind: "command",
      itemId: "c1",
      command: "rg --files | head",
      cwd: "/workspace",
      status: "completed",
      actions: [
        { type: "search", command: "rg --files" },
        { type: "unknown", command: "head" },
      ],
      output: "a.ts\nb.ts\n",
      exitCode: 0,
      durationMs: 42,
      processId: "pty-7",
      source: "agent",
    });

    expect(item).toMatchObject({ exitCode: 0, actions: [{ type: "search" }, { type: "unknown" }] });
  });

  test("file_change item merges codex changes and ACP v2 diff ops", () => {
    const item = parseSessionItem({
      kind: "file_change",
      itemId: "f1",
      status: "completed",
      changes: [
        { path: "/w/a.ts", op: "modify", diff: "--- a\n+++ b\n" },
        { path: "/w/b.png", op: "add", fileType: "binary", diff: null },
        { path: "/w/new.ts", op: "move", oldPath: "/w/old.ts" },
      ],
    });

    expect(item).toMatchObject({
      changes: [{ op: "modify" }, { fileType: "binary" }, { op: "move" }],
    });
    expect(() =>
      parseSessionItem({ kind: "file_change", itemId: "f1", status: "completed", changes: [] }),
    ).toThrow();
  });

  test("tool_call item keeps ACP classification and MCP-shaped output", () => {
    const item = parseSessionItem({
      kind: "tool_call",
      itemId: "t1",
      name: "search_docs",
      title: "Searching docs",
      category: "search",
      origin: "mcp",
      server: "docs",
      status: "completed",
      input: { query: "contract" },
      output: {
        content: [{ type: "text", text: "3 results" }],
        structured: { hits: 3 },
        isError: false,
      },
      locations: [{ path: "/w/docs/contract.md", line: 12 }],
      progressMessage: "done",
      durationMs: 88,
    }) as ToolCallItem;

    expect(item.output?.structured).toEqual({ hits: 3 });
    expect(item.locations).toEqual([{ path: "/w/docs/contract.md", line: 12 }]);
  });

  test("extension items carry vendor granularity", () => {
    const item = parseSessionItem({
      kind: "x_codex_web_search",
      itemId: "w1",
      status: "completed",
      payload: { query: "zig allocator", action: { type: "search" } },
    });

    expect(item).toMatchObject({ kind: "x_codex_web_search" });

    const future = parseSessionItem({ kind: "hologram", itemId: "h1" });
    expect(future.kind).toBe("hologram");
  });

  test("rejects malformed typed items loudly", () => {
    expect(() =>
      parseSessionItem({ kind: "message", itemId: "m1", role: "bot", content: [] }),
    ).toThrow();
    expect(() => parseSessionItem({ kind: "tool_call", itemId: "t1" })).toThrow();
    expect(() => parseSessionItem({ itemId: "t1" })).toThrow();
  });
});

describe("item patches", () => {
  test("typed patches validate against the item schema minus identity", () => {
    expect(parseSessionItemPatch("command", { status: "completed", exitCode: 1 })).toEqual({
      status: "completed",
      exitCode: 1,
    });
    expect(() => parseSessionItemPatch("command", { exitCode: "one" })).toThrow();
    expect(parseSessionItemPatch("x_custom", { anything: true })).toEqual({ anything: true });
  });

  test("applySessionItemPatch replaces per-field and preserves identity", () => {
    const item = parseSessionItem({
      kind: "tool_call",
      itemId: "t1",
      name: "run",
      status: "in_progress",
      input: { a: 1 },
    }) as ToolCallItem;

    const patched = applySessionItemPatch(item, {
      status: "completed",
      itemId: "hijack",
      kind: "message",
    });

    expect(patched.itemId).toBe("t1");
    expect(patched.kind).toBe("tool_call");
    expect(patched.status).toBe("completed");
    expect(patched.input).toEqual({ a: 1 });
  });
});
