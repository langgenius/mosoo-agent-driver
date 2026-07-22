import { pushLosslessEvents } from "./driver-runtime-io";
import type { DriverRuntimeEventPort } from "./driver-runtime-io";
import type {
  AgentDriverCommandSource,
  AgentDriverEventSink,
  AgentDriverFilePort,
  AgentDriverHostIntegrationPort,
  AgentDriverHostPorts,
  AgentDriverMcpPort,
  AgentDriverPermissionPort,
  AgentDriverSkillPort,
} from "../host-ports";
import type { Logger } from "../observability";
import type { DriverEventInput } from "../protocol/events";
import type { RunId } from "../protocol/id";
import type { DriverRuntime } from "../protocol/runtime";
import type { DriverStartInput } from "../protocol/start";
import type { RuntimeCommandInput } from "../runtime-command";

export interface AgentDriverContext {
  lifecycle: AgentDriverLifecycle;
  logger: Logger;
  payload: DriverStartInput;
  ports: AgentDriverHostPorts;
}

export interface AgentDriverLifecycle {
  fail(error: Error): void;
}

export type AgentDriverContextPortOverrides = Partial<{
  commandSource: AgentDriverCommandSource;
  eventSink: AgentDriverEventSink;
  file: AgentDriverFilePort;
  hostIntegration: AgentDriverHostIntegrationPort;
  mcp: AgentDriverMcpPort;
  permission: AgentDriverPermissionPort;
  skill: AgentDriverSkillPort;
}>;

export interface AgentDriverContextInput {
  commandSource?: AgentDriverCommandSource;
  eventSink: DriverRuntimeEventPort | AgentDriverEventSink;
  lifecycle?: AgentDriverLifecycle;
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

  const currentRunId = eventSink.currentRunId?.bind(eventSink);

  return {
    commandUpdate: async () => {},
    ...(currentRunId === undefined ? {} : { currentRunId }),
    pushEvents: (input) => eventSink.pushEvents(input),
  };
}

function createDefaultHostPorts(input: AgentDriverContextInput): AgentDriverHostPorts {
  const eventSink = toAgentDriverEventSink(input.eventSink);

  return {
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

        await pushLosslessEvents(eventSink, [event]);
      },
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
    lifecycle:
      input.lifecycle ??
      ({
        fail: (error) => input.logger.error("driver.backend.unsupervised_failure", error, {}),
      } satisfies AgentDriverLifecycle),
    logger: input.logger,
    payload: input.payload,
    ports,
  };
}

export interface AgentDriverBackend {
  readonly runtime: DriverRuntime;
  cancelActiveTurn(context: AgentDriverContext, reason: string): Promise<void>;
  handleInput(
    context: AgentDriverContext,
    input: RuntimeCommandInput,
    runId: RunId,
    signal?: AbortSignal,
  ): Promise<void>;
  start(context: AgentDriverContext, signal: AbortSignal): Promise<void>;
  stop(context: AgentDriverContext, reason: string, signal: AbortSignal): Promise<void>;
}

export type AgentDriverBackendFactory = (input: DriverStartInput) => AgentDriverBackend;
