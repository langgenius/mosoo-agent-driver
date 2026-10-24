import type { RuntimeToolCallUpdatedPayload } from "../src/protocol/events/runtime-event-types";

export const CANONICAL_TOOL_CALL_STATUSES = [
  "cancelled",
  "completed",
  "failed",
  "running",
] as const satisfies readonly RuntimeToolCallUpdatedPayload["status"][];

export type CanonicalToolCallStatus = (typeof CANONICAL_TOOL_CALL_STATUSES)[number];

export interface ToolCallUpdateLifecycle {
  readonly firstTerminalIndex: number | null;
  readonly hasRunningUpdate: boolean;
  readonly runningAfterTerminal: boolean;
  readonly terminalStatuses: readonly Exclude<CanonicalToolCallStatus, "running">[];
}

export function isCanonicalToolCallStatus(
  value: unknown,
): value is RuntimeToolCallUpdatedPayload["status"] {
  return (
    typeof value === "string" && (CANONICAL_TOOL_CALL_STATUSES as readonly string[]).includes(value)
  );
}

export function inspectToolCallUpdateLifecycle(
  statuses: readonly unknown[],
): ToolCallUpdateLifecycle {
  const firstTerminalIndex = statuses.findIndex((status) => status !== "running");
  const terminalStatuses = statuses.flatMap<Exclude<CanonicalToolCallStatus, "running">>(
    (status) => {
      if (status === "cancelled" || status === "completed" || status === "failed") {
        return [status];
      }
      return [];
    },
  );

  return {
    firstTerminalIndex: firstTerminalIndex === -1 ? null : firstTerminalIndex,
    hasRunningUpdate: statuses.includes("running"),
    runningAfterTerminal:
      firstTerminalIndex === -1
        ? false
        : statuses.slice(firstTerminalIndex + 1).some((status) => status === "running"),
    terminalStatuses,
  };
}
