import { describe, expect, test } from "bun:test";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDisabledLogger } from "../src/observability";
import {
  ACP_PROTOCOL_VERSION,
  appendOpenCodeInstruction,
  buildChildEnv,
  buildClientCapabilities,
  assertProtocolVersion,
  isOpenCodeCommand,
  resolveAuthMethod,
  supportsAdditionalDirs,
  supportsSessionClose,
  supportsSessionResume,
} from "../src/runtimes/acp/acp-configuration";
import { AcpDriverBackend, limitAcpInput } from "../src/runtimes/acp/acp-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
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
  test("adds a session instruction to OpenCode's inline config", () => {
    const instructionPath = "/workspace/session/runtime-instructions.md";
    const env = appendOpenCodeInstruction(
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          instructions: ["/managed/instructions.md"],
          model: "deepseek/deepseek-v4-pro",
        }),
      },
      instructionPath,
    );

    expect(isOpenCodeCommand("/usr/local/bin/opencode")).toBe(true);
    expect(isOpenCodeCommand("opencode.exe")).toBe(true);
    expect(isOpenCodeCommand("acp-agent")).toBe(false);
    expect(JSON.parse(env["OPENCODE_CONFIG_CONTENT"] ?? "{}")).toEqual({
      instructions: ["/managed/instructions.md", instructionPath],
      model: "deepseek/deepseek-v4-pro",
    });
    expect(
      JSON.parse(
        appendOpenCodeInstruction(env, instructionPath)["OPENCODE_CONFIG_CONTENT"] ?? "{}",
      ),
    ).toEqual({
      instructions: ["/managed/instructions.md", instructionPath],
      model: "deepseek/deepseek-v4-pro",
    });
  });

  test("accepts the configured ACP protocol version only", () => {
    expect(() => assertProtocolVersion(createInitializeResult(ACP_PROTOCOL_VERSION))).not.toThrow();
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

  test("leaves JSON-RPC parsing and wire validation to the official SDK", async () => {
    let sdkOutput = "";
    const inputReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const handled = Promise.withResolvers<void>();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        inputReady.resolve(controller);
        controller.enqueue(
          new TextEncoder().encode(
            '{\n{}\n{"jsonrpc":"2.0","id":1,"method":"fs/read_text_file","params":{"sessionId":"session-1","path":"/tmp/alive"}}\n',
          ),
        );
      },
    });
    const transport = ndJsonStream(
      new WritableStream<Uint8Array>({
        write(chunk) {
          sdkOutput += new TextDecoder().decode(chunk);
          if (sdkOutput.includes('"content":"alive"')) handled.resolve();
        },
      }),
      limitAcpInput(input),
    );
    const connection = new ClientSideConnection(
      () => ({
        readTextFile: async () => ({ content: "alive" }),
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      }),
      transport,
    );

    await handled.promise;
    (await inputReady.promise).close();
    void connection;
    expect(
      sdkOutput
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toMatchObject([
      { error: { code: -32700 }, id: null, jsonrpc: "2.0" },
      { error: { code: -32600 }, id: null, jsonrpc: "2.0" },
      { id: 1, jsonrpc: "2.0", result: { content: "alive" } },
    ]);
  });

  test("counts UTF-8 bytes across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode("😀\n");
    const stream = (limit: number) =>
      limitAcpInput(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 3));
            controller.enqueue(bytes.subarray(3));
            controller.close();
          },
        }),
        limit,
      );

    await expect(new Response(stream(3)).text()).rejects.toThrow("message exceeds 3 bytes");
    await expect(new Response(stream(4)).text()).resolves.toBe("😀\n");
  });

  test("rejects malformed UTF-8 before the ACP decoder", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(0xc3, 0x28, 0x0a));
        controller.close();
      },
    });

    await expect(new Response(limitAcpInput(input)).text()).rejects.toThrow();
  });

  test("passes one JSON-RPC object across UTF-8 chunks and an unterminated EOF line", async () => {
    const message = '{"jsonrpc":"2.0","method":"session/update","params":{"text":"😀"}}';
    const bytes = new TextEncoder().encode(`\n${message}`);
    const emoji = new TextEncoder().encode("😀");
    const split = bytes.findIndex((byte) => byte === emoji[0]) + 2;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, split));
        controller.enqueue(bytes.subarray(split));
        controller.close();
      },
    });

    expect(await new Response(limitAcpInput(input)).text()).toBe(`\n${message}`);
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
      resolveAuthMethod([{ id: "browser-login", name: "Browser login" }], {
        MOSOO_ACP_AUTH_METHOD_ID: "browser-login",
      }),
    ).toBe("browser-login");

    expect(resolveAuthMethod([{ id: "browser-login", name: "Browser login" }], {})).toBeNull();

    expect(() =>
      resolveAuthMethod([{ id: "browser-login", name: "Browser login" }], {
        MOSOO_ACP_AUTH_METHOD_ID: "device-login",
      }),
    ).toThrow();

    expect(() =>
      resolveAuthMethod(
        [
          {
            args: ["auth"],
            id: "terminal-login",
            name: "Terminal login",
            type: "terminal",
          },
        ],
        { MOSOO_ACP_AUTH_METHOD_ID: "terminal-login" },
      ),
    ).toThrow("requires unsupported terminal auth");
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
    const root = await mkdtemp(join(tmpdir(), "driver-acp-configuration-"));
    const payload = {
      ...bootPayload,
      execution: {
        ...bootPayload.execution,
        session: {
          ...bootPayload.execution.session,
          cwd: root,
          homePath: join(root, "home"),
          sharedRootPath: root,
        },
      },
    };
    const backend = new AcpDriverBackend(payload);
    const context = createAgentDriverContext({
      eventSink: {
        commandUpdate: async () => {},
        currentRunId: () => null,
        pushEvents: async () => ({ accepted: [] }),
      },
      logger: createDisabledLogger(),
      payload,
      permission: {
        request: async () => "reject_once",
      },
    });

    try {
      await expect(backend.start(context, new AbortController().signal)).rejects.toThrow(
        "ACP fallback requires a host integration snapshot.",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
