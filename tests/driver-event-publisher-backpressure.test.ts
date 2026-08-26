import { describe, expect, test } from "bun:test";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import type { DriverEventBatchOutput } from "../src/protocol/orpc";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { DriverEventPublisher } from "../src/runtimes/driver-event-publisher";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
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

function createDelta(contentDelta: string): DriverEventInput {
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

function kinds(batches: readonly (readonly DriverEventInput[])[]): string[][] {
  return batches.map((batch) => batch.map((event) => event.kind));
}

function createContext(input: {
  currentRunId?: () => RunId | null;
  pushEvents: (events: DriverEventInput[], signal?: AbortSignal) => Promise<DriverEventBatchOutput>;
}) {
  return createAgentDriverContext({
    eventSink: {
      commandUpdate: async () => {},
      currentRunId: input.currentRunId ?? (() => DRIVER_TEST_IDS.runId),
      pushEvents: async ({ events, signal }) => input.pushEvents(events, signal),
    },
    logger: createTestLogger(),
    payload: bootPayload,
    permission: {
      request: async () => "reject_once",
    },
  });
}

describe("DriverEventPublisher", () => {
  test("resolves only fully accepted callers after a coalesced partial failure", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);
        const accepted = attempts.length === 1 ? events.slice(0, 1) : [];
        return {
          accepted: accepted.map((event, index) => ({
            eventId: event.sourceEventId,
            seq: index + 1,
            type: event.kind,
          })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const first = publisher.push(context, "first", [createEvent("message.started")]);
    const second = publisher.push(context, "second", [createEvent("message.completed")]);

    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes[0]).toEqual({ status: "fulfilled", value: undefined });
    expect(outcomes[1]).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringContaining("made no progress") }),
      status: "rejected",
    });
    expect(kinds(attempts)).toEqual([
      ["message.started", "message.completed"],
      ["message.completed"],
    ]);
    await context.logger.destroy();
  });

  test.each([
    ["rejected lossless", "lossless"],
    ["dropped best effort", "best_effort"],
  ] as const)(
    "a %s push wakes a full in-flight batch if that batch becomes pending",
    async (_name, triggerKind) => {
      const firstSendEntered = Promise.withResolvers<void>();
      const releaseFirstSend = Promise.withResolvers<void>();
      const recovered = Promise.withResolvers<void>();
      const attempts: DriverEventInput[][] = [];
      const context = createContext({
        pushEvents: async (events) => {
          attempts.push(events);

          if (attempts.length === 1) {
            firstSendEntered.resolve();
            await releaseFirstSend.promise;
            throw new Error("socket unavailable");
          }

          recovered.resolve();
          return {
            accepted: events.map((event, index) => ({
              eventId: event.sourceEventId,
              seq: index + 1,
              type: event.kind,
            })),
          };
        },
      });
      const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
      const retained = Array.from({ length: 1_024 }, () => createEvent("message.started"));
      const first = publisher.push(context, "fill", retained);

      await firstSendEntered.promise;
      const trigger = publisher.push(
        context,
        "wake",
        triggerKind === "lossless" ? [createEvent("message.completed")] : [createDelta("wake")],
      );

      if (triggerKind === "lossless") {
        await expect(trigger).rejects.toThrow("exceeds 1024 events");
      } else {
        await expect(trigger).resolves.toBeUndefined();
      }

      releaseFirstSend.resolve();
      await expect(first).rejects.toThrow("socket unavailable");
      expect(
        await Promise.race([recovered.promise.then(() => true), Bun.sleep(50).then(() => false)]),
      ).toBe(true);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.map((event) => event.sourceEventId)).toEqual(
        attempts[0]?.map((event) => event.sourceEventId),
      );
      await context.logger.destroy();
    },
  );
});
