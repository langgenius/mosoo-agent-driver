import { describe, expect, test } from "bun:test";

import { createBufferedSinkLogger } from "../src/observability";
import {
  ACP_PROTOCOL_VERSION,
  buildAcpChildProcessEnv,
  enforceAcpProtocolVersion,
  resolveAcpAuthMethodId,
} from "../src/runtimes/acp/acp-configuration";
import { AcpDriverBackend } from "../src/runtimes/acp/acp-driver-backend";
import type { AcpInitializeResult } from "../src/runtimes/acp/acp-types";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { bootPayload } from "./driver-runtime-boundary-fixtures";

function createInitializeResult(protocolVersion: number | string | null): AcpInitializeResult {
  return {
    agentCapabilities: {},
    agentInfo: null,
    authMethods: [],
    protocolVersion,
  };
}

describe("ACP runtime configuration", () => {
  test("accepts the configured ACP protocol version only", () => {
    expect(() =>
      enforceAcpProtocolVersion(createInitializeResult(ACP_PROTOCOL_VERSION)),
    ).not.toThrow();
    expect(() =>
      enforceAcpProtocolVersion(createInitializeResult(String(ACP_PROTOCOL_VERSION))),
    ).not.toThrow();

    expect(() => enforceAcpProtocolVersion(createInitializeResult(2))).toThrow();
    expect(() => enforceAcpProtocolVersion(createInitializeResult(null))).toThrow();
  });

  test("fails fast when a configured auth method is not advertised", () => {
    expect(
      resolveAcpAuthMethodId([{ id: "browser-login", name: "Browser Login" }], {
        MOSOO_ACP_AUTH_METHOD_ID: "browser-login",
      }),
    ).toBe("browser-login");

    expect(resolveAcpAuthMethodId([{ id: "browser-login", name: "Browser Login" }], {})).toBeNull();

    expect(() =>
      resolveAcpAuthMethodId([{ id: "browser-login", name: "Browser Login" }], {
        MOSOO_ACP_AUTH_METHOD_ID: "device-login",
      }),
    ).toThrow();
  });

  test("inherits runtime proxy env for ACP child processes only", () => {
    const env = buildAcpChildProcessEnv(bootPayload, {
      HTTPS_PROXY: "http://host.docker.internal:7897",
      NODE_USE_ENV_PROXY: "1",
      PATH: "/usr/local/bin:/usr/bin",
      RANDOM_SECRET: "secret",
      http_proxy: "http://host.docker.internal:7897",
    });

    expect(env).toMatchObject({
      HTTPS_PROXY: "http://host.docker.internal:7897",
      NODE_USE_ENV_PROXY: "1",
      PATH: "/usr/local/bin:/usr/bin",
      http_proxy: "http://host.docker.internal:7897",
    });
    expect(env["RANDOM_SECRET"]).toBeUndefined();
  });

  test("requires host integration snapshot before starting", async () => {
    const logger = createBufferedSinkLogger({
      level: "debug",
      service: "acp-configuration-test",
      sink: async () => {},
    });
    const backend = new AcpDriverBackend(bootPayload);
    const context = createAgentDriverContext({
      eventSink: {
        commandUpdate: async () => {},
        pushEvents: async () => {},
      },
      logger,
      payload: bootPayload,
      permission: {
        request: async () => "reject_once",
      },
    });

    try {
      await expect(backend.start(context)).rejects.toThrow(
        "ACP fallback requires a host integration snapshot.",
      );
    } finally {
      await logger.destroy();
    }
  });
});
