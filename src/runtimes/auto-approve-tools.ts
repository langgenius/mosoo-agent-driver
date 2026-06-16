import type { DriverStartInput } from "../protocol/start";

// Headless consumers (Public Thread API, web apps) cannot answer interactive
// tool-confirmation prompts: the public event stream does not carry the
// requestId needed to approve, so a tool-heavy agent would otherwise stall
// waiting for an approval that can never arrive. An Agent whose Environment sets
// MOSOO_DRIVER_AUTO_APPROVE_TOOLS=1 opts every tool call into auto-approval so it
// can run unattended. The Sandbox is already the isolation boundary, so this is
// a per-Agent trust decision, not a global one.
export const AUTO_APPROVE_TOOLS_ENV = "MOSOO_DRIVER_AUTO_APPROVE_TOOLS";

export function shouldAutoApproveTools(payload: DriverStartInput): boolean {
  return payload.execution.environment.variables[AUTO_APPROVE_TOOLS_ENV] === "1";
}
