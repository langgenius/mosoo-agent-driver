import { describe, expect, test } from "bun:test";

import { createBufferedSinkLogger } from "../src/observability";
import {
  ACP_PROTOCOL_VERSION,
  buildChildEnv,
  buildClientCapabilities,
  assertProtocolVersion,
  resolveAuthMethod,
  supportsAdditionalDirs,
  supportsSessionClose,
  supportsSessionResume,
} from "../src/runtimes/acp/acp-configuration";
import { AcpDriverBackend, limitAcpInput } from "../src/runtimes/acp/acp-driver-backend";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { bootPayload } from "./driver-runtime-boundary-fixtures";

function createInitializeResult(protocolVersion: number | string | null) {
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
      assertProtocolVersion(createInitializeResult(ACP_PROTOCOL_VERSION)),
    ).not.toThrow();
    expect(() =>
      assertProtocolVersion(createInitializeResult(String(ACP_PROTOCOL_VERSION))),
    ).toThrow();

    expect(() => assertProtocolVersion(createInitializeResult(2))).toThrow();
    expect(() => assertProtocolVersion(createInitializeResult(null))).toThrow();
  });

  test("bounds each official transport message before JSON decoding", async () => {
    const encoder = new TextEncoder();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("abc"));
        controller.enqueue(encoder.encode("d\nok\n"));
        controller.close();
      },
    });

    await expect(new Response(limitAcpInput(input, 3)).text()).rejects.toThrow(
      "message exceeds 3 bytes",
    );
  });

  test("advertises stable boolean configuration support", () => {
    expect(buildClientCapabilities()).toEqual({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      session: {
        configOptions: {
          boolean: {},
        },
      },
      terminal: true,
    });
  });

  test("treats null session capabilities as unsupported", () => {
    expect(
      supportsAdditionalDirs({
        sessionCapabilities: { additionalDirectories: null },
      }),
    ).toBe(false);
    expect(supportsSessionClose({ sessionCapabilities: { close: null } })).toBe(false);
    expect(supportsSessionResume({ sessionCapabilities: { resume: null } })).toBe(false);
    expect(supportsSessionClose({ sessionCapabilities: { close: {} } })).toBe(true);
    expect(supportsSessionResume({ sessionCapabilities: { resume: {} } })).toBe(true);
    expect(
      supportsAdditionalDirs({
        sessionCapabilities: { additionalDirectories: {} },
      }),
    ).toBe(true);
  });

  test("fails fast when a configured auth method is not advertised", () => {
    expect(
      resolveAuthMethod([{ id: "browser-login", name: "Browser Login" }], {
        MOSOO_ACP_AUTH_METHOD_ID: "browser-login",
      }),
    ).toBe("browser-login");

    expect(resolveAuthMethod([{ id: "browser-login", name: "Browser Login" }], {})).toBeNull();

    expect(() =>
      resolveAuthMethod([{ id: "browser-login", name: "Browser Login" }], {
        MOSOO_ACP_AUTH_METHOD_ID: "device-login",
      }),
    ).toThrow();
  });

  test("inherits only runtime proxy env and prepends artifact paths", () => {
    const env = buildChildEnv(
      {
        ...bootPayload,
        execution: {
          ...bootPayload.execution,
          environment: {
            paths: { executable: ["/artifact/bin"], node: [], python: [] },
            variables: bootPayload.execution.environment.variables,
          },
        },
      },
      {
        HTTPS_PROXY: "http://host.containers.internal:7897",
        NODE_USE_ENV_PROXY: "1",
        PATH: "/usr/local/bin:/usr/bin",
        RANDOM_SECRET: "secret",
        http_proxy: "http://host.containers.internal:7897",
      },
    );

    expect(env).toMatchObject({
      HTTPS_PROXY: "http://host.containers.internal:7897",
      NODE_USE_ENV_PROXY: "1",
      PATH: "/artifact/bin:/usr/local/bin:/usr/bin",
      http_proxy: "http://host.containers.internal:7897",
    });
    expect(env["RANDOM_SECRET"]).toBeUndefined();
  });

  test("keeps explicit ACP execution proxy env above inherited process env", () => {
    const env = buildChildEnv(
      {
        ...bootPayload,
        execution: {
          ...bootPayload.execution,
          environment: {
            variables: {
              ...bootPayload.execution.environment.variables,
              HTTPS_PROXY: "http://explicit-proxy:7897",
              NO_PROXY: "metadata.google.internal",
            },
          },
        },
      },
      {
        HTTPS_PROXY: "http://ambient-proxy:7897",
        NO_PROXY: "localhost,127.0.0.1",
        PATH: "/usr/local/bin:/usr/bin",
      },
    );

    expect(env["HTTPS_PROXY"]).toBe("http://explicit-proxy:7897");
    expect(env["NO_PROXY"]).toBe("metadata.google.internal");
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
      await expect(backend.start(context, new AbortController().signal)).rejects.toThrow(
        "ACP fallback requires a host integration snapshot.",
      );
    } finally {
      await logger.destroy();
    }
  });
});
