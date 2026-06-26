import { describe, expect, test } from "bun:test";

import { DRIVER_PROTOCOL_VERSION as DRIVER_PROTOCOL_VERSION_FROM_BOOT_SUBPATH } from "../src/boot";
import { createCmaHttpHandler as createCmaHttpHandlerFromSubpath } from "../src/cma-http";
import { createCmaSdkClient as createCmaSdkClientFromSubpath } from "../src/cma-sdk";
import { parseDriverEventEnvelope as parseDriverEventEnvelopeFromSubpath } from "../src/events";
import {
  AGENT_DRIVER_PROVIDER_REGISTRY,
  AgentDriverKernelCore,
  CMA_DEFAULT_BETA_HEADER_VALUE,
  CmaSdkError,
  SUPPORTED_DRIVER_RUNTIMES,
  createAgentDriverBackend,
  createAgentDriverContext,
  createDriverDiagnosticEvent,
  createAgentDriverProviderCapabilities,
  createCmaHttpHandler,
  createCmaMemoryStore,
  createCmaSdkClient,
  parseDriverNativeRuntimeRef,
  pushDriverDiagnosticEvent,
  projectCmaInboundToDriverCommand,
  projectDriverEventToCma,
} from "../src/index";
import {
  parseDriverHeartbeatInput as parseDriverHeartbeatInputFromOrpcSubpath,
  parseDriverHelloInput as parseDriverHelloInputFromOrpcSubpath,
  parseDriverReadyInput as parseDriverReadyInputFromOrpcSubpath,
} from "../src/orpc";
import type { DriverHeartbeatInput as DriverHeartbeatInputFromOrpcSubpath } from "../src/orpc";
import { SANDBOX_MEMORY_PATH as SANDBOX_MEMORY_PATH_FROM_PATHS_SUBPATH } from "../src/paths";
import { isSupportedDriverRuntime as isSupportedDriverRuntimeFromSubpath } from "../src/runtime";

describe("public API", () => {
  test("imports without starting the driver process", () => {
    expect(AgentDriverKernelCore).toBeFunction();
    expect(createAgentDriverBackend).toBeFunction();
    expect(createAgentDriverContext).toBeFunction();
    expect(createDriverDiagnosticEvent).toBeFunction();
    expect(createAgentDriverProviderCapabilities).toBeFunction();
    expect(createCmaHttpHandler).toBeFunction();
    expect(createCmaMemoryStore).toBeFunction();
    expect(createCmaSdkClient).toBeFunction();
    expect(CmaSdkError).toBeFunction();
    expect(CMA_DEFAULT_BETA_HEADER_VALUE).toBe("managed-agents-2026-04-01");
    expect(projectCmaInboundToDriverCommand).toBeFunction();
    expect(projectDriverEventToCma).toBeFunction();
    expect(pushDriverDiagnosticEvent).toBeFunction();
    expect(parseDriverNativeRuntimeRef).toBeFunction();
    expect(AGENT_DRIVER_PROVIDER_REGISTRY.list()).toHaveLength(3);
    expect(SUPPORTED_DRIVER_RUNTIMES).toEqual([
      "openai-runtime",
      "claude-agent-sdk",
      "acp-fallback",
    ]);
  });

  test("imports public subpath entries without process side effects", () => {
    const heartbeatReason = "ping" satisfies DriverHeartbeatInputFromOrpcSubpath["reason"];

    expect(DRIVER_PROTOCOL_VERSION_FROM_BOOT_SUBPATH).toBe(1);
    expect(createCmaHttpHandlerFromSubpath).toBe(createCmaHttpHandler);
    expect(createCmaSdkClientFromSubpath).toBe(createCmaSdkClient);
    expect(parseDriverEventEnvelopeFromSubpath).toBeFunction();
    expect(heartbeatReason).toBe("ping");
    expect(parseDriverHeartbeatInputFromOrpcSubpath({ at: "now", pid: 1, reason: "ping" })).toEqual(
      {
        at: "now",
        pid: 1,
        reason: "ping",
      },
    );
    expect(
      parseDriverHelloInputFromOrpcSubpath({
        capabilities: [],
        driverVersion: "0.1.0",
        pid: 1,
        protocolVersion: 1,
        runtime: "openai-runtime",
        startedAt: "now",
      }),
    ).toMatchObject({
      driverVersion: "0.1.0",
      runtime: "openai-runtime",
    });
    expect(
      parseDriverReadyInputFromOrpcSubpath({
        at: "now",
        driverInstanceId: "driver-1",
        pid: 1,
      }),
    ).toMatchObject({
      driverInstanceId: "driver-1",
    });
    expect(isSupportedDriverRuntimeFromSubpath("openai-runtime")).toBe(true);
    expect(SANDBOX_MEMORY_PATH_FROM_PATHS_SUBPATH).toBe("/workspace/memory");
  });
});
