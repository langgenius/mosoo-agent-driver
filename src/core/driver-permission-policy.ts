import type { DriverPermissionPolicy } from "../protocol/boot";
import type { DriverStartInput } from "../protocol/start";
import type { DriverPermissionRequest, PermissionDecision } from "./driver-permission-broker";

export type { DriverPermissionPolicy };

export function isDriverFullAccess(payload: DriverStartInput): boolean {
  return payload.execution.permissionPolicy === "full_access";
}

/**
 * Build the permission handler the runtime context uses.
 *
 * Under the `full_access` policy (the default) every tool call is approved
 * synchronously inside the runtime — no control-plane round-trip, no
 * `needs_approval` state churn, and no 5-minute reject-on-timeout window. The
 * sandbox is the isolation boundary, so this is safe and removes permission
 * latency from the critical path entirely.
 *
 * Under `supervised` the caller's interactive handler (the permission broker)
 * is used unchanged.
 */
export function createDriverPermissionRequestHandler(input: {
  payload: DriverStartInput;
  supervised: (
    request: DriverPermissionRequest,
    signal?: AbortSignal,
  ) => Promise<PermissionDecision>;
}): (request: DriverPermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision> {
  if (isDriverFullAccess(input.payload)) {
    return async () => "allow_once";
  }

  return input.supervised;
}
