import { afterEach, describe, expect, test } from "bun:test";

import { DriverProcess } from "../src/bin/driver-process";
import { DriverInstanceSocket } from "../src/infrastructure/runtime/driver-instance-socket";
import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { DriverTurnCancelledError } from "../src/core/driver-runtime-state";
import type { RuntimeCommand } from "../src/runtime-command";
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
  static commands: RuntimeCommand[] = [];
  static delayedEventKind: string | null = null;
  static delayedResponse = Promise.withResolvers<void>();
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
    const delayResponse =
      path === "/driver/pushEvents" &&
      (
        input as {
          events?: { event?: { kind?: string } }[];
        }
      ).events?.some(({ event }) => event?.kind === RpcWebSocket.delayedEventKind) === true;

    if (delayResponse) {
      RpcWebSocket.stalled.resolve();
    }

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
      output = { command: RpcWebSocket.commands.shift() ?? null };
    } else {
      output = { ok: true };
    }

    const respond = () => {
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
    };

    if (delayResponse) {
      void RpcWebSocket.delayedResponse.promise.then(respond);
    } else {
      queueMicrotask(respond);
    }
  }
}

afterEach(() => {
  globalThis.WebSocket = nativeWebSocket;
  AbortSignal.timeout = nativeAbortSignalTimeout;
  PendingWebSocket.instances.length = 0;
  RpcWebSocket.acceptedEventCounts = [];
  RpcWebSocket.commands = [];
  RpcWebSocket.delayedEventKind = null;
  RpcWebSocket.delayedResponse.resolve();
  RpcWebSocket.delayedResponse = Promise.withResolvers<void>();
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

  test("fails after an unexpected control disconnect and still cleans the backend", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.stalledPath = "/driverInstance/nextCommand";
    const backend = createBackend();
    let cleaned = false;
    backend.stop = async () => {
      cleaned = true;
    };
    const run = new DriverProcess(driverBootPayload, () => backend).run();

    await RpcWebSocket.stalled.promise;
    const socket = PendingWebSocket.instances[0] as RpcWebSocket;
    socket.close(1006, "test control connection lost");

    await expect(run).rejects.toThrow("test control connection lost");
    expect(cleaned).toBe(true);
    expect(socket.readyState).toBe(3);
    expect(socket.paths).not.toContain("/driver/completeRun");
  });

  test("reports an idle backend failure after cleanup and before socket close", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.sendFailurePath = "/driver/failRun";
    RpcWebSocket.stalledPath = "/driverInstance/nextCommand";
    const backend = createBackend();
    const cleanupEntered = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const failure = new Error("provider process exited");
    let cleaned = false;
    let failRunSocketState: number | null = null;
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    backend.stop = async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      cleaned = true;
    };
    RpcWebSocket.pathObserver = (path) => {
      if (path === "/driver/failRun") {
        failRunSocketState = PendingWebSocket.instances[0]?.readyState ?? null;
      }
    };
    const run = new DriverProcess(driverBootPayload, () => backend).run();

    await RpcWebSocket.stalled.promise;
    (context as AgentDriverContext | null)?.lifecycle.fail(failure);
    await cleanupEntered.promise;
    expect((PendingWebSocket.instances[0] as RpcWebSocket).paths).not.toContain("/driver/failRun");
    releaseCleanup.resolve();

    await expect(run).rejects.toBe(failure);
    const socket = PendingWebSocket.instances[0] as RpcWebSocket;
    const paths = socket.paths;
    expect(cleaned).toBe(true);
    expect(failRunSocketState).toBe(1);
    expect(socket.readyState).toBe(3);
    expect(paths.filter((path) => path === "/driver/failRun")).toHaveLength(2);
  });

  test("does not report a control terminal when backend cleanup remains failed", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.stalledPath = "/driverInstance/nextCommand";
    const backend = createBackend();
    const failure = new Error("provider process exited");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    backend.stop = async () => {
      throw new Error("cleanup remained failed");
    };
    const run = new DriverProcess(driverBootPayload, () => backend).run();

    await RpcWebSocket.stalled.promise;
    (context as AgentDriverContext | null)?.lifecycle.fail(failure);
    await expect(run).rejects.toBe(failure);

    const socket = PendingWebSocket.instances[0] as RpcWebSocket;
    expect(socket.paths).not.toContain("/driver/failRun");
    expect(socket.readyState).toBe(3);
  });

  test("settles a pending permission after its ACK outlives the old shutdown grace", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.commands = [
      {
        commandId: "permission-input",
        input: { text: "run a side effect" },
        kind: "input.start",
        requestId: "permission-request",
        runId: DRIVER_TEST_IDS.runId,
      },
    ];
    RpcWebSocket.delayedEventKind = "permission.requested";
    const existingSignalListeners = new Set(process.listeners("SIGTERM"));
    const backend = createBackend();
    let decision: "allow_once" | "reject_once" | null = null;
    let sideEffect = false;
    let stoppedBeforePermissionSettled = false;
    backend.handleInput = async (context) => {
      decision = await context.ports.permission.request({
        rawInput: '{"command":"touch should-not-exist"}',
        requestId: "pending-permission",
        title: "Allow test side effect?",
        toolCallId: "permission-tool",
        toolKind: "test",
      });

      if (decision === "allow_once") {
        sideEffect = true;
        return;
      }

      await context.ports.eventSink.pushEvents({
        events: [
          {
            kind: "run.cancelled",
            payload: {
              reason: "signal.sigterm",
              requestedBy: "user",
              stopReason: "cancelled",
            },
            runId: DRIVER_TEST_IDS.runId,
          },
        ],
      });
    };
    backend.stop = async () => {
      stoppedBeforePermissionSettled = decision === null;
    };
    const payload = {
      ...driverBootPayload,
      execution: {
        ...driverBootPayload.execution,
        permissionPolicy: "supervised" as const,
      },
    };
    const run = new DriverProcess(payload, () => backend).run();
    await RpcWebSocket.stalled.promise;
    const socket = PendingWebSocket.instances[0] as RpcWebSocket;
    const shutdown = process
      .listeners("SIGTERM")
      .find((listener) => !existingSignalListeners.has(listener));
    expect(shutdown).toBeDefined();
    shutdown?.("SIGTERM");
    const delayedAck = Bun.sleep(5_100).then(() => RpcWebSocket.delayedResponse.resolve());

    const outcome = await settlePromiseWithTimeout(run, {
      label: "pending permission signal shutdown",
      timeoutMs: 12_000,
    });
    await delayedAck;
    expect(outcome.status).toBe("completed");
    expect(decision).toBe("reject_once");
    expect(sideEffect).toBe(false);
    expect(stoppedBeforePermissionSettled).toBe(false);

    const requests = socket.requests;
    const pushedEvents = requests.flatMap(({ input, path }) =>
      path === "/driver/pushEvents"
        ? (
            input as {
              events: {
                event: {
                  kind: string;
                  payload: Record<string, unknown>;
                };
              }[];
            }
          ).events.map(({ event }) => event)
        : [],
    );
    expect(
      pushedEvents.filter(({ kind }) =>
        ["permission.requested", "permission.resolved", "run.cancelled"].includes(kind),
      ),
    ).toEqual([
      expect.objectContaining({ kind: "permission.requested" }),
      expect.objectContaining({
        kind: "permission.resolved",
        payload: expect.objectContaining({
          outcome: "reject_once",
          reason: "cancelled",
          requestId: "pending-permission",
        }),
      }),
      expect.objectContaining({ kind: "run.cancelled" }),
    ]);
    expect(
      pushedEvents.filter((event) =>
        ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
      ),
    ).toEqual([expect.objectContaining({ kind: "run.cancelled" })]);

    const inputTerminals = requests
      .filter(({ path }) => path === "/driver/commandUpdate")
      .map(({ input }) => input as { commandId: string; status: string })
      .filter(({ commandId, status }) => commandId === "permission-input" && status !== "accepted");
    expect(inputTerminals).toEqual([
      expect.objectContaining({ commandId: "permission-input", status: "cancelled" }),
    ]);
    expect(socket.paths).not.toContain("/driver/failRun");
    expect(process.listeners("SIGTERM")).toEqual([...existingSignalListeners]);
  }, 15_000);

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

  test.each(["backend", "heartbeat"] as const)(
    "reports %s process failure after the provider cancels the active turn",
    async (failureSource) => {
      globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
      RpcWebSocket.commands = [
        {
          commandId: `${failureSource}-input`,
          input: { text: "wait" },
          kind: "input.start",
          requestId: `${failureSource}-request`,
          runId: DRIVER_TEST_IDS.runId,
        },
      ];
      RpcWebSocket.heartbeatFails = failureSource === "heartbeat";
      RpcWebSocket.heartbeatIntervalMs = 250;
      const inputEntered = Promise.withResolvers<AgentDriverContext>();
      const stopRequested = Promise.withResolvers<void>();
      const backend = createBackend();
      backend.handleInput = async (context, _input, runId) => {
        inputEntered.resolve(context);
        await stopRequested.promise;
        await context.ports.eventSink.pushEvents({
          events: [
            {
              kind: "run.cancelled",
              payload: { requestedBy: "user", stopReason: "cancelled" },
              runId,
            },
          ],
        });
        throw new DriverTurnCancelledError(`${failureSource} shutdown`);
      };
      backend.stop = async () => stopRequested.resolve();
      const run = new DriverProcess(driverBootPayload, () => backend).run();
      const context = await inputEntered.promise;

      if (failureSource === "backend") {
        context.lifecycle.fail(new Error("provider failed"));
      }

      const outcome = await settlePromiseWithTimeout(run, {
        label: `active ${failureSource} failure shutdown`,
        timeoutMs: 2_000,
      });

      expect(outcome.status).toBe("failed");
      const socket = PendingWebSocket.instances[0] as RpcWebSocket;
      const pushedRunTerminals = socket.requests.flatMap(({ input, path }) =>
        path === "/driver/pushEvents"
          ? (
              input as {
                events: { event: { kind: string } }[];
              }
            ).events
              .map(({ event }) => event)
              .filter(({ kind }) => ["run.cancelled", "run.completed", "run.failed"].includes(kind))
          : [],
      );
      expect(pushedRunTerminals).toEqual([expect.objectContaining({ kind: "run.cancelled" })]);
      expect(socket.paths.filter((path) => path === "/driver/failRun")).toHaveLength(1);
    },
  );

  test("completes an active signal shutdown only after provider cleanup", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.lostResponsePath = "/driver/completeRun";
    RpcWebSocket.commands = [
      {
        commandId: "signal-input",
        input: { text: "wait" },
        kind: "input.start",
        requestId: "signal-request",
        runId: DRIVER_TEST_IDS.runId,
      },
    ];
    const existingSignalListeners = new Set(process.listeners("SIGTERM"));
    const inputEntered = Promise.withResolvers<void>();
    const cleanupEntered = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const stopInput = Promise.withResolvers<void>();
    const backend = createBackend();
    let cleaned = false;
    let completeRunSocketState: number | null = null;
    backend.handleInput = async (context, _input, runId) => {
      inputEntered.resolve();
      await stopInput.promise;
      await context.ports.eventSink.pushEvents({
        events: [
          {
            kind: "run.cancelled",
            payload: { requestedBy: "user", stopReason: "cancelled" },
            runId,
          },
        ],
      });
      throw new DriverTurnCancelledError("signal shutdown");
    };
    backend.stop = async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      cleaned = true;
      stopInput.resolve();
    };
    RpcWebSocket.pathObserver = (path) => {
      if (path === "/driver/completeRun") {
        completeRunSocketState = PendingWebSocket.instances[0]?.readyState ?? null;
      }
    };
    const run = new DriverProcess(driverBootPayload, () => backend).run();

    await inputEntered.promise;
    const shutdown = process
      .listeners("SIGTERM")
      .find((listener) => !existingSignalListeners.has(listener));
    expect(shutdown).toBeDefined();
    shutdown?.("SIGTERM");
    await cleanupEntered.promise;
    const socket = PendingWebSocket.instances[0] as RpcWebSocket;
    expect(socket.paths).not.toContain("/driver/completeRun");
    releaseCleanup.resolve();

    await expect(run).resolves.toBeUndefined();
    expect(cleaned).toBe(true);
    expect(completeRunSocketState).toBe(1);
    expect(socket.paths.filter((path) => path === "/driver/completeRun")).toHaveLength(2);
    expect(socket.readyState).toBe(3);
  });

  test("bounds a persistently stalled signal completion before closing", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.commands = [
      {
        commandId: "stalled-signal-input",
        input: { text: "wait" },
        kind: "input.start",
        requestId: "stalled-signal-request",
        runId: DRIVER_TEST_IDS.runId,
      },
    ];
    RpcWebSocket.stalledPath = "/driver/completeRun";
    const existingSignalListeners = new Set(process.listeners("SIGTERM"));
    const inputEntered = Promise.withResolvers<void>();
    const stopInput = Promise.withResolvers<void>();
    const backend = createBackend();
    backend.handleInput = async () => {
      inputEntered.resolve();
      await stopInput.promise;
      throw new DriverTurnCancelledError("signal shutdown");
    };
    backend.stop = async () => stopInput.resolve();
    const run = new DriverProcess(driverBootPayload, () => backend).run();

    await inputEntered.promise;
    const shutdown = process
      .listeners("SIGTERM")
      .find((listener) => !existingSignalListeners.has(listener));
    expect(shutdown).toBeDefined();
    shutdown?.("SIGTERM");

    await expect(run).rejects.toThrow("run completed terminal could not be delivered");
    const socket = PendingWebSocket.instances[0] as RpcWebSocket;
    expect(socket.paths.filter((path) => path === "/driver/completeRun")).toHaveLength(3);
    expect(socket.readyState).toBe(3);
  });

  test("bounds a persistently stalled failure terminal before closing", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.stalledPath = "/driver/failRun";
    const backend = createBackend();
    const backendStarted = Promise.withResolvers<void>();
    const failure = new Error("provider process exited");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
      backendStarted.resolve();
    };
    const run = new DriverProcess(driverBootPayload, () => backend).run();

    await backendStarted.promise;
    (context as AgentDriverContext | null)?.lifecycle.fail(failure);
    await expect(run).rejects.toBe(failure);

    const socket = PendingWebSocket.instances[0] as RpcWebSocket;
    expect(socket.paths.filter((path) => path === "/driver/failRun")).toHaveLength(3);
    expect(socket.readyState).toBe(3);
  });

  test("reports a stop failure after its third cleanup attempt succeeds", async () => {
    globalThis.WebSocket = RpcWebSocket as unknown as typeof WebSocket;
    RpcWebSocket.commands = [
      {
        commandId: "stop-after-cleanup-retries",
        kind: "session.stop",
        reason: "test.stop",
      },
    ];
    const backend = createBackend();
    let stopCount = 0;
    let failRunStopCount = 0;
    backend.stop = async () => {
      stopCount += 1;
      if (stopCount < 3) {
        throw new Error("cleanup failed");
      }
    };
    RpcWebSocket.pathObserver = (path) => {
      if (path === "/driver/failRun") {
        failRunStopCount = stopCount;
      }
    };

    await expect(new DriverProcess(driverBootPayload, () => backend).run()).rejects.toThrow(
      "cleanup failed",
    );

    const socket = PendingWebSocket.instances[0] as RpcWebSocket;
    expect(stopCount).toBe(3);
    expect(failRunStopCount).toBe(3);
    expect(socket.paths.filter((path) => path === "/driver/failRun")).toHaveLength(1);
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
