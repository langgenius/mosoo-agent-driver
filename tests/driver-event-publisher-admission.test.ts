import { describe, expect, test } from "bun:test";

import {
  DriverEventRejectedError,
  pushLosslessEvents,
  withSourceEventIds,
} from "../src/core/driver-runtime-io";
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

function acceptEvents(
  events: readonly DriverEventInput[],
  sequence: (index: number) => number = (index) => index + 1,
): DriverEventBatchOutput {
  return {
    accepted: events.map((event, index) => ({
      eventId: event.sourceEventId,
      seq: sequence(index),
      type: event.kind,
    })),
  };
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
  test("keeps an explicit source ID across direct lossless retries", async () => {
    const attempts: DriverEventInput[][] = [];
    const events = withSourceEventIds([createEvent("message.completed")]);
    const port = {
      pushEvents: async ({ events: sent }: { events: DriverEventInput[] }) => {
        attempts.push(sent);

        if (attempts.length === 1) {
          throw new Error("response lost");
        }

        return acceptEvents(sent);
      },
    };

    await expect(pushLosslessEvents(port, events)).rejects.toThrow("response lost");
    await pushLosslessEvents(port, events);

    expect(isDriverId(attempts[0]?.[0]?.sourceEventId)).toBe(true);
    expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
  });

  test("retries one transport failure after a valid receipt prefix", async () => {
    const attempts: DriverEventInput[][] = [];
    let sequence = 0;
    const port = {
      pushEvents: async ({ events }: { events: DriverEventInput[] }) => {
        attempts.push(events);

        if (attempts.length === 1) {
          return {
            accepted: [
              {
                eventId: events[0]!.sourceEventId,
                seq: ++sequence,
                type: events[0]!.kind,
              },
            ],
          };
        }

        if (attempts.length === 2) {
          throw new Error("temporary transport failure");
        }

        return acceptEvents(events, () => ++sequence);
      },
    };

    await expect(
      pushLosslessEvents(port, [createEvent("message.started"), createEvent("message.completed")]),
    ).resolves.toHaveLength(2);

    expect(kinds(attempts)).toEqual([
      ["message.started", "message.completed"],
      ["message.completed"],
      ["message.completed"],
    ]);
    expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[1]?.sourceEventId);
    expect(attempts[2]?.[0]?.sourceEventId).toBe(attempts[0]?.[1]?.sourceEventId);
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

          return acceptEvents(events, (index) => index + 2);
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

  test("does not let a timed-out best-effort lane poison later lossless delivery", async () => {
    const nativeTimeout = AbortSignal.timeout;
    const signals: (AbortSignal | undefined)[] = [];
    const controllers: AbortController[] = [];
    AbortSignal.timeout = () => {
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    };
    const context = createContext({
      pushEvents: async (events, signal) => {
        signals.push(signal);
        signal?.throwIfAborted();

        if (signals.length === 1) {
          controllers[0]!.abort(new DOMException("The operation timed out.", "TimeoutError"));
          signal?.throwIfAborted();
        }

        return acceptEvents(events);
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
    expect(new Set(signals).size).toBe(3);
    expect(controllers).toHaveLength(3);
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

  test("does not block best-effort producers on transport acknowledgements", async () => {
    const firstSendEntered = Promise.withResolvers<void>();
    const releaseFirstSend = Promise.withResolvers<void>();
    const context = createContext({
      pushEvents: async (events) => {
        firstSendEntered.resolve();
        await releaseFirstSend.promise;

        return acceptEvents(events);
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const first = publisher.push(context, "first", [createDelta("a")]);

    await firstSendEntered.promise;
    await first;
    releaseFirstSend.resolve();
    await publisher.push(context, "flush", [createEvent("message.completed")]);

    await context.logger.destroy();
  });

  test("delivers terminal closures one at a time before the run terminal", async () => {
    const attempts: DriverEventInput[][] = [];
    let seq = 0;
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);
        return acceptEvents(events, () => (seq += 1));
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const closures = Array.from({ length: 66 }, (_, index) => ({
      kind: "message.completed",
      payload: { messageId: `message-${index}`, stopReason: "end_turn" },
    })) satisfies DriverEventInput[];

    await publisher.pushTerminal(context, "terminal", closures, createRunTerminal("run.completed"));

    expect(attempts).toHaveLength(67);
    expect(attempts.every((events) => events.length === 1)).toBe(true);
    expect(attempts.slice(0, -1).every(([event]) => event?.kind === "message.completed")).toBe(
      true,
    );
    expect(attempts.at(-1)?.[0]?.kind).toBe("run.completed");
    await context.logger.destroy();
  });

  test("bounds the whole terminal settlement by one delivery deadline", async () => {
    const acceptedKinds: string[] = [];
    const attempts: DriverEventInput[][] = [];
    const nativeTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => nativeTimeout(100);
    const context = createContext({
      pushEvents: async (events, signal) => {
        attempts.push(events);
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, 40);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              reject(signal.reason);
            },
            { once: true },
          );
        });
        acceptedKinds.push(...events.map(({ kind }) => kind));
        return acceptEvents(events, (index) => attempts.length + index);
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    let terminal: Promise<void>;

    try {
      terminal = publisher.pushTerminal(
        context,
        "terminal",
        [
          { ...createEvent("message.completed"), payload: { messageId: "one" } },
          { ...createEvent("message.completed"), payload: { messageId: "two" } },
        ],
        createRunTerminal("run.completed"),
      );
    } finally {
      AbortSignal.timeout = nativeTimeout;
    }

    try {
      await expect(terminal).rejects.toThrow();
      expect(kinds(attempts)).toEqual([
        ["message.completed"],
        ["message.completed"],
        ["run.completed"],
      ]);
      expect(acceptedKinds).toEqual(["message.completed", "message.completed"]);

      AbortSignal.timeout = () => nativeTimeout(100);
      try {
        terminal = publisher.pushTerminal(
          context,
          "terminal.retry",
          [
            { ...createEvent("message.completed"), payload: { messageId: "one" } },
            { ...createEvent("message.completed"), payload: { messageId: "two" } },
          ],
          createRunTerminal("run.completed"),
        );
      } finally {
        AbortSignal.timeout = nativeTimeout;
      }
      await expect(terminal).resolves.toBeUndefined();
      expect(acceptedKinds).toEqual(["message.completed", "message.completed", "run.completed"]);
    } finally {
      await context.logger.destroy();
    }
  });

  test("bounds waiting for an earlier drain by the terminal settlement deadline", async () => {
    const attempts: DriverEventInput[][] = [];
    const drainEntered = Promise.withResolvers<void>();
    const releaseDrain = Promise.withResolvers<void>();
    const nativeTimeout = AbortSignal.timeout;
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);
        if (attempts.length === 1) {
          drainEntered.resolve();
          await releaseDrain.promise;
        }
        return acceptEvents(events, (index) => attempts.length + index);
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const ordinary = publisher.push(context, "ordinary", [createEvent("message.completed")]);
    await drainEntered.promise;
    AbortSignal.timeout = () => nativeTimeout(50);
    let terminal: Promise<void>;

    try {
      terminal = publisher.pushTerminal(
        context,
        "terminal",
        [],
        createRunTerminal("run.completed"),
      );
    } finally {
      AbortSignal.timeout = nativeTimeout;
    }

    try {
      await expect(terminal).rejects.toThrow();
      expect(kinds(attempts)).toEqual([["message.completed"]]);
    } finally {
      releaseDrain.resolve();
      await ordinary;
      await context.logger.destroy();
    }
  });

  test("retries the exact pending closure before delivering the run terminal", async () => {
    const attempts: DriverEventInput[][] = [];
    let seq = 0;
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          throw new Error("response lost");
        }

        return acceptEvents(events, () => (seq += 1));
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");

    await publisher.pushTerminal(
      context,
      "terminal",
      [createEvent("message.completed")],
      createRunTerminal("run.completed"),
    );

    expect(kinds(attempts)).toEqual([
      ["message.completed"],
      ["message.completed"],
      ["run.completed"],
    ]);
    expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
    await context.logger.destroy();
  });

  test("reuses a retained closure identity when the terminal call is retried", async () => {
    const attempts: DriverEventInput[][] = [];
    const accepted: DriverEventInput[] = [];
    let seq = 0;
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length <= 2) {
          throw new Error(`socket unavailable ${attempts.length}`);
        }

        accepted.push(...events);
        return acceptEvents(events, () => (seq += 1));
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const closures = [createEvent("message.completed")];
    const terminal = createRunTerminal("run.completed");

    await expect(publisher.pushTerminal(context, "terminal", closures, terminal)).rejects.toThrow(
      "socket unavailable 2",
    );
    await expect(
      publisher.pushTerminal(context, "terminal.retry", closures, terminal),
    ).resolves.toBeUndefined();

    expect(kinds(attempts)).toEqual([
      ["message.completed"],
      ["message.completed"],
      ["message.completed"],
      ["run.completed"],
    ]);
    expect(new Set(attempts.slice(0, 3).map(([event]) => event?.sourceEventId)).size).toBe(1);
    expect(kinds([accepted])).toEqual([["message.completed", "run.completed"]]);
    await context.logger.destroy();
  });

  test("joins one in-flight terminal operation and rejects a different occurrence", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const attempts: DriverEventInput[][] = [];
    let seq = 0;
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          entered.resolve();
          await release.promise;
        }

        return acceptEvents(events, () => (seq += 1));
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const closure = createEvent("message.completed");
    const terminal = createRunTerminal("run.completed");
    const first = publisher.pushTerminal(context, "terminal", [closure], terminal);
    const joined = publisher.pushTerminal(context, "terminal.join", [closure], terminal);

    await entered.promise;
    expect(() =>
      publisher.pushTerminal(
        context,
        "terminal.other",
        [{ ...closure, sourceEventId: "explicit-other-closure" }],
        { ...terminal, sourceEventId: "explicit-other-terminal" },
      ),
    ).toThrow("settlement slot is full");
    release.resolve();
    await Promise.all([first, joined]);

    expect(kinds(attempts)).toEqual([["message.completed"], ["run.completed"]]);
    await context.logger.destroy();
  });

  test("continues a partially delivered terminal operation without duplicating closures", async () => {
    const attempts: DriverEventInput[][] = [];
    const accepted: DriverEventInput[] = [];
    let seq = 0;
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 2 || attempts.length === 3) {
          throw new Error(`closure unavailable ${attempts.length}`);
        }

        accepted.push(...events);
        return acceptEvents(events, () => (seq += 1));
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const closures = [
      { ...createEvent("message.completed"), payload: { messageId: "one" } },
      { ...createEvent("message.completed"), payload: { messageId: "two" } },
    ] satisfies DriverEventInput[];
    const terminal = createRunTerminal("run.completed");

    await expect(publisher.pushTerminal(context, "terminal", closures, terminal)).rejects.toThrow(
      "closure unavailable 3",
    );
    await publisher.pushTerminal(context, "terminal.retry", closures, terminal);

    expect(accepted.map((event) => event.kind)).toEqual([
      "message.completed",
      "message.completed",
      "run.completed",
    ]);
    expect(
      accepted.filter(
        (event) =>
          event.kind === "message.completed" &&
          (event.payload as { messageId?: string }).messageId === "one",
      ),
    ).toHaveLength(1);
    expect(new Set(attempts.slice(1, 4).map(([event]) => event?.sourceEventId)).size).toBe(1);
    await context.logger.destroy();
  });

  test("keeps a failed terminal settlement reserved until the same run retries it", async () => {
    const attempts: DriverEventInput[][] = [];
    let activeRunId: RunId | null = DRIVER_TEST_IDS.runId;
    let available = false;
    let seq = 0;
    const context = createContext({
      currentRunId: () => activeRunId,
      pushEvents: async (events) => {
        attempts.push(events);

        if (!available) {
          throw new Error("terminal transport unavailable");
        }

        return acceptEvents(events, () => (seq += 1));
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const closure = createEvent("message.completed");
    const terminal = createRunTerminal("run.completed");

    await expect(publisher.pushTerminal(context, "terminal", [closure], terminal)).rejects.toThrow(
      "terminal transport unavailable",
    );
    activeRunId = DRIVER_TEST_IDS.secondRunId;
    await expect(
      publisher.pushSession(context, "session", [
        {
          kind: "agent.task.updated",
          payload: { active: false, status: "completed", taskId: "agent-1" },
        },
      ]),
    ).rejects.toThrow("terminal settlement slot is full");
    expect(() =>
      publisher.pushTerminal(context, "next-run", [], {
        ...terminal,
        runId: DRIVER_TEST_IDS.secondRunId,
      }),
    ).toThrow("terminal settlement slot is full");

    activeRunId = DRIVER_TEST_IDS.runId;
    available = true;
    await publisher.pushTerminal(context, "terminal.retry", [closure], terminal);

    expect(kinds(attempts)).toEqual([
      ["message.completed"],
      ["message.completed"],
      ["message.completed"],
      ["run.completed"],
    ]);
    expect(attempts.flat().some((event) => event.kind === "agent.task.updated")).toBe(false);
    await context.logger.destroy();
  });

  test("does not let a session push cross a terminal installed at its await boundary", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);
        return acceptEvents(events);
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const session = publisher.pushSession(context, "session", [
      {
        kind: "agent.task.updated",
        payload: { active: false, status: "completed", taskId: "agent-1" },
      },
    ]);
    const terminal = publisher.pushTerminal(
      context,
      "terminal",
      [],
      createRunTerminal("run.completed"),
    );

    await expect(session).rejects.toThrow("terminal settlement slot is full");
    await terminal;
    expect(kinds(attempts)).toEqual([["run.completed"]]);
    await context.logger.destroy();
  });

  test("adopts the identity of a matching generic pending closure", async () => {
    const attempts: DriverEventInput[][] = [];
    let seq = 0;
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          throw new Error("generic closure unavailable");
        }

        return acceptEvents(events, () => (seq += 1));
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const closure = createEvent("message.completed");

    await expect(publisher.push(context, "closure", [closure])).rejects.toThrow(
      "generic closure unavailable",
    );
    await publisher.pushTerminal(
      context,
      "terminal",
      [closure],
      createRunTerminal("run.completed"),
    );

    expect(kinds(attempts)).toEqual([
      ["message.completed"],
      ["message.completed"],
      ["run.completed"],
    ]);
    expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
    await context.logger.destroy();
  });

  test("does not duplicate a matching closure already in flight", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const attempts: DriverEventInput[][] = [];
    let seq = 0;
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          entered.resolve();
          await release.promise;
        }

        return acceptEvents(events, () => (seq += 1));
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const closure = createEvent("message.completed");
    const ordinary = publisher.push(context, "closure", [closure]);

    await entered.promise;
    const terminal = publisher.pushTerminal(
      context,
      "terminal",
      [closure],
      createRunTerminal("run.completed"),
    );
    void ordinary.catch(() => {});
    void terminal.catch(() => {});
    release.resolve();
    await Promise.all([ordinary, terminal]);

    expect(kinds(attempts)).toEqual([["message.completed"], ["run.completed"]]);
    await context.logger.destroy();
  });

  test("does not resend an accepted in-flight closure while its suffix is blocked", async () => {
    const suffixEntered = Promise.withResolvers<void>();
    const releaseSuffix = Promise.withResolvers<void>();
    const attempts: DriverEventInput[][] = [];
    const accepted: DriverEventInput[] = [];
    let seq = 0;
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          accepted.push(events[0]!);
          return {
            accepted: [
              {
                eventId: events[0]!.sourceEventId,
                seq: (seq += 1),
                type: events[0]!.kind,
              },
            ],
          };
        }

        if (attempts.length === 2) {
          suffixEntered.resolve();
          await releaseSuffix.promise;
          throw new Error("suffix transport unavailable");
        }

        if (attempts.length === 3) {
          throw new Error("suffix transport still unavailable");
        }

        accepted.push(...events);
        return acceptEvents(events, () => (seq += 1));
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const closure = createEvent("message.completed");
    const ordinary = publisher.push(context, "ordinary", [closure, createEvent("message.started")]);

    await suffixEntered.promise;
    const terminal = publisher.pushTerminal(
      context,
      "terminal",
      [closure],
      createRunTerminal("run.completed"),
    );
    void ordinary.catch(() => {});
    void terminal.catch(() => {});
    releaseSuffix.resolve();

    await expect(ordinary).rejects.toThrow("suffix transport still unavailable");
    await expect(terminal).resolves.toBeUndefined();
    expect(kinds(attempts)).toEqual([
      ["message.completed", "message.started"],
      ["message.started"],
      ["message.started"],
      ["message.started", "run.completed"],
    ]);
    expect(
      accepted.filter((event) => event.sourceEventId === attempts[0]![0]!.sourceEventId),
    ).toHaveLength(1);
    await context.logger.destroy();
  });

  test("does not revive a matching in-flight closure rejected by the sink", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);
        entered.resolve();
        await release.promise;
        throw new DriverEventRejectedError(
          events[0]!.sourceEventId!,
          new Error("closure rejected"),
        );
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const closure = createEvent("message.completed");
    const ordinary = publisher.push(context, "closure", [closure]);

    await entered.promise;
    const terminal = publisher.pushTerminal(
      context,
      "terminal",
      [closure],
      createRunTerminal("run.completed"),
    );
    void ordinary.catch(() => {});
    void terminal.catch(() => {});
    release.resolve();

    await expect(ordinary).rejects.toThrow("closure rejected");
    await expect(terminal).rejects.toThrow("closure rejected");
    expect(kinds(attempts)).toEqual([["message.completed"]]);
    await context.logger.destroy();
  });

  test("does not revive a rejected closure while its in-flight suffix is blocked", async () => {
    const suffixEntered = Promise.withResolvers<void>();
    const releaseSuffix = Promise.withResolvers<void>();
    const attempts: DriverEventInput[][] = [];
    let seq = 0;
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          throw new DriverEventRejectedError(
            events[0]!.sourceEventId!,
            new Error("closure rejected"),
          );
        }

        suffixEntered.resolve();
        await releaseSuffix.promise;
        return acceptEvents(events, () => (seq += 1));
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const closure = createEvent("message.completed");
    const ordinary = publisher.push(context, "ordinary", [closure, createEvent("message.started")]);

    await suffixEntered.promise;
    const terminal = publisher.pushTerminal(
      context,
      "terminal",
      [closure],
      createRunTerminal("run.completed"),
    );
    void ordinary.catch(() => {});
    void terminal.catch(() => {});
    releaseSuffix.resolve();

    await expect(ordinary).rejects.toThrow("closure rejected");
    await expect(terminal).rejects.toThrow("closure rejected");
    expect(kinds(attempts)).toEqual([
      ["message.completed", "message.started"],
      ["message.started"],
    ]);
    await context.logger.destroy();
  });

  test("does not treat a rejected pending terminal retry as accepted", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          throw new Error("response lost");
        }

        throw new DriverEventRejectedError(
          events[0]!.sourceEventId!,
          new Error("terminal rejected"),
        );
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");

    await expect(
      publisher.pushTerminal(context, "terminal", [], createRunTerminal("run.completed")),
    ).rejects.toThrow("terminal rejected");
    expect(kinds(attempts)).toEqual([["run.completed"], ["run.completed"]]);
    expect(attempts[1]?.[0]?.sourceEventId).toBe(attempts[0]?.[0]?.sourceEventId);
    await context.logger.destroy();
  });

  test.each([
    ["target", true],
    ["unrelated", false],
  ] as const)(
    "attributes a coalesced pending rejection to the %s event",
    async (_name, rejectTarget) => {
      const attempts: DriverEventInput[][] = [];
      const context = createContext({
        pushEvents: async (events) => {
          attempts.push(events);

          if (attempts.length === 1) {
            throw new Error("coalesced transport failure");
          }

          if (attempts.length === 2) {
            const rejected = rejectTarget
              ? events.find((event) => event.kind === "message.completed")
              : events.find((event) => event.kind === "message.started");
            throw new DriverEventRejectedError(
              rejected!.sourceEventId!,
              new Error(rejectTarget ? "target rejected" : "unrelated rejected"),
            );
          }

          if (rejectTarget && attempts.length === 3) {
            throw new Error("unrelated remains pending");
          }

          return acceptEvents(events);
        },
      });
      const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
      const unrelated = publisher.push(context, "unrelated", [createEvent("message.started")]);
      const terminal = publisher.pushTerminal(
        context,
        "terminal",
        [createEvent("message.completed")],
        createRunTerminal("run.completed"),
      );
      void unrelated.catch(() => {});
      void terminal.catch(() => {});

      await expect(unrelated).rejects.toThrow("coalesced transport failure");

      if (rejectTarget) {
        await expect(terminal).rejects.toThrow("target rejected");
        expect(attempts.flat().some((event) => event.kind === "run.completed")).toBe(false);
      } else {
        await expect(terminal).resolves.toBeUndefined();
        expect(attempts.at(-1)?.[0]?.kind).toBe("run.completed");
      }

      await context.logger.destroy();
    },
  );

  test("does not mistake an old full pending queue for an admitted closure", async () => {
    const retryEntered = Promise.withResolvers<void>();
    const releaseRetry = Promise.withResolvers<void>();
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          throw new Error("socket unavailable");
        }

        if (attempts.length === 2) {
          retryEntered.resolve();
          await releaseRetry.promise;
        }

        return acceptEvents(events);
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const retained = Array.from({ length: 1_024 }, (_, index) => ({
      kind: "message.started",
      payload: { messageId: `pending-${index}`, role: "agent" },
    })) satisfies DriverEventInput[];

    try {
      await expect(publisher.push(context, "fill", retained)).rejects.toThrow("socket unavailable");
      await expect(
        publisher.pushTerminal(
          context,
          "terminal",
          [createEvent("message.completed")],
          createRunTerminal("run.completed"),
        ),
      ).rejects.toThrow("Driver event queue exceeds 1024 events");
      await retryEntered.promise;
    } finally {
      releaseRetry.resolve();
      await context.logger.destroy();
    }

    expect(attempts.flat().some((event) => event.kind === "run.completed")).toBe(false);
  });

  test("does not retry a rejected closure through unrelated pending events", async () => {
    const firstSendEntered = Promise.withResolvers<void>();
    const releaseFirstSend = Promise.withResolvers<void>();
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          firstSendEntered.resolve();
          await releaseFirstSend.promise;
          throw new Error("initial transport failure");
        }

        if (attempts.length === 3) {
          throw new Error("old pending still unavailable");
        }

        const envelopes = events.flatMap((event) =>
          toDriverEventEnvelopes(driverBootPayload, event, DRIVER_TEST_IDS.runId),
        );
        return {
          accepted: envelopes.map((envelope, index) => ({
            eventId: envelope.eventId,
            seq: index + 1,
            type: envelope.event.kind,
          })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const pending = publisher.push(context, "pending", [createEvent("message.started")]);
    void pending.catch(() => {});

    await firstSendEntered.promise;
    const terminal = publisher.pushTerminal(
      context,
      "terminal",
      [{ kind: "invalid.kind", payload: {} } as unknown as DriverEventInput],
      createRunTerminal("run.completed"),
    );
    void terminal.catch(() => {});
    releaseFirstSend.resolve();

    await expect(pending).rejects.toThrow("initial transport failure");
    await expect(terminal).rejects.toThrow("unsupported");
    expect(attempts.flat().some((event) => event.kind === "run.completed")).toBe(false);
    await context.logger.destroy();
  });

  test("rejects aggregate terminal bytes before delivering any event", async () => {
    let sends = 0;
    const context = createContext({
      pushEvents: async () => {
        sends += 1;
        return { accepted: [] };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const closures = ["one", "two"].map((messageId): DriverEventInput => ({
      kind: "message.completed",
      payload: {
        messageId,
        metadata: { detail: "x".repeat(600 * 1_024) },
        stopReason: "end_turn",
      },
    }));

    expect(() =>
      publisher.pushTerminal(context, "terminal", closures, createRunTerminal("run.completed")),
    ).toThrow("run terminal batch exceeds 1048576 UTF-8 bytes");
    expect(sends).toBe(0);
    await context.logger.destroy();
  });

  test("rejects aggregate terminal count before reading payloads", async () => {
    let payloadReads = 0;
    let sends = 0;
    const closure = {
      kind: "message.completed",
      get payload() {
        payloadReads += 1;
        return { messageId: "message-1", stopReason: "end_turn" };
      },
    } as DriverEventInput;
    const context = createContext({
      pushEvents: async () => {
        sends += 1;
        return { accepted: [] };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");

    expect(() =>
      publisher.pushTerminal(
        context,
        "terminal",
        Array.from({ length: 1_024 }, () => closure),
        createRunTerminal("run.completed"),
      ),
    ).toThrow("exceeds 1024 events");
    expect(payloadReads).toBe(0);
    expect(sends).toBe(0);
    await context.logger.destroy();
  });

  test("rejects an oversized run terminal before delivering closures", async () => {
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
      payload: { structuredOutput: "x".repeat(1_024 * 1_024) },
    } satisfies DriverEventInput;

    expect(() =>
      publisher.pushTerminal(context, "terminal", [createEvent("message.completed")], terminal),
    ).toThrow("run terminal batch exceeds 1048576 UTF-8 bytes");
    expect(sends).toBe(0);
    await context.logger.destroy();
  });

  test("rejects a non-run terminal before delivering closures", async () => {
    let sends = 0;
    const context = createContext({
      pushEvents: async () => {
        sends += 1;
        return { accepted: [] };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");

    expect(() =>
      publisher.pushTerminal(
        context,
        "terminal",
        [createEvent("message.completed")],
        createEvent("message.completed"),
      ),
    ).toThrow("requires a run terminal event");
    expect(sends).toBe(0);
    await context.logger.destroy();
  });

  test.each([
    [
      "closures",
      [
        { ...createEvent("message.started"), sourceEventId: "duplicate" },
        { ...createEvent("message.completed"), sourceEventId: "duplicate" },
      ],
      createRunTerminal("run.completed"),
    ],
    [
      "closure and terminal",
      [{ ...createEvent("message.completed"), sourceEventId: "duplicate" }],
      { ...createRunTerminal("run.completed"), sourceEventId: "duplicate" },
    ],
  ] as const)("rejects duplicate source IDs across %s", async (_name, closures, terminal) => {
    let sends = 0;
    const context = createContext({
      pushEvents: async () => {
        sends += 1;
        return { accepted: [] };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");

    expect(() => publisher.pushTerminal(context, "terminal", closures, terminal)).toThrow(
      "requires unique source event IDs",
    );
    expect(sends).toBe(0);
    await context.logger.destroy();
  });

  test("rejects duplicate source IDs in an ordinary push before delivery", async () => {
    let sends = 0;
    const context = createContext({
      pushEvents: async () => {
        sends += 1;
        return { accepted: [] };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");

    await expect(
      publisher.push(context, "duplicate", [
        { ...createEvent("message.started"), sourceEventId: "duplicate" },
        { ...createEvent("message.completed"), sourceEventId: "duplicate" },
      ]),
    ).rejects.toThrow("requires unique source event IDs");
    expect(sends).toBe(0);
    await context.logger.destroy();
  });

  test("does not confuse a pending event with a different terminal closure sharing its ID", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);

        if (attempts.length === 1) {
          throw new Error("transport unavailable");
        }

        return acceptEvents(events);
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const pending = publisher.push(context, "pending", [
      { ...createEvent("message.started"), sourceEventId: "collision" },
    ]);

    await expect(pending).rejects.toThrow("transport unavailable");
    expect(() =>
      publisher.pushTerminal(
        context,
        "terminal",
        [{ ...createEvent("message.completed"), sourceEventId: "collision" }],
        createRunTerminal("run.completed"),
      ),
    ).toThrow("source event ID conflicts");

    expect(attempts.flat().some((event) => event.kind === "message.completed")).toBe(false);
    expect(attempts.flat().some((event) => event.kind === "run.completed")).toBe(false);
    await context.logger.destroy();
  });

  test.each([
    ["best-effort closure", [createDelta("draft")], createRunTerminal("run.completed")],
    ["run terminal closure", [createRunTerminal("run.failed")], createRunTerminal("run.completed")],
    [
      "best-effort terminal",
      [createEvent("message.completed")],
      { ...createRunTerminal("run.completed"), delivery: "best_effort" },
    ],
  ] as const)("rejects a %s before delivering any event", async (_name, closures, terminal) => {
    let sends = 0;
    const context = createContext({
      pushEvents: async () => {
        sends += 1;
        return { accepted: [] };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");

    expect(() => publisher.pushTerminal(context, "terminal", closures, terminal)).toThrow();
    expect(sends).toBe(0);
    await context.logger.destroy();
  });

  test("rejects or drops events queued after a run terminal", async () => {
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);
        return acceptEvents(events);
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const terminal = publisher.pushTerminal(
      context,
      "terminal",
      [],
      createRunTerminal("run.completed"),
    );
    const lossless = publisher.push(context, "late-lossless", [createEvent("message.completed")]);
    const bestEffort = publisher.push(context, "late-best-effort", [createDelta("late")]);

    await expect(lossless).rejects.toThrow("run terminal settlement slot is full");
    await expect(Promise.all([terminal, bestEffort])).resolves.toEqual([undefined, undefined]);
    expect(kinds(attempts)).toEqual([["run.completed"]]);
    await context.logger.destroy();
  });

  test("requires the unique terminal entry point and an attributable run", async () => {
    let sends = 0;
    const context = createContext({
      currentRunId: () => null,
      pushEvents: async () => {
        sends += 1;
        return { accepted: [] };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const { runId: _, ...unscoped } = createRunTerminal("run.completed");

    await expect(
      publisher.push(context, "terminal", [createRunTerminal("run.completed")]),
    ).rejects.toThrow("must use pushTerminal");
    expect(() => publisher.pushTerminal(context, "terminal", [], unscoped)).toThrow(
      "requires an active run",
    );
    expect(sends).toBe(0);
    await context.logger.destroy();
  });

  test("settles sequential runs after the active run changes", async () => {
    const attempts: DriverEventInput[][] = [];
    let activeRunId: RunId | null = DRIVER_TEST_IDS.runId;
    let seq = 0;
    const context = createContext({
      currentRunId: () => activeRunId,
      pushEvents: async (events) => {
        attempts.push(events);
        return acceptEvents(events, () => (seq += 1));
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");

    await publisher.pushTerminal(context, "terminal.one", [], createRunTerminal("run.completed"));
    activeRunId = null;
    await publisher.push(context, "session.event", [createEvent("message.started")]);
    activeRunId = DRIVER_TEST_IDS.secondRunId;
    await publisher.pushTerminal(context, "terminal.two", [], {
      ...createRunTerminal("run.completed"),
      runId: DRIVER_TEST_IDS.secondRunId,
    });

    expect(attempts.map(([event]) => [event?.kind, event?.runId ?? null])).toEqual([
      ["run.completed", DRIVER_TEST_IDS.runId],
      ["message.started", null],
      ["run.completed", DRIVER_TEST_IDS.secondRunId],
    ]);
    await context.logger.destroy();
  });

  test("keeps session events unscoped without reopening a settled run", async () => {
    const attempts: DriverEventInput[][] = [];
    let activeRunId: RunId | null = DRIVER_TEST_IDS.runId;
    let seq = 0;
    const context = createContext({
      currentRunId: () => activeRunId,
      pushEvents: async (events) => {
        const canonical = events.flatMap((event) =>
          toDriverEventEnvelopes(driverBootPayload, event, activeRunId),
        );
        attempts.push(canonical.map(({ event }) => event));
        return {
          accepted: canonical.map((envelope) => ({
            eventId: envelope.eventId,
            seq: (seq += 1),
            type: envelope.event.kind,
          })),
        };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const task = (taskId: string): DriverEventInput => ({
      kind: "agent.task.updated",
      payload: { active: false, status: "completed", taskId },
    });

    await publisher.pushTerminal(context, "terminal", [], createRunTerminal("run.completed"));
    await publisher.pushSession(context, "session.same-run", [task("agent-1")]);
    await expect(
      publisher.push(context, "late-run", [createEvent("message.completed")]),
    ).rejects.toThrow("run terminal settlement slot is full");
    activeRunId = DRIVER_TEST_IDS.secondRunId;
    await publisher.pushSession(context, "session.next-run", [task("agent-2")]);

    expect(attempts.flat().map((event) => [event.kind, event.runId ?? null])).toEqual([
      ["run.completed", DRIVER_TEST_IDS.runId],
      ["agent.task.updated", null],
      ["agent.task.updated", null],
    ]);
    await context.logger.destroy();
  });

  test("does not let another run displace an in-flight settlement", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const attempts: DriverEventInput[][] = [];
    const context = createContext({
      pushEvents: async (events) => {
        attempts.push(events);
        entered.resolve();
        await release.promise;
        return acceptEvents(events);
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");
    const first = publisher.pushTerminal(
      context,
      "terminal.one",
      [],
      createRunTerminal("run.completed"),
    );

    await entered.promise;
    expect(() =>
      publisher.pushTerminal(context, "terminal.two", [], {
        ...createRunTerminal("run.completed"),
        runId: DRIVER_TEST_IDS.secondRunId,
      }),
    ).toThrow("must target the active run");
    release.resolve();
    await first;

    expect(attempts).toHaveLength(1);
    await context.logger.destroy();
  });

  test("rejects an operation that targets a run other than the active run", async () => {
    let sends = 0;
    const context = createContext({
      currentRunId: () => DRIVER_TEST_IDS.runId,
      pushEvents: async () => {
        sends += 1;
        return { accepted: [] };
      },
    });
    const publisher = new DriverEventPublisher("openai-runtime", () => "session-ref");

    expect(() =>
      publisher.pushTerminal(context, "terminal", [], {
        ...createRunTerminal("run.completed"),
        runId: DRIVER_TEST_IDS.secondRunId,
      }),
    ).toThrow("must target the active run");
    expect(sends).toBe(0);
    await context.logger.destroy();
  });
});
