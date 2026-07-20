import type {
  AgentDriverBackend,
  AgentDriverKernel,
  CmaStore,
  DriverStartInput,
} from "@mosoo/agent-driver";
import type { SessionSnapshot } from "@mosoo/agent-driver/contract";
import type { CmaHttpHandler } from "@mosoo/agent-driver/cma-http";
import type { CmaSdkClient } from "@mosoo/agent-driver/cma-sdk";
import type { DriverEventInput } from "@mosoo/agent-driver/events";

export interface PublicApiConsumer {
  readonly backend: AgentDriverBackend;
  readonly cmaClient: CmaSdkClient;
  readonly cmaHandler: CmaHttpHandler;
  readonly cmaStore: CmaStore;
  readonly event: DriverEventInput;
  readonly kernel: AgentDriverKernel;
  readonly snapshot: SessionSnapshot;
  readonly startInput: DriverStartInput;
}

export function consumePublicApi(api: PublicApiConsumer): PublicApiConsumer {
  return api;
}
