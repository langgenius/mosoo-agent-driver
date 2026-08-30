import { describe, expect, test } from "bun:test";

import { parseDriverBootPayload } from "../src/protocol/boot";
import { parseDriverNativeRuntimeRef } from "../src/protocol/runtime";
import { mergeProviderOptions } from "../src/runtimes/provider-options";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

describe("Driver boot schema", () => {
  test("uses the runtime parser for native refs and ignores inherited fields", () => {
    const parsed = parseDriverNativeRuntimeRef({
      kind: "openai_thread_id",
      runtimeId: "openai-runtime",
      unknown: true,
      value: "thread-1",
    });

    expect(parsed).toEqual({
      kind: "openai_thread_id",
      runtimeId: "openai-runtime",
      value: "thread-1",
    });
    expect(() =>
      parseDriverNativeRuntimeRef(
        Object.assign(Object.create({ kind: "openai_thread_id" }), {
          runtimeId: "openai-runtime",
          value: "thread-1",
        }),
      ),
    ).toThrow(TypeError);

    expect(() =>
      parseDriverNativeRuntimeRef({
        get kind() {
          throw new Error("getter must stay inside the parser boundary");
        },
        runtimeId: "openai-runtime",
        value: "thread-1",
      }),
    ).toThrow(TypeError);
  });

  test("strips unknown fields and canonicalizes IDs", () => {
    const ignoredCycle: { self?: unknown } = {};
    ignoredCycle.self = ignoredCycle;
    const input = {
      ...driverBootPayload,
      driverInstanceId: driverBootPayload.driverInstanceId.toLowerCase(),
      execution: { ...driverBootPayload.execution, unknownExecutionField: true },
      ignoredCycle,
      unknownRootField: true,
    };
    Object.defineProperty(input, "ignoredGetter", {
      enumerable: true,
      get: () => {
        throw new Error("unknown fields must not be read");
      },
    });
    const parsed = parseDriverBootPayload(input);

    expect(parsed.driverInstanceId).toBe(driverBootPayload.driverInstanceId);
    expect(parsed).not.toHaveProperty("unknownRootField");
    expect(parsed.execution).not.toHaveProperty("unknownExecutionField");
  });

  test("requires the native resume kind to match its runtime", () => {
    expect(() =>
      parseDriverBootPayload({
        ...driverBootPayload,
        execution: {
          ...driverBootPayload.execution,
          session: {
            ...driverBootPayload.execution.session,
            nativeResumeRef: {
              kind: "claude_session_id",
              runtimeId: "openai-runtime",
              value: "thread-1",
            },
          },
        },
      }),
    ).toThrow("does not match runtime openai-runtime");

    expect(() =>
      parseDriverBootPayload({
        ...driverBootPayload,
        execution: {
          ...driverBootPayload.execution,
          session: {
            ...driverBootPayload.execution.session,
            nativeResumeRef: {
              kind: "claude_session_id",
              runtimeId: "claude-agent-sdk",
              value: "session-1",
            },
          },
        },
      }),
    ).toThrow("native resume runtime claude-agent-sdk does not match runtime openai-runtime");

    expect(() =>
      parseDriverBootPayload({
        ...driverBootPayload,
        runtimeTransport: "claude-agent-sdk",
      }),
    ).toThrow("runtime openai-runtime does not match transport claude-agent-sdk");
  });

  test("preserves arbitrary JSON option keys and rejects non-JSON values", () => {
    const providerOptions = JSON.parse('{"__proto__":{"enabled":true}}') as unknown;
    const sparseOptions: unknown[] = [];
    sparseOptions.length = 1;
    const parsed = parseDriverBootPayload({
      ...driverBootPayload,
      execution: { ...driverBootPayload.execution, providerOptions },
    });

    expect(Object.hasOwn(parsed.execution.providerOptions, "__proto__")).toBe(true);
    expect(parsed.execution.providerOptions["__proto__"]).toEqual({ enabled: true });

    const merged = mergeProviderOptions({}, parsed.execution.providerOptions);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, "__proto__")).toBe(true);
    expect(merged).not.toHaveProperty("enabled");

    expect(() =>
      parseDriverBootPayload({
        ...driverBootPayload,
        execution: { ...driverBootPayload.execution, providerOptions: { invalid: Infinity } },
      }),
    ).toThrow("must be JSON-serializable");

    for (const invalid of [new Date(), new Map(), new Set(), sparseOptions]) {
      expect(() =>
        parseDriverBootPayload({
          ...driverBootPayload,
          execution: { ...driverBootPayload.execution, providerOptions: invalid },
        }),
      ).toThrow();
    }
  });

  test("ignores inherited fields at every object boundary", () => {
    const { bootToken: _bootToken, ...withoutBootToken } = driverBootPayload;
    expect(() =>
      parseDriverBootPayload(
        Object.assign(Object.create({ bootToken: "inherited" }), withoutBootToken),
      ),
    ).toThrow("bootToken");

    const { model: _model, ...executionWithoutModel } = driverBootPayload.execution;
    expect(() =>
      parseDriverBootPayload({
        ...driverBootPayload,
        execution: Object.assign(
          Object.create({ model: driverBootPayload.execution.model }),
          executionWithoutModel,
        ),
      }),
    ).toThrow("model");
  });

  test("applies defaults while keeping absent optional fields absent", () => {
    const {
      providerOptions: _providerOptions,
      session: originalSession,
      ...execution
    } = driverBootPayload.execution;
    const { recoveryMessages: _recoveryMessages, ...session } = originalSession;
    const parsed = parseDriverBootPayload({
      ...driverBootPayload,
      execution: {
        ...execution,
        environment: { ...execution.environment, paths: undefined },
        permissionPolicy: null,
        session: {
          ...session,
          mcpServers: [
            {
              authType: "token",
              authorizationState: "disabled",
              credentialScope: "sandbox",
              credentialStatus: "disabled",
              name: "disabled-server",
              serverId: DRIVER_TEST_IDS.agentId,
              subjectLabel: undefined,
            },
          ],
          recoveryMessages: undefined,
        },
        skillCatalog: [
          {
            frontmatter: {},
            mountPath: "/skills/example",
            resolutionMode: "explicit",
            skillId: DRIVER_TEST_IDS.agentId,
            skillName: "example",
          },
        ],
        skills: [
          {
            archiveFormat: "zip",
            blobSha256: "sha256",
            compression: "deflate",
            downloadUrl: "artifact://skill",
            materializationStatus: "ready",
            mountPath: "/skills/example",
            resolutionMode: "explicit",
            skillId: DRIVER_TEST_IDS.agentId,
            skillName: "example",
            snapshotId: undefined,
            warningCode: undefined,
          },
        ],
      },
    });

    expect(parsed.execution.permissionPolicy).toBe("full_access");
    expect(parsed.execution.providerOptions).toEqual({});
    expect(parsed.execution.session.recoveryMessages).toEqual([]);
    expect(parsed.execution.environment).not.toHaveProperty("paths");
    expect(parsed.execution.session.mcpServers[0]).not.toHaveProperty("subjectLabel");
    expect(parsed.execution.skills[0]).not.toHaveProperty("snapshotId");
    expect(parsed.execution.skills[0]).not.toHaveProperty("warningCode");
    expect(parsed.execution.skillCatalog[0]?.frontmatter).toEqual({
      author: null,
      description: null,
      version: null,
    });
  });

  test("rejects array-shaped environment variables", () => {
    expect(() =>
      parseDriverBootPayload({
        ...driverBootPayload,
        execution: {
          ...driverBootPayload.execution,
          environment: { variables: [["NAME", "value"]] },
        },
      }),
    ).toThrow("must be an object");
  });

  test("rejects inherited sparse array entries", () => {
    const directories: string[] = [];
    directories.length = 1;
    Array.prototype[0] = "/inherited";
    try {
      expect(() =>
        parseDriverBootPayload({
          ...driverBootPayload,
          execution: {
            ...driverBootPayload.execution,
            session: { ...driverBootPayload.execution.session, additionalDirectories: directories },
          },
        }),
      ).toThrow();
    } finally {
      delete Array.prototype[0];
    }
  });

  test("rejects unsupported control URL protocols", () => {
    expect(() =>
      parseDriverBootPayload({ ...driverBootPayload, controlUrl: "file:///tmp/socket" }),
    ).toThrow("must use http, https, ws, or wss");
    expect(() => parseDriverBootPayload({ ...driverBootPayload, controlUrl: "not-url" })).toThrow(
      TypeError,
    );
  });

  test.each([
    "",
    "00-00000000000000000000000000000000-0000000000000001-01",
    "00-00000000000000000000000000000001-0000000000000000-01",
    "00-0000000000000000000000000000000g-0000000000000001-01",
    "00-0000000000000000000000000000000A-0000000000000001-01",
    "00-00000000000000000000000000000001-0000000000000001",
  ])("rejects invalid W3C traceparent %p", (traceparent) => {
    expect(() => parseDriverBootPayload({ ...driverBootPayload, traceparent })).toThrow(
      "traceparent",
    );
  });
});
