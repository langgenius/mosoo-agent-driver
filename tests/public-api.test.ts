import { describe, expect, test } from "bun:test";

import * as agentDriver from "@mosoo/agent-driver";
import * as boot from "@mosoo/agent-driver/boot";
import * as cmaHttp from "@mosoo/agent-driver/cma-http";
import * as cmaSdk from "@mosoo/agent-driver/cma-sdk";
import * as contract from "@mosoo/agent-driver/contract";
import * as events from "@mosoo/agent-driver/events";
import * as orpc from "@mosoo/agent-driver/orpc";
import * as paths from "@mosoo/agent-driver/paths";
import * as providerOutput from "@mosoo/agent-driver/provider-output";
import * as runtime from "@mosoo/agent-driver/runtime";

describe("public API", () => {
  test("imports without starting the driver process", () => {
    expect(agentDriver.AgentDriverKernelCore).toBeFunction();
    expect(agentDriver.createAgentDriverContext).toBeFunction();
    expect(agentDriver.createDriverDiagnosticEvent).toBeFunction();
    expect(agentDriver.createAgentDriverProviderCapabilities).toBeFunction();
    expect(agentDriver.createCmaHttpHandler).toBeFunction();
    expect(agentDriver.createCmaMemoryStore).toBeFunction();
    expect(agentDriver.CmaSdkClient).toBeFunction();
    expect(agentDriver.CmaSdkError).toBeFunction();
    expect(agentDriver.CMA_DEFAULT_BETA_HEADER_VALUE).toBe("managed-agents-2026-04-01");
    expect(agentDriver.projectCmaInboundToDriverCommand).toBeFunction();
    expect(agentDriver.projectDriverEventToCma).toBeFunction();
    expect(agentDriver.pushDriverDiagnosticEvent).toBeFunction();
    expect(agentDriver.parseDriverNativeRuntimeRef).toBeFunction();
    expect(agentDriver.AGENT_DRIVER_PROVIDER_REGISTRY.list()).toHaveLength(3);
    expect(agentDriver.SUPPORTED_DRIVER_RUNTIMES).toEqual([
      "openai-runtime",
      "claude-agent-sdk",
      "acp-fallback",
    ]);
  });

  test("imports public subpath entries without process side effects", () => {
    const heartbeatReason = "ping" satisfies orpc.DriverHeartbeatInput["reason"];

    expect(boot.DRIVER_PROTOCOL_VERSION).toBe(3);
    expect(contract.PROTOCOL_VERSION).toBe(2);
    expect(contract.protocolVersionSchema.parse(2)).toBe(2);
    expect(contract.sessionSnapshotSchema.parse).toBeFunction();
    expect(cmaHttp.createCmaHttpHandler).toBe(agentDriver.createCmaHttpHandler);
    expect(cmaSdk.CmaSdkClient).toBe(agentDriver.CmaSdkClient);
    expect(events.parseDriverEventEnvelope).toBeFunction();
    expect(events.toRuntimeEventInput).toBeFunction();
    expect(events.RUNTIME_EVENT_SCHEMA_VERSION).toBe("2026-08-29");
    expect(events.RUNTIME_EVENT_KINDS).toContain("agent.tasks.replaced");
    expect(orpc.parseDriverHeartbeatInput({ at: "now", pid: 1, reason: heartbeatReason })).toEqual({
      at: "now",
      pid: 1,
      reason: "ping",
    });
    expect(
      orpc.parseDriverHelloInput({
        capabilities: [],
        driverVersion: "0.1.0",
        pid: 1,
        protocolVersion: boot.DRIVER_PROTOCOL_VERSION,
        runtime: "openai-runtime",
        startedAt: "now",
      }),
    ).toMatchObject({
      driverVersion: "0.1.0",
      runtime: "openai-runtime",
    });
    expect(
      orpc.parseDriverReadyInput({
        at: "now",
        driverInstanceId: "driver-1",
        pid: 1,
      }),
    ).toMatchObject({
      driverInstanceId: "driver-1",
    });
    expect(runtime.isSupportedDriverRuntime("openai-runtime")).toBe(true);
    expect(paths.SANDBOX_MEMORY_PATH).toBe("/workspace/memory");
    expect(paths.getSessionResourceRootPath("session-1")).toBe(
      "/workspace/se/session-1/session-files",
    );
    expect(paths.getSessionResourceBackingPath("session-1")).toBe(
      "/workspace/.mosoo/session-files/session-1",
    );
    expect(
      paths.isSandboxSessionResourceBackingPath(
        "/workspace/.mosoo/session-files/session-1/nested.txt",
      ),
    ).toBe(true);
    expect(
      paths.isSandboxSessionResourceBackingPath(
        "/workspace/.mosoo/session-files-other/session-1/nested.txt",
      ),
    ).toBe(false);
    expect(
      paths.isSandboxSessionResourceBackingPath(
        "/workspace/se/session-1/public/.mosoo-session-files-session-1",
      ),
    ).toBe(false);
    expect(() =>
      paths.normalizeSandboxFileBrowserPath("/workspace/.mosoo/session-files/session-1/nested.txt"),
    ).toThrow("Session resource backing is not visible");
    expect(
      paths.normalizeSandboxFileBrowserPath(
        "/workspace/se/session-1/.mosoo-session-files-session-2/nested.txt",
      ),
    ).toBe("/workspace/se/session-1/.mosoo-session-files-session-2/nested.txt");
    expect(providerOutput.filterOpenAiPrivateCitations("plain text")).toEqual({
      privateCitationCount: 0,
      text: "plain text",
    });
  });
});
