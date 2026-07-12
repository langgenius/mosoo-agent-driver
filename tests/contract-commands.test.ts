import { describe, expect, test } from "bun:test";

import { parseCommandUpdate, parseSessionCommand } from "../src/contract";

const ID = "01J0000000000000000000000A";
const TURN_ID = "01J0000000000000000000000N";

describe("session commands", () => {
  test("turn.start takes multimodal content-block input", () => {
    const command = parseSessionCommand({
      kind: "turn.start",
      id: ID,
      turnId: TURN_ID,
      input: [
        { type: "text", text: "fix the bug in" },
        { type: "resource_link", uri: "file:///w/a.ts", name: "a.ts" },
        { type: "image", mimeType: "image/png", data: "aGk=" },
      ],
    });

    expect(command.kind).toBe("turn.start");

    if (command.kind === "turn.start") {
      expect(command.input).toHaveLength(3);
    }

    expect(() =>
      parseSessionCommand({ kind: "turn.start", id: ID, turnId: TURN_ID, input: [] }),
    ).toThrow();
  });

  test("turn.steer and turn.cancel drive an in-flight turn", () => {
    expect(
      parseSessionCommand({
        kind: "turn.steer",
        id: ID,
        turnId: TURN_ID,
        input: [{ type: "text", text: "also add a test" }],
      }).kind,
    ).toBe("turn.steer");

    expect(
      parseSessionCommand({ kind: "turn.cancel", id: ID, reason: "user interrupt" }).kind,
    ).toBe("turn.cancel");
  });

  test("session.config.set carries typed values", () => {
    for (const value of [
      { type: "select", valueId: "claude-fable-5" },
      { type: "boolean", value: true },
      { type: "x_slider", amount: 0.7 },
    ]) {
      const command = parseSessionCommand({
        kind: "session.config.set",
        id: ID,
        configId: "model",
        value,
      });
      expect(command.kind).toBe("session.config.set");
    }
  });

  test("permission.resolve and input.resolve answer interaction requests", () => {
    const permission = parseSessionCommand({
      kind: "permission.resolve",
      id: ID,
      requestId: "req-1",
      outcome: { type: "selected", optionId: "allow_always" },
    });
    expect(permission.kind).toBe("permission.resolve");

    const input = parseSessionCommand({
      kind: "input.resolve",
      id: ID,
      requestId: "req-2",
      outcome: { type: "answered", answers: { q1: ["work"] } },
    });
    expect(input.kind).toBe("input.resolve");
  });

  test("mcp.execute takes structured arguments", () => {
    const command = parseSessionCommand({
      kind: "mcp.execute",
      id: ID,
      requestId: "req-3",
      serverId: "docs",
      toolName: "search",
      arguments: { query: "contract", limit: 5 },
    });

    expect(command.kind).toBe("mcp.execute");
  });

  test("rejects unknown command kinds and malformed commands", () => {
    expect(() => parseSessionCommand({ kind: "session.hibernate", id: ID })).toThrow();
    expect(() => parseSessionCommand({ kind: "session.stop", id: ID, reason: "" })).toThrow();
    expect(() =>
      parseSessionCommand({ kind: "turn.start", id: "nope", turnId: TURN_ID }),
    ).toThrow();
  });
});

describe("command updates", () => {
  test("reports command fate with typed results", () => {
    const update = parseCommandUpdate({
      commandId: ID,
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }], isError: false },
    });

    expect(update.status).toBe("completed");
  });

  test("failed updates require an error", () => {
    expect(() => parseCommandUpdate({ commandId: ID, status: "failed" })).toThrow();

    const update = parseCommandUpdate({
      commandId: ID,
      status: "failed",
      error: { code: "driver.mcp_execute_failed", message: "server unreachable", retryable: true },
    });
    expect(update.error?.code).toBe("driver.mcp_execute_failed");
  });
});
