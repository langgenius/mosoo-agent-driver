import type { Logger } from "../observability";
import type { DriverEventInput } from "../protocol/events";
import { pushLosslessEvents } from "./driver-runtime-io";
import type { DriverRuntimeEventPort } from "./driver-runtime-io";

export type DriverDiagnosticCode =
  | "driver.command_loop_failed"
  | "driver.command_failed"
  | "driver.mcp_execute_failed"
  | "driver.runtime_failed"
  | "driver.transport_disconnected"
  | "permission.cancelled"
  | "permission.timed_out";

export type DriverDiagnosticSeverity = "debug" | "error" | "info" | "warn";

export interface DriverDiagnosticInput {
  readonly code: DriverDiagnosticCode;
  readonly details?: Record<string, unknown>;
  readonly message: string;
  readonly reason?: string;
  readonly severity: DriverDiagnosticSeverity;
  readonly source: "core" | "permission" | "process" | "transport";
}

export function createDriverDiagnosticEvent(input: DriverDiagnosticInput): DriverEventInput {
  return {
    kind: "diagnostic.reported",
    payload: {
      code: input.code,
      ...(input.details === undefined ? {} : { details: input.details }),
      message: input.message,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      severity: input.severity,
      source: input.source,
    },
    visibility: "owner_debug",
  };
}

export async function pushDriverDiagnosticEvent(
  port: Pick<DriverRuntimeEventPort, "pushEvents">,
  input: DriverDiagnosticInput,
  logger?: Logger,
): Promise<void> {
  try {
    await pushLosslessEvents(port, [createDriverDiagnosticEvent(input)]);
  } catch (error) {
    logger?.error("driver.diagnostic.report_failed", error, {
      code: input.code,
      source: input.source,
    });
  }
}
