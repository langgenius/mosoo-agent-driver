import { methods as acpMethods, RequestError } from "@agentclientprotocol/sdk";
import type { AgentCapabilities, ClientContext } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "bun:test";

import { setupAcpSession } from "../src/runtimes/acp/acp-session-setup";
import { driverBootPayload, driverStartInput } from "./driver-boot-payload-fixture";

const EXISTING_SESSION_ID = "native-session-existing";

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

function connectionWith(
  request: (method: string, params: unknown) => Promise<unknown>,
): ClientContext {
  return { request } as unknown as ClientContext;
}

function createRecordingConnection(): {
  connection: ClientContext;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const connection = connectionWith(async (method, params) => {
    requests.push({ method, params: params as Record<string, unknown> });
    return { sessionId: "acp-session-1" };
  });

  return { connection, requests };
}

function setupInput(input: {
  readonly agentCapabilities: AgentCapabilities;
  readonly connection: ClientContext;
  readonly currentSessionId: string | null;
  readonly payload?: typeof driverStartInput;
  replaySession<T>(operation: () => Promise<T>): Promise<T>;
}) {
  return {
    ...input,
    payload: input.payload ?? driverStartInput,
    sessionContext: driverBootPayload.execution.session.context,
  };
}

describe("ACP session setup", () => {
  test("drops additional directories when the agent does not advertise support", async () => {
    const { connection, requests } = createRecordingConnection();

    const setup = await setupAcpSession(
      setupInput({
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { close: {}, resume: {} },
        },
        connection,
        currentSessionId: null,
        payload: withAdditionalDirectories(["/workspace/extra"]),
        replaySession: async (operation) => operation(),
      }),
    );

    expect(setup.mode).toBe("created");
    expect(setup.sessionId).toBe("acp-session-1");
    expect(setup.droppedAdditionalDirectories).toEqual(["/workspace/extra"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe(acpMethods.agent.session.new);
    expect("additionalDirectories" in (requests[0]?.params ?? {})).toBe(false);
  });

  test("passes additional directories through when the agent advertises support", async () => {
    const { connection, requests } = createRecordingConnection();

    const setup = await setupAcpSession(
      setupInput({
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { additionalDirectories: {}, close: {} },
        },
        connection,
        currentSessionId: null,
        payload: withAdditionalDirectories(["/workspace/extra"]),
        replaySession: async (operation) => operation(),
      }),
    );

    expect(setup.droppedAdditionalDirectories).toEqual([]);
    expect(requests[0]?.params["additionalDirectories"]).toEqual(["/workspace/extra"]);
  });

  test("prefers resume without entering the load replay scope", async () => {
    const methods: string[] = [];
    let replayCalls = 0;
    const result = await setupAcpSession(
      setupInput({
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
        },
        connection: connectionWith(async (method) => {
          methods.push(method);
          return {};
        }),
        currentSessionId: EXISTING_SESSION_ID,
        replaySession: async (operation) => {
          replayCalls += 1;
          return operation();
        },
      }),
    );

    expect(result).toMatchObject({
      mode: "resumed",
      sessionId: EXISTING_SESSION_ID,
    });
    expect(methods).toEqual([acpMethods.agent.session.resume]);
    expect(replayCalls).toBe(0);
  });

  test("quiesces a resumed session before handing it to the new driver", async () => {
    const methods: string[] = [];
    let resumeCalls = 0;
    const result = await setupAcpSession(
      setupInput({
        agentCapabilities: {
          sessionCapabilities: { close: {}, resume: {} },
        },
        connection: connectionWith(async (method) => {
          methods.push(method);
          if (method === acpMethods.agent.session.resume) {
            resumeCalls += 1;
            return { marker: `resume-${resumeCalls}` };
          }
          return {};
        }),
        currentSessionId: EXISTING_SESSION_ID,
        replaySession: async (operation) => operation(),
      }),
    );

    expect(methods).toEqual([
      acpMethods.agent.session.resume,
      acpMethods.agent.session.close,
      acpMethods.agent.session.resume,
    ]);
    expect(result.raw).toEqual({ marker: "resume-2" });
  });

  test("preserves the native pointer and failure category in resume errors", async () => {
    const setup = setupAcpSession(
      setupInput({
        agentCapabilities: {
          sessionCapabilities: { resume: {} },
        },
        connection: connectionWith(async () => {
          throw RequestError.internalError({ service: "session" }, "OpenCode service failure");
        }),
        currentSessionId: EXISTING_SESSION_ID,
        replaySession: async (operation) => operation(),
      }),
    );

    await expect(setup).rejects.toThrow(
      `ACP native session pointer "${EXISTING_SESSION_ID}" resume failed [category=native_session_restore_failed]: Internal error: OpenCode service failure`,
    );
  });

  test("does not expose a load response before replay is drained", async () => {
    const loadResponded = Promise.withResolvers<void>();
    const replayDrained = Promise.withResolvers<void>();
    let settled = false;
    const setup = setupAcpSession(
      setupInput({
        agentCapabilities: { loadSession: true },
        connection: connectionWith(async (method) => {
          expect(method).toBe(acpMethods.agent.session.load);
          loadResponded.resolve();
          return {};
        }),
        currentSessionId: EXISTING_SESSION_ID,
        replaySession: async (operation) => {
          const result = await operation();
          await replayDrained.promise;
          return result;
        },
      }),
    );
    void setup.then(() => {
      settled = true;
    });

    await loadResponded.promise;
    await Promise.resolve();
    expect(settled).toBe(false);

    replayDrained.resolve();
    await expect(setup).resolves.toMatchObject({
      mode: "loaded",
      sessionId: EXISTING_SESSION_ID,
    });
  });

  test("creates a new session when native restoration is unavailable", async () => {
    const methods: string[] = [];
    const result = await setupAcpSession(
      setupInput({
        agentCapabilities: {},
        connection: connectionWith(async (method) => {
          methods.push(method);
          return { sessionId: "native-session-new" };
        }),
        currentSessionId: EXISTING_SESSION_ID,
        replaySession: async (operation) => operation(),
      }),
    );

    expect(result).toMatchObject({
      mode: "created",
      sessionId: "native-session-new",
    });
    expect(methods).toEqual([acpMethods.agent.session.new]);
  });
});
