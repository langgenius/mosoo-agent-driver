import type { DriverRuntimeEventPort } from "../core/driver-runtime-io";
import type {
  AgentDriverAccessPort,
  AgentDriverCommandSource,
  AgentDriverEventSink,
  AgentDriverFilePort,
  AgentDriverHostIntegrationPort,
  AgentDriverHostPorts,
  AgentDriverLoggerPort,
  AgentDriverMcpPort,
  AgentDriverPermissionPort,
  AgentDriverPolicyPort,
  AgentDriverSkillPort,
} from "../host-ports";
import type { Logger } from "../observability";
import type { DriverAppAccessSnapshotOutput } from "../protocol/boot";
import type { DriverEventInput } from "../protocol/events";
import type { RunId } from "../protocol/id";
import type { DriverRuntime } from "../protocol/runtime";
import type { DriverStartInput } from "../protocol/start";
import type { McpExecuteCommand, RuntimeCommandInput } from "../runtime-command";

export interface AgentDriverContext {
  logger: Logger;
  payload: DriverStartInput;
  ports: AgentDriverHostPorts;
}

export type AgentDriverContextPortOverrides = Partial<{
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
}>;

export interface AgentDriverContextInput {
  commandSource?: AgentDriverCommandSource;
  eventSink: DriverRuntimeEventPort | AgentDriverEventSink;
  logger: Logger;
  payload: DriverStartInput;
  permission: AgentDriverPermissionPort;
  ports?: AgentDriverContextPortOverrides;
}

function hasCommandUpdate(
  eventSink: DriverRuntimeEventPort | AgentDriverEventSink,
): eventSink is AgentDriverEventSink {
  return "commandUpdate" in eventSink && typeof eventSink.commandUpdate === "function";
}

function hasNextCommand(source: unknown): source is AgentDriverCommandSource {
  return typeof source === "object" && source !== null && "nextCommand" in source;
}

function toAgentDriverEventSink(
  eventSink: DriverRuntimeEventPort | AgentDriverEventSink,
): AgentDriverEventSink {
  if (hasCommandUpdate(eventSink)) {
    return eventSink;
  }

  return {
    commandUpdate: async () => {},
    pushEvents: (input) => eventSink.pushEvents(input),
  };
}

function createDefaultHostPorts(input: AgentDriverContextInput): AgentDriverHostPorts {
  const eventSink = toAgentDriverEventSink(input.eventSink);

  return {
    access: {
      refresh: async () => {},
    },
    commandSource:
      input.commandSource ??
      (hasNextCommand(input.eventSink)
        ? input.eventSink
        : {
            nextCommand: async () => null,
          }),
    eventSink,
    file: {
      reportChanged: async (fileChange) => {
        const event = {
          kind: "file.changed",
          payload: {
            change: fileChange.change,
            path: fileChange.path,
            source: fileChange.reason,
          },
        } satisfies DriverEventInput;

        await eventSink.pushEvents({ events: [event] });
      },
    },
    logger: {
      logger: () => input.logger,
    },
    hostIntegration: {
      snapshot: async () => null,
    },
    mcp: {
      execute: async () => {
        throw new Error("Driver MCP host port is not configured.");
      },
    },
    permission: input.permission,
    policy: {
      assertSupported: async () => {},
    },
    skill: {
      materialize: async () => {
        throw new Error("Driver skill host port is not configured.");
      },
    },
  };
}

export function createAgentDriverContext(input: AgentDriverContextInput): AgentDriverContext {
  const defaultPorts = createDefaultHostPorts(input);
  const ports: AgentDriverHostPorts = {
    ...defaultPorts,
    ...input.ports,
  };

  return {
    logger: input.logger,
    payload: input.payload,
    ports,
  };
}

export interface AgentDriverBackend {
  readonly runtime: DriverRuntime;
  cancelActiveTurn(context: AgentDriverContext, reason: string): Promise<void>;
  handleInput(context: AgentDriverContext, input: RuntimeCommandInput, runId: RunId): Promise<void>;
  handleMcpExecute(
    context: AgentDriverContext,
    command: McpExecuteCommand,
  ): Promise<{ outputText: string; requestId: string; serverId: string; toolName: string }>;
  refreshAppAccess(
    context: AgentDriverContext,
    snapshot: DriverAppAccessSnapshotOutput,
  ): Promise<void>;
  start(context: AgentDriverContext): Promise<void>;
  stop(context: AgentDriverContext, reason: string): Promise<void>;
}

export type AgentDriverBackendFactory = (
  input: DriverStartInput,
) => AgentDriverBackend | Promise<AgentDriverBackend>;
