import { afterEach, describe, expect, test } from "bun:test";

import { DriverProcess } from "../src/core/driver-process";
import { DriverInstanceSocket } from "../src/infrastructure/runtime/driver-instance-socket";
import type { AgentDriverContext } from "../src/runtimes/agent-driver-backend";
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

    if (path === RpcWebSocket.sendFailurePath) {
      RpcWebSocket.sendFailurePath = null;
      throw new Error("test wire send failed");
    }

    const input = request.p.b?.json;
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
  RpcWebSocket.receiptOverride = null;
  RpcWebSocket.sendFailurePath = null;
  RpcWebSocket.stalledPath = null;
  RpcWebSocket.stalled = Promise.withResolvers<void>();
});

describe("DriverInstanceSocket lifecycle", () => {
  test("abortConnect closes and rejects an in-flight dial", async () => {
    globalThis.WebSocket = PendingWebSocket as unknown as typeof WebSocket;
    let closeNotifications = 0;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {
        closeNotifications += 1;
      },
    });

    const connection = socket.connect();
    socket.abortConnect("test shutdown");

    await expect(connection).rejects.toThrow("test shutdown");
    expect(PendingWebSocket.instances).toHaveLength(1);
    expect(PendingWebSocket.instances[0]?.closeReason).toBe("runtime.dial.cancelled");
    expect(closeNotifications).toBe(0);
  });

  test("cancels an RPC that does not answer", async () => {
    globalThis.WebSocket = OpenWebSocket as unknown as typeof WebSocket;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    AbortSignal.timeout = () => AbortSignal.abort(new Error("test RPC timeout"));

    await expect(
      socket.heartbeat({
        at: new Date(0).toISOString(),
        reason: "interval",
      }),
    ).rejects.toThrow("test RPC timeout");
  });

  test("close settles an in-flight RPC and rejects later calls", async () => {
    globalThis.WebSocket = OpenWebSocket as unknown as typeof WebSocket;
    const closeNotifications: [number, string][] = [];
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: (code, reason) => closeNotifications.push([code, reason]),
    });
    await socket.connect();
    const heartbeat = socket.heartbeat({
      at: new Date(0).toISOString(),
      reason: "interval",
    });
    await Promise.resolve();

    socket.close(1000, "test shutdown");
    socket.close(1000, "duplicate shutdown");

    const result = await settlePromiseWithTimeout(heartbeat, {
      label: "in-flight socket RPC",
      timeoutMs: 100,
    });
    expect(result.status).toBe("failed");
    await expect(
      socket.heartbeat({ at: new Date(0).toISOString(), reason: "interval" }),
    ).rejects.toThrow("not connected");
    expect(closeNotifications).toEqual([[1000, "test shutdown"]]);
  });

  test("requires a fresh hello after reconnecting", async () => {
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
    const firstWire = PendingWebSocket.instances[0]!;
    firstWire.dispatchEvent(
      new CloseEvent("close", { code: 1006, reason: "connection lost" }),
    );

    await socket.connect();

    await expect(
      socket.pushEvents({
        events: [
          {
            kind: "message.completed",
            payload: { messageId: "message-1", stopReason: "end_turn" },
          },
        ],
      }),
    ).rejects.toThrow("hello must complete");
  });

  test("ignores a stale close after the new connection completes hello", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    const closeNotifications: [number, string][] = [];
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: (code, reason) => closeNotifications.push([code, reason]),
    });
    const helloInput = {
      capabilities: [],
      driverVersion: "test",
      protocolVersion: driverBootPayload.protocolVersion,
      startedAt: new Date(0).toISOString(),
    };
    await socket.connect();
    await socket.hello(helloInput);
    const firstWire = PendingWebSocket.instances[0]!;
    firstWire.dispatchEvent(
      new CloseEvent("close", { code: 1006, reason: "connection lost" }),
    );
    await socket.connect();
    await socket.hello(helloInput);

    firstWire.dispatchEvent(
      new CloseEvent("close", { code: 1006, reason: "stale close" }),
    );

    await expect(
      socket.heartbeat({ at: new Date(0).toISOString(), reason: "interval" }),
    ).resolves.toEqual({ heartbeatCount: 1, ok: true });
    expect(closeNotifications).toEqual([[1006, "connection lost"]]);
  });

  test("aborts an in-flight RPC without closing the socket", async () => {
    globalThis.WebSocket = OpenWebSocket as unknown as typeof WebSocket;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    const first = socket.heartbeat({
      at: new Date(0).toISOString(),
      reason: "interval",
    });
    await Promise.resolve();

    socket.abortPendingRequests("test shutdown");
    await expect(first).rejects.toThrow("test shutdown");
    expect(PendingWebSocket.instances[0]?.readyState).toBe(1);
    socket.close();
  });

  test("uses the terminal-attempt signal to abort only that command update", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.stalledPath = "/driver/commandUpdate";
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    const controller = new AbortController();
    const reason = new Error("terminal attempt elapsed");
    const update = socket.commandUpdate(
      {
        commandId: "command-1",
        status: "completed",
      },
      controller.signal,
    );

    await RpcWebSocket.stalled.promise;
    controller.abort(reason);
    const failure = await update.then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBe(reason);
    await expect(
      socket.heartbeat({ at: new Date(0).toISOString(), reason: "interval" }),
    ).resolves.toEqual({ heartbeatCount: 1, ok: true });
  });

  test.each([
    ["completeRun", "/driver/completeRun", "/driver/failRun"],
    ["failRun", "/driver/failRun", "/driver/completeRun"],
  ] as const)("keeps a claimed %s run terminal monotonic", async (first, sent, skipped) => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    socket.beginRun(DRIVER_TEST_IDS.runId);
    const failure = {
      code: "test.failure",
      details: {},
      message: "failed",
      retryable: false,
    };

    if (first === "completeRun") {
      await socket.completeRun();
      await socket.failRun(failure);
    } else {
      await socket.failRun(failure);
      await socket.completeRun();
    }

    const paths = (PendingWebSocket.instances[0] as RpcWebSocket).paths;
    expect(paths.filter((path) => path === sent)).toHaveLength(1);
    expect(paths).not.toContain(skipped);
  });

  test.each([
    ["completeRun", "/driver/completeRun", "/driver/failRun"],
    ["failRun", "/driver/failRun", "/driver/completeRun"],
  ] as const)("retries a failed %s send without changing the selected terminal", async (
    selected,
    sent,
    skipped,
  ) => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    socket.beginRun(DRIVER_TEST_IDS.runId);
    const failure = {
      code: "test.failure",
      details: {},
      message: "failed",
      retryable: false,
    };
    const deliver = () =>
      selected === "completeRun" ? socket.completeRun() : socket.failRun(failure);
    const deliverOpposite = () =>
      selected === "completeRun" ? socket.failRun(failure) : socket.completeRun();
    RpcWebSocket.sendFailurePath = sent;

    await expect(deliver()).rejects.toThrow("test wire send failed");
    await expect(deliverOpposite()).resolves.toBeUndefined();
    await expect(deliver()).resolves.toBeUndefined();
    await expect(deliver()).resolves.toBeUndefined();

    const paths = (PendingWebSocket.instances[0] as RpcWebSocket).paths;
    expect(paths.filter((path) => path === sent)).toHaveLength(2);
    expect(paths).not.toContain(skipped);
  });

  test.each([
    ["completeRun", "/driver/completeRun"],
    ["failRun", "/driver/failRun"],
  ] as const)("shares an in-flight %s task and retries after a lost response", async (
    selected,
    path,
  ) => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    socket.beginRun(DRIVER_TEST_IDS.runId);
    const failure = {
      code: "test.failure",
      details: {},
      message: "failed",
      retryable: false,
    };
    const deliver = (signal?: AbortSignal) =>
      selected === "completeRun" ? socket.completeRun(signal) : socket.failRun(failure, signal);
    const controller = new AbortController();
    const reason = new Error("run terminal response lost");
    RpcWebSocket.lostResponsePath = path;

    const first = deliver(controller.signal);
    await RpcWebSocket.stalled.promise;
    const concurrent = deliver();

    expect(concurrent).toBe(first);
    expect((PendingWebSocket.instances[0] as RpcWebSocket).paths).toEqual([path]);

    controller.abort(reason);
    await expect(first).rejects.toBe(reason);
    await expect(concurrent).rejects.toBe(reason);
    await expect(deliver()).resolves.toBeUndefined();

    expect((PendingWebSocket.instances[0] as RpcWebSocket).paths).toEqual([path, path]);
  });

  test("freezes a failed run payload across failed delivery attempts", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    socket.beginRun(DRIVER_TEST_IDS.runId);
    const failure = {
      code: "test.failure",
      details: { attempt: "selected" },
      message: "selected failure",
      retryable: false,
    };
    const selected = structuredClone(failure);
    RpcWebSocket.sendFailurePath = "/driver/failRun";

    const first = socket.failRun(failure);
    failure.details.attempt = "mutated";
    failure.message = "mutated failure";

    await expect(first).rejects.toThrow("test wire send failed");
    await expect(socket.failRun(failure)).rejects.toThrow("different error");
    await expect(socket.failRun(selected)).resolves.toBeUndefined();
    await expect(socket.failRun(selected)).resolves.toBeUndefined();

    const wire = PendingWebSocket.instances[0] as RpcWebSocket;
    expect(wire.paths.filter((path) => path === "/driver/failRun")).toHaveLength(2);
    expect(wire.requests.find(({ path }) => path === "/driver/failRun")).toEqual({
      input: {
        driverInstanceId: DRIVER_TEST_IDS.driverInstanceId,
        error: selected,
      },
      path: "/driver/failRun",
    });
  });

  test.each([
    ["completeRun", "/driver/completeRun"],
    ["failRun", "/driver/failRun"],
  ] as const)("retries a selected %s terminal after reconnecting", async (selected, path) => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    socket.beginRun(DRIVER_TEST_IDS.runId);
    const failure = {
      code: "test.failure",
      details: {},
      message: "failed",
      retryable: false,
    };
    const deliver = () =>
      selected === "completeRun" ? socket.completeRun() : socket.failRun(failure);
    const firstWire = PendingWebSocket.instances[0] as RpcWebSocket;
    RpcWebSocket.lostResponsePath = path;

    const first = deliver();
    await RpcWebSocket.stalled.promise;
    firstWire.close(1006, "test connection lost");

    await expect(first).rejects.toThrow("test connection lost");
    await socket.connect();
    await expect(deliver()).resolves.toBeUndefined();

    const secondWire = PendingWebSocket.instances[1] as RpcWebSocket;
    expect(firstWire.paths.filter((sent) => sent === path)).toHaveLength(1);
    expect(secondWire.paths.filter((sent) => sent === path)).toHaveLength(1);
  });

  test("splits event delivery at the negotiated batch limit", async () => {
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
    socket.beginRun(DRIVER_TEST_IDS.runId);
    let timeoutSignals = 0;
    AbortSignal.timeout = () => {
      timeoutSignals += 1;
      return new AbortController().signal;
    };

    const result = await socket.pushEvents({
      events: Array.from({ length: 5 }, (_, index) => ({
        delivery: "best_effort" as const,
        kind: "message.delta" as const,
        payload: {
          contentDelta: String(index),
          messageId: "message-1",
          role: "agent" as const,
        },
      })),
    });
    const wire = PendingWebSocket.instances[0] as RpcWebSocket;

    expect(wire.eventBatchSizes).toEqual([2, 2, 1]);
    expect(result.accepted).toHaveLength(5);
    expect(timeoutSignals).toBe(1);
  });

  test("drains a partially accepted event batch before returning", async () => {
    RpcWebSocket.eventBatchMaxSize = 3;
    RpcWebSocket.acceptedEventCounts = [1, 2];
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
    socket.beginRun(DRIVER_TEST_IDS.runId);

    const result = await socket.pushEvents({
      events: ["started", "one", "two"].map((messageId) => ({
        kind: "message.completed" as const,
        payload: {
          messageId,
          stopReason: "end_turn",
        },
      })),
    });
    const wire = PendingWebSocket.instances[0] as RpcWebSocket;

    expect(wire.eventBatchSizes).toEqual([3, 2]);
    expect(result.accepted).toHaveLength(3);
  });

  test("does not retry an unaccepted best-effort suffix", async () => {
    RpcWebSocket.eventBatchMaxSize = 2;
    RpcWebSocket.acceptedEventCounts = [1];
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

    const result = await socket.pushEvents({
      events: ["one", "two", "three", "four", "five"].map((contentDelta) => ({
        delivery: "best_effort" as const,
        kind: "message.delta" as const,
        payload: {
          contentDelta,
          messageId: "message-1",
          role: "agent" as const,
        },
      })),
    });
    const wire = PendingWebSocket.instances[0] as RpcWebSocket;

    expect(wire.eventBatchSizes).toEqual([2]);
    expect(result.accepted).toHaveLength(1);
  });

  test("rejects a mixed delivery batch before sending it", async () => {
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
            delivery: "best_effort",
            kind: "message.delta",
            payload: { contentDelta: "draft", messageId: "message-1", role: "agent" },
          },
          {
            kind: "message.completed",
            payload: { messageId: "message-1", stopReason: "end_turn" },
          },
        ],
      }),
    ).rejects.toThrow("cannot mix");
    expect((PendingWebSocket.instances[0] as RpcWebSocket).eventBatchSizes).toEqual([]);
  });

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
    context?.lifecycle.fail(failure);

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

      await (stallBackendStart
        ? backendStartEntered.promise
        : RpcWebSocket.stalled.promise);
      const shutdown = process
        .listeners("SIGTERM")
        .find((listener) => !existingSignalListeners.has(listener));
      expect(shutdown).toBeDefined();
      shutdown?.();

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
    shutdown?.();

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
    globalThis.setTimeout = ((callback, delay, ...args) =>
      nativeSetTimeout(callback, delay === 5_000 ? 10 : delay, ...args)) as typeof setTimeout;

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
      shutdown?.();
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
      shutdown?.();

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
    globalThis.setTimeout = ((callback, delay, ...args) =>
      nativeSetTimeout(callback, delay === 5_000 ? 10 : delay, ...args)) as typeof setTimeout;

    try {
      const run = new DriverProcess(driverBootPayload, () => backend).run();
      await RpcWebSocket.stalled.promise;
      const shutdown = process
        .listeners("SIGTERM")
        .find((listener) => !existingSignalListeners.has(listener));
      expect(shutdown).toBeDefined();
      shutdown?.();

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
    shutdown?.();
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
