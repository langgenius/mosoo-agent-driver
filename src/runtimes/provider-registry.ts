import type { DriverRuntimeTransport } from "../protocol/runtime";
import type { DriverStartInput } from "../protocol/start";
import type { DriverCapability } from "../runtime-command";
import { AcpDriverBackend } from "./acp/acp-driver-backend";
import type { AgentDriverBackend } from "./agent-driver-backend";
import { ClaudeAgentSdkDriverBackend } from "./claude/agent-sdk-driver-backend";
import { OpenAiAppServerDriverBackend } from "./openai/app-server-driver-backend";
import { AGENT_DRIVER_PROVIDER_CONTRACTS } from "./provider-contract";
import type { AgentDriverProviderContract } from "./provider-contract";

export interface AgentDriverProviderDescriptor extends AgentDriverProviderContract {
  createBackend(input: DriverStartInput): AgentDriverBackend;
}

export interface AgentDriverProviderRegistry {
  createBackend(input: DriverStartInput): AgentDriverBackend;
  getByStartInput(input: DriverStartInput): AgentDriverProviderDescriptor;
  list(): readonly AgentDriverProviderDescriptor[];
}

type AgentDriverBackendFactory = (input: DriverStartInput) => AgentDriverBackend;

const BACKEND_FACTORIES = {
  "acp-fallback": (payload) => new AcpDriverBackend(payload),
  "claude-agent-sdk": (payload) => new ClaudeAgentSdkDriverBackend(payload),
  "openai-app-server": (payload) => new OpenAiAppServerDriverBackend(payload),
} satisfies Record<DriverRuntimeTransport, AgentDriverBackendFactory>;

const PROVIDERS = AGENT_DRIVER_PROVIDER_CONTRACTS.map((contract) => ({
  capabilities: contract.capabilities,
  createBackend: BACKEND_FACTORIES[contract.id],
  id: contract.id,
  requiredHostPorts: contract.requiredHostPorts,
  runtime: contract.runtime,
})) satisfies readonly AgentDriverProviderDescriptor[];

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
