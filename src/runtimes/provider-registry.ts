import type { AgentDriverHostPortName } from "../host-ports";
import type { DriverRuntime, DriverRuntimeTransport } from "../protocol/runtime";
import type { DriverStartInput } from "../protocol/start";
import type { DriverCapability } from "../runtime-command";
import { AcpDriverBackend } from "./acp/acp-driver-backend";
import type { AgentDriverBackend } from "./agent-driver-backend";
import { ClaudeAgentSdkDriverBackend } from "./claude/agent-sdk-driver-backend";
import { OpenAiAppServerDriverBackend } from "./openai/app-server-driver-backend";

export interface AgentDriverProviderDescriptor {
  readonly capabilities: readonly DriverCapability[];
  createBackend(input: DriverStartInput): AgentDriverBackend;
  readonly id: DriverRuntimeTransport;
  readonly requiredHostPorts: readonly AgentDriverHostPortName[];
  readonly runtime: DriverRuntime;
}

export interface AgentDriverProviderRegistry {
  createBackend(input: DriverStartInput): AgentDriverBackend;
  getByStartInput(input: DriverStartInput): AgentDriverProviderDescriptor;
  list(): readonly AgentDriverProviderDescriptor[];
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

const PROVIDERS = [
  {
    capabilities: [
      ...TEXT_TOOL_CAPABILITIES,
      { id: "native_resume", status: "supported", version: 1 },
      { id: "thinking_stream", status: "unsupported", version: 1 },
    ],
    createBackend: (payload) => new OpenAiAppServerDriverBackend(payload),
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
    createBackend: (payload) => new ClaudeAgentSdkDriverBackend(payload),
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
    createBackend: (payload) => new AcpDriverBackend(payload),
    id: "acp-fallback",
    requiredHostPorts: [...SHARED_REQUIRED_HOST_PORTS, "file", "host_integration"],
    runtime: "acp-fallback",
  },
] as const satisfies readonly AgentDriverProviderDescriptor[];

export function createAgentDriverProviderRegistry(
  providers: readonly AgentDriverProviderDescriptor[] = PROVIDERS,
): AgentDriverProviderRegistry {
  const providersByTransport = new Map<DriverRuntimeTransport, AgentDriverProviderDescriptor>();

  for (const provider of providers) {
    registerProviderTransport(providersByTransport, provider, provider.id);
  }

  return {
    createBackend(input) {
      return this.getByStartInput(input).createBackend(input);
    },
    getByStartInput(input) {
      return resolveProviderForStartInput(providersByTransport, input);
    },
    list() {
      return providers;
    },
  };
}

export const AGENT_DRIVER_PROVIDER_REGISTRY = createAgentDriverProviderRegistry();

export function createAgentDriverProviderCapabilities(input: {
  permissionRequestStatus: DriverCapability["status"];
  provider: AgentDriverProviderDescriptor;
}): readonly DriverCapability[] {
  const capabilitiesById = new Map<DriverCapability["id"], DriverCapability>();

  for (const capability of input.provider.capabilities) {
    capabilitiesById.set(capability.id, capability);
  }

  capabilitiesById.set("permission_request", {
    id: "permission_request",
    status: input.permissionRequestStatus,
    version: 1,
  });

  return [...capabilitiesById.values()];
}

function resolveProviderForStartInput(
  providersByTransport: Map<DriverRuntimeTransport, AgentDriverProviderDescriptor>,
  input: DriverStartInput,
): AgentDriverProviderDescriptor {
  const provider = providersByTransport.get(input.runtimeTransport);

  if (!provider) {
    throw new Error(`Unsupported runtime transport: ${input.runtimeTransport}.`);
  }

  if (input.runtime !== provider.runtime) {
    throw new Error(`Runtime ${input.runtime} does not match transport ${input.runtimeTransport}.`);
  }

  return provider;
}

function registerProviderTransport(
  providersByTransport: Map<DriverRuntimeTransport, AgentDriverProviderDescriptor>,
  provider: AgentDriverProviderDescriptor,
  transport: DriverRuntimeTransport,
): void {
  const existing = providersByTransport.get(transport);

  if (existing) {
    throw new Error(
      `Runtime transport ${transport} is already registered by provider ${existing.id}.`,
    );
  }

  providersByTransport.set(transport, provider);
}
