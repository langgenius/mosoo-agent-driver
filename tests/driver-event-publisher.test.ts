import { describe, expect, test } from "bun:test";

import {
  pushLosslessEvents,
  withSourceEventIds,
} from "../src/core/driver-runtime-io";
import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import type { RunId } from "../src/protocol/id";
import type { DriverEventBatchOutput } from "../src/protocol/orpc";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
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

function createUnscopedRunTerminal(
  kind: "run.cancelled" | "run.completed" | "run.failed",
): DriverEventInput {
  const { runId: _, ...event } = createRunTerminal(kind);
  return event;
}

function kinds(batches: readonly (readonly DriverEventInput[])[]): string[][] {
  return batches.map((batch) => batch.map((event) => event.kind));
}

function createContext(input: {
  currentRunId?: () => RunId | null;
  pushEvents: (
    events: DriverEventInput[],
    signal?: AbortSignal,
  ) => Promise<DriverEventBatchOutput>;
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

      const delivery = pushLosslessEvents(port, [
        createEvent("message.started"),
        mutable,
      ]);
      await firstSendEntered.promise;
      mutable.payload.metadata.label = "changed-during-send";
      releaseFirstSend.resolve();
      await delivery;

      expect(
        attempts.map((events) =>
          events.map(
            (event) =>
              (event.payload as { metadata?: { label?: string } }).metadata?.label ?? null,
          ),
        ),
      ).toEqual([
        [null, "original"],
        ["original"],
      ]);
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
      const retained = Array.from({ length: 1_024 }, () =>
        createEvent("message.started"),
      );

      await expect(publisher.push(context, "fill", retained)).rejects.toThrow(
        "socket unavailable",
      );
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

    await expect(publisher.push(context, "fill", retained)).rejects.toThrow(
      "socket unavailable",
    );
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
    pushes.push(
      publisher.push(context, "terminal", [createRunTerminal("run.completed")]),
    );

    await Promise.all(pushes);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toHaveLength(1_025);
    expect(attempts[0]?.at(-1)?.kind).toBe("run.completed");
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

  test("attributes a coalesced poison event only to its caller", async () => {
    const delivered: DriverEventInput[] = [];
    let nextSeq = 1;
    const context = createContext({
      pushEvents: async (events) => {
        const envelopes = events.flatMap((event) =>
          toDriverEventEnvelopes(driverBootPayload, event, DRIVER_TEST_IDS.runId),
        );
        delivered.push(...envelopes.map(({ event }) => event));
        return {
          accepted: envelopes.map((envelope) => ({
            eventId: envelope.eventId,
            seq: nextSeq++,
            type: envelope.event.kind,
          })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const poison = publisher.push(context, "poison", [
      { kind: "invalid.kind", payload: {} } as unknown as DriverEventInput,
    ]);
    const terminal = publisher.push(context, "terminal", [
      createRunTerminal("run.completed"),
    ]);

    const outcomes = await Promise.allSettled([poison, terminal]);

    expect(outcomes[0]).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringContaining("unsupported") }),
      status: "rejected",
    });
    expect(outcomes[1]).toEqual({ status: "fulfilled", value: undefined });
    expect(kinds([delivered])).toEqual([["run.completed"]]);
    await context.logger.destroy();
  });

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

  test("treats an identical pending run terminal retry as one idempotent delivery", async () => {
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
    const terminal = createRunTerminal("run.completed");

    await expect(publisher.push(context, "terminal", [terminal])).rejects.toThrow(
      "socket unavailable",
    );
    await expect(publisher.push(context, "terminal.retry", [terminal])).resolves.toBeUndefined();

    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
    await context.logger.destroy();
  });

  test("does not join the same raw terminal after the active run changes", async () => {
    const attempts: DriverEventInput[][] = [];
    const oldRunRecovered = Promise.withResolvers<void>();
    let activeRunId = DRIVER_TEST_IDS.runId as RunId;
    const context = createContext({
      currentRunId: () => activeRunId,
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          throw new Error("socket unavailable");
        }

        if (attempts.length === 2) {
          oldRunRecovered.resolve();
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
    const terminal = createUnscopedRunTerminal("run.completed");

    await expect(publisher.push(context, "run-1", [terminal])).rejects.toThrow(
      "socket unavailable",
    );
    activeRunId = DRIVER_TEST_IDS.secondRunId;
    await expect(publisher.push(context, "run-2", [terminal])).rejects.toThrow(
      "run terminal slot",
    );
    await oldRunRecovered.promise;
    await Bun.sleep(0);
    await publisher.push(context, "run-2.retry", [terminal]);

    expect(attempts.map(([event]) => event?.runId)).toEqual([
      DRIVER_TEST_IDS.runId,
      DRIVER_TEST_IDS.runId,
      DRIVER_TEST_IDS.secondRunId,
    ]);
    expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
    expect(attempts[2]?.[0]?.sourceEventId).not.toBe(attempts[0]?.[0]?.sourceEventId);
    await context.logger.destroy();
  });

  test.each(["run.cancelled", "run.completed", "run.failed"] as const)(
    "joins an old %s retry with an explicit frozen run after the active run changes",
    async (kind) => {
      const attempts: DriverEventInput[][] = [];
      let activeRunId = DRIVER_TEST_IDS.runId as RunId;
      const context = createContext({
        currentRunId: () => activeRunId,
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
      const terminal = createUnscopedRunTerminal(kind);

      await expect(publisher.push(context, "terminal", [terminal])).rejects.toThrow(
        "socket unavailable",
      );
      activeRunId = DRIVER_TEST_IDS.secondRunId;
      await publisher.push(context, "terminal.retry", [
        { ...terminal, runId: DRIVER_TEST_IDS.runId },
      ]);

      expect(attempts.map(([event]) => event?.runId)).toEqual([
        DRIVER_TEST_IDS.runId,
        DRIVER_TEST_IDS.runId,
      ]);
      expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
      await context.logger.destroy();
    },
  );

  test.each([
    [
      "the same active run",
      DRIVER_TEST_IDS.runId,
      undefined,
      DRIVER_TEST_IDS.runId,
      DRIVER_TEST_IDS.runId,
    ],
    [
      "an explicit run override",
      DRIVER_TEST_IDS.runId,
      DRIVER_TEST_IDS.thirdRunId,
      DRIVER_TEST_IDS.secondRunId,
      DRIVER_TEST_IDS.thirdRunId,
    ],
    ["no active run", null, undefined, null, null],
  ] as const)(
    "keeps terminal retry identity with %s",
    async (_name, initialActiveRunId, eventRunId, nextActiveRunId, expectedRunId) => {
      const attempts: DriverEventInput[][] = [];
      let activeRunId: RunId | null = initialActiveRunId;
      const context = createContext({
        currentRunId: () => activeRunId,
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
      const raw = createUnscopedRunTerminal("run.completed");
      const terminal =
        eventRunId === undefined ? raw : { ...raw, runId: eventRunId };

      await expect(publisher.push(context, "terminal", [terminal])).rejects.toThrow(
        "socket unavailable",
      );
      activeRunId = nextActiveRunId;
      await publisher.push(context, "terminal.retry", [terminal]);

      expect(attempts.map(([event]) => event?.runId ?? null)).toEqual([
        expectedRunId,
        expectedRunId,
      ]);
      expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
      await context.logger.destroy();
    },
  );

  test.each([
    ["joins the pending terminal for the same", "source-terminal-1", true],
    ["keeps the pending occurrence for a different", "source-terminal-2", false],
  ] as const)(
    "%s explicit source ID",
    async (_name, retrySourceEventId, joinsPending) => {
      const attempts: DriverEventInput[][] = [];
      const delivered = Promise.withResolvers<void>();
      const context = createContext({
        currentRunId: () => DRIVER_TEST_IDS.runId,
        pushEvents: async (events) => {
          attempts.push(events);

          if (attempts.length === 1) {
            throw new Error("socket unavailable");
          }

          delivered.resolve();
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
      const terminal = {
        ...createUnscopedRunTerminal("run.completed"),
        sourceEventId: "source-terminal-1",
      };

      await expect(publisher.push(context, "terminal", [terminal])).rejects.toThrow(
        "socket unavailable",
      );
      const retry = publisher.push(context, "terminal.retry", [
        { ...terminal, sourceEventId: retrySourceEventId },
      ]);

      if (joinsPending) {
        await expect(retry).resolves.toBeUndefined();
      } else {
        await expect(retry).rejects.toThrow("run terminal slot");
        await delivered.promise;
        await Bun.sleep(0);
      }

      expect(attempts).toHaveLength(2);
      expect(attempts.map(([event]) => event?.sourceEventId)).toEqual([
        "source-terminal-1",
        "source-terminal-1",
      ]);
      await context.logger.destroy();
    },
  );

  test.each([
    ["ordinary lossless", "ordinary"],
    ["different terminal", "terminal"],
    ["best effort", "best_effort"],
  ] as const)(
    "a rejected or dropped %s push wakes a full retained terminal batch without joining it",
    async (_name, triggerKind) => {
      const attempts: DriverEventInput[][] = [];
      const recovered = Promise.withResolvers<void>();
      const context = createContext({
        pushEvents: async (events) => {
          attempts.push(events);

          if (attempts.length <= 2) {
            throw new Error(`socket unavailable ${attempts.length}`);
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
      const retained = Array.from({ length: 1_024 }, () =>
        createEvent("message.started"),
      );

      await expect(publisher.push(context, "fill", retained)).rejects.toThrow(
        "socket unavailable 1",
      );
      await expect(
        publisher.push(context, "terminal", [createRunTerminal("run.completed")]),
      ).rejects.toThrow("socket unavailable 2");

      const trigger =
        triggerKind === "ordinary"
          ? publisher.push(context, "ordinary.retry", [createEvent("message.completed")])
          : triggerKind === "terminal"
            ? publisher.push(context, "terminal.retry", [createRunTerminal("run.failed")])
            : publisher.push(context, "stream.retry", [createDelta("wake")]);

      if (triggerKind === "best_effort") {
        await expect(trigger).resolves.toBeUndefined();
      } else {
        await expect(trigger).rejects.toThrow(
          triggerKind === "terminal" ? "run terminal slot" : "exceeds 1024 events",
        );
      }

      expect(
        await Promise.race([
          recovered.promise.then(() => true),
          Bun.sleep(50).then(() => false),
        ]),
      ).toBe(true);
      expect(attempts).toHaveLength(3);
      expect(attempts[2]?.map((event) => event.sourceEventId)).toEqual(
        attempts[1]?.map((event) => event.sourceEventId),
      );
      expect(attempts[2]?.at(-1)?.kind).toBe("run.completed");
      await context.logger.destroy();
    },
  );

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
      const retained = Array.from({ length: 1_024 }, () =>
        createEvent("message.started"),
      );
      const first = publisher.push(context, "fill", retained);

      await firstSendEntered.promise;
      const trigger = publisher.push(
        context,
        "wake",
        triggerKind === "lossless"
          ? [createEvent("message.completed")]
          : [createDelta("wake")],
      );

      if (triggerKind === "lossless") {
        await expect(trigger).rejects.toThrow("exceeds 1024 events");
      } else {
        await expect(trigger).resolves.toBeUndefined();
      }

      releaseFirstSend.resolve();
      await expect(first).rejects.toThrow("socket unavailable");
      expect(
        await Promise.race([
          recovered.promise.then(() => true),
          Bun.sleep(50).then(() => false),
        ]),
      ).toBe(true);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.map((event) => event.sourceEventId)).toEqual(
        attempts[0]?.map((event) => event.sourceEventId),
      );
      await context.logger.destroy();
    },
  );

  test("does not spin while an explicitly retried pending terminal keeps failing", async () => {
    let attempts = 0;
    const context = createContext({
      currentRunId: () => DRIVER_TEST_IDS.runId,
      pushEvents: async () => {
        attempts += 1;
        throw new Error("socket unavailable");
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const terminal = createUnscopedRunTerminal("run.completed");

    await expect(publisher.push(context, "terminal", [terminal])).rejects.toThrow(
      "socket unavailable",
    );
    await expect(publisher.push(context, "terminal.retry", [terminal])).rejects.toThrow(
      "socket unavailable",
    );
    await Bun.sleep(20);

    expect(attempts).toBe(2);
    await context.logger.destroy();
  });

  test("drains a partial receipt before resolving the same reliable push", async () => {
    const firstSendEntered = Promise.withResolvers<void>();
    const releaseFirstSend = Promise.withResolvers<void>();
    const attempts: DriverEventInput[][] = [];
    let nextSeq = 40;
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          firstSendEntered.resolve();
          await releaseFirstSend.promise;
        }

        const acceptedEvents = attempts.length === 1 ? events.slice(0, 1) : events;
        return {
          accepted: acceptedEvents.map((event) => ({
            seq: nextSeq++,
            type: event.kind,
          })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const firstBatch = [createEvent("message.started"), createEvent("message.completed")];
    const laterEvent = createEvent("message.started");

    const first = publisher.push(context, "first", firstBatch);
    await firstSendEntered.promise;
    const second = publisher.push(context, "second", [laterEvent]);
    await Promise.resolve();
    expect(attempts).toHaveLength(1);

    releaseFirstSend.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(kinds(attempts)).toEqual([
      ["message.started", "message.completed"],
      ["message.completed"],
      ["message.started"],
    ]);
    expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[1]?.sourceEventId);
    expect(publisher.lastAcceptedSeq()).toBe(42);
    await context.logger.destroy();
  });

  test("fails a reliable push that makes no receipt progress and retries it later", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          return { accepted: [] };
        }

        return {
          accepted: events.map((event, index) => ({
            seq: 50 + index,
            type: event.kind,
          })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const firstBatch = [createEvent("message.started"), createEvent("message.completed")];
    const laterEvent = createEvent("message.started");

    await expect(publisher.push(context, "first", firstBatch)).rejects.toThrow(
      "made no progress",
    );
    await publisher.push(context, "retry", [laterEvent]);

    expect(kinds(attempts)).toEqual([
      ["message.started", "message.completed"],
      ["message.started", "message.completed", "message.started"],
    ]);
    expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
    expect(attempts[1]?.[1]?.sourceEventId).toBe(attempts[0]?.[1]?.sourceEventId);
    expect(publisher.lastAcceptedSeq()).toBe(52);
    await context.logger.destroy();
  });

  test("retains only the unaccepted suffix after progress stops", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          return {
            accepted: [{ seq: 40, type: events[0]!.kind }],
          };
        }

        if (attempts.length === 2) {
          return { accepted: [] };
        }

        return {
          accepted: events.map((event, index) => ({
            seq: 50 + index,
            type: event.kind,
          })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const started = createEvent("message.started");
    const completed = createEvent("message.completed");
    const laterEvent = createEvent("message.started");

    await expect(publisher.push(context, "first", [started, completed])).rejects.toThrow(
      "made no progress",
    );
    expect(publisher.lastAcceptedSeq()).toBe(40);
    await publisher.push(context, "retry", [laterEvent]);

    expect(kinds(attempts)).toEqual([
      ["message.started", "message.completed"],
      ["message.completed"],
      ["message.completed", "message.started"],
    ]);
    expect(attempts[2]?.[0]?.sourceEventId).toBe(attempts[0]?.[1]?.sourceEventId);
    expect(publisher.lastAcceptedSeq()).toBe(51);
    await context.logger.destroy();
  });

  test("reserves a full lossless lane beside queued best-effort deltas", async () => {
    const firstSendEntered = Promise.withResolvers<void>();
    const releaseFirstSend = Promise.withResolvers<void>();
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          firstSendEntered.resolve();
          await releaseFirstSend.promise;
        }

        return {
          accepted: events.map((event, index) => ({
            seq: attempts.length * 2_000 + index,
            type: event.kind,
          })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const first = publisher.push(
      context,
      "stream",
      Array.from({ length: 1_024 }, (_, index) => createDelta(String(index))),
    );
    await firstSendEntered.promise;
    const dropped = publisher.push(context, "stream", [createDelta("dropped")]);
    const terminalEvents = [
      createEvent("message.completed"),
      createEvent("message.started"),
      createEvent("message.completed"),
    ];
    const terminal = publisher.push(context, "terminal", terminalEvents);

    releaseFirstSend.resolve();
    await expect(Promise.all([first, dropped, terminal])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(attempts[0]).toHaveLength(1_024);
    expect(kinds(attempts).at(-1)).toEqual([
      "message.completed",
      "message.started",
      "message.completed",
    ]);
    await context.logger.destroy();
  });

  test("takes ownership of a queued lossless array", async () => {
    const firstSendEntered = Promise.withResolvers<void>();
    const releaseFirstSend = Promise.withResolvers<void>();
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          firstSendEntered.resolve();
          await releaseFirstSend.promise;
        }

        return {
          accepted: events.map((event, index) => ({ seq: index + 1, type: event.kind })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const first = publisher.push(context, "first", [createEvent("message.started")]);
    await firstSendEntered.promise;
    const mutable = [createEvent("message.completed")];
    const second = publisher.push(context, "second", mutable);

    mutable.push(...Array.from({ length: 1_100 }, () => createEvent("message.completed")));
    releaseFirstSend.resolve();
    await Promise.all([first, second]);

    expect(attempts.map((batch) => batch.length)).toEqual([1, 1]);
    await context.logger.destroy();
  });

  test("takes deep ownership of queued lossless payloads", async () => {
    const firstSendEntered = Promise.withResolvers<void>();
    const releaseFirstSend = Promise.withResolvers<void>();
    const observed: { messageIds: string[]; sourceEventIds: (string | undefined)[] }[] = [];
    let attempt = 0;
    const context = createContext({
      pushEvents: async (events) => {
        attempt += 1;
        observed.push({
          messageIds: events.map(
            (event) => (event.payload as { messageId: string }).messageId,
          ),
          sourceEventIds: events.map((event) => event.sourceEventId),
        });

        if (attempt === 1) {
          firstSendEntered.resolve();
          await releaseFirstSend.promise;
        } else if (attempt === 2) {
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
    const gate = createEvent("message.started");
    (gate.payload as { messageId: string }).messageId = "gate";
    const mutable = createEvent("message.completed");
    (mutable.payload as { messageId: string }).messageId = "original";
    const first = publisher.push(context, "first", [gate]);

    await firstSendEntered.promise;
    const second = publisher.push(context, "second", [mutable]);
    (mutable.payload as { messageId: string }).messageId = "changed-before-send";
    releaseFirstSend.resolve();
    await first;
    await expect(second).rejects.toThrow("socket unavailable");

    (mutable.payload as { messageId: string }).messageId = "changed-before-retry";
    await publisher.push(context, "retry", [createEvent("message.started")]);

    expect(observed.map(({ messageIds }) => messageIds)).toEqual([
      ["gate"],
      ["original"],
      ["original", "message-1"],
    ]);
    expect(observed[2]?.sourceEventIds[0]).toBe(observed[1]?.sourceEventIds[0]);
    await context.logger.destroy();
  });

  test("drops a rejected lossless draft without blocking a terminal event", async () => {
    const delivered: DriverEventInput[] = [];
    let nextSeq = 1;
    const context = createContext({
      pushEvents: async (events) => {
        const envelopes = events.flatMap((event) =>
          toDriverEventEnvelopes(driverBootPayload, event, DRIVER_TEST_IDS.runId),
        );
        delivered.push(...envelopes.map(({ event }) => event));
        return {
          accepted: envelopes.map((envelope) => ({
            eventId: envelope.eventId,
            seq: nextSeq++,
            type: envelope.event.kind,
          })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const poison = {
      kind: "invalid.kind",
      payload: {},
    } as unknown as DriverEventInput;
    const terminal = createEvent("message.completed");

    await expect(publisher.push(context, "terminal", [poison, terminal])).rejects.toThrow(
      "unsupported",
    );
    expect(kinds([delivered])).toEqual([["message.completed"]]);
    await context.logger.destroy();
  });

  test("rejects an oversized lossless batch before reading its payloads", async () => {
    let payloadReads = 0;
    const event = {
      kind: "message.completed",
      get payload() {
        payloadReads += 1;
        return { messageId: "message-1", stopReason: "end_turn" };
      },
    } as DriverEventInput;
    const context = createContext({
      pushEvents: async () => {
        throw new Error("must not send");
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");

    await expect(
      publisher.push(context, "oversized", Array.from({ length: 1_025 }, () => event)),
    ).rejects.toThrow("exceeds 1024 events");
    expect(payloadReads).toBe(0);
    await context.logger.destroy();
  });

  test("rejects a receipt for a later same-kind event", async () => {
    let attempt = 0;
    const context = createContext({
      pushEvents: async (events) => {
        attempt += 1;

        if (attempt === 1) {
          return {
            accepted: [
              {
                eventId: events[1]?.sourceEventId,
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
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const firstBatch = [createEvent("message.completed"), createEvent("message.completed")];

    await expect(publisher.push(context, "mismatched", firstBatch)).rejects.toThrow("event ID");
    await publisher.push(context, "retry", [createEvent("message.started")]);
    expect(attempt).toBe(2);
    await context.logger.destroy();
  });

  test("gives a reused draft object a new identity after a successful push", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);
        return {
          accepted: events.map((event, index) => ({ seq: index + 1, type: event.kind })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const event = createEvent("message.completed");

    await publisher.push(context, "first", [event]);
    await publisher.push(context, "second", [event]);

    expect(attempts[1]?.[0]?.sourceEventId).not.toBe(attempts[0]?.[0]?.sourceEventId);
    expect(isDriverId(attempts[0]?.[0]?.sourceEventId)).toBe(true);
    expect(isDriverId(attempts[1]?.[0]?.sourceEventId)).toBe(true);
    await context.logger.destroy();
  });

  test.each([
    [
      "too many",
      [
        { seq: 40, type: "message.started" },
        { seq: 41, type: "message.completed" },
        { seq: 42, type: "message.started" },
      ],
      "exceeds",
    ],
    ["wrong first type", [{ seq: 40, type: "message.completed" }], "does not match"],
    [
      "wrong later type",
      [
        { seq: 40, type: "message.started" },
        { seq: 41, type: "message.started" },
      ],
      "does not match",
    ],
    ["NaN seq", [{ seq: Number.NaN, type: "message.started" }], "safe integer"],
    [
      "infinite seq",
      [{ seq: Number.POSITIVE_INFINITY, type: "message.started" }],
      "safe integer",
    ],
    ["fractional seq", [{ seq: 40.5, type: "message.started" }], "safe integer"],
    [
      "unsafe seq",
      [{ seq: Number.MAX_SAFE_INTEGER + 1, type: "message.started" }],
      "safe integer",
    ],
    ["negative seq", [{ seq: -1, type: "message.started" }], "non-negative"],
  ] as const)(
    "retains the full batch after a %s receipt prefix",
    async (_name, malformedReceipts, expectedError) => {
      const attempts: DriverEventInput[][] = [];
      const context = createContext({
        pushEvents: async (events) => {
          attempts.push(events);

          if (attempts.length === 1) {
            return { accepted: malformedReceipts };
          }

          return {
            accepted: events.map((event, index) => ({
              seq: 50 + index,
              type: event.kind,
            })),
          };
        },
      });
      const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
      const firstBatch = [createEvent("message.started"), createEvent("message.completed")];
      const laterEvent = createEvent("message.started");

      await expect(publisher.push(context, "malformed", firstBatch)).rejects.toThrow(
        expectedError,
      );
      expect(publisher.lastAcceptedSeq()).toBe(0);
      await publisher.push(context, "retry", [laterEvent]);

      expect(kinds(attempts)).toEqual([
        ["message.started", "message.completed"],
        ["message.started", "message.completed", "message.started"],
      ]);
      expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
      expect(attempts[1]?.[1]?.sourceEventId).toBe(attempts[0]?.[1]?.sourceEventId);
      expect(publisher.lastAcceptedSeq()).toBe(52);
      await context.logger.destroy();
    },
  );
});
