import { describe, expect, test } from "bun:test";

import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import { AsyncValueQueue } from "../src/core/async-value-queue";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import type { RuntimeCommand } from "../src/runtime-command";
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
    (context as AgentDriverContext | null)?.lifecycle.fail(failure);
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
      (context as AgentDriverContext | null)?.lifecycle.fail(failure);
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
      toolCallId: "owned-result-tool",
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
    (context as AgentDriverContext | null)?.lifecycle.fail(failure);
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
    Reflect.set(event.payload as Record<string, unknown>, "contentDelta", "mutated");
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
});
