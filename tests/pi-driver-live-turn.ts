import type { InputStartCommand } from "../src/runtime-command";

export interface PiLiveTurnInput {
  readonly commandId: string;
  readonly eventIndex: number;
  readonly requestId: string;
  readonly runId: string;
  readonly text: string;
}

export interface PiLiveTurn {
  readonly command: InputStartCommand;
  readonly commandId: string;
  readonly eventIndex: number;
  readonly requestId: string;
  readonly runId: string;
}

export function createPiLiveTurn(input: PiLiveTurnInput): PiLiveTurn {
  return {
    command: {
      commandId: input.commandId,
      input: { text: input.text },
      kind: "input.start",
      requestId: input.requestId,
      runId: input.runId,
    },
    commandId: input.commandId,
    eventIndex: input.eventIndex,
    requestId: input.requestId,
    runId: input.runId,
  };
}
