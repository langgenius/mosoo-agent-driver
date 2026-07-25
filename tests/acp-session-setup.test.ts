import { describe, expect, test } from "bun:test";

import { methods as acpMethods } from "@agentclientprotocol/sdk";
import type { ClientContext } from "@agentclientprotocol/sdk";

import type { DriverExecutionSessionContext } from "../src/protocol/boot";
import { setupAcpSession } from "../src/runtimes/acp/acp-session-setup";
import { driverBootPayload, driverStartInput } from "./driver-boot-payload-fixture";

const SESSION_CONTEXT = driverBootPayload.execution.session
  .context as DriverExecutionSessionContext;

function withAdditionalDirectories(directories: readonly string[]): typeof driverStartInput {
  return {
    ...driverStartInput,
    execution: {
      ...driverStartInput.execution,
      session: {
        ...driverStartInput.execution.session,
        additionalDirectories: [...directories],
      },
    },
  };
}

function createRecordingConnection(): {
  connection: ClientContext;
  requests: Array<{ method: unknown; params: Record<string, unknown> }>;
} {
  const requests: Array<{ method: unknown; params: Record<string, unknown> }> = [];
  const connection = {
    request: async (method: unknown, params: Record<string, unknown>) => {
      requests.push({ method, params });
      return { sessionId: "acp-session-1" };
    },
  } as unknown as ClientContext;

  return { connection, requests };
}

describe("ACP session setup", () => {
  test("drops additional directories when the agent does not advertise support", async () => {
    const { connection, requests } = createRecordingConnection();

    const setup = await setupAcpSession({
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { close: {}, resume: {} },
      },
      connection,
      currentSessionId: null,
      payload: withAdditionalDirectories(["/workspace/extra"]),
      sessionContext: SESSION_CONTEXT,
      replaySession: async (operation) => operation(),
    });

    expect(setup.mode).toBe("created");
    expect(setup.sessionId).toBe("acp-session-1");
    expect(setup.droppedAdditionalDirectories).toEqual(["/workspace/extra"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe(acpMethods.agent.session.new);
    expect("additionalDirectories" in (requests[0]?.params ?? {})).toBe(false);
  });

  test("passes additional directories through when the agent advertises support", async () => {
    const { connection, requests } = createRecordingConnection();

    const setup = await setupAcpSession({
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { additionalDirectories: {}, close: {} },
      },
      connection,
      currentSessionId: null,
      payload: withAdditionalDirectories(["/workspace/extra"]),
      sessionContext: SESSION_CONTEXT,
      replaySession: async (operation) => operation(),
    });

    expect(setup.droppedAdditionalDirectories).toEqual([]);
    expect(requests[0]?.params["additionalDirectories"]).toEqual(["/workspace/extra"]);
  });
});
