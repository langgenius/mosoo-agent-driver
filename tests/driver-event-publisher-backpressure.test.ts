import { describe, expect, test } from "bun:test";

import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
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
    const terminal = publisher.push(context, "terminal", [createRunTerminal("run.completed")]);

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
    await expect(publisher.push(context, "run-2", [terminal])).rejects.toThrow("run terminal slot");
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
      const terminal = eventRunId === undefined ? raw : { ...raw, runId: eventRunId };

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
  ] as const)("%s explicit source ID", async (_name, retrySourceEventId, joinsPending) => {
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
  });

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
      const retained = Array.from({ length: 1_024 }, () => createEvent("message.started"));

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
        await Promise.race([recovered.promise.then(() => true), Bun.sleep(50).then(() => false)]),
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
});
