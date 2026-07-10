import type { DriverEventInput } from "../protocol/events";
import type { DriverExecutionInput } from "../protocol/execution";
import type { DriverHostIntegrationSnapshot } from "../protocol/host-integration";
import type { RunId } from "../protocol/id";
import type { DriverEventBatchOutput } from "../protocol/orpc";
import type { McpExecuteCommand, RuntimeCommand, RuntimeCommandResult } from "../runtime-command";

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
  commandUpdate(input: {
    commandId: string;
    result?: RuntimeCommandResult;
    status: "accepted" | "cancelled" | "completed" | "failed";
  }, signal: AbortSignal): Promise<void>;
  currentRunId?(): RunId | null;
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
  ): Promise<{
    outputText: string;
    requestId: string;
    serverId: string;
    toolName: string;
  }>;
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
