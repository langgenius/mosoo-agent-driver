import type {
  AgentDriverBackend,
  AgentDriverKernel,
  CmaStore,
  DriverStartInput,
} from "@mosoo/agent-driver";
import type { DriverBootPayload } from "@mosoo/agent-driver/boot";
import type { SessionSnapshot } from "@mosoo/agent-driver/contract";
import type { CmaHttpHandler } from "@mosoo/agent-driver/cma-http";
import type { CmaSdkClient } from "@mosoo/agent-driver/cma-sdk";
import type { DriverEventInput } from "@mosoo/agent-driver/events";
import type { DriverHeartbeatInput } from "@mosoo/agent-driver/orpc";
import type { OpenAiPrivateCitationFilterResult } from "@mosoo/agent-driver/provider-output";
import type { DriverRuntime } from "@mosoo/agent-driver/runtime";

type SandboxMemoryPath = typeof import("@mosoo/agent-driver/paths").SANDBOX_MEMORY_PATH;

export interface PublicApiConsumer {
  readonly backend: AgentDriverBackend;
  readonly bootPayload: DriverBootPayload;
  readonly cmaClient: CmaSdkClient;
  readonly cmaHandler: CmaHttpHandler;
  readonly cmaStore: CmaStore;
  readonly event: DriverEventInput;
  readonly heartbeat: DriverHeartbeatInput;
  readonly kernel: AgentDriverKernel;
  readonly memoryPath: SandboxMemoryPath;
  readonly providerOutput: OpenAiPrivateCitationFilterResult;
  readonly runtime: DriverRuntime;
  readonly snapshot: SessionSnapshot;
  readonly startInput: DriverStartInput;
}
