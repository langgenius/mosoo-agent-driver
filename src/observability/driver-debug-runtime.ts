import type { DriverPermissionRequest } from "../host-ports";
import type { RuntimeCommand, RuntimeCommandInput, RuntimeCommandResult } from "../runtime-command";
import { summarizeTextDigest } from "./driver-debug-paths";

export function summarizeRuntimeCommandInput(input: RuntimeCommandInput): Record<string, unknown> {
  return {
    text: summarizeTextDigest(input.text),
  };
}

export function summarizeRuntimeCommand(command: RuntimeCommand): Record<string, unknown> {
  const base = {
    commandId: command.commandId,
    kind: command.kind,
  };

  switch (command.kind) {
    case "input.start": {
      return {
        ...base,
        input: summarizeRuntimeCommandInput(command.input),
        requestId: command.requestId,
        runId: command.runId,
      };
    }
    case "mcp.execute": {
      return {
        ...base,
        arguments: summarizeTextDigest(command.argumentsJson),
        requestId: command.requestId,
        runId: command.runId,
        serverId: command.serverId,
        toolName: command.toolName,
      };
    }
    case "permission.resolve": {
      return {
        ...base,
        decision: command.decision,
        requestId: command.requestId,
        runId: command.runId ?? null,
      };
    }
    case "turn.cancel": {
      return {
        ...base,
        reason: command.reason ?? null,
        runId: command.runId ?? null,
      };
    }
    case "session.stop": {
      return {
        ...base,
        reason: "reason" in command ? (command.reason ?? null) : null,
      };
    }
    default: {
      return base;
    }
  }
}

export function summarizeRuntimeCommandResult(
  result: RuntimeCommandResult | undefined,
): Record<string, unknown> | null {
  if (result === undefined || result === null) {
    return null;
  }

  if ("outputText" in result) {
    return {
      kind: "mcp_execute",
      outputText: summarizeTextDigest(result.outputText),
      requestId: result.requestId,
      serverId: result.serverId,
      toolName: result.toolName,
    };
  }

  if ("requestId" in result) {
    return {
      kind: "input_start",
      requestId: result.requestId,
    };
  }

  return {
    kind: "unknown",
  };
}

export function summarizeDriverPermissionRequest(
  input: DriverPermissionRequest,
): Record<string, unknown> {
  return {
    agentId: input.agentId,
    blockedPath: summarizeTextDigest(input.blockedPath ?? null),
    decisionReason: summarizeTextDigest(input.decisionReason ?? null),
    description: summarizeTextDigest(input.description ?? null),
    matchedAskRule:
      input.matchedAskRule === undefined
        ? undefined
        : {
            ruleContent: summarizeTextDigest(input.matchedAskRule.ruleContent ?? null),
            source: input.matchedAskRule.source,
            toolName: input.matchedAskRule.toolName,
          },
    rawInput: summarizeTextDigest(input.rawInput),
    requestId: input.requestId,
    title: summarizeTextDigest(input.title),
    toolCallIdPresent: input.toolCallId !== null,
    toolKind: input.toolKind,
  };
}
