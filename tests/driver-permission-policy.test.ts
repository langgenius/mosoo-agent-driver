import { describe, expect, test } from "bun:test";

import type { DriverPermissionRequest } from "../src/core/driver-permission-broker";
import {
  createDriverPermissionRequestHandler,
  isDriverFullAccess,
  resolveDriverPermissionPolicy,
} from "../src/core/driver-permission-policy";
import type { DriverPermissionPolicy } from "../src/protocol/boot";
import { parseDriverBootPayload } from "../src/protocol/boot";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import type { DriverStartInput } from "../src/protocol/start";
import { driverBootPayload } from "./driver-boot-payload-fixture";

function startInputWithPolicy(policy: DriverPermissionPolicy): DriverStartInput {
  const raw = {
    ...driverBootPayload,
    execution: { ...driverBootPayload.execution, permissionPolicy: policy },
  };
  return createDriverStartInputFromBootPayload(parseDriverBootPayload(raw));
}

const SAMPLE_REQUEST: DriverPermissionRequest = {
  rawInput: "{}",
  requestId: "req-1",
  title: "Approve Bash",
  toolCallId: "call-1",
  toolKind: "Bash",
};

describe("driver permission policy", () => {
  test("reader defaults to full_access when omitted", () => {
    const { permissionPolicy: _omitted, ...executionWithout } = driverBootPayload.execution;
    const parsed = parseDriverBootPayload({ ...driverBootPayload, execution: executionWithout });
    expect(parsed.execution.permissionPolicy).toBe("full_access");
  });

  test("reader parses supervised", () => {
    const raw = {
      ...driverBootPayload,
      execution: { ...driverBootPayload.execution, permissionPolicy: "supervised" },
    };
    expect(parseDriverBootPayload(raw).execution.permissionPolicy).toBe("supervised");
  });

  test("reader rejects an unsupported policy", () => {
    const raw = {
      ...driverBootPayload,
      execution: { ...driverBootPayload.execution, permissionPolicy: "yolo" },
    };
    expect(() => parseDriverBootPayload(raw)).toThrow(/permissionPolicy/);
  });

  test("resolveDriverPermissionPolicy / isDriverFullAccess reflect the payload", () => {
    expect(resolveDriverPermissionPolicy(startInputWithPolicy("full_access"))).toBe("full_access");
    expect(isDriverFullAccess(startInputWithPolicy("full_access"))).toBe(true);
    expect(isDriverFullAccess(startInputWithPolicy("supervised"))).toBe(false);
  });

  test("full_access auto-approves without invoking the supervised handler", async () => {
    let supervisedCalls = 0;
    const handler = createDriverPermissionRequestHandler({
      payload: startInputWithPolicy("full_access"),
      supervised: async () => {
        supervisedCalls += 1;
        return "reject_once";
      },
    });

    await expect(handler(SAMPLE_REQUEST)).resolves.toBe("allow_once");
    expect(supervisedCalls).toBe(0);
  });

  test("supervised delegates to the interactive handler", async () => {
    const seen: DriverPermissionRequest[] = [];
    const handler = createDriverPermissionRequestHandler({
      payload: startInputWithPolicy("supervised"),
      supervised: async (request) => {
        seen.push(request);
        return "reject_once";
      },
    });

    await expect(handler(SAMPLE_REQUEST)).resolves.toBe("reject_once");
    expect(seen).toEqual([SAMPLE_REQUEST]);
  });
});
