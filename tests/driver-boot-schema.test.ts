import { describe, expect, test } from "bun:test";

import { parseDriverBootPayload } from "../src/protocol/boot";
import { parseDriverNativeRuntimeRef } from "../src/protocol/runtime";
import { mergeProviderOptions } from "../src/runtimes/provider-options";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

const nativeRef = {
  kind: "openai_thread_id",
  runtimeId: "openai-runtime",
  value: "thread-1",
} as const;
const nativeCheckpoint = {
  formatVersion: 1,
  nativeRef,
  runId: DRIVER_TEST_IDS.secondRunId,
} as const;

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

  test("accepts a new session without a native checkpoint", () => {
    const parsed = parseDriverBootPayload(driverBootPayload);

    expect(parsed.protocolVersion).toBe(8);
    expect(parsed.execution.session.nativeCheckpoint).toBeNull();
    expect(parsed.execution.session.nativeResumeRef).toBeNull();
  });

  test.each([
    ["openai-runtime", "openai-app-server", "openai_thread_id", "thread-1"],
    ["claude-agent-sdk", "claude-agent-sdk", "claude_session_id", "session-1"],
    ["acp-fallback", "acp-fallback", "acp_session_id", "session-1"],
    ["pi", "pi-rpc", "pi_session_path", "sessions/restored.jsonl"],
  ])(
    "accepts a committed checkpoint from a previous %s run",
    (runtime, runtimeTransport, kind, value) => {
      const reference = { kind, runtimeId: runtime, value };
      const checkpoint = { ...nativeCheckpoint, nativeRef: reference };
      const parsed = parseDriverBootPayload({
        ...driverBootPayload,
        runtime,
        runtimeTransport,
        execution: {
          ...driverBootPayload.execution,
          session: {
            ...driverBootPayload.execution.session,
            nativeCheckpoint: checkpoint,
            nativeResumeRef: reference,
          },
        },
      });

      expect(parsed.execution.session.nativeCheckpoint).toEqual(checkpoint);
      expect(parsed.execution.session.nativeResumeRef).toEqual(reference);
      expect(parsed.execution.configRevision.runId).toBe(DRIVER_TEST_IDS.runId);
    },
  );

  test.each([
    { nativeCheckpoint: undefined, nativeResumeRef: null },
    { nativeCheckpoint: null, nativeResumeRef: nativeRef },
    { nativeCheckpoint, nativeResumeRef: null },
    { nativeCheckpoint, nativeResumeRef: { ...nativeRef, value: "another-thread" } },
    {
      nativeCheckpoint: {
        ...nativeCheckpoint,
        nativeRef: { kind: "claude_session_id", runtimeId: "claude-agent-sdk", value: "thread-1" },
      },
      nativeResumeRef: nativeRef,
    },
    {
      nativeCheckpoint: { ...nativeCheckpoint, path: "../../outside" },
      nativeResumeRef: nativeRef,
    },
  ])("rejects an absent, unpaired, or mismatched checkpoint: %p", (session) => {
    expect(() =>
      parseDriverBootPayload({
        ...driverBootPayload,
        execution: {
          ...driverBootPayload.execution,
          session: { ...driverBootPayload.execution.session, ...session },
        },
      }),
    ).toThrow(TypeError);
  });

  test("accepts an explicitly absent Agent preset", () => {
    const parsed = parseDriverBootPayload({
      ...driverBootPayload,
      execution: {
        ...driverBootPayload.execution,
        configRevision: { ...driverBootPayload.execution.configRevision, agentId: null },
      },
    });

    expect(parsed.execution.configRevision.agentId).toBeNull();
  });

  test.each([{ deploymentVersionId: DRIVER_TEST_IDS.agentId }, { deploymentVersionNumber: 1 }])(
    "rejects a deployment revision without an Agent preset: %p",
    (revision) => {
      expect(() =>
        parseDriverBootPayload({
          ...driverBootPayload,
          execution: {
            ...driverBootPayload.execution,
            configRevision: {
              ...driverBootPayload.execution.configRevision,
              ...revision,
              agentId: null,
            },
          },
        }),
      ).toThrow(TypeError);
    },
  );

  test.each([undefined, "pet", "cattle"])(
    "discards the retired sandbox marker: %p",
    (sandboxKind) => {
      const parsed = parseDriverBootPayload({
        ...driverBootPayload,
        execution: {
          ...driverBootPayload.execution,
          session: {
            ...driverBootPayload.execution.session,
            context: { ...driverBootPayload.execution.session.context, sandboxKind },
          },
        },
      });

      expect(parsed.execution.session.context).not.toHaveProperty("sandboxKind");
      expect(parsed.execution.session.context.sandboxSubjectId).toBe(DRIVER_TEST_IDS.sessionId);
    },
  );

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
