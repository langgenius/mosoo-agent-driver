import { describe, expect, test } from "bun:test";

import type { DriverRuntimeTransport } from "../src/protocol/runtime";
import type { DriverStartInput } from "../src/protocol/start";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import {
  AGENT_DRIVER_PROVIDER_REGISTRY,
  createAgentDriverProviderCapabilities,
} from "../src/runtimes/provider-registry";
import { driverBootPayload } from "./driver-boot-payload-fixture";

function startInputFor(transport: DriverRuntimeTransport): DriverStartInput {
  const runtimeByTransport = {
    "acp-fallback": "acp-fallback",
    "claude-agent-sdk": "claude-agent-sdk",
    "openai-app-server": "openai-runtime",
    "pi-rpc": "pi",
  } as const satisfies Record<DriverRuntimeTransport, DriverStartInput["runtime"]>;

  return createDriverStartInputFromBootPayload({
    ...driverBootPayload,
    runtime: runtimeByTransport[transport],
    runtimeTransport: transport,
  });
}

describe("provider registry", () => {
  test("declares every launch transport through one public registry", () => {
    expect(AGENT_DRIVER_PROVIDER_REGISTRY.list()).toMatchObject([
      {
        id: "openai-app-server",
        runtime: "openai-runtime",
      },
      {
        id: "claude-agent-sdk",
        runtime: "claude-agent-sdk",
      },
      {
        id: "acp-fallback",
        runtime: "acp-fallback",
      },
      { id: "pi-rpc", runtime: "pi" },
    ]);
  });

  test("creates the matching backend from the start input transport", () => {
    expect(
      AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(startInputFor("openai-app-server")).runtime,
    ).toBe("openai-runtime");
    expect(
      AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(startInputFor("claude-agent-sdk")).runtime,
    ).toBe("claude-agent-sdk");
    expect(
      AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(startInputFor("acp-fallback")).runtime,
    ).toBe("acp-fallback");
    expect(AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(startInputFor("pi-rpc")).runtime).toBe(
      "pi",
    );
  });

  test("resolves provider descriptors from driver start inputs", () => {
    expect(
      AGENT_DRIVER_PROVIDER_REGISTRY.getByStartInput(startInputFor("openai-app-server")),
    ).toMatchObject({
      id: "openai-app-server",
      runtime: "openai-runtime",
    });
  });

  test("builds hello capabilities from the provider descriptor", () => {
    const provider = AGENT_DRIVER_PROVIDER_REGISTRY.getByStartInput(
      startInputFor("openai-app-server"),
    );
    const capabilities = createAgentDriverProviderCapabilities({
      permissionRequestStatus: "unsupported",
      provider,
    });

    expect(capabilities).toEqual(
      expect.arrayContaining([
        { id: "custom_tool_execute", status: "unsupported", version: 1 },
        { id: "file_change", status: "supported", version: 1 },
        { id: "input_start", status: "supported", version: 1 },
        { id: "permission_request", status: "unsupported", version: 1 },
        { id: "session_stop", status: "supported", version: 1 },
        { id: "thinking_stream", status: "supported", version: 1 },
      ]),
    );
  });

  test("fails fast when no provider owns the transport", () => {
    expect(() =>
      AGENT_DRIVER_PROVIDER_REGISTRY.createBackend({
        ...startInputFor("openai-app-server"),
        runtimeTransport: "unknown" as DriverRuntimeTransport,
      }),
    ).toThrow("Unsupported runtime transport: unknown.");
  });

  test("fails fast when the start input runtime does not match the provider transport", () => {
    expect(() =>
      AGENT_DRIVER_PROVIDER_REGISTRY.createBackend({
        ...startInputFor("openai-app-server"),
        runtime: "claude-agent-sdk",
      }),
    ).toThrow("Runtime claude-agent-sdk does not match transport openai-app-server.");
  });

  test.each(["openai-app-server", "acp-fallback", "pi-rpc"] as const)(
    "rejects built-in tool restrictions unsupported by %s",
    (transport) => {
      const input = startInputFor(transport);

      expect(() =>
        AGENT_DRIVER_PROVIDER_REGISTRY.getByStartInput({
          ...input,
          execution: {
            ...input.execution,
            builtInTools: input.execution.builtInTools.map((tool) =>
              tool.name === "bash" ? { ...tool, enabled: false } : tool,
            ),
          },
        }),
      ).toThrow(`Runtime ${input.runtime} does not support built-in tool restrictions.`);
    },
  );

  test("accepts Claude built-in tool restrictions", () => {
    const input = startInputFor("claude-agent-sdk");

    expect(
      AGENT_DRIVER_PROVIDER_REGISTRY.getByStartInput({
        ...input,
        execution: {
          ...input.execution,
          builtInTools: input.execution.builtInTools.map((tool) =>
            tool.name === "bash" ? { ...tool, enabled: false } : tool,
          ),
        },
      }).runtime,
    ).toBe("claude-agent-sdk");
  });

  test("preserves v1 compatibility when OpenAI receives additional directories", () => {
    const input = startInputFor("openai-app-server");

    expect(
      AGENT_DRIVER_PROVIDER_REGISTRY.getByStartInput({
        ...input,
        execution: {
          ...input.execution,
          session: {
            ...input.execution.session,
            additionalDirectories: ["/tmp/shared"],
          },
        },
      }).runtime,
    ).toBe("openai-runtime");
  });

  test.each(["claude-agent-sdk", "acp-fallback"] as const)(
    "accepts additional directories supported by %s",
    (transport) => {
      const input = startInputFor(transport);

      expect(
        AGENT_DRIVER_PROVIDER_REGISTRY.getByStartInput({
          ...input,
          execution: {
            ...input.execution,
            session: {
              ...input.execution.session,
              additionalDirectories: ["/tmp/shared"],
            },
          },
        }).runtime,
      ).toBe(input.runtime);
    },
  );

  test("rejects additional directories unsupported by Pi", () => {
    const input = startInputFor("pi-rpc");
    expect(() =>
      AGENT_DRIVER_PROVIDER_REGISTRY.getByStartInput({
        ...input,
        execution: {
          ...input.execution,
          session: { ...input.execution.session, additionalDirectories: ["/tmp/shared"] },
        },
      }),
    ).toThrow("Runtime pi does not support additional directories.");
  });
});
