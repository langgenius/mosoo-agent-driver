import { describe, expect, test } from "bun:test";

import { parseDriverBootPayload } from "../src/protocol/boot";
import {
  DRIVER_BOOT_PAYLOAD_ENV_NAME,
  DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME,
  buildRuntimeChildProcessEnv,
} from "../src/runtimes/child-process-env";
import { driverBootPayload } from "./driver-boot-payload-fixture";

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
    const env = buildRuntimeChildProcessEnv(driverBootPayload.execution.environment.paths, {
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

    expect(env["PATH"]).toBe("/artifact/bin:/runtime/bin");
    expect(env["NODE_PATH"]).toBe("/artifact/node:/runtime/node");
    expect(env["PYTHONPATH"]).toBe("/artifact/python:/runtime/python");
  });
});

describe("Driver execution environment paths", () => {
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

  test.each(["relative/path", "/artifact/\0bin"])("rejects invalid path %j", (path) => {
    expect(() =>
      parseDriverBootPayload(withEnvironmentPaths({ executable: [path], node: [], python: [] })),
    ).toThrow("execution.environment.paths.executable[0]");
  });
});
