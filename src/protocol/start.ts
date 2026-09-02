import type { DriverBootPayload } from "./boot";
import type { SandboxId } from "./boot/host-ids";
import type { DriverExecutionInput } from "./execution";
import { createDriverExecutionInputFromBootExecution } from "./execution";
import type { DriverInstanceId } from "./id";
import type { DriverRuntime, DriverRuntimeTransport } from "./runtime";

export interface DriverStartInput {
  readonly driverGeneration: number;
  readonly driverInstanceId: DriverInstanceId;
  readonly execution: DriverExecutionInput;
  readonly runtime: DriverRuntime;
  readonly runtimeTransport: DriverRuntimeTransport;
  readonly sandboxId: SandboxId;
}

export function createDriverStartInputFromBootPayload(
  payload: DriverBootPayload,
): DriverStartInput {
  return {
    driverGeneration: payload.driverGeneration,
    driverInstanceId: payload.driverInstanceId,
    execution: createDriverExecutionInputFromBootExecution(payload.execution),
    runtime: payload.runtime,
    runtimeTransport: payload.runtimeTransport,
    sandboxId: payload.execution.session.context.sandboxId,
  };
}
