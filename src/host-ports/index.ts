import type { DriverEventInput } from "../protocol/events";
import type { DriverExecutionInput } from "../protocol/execution";
import type { DriverHostIntegrationSnapshot } from "../protocol/host-integration";
import type { RunId } from "../protocol/id";
import type { DriverEventBatchOutput } from "../protocol/orpc";
import type {
  McpExecuteCommand,
  McpExecuteCommandResult,
  McpExternalToolEffectClaim,
  McpExternalToolEffectExecution,
  McpExternalToolExecutionResult,
  RuntimeCommand,
  RuntimeCommandResult,
} from "../runtime-command";

export type AgentDriverHostPortName =
  | "command_source"
  | "event_sink"
  | "permission"
  | "mcp"
  | "skill"
  | "file"
  | "host_integration";

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
  currentRunId?(): RunId | null;
  markExternalToolEffectUnknown?(input: { commandId: string }, signal: AbortSignal): Promise<void>;
  pushEvents(input: {
    events: DriverEventInput[];
    signal?: AbortSignal;
  }): Promise<DriverEventBatchOutput>;
}

export interface AgentDriverPermissionPort {
  request(
    input: {
      rawInput: string | null;
      requestId: string;
      title: string;
      toolCallId: string | null;
      toolKind: string | null;
    },
    signal?: AbortSignal,
  ): Promise<"allow_once" | "reject_once">;
}

export interface AgentDriverMcpPort {
  execute(
    command: McpExecuteCommand,
    signal: AbortSignal,
    effect?: McpExternalToolEffectExecution,
  ): Promise<McpExternalToolExecutionResult>;
}

export interface AgentDriverMaterializedSkill {
  readonly mountPath: string;
  readonly skillId: string;
  readonly skillMarkdownPath: string;
  readonly skillName: string;
  readonly snapshotId: string;
}

export interface AgentDriverSkillPort {
  materialize(execution: DriverExecutionInput): Promise<readonly AgentDriverMaterializedSkill[]>;
}

export interface AgentDriverFilePort {
  reportChanged(input: {
    change: "delete" | "upsert";
    path: string;
    reason: string;
  }): Promise<void>;
}

export interface AgentDriverHostIntegrationPort {
  snapshot(): Promise<DriverHostIntegrationSnapshot | null>;
}

export interface AgentDriverHostPorts {
  commandSource: AgentDriverCommandSource;
  eventSink: AgentDriverEventSink;
  file: AgentDriverFilePort;
  hostIntegration: AgentDriverHostIntegrationPort;
  mcp: AgentDriverMcpPort;
  permission: AgentDriverPermissionPort;
  skill: AgentDriverSkillPort;
}
