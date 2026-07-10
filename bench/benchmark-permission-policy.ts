import type { DriverPermissionPolicy } from "../src/protocol/boot";
import type { DriverStartInput } from "../src/protocol/start";

export function applyBenchmarkPermissionPolicy(
  input: DriverStartInput,
  permissionPolicy: DriverPermissionPolicy,
): DriverStartInput {
  return {
    ...input,
    execution: {
      ...input.execution,
      permissionPolicy,
    },
  };
}
