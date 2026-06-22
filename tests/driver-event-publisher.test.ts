import { describe, expect, test } from "bun:test";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { DriverEventBatchOutput } from "../src/protocol/orpc";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { DriverEventPublisher } from "../src/runtimes/driver-event-publisher";
import { bootPayload } from "./driver-runtime-boundary-fixtures";

function createTestLogger() {
  return createBufferedSinkLogger({
    level: "debug",
    service: "driver-event-publisher-test",
    sink: async () => {},
  });
}

function createEvent(kind: "message.started" | "message.completed"): DriverEventInput {
  return {
    kind,
    payload: {
      messageId: "message-1",
      ...(kind === "message.started" ? { role: "agent" } : { stopReason: "end_turn" }),
    },
  };
}

function createContext(input: {
  pushEvents: (events: DriverEventInput[]) => Promise<DriverEventBatchOutput>;
}) {
  return createAgentDriverContext({
    eventSink: {
      commandUpdate: async () => {},
      pushEvents: async ({ events }) => input.pushEvents(events),
    },
    logger: createTestLogger(),
    payload: bootPayload,
    permission: {
      request: async () => "reject_once",
    },
  });
}

describe("DriverEventPublisher", () => {
  test("retries a failed batch and advances the accepted seq cursor", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          throw new Error("socket send failed");
        }

        return {
          accepted: events.map((event, index) => ({
            seq: 40 + index,
            type: event.kind,
          })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const started = createEvent("message.started");
    const completed = createEvent("message.completed");

    await expect(publisher.push(context, "first", [started])).rejects.toThrow("socket send failed");
    await publisher.push(context, "second", [completed]);

    expect(attempts).toEqual([[started], [started, completed]]);
    expect(publisher.lastAcceptedSeq()).toBe(41);
  });
});
