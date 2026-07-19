import { afterEach, describe, expect, test } from "bun:test";

import { DriverProcess } from "../src/bin/driver-process";
import { DriverInstanceSocket } from "../src/infrastructure/runtime/driver-instance-socket";
import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";
import { createBackend } from "./driver-runtime-boundary-fixtures";

const nativeWebSocket = globalThis.WebSocket;
const nativeAbortSignalTimeout = AbortSignal.timeout;

class PendingWebSocket extends EventTarget {
  static readonly instances: PendingWebSocket[] = [];

  closeReason: string | null = null;
  readyState = 0;

  constructor(_url: string | URL) {
    super();
    PendingWebSocket.instances.push(this);
  }

  close(code = 1000, reason = ""): void {
    this.closeReason = reason;
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  send(_data?: unknown): void {}
}

class OpenWebSocket extends PendingWebSocket {
  constructor(url: string | URL) {
    super(url);
    this.readyState = 1;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
}

interface RpcRequest {
  readonly i: number;
  readonly p?: {
    readonly b?: {
      readonly json?: unknown;
    };
    readonly u: string;
  };
  readonly t?: number;
}

class RpcWebSocket extends OpenWebSocket {
  static acceptedEventCounts: number[] = [];
  static eventBatchMaxSize = 2;
  static heartbeatFails = false;
  static heartbeatIntervalMs = 1_000;
  static lostResponsePath: string | null = null;
  static pathObserver: ((path: string) => void) | null = null;
  static receiptOverride: Partial<{ eventId: string; seq: number; type: string }> | null = null;
  static sendFailurePath: string | null = null;
  static stalledPath: string | null = null;
  static stalled = Promise.withResolvers<void>();

  readonly eventBatchSizes: number[] = [];
  readonly paths: string[] = [];
  readonly requests: { input: unknown; path: string }[] = [];
  #nextEventSeq = 0;

  override send(data?: unknown): void {
    if (typeof data !== "string") {
      throw new Error("Test RPC socket only accepts JSON messages.");
    }

    const request = JSON.parse(data) as RpcRequest;

    if (request.t === 4) {
      return;
    }

    const path = request.p?.u;

    if (path === undefined) {
      throw new Error("Test RPC socket received an invalid request message.");
    }
    this.paths.push(path);
    RpcWebSocket.pathObserver?.(path);

    if (path === RpcWebSocket.sendFailurePath) {
      RpcWebSocket.sendFailurePath = null;
      throw new Error("test wire send failed");
    }

    const input = request.p?.b?.json;
    this.requests.push({ input, path });

    if (path === RpcWebSocket.lostResponsePath) {
      RpcWebSocket.lostResponsePath = null;
      RpcWebSocket.stalled.resolve();
      return;
    }

    if (path === RpcWebSocket.stalledPath) {
      RpcWebSocket.stalled.resolve();
      return;
    }

    let output: unknown;
    let status: number | undefined;

    if (path === "/driver/hello") {
      output = {
        acceptedCapabilities: [],
        connectionId: "connection-1",
        driverInstanceId: DRIVER_TEST_IDS.driverInstanceId,
        heartbeatIntervalMs: RpcWebSocket.heartbeatIntervalMs,
        runConfig: {
          commandLeaseMs: 30_000,
          envPolicy: "strict",
          eventBatchMaxSize: RpcWebSocket.eventBatchMaxSize,
          organizationPath: "/workspace",
        },
        runId: null,
      };
    } else if (path === "/driver/pushEvents") {
      const events = (input as { events: { event: { kind: string } }[] }).events;
      this.eventBatchSizes.push(events.length);
      const acceptedCount = RpcWebSocket.acceptedEventCounts.shift() ?? events.length;
      const accepted = events.slice(0, acceptedCount).map(({ event }) => {
        this.#nextEventSeq += 1;
        return {
          seq: this.#nextEventSeq,
          type: event.kind,
        };
      });

      if (accepted[0] !== undefined && RpcWebSocket.receiptOverride !== null) {
        Object.assign(accepted[0], RpcWebSocket.receiptOverride);
      }

      output = { accepted };
    } else if (path === "/driver/heartbeat") {
      if (RpcWebSocket.heartbeatFails) {
        status = 500;
        output = { message: "heartbeat transport failed" };
      } else {
        output = { heartbeatCount: 1, ok: true };
      }
    } else if (path === "/driverInstance/nextCommand") {
      output = { command: null };
    } else {
      output = { ok: true };
    }

    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            i: request.i,
            p: {
              ...(status === undefined ? {} : { s: status }),
              b: { json: output },
            },
          }),
        }),
      );
    });
  }
}

afterEach(() => {
  globalThis.WebSocket = nativeWebSocket;
  AbortSignal.timeout = nativeAbortSignalTimeout;
  PendingWebSocket.instances.length = 0;
  RpcWebSocket.acceptedEventCounts = [];
  RpcWebSocket.eventBatchMaxSize = 2;
  RpcWebSocket.heartbeatFails = false;
  RpcWebSocket.heartbeatIntervalMs = 1_000;
  RpcWebSocket.lostResponsePath = null;
  RpcWebSocket.pathObserver = null;
  RpcWebSocket.receiptOverride = null;
  RpcWebSocket.sendFailurePath = null;
  RpcWebSocket.stalledPath = null;
  RpcWebSocket.stalled = Promise.withResolvers<void>();
});

describe("DriverInstanceSocket lifecycle", () => {
  test("fails event delivery when a non-empty batch makes no receipt progress", async () => {
    RpcWebSocket.acceptedEventCounts = [0];
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    await socket.hello({
      capabilities: [],
      driverVersion: "test",
      protocolVersion: driverBootPayload.protocolVersion,
      startedAt: new Date(0).toISOString(),
    });

    await expect(
      socket.pushEvents({
        events: [
          {
            kind: "message.completed",
            payload: { messageId: "message-1", stopReason: "end_turn" },
          },
        ],
      }),
    ).rejects.toThrow("made no progress");
  });

  test.each([
    ["type", { type: "message.started" }, "event type"],
    ["sequence", { seq: -1 }, "non-negative"],
    ["event ID", { eventId: "wrong-event" }, "event ID"],
  ] as const)("rejects a receipt with a mismatched %s", async (_field, receipt, message) => {
    RpcWebSocket.receiptOverride = receipt;
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    await socket.hello({
      capabilities: [],
      driverVersion: "test",
      protocolVersion: driverBootPayload.protocolVersion,
      startedAt: new Date(0).toISOString(),
    });

    await expect(
      socket.pushEvents({
        events: [
          {
            kind: "message.completed",
            payload: { messageId: "message-1", stopReason: "end_turn" },
          },
        ],
      }),
    ).rejects.toThrow(message);
  });

  test.each([
    ["heartbeat interval", () => (RpcWebSocket.heartbeatIntervalMs = 0), "heartbeat interval"],
    ["event batch size", () => (RpcWebSocket.eventBatchMaxSize = 0), "event batch max size"],
  ] as const)("rejects an invalid negotiated %s", async (_field, configure, message) => {
    configure();
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();

    await expect(
      socket.hello({
        capabilities: [],
        driverVersion: "test",
        protocolVersion: driverBootPayload.protocolVersion,
        startedAt: new Date(0).toISOString(),
      }),
    ).rejects.toThrow(message);
  });
});

describe("DriverProcess lifecycle", () => {
  test("orders hello, backend startup, ready, and steady-state polling", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.heartbeatIntervalMs = 250;
    RpcWebSocket.stalledPath = "/driverInstance/nextCommand";
    const sequence: string[] = [];
    RpcWebSocket.pathObserver = (path) => sequence.push(path);
    const existingSignalListeners = new Set(process.listeners("SIGTERM"));
    const backend = createBackend();
    backend.start = async () => {
      sequence.push("backend.start");
    };
    const run = new DriverProcess(driverBootPayload, () => backend).run();

    await RpcWebSocket.stalled.promise;
    for (let attempt = 0; attempt < 100 && !sequence.includes("/driver/heartbeat"); attempt += 1) {
      await Bun.sleep(10);
    }

    const shutdown = process
      .listeners("SIGTERM")
      .find((listener) => !existingSignalListeners.has(listener));
    shutdown?.("SIGTERM");
    await expect(run).resolves.toBeUndefined();

    const hello = sequence.indexOf("/driver/hello");
    const backendStart = sequence.indexOf("backend.start");
    const ready = sequence.indexOf("/driver/ready");
    const heartbeat = sequence.indexOf("/driver/heartbeat");
    const commandPoll = sequence.indexOf("/driverInstance/nextCommand");
    expect({ hello, backendStart, ready, heartbeat, commandPoll }).toEqual({
      hello: expect.any(Number),
      backendStart: expect.any(Number),
      ready: expect.any(Number),
      heartbeat: expect.any(Number),
      commandPoll: expect.any(Number),
    });
    expect(hello).toBeLessThan(backendStart);
    expect(backendStart).toBeLessThan(ready);
    expect(ready).toBeLessThan(commandPoll);
    expect(ready).toBeLessThan(heartbeat);
  });

  test("propagates an idle backend lifecycle failure", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.stalledPath = "/driverInstance/nextCommand";
    const backend = createBackend();
    const failure = new Error("provider process exited");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    const run = new DriverProcess(driverBootPayload, () => backend).run();

    await RpcWebSocket.stalled.promise;
    (context as AgentDriverContext | null)?.lifecycle.fail(failure);

    await expect(run).rejects.toBe(failure);
    const paths = (PendingWebSocket.instances[0] as RpcWebSocket).paths;
    expect(paths.filter((path) => path === "/driver/failRun")).toHaveLength(1);
  });

  test.each([
    ["hello", "/driver/hello", false, 0],
    ["backend start", "/driverInstance/nextCommand", true, 2],
    ["command poll", "/driverInstance/nextCommand", false, 1],
  ] as const)(
    "joins a signal shutdown during %s",
    async (_stage, stalledPath, stallBackendStart, expectedStops) => {
      globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
      RpcWebSocket.stalledPath = stalledPath;
      const existingSignalListeners = new Set(process.listeners("SIGTERM"));
      const backend = createBackend();
      const backendStartEntered = Promise.withResolvers<void>();
      const releaseBackendStart = Promise.withResolvers<void>();
      const stopReasons: string[] = [];
      backend.start = async () => {
        if (stallBackendStart) {
          backendStartEntered.resolve();
          await releaseBackendStart.promise;
        }
      };
      backend.stop = async (_context, reason) => {
        stopReasons.push(reason);
        releaseBackendStart.resolve();
      };
      const driver = new DriverProcess(driverBootPayload, () => backend);
      const run = driver.run();

      await (stallBackendStart ? backendStartEntered.promise : RpcWebSocket.stalled.promise);
      const shutdown = process
        .listeners("SIGTERM")
        .find((listener) => !existingSignalListeners.has(listener));
      expect(shutdown).toBeDefined();
      shutdown?.("SIGTERM");

      const outcome = await settlePromiseWithTimeout(run, {
        label: "driver process signal shutdown",
        timeoutMs: 1_000,
      });
      expect(outcome.status).toBe("completed");
      expect(stopReasons).toEqual(Array.from({ length: expectedStops }, () => "signal.sigterm"));
      expect((PendingWebSocket.instances[0] as RpcWebSocket).paths).not.toContain(
        "/driver/failRun",
      );
      expect(process.listeners("SIGTERM")).toEqual([...existingSignalListeners]);
    },
  );

  test("stops resources created while the original backend start settles", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    const existingSignalListeners = new Set(process.listeners("SIGTERM"));
    const startEntered = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    const backend = createBackend();
    let resourceActive = false;
    let stopCount = 0;
    let startSignal: AbortSignal | undefined;
    backend.start = async (_context, signal) => {
      startSignal = signal;
      startEntered.resolve();
      await releaseStart.promise;
      signal.throwIfAborted();
      resourceActive = true;
    };
    backend.stop = async () => {
      stopCount += 1;
      resourceActive = false;
    };
    const run = new DriverProcess(driverBootPayload, () => backend).run();

    await startEntered.promise;
    const shutdown = process
      .listeners("SIGTERM")
      .find((listener) => !existingSignalListeners.has(listener));
    expect(shutdown).toBeDefined();
    shutdown?.("SIGTERM");

    expect(
      await Promise.race([
        run.then(
          () => true,
          () => true,
        ),
        Bun.sleep(10).then(() => false),
      ]),
    ).toBe(false);
    expect(stopCount).toBe(1);
    expect(startSignal?.aborted).toBe(true);
    expect(startSignal?.reason).toMatchObject({ message: "signal.sigterm" });
    releaseStart.resolve();

    await expect(run).resolves.toBeUndefined();
    expect(stopCount).toBe(2);
    expect(resourceActive).toBe(false);
    expect(process.listeners("SIGTERM")).toEqual([...existingSignalListeners]);
  });

  test("automatically retries final cleanup after shutdown times out during backend start", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    const existingSignalListeners = new Set(process.listeners("SIGTERM"));
    const startEntered = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    const finalCleanup = Promise.withResolvers<void>();
    const backend = createBackend();
    let resourceActive = false;
    let stopCount = 0;
    let startSignal: AbortSignal | undefined;
    backend.start = async (_context, signal) => {
      startSignal = signal;
      startEntered.resolve();
      await releaseStart.promise;
      signal.throwIfAborted();
      resourceActive = true;
    };
    backend.stop = async () => {
      stopCount += 1;
      resourceActive = false;

      if (stopCount === 3) {
        finalCleanup.resolve();
      }
    };
    const nativeSetTimeout = globalThis.setTimeout;
    const acceleratedSetTimeout = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => nativeSetTimeout(callback, delay === 5_000 ? 10 : delay, ...args);
    globalThis.setTimeout = acceleratedSetTimeout as typeof setTimeout;

    try {
      const run = new DriverProcess(driverBootPayload, () => backend).run();
      const outcome = run.then(
        () => null,
        (error: unknown) => error,
      );

      await startEntered.promise;
      const shutdown = process
        .listeners("SIGTERM")
        .find((listener) => !existingSignalListeners.has(listener));
      expect(shutdown).toBeDefined();
      shutdown?.("SIGTERM");
      await outcome;
      expect(startSignal?.aborted).toBe(true);
      expect(startSignal?.reason).toMatchObject({ message: "signal.sigterm" });
      releaseStart.resolve();

      const cleaned = await Promise.race([
        finalCleanup.promise.then(() => true),
        Bun.sleep(50).then(() => false),
      ]);
      expect(cleaned).toBe(true);
      expect(stopCount).toBe(3);
      expect(resourceActive).toBe(false);
      expect(process.listeners("SIGTERM")).toEqual([...existingSignalListeners]);
    } finally {
      releaseStart.resolve();
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("propagates a heartbeat failure instead of treating it as a normal shutdown", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.heartbeatFails = true;
    RpcWebSocket.heartbeatIntervalMs = 250;
    RpcWebSocket.stalledPath = "/driverInstance/nextCommand";
    const run = new DriverProcess(driverBootPayload, () => createBackend()).run();

    await RpcWebSocket.stalled.promise;
    const outcome = await settlePromiseWithTimeout(run, {
      label: "heartbeat failure shutdown",
      timeoutMs: 1_000,
    });

    expect(outcome.status).toBe("failed");
    expect((PendingWebSocket.instances[0] as RpcWebSocket).paths).toContain("/driver/failRun");
  });

  test.each([
    ["transient", 1, "completed"],
    ["persistent", Number.POSITIVE_INFINITY, "failed"],
  ] as const)(
    "bounds and retries a %s backend cleanup failure during process shutdown",
    async (_name, failures, expectedStatus) => {
      globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
      RpcWebSocket.stalledPath = "/driverInstance/nextCommand";
      const existingSignalListeners = new Set(process.listeners("SIGTERM"));
      const backend = createBackend();
      let stopCount = 0;
      backend.stop = async () => {
        stopCount += 1;

        if (stopCount <= failures) {
          throw new Error("cleanup failed");
        }
      };
      const driver = new DriverProcess(driverBootPayload, () => backend);
      const run = driver.run();

      await RpcWebSocket.stalled.promise;
      const shutdown = process
        .listeners("SIGTERM")
        .find((listener) => !existingSignalListeners.has(listener));
      expect(shutdown).toBeDefined();
      shutdown?.("SIGTERM");

      const outcome = await settlePromiseWithTimeout(run, {
        label: "driver process cleanup retry",
        timeoutMs: 1_000,
      });

      expect(outcome.status).toBe(expectedStatus);
      expect(stopCount).toBe(2);
      expect(process.listeners("SIGTERM")).toEqual([...existingSignalListeners]);
    },
  );

  test("starts a new backend cleanup attempt after the previous one times out", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.stalledPath = "/driverInstance/nextCommand";
    const existingSignalListeners = new Set(process.listeners("SIGTERM"));
    const firstStopAborted = Promise.withResolvers<void>();
    const backend = createBackend();
    const stopSignals: AbortSignal[] = [];
    let stopCount = 0;
    backend.stop = async (_context, _reason, signal) => {
      stopCount += 1;
      stopSignals.push(signal);

      if (stopCount === 1) {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              firstStopAborted.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
    };
    const nativeSetTimeout = globalThis.setTimeout;
    const acceleratedSetTimeout = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => nativeSetTimeout(callback, delay === 5_000 ? 10 : delay, ...args);
    globalThis.setTimeout = acceleratedSetTimeout as typeof setTimeout;

    try {
      const run = new DriverProcess(driverBootPayload, () => backend).run();
      await RpcWebSocket.stalled.promise;
      const shutdown = process
        .listeners("SIGTERM")
        .find((listener) => !existingSignalListeners.has(listener));
      expect(shutdown).toBeDefined();
      shutdown?.("SIGTERM");

      await expect(run).resolves.toBeUndefined();
      await firstStopAborted.promise;
      expect(stopCount).toBe(2);
      expect(stopSignals[0]?.aborted).toBe(true);
      expect(stopSignals[1]).not.toBe(stopSignals[0]);
      expect(stopSignals[1]?.aborted).toBe(false);
      expect(process.listeners("SIGTERM")).toEqual([...existingSignalListeners]);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("retries a shutdown failure joined by process finalization", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.stalledPath = "/driverInstance/nextCommand";
    const existingSignalListeners = new Set(process.listeners("SIGTERM"));
    const firstStopEntered = Promise.withResolvers<void>();
    const releaseFirstStop = Promise.withResolvers<void>();
    const backend = createBackend();
    let stopCount = 0;
    backend.stop = async () => {
      stopCount += 1;

      if (stopCount === 1) {
        firstStopEntered.resolve();
        await releaseFirstStop.promise;
        throw new Error("cleanup failed");
      }
    };
    const run = new DriverProcess(driverBootPayload, () => backend).run();

    await RpcWebSocket.stalled.promise;
    const shutdown = process
      .listeners("SIGTERM")
      .find((listener) => !existingSignalListeners.has(listener));
    expect(shutdown).toBeDefined();
    shutdown?.("SIGTERM");
    await firstStopEntered.promise;
    await Bun.sleep(10);
    expect(stopCount).toBe(1);
    releaseFirstStop.resolve();

    const outcome = await settlePromiseWithTimeout(run, {
      label: "driver process joined cleanup retry",
      timeoutMs: 1_000,
    });

    expect(outcome.status).toBe("completed");
    expect(stopCount).toBe(2);
    expect(process.listeners("SIGTERM")).toEqual([...existingSignalListeners]);
  });

  test.each([
    ["transient", 1],
    ["persistent", Number.POSITIVE_INFINITY],
  ] as const)(
    "bounds and retries %s cleanup after backend startup fails",
    async (_name, cleanupFailures) => {
      globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
      const existingSignalListeners = new Set(process.listeners("SIGTERM"));
      const backend = createBackend();
      let stopCount = 0;
      backend.start = async () => {
        throw new Error("startup failed");
      };
      backend.stop = async () => {
        stopCount += 1;

        if (stopCount <= cleanupFailures) {
          throw new Error("cleanup failed");
        }
      };

      const outcome = await settlePromiseWithTimeout(
        new DriverProcess(driverBootPayload, () => backend).run(),
        {
          label: "driver process startup failure cleanup",
          timeoutMs: 1_000,
        },
      );

      expect(outcome).toMatchObject({
        error: { message: "startup failed" },
        status: "failed",
      });
      expect(stopCount).toBe(2);
      expect(process.listeners("SIGTERM")).toEqual([...existingSignalListeners]);
    },
  );
});
