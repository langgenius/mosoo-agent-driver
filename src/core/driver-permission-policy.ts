import type { DriverPermissionPolicy } from "../protocol/boot";
import type { DriverStartInput } from "../protocol/start";
import type { DriverPermissionRequest } from "../host-ports";
import type { PermissionDecision } from "./driver-permission-broker";

export type { DriverPermissionPolicy };

export function isDriverFullAccess(payload: DriverStartInput): boolean {
  return payload.execution.permissionPolicy === "full_access";
}

/**
 * Build the permission handler the runtime context uses.
 *
 * Under the `full_access` policy (the default), ordinary tool calls are
 * approved synchronously inside the runtime. A provider-reported matched ask
 * rule still delegates to the interactive handler so user policy cannot be
 * bypassed.
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
    return async (request, signal) =>
      request.matchedAskRule === undefined ? "allow_once" : input.supervised(request, signal);
  }

  return input.supervised;
}
