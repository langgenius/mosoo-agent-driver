import type { DriverPermissionPolicy } from "../protocol/boot";
import type { DriverStartInput } from "../protocol/start";
import type { DriverPermissionRequest, PermissionDecision } from "./driver-permission-broker";

export type { DriverPermissionPolicy };

export function resolveDriverPermissionPolicy(payload: DriverStartInput): DriverPermissionPolicy {
  return payload.execution.permissionPolicy;
}

export function isDriverFullAccess(payload: DriverStartInput): boolean {
  return resolveDriverPermissionPolicy(payload) === "full_access";
}

/**
 * Build the permission handler the runtime context uses.
 *
 * Under the `full_access` policy (the default) every tool call is approved
 * synchronously inside the runtime — no control-plane round-trip, no
 * `needs_approval` state churn, and no 5-minute reject-on-timeout window. This
 * grants tools the Sandbox and credential access provisioned for that run; it
 * does not make untrusted input, shared Agent state, credentials, or external
 * side effects safe.
 *
 * Under `supervised` the caller's interactive handler (the permission broker)
 * is used unchanged.
 */
export function createDriverPermissionRequestHandler(input: {
  payload: DriverStartInput;
  supervised: (request: DriverPermissionRequest) => Promise<PermissionDecision>;
}): (request: DriverPermissionRequest) => Promise<PermissionDecision> {
  if (isDriverFullAccess(input.payload)) {
    return async () => "allow_once";
  }

  return input.supervised;
}
