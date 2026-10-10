import { expect, spyOn, test } from "bun:test";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import { createDisabledLogger } from "../src/observability";
import { DriverEventPublisher } from "../src/runtimes/driver-event-publisher";
import { AGENT_DRIVER_PROVIDER_REGISTRY } from "../src/runtimes/provider-registry";
import { bootPayload, createBackend } from "./driver-runtime-boundary-fixtures";

test.each(AGENT_DRIVER_PROVIDER_REGISTRY.list())(
  "$runtime fixes checkpoint cleanup ownership before preparing model work",
  async (provider) => {
    const failure = new Error("Checkpoint root could not be pinned.");
    const initialize = spyOn(
      DriverEventPublisher.prototype,
      "initializeNativeCheckpointRoot",
    ).mockRejectedValue(failure);
    let materializations = 0;
    const payload = {
      ...structuredClone(bootPayload),
      runtime: provider.runtime,
      runtimeTransport: provider.id,
    };
    const context = createAgentDriverContext({
      eventSink: {
        currentRunId: () => null,
        pushEvents: async () => ({ accepted: [] }),
      },
      logger: createDisabledLogger(),
      payload,
      permission: { request: async () => "reject_once" },
      ports: {
        skill: {
          materialize: async () => {
            materializations += 1;
            throw new Error("Model preparation must wait for the checkpoint root.");
          },
        },
      },
    });

    try {
      const backend = provider.createBackend(payload);
      await expect(backend.start(context, new AbortController().signal)).rejects.toBe(failure);
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(materializations).toBe(0);
    } finally {
      initialize.mockRestore();
    }
  },
);

test("custom kernel backends do not require a native filesystem root", async () => {
  const initialize = spyOn(
    DriverEventPublisher.prototype,
    "initializeNativeCheckpointRoot",
  ).mockRejectedValue(new Error("Native filesystem access is unavailable."));
  const payload = structuredClone(bootPayload);
  const kernel = new AgentDriverKernelCore({ backendFactory: () => createBackend() });

  try {
    await expect(
      kernel.start({
        ...payload,
        execution: {
          ...payload.execution,
          session: { ...payload.execution.session, cwd: "/missing-custom-kernel-workspace" },
        },
      }),
    ).resolves.toBeUndefined();
    await expect(kernel.stop("test.complete")).resolves.toBeUndefined();
    expect(initialize).not.toHaveBeenCalled();
  } finally {
    initialize.mockRestore();
  }
});
