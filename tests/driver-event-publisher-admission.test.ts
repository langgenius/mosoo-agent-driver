import { describe, expect, test } from "bun:test";

import { pushLosslessEvents, withSourceEventIds } from "../src/core/driver-runtime-io";
import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import type { RunId } from "../src/protocol/id";
import type { DriverEventBatchOutput } from "../src/protocol/orpc";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { DriverEventPublisher } from "../src/runtimes/driver-event-publisher";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";
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

function createRunTerminal(
  kind: "run.cancelled" | "run.completed" | "run.failed",
): DriverEventInput {
  return {
    kind,
    payload:
      kind === "run.failed"
        ? { error: { code: "runtime_failed", message: "failed", retryable: false } }
        : kind === "run.cancelled"
          ? { requestedBy: "user", stopReason: "cancelled" }
          : {},
    runId: DRIVER_TEST_IDS.runId,
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
      ...(input.currentRunId === undefined ? {} : { currentRunId: input.currentRunId }),
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
  test("keeps an explicit source ID across direct lossless retries", async () => {
    const attempts: DriverEventInput[][] = [];
    const events = withSourceEventIds([createEvent("message.completed")]);
    const port = {
      pushEvents: async ({ events: sent }: { events: DriverEventInput[] }) => {
        attempts.push(sent);

        if (attempts.length === 1) {
          throw new Error("response lost");
        }

        return {
          accepted: sent.map((event, index) => ({
            eventId: event.sourceEventId,
            seq: index + 1,
            type: event.kind,
          })),
        };
      },
    };

    await expect(pushLosslessEvents(port, events)).rejects.toThrow("response lost");
    await pushLosslessEvents(port, events);

    expect(isDriverId(attempts[0]?.[0]?.sourceEventId)).toBe(true);
    expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
  });

  test.each([
    ["without", undefined],
    ["with", "explicit-source-event-id"],
  ] as const)(
    "takes deep ownership of direct lossless input %s a source ID",
    async (_name, sourceEventId) => {
      const firstSendEntered = Promise.withResolvers<void>();
      const releaseFirstSend = Promise.withResolvers<void>();
      const attempts: DriverEventInput[][] = [];
      const mutable = {
        ...createEvent("message.completed"),
        ...(sourceEventId === undefined ? {} : { sourceEventId }),
        payload: {
          messageId: "message-1",
          metadata: { label: "original" },
          stopReason: "end_turn",
        },
      };
      const port = {
        pushEvents: async ({ events }: { events: DriverEventInput[] }) => {
          attempts.push(events);

          if (attempts.length === 1) {
            firstSendEntered.resolve();
            await releaseFirstSend.promise;

            return {
              accepted: [
                {
                  eventId: events[0]?.sourceEventId,
                  seq: 1,
                  type: events[0]!.kind,
                },
              ],
            };
          }

          return {
            accepted: events.map((event, index) => ({
              eventId: event.sourceEventId,
              seq: index + 2,
              type: event.kind,
            })),
          };
        },
      };

      const delivery = pushLosslessEvents(port, [createEvent("message.started"), mutable]);
      await firstSendEntered.promise;
      mutable.payload.metadata.label = "changed-during-send";
      releaseFirstSend.resolve();
      await delivery;

      expect(
        attempts.map((events) =>
          events.map(
            (event) => (event.payload as { metadata?: { label?: string } }).metadata?.label ?? null,
          ),
        ),
      ).toEqual([[null, "original"], ["original"]]);
      expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[1]?.sourceEventId);

      if (sourceEventId !== undefined) {
        expect(attempts[1]?.[0]?.sourceEventId).toBe(sourceEventId);
      }
    },
  );

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

    expect(kinds(attempts)).toEqual([
      ["message.started"],
      ["message.started", "message.completed"],
    ]);
    expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
    expect(isDriverId(attempts[0]?.[0]?.sourceEventId)).toBe(true);
    expect(isDriverId(attempts[1]?.[1]?.sourceEventId)).toBe(true);
    expect(publisher.lastAcceptedSeq()).toBe(41);
    await context.logger.destroy();
  });

  test("rejects new events when failed delivery fills the bounded queue", async () => {
    const context = createContext({
      pushEvents: async () => {
        throw new Error("socket unavailable");
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const retained = Array.from({ length: 1_024 }, () => createEvent("message.started"));

    await expect(publisher.push(context, "fill", retained)).rejects.toThrow("socket unavailable");
    await expect(
      publisher.push(context, "overflow", [createEvent("message.completed")]),
    ).rejects.toThrow("Driver event queue exceeds 1024 events.");
    await context.logger.destroy();
  });

  test.each(["run.cancelled", "run.completed", "run.failed"] as const)(
    "admits one %s event after the lossless queue is full",
    async (kind) => {
      const attempts: DriverEventInput[][] = [];
      const context = createContext({
        pushEvents: async (events) => {
          attempts.push(events);

          if (attempts.length === 1) {
            throw new Error("socket unavailable");
          }

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

      await expect(publisher.push(context, "fill", retained)).rejects.toThrow("socket unavailable");
      await expect(
        publisher.push(context, "terminal", [createRunTerminal(kind)]),
      ).resolves.toBeUndefined();

      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toHaveLength(1_025);
      expect(attempts[1]?.at(-1)?.kind).toBe(kind);
      await context.logger.destroy();
    },
  );

  test("reserves exactly one run terminal slot", async () => {
    let sends = 0;
    const context = createContext({
      pushEvents: async () => {
        sends += 1;
        return { accepted: [] };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");

    await expect(
      publisher.push(context, "terminal", [
        createRunTerminal("run.completed"),
        createRunTerminal("run.failed"),
      ]),
    ).rejects.toThrow("run terminal slot");
    expect(sends).toBe(0);
    await context.logger.destroy();
  });

  test("bounds the independent run terminal slot by bytes", async () => {
    let sends = 0;
    const context = createContext({
      pushEvents: async () => {
        sends += 1;
        return { accepted: [] };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const terminal = {
      ...createRunTerminal("run.completed"),
      payload: { detail: "x".repeat(1_024 * 1_024) },
    };

    await expect(publisher.push(context, "terminal", [terminal])).rejects.toThrow(
      "run terminal batch exceeds 1048576 UTF-8 bytes",
    );
    expect(sends).toBe(0);
    await context.logger.destroy();
  });

  test("admits a bounded closing batch through the full regular lossless lane", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          throw new Error("socket unavailable");
        }

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
    const closing = [
      createEvent("message.completed"),
      {
        kind: "thought.completed",
        payload: { channel: "summary", thoughtId: "thought-1" },
      } satisfies DriverEventInput,
      createRunTerminal("run.completed"),
    ];

    await expect(publisher.push(context, "fill", retained)).rejects.toThrow("socket unavailable");
    await expect(publisher.push(context, "terminal", closing)).resolves.toBeUndefined();

    expect(attempts[1]).toHaveLength(1_027);
    expect(attempts[1]?.slice(-3).map((event) => event.kind)).toEqual([
      "message.completed",
      "thought.completed",
      "run.completed",
    ]);
    await context.logger.destroy();
  });

  test("drops an oversized best-effort prefix without blocking its run terminal", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);
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

    await publisher.push(context, "terminal", [
      ...Array.from({ length: 2_048 }, (_, index) => createDelta(String(index))),
      createRunTerminal("run.completed"),
    ]);

    expect(kinds(attempts)).toEqual([["run.completed"]]);
    await context.logger.destroy();
  });

  test("shares one overall deadline across a mixed-delivery push", async () => {
    const nativeTimeout = AbortSignal.timeout;
    const signals: (AbortSignal | undefined)[] = [];
    let timeouts = 0;
    AbortSignal.timeout = () => {
      timeouts += 1;
      return new AbortController().signal;
    };
    const context = createContext({
      pushEvents: async (events, signal) => {
        signals.push(signal);
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

    try {
      await publisher.push(context, "mixed", [
        createDelta("before"),
        createEvent("message.completed"),
        createDelta("after"),
      ]);
    } finally {
      AbortSignal.timeout = nativeTimeout;
      await context.logger.destroy();
    }

    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(new Set(signals).size).toBe(1);
    expect(timeouts).toBe(1);
  });

  test("freezes the active run before a queued partial delivery", async () => {
    const firstSendEntered = Promise.withResolvers<void>();
    const releaseFirstSend = Promise.withResolvers<void>();
    const attempts: DriverEventInput[][] = [];
    let activeRunId = DRIVER_TEST_IDS.runId as RunId;
    const logger = createTestLogger();
    const context = createAgentDriverContext({
      eventSink: {
        currentRunId: () => activeRunId,
        pushEvents: async ({ events }) => {
          const canonical = events.flatMap((event) =>
            toDriverEventEnvelopes(driverBootPayload, event, activeRunId),
          );
          attempts.push(canonical.map(({ event }) => event));

          if (attempts.length === 1) {
            firstSendEntered.resolve();
            await releaseFirstSend.promise;
          }

          if (attempts.length === 2) {
            activeRunId = DRIVER_TEST_IDS.thirdRunId;
          }

          const accepted = attempts.length === 2 ? canonical.slice(0, 1) : canonical;
          return {
            accepted: accepted.map((envelope, index) => ({
              eventId: envelope.eventId,
              seq: attempts.length * 10 + index,
              type: envelope.event.kind,
            })),
          };
        },
      },
      logger,
      payload: bootPayload,
      permission: {
        request: async () => "reject_once",
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const gate = publisher.push(context, "gate", [createEvent("message.started")]);

    await firstSendEntered.promise;
    const queued = publisher.push(context, "queued", [
      createEvent("message.started"),
      createEvent("message.completed"),
    ]);
    activeRunId = DRIVER_TEST_IDS.secondRunId;
    releaseFirstSend.resolve();
    await Promise.all([gate, queued]);

    expect(attempts.slice(1).map((events) => events.map((event) => event.runId))).toEqual([
      [DRIVER_TEST_IDS.runId, DRIVER_TEST_IDS.runId],
      [DRIVER_TEST_IDS.runId],
    ]);
    expect(attempts[2]?.[0]?.sourceEventId).toBe(attempts[1]?.[1]?.sourceEventId);
    await logger.destroy();
  });

  test("coalesces concurrent singleton pushes without starving the final terminal", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);
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
    const pushes = Array.from({ length: 1_024 }, () =>
      publisher.push(context, "singleton", [createEvent("message.started")]),
    );
    pushes.push(publisher.push(context, "terminal", [createRunTerminal("run.completed")]));

    await Promise.all(pushes);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toHaveLength(1_025);
    expect(attempts[0]?.at(-1)?.kind).toBe("run.completed");
    await context.logger.destroy();
  });

  test("does not block best-effort producers on transport acknowledgements", async () => {
    const firstSendEntered = Promise.withResolvers<void>();
    const releaseFirstSend = Promise.withResolvers<void>();
    const context = createContext({
      pushEvents: async (events) => {
        firstSendEntered.resolve();
        await releaseFirstSend.promise;

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
    const first = publisher.push(context, "first", [createDelta("a")]);

    await firstSendEntered.promise;
    const blocked = await Promise.race([first.then(() => false), Bun.sleep(10).then(() => true)]);
    releaseFirstSend.resolve();
    await publisher.push(context, "flush", [createEvent("message.completed")]);

    expect(blocked).toBe(false);
    await context.logger.destroy();
  });

  test("bounds the number of closing events in a run terminal batch", async () => {
    let sends = 0;
    const context = createContext({
      pushEvents: async () => {
        sends += 1;
        return { accepted: [] };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");

    await expect(
      publisher.push(context, "terminal", [
        ...Array.from({ length: 64 }, () => createEvent("message.completed")),
        createRunTerminal("run.completed"),
      ]),
    ).rejects.toThrow("run terminal batch exceeds 64 events");
    expect(sends).toBe(0);
    await context.logger.destroy();
  });
});
