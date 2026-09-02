import type { DriverEventInput } from "../protocol/events";
import type { DriverExecutionInput } from "../protocol/execution";
import type { RunId } from "../protocol/id";
import type { DriverEventBatchOutput } from "../protocol/orpc";
import type {
  DriverCommandUpdate,
  McpExecuteCommand,
  McpExternalToolEffectClaim,
  McpExternalToolEffectExecution,
  McpExternalToolEffectSettlement,
  McpExternalToolEffectState,
  McpExternalToolExecutionResult,
  RuntimeCommand,
} from "../runtime-command";

/** Maximum provider-call duration after the durable MCP claim commits. */
export const AGENT_DRIVER_MCP_EXECUTE_TIMEOUT_MS = 60_000;

export interface AgentDriverCommandSource {
  nextCommand(signal: AbortSignal): Promise<RuntimeCommand | null>;
}

export interface AgentDriverEventSink {
  claimExternalToolEffect?(
    input: { claimToken: string; commandId: string },
    signal: AbortSignal,
  ): Promise<McpExternalToolEffectClaim>;
  commandUpdate(input: DriverCommandUpdate, signal: AbortSignal): Promise<void>;
  observeExternalToolEffect?(
    input: { commandId: string },
    signal: AbortSignal,
  ): Promise<McpExternalToolEffectState>;
  settleExternalToolEffect?(
    input: {
      claimToken: string;
      commandId: string;
      effectId: string;
      settlement: McpExternalToolEffectSettlement;
    },
    signal: AbortSignal,
  ): Promise<McpExternalToolEffectState>;
  currentRunId(): RunId | null;
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
  /**
   * Runs after the durable effect claim commits. Implementations must bound
   * this call independently instead of reusing the cancellable prepare signal.
   */
  execute(effect: McpExternalToolEffectExecution): Promise<McpExternalToolExecutionResult>;
}

export interface AgentDriverMcpPort {
  /** Prepares provider state without invoking the external tool. */
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
  reportChanged(
    input: {
      change: "delete" | "upsert";
      path: string;
      reason: string;
    },
    signal: AbortSignal,
  ): Promise<void>;
}

export interface AgentDriverHostPorts {
  commandSource: AgentDriverCommandSource;
  eventSink: AgentDriverEventSink;
  file: AgentDriverFilePort;
  mcp: AgentDriverMcpPort;
  permission: AgentDriverPermissionPort;
  skill: AgentDriverSkillPort;
}
