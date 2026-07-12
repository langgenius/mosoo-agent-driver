import { describe, expect, test } from "bun:test";

import { AgentDriverKernelCore, AsyncValueQueue } from "../src/core/agent-driver-kernel";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import type { RuntimeCommand } from "../src/runtime-command";
import type {
  AgentDriverContext,
  AgentDriverContextPortOverrides,
} from "../src/runtimes/agent-driver-backend";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { driverBootPayload } from "./driver-boot-payload-fixture";
import { DRIVER_TEST_IDS, bootPayload, createBackend } from "./driver-runtime-boundary-fixtures";

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("AsyncValueQueue", () => {
  test("admits the exact UTF-8 JSON byte limit and rejects one byte less", async () => {
    const value = { text: "你好🙂" };
    const bytes = jsonBytes(value);
    const exact = new AsyncValueQueue("test", 2, bytes, jsonBytes);
    const short = new AsyncValueQueue("test", 2, bytes - 1, jsonBytes);

    exact.push(value);
    expect(() => short.push(value)).toThrow("UTF-8 JSON bytes");
    await expect(exact.next()).resolves.toEqual({ done: false, value });
  });

  test("rejects a byte-overflowing batch atomically and restores bytes on next", async () => {
    const queue = new AsyncValueQueue("test", 4, 3, (value: string) => value.length);
    queue.push("aa");

    expect(() => queue.pushMany(["b", "c"])).toThrow("UTF-8 JSON bytes");
    await expect(queue.next()).resolves.toEqual({ done: false, value: "aa" });
    queue.pushMany(["b", "c"]);
    await expect(queue.next()).resolves.toEqual({ done: false, value: "b" });
    await expect(queue.next()).resolves.toEqual({ done: false, value: "c" });
  });

  test("does not charge directly delivered values and drains buffered values after close", async () => {
    const queue = new AsyncValueQueue("test", 1, 5, (value: string) => value.length);
    queue.push("old");
    await expect(queue.next()).resolves.toEqual({ done: false, value: "old" });

    const waiting = queue.next();
    queue.push("larger than the buffered byte limit");
    await expect(waiting).resolves.toEqual({
      done: false,
      value: "larger than the buffered byte limit",
    });
    queue.push("12345");
    queue.close();
    await expect(queue.next()).resolves.toEqual({ done: false, value: "12345" });
    await expect(queue.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("discards buffered values when a non-draining owner closes", async () => {
    const queue = new AsyncValueQueue("test", 2);
    queue.pushMany(["first", "second"]);
    queue.close({ discard: true });

    await expect(queue.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test.each(["run.cancelled", "run.completed", "run.failed"] as const)(
    "reserves one %s after the ordinary lane is full and drains it last",
    async (kind) => {
      const terminal: DriverEventInput = { kind, payload: { reason: "terminal" } };
      const ordinary: DriverEventInput = {
        kind: "message.started",
        payload: { messageId: "message", role: "agent" },
      };
      const queue = new AsyncValueQueue("event", 2, jsonBytes(ordinary) * 2, jsonBytes, {
        maxBytes: jsonBytes(terminal),
        maxSize: 1,
      });
      queue.pushMany([ordinary, ordinary]);

      expect(() => queue.push(ordinary)).toThrow("2 items");
      queue.pushReserved(terminal);
      queue.close();

      await expect(queue.next()).resolves.toEqual({ done: false, value: ordinary });
      await expect(queue.next()).resolves.toEqual({ done: false, value: ordinary });
      await expect(queue.next()).resolves.toEqual({ done: false, value: terminal });
      await expect(queue.next()).resolves.toEqual({ done: true, value: undefined });
    },
  );

  test("keeps byte reserve independent and rejects a value larger than the reserve", async () => {
    const queue = new AsyncValueQueue("test", 4, 4, (value: string) => value.length, {
      maxBytes: 2,
      maxSize: 1,
    });
    queue.push("1234");

    expect(() => queue.push("x")).toThrow("UTF-8 JSON bytes");
    expect(() => queue.pushReserved("oversized")).toThrow("reserve exceeds 2 UTF-8 JSON bytes");
    queue.pushReserved("ok");
    await expect(queue.next()).resolves.toEqual({ done: false, value: "1234" });
    await expect(queue.next()).resolves.toEqual({ done: false, value: "ok" });
  });
});

describe("AgentDriverKernelCore", () => {
  test("rejects an overflowing event batch without partially enqueueing it", async () => {
    const kernel = new AgentDriverKernelCore({ backendFactory: () => createBackend() });
    const event: DriverEventInput = {
      kind: "message.started",
      payload: {
        messageId: "message-1",
        role: "agent",
      },
    };

    await kernel.pushEvents({ events: Array.from({ length: 1_023 }, () => event) });
    await expect(kernel.pushEvents({ events: [event, event] })).rejects.toThrow(
      "Driver kernel event queue exceeds 1024 items.",
    );
    await kernel.stop("test.complete");

    let received = 0;

    for await (const _event of kernel.events()) {
      received += 1;
    }

    expect(received).toBe(1_023);
  });

  test("enforces the event queue UTF-8 JSON byte budget", async () => {
    const kernel = new AgentDriverKernelCore({ backendFactory: () => createBackend() });
    const events = kernel.events()[Symbol.asyncIterator]();
    const contentDelta = "x".repeat(17 * 1_024 * 1_024);
    const event: DriverEventInput = {
      delivery: "best_effort",
      kind: "message.delta",
      payload: {
        contentDelta,
        messageId: "large-message",
        role: "agent",
      },
    };

    await kernel.pushEvents({ events: [event] });
    await expect(kernel.pushEvents({ events: [event] })).rejects.toThrow("UTF-8 JSON bytes");
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { payload: { messageId: "large-message" } },
    });
    await kernel.stop("test.complete");
  });

  test("preserves run.failed after lossless events fill the ordinary byte lane", async () => {
    const backend = createBackend();
    const failure = new Error("provider failed after a large lossless event");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();
    const base: DriverEventInput = {
      delivery: "lossless",
      kind: "diagnostic.reported",
      payload: { message: "" },
    };
    const event: DriverEventInput = {
      ...base,
      payload: {
        message: "x".repeat(32 * 1_024 * 1_024 - jsonBytes(base)),
      },
    };
    expect(jsonBytes(event)).toBe(32 * 1_024 * 1_024);

    await kernel.start(bootPayload);
    kernel.beginRun(DRIVER_TEST_IDS.runId);
    await kernel.pushEvents({ events: [event] });
    context?.lifecycle.fail(failure);
    await expect(kernel.stop("join failure")).rejects.toBe(failure);

    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "diagnostic.reported" },
    });
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "run.failed", runId: DRIVER_TEST_IDS.runId },
    });
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("can retry a run terminal after an oversized reserve admission fails", async () => {
    const kernel = new AgentDriverKernelCore({ backendFactory: () => createBackend() });
    const events = kernel.events()[Symbol.asyncIterator]();
    kernel.beginRun(DRIVER_TEST_IDS.runId);

    await expect(
      kernel.failRun({
        code: "oversized",
        details: {},
        message: "x".repeat(1_024 * 1_024),
        retryable: false,
      }),
    ).rejects.toThrow("queue reserve exceeds 1048576 UTF-8 JSON bytes");
    const retryError = {
      code: "retry",
      details: {},
      message: "retry fits",
      retryable: false,
    };
    const retry = kernel.failRun(retryError);
    Reflect.set(retryError, "code", "mutated");
    Reflect.set(retryError, "message", "mutated after admission");
    await expect(retry).resolves.toBeUndefined();
    await kernel.completeRun();
    await kernel.stop("test.complete");

    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: "run.failed",
        payload: { error: { code: "retry" } },
        runId: DRIVER_TEST_IDS.runId,
      },
    });
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test.each(["best_effort", "lossless"] as const)(
    "keeps a terminal run failure when %s events fill the ordinary queue",
    async (delivery) => {
      const backend = createBackend();
      const failure = new Error("provider exited after streaming");
      let context: AgentDriverContext | null = null;
      backend.start = async (startedContext) => {
        context = startedContext;
      };
      const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
      const events = kernel.events()[Symbol.asyncIterator]();
      const delta: DriverEventInput = {
        delivery,
        kind: "message.delta",
        payload: {
          contentDelta: "x",
          messageId: "message-1",
          role: "agent",
        },
      };

      await kernel.start(bootPayload);
      kernel.beginRun(DRIVER_TEST_IDS.runId);
      await kernel.pushEvents({ events: Array.from({ length: 1_024 }, () => delta) });
      context?.lifecycle.fail(failure);
      await expect(kernel.stop("join failure")).rejects.toBe(failure);

      const received: DriverEventInput[] = [];

      for await (const event of { [Symbol.asyncIterator]: () => events }) {
        received.push(event);
      }

      expect(received).toHaveLength(1_025);
      expect(received.filter((event) => event.kind === "message.delta")).toHaveLength(1_024);
      expect(received.at(-1)).toEqual(
        expect.objectContaining({ kind: "run.failed", runId: DRIVER_TEST_IDS.runId }),
      );
    },
  );

  test("treats stop before start as a terminal lifecycle", async () => {
    const kernel = new AgentDriverKernelCore({ backendFactory: () => createBackend() });
    const events = kernel.events()[Symbol.asyncIterator]();

    await expect(Promise.all([kernel.stop("first"), kernel.stop("second")])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(kernel.start(bootPayload)).rejects.toThrow("already started");
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("starts from a driver start input without boot transport fields", async () => {
    const backend = createBackend();
    const startInput = createDriverStartInputFromBootPayload(driverBootPayload);
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
    });

    await kernel.start(startInput);
    await kernel.stop("test.stop");

    expect(startInput).not.toHaveProperty("bootToken");
    expect(startInput).not.toHaveProperty("driverControlPort");
    expect(startInput).not.toHaveProperty("heartbeatIntervalMs");
    expect(startInput).not.toHaveProperty("traceparent");
    expect(startInput.execution).not.toHaveProperty("configRevision");
    expect(startInput.execution).toHaveProperty("run");
    expect(startInput.execution.session).not.toHaveProperty("context");
    expect(startInput.execution.session).toHaveProperty("sharedRootPath");
  });

  test("owns its start input before asynchronous startup continues", async () => {
    const backend = createBackend();
    const startEntered = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    const mutable = structuredClone(bootPayload);
    let contextCwd: string | null = null;
    let contextDirectories: string[] | null = null;
    let factoryCwd: string | null = null;
    backend.start = async (context) => {
      startEntered.resolve();
      await releaseStart.promise;
      contextCwd = context.payload.execution.session.cwd;
      contextDirectories = [...context.payload.execution.session.additionalDirectories];
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: (input) => {
        factoryCwd = input.execution.session.cwd;
        return backend;
      },
    });

    const started = kernel.start(mutable);
    await startEntered.promise;
    Reflect.set(mutable.execution.session, "cwd", "/mutated");
    Reflect.set(mutable.execution.session.additionalDirectories, 0, "/mutated-dir");
    releaseStart.resolve();
    await started;
    await kernel.stop("test.stop");

    expect(factoryCwd).toBe(bootPayload.execution.session.cwd);
    expect(contextCwd).toBe(bootPayload.execution.session.cwd);
    expect(contextDirectories).toEqual([]);
  });

  test("owns a command before the caller can mutate its identity or payload", async () => {
    const backend = createBackend();
    let handledText: string | null = null;
    backend.handleInput = async (_context, input) => {
      handledText = input.text;
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const command = {
      commandId: "owned-command",
      input: { text: "original" },
      kind: "input.start",
      requestId: "owned-request",
      runId: DRIVER_TEST_IDS.runId,
    } satisfies RuntimeCommand;

    await kernel.start(bootPayload);
    const dispatched = kernel.dispatch(command);
    Reflect.set(command, "commandId", "mutated-command");
    Reflect.set(command, "kind", "turn.cancel");
    Reflect.set(command.input, "text", "mutated");

    await expect(dispatched).resolves.toEqual({ requestId: "owned-request" });
    await kernel.stop("test.stop");
    expect(handledText).toBe("original");
    expect(backend.cancelledReasons).toEqual(["test.stop"]);
  });

  test("owns a command result before resolving it to the dispatch caller", async () => {
    const backend = createBackend();
    const failure = new Error("close custom command source");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
      hostPorts: {
        commandSource: {
          nextCommand: async () => new Promise<never>(() => {}),
        },
      },
    });
    const command: RuntimeCommand = {
      argumentsJson: "{}",
      commandId: "owned-result-command",
      kind: "mcp.execute",
      requestId: "owned-result-request",
      serverId: "mcp-server",
      toolName: "tool",
    };
    const externalResult = {
      debug: { nested: "original" },
      outputText: "original",
      requestId: "owned-result-request",
      serverId: "mcp-server",
      toolName: "tool",
    };

    await kernel.start(bootPayload);
    const dispatched = kernel.dispatch(command);
    const completed = kernel.commandUpdate(
      {
        commandId: command.commandId,
        result: externalResult,
        status: "completed",
      },
      new AbortController().signal,
    );
    Reflect.set(externalResult, "outputText", "mutated");
    Reflect.set(externalResult.debug, "nested", "mutated");

    await completed;
    await expect(dispatched).resolves.toEqual({
      debug: { nested: "original" },
      outputText: "original",
      requestId: "owned-result-request",
      serverId: "mcp-server",
      toolName: "tool",
    });
    context?.lifecycle.fail(failure);
    await expect(kernel.stop("join failure")).rejects.toBe(failure);
  });

  test.each([
    ["empty command ID", { commandId: "", kind: "turn.cancel" }, "commandId"],
    ["non-string command ID", { commandId: 1, kind: "turn.cancel" }, "commandId"],
    ["unsupported kind", { commandId: "invalid-kind", kind: "turn.finish" }, "Unsupported"],
    [
      "empty input text",
      {
        commandId: "empty-input",
        input: { text: "" },
        kind: "input.start",
        requestId: "empty-input-request",
        runId: DRIVER_TEST_IDS.runId,
      },
      "text",
    ],
  ] as const)("rejects an invalid %s at admission", async (_name, command, message) => {
    const kernel = new AgentDriverKernelCore({ backendFactory: () => createBackend() });
    await kernel.start(bootPayload);

    await expect(kernel.dispatch(command as unknown as RuntimeCommand)).rejects.toThrow(message);
    await expect(kernel.stop("test.stop")).resolves.toBeUndefined();
  });

  test("owns pushed event payloads before returning control to the caller", async () => {
    const kernel = new AgentDriverKernelCore({ backendFactory: () => createBackend() });
    const event: DriverEventInput = {
      delivery: "best_effort",
      kind: "message.delta",
      payload: {
        contentDelta: "original",
        messageId: "message-owned",
        role: "agent",
      },
    };
    const events = kernel.events()[Symbol.asyncIterator]();

    const pushed = kernel.pushEvents({ events: [event] });
    Reflect.set(event.payload, "contentDelta", "mutated");
    await pushed;
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { payload: { contentDelta: "original" } },
    });
    await kernel.stop("test.stop");
  });

  test("starts a backend and dispatches runtime commands without process transport", async () => {
    const backend = createBackend();
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
    });

    await kernel.start(bootPayload);
    const result = await kernel.dispatch({
      commandId: "input-1",
      input: {
        text: "hello",
      },
      kind: "input.start",
      requestId: "request-1",
      runId: DRIVER_TEST_IDS.runId,
    });
    await kernel.stop("test.stop");

    expect(result).toEqual({
      requestId: "request-1",
    });
    expect(backend.handledInputs).toHaveLength(1);
  });

  test.each(["input", "mcp"] as const)(
    "replays a completed %s command without repeating its side effect",
    async (kind) => {
      const backend = createBackend();
      let calls = 0;
      backend.handleInput = async () => {
        calls += 1;
      };
      const kernel = new AgentDriverKernelCore({
        backendFactory: () => backend,
        hostPorts: {
          mcp: {
            execute: async (command) => {
              calls += 1;
              const result = {
                debug: { nested: "original" },
                outputText: `ran ${command.toolName}`,
                requestId: command.requestId,
                serverId: command.serverId,
                toolName: command.toolName,
              };
              return result;
            },
          },
        },
      });
      const command: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "replayed-command",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "request-replay",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              argumentsJson: '{"issue":"A-1"}',
              commandId: "replayed-command",
              kind: "mcp.execute",
              requestId: "request-replay",
              serverId: "mcp-linear",
              toolName: "createIssue",
            };

      await kernel.start(bootPayload);
      const first = await kernel.dispatch(command);
      if (typeof first === "object" && first !== null) {
        Reflect.set(first, "requestId", "caller-mutated");
        const debug = Reflect.get(first, "debug") as { nested?: string } | undefined;
        if (debug !== undefined) {
          debug.nested = "caller-mutated";
        }
      }
      const replay = await kernel.dispatch(structuredClone(command));
      await kernel.stop("test.stop");

      expect(replay).toEqual(
        kind === "input"
          ? { requestId: "request-replay" }
          : {
              debug: { nested: "original" },
              outputText: "ran createIssue",
              requestId: "request-replay",
              serverId: "mcp-linear",
              toolName: "createIssue",
            },
      );
      expect(calls).toBe(1);
    },
  );

  test("exposes provider events through the kernel event stream", async () => {
    const backend = createBackend();
    const event: DriverEventInput = {
      kind: "message.started",
      payload: {
        messageId: "message-1",
        role: "agent",
      },
    };
    backend.handleInput = async (context: AgentDriverContext) => {
      await context.ports.eventSink.pushEvents({ events: [event] });
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
    });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    const dispatch = kernel.dispatch({
      commandId: "input-1",
      input: {
        text: "hello",
      },
      kind: "input.start",
      requestId: "request-1",
      runId: DRIVER_TEST_IDS.runId,
    });

    await expect(events.next()).resolves.toEqual({
      done: false,
      value: event,
    });
    await expect(dispatch).resolves.toEqual({
      requestId: "request-1",
    });
    await kernel.stop("test.stop");
  });

  test("turn cancel dispatches through the active backend", async () => {
    const backend = createBackend();
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
    });

    await kernel.start(bootPayload);
    await kernel.cancel("test.cancel");
    expect(backend.cancelledReasons).toEqual(["test.cancel"]);
    await kernel.stop("test.stop");

    expect(backend.cancelledReasons).toEqual(["test.cancel", "test.stop"]);
  });

  test("completes turn cancellation only after the active input settles", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    const cancelEntered = Promise.withResolvers<void>();
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
    };
    backend.cancelActiveTurn = async (_context, reason) => {
      backend.cancelledReasons.push(reason);
      cancelEntered.resolve();
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    await kernel.start(bootPayload);
    const input = kernel.dispatch({
      commandId: "active-input",
      input: { text: "wait" },
      kind: "input.start",
      requestId: "active-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    await inputEntered.promise;
    const cancel = kernel.cancel("test.cancel");
    await cancelEntered.promise;

    expect(await Promise.race([cancel.then(() => true), Bun.sleep(10).then(() => false)])).toBe(
      false,
    );

    releaseInput.resolve();
    await expect(Promise.all([input, cancel])).resolves.toEqual([undefined, undefined]);
    await kernel.stop("test.stop");
  });

  test("treats an input error after the local abort as cancellation", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const cancelInput = Promise.withResolvers<void>();
    backend.handleInput = async () => {
      inputEntered.resolve();
      await cancelInput.promise;
    };
    backend.cancelActiveTurn = async () => {
      cancelInput.reject(new Error("native cancellation"));
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    await kernel.start(bootPayload);
    const input = kernel.dispatch({
      commandId: "cancelled-input",
      input: { text: "wait" },
      kind: "input.start",
      requestId: "cancelled-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    await inputEntered.promise;

    await expect(Promise.all([input, kernel.cancel("test.cancel")])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(kernel.stop("test.stop")).resolves.toBeUndefined();
  });

  test.each(["allow_once", "reject_once"] as const)(
    "ignores a stale %s permission completion after its cancelled run",
    async (decision) => {
      const backend = createBackend();
      const inputEntered = Promise.withResolvers<void>();
      const releaseInput = Promise.withResolvers<void>();
      const resolutionPublishing = Promise.withResolvers<void>();
      const releaseResolution = Promise.withResolvers<void>();
      let inputCount = 0;
      let permission: Promise<unknown> | null = null;
      backend.handleInput = async (context) => {
        inputCount += 1;

        if (inputCount > 1) {
          return;
        }

        permission = context.ports.permission.request({
          rawInput: null,
          requestId: "permission-stale",
          title: "Allow test tool?",
          toolCallId: "tool-call-stale",
          toolKind: "test",
        });
        inputEntered.resolve();
        await releaseInput.promise;
      };
      backend.cancelActiveTurn = async () => {
        releaseInput.resolve();
      };
      const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
      const pushEvents = kernel.pushEvents.bind(kernel);
      kernel.pushEvents = async (input) => {
        if (input.events.some((event) => event.kind === "permission.resolved")) {
          resolutionPublishing.resolve();
          await releaseResolution.promise;
        }

        return pushEvents(input);
      };
      const payload = {
        ...bootPayload,
        execution: {
          ...bootPayload.execution,
          permissionPolicy: "supervised" as const,
        },
      };

      await kernel.start(payload);
      const firstInput = kernel.dispatch({
        commandId: "permission-input",
        input: { text: "wait for permission" },
        kind: "input.start",
        requestId: "permission-request",
        runId: DRIVER_TEST_IDS.runId,
      });
      await inputEntered.promise;
      await expect(Promise.all([firstInput, kernel.cancel("test.cancel")])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      await kernel.dispatch({
        commandId: "resolve-stale-permission",
        decision,
        kind: "permission.resolve",
        requestId: "permission-stale",
      });
      await resolutionPublishing.promise;
      releaseResolution.resolve();
      await permission;

      await expect(
        kernel.dispatch({
          commandId: "next-input",
          input: { text: "continue" },
          kind: "input.start",
          requestId: "next-request",
          runId: DRIVER_TEST_IDS.secondRunId,
        }),
      ).resolves.toEqual({ requestId: "next-request" });
      await kernel.stop("test.stop");
    },
  );

  test.each(["requested", "resolved"] as const)(
    "fails closed when a cancelled permission.%s event cannot be delivered",
    async (phase) => {
      const backend = createBackend();
      const inputEntered = Promise.withResolvers<void>();
      const deliveryEntered = Promise.withResolvers<void>();
      const releaseDelivery = Promise.withResolvers<void>();
      backend.handleInput = async (context) => {
        inputEntered.resolve();
        await context.ports.permission.request({
          rawInput: null,
          requestId: "permission-delivery-failure",
          title: "Allow test tool?",
          toolCallId: "tool-call-delivery-failure",
          toolKind: "test",
        });
      };
      const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
      const pushEvents = kernel.pushEvents.bind(kernel);
      kernel.pushEvents = async (input) => {
        if (input.events.some((event) => event.kind === `permission.${phase}`)) {
          deliveryEntered.resolve();
          await releaseDelivery.promise;
          throw new Error("permission event delivery failed");
        }

        return pushEvents(input);
      };
      const payload = {
        ...bootPayload,
        execution: {
          ...bootPayload.execution,
          permissionPolicy: "supervised" as const,
        },
      };

      await kernel.start(payload);
      const input = kernel.dispatch({
        commandId: "permission-delivery-input",
        input: { text: "wait for permission" },
        kind: "input.start",
        requestId: "permission-delivery-request",
        runId: DRIVER_TEST_IDS.runId,
      });
      await inputEntered.promise;
      const cancel = kernel.cancel("test.cancel");
      await deliveryEntered.promise;
      releaseDelivery.resolve();

      await expect(input).rejects.toThrow("could not be delivered");
      await cancel.catch(() => {});
      await expect(
        kernel.dispatch({
          commandId: "input-after-permission-delivery-failure",
          input: { text: "must not continue" },
          kind: "input.start",
          requestId: "request-after-permission-delivery-failure",
          runId: DRIVER_TEST_IDS.secondRunId,
        }),
      ).rejects.toThrow("not accepting commands: failed");
      await kernel.stop("test.stop");
    },
  );

  test("propagates a lifecycle failure raised during backend startup", async () => {
    const backend = createBackend();
    const failure = new Error("provider failed during startup");
    backend.start = async (context) => {
      context.lifecycle.fail(failure);
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    await expect(kernel.start(bootPayload)).rejects.toBe(failure);
    await expect(kernel.stop("join failed startup")).rejects.toBe(failure);
  });

  test.each([
    ["factory", 0],
    ["backend start", 1],
  ] as const)("closes the kernel after a %s failure", async (stage, expectedStopCount) => {
    const backend = createBackend();
    let stopCount = 0;
    backend.start = async () => {
      if (stage === "backend start") {
        throw new Error("startup failed");
      }
    };
    backend.stop = async () => {
      stopCount += 1;
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => {
        if (stage === "factory") {
          throw new Error("startup failed");
        }

        return backend;
      },
    });
    const events = kernel.events()[Symbol.asyncIterator]();

    await expect(kernel.start(bootPayload)).rejects.toThrow("startup failed");
    await expect(kernel.stop("test.stop")).rejects.toThrow("startup failed");
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(
      kernel.dispatch({
        commandId: "after-start-failure",
        kind: "turn.cancel",
        reason: "test",
      }),
    ).rejects.toThrow("not accepting commands: failed");
    expect(stopCount).toBe(expectedStopCount);
  });

  test.each([
    ["successful", null],
    ["failed", new Error("cleanup failed")],
  ] as const)("joins %s startup cleanup from every concurrent stop", async (_name, cleanupError) => {
    const backend = createBackend();
    const cleanupEntered = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    let stopCount = 0;
    backend.start = async () => {
      throw new Error("startup failed");
    };
    backend.stop = async () => {
      stopCount += 1;
      cleanupEntered.resolve();
      await releaseCleanup.promise;

      if (cleanupError !== null) {
        throw cleanupError;
      }
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();
    const startOutcome = kernel.start(bootPayload).then(
      () => null,
      (error: unknown) => error,
    );

    await cleanupEntered.promise;
    const stopOutcome = Promise.all([kernel.stop("first stop"), kernel.stop("second stop")]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(
      await Promise.race([stopOutcome.then(() => true), Bun.sleep(10).then(() => false)]),
    ).toBe(false);

    releaseCleanup.resolve();
    const startupError = await startOutcome;
    expect(startupError).toMatchObject({ message: "startup failed" });
    expect(await stopOutcome).toBe(startupError);

    expect(stopCount).toBe(1);
    if (cleanupError === null) {
      await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
    }
  });

  test("serializes concurrent stop calls with an in-flight start", async () => {
    const backend = createBackend();
    const startEntered = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    let stopCount = 0;
    let stopReason: string | null = null;
    backend.start = async () => {
      startEntered.resolve();
      await releaseStart.promise;
    };
    backend.stop = async (_context, reason) => {
      stopCount += 1;
      stopReason = reason;
      releaseStart.resolve();
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    const start = kernel.start(bootPayload);
    await startEntered.promise;
    const firstStop = kernel.stop("first stop");
    const secondStop = kernel.stop("second stop");

    await expect(start).resolves.toBeUndefined();
    await expect(Promise.all([firstStop, secondStop])).resolves.toEqual([undefined, undefined]);
    await expect(kernel.stop("third stop")).resolves.toBeUndefined();
    expect(stopCount).toBe(2);
    expect(stopReason).toBe("first stop");
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("stops resources created while the original startup task settles", async () => {
    const backend = createBackend();
    const startEntered = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    let resourceActive = false;
    let stopCount = 0;
    backend.start = async () => {
      startEntered.resolve();
      await releaseStart.promise;
      resourceActive = true;
    };
    backend.stop = async () => {
      stopCount += 1;
      resourceActive = false;
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    const start = kernel.start(bootPayload);
    await startEntered.promise;
    const stop = kernel.stop("startup stop");

    expect(await Promise.race([stop.then(() => true), Bun.sleep(10).then(() => false)])).toBe(
      false,
    );
    releaseStart.resolve();

    await expect(stop).resolves.toBeUndefined();
    await expect(start).resolves.toBeUndefined();
    expect(stopCount).toBe(2);
    expect(resourceActive).toBe(false);
  });

  test("automatically retries final cleanup after shutdown times out during startup", async () => {
    const backend = createBackend();
    const startEntered = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    const finalCleanup = Promise.withResolvers<void>();
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

      if (stopCount === 2) {
        finalCleanup.resolve();
      }
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback, delay, ...args) =>
      nativeSetTimeout(callback, delay === 5_000 ? 10 : delay, ...args)) as typeof setTimeout;

    try {
      const start = kernel.start(bootPayload);
      await startEntered.promise;
      await expect(kernel.stop("startup stop")).rejects.toThrow("timed out");
      expect(startSignal?.aborted).toBe(true);
      expect(startSignal?.reason).toMatchObject({ message: "startup stop" });
      releaseStart.resolve();
      await start;

      const cleaned = await Promise.race([
        finalCleanup.promise.then(() => true),
        Bun.sleep(50).then(() => false),
      ]);
      expect(cleaned).toBe(true);
      expect(stopCount).toBe(2);
      expect(resourceActive).toBe(false);
    } finally {
      releaseStart.resolve();
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("enforces the command queue UTF-8 JSON byte budget", async () => {
    const backend = createBackend();
    const pollEntered = Promise.withResolvers<void>();
    const failure = new Error("release queued commands");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
      hostPorts: {
        commandSource: {
          nextCommand: async () => {
            pollEntered.resolve();
            return new Promise<never>(() => {});
          },
        },
      },
    });
    const text = "x".repeat(17 * 1_024 * 1_024);

    await kernel.start(bootPayload);
    await pollEntered.promise;
    const first = kernel.dispatch({
      commandId: "large-command-1",
      input: { text },
      kind: "input.start",
      requestId: "large-request-1",
      runId: DRIVER_TEST_IDS.runId,
    });
    void first.catch(() => {});
    await expect(
      kernel.dispatch({
        commandId: "large-command-2",
        input: { text },
        kind: "input.start",
        requestId: "large-request-2",
        runId: DRIVER_TEST_IDS.runId,
      }),
    ).rejects.toThrow("UTF-8 JSON bytes");

    context?.lifecycle.fail(failure);
    await expect(first).rejects.toBe(failure);
    await expect(kernel.stop("join failure")).rejects.toBe(failure);
  });

  test.each([
    ["poll", "resolve"],
    ["poll", "reject"],
    ["accepted ACK", "resolve"],
    ["accepted ACK", "reject"],
  ] as const)(
    "backend failure bounds a non-compliant %s and absorbs its late %s",
    async (boundary, lateOutcome) => {
      const backend = createBackend();
      const entered = Promise.withResolvers<void>();
      const late = Promise.withResolvers<unknown>();
      const failure = new Error(`provider failed during ${boundary}`);
      let context: AgentDriverContext | null = null;
      backend.start = async (startedContext) => {
        context = startedContext;
      };
      const hostPorts: AgentDriverContextPortOverrides =
        boundary === "poll"
          ? {
              commandSource: {
                nextCommand: async () => {
                  entered.resolve();
                  return late.promise as Promise<RuntimeCommand | null>;
                },
              },
            }
          : {
              eventSink: {
                commandUpdate: async () => {
                  entered.resolve();
                  await late.promise;
                },
                pushEvents: async ({ events }) => ({
                  accepted: events.map((event, index) => ({
                    seq: index + 1,
                    type: event.kind,
                  })),
                }),
              },
            };
      const kernel = new AgentDriverKernelCore({
        backendFactory: () => backend,
        hostPorts,
      });

      await kernel.start(bootPayload);
      const command =
        boundary === "accepted ACK"
          ? kernel
              .dispatch({
                commandId: "blocked-accepted-command",
                kind: "turn.cancel",
                reason: "test.cancel",
              })
              .catch(() => {})
          : null;
      await entered.promise;
      context?.lifecycle.fail(failure);

      const stopped = await settlePromiseWithTimeout(kernel.stop("join failure"), {
        label: `Kernel ${boundary} failure shutdown`,
        timeoutMs: 100,
      });
      expect(stopped).toEqual({ error: failure, status: "failed" });
      await command;

      if (lateOutcome === "resolve") {
        late.resolve(boundary === "poll" ? null : undefined);
      } else {
        late.reject(new Error("late host port failure"));
      }
      await Bun.sleep(0);
    },
  );

  test("an idle backend failure enters the supervised shutdown path", async () => {
    const backend = createBackend();
    const failure = new Error("provider process exited");
    let context: AgentDriverContext | null = null;
    let stopCount = 0;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    backend.stop = async () => {
      stopCount += 1;
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    context?.lifecycle.fail(failure);
    await expect(kernel.stop("wait for failure cleanup")).rejects.toBe(failure);

    expect(stopCount).toBe(1);
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("an active backend failure rejects input and publishes run.failed before shutdown", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    const failure = new Error("provider process exited during input");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
    };
    backend.stop = async () => {
      releaseInput.resolve();
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    const input = kernel.dispatch({
      commandId: "failing-active-input",
      input: { text: "wait" },
      kind: "input.start",
      requestId: "failing-active-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    await inputEntered.promise;
    context?.lifecycle.fail(failure);

    await expect(input).rejects.toBe(failure);
    await expect(kernel.stop("wait for failure cleanup")).rejects.toBe(failure);
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "run.failed", runId: DRIVER_TEST_IDS.runId },
    });
  });

  test("stop bypasses a full ordinary command queue", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    let stopCount = 0;
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
    };
    backend.stop = async () => {
      stopCount += 1;
      releaseInput.resolve();
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    const pending = [
      kernel
        .dispatch({
          commandId: "blocking-input",
          input: { text: "wait" },
          kind: "input.start",
          requestId: "blocking-request",
          runId: DRIVER_TEST_IDS.runId,
        })
        .catch(() => {}),
    ];
    await inputEntered.promise;
    pending.push(
      kernel
        .dispatch({
          commandId: "queued-input",
          input: { text: "wait again" },
          kind: "input.start",
          requestId: "queued-request",
          runId: DRIVER_TEST_IDS.runId,
        })
        .catch(() => {}),
    );
    await Bun.sleep(0);

    for (let index = 0; index < 1_024; index += 1) {
      pending.push(
        kernel
          .dispatch({
            commandId: `queued-cancel-${index}`,
            kind: "turn.cancel",
            reason: "queued",
          })
          .catch(() => {}),
      );
    }

    await expect(kernel.stop("queue full stop")).resolves.toBeUndefined();
    await Promise.all(pending);
    expect(stopCount).toBe(1);
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "run.completed" },
    });
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("cancels and settles an active input before releasing the backend", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    let stopCount = 0;
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
    };
    backend.cancelActiveTurn = async (_context, reason) => {
      backend.cancelledReasons.push(reason);
      releaseInput.resolve();
    };
    backend.stop = async () => {
      stopCount += 1;
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    await kernel.start(bootPayload);
    const input = kernel.dispatch({
      commandId: "active-input",
      input: { text: "wait" },
      kind: "input.start",
      requestId: "active-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    await inputEntered.promise;
    const stop = kernel.stop("active stop");

    await expect(input).resolves.toBeUndefined();
    await expect(stop).resolves.toBeUndefined();
    expect(backend.cancelledReasons).toEqual(["active stop"]);
    expect(stopCount).toBe(1);
  });

  test(
    "never reports a successful stop while an owned input task is still running",
    async () => {
      const backend = createBackend();
      const inputEntered = Promise.withResolvers<void>();
      const releaseInput = Promise.withResolvers<void>();
      let inputSettled = false;
      backend.handleInput = async () => {
        inputEntered.resolve();
        await releaseInput.promise;
        inputSettled = true;
      };
      backend.cancelActiveTurn = async () => {};
      const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

      await kernel.start(bootPayload);
      const input = kernel
        .dispatch({
          commandId: "stuck-input",
          input: { text: "wait" },
          kind: "input.start",
          requestId: "stuck-request",
          runId: DRIVER_TEST_IDS.runId,
        })
        .catch(() => {});
      await inputEntered.promise;

      const first = await Promise.allSettled([kernel.stop("first stop")]);
      const second = await Promise.allSettled([kernel.stop("second stop")]);
      const settledBeforeRelease = inputSettled;
      releaseInput.resolve();
      await input;

      expect(first[0]?.status).toBe("rejected");
      expect(second[0]?.status).toBe("rejected");
      expect(settledBeforeRelease).toBe(false);
    },
    10_000,
  );

  test("keeps cleanup event delivery available across a transient stop failure", async () => {
    const backend = createBackend();
    let stopCount = 0;
    backend.stop = async (context) => {
      stopCount += 1;

      if (stopCount === 1) {
        throw new Error("cleanup failed");
      }

      await context.ports.eventSink.pushEvents({
        events: [
          {
            kind: "diagnostic.reported",
            payload: {
              code: "cleanup.retried",
              details: {},
              message: "Cleanup retry completed.",
              severity: "info",
              source: "core",
            },
          },
        ],
      });
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    await expect(kernel.stop("first stop")).rejects.toThrow("cleanup failed");
    await expect(kernel.stop("second stop")).resolves.toBeUndefined();

    const received: DriverEventInput[] = [];

    for await (const event of { [Symbol.asyncIterator]: () => events }) {
      received.push(event);
    }

    expect(stopCount).toBe(2);
    expect(received.map((event) => event.kind)).toEqual([
      "run.completed",
      "diagnostic.reported",
    ]);
  });

  test.each([
    ["transient", 1, "fulfilled", 2],
    ["persistent", Number.POSITIVE_INFINITY, "rejected", 3],
  ] as const)(
    "retries %s backend cleanup during and after a stop call",
    async (_name, failures, secondStatus, expectedStops) => {
      const backend = createBackend();
      let stopCount = 0;
      backend.stop = async () => {
        stopCount += 1;

        if (stopCount <= failures) {
          throw new Error("cleanup failed");
        }
      };
      const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
      const events = kernel.events()[Symbol.asyncIterator]();

      await kernel.start(bootPayload);
      await expect(kernel.stop("test.stop")).rejects.toThrow("cleanup failed");
      const [second] = await Promise.allSettled([kernel.stop("test.stop.again")]);

      expect(second?.status).toBe(secondStatus);
      expect(stopCount).toBe(expectedStops);
      await expect(events.next()).resolves.toMatchObject({
        done: false,
        value: { kind: "run.completed" },
      });
      if (secondStatus === "fulfilled") {
        await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
      }
      await expect(
        kernel.dispatch({
          commandId: "after-stop-failure",
          kind: "turn.cancel",
          reason: "test",
        }),
      ).rejects.toThrow("not accepting commands: failed");
    },
  );

  test("starts a new cleanup attempt after the previous one times out", async () => {
    const backend = createBackend();
    const firstStopAborted = Promise.withResolvers<void>();
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
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback, delay, ...args) =>
      nativeSetTimeout(callback, delay === 5_000 ? 10 : delay, ...args)) as typeof setTimeout;

    try {
      await kernel.start(bootPayload);
      const firstError = await kernel.stop("first stop").then(
        () => null,
        (error: unknown) => error,
      );
      expect(firstError).toBeInstanceOf(Error);
      expect((firstError as Error).message).toContain("timed out");
      await firstStopAborted.promise;
      expect(stopSignals[0]?.reason).toMatchObject({
        message: "Driver kernel backend shutdown timed out after 5000ms.",
      });
      await expect(kernel.stop("second stop")).resolves.toBeUndefined();
      expect(stopCount).toBe(2);
      expect(stopSignals[1]).not.toBe(stopSignals[0]);
      expect(stopSignals[1]?.aborted).toBe(false);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("passes host ports into backend context", async () => {
    const backend = createBackend();
    let mcpOutput: string | null = null;
    let materializedSkillName: string | null = null;
    backend.start = async (context: AgentDriverContext) => {
      const [skill] = await context.ports.skill.materialize(context.payload.execution);
      materializedSkillName = skill?.skillName ?? null;
    };
    backend.handleInput = async (context: AgentDriverContext) => {
      const result = await context.ports.mcp.execute({
        argumentsJson: '{"ok":true}',
        commandId: "mcp-port-1",
        kind: "mcp.execute",
        requestId: "request-1",
        serverId: "server-1",
        toolName: "complete",
      });
      mcpOutput = result.outputText;
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
      hostPorts: {
        mcp: {
          execute: async (command) => ({
            outputText: `port:${command.toolName}`,
            requestId: command.requestId,
            serverId: command.serverId,
            toolName: command.toolName,
          }),
        },
        skill: {
          materialize: async () => [
            {
              mountPath: "/workspace/.mosoo/skill/review",
              skillId: "skill-1",
              skillMarkdownPath: "/workspace/.mosoo/skill/review/SKILL.md",
              skillName: "review",
              snapshotId: "snapshot-1",
            },
          ],
        },
      },
    });

    await kernel.start(bootPayload);
    await kernel.dispatch({
      commandId: "input-ports-1",
      input: {
        text: "hello",
      },
      kind: "input.start",
      requestId: "request-1",
      runId: DRIVER_TEST_IDS.runId,
    });
    await kernel.stop("test.stop");

    expect(mcpOutput).toBe("port:complete");
    expect(materializedSkillName).toBe("review");
  });
});
