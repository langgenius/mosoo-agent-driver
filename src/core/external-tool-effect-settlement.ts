import type {
  McpExecuteCommand,
  McpExternalToolEffectSettlement,
  McpExternalToolExecutionResult,
} from "../runtime-command";
import {
  measureRuntimeCommandJson,
  RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
} from "../runtime-command";
const OVERSIZED_MCP_OUTPUT =
  "MCP tool output was omitted because its durable settlement exceeded the 1044480-byte limit.";

type McpResultIdentity = Pick<McpExecuteCommand, "requestId" | "serverId" | "toolName">;

function createOmittedSettlement(
  identity: McpResultIdentity,
): Extract<McpExternalToolEffectSettlement, { kind: "succeeded" }> {
  return {
    kind: "succeeded",
    result: { isError: true, outputText: OVERSIZED_MCP_OUTPUT, ...identity },
  };
}

/** Proves the fixed result identity is settleable before the provider may run. */
export function requireDurableMcpResultIdentity(command: McpResultIdentity): McpResultIdentity {
  const identity = {
    requestId: command.requestId,
    serverId: command.serverId,
    toolName: command.toolName,
  };

  if (
    measureRuntimeCommandJson(createOmittedSettlement(identity)) >
    RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES
  ) {
    throw new RangeError("MCP command identity exceeds the durable settlement byte limit.");
  }

  return identity;
}

/**
 * Keeps a known provider result durably settleable without retaining unbounded
 * diagnostic data or presenting an omitted response as a successful tool result.
 */
export function createDurableMcpSucceededSettlement(
  execution: McpExternalToolExecutionResult,
  identity: McpResultIdentity,
): Extract<McpExternalToolEffectSettlement, { kind: "succeeded" }> {
  const result = {
    ...(execution.isError === undefined ? {} : { isError: execution.isError }),
    outputText: execution.outputText,
    ...identity,
  };
  const settlement = {
    kind: "succeeded",
    ...(execution.providerReceiptJson === undefined
      ? {}
      : { providerReceiptJson: execution.providerReceiptJson }),
    result,
  } as const;

  if (measureRuntimeCommandJson(settlement) <= RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES) {
    return settlement;
  }

  const withoutReceipt = { kind: "succeeded", result } as const;
  if (
    measureRuntimeCommandJson(withoutReceipt) <= RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES
  ) {
    return withoutReceipt;
  }

  return createOmittedSettlement(identity);
}
