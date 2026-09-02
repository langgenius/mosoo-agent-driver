import { describe, expect, test } from "bun:test";
import { delimiter } from "node:path";

import { parseDriverBootPayload } from "../src/protocol/boot";
import type { DriverExecutionEnvironment } from "../src/protocol/boot";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import {
  DRIVER_BOOT_PAYLOAD_ENV_NAME,
  DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME,
  buildRuntimeChildProcessEnv,
} from "../src/runtimes/child-process-env";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

function withEnvironmentPaths(paths: unknown) {
  return {
    ...driverBootPayload,
    execution: {
      ...driverBootPayload.execution,
      environment: { ...driverBootPayload.execution.environment, paths },
    },
  };
}

describe("buildRuntimeChildProcessEnv", () => {
  test("keeps the final environment and removes driver-only boot payload", () => {
    const environment: DriverExecutionEnvironment = driverBootPayload.execution.environment;
    const env = buildRuntimeChildProcessEnv(environment.paths, {
      [DRIVER_BOOT_PAYLOAD_ENV_NAME]: "large-private-payload",
      [DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME]: "large-private-payload-file",
      INHERITED_VAR: "keep",
      PATH: "",
      RUNTIME_VISIBLE_VAR: "visible",
    });

    expect(env["INHERITED_VAR"]).toBe("keep");
    expect(env["PATH"]).toBe("");
    expect(env["RUNTIME_VISIBLE_VAR"]).toBe("visible");
    expect(env[DRIVER_BOOT_PAYLOAD_ENV_NAME]).toBeUndefined();
    expect(env[DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME]).toBeUndefined();
  });

  test("prepends artifact paths to the final child environment", () => {
    const env = buildRuntimeChildProcessEnv(
      {
        executable: ["/artifact/bin"],
        node: ["/artifact/node"],
        python: ["/artifact/python"],
      },
      {
        NODE_PATH: "/runtime/node",
        PATH: "/runtime/bin",
        PYTHONPATH: "/runtime/python",
      },
    );

    expect(env["PATH"]).toBe(["/artifact/bin", "/runtime/bin"].join(delimiter));
    expect(env["NODE_PATH"]).toBe(["/artifact/node", "/runtime/node"].join(delimiter));
    expect(env["PYTHONPATH"]).toBe(["/artifact/python", "/runtime/python"].join(delimiter));
  });

  test("inherits and canonicalizes case-insensitive Windows path variables", () => {
    const env = buildRuntimeChildProcessEnv(
      { executable: ["C:\\artifact"], node: [], python: [] },
      { Path: "C:\\Windows" },
      "win32",
    );

    expect(env["PATH"]).toBe("C:\\artifact;C:\\Windows");
    expect(env).not.toHaveProperty("Path");
  });
});

describe("Driver execution environment paths", () => {
  test("validates the v2 boot metadata before deriving the internal sandbox identity", () => {
    const parsed = parseDriverBootPayload(driverBootPayload);

    expect(parsed.driverControlPort).toBe(20_000);
    expect(parsed.driverGeneration).toBe(0);
    expect(parsed.heartbeatIntervalMs).toBe(1_000);
    expect(createDriverStartInputFromBootPayload(parsed).sandboxId).toBe(
      driverBootPayload.execution.session.context.sandboxId,
    );

    expect(() =>
      parseDriverBootPayload({ ...driverBootPayload, sandboxId: DRIVER_TEST_IDS.secondRunId }),
    ).toThrow("sandbox IDs must match");
  });

  test("parses absolute path arrays as an additive protocol version 1 field", () => {
    const paths = {
      executable: ["/artifact/bin"],
      node: ["/artifact/node"],
      python: ["/artifact/python"],
    };

    expect(parseDriverBootPayload(withEnvironmentPaths(paths)).execution.environment.paths).toEqual(
      paths,
    );
  });

  test("keeps legacy version 1 payloads valid when paths are absent", () => {
    expect(parseDriverBootPayload(driverBootPayload).execution.environment.paths).toBeUndefined();
  });

  test.each(["relative/path", "/artifact/\0bin", `/trusted${delimiter}/tmp/untrusted`])(
    "rejects invalid path %j",
    (path) => {
      expect(() =>
        parseDriverBootPayload(withEnvironmentPaths({ executable: [path], node: [], python: [] })),
      ).toThrow("execution.environment.paths.executable[0]");
    },
  );

  test("preserves dangerous environment variable names as data", () => {
    const payload = structuredClone(driverBootPayload);
    payload.execution.environment.variables = JSON.parse('{"__proto__":"value"}');

    const variables = parseDriverBootPayload(payload).execution.environment.variables;
    expect(Object.hasOwn(variables, "__proto__")).toBe(true);
    expect(variables["__proto__"]).toBe("value");
  });

  test.each([
    ["", "value"],
    ["A=B", "value"],
    ["NAME", "bad\0value"],
  ])("rejects invalid environment entry %j", (name, value) => {
    const payload = structuredClone(driverBootPayload);
    payload.execution.environment.variables = { [name]: value };

    expect(() => parseDriverBootPayload(payload)).toThrow("must be a valid environment entry");
  });
});
