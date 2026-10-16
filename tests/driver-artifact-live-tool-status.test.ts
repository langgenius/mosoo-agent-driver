import { describe, expect, test } from "bun:test";

import {
  CANONICAL_TOOL_CALL_STATUSES,
  inspectToolCallUpdateLifecycle,
  isCanonicalToolCallStatus,
} from "./driver-artifact-live-tool-status";

describe("packed driver tool call status predicate", () => {
  test("accepts every canonical protocol status", () => {
    expect(CANONICAL_TOOL_CALL_STATUSES).toEqual(["cancelled", "completed", "failed", "running"]);

    for (const status of CANONICAL_TOOL_CALL_STATUSES) {
      expect(isCanonicalToolCallStatus(status)).toBe(true);
    }
  });

  test.each(["", "queued", "pending", "unknown"])('rejects "%s"', (status) => {
    expect(isCanonicalToolCallStatus(status)).toBe(false);
  });

  test("allows authoritative terminal patches without reopening the tool", () => {
    expect(inspectToolCallUpdateLifecycle(["running", "failed", "failed"])).toEqual({
      firstTerminalIndex: 1,
      hasRunningUpdate: true,
      runningAfterTerminal: false,
      terminalStatuses: ["failed", "failed"],
    });
  });

  test("detects a running update after terminal status", () => {
    expect(inspectToolCallUpdateLifecycle(["running", "completed", "running"])).toEqual({
      firstTerminalIndex: 1,
      hasRunningUpdate: true,
      runningAfterTerminal: true,
      terminalStatuses: ["completed"],
    });
  });
});
