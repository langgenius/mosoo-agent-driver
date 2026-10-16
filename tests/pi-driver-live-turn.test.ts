import { expect, test } from "bun:test";

import { parseRuntimeCommand } from "../src/runtime-command";
import { createPiLiveTurn } from "./pi-driver-live-turn";

test("keeps event metadata outside the input.start command", () => {
  const turn = createPiLiveTurn({
    commandId: "command-1",
    eventIndex: 7,
    requestId: "request-1",
    runId: "run-1",
    text: "hello",
  });

  expect(() => parseRuntimeCommand(turn.command)).not.toThrow();
  expect(Object.keys(turn.command).toSorted()).toEqual([
    "commandId",
    "input",
    "kind",
    "requestId",
    "runId",
  ]);
  expect(turn.eventIndex).toBe(7);
});
