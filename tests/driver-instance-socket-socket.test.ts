import { afterEach, describe, expect, test } from "bun:test";

import { DriverInstanceSocket } from "../src/infrastructure/runtime/driver-instance-socket";
import type { DriverEventInput } from "../src/protocol/events";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

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
  static nextCommand: unknown = null;
  static receiptOverride: Partial<{ eventId: string; seq: number; type: string }> | null = null;
  static responseOverrides = new Map<string, unknown>();
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
      output = { command: RpcWebSocket.nextCommand };
    } else {
      output = { ok: true };
    }

    if (RpcWebSocket.responseOverrides.has(path)) {
      output = RpcWebSocket.responseOverrides.get(path);
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

const connectRpcSocket = async () => {
  globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
  const socket = new DriverInstanceSocket(driverBootPayload, {
    onClose: () => {},
  });
  await socket.connect();
  return socket;
};

afterEach(() => {
  globalThis.WebSocket = nativeWebSocket;
  AbortSignal.timeout = nativeAbortSignalTimeout;
  PendingWebSocket.instances.length = 0;
  RpcWebSocket.acceptedEventCounts = [];
  RpcWebSocket.eventBatchMaxSize = 2;
  RpcWebSocket.heartbeatFails = false;
  RpcWebSocket.heartbeatIntervalMs = 1_000;
  RpcWebSocket.lostResponsePath = null;
  RpcWebSocket.nextCommand = null;
  RpcWebSocket.receiptOverride = null;
  RpcWebSocket.responseOverrides.clear();
  RpcWebSocket.sendFailurePath = null;
  RpcWebSocket.stalledPath = null;
  RpcWebSocket.stalled = Promise.withResolvers<void>();
});

describe("DriverInstanceSocket lifecycle", () => {
  test.each([
    [
      "malformed",
      {
        commandId: "command-1",
        input: { text: "hello" },
        kind: "input.start",
        requestId: "request-1",
      },
      "runId must be a non-empty string",
    ],
    ["unknown", { commandId: "command-1", kind: "unknown" }, "Unsupported runtime command kind"],
  ] as const)("rejects a %s command from the wire", async (_name, command, message) => {
    RpcWebSocket.nextCommand = command;
    const socket = await connectRpcSocket();

    await expect(socket.nextCommand(new AbortController().signal)).rejects.toThrow(message);
  });

  test("returns an empty poll after the next-command deadline and remains reusable", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.stalledPath = "/driverInstance/nextCommand";
    let deadline = new AbortController();
    AbortSignal.timeout = () => deadline.signal;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    const shutdown = new AbortController();

    const poll = socket.nextCommand(shutdown.signal);
    await RpcWebSocket.stalled.promise;
    deadline.abort(new Error("test RPC timeout"));

    await expect(poll).resolves.toBeNull();
    expect(shutdown.signal.aborted).toBeFalse();
    expect(PendingWebSocket.instances[0]?.readyState).toBe(1);

    deadline = new AbortController();
    RpcWebSocket.stalledPath = null;
    await expect(socket.nextCommand(shutdown.signal)).resolves.toBeNull();
    expect(
      (PendingWebSocket.instances[0] as RpcWebSocket).paths.filter(
        (path) => path === "/driverInstance/nextCommand",
      ),
    ).toHaveLength(2);
  });

  test("shutdown immediately aborts a stalled next-command poll before its deadline", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.stalledPath = "/driverInstance/nextCommand";
    AbortSignal.timeout = () => new AbortController().signal;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    const shutdown = new AbortController();
    const reason = new Error("test shutdown");

    const poll = socket.nextCommand(shutdown.signal);
    await RpcWebSocket.stalled.promise;
    shutdown.abort(reason);

    await expect(poll).rejects.toBe(reason);
  });

  test("peer close immediately aborts a stalled next-command poll before its deadline", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.stalledPath = "/driverInstance/nextCommand";
    AbortSignal.timeout = () => new AbortController().signal;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();

    const poll = socket.nextCommand(new AbortController().signal);
    await RpcWebSocket.stalled.promise;
    (PendingWebSocket.instances[0] as RpcWebSocket).close(1006, "test connection lost");

    await expect(poll).rejects.toThrow("test connection lost");
  });

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

  test("bounds close reasons at a complete UTF-8 character", async () => {
    globalThis.WebSocket = OpenWebSocket as unknown as typeof WebSocket;
    const socket = new DriverInstanceSocket(driverBootPayload, {
      onClose: () => {},
    });
    await socket.connect();
    const reason = `${"x".repeat(121)}🙂diagnostic detail`;
    const heartbeat = socket.heartbeat({
      at: new Date(0).toISOString(),
      reason: "interval",
    });
    await Promise.resolve();

    socket.close(1000, reason);

    await expect(heartbeat).rejects.toThrow(reason);
    const closeReason = PendingWebSocket.instances[0]?.closeReason;
    expect(closeReason).toBe("x".repeat(121));
    expect(Buffer.byteLength(closeReason ?? "", "utf8")).toBeLessThanOrEqual(123);
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
    firstWire.dispatchEvent(new CloseEvent("close", { code: 1006, reason: "connection lost" }));

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
    firstWire.dispatchEvent(new CloseEvent("close", { code: 1006, reason: "connection lost" }));
    await socket.connect();
    await socket.hello(helloInput);

    firstWire.dispatchEvent(new CloseEvent("close", { code: 1006, reason: "stale close" }));

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

  test("keeps durable effect settlement independent from aborted ordinary RPCs", async () => {
    const socket = await connectRpcSocket();
    socket.abortPendingRequests("test shutdown");
    const signal = new AbortController().signal;

    await expect(
      socket.completeExternalToolEffect(
        {
          commandId: "effect-command",
          result: {
            outputText: "done",
            requestId: "effect-request",
            serverId: "effect-server",
            toolName: "lookup",
          },
        },
        signal,
      ),
    ).resolves.toBeUndefined();
    await expect(
      socket.markExternalToolEffectUnknown({ commandId: "unknown-command" }, signal),
    ).resolves.toBeUndefined();

    expect((PendingWebSocket.instances[0] as RpcWebSocket).paths).toEqual([
      "/driver/completeExternalToolEffect",
      "/driver/markExternalToolEffectUnknown",
    ]);
  });

  test("validates control-plane responses before returning them", async () => {
    const socket = await connectRpcSocket();
    const signal = new AbortController().signal;

    RpcWebSocket.responseOverrides.set("/driver/heartbeat", {
      heartbeatCount: 1,
      ok: false,
    });
    await expect(
      socket.heartbeat({ at: new Date(0).toISOString(), reason: "interval" }),
    ).rejects.toThrow("expected true");

    RpcWebSocket.responseOverrides.set("/driver/ready", { ok: false });
    await expect(socket.ready({ at: new Date(0).toISOString() })).rejects.toThrow("expected true");

    RpcWebSocket.responseOverrides.set("/driver/claimExternalToolEffect", {
      attempt: 0,
      effectId: "effect-1",
      idempotencyKey: "effect-1",
      kind: "execute",
    });
    await expect(
      socket.claimExternalToolEffect({ commandId: "command-1" }, signal),
    ).rejects.toThrow("attempt must be a positive safe integer");
  });

  test("marks a run terminal delivered only after validating its response", async () => {
    const socket = await connectRpcSocket();
    socket.beginRun(DRIVER_TEST_IDS.runId);
    RpcWebSocket.responseOverrides.set("/driver/completeRun", { ok: false });

    await expect(socket.completeRun()).rejects.toThrow("expected true");
    RpcWebSocket.responseOverrides.delete("/driver/completeRun");
    await expect(socket.completeRun()).resolves.toBeUndefined();

    expect(
      (PendingWebSocket.instances[0] as RpcWebSocket).paths.filter(
        (path) => path === "/driver/completeRun",
      ),
    ).toHaveLength(2);
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
    const socket = await connectRpcSocket();
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
  ] as const)(
    "retries a failed %s send without changing the selected terminal",
    async (selected, sent, skipped) => {
      const socket = await connectRpcSocket();
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
    },
  );

  test.each([
    ["completeRun", "/driver/completeRun"],
    ["failRun", "/driver/failRun"],
  ] as const)(
    "shares an in-flight %s task and retries after a lost response",
    async (selected, path) => {
      const socket = await connectRpcSocket();
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
    },
  );

  test("freezes a failed run payload across failed delivery attempts", async () => {
    const socket = await connectRpcSocket();
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

  test("rejects event receipts that are not a submitted-prefix", async () => {
    const socket = await connectRpcSocket();
    await socket.hello({
      capabilities: [],
      driverVersion: "test",
      protocolVersion: driverBootPayload.protocolVersion,
      startedAt: new Date(0).toISOString(),
    });
    RpcWebSocket.responseOverrides.set("/driver/pushEvents", {
      accepted: [
        { seq: 1, type: "message.completed" },
        { seq: 2, type: "message.completed" },
      ],
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
    ).rejects.toThrow("receipt count exceeds");
  });

  test("splits event delivery at the negotiated batch limit", async () => {
    const socket = await connectRpcSocket();
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
    const socket = await connectRpcSocket();
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

  test("linearizes each run at one fully acknowledged final terminal", async () => {
    RpcWebSocket.eventBatchMaxSize = 2;
    const socket = await connectRpcSocket();
    await socket.hello({
      capabilities: [],
      driverVersion: "test",
      protocolVersion: driverBootPayload.protocolVersion,
      startedAt: new Date(0).toISOString(),
    });
    socket.beginRun(DRIVER_TEST_IDS.runId);
    const delta: DriverEventInput = {
      kind: "message.delta",
      payload: { contentDelta: "x", messageId: "message-1", role: "agent" },
    };
    const completed: DriverEventInput = {
      kind: "run.completed",
      payload: { stopReason: "end_turn" },
    };

    await expect(socket.pushEvents({ events: [completed, delta] })).rejects.toThrow(
      "must be the final event",
    );
    await expect(
      socket.pushEvents({
        events: [
          completed,
          {
            kind: "run.failed",
            payload: { error: { code: "failed", message: "failed", retryable: false } },
          },
        ],
      }),
    ).rejects.toThrow("multiple run terminals");
    await expect(
      socket.pushEvents({ events: [{ ...completed, delivery: "best_effort" }] }),
    ).rejects.toThrow("must use lossless delivery");
    expect(socket.runEventTerminal(DRIVER_TEST_IDS.runId)).toBeNull();

    RpcWebSocket.acceptedEventCounts = [1, 0];
    await expect(socket.pushEvents({ events: [delta, completed] })).rejects.toThrow("no progress");
    expect(socket.runEventTerminal(DRIVER_TEST_IDS.runId)).toBeNull();
    expect(socket.selectedRunEventTerminal(DRIVER_TEST_IDS.runId)).toBe("completed");

    await expect(socket.pushEvents({ events: [completed] })).resolves.toMatchObject({
      accepted: [{ type: "run.completed" }],
    });
    expect(socket.runEventTerminal(DRIVER_TEST_IDS.runId)).toBe("completed");
    await expect(socket.pushEvents({ events: [delta] })).rejects.toThrow(
      "cannot target a terminated run",
    );
    await expect(socket.pushEvents({ events: [{ ...delta, runId: null }] })).resolves.toMatchObject(
      { accepted: [{ type: "message.delta" }] },
    );
    await expect(
      socket.pushEvents({ events: [{ ...delta, runId: DRIVER_TEST_IDS.secondRunId }] }),
    ).rejects.toThrow("must target the active run");
  });

  test("does not replace an active run or discard its terminal state", async () => {
    const socket = await connectRpcSocket();
    await socket.hello({
      capabilities: [],
      driverVersion: "test",
      protocolVersion: driverBootPayload.protocolVersion,
      startedAt: new Date(0).toISOString(),
    });
    socket.beginRun(DRIVER_TEST_IDS.runId);
    await socket.pushEvents({
      events: [{ kind: "run.completed", payload: { stopReason: "end_turn" } }],
    });

    expect(() => socket.beginRun(DRIVER_TEST_IDS.secondRunId)).toThrow("another run is active");
    expect(socket.currentRunId()).toBe(DRIVER_TEST_IDS.runId);
    expect(socket.runEventTerminal(DRIVER_TEST_IDS.runId)).toBe("completed");

    socket.endRun(DRIVER_TEST_IDS.runId);
    socket.beginRun(DRIVER_TEST_IDS.secondRunId);
    expect(socket.currentRunId()).toBe(DRIVER_TEST_IDS.secondRunId);
    expect(socket.runEventTerminal(DRIVER_TEST_IDS.runId)).toBeNull();
  });

  test("reserves a terminal before its RPC and serializes the matching control terminal", async () => {
    const socket = await connectRpcSocket();
    await socket.hello({
      capabilities: [],
      driverVersion: "test",
      protocolVersion: driverBootPayload.protocolVersion,
      startedAt: new Date(0).toISOString(),
    });
    socket.beginRun(DRIVER_TEST_IDS.runId);
    RpcWebSocket.stalledPath = "/driver/pushEvents";
    const completed: DriverEventInput = {
      kind: "run.completed",
      payload: { stopReason: "end_turn" },
    };
    const failed: DriverEventInput = {
      kind: "run.failed",
      payload: { error: { code: "failed", message: "failed", retryable: false } },
    };
    const failure = {
      code: "failed",
      details: {},
      message: "failed",
      retryable: false,
    };

    const eventTerminal = socket.pushEvents({ events: [completed] });
    await RpcWebSocket.stalled.promise;
    expect(socket.selectedRunEventTerminal(DRIVER_TEST_IDS.runId)).toBe("completed");
    expect(socket.runEventTerminal(DRIVER_TEST_IDS.runId)).toBeNull();
    await expect(socket.pushEvents({ events: [failed] })).rejects.toThrow(
      "cannot target a terminated run",
    );
    const matchingControl = socket.completeRun();
    const eventTerminalOutcome = eventTerminal.then(
      () => null,
      (error: unknown) => error,
    );
    const matchingControlOutcome = matchingControl.then(
      () => null,
      (error: unknown) => error,
    );
    await expect(socket.failRun(failure)).resolves.toBeUndefined();
    await Bun.sleep(0);

    const firstWire = PendingWebSocket.instances[0] as RpcWebSocket;
    expect(firstWire.paths.filter((path) => path !== "/driver/hello")).toEqual([
      "/driver/pushEvents",
    ]);
    firstWire.close(1006, "terminal response lost");
    const eventTerminalError = await eventTerminalOutcome;
    const matchingControlError = await matchingControlOutcome;
    expect(eventTerminalError).toBeInstanceOf(Error);
    expect(matchingControlError).toBeInstanceOf(Error);
    expect(matchingControlError as Error).toHaveProperty(
      "message",
      expect.stringContaining("connection changed"),
    );
    expect(socket.runEventTerminal(DRIVER_TEST_IDS.runId)).toBeNull();

    await socket.connect();
    await socket.hello({
      capabilities: [],
      driverVersion: "test",
      protocolVersion: driverBootPayload.protocolVersion,
      startedAt: new Date(0).toISOString(),
    });
    await expect(socket.pushEvents({ events: [failed] })).rejects.toThrow(
      "cannot target a terminated run",
    );
    expect((PendingWebSocket.instances[1] as RpcWebSocket).paths).toEqual(["/driver/hello"]);
  });

  test.each([
    ["completeRun", "/driver/completeRun"],
    ["failRun", "/driver/failRun"],
  ] as const)("does not begin another run after an in-flight %s", async (selected, path) => {
    const socket = await connectRpcSocket();
    socket.beginRun(DRIVER_TEST_IDS.runId);
    const failure = {
      code: "test.failure",
      details: {},
      message: "failed",
      retryable: false,
    };
    RpcWebSocket.lostResponsePath = path;
    const terminal = selected === "completeRun" ? socket.completeRun() : socket.failRun(failure);
    await RpcWebSocket.stalled.promise;

    socket.endRun(DRIVER_TEST_IDS.runId);
    expect(() => socket.beginRun(DRIVER_TEST_IDS.secondRunId)).toThrow(
      "control terminal has been selected",
    );
    expect(socket.currentRunId()).toBeNull();
    expect(selected === "completeRun" ? socket.completeRun() : socket.failRun(failure)).toBe(
      terminal,
    );
    await expect(
      selected === "completeRun" ? socket.failRun(failure) : socket.completeRun(),
    ).resolves.toBeUndefined();

    (PendingWebSocket.instances[0] as RpcWebSocket).close(1006, "terminal response lost");
    await expect(terminal).rejects.toThrow("terminal response lost");
    expect(() => socket.beginRun(DRIVER_TEST_IDS.secondRunId)).toThrow(
      "control terminal has been selected",
    );
  });

  test("does not redirect a queued run event after the active run ends", async () => {
    const socket = await connectRpcSocket();
    await socket.hello({
      capabilities: [],
      driverVersion: "test",
      protocolVersion: driverBootPayload.protocolVersion,
      startedAt: new Date(0).toISOString(),
    });
    socket.beginRun(DRIVER_TEST_IDS.runId);
    RpcWebSocket.stalledPath = "/driver/pushEvents";
    const controller = new AbortController();
    const blocker = socket.pushEvents({
      events: [
        {
          kind: "diagnostic.reported",
          payload: { code: "queue.blocker", message: "block", severity: "info" },
          runId: null,
        },
      ],
      signal: controller.signal,
    });
    await RpcWebSocket.stalled.promise;
    const queuedTerminal = socket.pushEvents({
      events: [{ kind: "run.completed", payload: { stopReason: "end_turn" } }],
    });
    const queuedOutcome = queuedTerminal.then(
      () => null,
      (error: unknown) => error,
    );

    socket.endRun(DRIVER_TEST_IDS.runId);
    socket.beginRun(DRIVER_TEST_IDS.secondRunId);
    controller.abort(new Error("release old run"));
    await expect(blocker).rejects.toThrow();
    const queuedError = await queuedOutcome;
    expect(queuedError).toBeInstanceOf(Error);
    expect(queuedError as Error).toHaveProperty(
      "message",
      expect.stringContaining("active run changed"),
    );
    expect(socket.runEventTerminal(DRIVER_TEST_IDS.runId)).toBeNull();
    expect(
      (PendingWebSocket.instances[0] as RpcWebSocket).paths.filter(
        (path) => path === "/driver/pushEvents",
      ),
    ).toHaveLength(1);

    RpcWebSocket.stalledPath = null;
    await expect(
      socket.pushEvents({
        events: [
          {
            kind: "message.delta",
            payload: { contentDelta: "new", messageId: "message-2", role: "agent" },
          },
        ],
      }),
    ).resolves.toMatchObject({ accepted: [{ type: "message.delta" }] });
  });

  test("does not send a queued control terminal after its run ends", async () => {
    const socket = await connectRpcSocket();
    await socket.hello({
      capabilities: [],
      driverVersion: "test",
      protocolVersion: driverBootPayload.protocolVersion,
      startedAt: new Date(0).toISOString(),
    });
    socket.beginRun(DRIVER_TEST_IDS.runId);
    RpcWebSocket.stalledPath = "/driver/pushEvents";
    const controller = new AbortController();
    const blocker = socket.pushEvents({
      events: [
        {
          kind: "diagnostic.reported",
          payload: { code: "queue.blocker", message: "block", severity: "info" },
          runId: null,
        },
      ],
      signal: controller.signal,
    });
    await RpcWebSocket.stalled.promise;
    const oldTerminal = socket.completeRun();

    socket.endRun(DRIVER_TEST_IDS.runId);
    expect(() => socket.beginRun(DRIVER_TEST_IDS.secondRunId)).toThrow(
      "control terminal has been selected",
    );
    controller.abort(new Error("release old run"));

    await expect(blocker).rejects.toThrow();
    await expect(oldTerminal).rejects.toThrow("active run changed");
    const paths = (PendingWebSocket.instances[0] as RpcWebSocket).paths;
    expect(paths.filter((path) => path === "/driver/pushEvents")).toHaveLength(1);
    expect(paths).not.toContain("/driver/completeRun");
    expect(socket.currentRunId()).toBeNull();
  });

  test("does not retry an unaccepted best-effort suffix", async () => {
    RpcWebSocket.eventBatchMaxSize = 2;
    RpcWebSocket.acceptedEventCounts = [1];
    const socket = await connectRpcSocket();
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
    const socket = await connectRpcSocket();
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
});
