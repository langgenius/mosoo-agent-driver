import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createDisabledLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import type { DriverEventBatchOutput } from "../src/protocol/orpc";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import { bootPayload } from "./driver-runtime-boundary-fixtures";

export function createEvent(kind: "message.started" | "message.completed"): DriverEventInput {
  return {
    kind,
    payload: {
      messageId: "message-1",
      ...(kind === "message.started" ? { role: "agent" } : { stopReason: "end_turn" }),
    },
  };
}

export function createDelta(contentDelta: string): DriverEventInput {
  return {
    delivery: "best_effort",
    kind: "message.delta",
    payload: {
      contentDelta,
      messageId: "message-1",
      role: "agent",
    },
  };
}

export function kinds(batches: readonly (readonly DriverEventInput[])[]): string[][] {
  return batches.map((batch) => batch.map((event) => event.kind));
}

export function createContext(input: {
  currentRunId?: () => RunId | null;
  pushEvents: (events: DriverEventInput[], signal?: AbortSignal) => Promise<DriverEventBatchOutput>;
}) {
  return createAgentDriverContext({
    eventSink: {
      commandUpdate: async () => {},
      currentRunId: input.currentRunId ?? (() => DRIVER_TEST_IDS.runId),
      pushEvents: async ({ events, signal }) => input.pushEvents(events, signal),
    },
    logger: createDisabledLogger(),
    payload: bootPayload,
    permission: {
      request: async () => "reject_once",
    },
  });
}
