import { isRecord } from "./app-server-json";
import type { JsonObject } from "./app-server-json";

export function validateTurnStatusError(turn: JsonObject, requireTerminal: boolean): string | null {
  const status = turn["status"];

  if (
    requireTerminal &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "interrupted"
  ) {
    return "turn.status must be terminal.";
  }

  return (status === "failed") !== isRecord(turn["error"])
    ? "turn.error must be present exactly when the turn failed."
    : null;
}
