import type { DriverEventInput } from "../protocol/events";
import type { DriverExecutionInput } from "../protocol/execution";
import type { RunId } from "../protocol/id";
import type { DriverEventBatchOutput } from "../protocol/orpc";
import type {
  McpExecuteCommand,
  McpExecuteCommandResult,
  McpExternalToolEffectClaim,
  McpExternalToolEffectExecution,
  McpExternalToolExecutionResult,
  RunError,
  RuntimeCommand,
  RuntimeCommandResult,
} from "../runtime-command";

export interface AgentDriverCommandSource {
  nextCommand(signal: AbortSignal): Promise<RuntimeCommand | null>;
}

export interface AgentDriverEventSink {
  claimExternalToolEffect?(
    input: { commandId: string },
    signal: AbortSignal,
  ): Promise<McpExternalToolEffectClaim>;
  commandUpdate(
    input: {
      commandId: string;
      error?: RunError;
      result?: RuntimeCommandResult;
      status: "accepted" | "cancelled" | "completed" | "failed";
    },
    signal: AbortSignal,
  ): Promise<void>;
  completeExternalToolEffect?(
    input: {
      commandId: string;
      providerReceiptJson?: string | null | undefined;
      result: McpExecuteCommandResult;
    },
    signal: AbortSignal,
  ): Promise<void>;
  currentRunId(): RunId | null;
  markExternalToolEffectUnknown?(input: { commandId: string }, signal: AbortSignal): Promise<void>;
  pushEvents(input: {
    events: DriverEventInput[];
    signal?: AbortSignal;
  }): Promise<DriverEventBatchOutput>;
}

export interface AgentDriverPermissionPort {
  request(
    input: DriverPermissionRequest,
    signal?: AbortSignal,
  ): Promise<"allow_once" | "reject_once">;
}

export interface DriverPermissionRequest {
  agentId?: string;
  blockedPath?: string;
  decisionReason?: string;
  description?: string;
  matchedAskRule?: {
    readonly ruleContent?: string;
    readonly source: string;
    readonly toolName: string;
  };
  rawInput: string | null;
  requestId: string;
  title: string;
  toolCallId: string | null;
  toolKind: string | null;
}

export interface AgentDriverMcpExecution extends AsyncDisposable {
  execute(effect: McpExternalToolEffectExecution): Promise<McpExternalToolExecutionResult>;
}

export interface AgentDriverMcpPort {
  prepare(command: McpExecuteCommand, signal: AbortSignal): Promise<AgentDriverMcpExecution>;
}

export interface AgentDriverMaterializedSkill {
  readonly mountPath: string;
  readonly skillId: string;
  readonly skillMarkdownPath: string;
  readonly skillName: string;
  readonly snapshotId: string;
}

export interface AgentDriverSkillPort {
  materialize(
    execution: DriverExecutionInput,
    signal: AbortSignal,
  ): Promise<readonly AgentDriverMaterializedSkill[]>;
}

export interface AgentDriverFilePort {
  reportChanged(input: {
    change: "delete" | "upsert";
    path: string;
    reason: string;
  }): Promise<void>;
}

export interface AgentDriverHostPorts {
  commandSource: AgentDriverCommandSource;
  eventSink: AgentDriverEventSink;
  file: AgentDriverFilePort;
  mcp: AgentDriverMcpPort;
  permission: AgentDriverPermissionPort;
  skill: AgentDriverSkillPort;
}
