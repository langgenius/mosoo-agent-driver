import { describe, expect, test } from "bun:test";

import {
  DriverPermissionBroker,
  PermissionEventDeliveryError,
} from "../src/core/driver-permission-broker";
import type { DriverRuntimeEventPort } from "../src/core/driver-runtime-io";
import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import type { DriverEventBatchOutput } from "../src/protocol/orpc";
import { CMA_MAX_EVENT_BYTES } from "../src/stores/cma-store";
import { createCmaMemoryStore } from "../src/stores/memory";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

const runId = "run-1" as RunId;

interface RecordingSocket extends DriverRuntimeEventPort {
  readonly pushedEvents: DriverEventInput[];
}

function acceptEvents(events: readonly DriverEventInput[]): DriverEventBatchOutput {
  return {
    accepted: events.map((event, index) => ({
      eventId: event.sourceEventId!,
      seq: index + 1,
      type: event.kind,
    })),
  };
}

function createRecordingSocket(): RecordingSocket {
  const pushedEvents: DriverEventInput[] = [];

  return {
    currentRunId: () => runId,
    pushedEvents,
    pushEvents: async (input) => {
      pushedEvents.push(...input.events);
      return acceptEvents(input.events);
    },
  };
}

const permissionInput = {
  agentId: "subagent-1",
  blockedPath: "/workspace/secret",
  decisionReason: "Path is outside the allowed roots.",
  description: "Read access to /workspace/secret",
  matchedAskRule: {
    ruleContent: "Read(/workspace/secret/**)",
    source: "project",
    toolName: "Read",
  },
  rawInput: '{"command":"fd ."}',
  requestId: "permission-1",
  title: "Approve command execution",
  toolCallId: "tool-1",
  toolKind: "bash",
} as const;
const permissionInputBytes = new TextEncoder().encode(JSON.stringify(permissionInput)).byteLength;

describe("DriverPermissionBroker", () => {
  test.each([
    ["allow_once", "approved"],
    ["reject_once", "rejected"],
  ] as const)("resolves a permission with %s", async (decision, reason) => {
    const broker = new DriverPermissionBroker(() => null);
    const socket = createRecordingSocket();

    const request = broker.request(socket, permissionInput);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.pushedEvents).toMatchObject([
      {
        kind: "permission.requested",
        payload: {
          agentId: "subagent-1",
          blockedPath: "/workspace/secret",
          decisionReason: "Path is outside the allowed roots.",
          description: "Read access to /workspace/secret",
          details: '{"command":"fd ."}',
          matchedAskRule: {
            ruleContent: "Read(/workspace/secret/**)",
            source: "project",
            toolName: "Read",
          },
          requestId: "permission-1",
          targetItemId: "tool-1",
          title: "Approve command execution",
        },
      },
    ]);

    expect(broker.resolve("permission-1", decision)).toBe(true);
    await expect(request).resolves.toBe(decision);
    expect(broker.resolve("permission-1", decision)).toBe(false);

    expect(socket.pushedEvents).toMatchObject([
      {
        kind: "permission.requested",
      },
      {
        kind: "permission.resolved",
        payload: {
          outcome: decision,
          permissionRequests: [],
          reason,
          requestId: "permission-1",
        },
      },
    ]);
  });

  test("rejects a duplicate request without orphaning the first request", async () => {
    const broker = new DriverPermissionBroker(() => null);
    const socket = createRecordingSocket();
    const first = broker.request(socket, permissionInput);

    await Promise.resolve();
    await expect(broker.request(socket, permissionInput)).rejects.toThrow("already pending");
    expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
    await expect(first).resolves.toBe("allow_once");
  });

  test("rejects a request whose delivery outlives its run generation", async () => {
    const deliveryEntered = Promise.withResolvers<void>();
    const releaseDelivery = Promise.withResolvers<void>();
    const broker = new DriverPermissionBroker(() => null);
    let ownsRun = true;
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events }) => {
        deliveryEntered.resolve();
        await releaseDelivery.promise;
        return acceptEvents(events);
      },
    };

    const request = broker.request(socket, permissionInput, undefined, () => ownsRun);
    await deliveryEntered.promise;
    ownsRun = false;
    releaseDelivery.resolve();

    await expect(request).resolves.toBe("reject_once");
    expect(broker.hasPending()).toBe(false);
  });

  test("bounds the number of pending requests", async () => {
    const broker = new DriverPermissionBroker(() => null, {
      maxPendingRequestBytes: 1_024,
      maxPendingRequests: 1,
    });
    const socket = createRecordingSocket();
    const first = broker.request(socket, permissionInput);
    const secondInput = { ...permissionInput, requestId: "permission-2" };

    await expect(broker.request(socket, secondInput)).rejects.toThrow(
      "pending request limit is exhausted",
    );
    expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
    await expect(first).resolves.toBe("allow_once");

    const second = broker.request(socket, secondInput);
    expect(broker.resolve(secondInput.requestId, "allow_once")).toBe(true);
    await expect(second).resolves.toBe("allow_once");
  });

  test("counts UTF-8 bytes and accepts the exact pending byte limit", async () => {
    const firstInput = { ...permissionInput, rawInput: '{"路径":"你好🙂"}' };
    const secondInput = { ...firstInput, requestId: "permission-2" };
    const bytes = new TextEncoder().encode(JSON.stringify(firstInput)).byteLength;
    const broker = new DriverPermissionBroker(() => null, {
      maxPendingRequestBytes: bytes,
      maxPendingRequests: 2,
    });
    const socket = createRecordingSocket();
    const first = broker.request(socket, firstInput);

    expect(JSON.stringify(firstInput).length).toBeLessThan(bytes);
    await expect(broker.request(socket, secondInput)).rejects.toThrow(
      "pending request byte budget is exhausted",
    );
    expect(broker.resolve(firstInput.requestId, "allow_once")).toBe(true);
    await expect(first).resolves.toBe("allow_once");

    const second = broker.request(socket, secondInput);
    expect(broker.resolve(secondInput.requestId, "allow_once")).toBe(true);
    await expect(second).resolves.toBe("allow_once");
  });

  test("rejects a request larger than the UTF-8 budget before publishing it", async () => {
    const broker = new DriverPermissionBroker(() => null, {
      maxPendingRequestBytes: permissionInputBytes - 1,
    });
    const socket = createRecordingSocket();

    await expect(broker.request(socket, permissionInput)).rejects.toThrow(
      "pending request byte budget is exhausted",
    );
    expect(broker.hasPending()).toBe(false);
    expect(socket.pushedEvents).toEqual([]);
  });

  test("rejects an oversized permission event before the real CMA boundary", async () => {
    const broker = new DriverPermissionBroker(() => null);
    const store = createCmaMemoryStore({ sessions: [{ id: DRIVER_TEST_IDS.sessionId }] });
    const pushedEvents: DriverEventInput[] = [];
    let sequence = 0;
    const socket: RecordingSocket = {
      currentRunId: () => DRIVER_TEST_IDS.runId,
      pushedEvents,
      pushEvents: async ({ events }) => {
        for (const event of events) {
          const [envelope] = toDriverEventEnvelopes(
            driverBootPayload,
            event,
            DRIVER_TEST_IDS.runId,
          );
          await store.appendDriverEvent(DRIVER_TEST_IDS.sessionId, envelope!.event);
        }
        pushedEvents.push(...events);
        return {
          accepted: events.map((event) => ({
            eventId: event.sourceEventId!,
            seq: (sequence += 1),
            type: event.kind,
          })),
        };
      },
    };
    const safeInput = { ...permissionInput, rawInput: "x".repeat(500_000) };
    const safeRequest = broker.request(socket, safeInput);

    await Bun.sleep(0);
    expect(broker.resolve(safeInput.requestId, "reject_once")).toBe(true);
    await expect(safeRequest).resolves.toBe("reject_once");
    expect(pushedEvents.map(({ kind }) => kind)).toEqual([
      "permission.requested",
      "permission.resolved",
    ]);

    await expect(
      broker.request(socket, {
        ...permissionInput,
        rawInput: "x".repeat(CMA_MAX_EVENT_BYTES),
        requestId: "permission-oversized",
      }),
    ).rejects.toThrow("permission request event exceeds 524288 UTF-8 bytes");
    expect(pushedEvents).toHaveLength(2);
    expect(broker.hasPending()).toBe(false);
  });

  test.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects invalid pending limits %p",
    (limit) => {
      expect(() => new DriverPermissionBroker(() => null, { maxPendingRequests: limit })).toThrow(
        "limits must be positive safe integers",
      );
      expect(
        () => new DriverPermissionBroker(() => null, { maxPendingRequestBytes: limit }),
      ).toThrow("limits must be positive safe integers");
    },
  );

  test.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects invalid permission timeout %p",
    (timeoutMs) => {
      expect(() => new DriverPermissionBroker(() => null, { requestTimeoutMs: timeoutMs })).toThrow(
        "request timeout must be a non-negative safe integer",
      );
      expect(
        () => new DriverPermissionBroker(() => null, { eventDeliveryTimeoutMs: timeoutMs }),
      ).toThrow("event delivery timeout must be a non-negative safe integer");
    },
  );

  test("allows an immediate permission timeout", () => {
    expect(() => new DriverPermissionBroker(() => null, { requestTimeoutMs: 0 })).not.toThrow();
  });

  test.each(["resolve", "abort", "rejectAll", "timeout", "publish retry"] as const)(
    "returns pending capacity after %s",
    async (mode) => {
      const controller = new AbortController();
      let failPublish = mode === "publish retry";
      const socket: DriverRuntimeEventPort = {
        currentRunId: () => runId,
        pushEvents: async ({ events }) => {
          if (failPublish) {
            failPublish = false;
            throw new Error("event sink unavailable");
          }

          return acceptEvents(events);
        },
      };
      const broker = new DriverPermissionBroker(() => null, {
        maxPendingRequestBytes: permissionInputBytes,
        maxPendingRequests: 1,
        requestTimeoutMs: mode === "timeout" ? 1 : 100,
      });
      const first = broker.request(socket, permissionInput, controller.signal);

      await Promise.resolve();
      switch (mode) {
        case "abort":
          controller.abort();
          await expect(first).resolves.toBe("reject_once");
          break;
        case "publish retry":
          expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
          await expect(first).resolves.toBe("allow_once");
          break;
        case "rejectAll":
          broker.rejectAll();
          await expect(first).resolves.toBe("reject_once");
          break;
        case "resolve":
          expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
          await expect(first).resolves.toBe("allow_once");
          break;
        case "timeout":
          await expect(first).resolves.toBe("reject_once");
          break;
      }

      const secondInput = { ...permissionInput, requestId: "permission-2" };
      const second = broker.request(socket, secondInput);
      expect(broker.resolve(secondInput.requestId, "allow_once")).toBe(true);
      await expect(second).resolves.toBe("allow_once");
    },
  );

  test.each(["abort", "rejectAll", "timeout"] as const)(
    "retains a timed-out permission.requested %s lease until late delivery settles",
    async (mode) => {
      const requestedPublishing = Promise.withResolvers<void>();
      const lateDelivery = Promise.withResolvers<DriverEventBatchOutput>();
      const controller = new AbortController();
      let stallRequested = true;
      let requestedEvents: readonly DriverEventInput[] = [];
      const socket: DriverRuntimeEventPort = {
        currentRunId: () => runId,
        pushEvents: async ({ events }) => {
          if (stallRequested && events.some((event) => event.kind === "permission.requested")) {
            requestedEvents = events;
            requestedPublishing.resolve();
            return lateDelivery.promise;
          }

          return acceptEvents(events);
        },
      };
      const broker = new DriverPermissionBroker(() => null, {
        eventDeliveryTimeoutMs: 5,
        maxPendingRequestBytes: permissionInputBytes,
        maxPendingRequests: 1,
        requestTimeoutMs: 1_000,
      });
      const request = broker.request(socket, permissionInput, controller.signal);

      await requestedPublishing.promise;
      if (mode === "abort") {
        controller.abort();
      } else if (mode === "rejectAll") {
        broker.rejectAll();
      }

      const outcome = await settlePromiseWithTimeout(request, {
        label: "stalled permission request delivery",
        timeoutMs: 100,
      });
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.error).toBeInstanceOf(PermissionEventDeliveryError);
        expect(outcome.error).toMatchObject({
          phase: "requested",
          requestId: permissionInput.requestId,
        });
      }
      expect(broker.hasPending()).toBe(true);
      await expect(broker.request(socket, permissionInput)).rejects.toThrow("already pending");
      await expect(
        broker.request(socket, { ...permissionInput, requestId: "permission-2" }),
      ).rejects.toThrow("pending request limit is exhausted");

      stallRequested = false;
      lateDelivery.resolve(acceptEvents(requestedEvents));
      await Bun.sleep(0);
      expect(broker.hasPending()).toBe(false);
      const retry = broker.request(socket, permissionInput);
      expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
      await expect(retry).resolves.toBe("allow_once");
    },
  );

  test.each(["abort", "rejectAll", "timeout"] as const)(
    "retains a timed-out permission.resolved %s lease until late delivery settles",
    async (mode) => {
      const resolutionPublishing = Promise.withResolvers<void>();
      const lateDelivery = Promise.withResolvers<DriverEventBatchOutput>();
      const controller = new AbortController();
      let stallResolution = true;
      let resolutionEvents: readonly DriverEventInput[] = [];
      const socket: DriverRuntimeEventPort = {
        currentRunId: () => runId,
        pushEvents: async ({ events }) => {
          if (stallResolution && events.some((event) => event.kind === "permission.resolved")) {
            resolutionEvents = events;
            resolutionPublishing.resolve();
            return lateDelivery.promise;
          }

          return acceptEvents(events);
        },
      };
      const broker = new DriverPermissionBroker(() => null, {
        eventDeliveryTimeoutMs: 10,
        maxPendingRequestBytes: permissionInputBytes,
        maxPendingRequests: 1,
        requestTimeoutMs: mode === "timeout" ? 10 : 1_000,
      });
      const request = broker.request(socket, permissionInput, controller.signal);

      await Promise.resolve();
      if (mode === "abort") {
        controller.abort();
      } else if (mode === "rejectAll") {
        broker.rejectAll();
      }
      await resolutionPublishing.promise;

      const outcome = await settlePromiseWithTimeout(request, {
        label: "stalled permission resolution delivery",
        timeoutMs: 100,
      });
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.error).toBeInstanceOf(PermissionEventDeliveryError);
        expect(outcome.error).toMatchObject({
          phase: "resolved",
          requestId: permissionInput.requestId,
        });
      }
      expect(broker.hasPending()).toBe(true);
      await expect(broker.request(socket, permissionInput)).rejects.toThrow("already pending");
      await expect(
        broker.request(socket, { ...permissionInput, requestId: "permission-2" }),
      ).rejects.toThrow("pending request limit is exhausted");

      stallResolution = false;
      lateDelivery.resolve(acceptEvents(resolutionEvents));
      await Bun.sleep(0);
      expect(broker.hasPending()).toBe(false);
      const retry = broker.request(socket, permissionInput);
      expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
      await expect(retry).resolves.toBe("allow_once");
    },
  );

  test("gives a timed-out decision a full resolution delivery budget", async () => {
    const broker = new DriverPermissionBroker(() => null, {
      eventDeliveryTimeoutMs: 50,
      requestTimeoutMs: 1,
    });
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events }) => {
        if (events.some((event) => event.kind === "permission.resolved")) {
          await Bun.sleep(10);
        }

        return acceptEvents(events);
      },
    };

    await expect(broker.request(socket, permissionInput)).resolves.toBe("reject_once");
  });

  test("wraps a rejected resolution delivery and releases capacity", async () => {
    const deliveryFailure = new Error("event sink unavailable");
    let failResolution = true;
    const broker = new DriverPermissionBroker(() => null, {
      maxPendingRequestBytes: permissionInputBytes,
      maxPendingRequests: 1,
    });
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events }) => {
        if (failResolution && events.some((event) => event.kind === "permission.resolved")) {
          throw deliveryFailure;
        }

        return acceptEvents(events);
      },
    };
    const request = broker.request(socket, permissionInput);

    await Promise.resolve();
    expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
    const outcome = await settlePromiseWithTimeout(request, {
      label: "rejected permission resolution delivery",
      timeoutMs: 100,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error).toBeInstanceOf(PermissionEventDeliveryError);
      expect(outcome.error).toMatchObject({
        phase: "resolved",
        requestId: permissionInput.requestId,
      });
      expect(((outcome.error as Error).cause as Error).cause).toBe(deliveryFailure);
    }

    failResolution = false;
    const retry = broker.request(socket, permissionInput);
    expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
    await expect(retry).resolves.toBe("allow_once");
  });

  test.each([
    [
      "request count after resolution",
      "resolve",
      { maxPendingRequestBytes: permissionInputBytes * 2, maxPendingRequests: 1 },
      "pending request limit is exhausted",
    ],
    [
      "UTF-8 bytes after abort",
      "abort",
      { maxPendingRequestBytes: permissionInputBytes, maxPendingRequests: 2 },
      "pending request byte budget is exhausted",
    ],
  ] as const)(
    "holds %s until resolution delivery completes",
    async (_budget, action, limits, error) => {
      const resolutionPublishing = Promise.withResolvers<void>();
      const releaseResolution = Promise.withResolvers<void>();
      const controller = new AbortController();
      const socket: DriverRuntimeEventPort = {
        currentRunId: () => runId,
        pushEvents: async ({ events }) => {
          if (events.some((event) => event.kind === "permission.resolved")) {
            resolutionPublishing.resolve();
            await releaseResolution.promise;
          }

          return acceptEvents(events);
        },
      };
      const broker = new DriverPermissionBroker(() => null, {
        ...limits,
        requestTimeoutMs: 100,
      });
      const first = broker.request(socket, permissionInput, controller.signal);

      await Promise.resolve();
      if (action === "abort") {
        controller.abort();
      } else {
        expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
      }
      await resolutionPublishing.promise;
      expect(broker.hasPending()).toBe(true);

      const secondInput = { ...permissionInput, requestId: "permission-2" };
      await expect(broker.request(socket, secondInput)).rejects.toThrow(error);

      releaseResolution.resolve();
      await expect(first).resolves.toBe(action === "abort" ? "reject_once" : "allow_once");
      expect(broker.hasPending()).toBe(false);
      const second = broker.request(socket, secondInput);
      expect(broker.resolve(secondInput.requestId, "allow_once")).toBe(true);
      await expect(second).resolves.toBe("allow_once");
    },
  );

  test.each([
    [
      "approved",
      "allow_once",
      (broker: DriverPermissionBroker) => broker.resolve(permissionInput.requestId, "allow_once"),
    ],
    [
      "cancelled",
      "reject_once",
      (broker: DriverPermissionBroker) => {
        broker.rejectAll();
        return true;
      },
    ],
  ] as const)(
    "does not reuse an old %s request id before resolution delivery finishes",
    async (_reason, firstDecision, resolveFirst) => {
      const firstResolutionPublishing = Promise.withResolvers<void>();
      const releaseFirstResolution = Promise.withResolvers<void>();
      let resolvedEvents = 0;
      const broker = new DriverPermissionBroker(() => null, { requestTimeoutMs: 100 });
      const socket: DriverRuntimeEventPort = {
        currentRunId: () => runId,
        pushEvents: async ({ events }) => {
          if (events.some((event) => event.kind === "permission.resolved")) {
            resolvedEvents += 1;

            if (resolvedEvents === 1) {
              firstResolutionPublishing.resolve();
              await releaseFirstResolution.promise;
            }
          }

          return acceptEvents(events);
        },
      };

      const first = broker.request(socket, permissionInput);
      await Promise.resolve();
      expect(resolveFirst(broker)).toBe(true);
      await firstResolutionPublishing.promise;

      const prematureReuse = broker.request(socket, permissionInput);
      const prematureReuseRejected = expect(prematureReuse).rejects.toThrow("already pending");
      await Promise.resolve();
      const lateDecisionAccepted = broker.resolve(permissionInput.requestId, "reject_once");
      releaseFirstResolution.resolve();
      await expect(first).resolves.toBe(firstDecision);
      expect(lateDecisionAccepted).toBe(false);
      await prematureReuseRejected;

      const second = broker.request(socket, permissionInput);
      expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
      await expect(second).resolves.toBe("allow_once");
    },
  );

  test("stays pending until every concurrent request is resolved", async () => {
    const broker = new DriverPermissionBroker(() => null);
    const socket = createRecordingSocket();
    const first = broker.request(socket, permissionInput);
    const secondInput = { ...permissionInput, requestId: "permission-2" };
    const second = broker.request(socket, secondInput);

    await Promise.resolve();
    expect(broker.hasPending()).toBe(true);
    expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
    await expect(first).resolves.toBe("allow_once");
    expect(broker.hasPending()).toBe(true);
    expect(broker.resolve(secondInput.requestId, "reject_once")).toBe(true);
    await expect(second).resolves.toBe("reject_once");
    expect(broker.hasPending()).toBe(false);
  });

  test("stays pending until every concurrent resolution is delivered", async () => {
    const resolutionsPublishing = Promise.withResolvers<void>();
    const releaseResolutions = Promise.withResolvers<void>();
    let resolutionCount = 0;
    const broker = new DriverPermissionBroker(() => null, {
      eventDeliveryTimeoutMs: 100,
      requestTimeoutMs: 100,
    });
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events }) => {
        if (events.some((event) => event.kind === "permission.resolved")) {
          resolutionCount += 1;

          if (resolutionCount === 2) {
            resolutionsPublishing.resolve();
          }
          await releaseResolutions.promise;
        }

        return acceptEvents(events);
      },
    };
    const first = broker.request(socket, permissionInput);
    const secondInput = { ...permissionInput, requestId: "permission-2" };
    const second = broker.request(socket, secondInput);

    await Promise.resolve();
    expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
    expect(broker.resolve(secondInput.requestId, "reject_once")).toBe(true);
    await resolutionsPublishing.promise;
    expect(broker.hasPending()).toBe(true);

    releaseResolutions.resolve();
    await Promise.all([first, second]);
    expect(broker.hasPending()).toBe(false);
  });

  test("replays one stable lifecycle when persisted permission ACKs are lost", async () => {
    const attempts: DriverEventInput[][] = [];
    const persisted = new Map<string, string>();
    const phaseAttempts = new Map<string, number>();
    const broker = new DriverPermissionBroker(() => null);
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events }) => {
        const owned = structuredClone(events);
        attempts.push(owned);
        for (const event of owned) {
          const sourceEventId = event.sourceEventId!;
          const content = JSON.stringify(event);
          const previous = persisted.get(sourceEventId);
          expect(previous === undefined || previous === content).toBe(true);
          persisted.set(sourceEventId, content);
        }

        const phase = owned[0]!.kind;
        const attempt = (phaseAttempts.get(phase) ?? 0) + 1;
        phaseAttempts.set(phase, attempt);
        if (attempt === 1) {
          throw new Error(`${phase} ACK lost after persistence`);
        }
        return acceptEvents(owned);
      },
    };

    for (let replay = 0; replay < 2; replay += 1) {
      const request = broker.request(socket, permissionInput);
      await Promise.resolve();
      broker.rejectAll();
      await expect(request).resolves.toBe("reject_once");
    }

    expect(attempts.map((events) => events.map(({ kind }) => kind))).toEqual([
      ["permission.requested"],
      ["permission.requested"],
      ["permission.resolved", "diagnostic.reported"],
      ["permission.resolved", "diagnostic.reported"],
      ["permission.requested"],
      ["permission.resolved", "diagnostic.reported"],
    ]);
    expect(persisted.size).toBe(3);
    expect(
      [...persisted.keys()].every((sourceEventId) => sourceEventId.startsWith("permission:")),
    ).toBe(true);
  });

  test("rejects unsupported interactive permission requests instead of allowing them", async () => {
    const broker = new DriverPermissionBroker(() => null, { interactiveRequests: false });
    const socket = createRecordingSocket();

    await expect(broker.request(socket, permissionInput)).resolves.toBe("reject_once");

    expect(broker.capabilityStatus()).toBe("unsupported");
    expect(socket.pushedEvents).toEqual([]);
  });

  test("marks pending permission requests as cancelled when rejecting all", async () => {
    const broker = new DriverPermissionBroker(() => null);
    const socket = createRecordingSocket();

    const request = broker.request(socket, permissionInput);

    await new Promise((resolve) => setTimeout(resolve, 0));
    broker.rejectAll();

    await expect(request).resolves.toBe("reject_once");
    expect(socket.pushedEvents).toMatchObject([
      {
        kind: "permission.requested",
      },
      {
        kind: "permission.resolved",
        payload: {
          outcome: "reject_once",
          reason: "cancelled",
          requestId: "permission-1",
        },
      },
      {
        kind: "diagnostic.reported",
        payload: {
          code: "permission.cancelled",
          details: {
            requestId: "permission-1",
          },
          severity: "info",
          source: "permission",
        },
      },
    ]);
  });

  test("waits for the cancelled permission event pipeline to become idle", async () => {
    const requestedPublishing = Promise.withResolvers<void>();
    const releaseRequested = Promise.withResolvers<void>();
    const resolutionPublishing = Promise.withResolvers<void>();
    const releaseResolution = Promise.withResolvers<void>();
    const pushedEvents: DriverEventInput[] = [];
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events }) => {
        pushedEvents.push(...events);

        if (events.some((event) => event.kind === "permission.requested")) {
          requestedPublishing.resolve();
          await releaseRequested.promise;
        }
        if (events.some((event) => event.kind === "permission.resolved")) {
          resolutionPublishing.resolve();
          await releaseResolution.promise;
        }

        return acceptEvents(events);
      },
    };
    const broker = new DriverPermissionBroker(() => null, {
      eventDeliveryTimeoutMs: 200,
    });
    const request = broker.request(socket, permissionInput);

    await requestedPublishing.promise;
    const cancellation = broker.rejectAllAndWait();
    let cancellationSettled = false;
    void cancellation.then(
      () => {
        cancellationSettled = true;
      },
      () => {
        cancellationSettled = true;
      },
    );
    expect(broker.rejectAllAndWait()).toBe(cancellation);
    await Bun.sleep(120);
    expect(cancellationSettled).toBe(false);

    releaseRequested.resolve();
    await resolutionPublishing.promise;
    await Bun.sleep(120);
    expect(cancellationSettled).toBe(false);

    releaseResolution.resolve();
    await expect(Promise.all([request, cancellation])).resolves.toEqual(["reject_once", undefined]);
    expect(broker.hasPending()).toBe(false);
    expect(pushedEvents.map(({ kind }) => kind)).toEqual([
      "permission.requested",
      "permission.resolved",
      "diagnostic.reported",
    ]);
  });

  test("gives a cancellation retry a fresh wait budget", async () => {
    const requestedPublishing = Promise.withResolvers<void>();
    const releaseRequested = Promise.withResolvers<void>();
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events }) => {
        if (events.some((event) => event.kind === "permission.requested")) {
          requestedPublishing.resolve();
          await releaseRequested.promise;
        }
        return acceptEvents(events);
      },
    };
    const broker = new DriverPermissionBroker(() => null, {
      eventDeliveryTimeoutMs: 10,
    });
    const request = broker.request(socket, permissionInput);
    const requestOutcome = request.then(
      () => null,
      (error: unknown) => error,
    );

    await requestedPublishing.promise;
    const first = broker.rejectAllAndWait();
    await expect(first).rejects.toThrow("Driver permission cancellation timed out");

    const retry = broker.rejectAllAndWait();
    expect(retry).not.toBe(first);
    let retrySettled = false;
    void retry.then(
      () => {
        retrySettled = true;
      },
      () => {
        retrySettled = true;
      },
    );
    await Promise.resolve();
    expect(retrySettled).toBe(false);

    releaseRequested.resolve();
    expect(await requestOutcome).toBeInstanceOf(PermissionEventDeliveryError);
    await expect(retry).resolves.toBeUndefined();
  });

  test("bounds ordinary cancellation delivery below the active-turn grace", async () => {
    const requestedPublishing = Promise.withResolvers<void>();
    const pushedKinds: string[] = [];
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events, signal }) => {
        pushedKinds.push(...events.map((event) => event.kind));

        if (events.some((event) => event.kind === "permission.requested")) {
          requestedPublishing.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }

        return acceptEvents(events);
      },
    };
    const broker = new DriverPermissionBroker(() => null, {
      eventDeliveryTimeoutMs: 5_000,
    });
    const request = broker.request(socket, permissionInput);

    await requestedPublishing.promise;
    broker.rejectAll();
    const outcome = await request.catch((error: unknown) => error);

    expect(outcome).toMatchObject({
      phase: "requested",
      requestId: permissionInput.requestId,
    });
    expect(String((outcome as Error).cause)).toContain("cancellation delivery timed out");
    expect(pushedKinds).toEqual(["permission.requested"]);
  }, 10_000);

  test("bounds cancellation after a decision while its resolution is still delivering", async () => {
    const resolutionPublishing = Promise.withResolvers<void>();
    const controller = new AbortController();
    const acceptedKinds: string[] = [];
    const pushedKinds: string[] = [];
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events, signal }) => {
        pushedKinds.push(...events.map((event) => event.kind));

        if (events.some((event) => event.kind === "permission.resolved")) {
          resolutionPublishing.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }

        acceptedKinds.push(...events.map((event) => event.kind));
        return acceptEvents(events);
      },
    };
    const broker = new DriverPermissionBroker(() => null, {
      eventDeliveryTimeoutMs: 5_000,
    });
    const request = broker.request(socket, permissionInput, controller.signal);

    await Promise.resolve();
    expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
    await resolutionPublishing.promise;
    controller.abort();
    const outcome = await request.catch((error: unknown) => error);

    expect(outcome).toMatchObject({
      phase: "resolved",
      requestId: permissionInput.requestId,
    });
    expect(String((outcome as Error).cause)).toContain("cancellation delivery timed out");
    expect(pushedKinds).toEqual(["permission.requested", "permission.resolved"]);
    expect(acceptedKinds).toEqual(["permission.requested"]);
  }, 10_000);

  test("keeps the full shutdown budget after a decision starts delivering", async () => {
    const resolutionPublishing = Promise.withResolvers<void>();
    const releaseResolution = Promise.withResolvers<void>();
    const controller = new AbortController();
    let deliveryAborted = false;
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events, signal }) => {
        if (events.some((event) => event.kind === "permission.resolved")) {
          resolutionPublishing.resolve();
          await Promise.race([
            releaseResolution.promise,
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  deliveryAborted = true;
                  reject(signal.reason);
                },
                { once: true },
              );
            }),
          ]);
        }

        return acceptEvents(events);
      },
    };
    const broker = new DriverPermissionBroker(() => null, {
      eventDeliveryTimeoutMs: 5_000,
    });
    const request = broker.request(socket, permissionInput, controller.signal);

    await Promise.resolve();
    expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(true);
    await resolutionPublishing.promise;
    broker.rejectAll();
    const shutdown = broker.rejectAllAndWait();
    let shutdownSettled = false;
    void shutdown.then(
      () => {
        shutdownSettled = true;
      },
      () => {
        shutdownSettled = true;
      },
    );
    controller.abort();
    await Bun.sleep(1_600);

    expect(deliveryAborted).toBe(false);
    expect(shutdownSettled).toBe(false);
    releaseResolution.resolve();
    await expect(Promise.all([request, shutdown])).resolves.toEqual(["allow_once", undefined]);
  }, 3_000);

  test("reports timed out permission requests explicitly", async () => {
    const broker = new DriverPermissionBroker(() => null, { requestTimeoutMs: 1 });
    const socket = createRecordingSocket();

    await expect(broker.request(socket, permissionInput)).resolves.toBe("reject_once");

    expect(socket.pushedEvents).toMatchObject([
      {
        kind: "permission.requested",
      },
      {
        kind: "permission.resolved",
        payload: {
          outcome: "reject_once",
          reason: "timed_out",
          requestId: "permission-1",
        },
      },
      {
        kind: "diagnostic.reported",
        payload: {
          code: "permission.timed_out",
          details: {
            requestId: "permission-1",
          },
          severity: "warn",
          source: "permission",
        },
      },
    ]);
  });

  test("rejects a late decision while publishing a timeout", async () => {
    const timeoutPublishing = Promise.withResolvers<void>();
    const releaseTimeoutPublish = Promise.withResolvers<void>();
    let pushCount = 0;
    const broker = new DriverPermissionBroker(() => null, { requestTimeoutMs: 1 });
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events }) => {
        pushCount += 1;

        if (pushCount === 2) {
          timeoutPublishing.resolve();
          await releaseTimeoutPublish.promise;
        }

        return acceptEvents(events);
      },
    };

    const request = broker.request(socket, permissionInput);
    await timeoutPublishing.promise;

    expect(broker.hasPending()).toBe(true);
    expect(broker.resolve(permissionInput.requestId, "allow_once")).toBe(false);

    releaseTimeoutPublish.resolve();
    await expect(request).resolves.toBe("reject_once");
    expect(broker.hasPending()).toBe(false);
  });

  test("drains a partially accepted resolution batch before returning", async () => {
    const batchSizes: number[] = [];
    const broker = new DriverPermissionBroker(() => null);
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events }) => {
        batchSizes.push(events.length);
        return acceptEvents(events.slice(0, 1));
      },
    };

    const request = broker.request(socket, permissionInput);
    await Promise.resolve();
    broker.rejectAll();

    await expect(request).resolves.toBe("reject_once");
    expect(batchSizes).toEqual([1, 2, 1]);
  });

  test("fails and releases a request when event delivery makes no progress", async () => {
    const broker = new DriverPermissionBroker(() => null);
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async () => ({ accepted: [] }),
    };

    const outcome = await broker.request(socket, permissionInput).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(PermissionEventDeliveryError);
    expect(outcome).toMatchObject({
      phase: "requested",
      requestId: permissionInput.requestId,
    });
    expect((outcome as Error).cause).toHaveProperty(
      "message",
      expect.stringContaining("made no progress"),
    );
    expect(broker.hasPending()).toBe(false);
  });

  test("an abort cancels only its request and waits for the rejection event", async () => {
    const cancelledPublishing = Promise.withResolvers<void>();
    const releaseCancelledPublish = Promise.withResolvers<void>();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const broker = new DriverPermissionBroker(() => null);
    const pushedEvents: DriverEventInput[] = [];
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => runId,
      pushEvents: async ({ events }) => {
        pushedEvents.push(...events);

        if (
          events.some(
            (event) =>
              event.kind === "permission.resolved" &&
              (event.payload as Record<string, unknown>)["requestId"] === permissionInput.requestId,
          )
        ) {
          cancelledPublishing.resolve();
          await releaseCancelledPublish.promise;
        }

        return acceptEvents(events);
      },
    };
    const first = broker.request(socket, permissionInput, firstController.signal);
    const secondInput = { ...permissionInput, requestId: "permission-2" };
    const second = broker.request(socket, secondInput, secondController.signal);
    let firstSettled = false;
    void first.finally(() => {
      firstSettled = true;
    });

    await Promise.resolve();
    firstController.abort(new Error("request cancelled"));
    await cancelledPublishing.promise;
    expect(firstSettled).toBe(false);
    expect(broker.hasPending()).toBe(true);

    releaseCancelledPublish.resolve();
    await expect(first).resolves.toBe("reject_once");
    expect(broker.resolve(secondInput.requestId, "allow_once")).toBe(true);
    await expect(second).resolves.toBe("allow_once");
    expect(pushedEvents).toContainEqual(
      expect.objectContaining({
        kind: "permission.resolved",
        payload: expect.objectContaining({
          outcome: "reject_once",
          reason: "cancelled",
          requestId: permissionInput.requestId,
        }),
      }),
    );
  });

  test("a request with an already aborted signal rejects without becoming pending", async () => {
    const controller = new AbortController();
    controller.abort(new Error("request cancelled"));
    const broker = new DriverPermissionBroker(() => null);
    const socket = createRecordingSocket();

    await expect(broker.request(socket, permissionInput, controller.signal)).resolves.toBe(
      "reject_once",
    );

    expect(broker.hasPending()).toBe(false);
    expect(socket.pushedEvents).toMatchObject([
      { kind: "permission.requested" },
      {
        kind: "permission.resolved",
        payload: {
          outcome: "reject_once",
          reason: "cancelled",
          requestId: permissionInput.requestId,
        },
      },
      {
        kind: "diagnostic.reported",
        payload: { code: "permission.cancelled" },
      },
    ]);
  });
});
