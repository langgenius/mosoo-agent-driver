import { describe, expect, test } from "bun:test";

import { DRIVER_PROTOCOL_VERSION as DRIVER_PROTOCOL_VERSION_FROM_BOOT_SUBPATH } from "@mosoo/agent-driver/boot";
import { createCmaHttpHandler as createCmaHttpHandlerFromSubpath } from "@mosoo/agent-driver/cma-http";
import { CmaSdkClient as CmaSdkClientFromSubpath } from "@mosoo/agent-driver/cma-sdk";
import {
  PROTOCOL_VERSION as PROTOCOL_VERSION_FROM_CONTRACT,
  protocolVersionSchema as protocolVersionSchemaFromContract,
  sessionSnapshotSchema as sessionSnapshotSchemaFromContract,
} from "@mosoo/agent-driver/contract";
import { parseDriverEventEnvelope as parseDriverEventEnvelopeFromSubpath } from "@mosoo/agent-driver/events";
import {
  AGENT_DRIVER_PROVIDER_REGISTRY,
  AgentDriverKernelCore,
  CMA_DEFAULT_BETA_HEADER_VALUE,
  CmaSdkClient,
  CmaSdkError,
  SUPPORTED_DRIVER_RUNTIMES,
  createAgentDriverContext,
  createDriverDiagnosticEvent,
  createAgentDriverProviderCapabilities,
  createCmaHttpHandler,
  createCmaMemoryStore,
  parseDriverNativeRuntimeRef,
  pushDriverDiagnosticEvent,
  projectCmaInboundToDriverCommand,
  projectDriverEventToCma,
} from "@mosoo/agent-driver";
import {
  parseDriverHeartbeatInput as parseDriverHeartbeatInputFromOrpcSubpath,
  parseDriverHelloInput as parseDriverHelloInputFromOrpcSubpath,
  parseDriverReadyInput as parseDriverReadyInputFromOrpcSubpath,
} from "@mosoo/agent-driver/orpc";
import type { DriverHeartbeatInput as DriverHeartbeatInputFromOrpcSubpath } from "@mosoo/agent-driver/orpc";
import { SANDBOX_MEMORY_PATH as SANDBOX_MEMORY_PATH_FROM_PATHS_SUBPATH } from "@mosoo/agent-driver/paths";
import { filterOpenAiPrivateCitations } from "@mosoo/agent-driver/provider-output";
import { isSupportedDriverRuntime as isSupportedDriverRuntimeFromSubpath } from "@mosoo/agent-driver/runtime";

describe("public API", () => {
  test("imports without starting the driver process", () => {
    expect(AgentDriverKernelCore).toBeFunction();
    expect(createAgentDriverContext).toBeFunction();
    expect(createDriverDiagnosticEvent).toBeFunction();
    expect(createAgentDriverProviderCapabilities).toBeFunction();
    expect(createCmaHttpHandler).toBeFunction();
    expect(createCmaMemoryStore).toBeFunction();
    expect(CmaSdkClient).toBeFunction();
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

    expect(DRIVER_PROTOCOL_VERSION_FROM_BOOT_SUBPATH).toBe(2);
    expect(PROTOCOL_VERSION_FROM_CONTRACT).toBe(2);
    expect(protocolVersionSchemaFromContract.parse(2)).toBe(2);
    expect(sessionSnapshotSchemaFromContract.parse).toBeFunction();
    expect(createCmaHttpHandlerFromSubpath).toBe(createCmaHttpHandler);
    expect(CmaSdkClientFromSubpath).toBe(CmaSdkClient);
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
        protocolVersion: 2,
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
    expect(filterOpenAiPrivateCitations("plain text")).toEqual({
      privateCitationCount: 0,
      text: "plain text",
    });
  });
});
