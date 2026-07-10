import type { AgentDriverHostPortName } from "../host-ports";
import type { DriverRuntime, DriverRuntimeTransport } from "../protocol/runtime";
import type { DriverCapability } from "../runtime-command";

export interface AgentDriverProviderContract {
  readonly capabilities: readonly DriverCapability[];
  readonly id: DriverRuntimeTransport;
  readonly requiredHostPorts: readonly AgentDriverHostPortName[];
  readonly runtime: DriverRuntime;
}

const SHARED_REQUIRED_HOST_PORTS = [
  "event_sink",
  "permission",
  "mcp",
  "skill",
] as const satisfies readonly AgentDriverHostPortName[];

const TEXT_TOOL_CAPABILITIES = [
  { id: "custom_tool_execute", status: "unsupported", version: 1 },
  { id: "file_change", status: "supported", version: 1 },
  { id: "input_start", status: "supported", version: 1 },
  { id: "mcp_execute", status: "supported", version: 1 },
  { id: "permission_request", status: "supported", version: 1 },
  { id: "session_stop", status: "supported", version: 1 },
  { id: "text_stream", status: "supported", version: 1 },
  { id: "tool_stream", status: "supported", version: 1 },
  { id: "turn_cancel", status: "supported", version: 1 },
  { id: "usage", status: "supported", version: 1 },
  { id: "visible_activity", status: "supported", version: 1 },
] as const satisfies readonly DriverCapability[];

export const AGENT_DRIVER_PROVIDER_CONTRACTS = [
  {
    capabilities: [
      ...TEXT_TOOL_CAPABILITIES,
      { id: "native_resume", status: "supported", version: 1 },
      { id: "thinking_stream", status: "unsupported", version: 1 },
    ],
    id: "openai-app-server",
    requiredHostPorts: SHARED_REQUIRED_HOST_PORTS,
    runtime: "openai-runtime",
  },
  {
    capabilities: [
      ...TEXT_TOOL_CAPABILITIES,
      { id: "native_resume", status: "supported", version: 1 },
      { id: "thinking_stream", status: "supported", version: 1 },
    ],
    id: "claude-agent-sdk",
    requiredHostPorts: SHARED_REQUIRED_HOST_PORTS,
    runtime: "claude-agent-sdk",
  },
  {
    capabilities: [
      ...TEXT_TOOL_CAPABILITIES,
      { id: "native_resume", status: "supported", version: 1 },
      { id: "thinking_stream", status: "supported", version: 1 },
    ],
    id: "acp-fallback",
    requiredHostPorts: [...SHARED_REQUIRED_HOST_PORTS, "file", "host_integration"],
    runtime: "acp-fallback",
  },
] as const satisfies readonly AgentDriverProviderContract[];
