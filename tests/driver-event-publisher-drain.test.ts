import { describe, expect, test } from "bun:test";

import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import type { DriverEventInput } from "../src/protocol/events";
import { DriverEventPublisher } from "../src/runtimes/driver-event-publisher";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";
import { createContext, createDelta, createEvent, kinds } from "./driver-event-publisher-fixture";

describe("DriverEventPublisher", () => {
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
            eventId: event.sourceEventId!,
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
            eventId: event.sourceEventId!,
            seq: 50 + index,
            type: event.kind,
          })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const firstBatch = [createEvent("message.started"), createEvent("message.completed")];
    const laterEvent = createEvent("message.started");

    await expect(publisher.push(context, "first", firstBatch)).rejects.toThrow("made no progress");
    await publisher.push(context, "retry", [laterEvent]);

    expect(kinds(attempts)).toEqual([
      ["message.started", "message.completed"],
      ["message.started", "message.completed", "message.started"],
    ]);
    expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
    expect(attempts[1]?.[1]?.sourceEventId).toBe(attempts[0]?.[1]?.sourceEventId);
    expect(publisher.lastAcceptedSeq()).toBe(52);
  });

  test("retains only the unaccepted suffix after progress stops", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          return {
            accepted: [{ eventId: events[0]!.sourceEventId!, seq: 40, type: events[0]!.kind }],
          };
        }

        if (attempts.length === 2) {
          return { accepted: [] };
        }

        return {
          accepted: events.map((event, index) => ({
            eventId: event.sourceEventId!,
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
            eventId: event.sourceEventId!,
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
          accepted: events.map((event, index) => ({
            eventId: event.sourceEventId!,
            seq: index + 1,
            type: event.kind,
          })),
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
          messageIds: events.map((event) => (event.payload as { messageId: string }).messageId),
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
            eventId: event.sourceEventId!,
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
      publisher.push(
        context,
        "oversized",
        Array.from({ length: 1_025 }, () => event),
      ),
    ).rejects.toThrow("exceeds 1024 events");
    expect(payloadReads).toBe(0);
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
                eventId: events[1]!.sourceEventId!,
                seq: 1,
                type: events[0]!.kind,
              },
            ],
          };
        }

        return {
          accepted: events.map((event, index) => ({
            eventId: event.sourceEventId!,
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
    ["infinite seq", [{ seq: Number.POSITIVE_INFINITY, type: "message.started" }], "safe integer"],
    ["fractional seq", [{ seq: 40.5, type: "message.started" }], "safe integer"],
    ["unsafe seq", [{ seq: Number.MAX_SAFE_INTEGER + 1, type: "message.started" }], "safe integer"],
    ["negative seq", [{ seq: -1, type: "message.started" }], "non-negative"],
  ] as const)(
    "retains the full batch after a %s receipt prefix",
    async (_name, malformedReceipts, expectedError) => {
      const attempts: DriverEventInput[][] = [];
      const context = createContext({
        pushEvents: async (events) => {
          attempts.push(events);

          if (attempts.length === 1) {
            return {
              accepted: malformedReceipts.map(
                (receipt: { readonly seq: number; readonly type: string }, index: number) => ({
                  ...receipt,
                  eventId: events[index]?.sourceEventId ?? "extra-event-id",
                }),
              ),
            };
          }

          return {
            accepted: events.map((event, index) => ({
              eventId: event.sourceEventId!,
              seq: 50 + index,
              type: event.kind,
            })),
          };
        },
      });
      const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
      const firstBatch = [createEvent("message.started"), createEvent("message.completed")];
      const laterEvent = createEvent("message.started");

      await expect(publisher.push(context, "malformed", firstBatch)).rejects.toThrow(expectedError);
      expect(publisher.lastAcceptedSeq()).toBe(0);
      await publisher.push(context, "retry", [laterEvent]);

      expect(kinds(attempts)).toEqual([
        ["message.started", "message.completed"],
        ["message.started", "message.completed", "message.started"],
      ]);
      expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
      expect(attempts[1]?.[1]?.sourceEventId).toBe(attempts[0]?.[1]?.sourceEventId);
      expect(publisher.lastAcceptedSeq()).toBe(52);
    },
  );
});
