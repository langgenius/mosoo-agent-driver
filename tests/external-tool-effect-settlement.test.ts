import { describe, expect, test } from "bun:test";
import {
  createMcpUnknownEffectRunError,
  createMcpUnsettledEffectRunError,
} from "@mosoo/agent-driver";

import {
  createDurableMcpSucceededSettlement,
  requireDurableMcpResultIdentity,
} from "../src/core/external-tool-effect-settlement";
import {
  measureRuntimeCommandJson,
  RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
  type McpExternalToolEffectSettlement,
  type McpExternalToolExecutionResult,
} from "../src/runtime-command";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

const RESULT = {
  outputText: "",
  requestId: "request-boundary",
  serverId: "server-boundary",
  toolName: "createIssue",
} as const;

function executionAtSettlementSize(byteLength: number, unit = "x"): McpExternalToolExecutionResult {
  const create = (outputText: string) => succeeded({ ...RESULT, outputText });
  const baseBytes = measureRuntimeCommandJson(create(""));
  const unitBytes = measureRuntimeCommandJson(create(unit)) - baseBytes;
  const outputBytes = byteLength - baseBytes;

  if (outputBytes < 0) {
    throw new Error("Requested settlement size is smaller than its fixed fields.");
  }

  return {
    ...RESULT,
    outputText:
      unit.repeat(Math.floor(outputBytes / unitBytes)) + "x".repeat(outputBytes % unitBytes),
  };
}

function succeeded(execution: McpExternalToolExecutionResult): McpExternalToolEffectSettlement {
  const { providerReceiptJson, ...result } = execution;
  return {
    kind: "succeeded",
    ...(providerReceiptJson === undefined ? {} : { providerReceiptJson }),
    result,
  };
}

describe("durable MCP succeeded settlement", () => {
  test("defines the exact cross-process repair failures", () => {
    const command = {
      commandId: "command-repair",
      requestId: RESULT.requestId,
      runId: DRIVER_TEST_IDS.runId,
      serverId: RESULT.serverId,
      toolName: RESULT.toolName,
    };

    expect(createMcpUnknownEffectRunError(command, "effect-repair")).toEqual({
      code: "driver.external_tool_effect_unknown",
      details: { ...command, effectId: "effect-repair" },
      message:
        "External effect effect-repair for MCP tool createIssue has an unknown outcome and will not be replayed.",
      retryable: false,
    });
    expect(createMcpUnsettledEffectRunError(command, "effect-repair")).toEqual({
      code: "driver.command_failed.mcp.execute",
      details: { commandId: command.commandId, commandKind: "mcp.execute" },
      message:
        "External effect effect-repair for MCP tool createIssue requires server-side repair.",
      retryable: false,
    });
  });

  test.each(["x", "界", "\0"])(
    "preserves the exact %p byte limit and omits output at limit plus one",
    (unit) => {
      const exactExecution = executionAtSettlementSize(
        RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
        unit,
      );
      const identity = requireDurableMcpResultIdentity(RESULT);
      const exact = createDurableMcpSucceededSettlement(exactExecution, identity);
      expect(measureRuntimeCommandJson(exact)).toBe(
        RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
      );
      expect(exact.result).toEqual(exactExecution);

      const oversized = createDurableMcpSucceededSettlement(
        executionAtSettlementSize(RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES + 1, unit),
        identity,
      );
      expect(oversized).toEqual({
        kind: "succeeded",
        result: {
          ...RESULT,
          isError: true,
          outputText:
            "MCP tool output was omitted because its durable settlement exceeded the 1044480-byte limit.",
        },
      });
      expect(measureRuntimeCommandJson(oversized)).toBeLessThanOrEqual(
        RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
      );
    },
  );

  test.each([
    ["escaped", "\0".repeat(Math.ceil(RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES / 6))],
    ["Unicode", "界".repeat(Math.ceil(RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES / 3))],
  ])("measures %s output after JSON escaping and UTF-8 encoding", (_label, outputText) => {
    const execution = { ...RESULT, outputText };
    expect(outputText.length).toBeLessThan(RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES);
    expect(measureRuntimeCommandJson(succeeded(execution))).toBeGreaterThan(
      RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
    );

    const normalized = createDurableMcpSucceededSettlement(
      execution,
      requireDurableMcpResultIdentity(RESULT),
    );
    expect(normalized.kind).toBe("succeeded");
    expect(normalized.result.isError).toBeTrue();
    expect(normalized.result.outputText).toContain("output was omitted");
  });

  test("drops an oversized diagnostic receipt before changing provider output", () => {
    const execution = {
      ...RESULT,
      outputText: "provider result",
      providerReceiptJson: JSON.stringify({
        diagnostic: "r".repeat(RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES),
      }),
    };
    expect(measureRuntimeCommandJson(succeeded(execution))).toBeGreaterThan(
      RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
    );

    expect(
      createDurableMcpSucceededSettlement(execution, requireDurableMcpResultIdentity(RESULT)),
    ).toEqual({
      kind: "succeeded",
      result: { ...RESULT, outputText: "provider result" },
    });
  });

  test("rejects an unpersistable result identity before execution", () => {
    expect(() =>
      requireDurableMcpResultIdentity({
        ...RESULT,
        requestId: "r".repeat(RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES),
      }),
    ).toThrow("MCP command identity exceeds the durable settlement byte limit.");
  });
});
