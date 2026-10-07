import { expect, test } from "bun:test";

import { readPiSessionHeader } from "../src/runtimes/pi/pi-session-validation";

test("native restore accepts Pi v3 context variants, metadata, and extension fields", () => {
  const timestamp = "2026-10-07T00:00:00.000Z";
  const text = { type: "text", text: "Remember this.", textSignature: "native-signature" };
  const image = { type: "image", data: "AA==", mimeType: "image/png" };
  const messages = [
    { role: "system", content: [text] },
    { role: "user", content: [text, image] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", redacted: true, thinkingSignature: "native-signature" },
        text,
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "proof.txt" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      isError: false,
      content: [text, image],
    },
    {
      role: "bashExecution",
      command: "pwd",
      output: "/workspace",
      cancelled: false,
      truncated: false,
      excludeFromContext: true,
    },
    {
      role: "custom",
      customType: "extension-state",
      content: "Custom text",
      display: false,
      details: { revision: 1 },
    },
    { role: "branchSummary", summary: "Earlier branch", fromId: null },
    { role: "compactionSummary", summary: "Earlier conversation", tokensBefore: 100 },
  ];
  const records: object[] = [
    { type: "session", version: 3, id: "native-session", timestamp, cwd: "/workspace" },
  ];
  let parentId: string | null = null;
  for (const [index, message] of messages.entries()) {
    const id = `message-${index}`;
    records.push({
      type: "message",
      id,
      parentId,
      timestamp,
      message: { ...message, timestamp: 1 },
    });
    parentId = id;
  }
  const entries = [
    { type: "thinking_level_change", thinkingLevel: "off" },
    { type: "model_change", provider: "mosoo", modelId: "pi-test" },
    { type: "usage", kind: "cache_warm", provider: "mosoo", model: "pi-test", usage: {} },
    { type: "custom", customType: "extension-data", data: { nested: [1, null] } },
    { type: "label", targetId: "message-1", label: "User prompt" },
    { type: "session_info", name: "Restored session" },
    {
      type: "branch_summary",
      fromId: "historical-branch-outside-this-file",
      summary: "Earlier branch",
    },
    { type: "custom_message", customType: "extension-data", content: [text, image], display: true },
    { type: "context_edit", targetId: "message-1", replacement: null },
    {
      type: "compaction",
      summary: "Conversation summary",
      tokensBefore: 100,
      firstKeptEntryId: "message-0",
    },
  ];
  for (const [index, entry] of entries.entries()) {
    const id = `entry-${index}`;
    records.push({ ...entry, id, parentId, timestamp });
    parentId = id;
  }
  expect(readPiSessionHeader(records.map((entry) => JSON.stringify(entry)).join("\n"))).toEqual({
    cwd: "/workspace",
  });
});
