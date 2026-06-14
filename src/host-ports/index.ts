import type { Logger } from "../observability";
import type { DriverAppAccessSnapshotOutput } from "../protocol/boot";
import type { DriverEventInput } from "../protocol/events";
import type { DriverExecutionInput } from "../protocol/execution";
import type { DriverHostIntegrationSnapshot } from "../protocol/host-integration";
import type { McpExecuteCommand, RuntimeCommand, RuntimeCommandResult } from "../runtime-command";

export type AgentDriverHostPortName =
  | "command_source"
  | "event_sink"
  | "permission"
  | "access"
  | "mcp"
  | "skill"
  | "file"
  | "host_integration"
  | "logger"
  | "policy";

export interface AgentDriverCommandSource {
  nextCommand(): Promise<RuntimeCommand | null>;
}

export interface AgentDriverEventSink {
  commandUpdate(input: {
    commandId: string;
    result?: RuntimeCommandResult;
    status: "accepted" | "cancelled" | "completed" | "failed";
  }): Promise<void>;
  pushEvents(input: { events: DriverEventInput[] }): Promise<void>;
}

export interface AgentDriverPermissionPort {
  request(input: {
    rawInput: string | null;
    requestId: string;
    title: string;
    toolCallId: string | null;
    toolKind: string | null;
  }): Promise<"allow_once" | "reject_once">;
}

export interface AgentDriverAccessPort {
  refresh(snapshot: DriverAppAccessSnapshotOutput): Promise<void>;
}

export interface AgentDriverMcpPort {
  execute(command: McpExecuteCommand): Promise<{
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

export interface AgentDriverLoggerPort {
  logger(): Logger;
}

export interface AgentDriverPolicyPort {
  assertSupported(input: { capability: string; subject: string }): Promise<void>;
}

export interface AgentDriverHostPorts {
  access: AgentDriverAccessPort;
  commandSource: AgentDriverCommandSource;
  eventSink: AgentDriverEventSink;
  file: AgentDriverFilePort;
  hostIntegration: AgentDriverHostIntegrationPort;
  logger: AgentDriverLoggerPort;
  mcp: AgentDriverMcpPort;
  permission: AgentDriverPermissionPort;
  policy: AgentDriverPolicyPort;
  skill: AgentDriverSkillPort;
}
