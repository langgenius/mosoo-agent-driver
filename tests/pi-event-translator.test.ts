import { describe, expect, test } from "bun:test";

import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-event-envelope";
import { isJsonObject } from "../src/protocol/json";
import { PiEventTranslator } from "../src/runtimes/pi/pi-event-translator";
import { driverBootPayload, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

describe("Pi tool event contract", () => {
  test.each([
    { type: "tool_execution_update", isError: false, status: "running" },
    { type: "tool_execution_end", isError: false, status: "completed" },
    { type: "tool_execution_end", isError: true, status: "failed" },
  ])("accepts empty $status output through the Driver uplink", ({ type, isError, status }) => {
    const translator = new PiEventTranslator();
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "empty", name: "bash", arguments: { command: "true" } }],
        stopReason: "toolUse",
      },
    });
    translator.translate({
      type: "tool_execution_start",
      toolCallId: "empty",
      toolName: "bash",
      args: { command: "true" },
    });
    const events = translator.translate({
      type,
      toolCallId: "empty",
      toolName: "bash",
      isError,
      result: { content: [{ type: "text", text: "" }] },
      partialResult: { content: [{ type: "text", text: "" }] },
    });
    const canonical = events.flatMap((event) =>
      toDriverEventEnvelopes(
        { ...driverBootPayload, runtime: "pi", runtimeTransport: "pi-rpc" },
        event,
        DRIVER_TEST_IDS.runId,
      ),
    );
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.event.payload).toMatchObject({
      status,
      parentMessageId: expect.any(String),
    });
    expect(canonical[0]?.event.payload).not.toHaveProperty("rawOutput");
    if (type === "tool_execution_end")
      expect(canonical[0]?.event.payload).toHaveProperty("rawInput", '{"command":"true"}');
  });

  test("keeps each completed tool attached to its original assistant message", () => {
    const translator = new PiEventTranslator();
    const first = translator.translate({ type: "message_start", message: { role: "assistant" } });
    translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "shell", name: "bash", arguments: { command: "pwd" } },
          { type: "toolCall", id: "file", name: "read", arguments: { path: "proof.txt" } },
        ],
        stopReason: "toolUse",
      },
    });
    const started = translator.translate({
      type: "tool_execution_start",
      toolCallId: "shell",
      toolName: "bash",
      args: { command: "pwd" },
    });
    const updated = translator.translate({
      type: "tool_execution_update",
      toolCallId: "shell",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "/work" }] },
    });
    const completed = translator.translate({
      type: "tool_execution_end",
      toolCallId: "shell",
      toolName: "bash",
      result: { content: [{ type: "text", text: "/workspace" }] },
      isError: false,
    });
    expect(started[0]?.payload).toMatchObject({ status: "running", title: "bash" });
    expect(updated[0]?.payload).toMatchObject({ status: "running", rawOutput: "/work" });
    expect(completed[0]?.payload).toMatchObject({
      status: "completed",
      rawInput: '{"command":"pwd"}',
      rawOutput: "/workspace",
    });
    // Arguments are AG-UI deltas, so a full native argument object occurs once.
    expect(started[0]?.payload).not.toHaveProperty("rawInput");
    expect(updated[0]?.payload).not.toHaveProperty("rawInput");

    const next = translator.translate({ type: "message_start", message: { role: "assistant" } });
    translator.translate({
      type: "tool_execution_start",
      toolCallId: "file",
      toolName: "read",
      args: { path: "proof.txt" },
    });
    const failed = translator.translate({
      type: "tool_execution_end",
      toolCallId: "file",
      toolName: "read",
      result: { content: [{ type: "text", text: "File does not exist." }] },
      isError: true,
    });
    expect(failed[0]?.payload).toMatchObject({
      status: "failed",
      rawInput: '{"path":"proof.txt"}',
      rawOutput: "File does not exist.",
    });
    const firstPayload = first[0]?.payload;
    if (!isJsonObject(firstPayload)) throw new Error("Missing assistant message start.");
    const firstId = firstPayload["messageId"];
    expect(next[0]?.payload).not.toHaveProperty("messageId", firstId);
    for (const event of [...started, ...updated, ...completed, ...failed]) {
      expect(event.payload).toHaveProperty("parentMessageId", firstId);
      expect(event.payload).not.toHaveProperty("outputText");
    }
  });

  test("rejects unassociated tool output instead of publishing an invisible tool", () => {
    const translator = new PiEventTranslator();
    expect(() =>
      translator.translate({
        type: "tool_execution_start",
        toolCallId: "unknown",
        toolName: "read",
        args: { path: "proof.txt" },
      }),
    ).toThrow("Pi tool event has no assistant message.");
  });
});
