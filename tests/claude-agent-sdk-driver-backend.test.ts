import { afterEach, describe, expect, test } from "bun:test";

import type {
  Options as ClaudeQueryOptions,
  Query,
  SDKMessage,
  WarmQuery,
} from "@anthropic-ai/claude-agent-sdk";

import { DriverTurnCancelledError } from "../src/core/driver-runtime-state";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import type { DriverStartInput } from "../src/protocol/start";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { ClaudeAgentSdkDriverBackend } from "../src/runtimes/claude/agent-sdk-driver-backend";
import { registerClaudeTaskRetry } from "../src/runtimes/claude/agent-sdk-tasks";
import { bootPayload, DRIVER_TEST_IDS } from "./driver-runtime-boundary-fixtures";

const PREWARM_ENV = "AGENT_DRIVER_CLAUDE_PREWARM";
const previousPrewarm = process.env[PREWARM_ENV];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

afterEach(() => {
  if (previousPrewarm === undefined) {
    delete process.env[PREWARM_ENV];
  } else {
    process.env[PREWARM_ENV] = previousPrewarm;
  }
});

function resultMessage(sessionId = "native-session-1"): SDKMessage {
  return {
    duration_api_ms: 1,
    duration_ms: 1,
    is_error: false,
    modelUsage: {},
    num_turns: 1,
    permission_denials: [],
    result: "done",
    session_id: sessionId,
    stop_reason: "end_turn",
    subtype: "success",
    total_cost_usd: 0,
    type: "result",
    usage: { input_tokens: 1, output_tokens: 1 },
    uuid: "result-1",
  } as unknown as SDKMessage;
}

function errorResultMessage(): SDKMessage {
  return {
    duration_api_ms: 1,
    duration_ms: 1,
    errors: ["failed"],
    is_error: true,
    modelUsage: {},
    num_turns: 1,
    permission_denials: [],
    session_id: "native-session-1",
    stop_reason: null,
    subtype: "error_during_execution",
    total_cost_usd: 0,
    type: "result",
    usage: { input_tokens: 1, output_tokens: 1 },
    uuid: "result-1",
  } as unknown as SDKMessage;
}

function fakeQuery(
  messages: AsyncIterable<SDKMessage> | readonly SDKMessage[],
  close = () => {},
  interrupt = async () => undefined,
  cleanup = async () => {},
): Query {
  const source =
    Symbol.asyncIterator in Object(messages)
      ? (messages as AsyncIterable<SDKMessage>)
      : (async function* () {
          yield* messages as readonly SDKMessage[];
        })();
  const iterator = source[Symbol.asyncIterator]();
  const returnIterator = iterator.return?.bind(iterator);
  let closed = false;
  let cleanupTask: Promise<void> | null = null;
  const closeOnce = () => {
    if (!closed) {
      closed = true;
      close();
    }
  };

  return Object.assign(iterator, {
    close: closeOnce,
    interrupt,
    async return(value?: void) {
      closeOnce();
      cleanupTask ??= cleanup();
      await cleanupTask;
      return returnIterator === undefined
        ? { done: true as const, value }
        : await returnIterator(value);
    },
  }) as Query;
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(
  dependencies: ConstructorParameters<typeof ClaudeAgentSdkDriverBackend>[1],
  beforePush?: (events: readonly DriverEventInput[]) => Promise<void> | void,
  payloadOverride?: DriverStartInput,
) {
  const events: DriverEventInput[] = [];
  let currentRunId: RunId | null = null;
  let seq = 0;
  const logger = createBufferedSinkLogger({
    level: "error",
    service: "claude-agent-sdk-driver-backend-test",
    sink: async () => {},
  });
  const payload =
    payloadOverride ??
    ({
      ...bootPayload,
      runtime: "claude-agent-sdk",
      runtimeTransport: "claude-agent-sdk",
    } as DriverStartInput);
  const context = createAgentDriverContext({
    eventSink: {
      currentRunId: () => currentRunId,
      pushEvents: async ({ events: batch }) => {
        await beforePush?.(batch);
        events.push(...batch);
        for (const event of batch) {
          if (event.kind === "run.started" && event.runId !== undefined) {
            currentRunId = event.runId;
          } else if (
            (event.kind === "run.cancelled" ||
              event.kind === "run.completed" ||
              event.kind === "run.failed") &&
            event.runId === currentRunId
          ) {
            currentRunId = null;
          }
        }
        return {
          accepted: batch.map((event) => ({ seq: (seq += 1), type: event.kind })),
        };
      },
    },
    logger,
    payload,
    permission: { request: async () => "allow_once" },
    ports: { skill: { materialize: async () => [] } },
  });

  return {
    backend: new ClaudeAgentSdkDriverBackend(payload, dependencies),
    context,
    events,
    logger,
  };
}

describe("Claude Agent SDK driver backend", () => {
  test("rejects invalid native session IDs before retaining or publishing them", async () => {
    const oversizedSessionId = "s".repeat(257);
    const resumePayload = {
      ...bootPayload,
      execution: {
        ...bootPayload.execution,
        session: {
          ...bootPayload.execution.session,
          nativeResumeRef: {
            kind: "claude_session_id",
            runtimeId: "claude-agent-sdk",
            value: oversizedSessionId,
          },
        },
      },
      runtime: "claude-agent-sdk",
      runtimeTransport: "claude-agent-sdk",
    } as DriverStartInput;
    expect(() => new ClaudeAgentSdkDriverBackend(resumePayload)).toThrow(
      "Claude native session ID must contain 1-256 UTF-8 bytes (received 257).",
    );

    const harness = createHarness({
      createQueryOptions: async () => ({}),
      query: () => fakeQuery([resultMessage(oversizedSessionId)]),
      startup: async () => {
        throw new Error("prewarm is disabled");
      },
    });
    await expect(
      harness.backend.handleInput(harness.context, { text: "hello" }, DRIVER_TEST_IDS.runId),
    ).rejects.toThrow("Claude native session ID must contain 1-256 UTF-8 bytes (received 257).");
    expect(harness.events.some((event) => event.kind === "runtime.resume.updated")).toBe(false);
    expect(harness.events.some((event) => event.kind === "run.failed")).toBe(true);
    expect(JSON.stringify(harness.events)).not.toContain(oversizedSessionId);
    await harness.logger.destroy();

    const emptyHarness = createHarness({
      createQueryOptions: async () => ({}),
      query: () => fakeQuery([resultMessage("")]),
      startup: async () => {
        throw new Error("prewarm is disabled");
      },
    });
    await expect(
      emptyHarness.backend.handleInput(
        emptyHarness.context,
        { text: "hello" },
        DRIVER_TEST_IDS.runId,
      ),
    ).rejects.toThrow("Claude native session ID must contain 1-256 UTF-8 bytes (received 0).");
    expect(emptyHarness.events.some((event) => event.kind === "runtime.resume.updated")).toBe(
      false,
    );
    await emptyHarness.logger.destroy();
  });

  test("consumes a ready prewarm for the first turn", async () => {
    process.env[PREWARM_ENV] = "1";
    const startupCalled = Promise.withResolvers<void>();
    const prompts: string[] = [];
    let coldQueries = 0;
    const harness = createHarness({
      createQueryOptions: async (input) =>
        ({
          abortController: input.abortController,
        }) as ClaudeQueryOptions,
      query: () => {
        coldQueries += 1;
        return fakeQuery([resultMessage()]);
      },
      startup: async () => {
        startupCalled.resolve();
        return {
          close: () => {},
          query: (prompt) => {
            prompts.push(String(prompt));
            return fakeQuery([resultMessage()]);
          },
          async [Symbol.asyncDispose]() {},
        };
      },
    });

    await harness.backend.start(harness.context, new AbortController().signal);
    await startupCalled.promise;
    await nextEventLoopTurn();
    await harness.backend.handleInput(harness.context, { text: "first" }, DRIVER_TEST_IDS.runId);
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(prompts).toEqual(["first"]);
    expect(coldQueries).toBe(0);
  });

  test("discards a late prewarm after the first turn takes the cold path", async () => {
    process.env[PREWARM_ENV] = "1";
    const startup = Promise.withResolvers<WarmQuery>();
    const startupCalled = Promise.withResolvers<void>();
    const warmClosed = Promise.withResolvers<void>();
    let warmQueries = 0;
    let coldQueries = 0;
    const optionSessionIds: Array<string | null> = [];
    let warmSignal: AbortSignal | undefined;
    const harness = createHarness({
      createQueryOptions: async (input) => {
        optionSessionIds.push(input.nativeSessionId);
        return { abortController: input.abortController } as ClaudeQueryOptions;
      },
      query: () => {
        coldQueries += 1;
        return fakeQuery([resultMessage()]);
      },
      startup: async ({ options } = {}) => {
        warmSignal = options?.abortController?.signal;
        startupCalled.resolve();
        return startup.promise;
      },
    });

    await harness.backend.start(harness.context, new AbortController().signal);
    await startupCalled.promise;
    await harness.backend.handleInput(harness.context, { text: "first" }, DRIVER_TEST_IDS.runId);
    expect(warmSignal?.aborted).toBe(true);

    startup.resolve({
      close: () => warmClosed.resolve(),
      query: () => {
        warmQueries += 1;
        return fakeQuery([resultMessage("stale-session")]);
      },
      async [Symbol.asyncDispose]() {},
    });
    await warmClosed.promise;

    await harness.backend.handleInput(
      harness.context,
      { text: "second" },
      DRIVER_TEST_IDS.secondRunId,
    );
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(coldQueries).toBe(2);
    expect(warmQueries).toBe(0);
    expect(optionSessionIds).toEqual([null, null, "native-session-1"]);
  });

  test("stop joins a prewarm that ignores cancellation until startup settles", async () => {
    process.env[PREWARM_ENV] = "1";
    const startup = Promise.withResolvers<WarmQuery>();
    const startupCalled = Promise.withResolvers<void>();
    const processExit = Promise.withResolvers<void>();
    const warmClosed = Promise.withResolvers<void>();
    let warmSignal: AbortSignal | undefined;
    const harness = createHarness({
      createQueryOptions: async (input) => {
        input.processTasks?.add(processExit.promise);
        const releaseProcess = () => input.processTasks?.delete(processExit.promise);
        void processExit.promise.then(releaseProcess, releaseProcess);
        return { abortController: input.abortController };
      },
      query: () => fakeQuery([resultMessage()]),
      startup: async ({ options } = {}) => {
        warmSignal = options?.abortController?.signal;
        startupCalled.resolve();
        return startup.promise;
      },
    });

    await harness.backend.start(harness.context, new AbortController().signal);
    await startupCalled.promise;
    let stopped = false;
    const stopping = harness.backend
      .stop(harness.context, "test.stop", new AbortController().signal)
      .then(() => {
        stopped = true;
      });
    expect(warmSignal?.aborted).toBe(true);
    await nextEventLoopTurn();
    expect(stopped).toBe(false);

    startup.resolve({
      close: () => warmClosed.resolve(),
      query: () => fakeQuery([resultMessage()]),
      async [Symbol.asyncDispose]() {},
    });
    await warmClosed.promise;
    await nextEventLoopTurn();
    expect(stopped).toBe(false);
    processExit.resolve();
    await stopping;
    await harness.logger.destroy();
  });

  test("stop joins a cooperatively aborted prewarm", async () => {
    process.env[PREWARM_ENV] = "1";
    const startupCalled = Promise.withResolvers<void>();
    let warmSignal: AbortSignal | undefined;
    const harness = createHarness({
      createQueryOptions: async (input) => ({ abortController: input.abortController }),
      query: () => fakeQuery([resultMessage()]),
      startup: ({ options } = {}) => {
        warmSignal = options?.abortController?.signal;
        startupCalled.resolve();
        return new Promise<WarmQuery>((_resolve, reject) => {
          const onAbort = () => reject(new Error("prewarm aborted"));
          warmSignal?.addEventListener("abort", onAbort, { once: true });
          if (warmSignal?.aborted) {
            onAbort();
          }
        });
      },
    });

    await harness.backend.start(harness.context, new AbortController().signal);
    await startupCalled.promise;
    await expect(
      harness.backend.stop(harness.context, "test.stop", new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(warmSignal?.aborted).toBe(true);
    await harness.logger.destroy();
  });

  test("stop fails at its deadline and can retry when prewarm later settles", async () => {
    process.env[PREWARM_ENV] = "1";
    const startup = Promise.withResolvers<WarmQuery>();
    const startupCalled = Promise.withResolvers<void>();
    let closes = 0;
    const harness = createHarness({
      createQueryOptions: async (input) => ({ abortController: input.abortController }),
      query: () => fakeQuery([resultMessage()]),
      startup: async () => {
        startupCalled.resolve();
        return startup.promise;
      },
    });
    const deadline = new AbortController();
    const deadlineError = new Error("stop deadline elapsed");

    await harness.backend.start(harness.context, new AbortController().signal);
    await startupCalled.promise;
    const stopping = harness.backend.stop(harness.context, "test.stop", deadline.signal);
    await nextEventLoopTurn();
    deadline.abort(deadlineError);

    await expect(stopping).rejects.toBe(deadlineError);
    const retry = harness.backend.stop(
      harness.context,
      "test.stop.retry",
      new AbortController().signal,
    );
    startup.resolve({
      close: () => {
        closes += 1;
      },
      query: () => fakeQuery([resultMessage()]),
      async [Symbol.asyncDispose]() {},
    });
    await expect(retry).resolves.toBeUndefined();
    expect(closes).toBe(1);
    await harness.logger.destroy();
  });

  test("stop consumes a late prewarm rejection", async () => {
    process.env[PREWARM_ENV] = "1";
    const startup = Promise.withResolvers<WarmQuery>();
    const startupCalled = Promise.withResolvers<void>();
    const harness = createHarness({
      createQueryOptions: async (input) => ({ abortController: input.abortController }),
      query: () => fakeQuery([resultMessage()]),
      startup: async () => {
        startupCalled.resolve();
        return startup.promise;
      },
    });

    await harness.backend.start(harness.context, new AbortController().signal);
    await startupCalled.promise;
    const stopping = harness.backend.stop(
      harness.context,
      "test.stop",
      new AbortController().signal,
    );
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await nextEventLoopTurn();
    expect(stopped).toBe(false);
    startup.reject(new Error("late startup failure"));

    await expect(stopping).resolves.toBeUndefined();
    await harness.logger.destroy();
  });

  test("stop propagates a rejected prewarm process cleanup", async () => {
    process.env[PREWARM_ENV] = "1";
    const startupCalled = Promise.withResolvers<void>();
    const processExit = Promise.withResolvers<void>();
    const cleanupError = new Error("prewarm process cleanup failed");
    let cleanupRetries = 0;
    const harness = createHarness({
      createQueryOptions: async (input) => {
        input.processTasks?.add(processExit.promise);
        registerClaudeTaskRetry(processExit.promise, async () => {
          cleanupRetries += 1;
        });
        return { abortController: input.abortController };
      },
      query: () => fakeQuery([resultMessage()]),
      startup: async () => {
        startupCalled.resolve();
        return {
          close: () => {},
          query: () => fakeQuery([resultMessage()]),
          async [Symbol.asyncDispose]() {},
        };
      },
    });

    await harness.backend.start(harness.context, new AbortController().signal);
    await startupCalled.promise;
    await nextEventLoopTurn();
    const stopping = harness.backend.stop(
      harness.context,
      "test.stop",
      new AbortController().signal,
    );
    await nextEventLoopTurn();
    processExit.reject(cleanupError);

    await expect(stopping).rejects.toBe(cleanupError);
    await expect(
      harness.backend.stop(harness.context, "test.stop.retry", new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(cleanupRetries).toBe(1);
    await harness.logger.destroy();
  });

  test("retains a spontaneous prewarm process cleanup rejection", async () => {
    process.env[PREWARM_ENV] = "1";
    const startupCalled = Promise.withResolvers<void>();
    const processExit = Promise.withResolvers<void>();
    const cleanupError = new Error("spontaneous prewarm cleanup failed");
    const harness = createHarness({
      createQueryOptions: async (input) => {
        input.processTasks?.add(processExit.promise);
        return { abortController: input.abortController };
      },
      query: () => fakeQuery([resultMessage()]),
      startup: async () => {
        startupCalled.resolve();
        throw new Error("prewarm startup failed");
      },
    });

    await harness.backend.start(harness.context, new AbortController().signal);
    await startupCalled.promise;
    processExit.reject(cleanupError);
    await nextEventLoopTurn();
    await nextEventLoopTurn();

    await expect(
      harness.backend.stop(harness.context, "test.stop", new AbortController().signal),
    ).rejects.toBe(cleanupError);
    await harness.logger.destroy();
  });

  test("concurrent stops share the same prewarm join", async () => {
    process.env[PREWARM_ENV] = "1";
    const startup = Promise.withResolvers<WarmQuery>();
    const startupCalled = Promise.withResolvers<void>();
    let closes = 0;
    const harness = createHarness({
      createQueryOptions: async (input) => ({ abortController: input.abortController }),
      query: () => fakeQuery([resultMessage()]),
      startup: async () => {
        startupCalled.resolve();
        return startup.promise;
      },
    });

    await harness.backend.start(harness.context, new AbortController().signal);
    await startupCalled.promise;
    const first = harness.backend.stop(
      harness.context,
      "test.stop.first",
      new AbortController().signal,
    );
    const second = harness.backend.stop(
      harness.context,
      "test.stop.second",
      new AbortController().signal,
    );
    expect(second).toBe(first);
    let stopped = false;
    void first.then(() => {
      stopped = true;
    });
    await nextEventLoopTurn();
    expect(stopped).toBe(false);
    startup.resolve({
      close: () => {
        closes += 1;
      },
      query: () => fakeQuery([resultMessage()]),
      async [Symbol.asyncDispose]() {},
    });

    await Promise.all([first, second]);
    expect(closes).toBe(1);
    await harness.logger.destroy();
  });

  test("stop drains prewarm cleanup after active turn cleanup fails", async () => {
    process.env[PREWARM_ENV] = "1";
    const activeCleanupError = new Error("active process cleanup failed");
    const activeCleanupStarted = Promise.withResolvers<void>();
    const activeProcessExit = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const prewarmProcessExit = Promise.withResolvers<void>();
    const prewarmStartup = Promise.withResolvers<WarmQuery>();
    const prewarmStartupCalled = Promise.withResolvers<void>();
    const queryCreated = Promise.withResolvers<void>();
    const warmClosed = Promise.withResolvers<void>();
    let optionCalls = 0;
    let stopSettled = false;
    const harness = createHarness({
      createQueryOptions: async (input) => {
        optionCalls += 1;
        input.processTasks?.add(
          optionCalls === 1 ? prewarmProcessExit.promise : activeProcessExit.promise,
        );
        return { abortController: input.abortController };
      },
      query: () => {
        queryCreated.resolve();
        return fakeQuery(
          (async function* () {
            await closed.promise;
            yield* [] as SDKMessage[];
          })(),
          () => closed.resolve(),
          async () => undefined,
          async () => activeCleanupStarted.resolve(),
        );
      },
      startup: async () => {
        prewarmStartupCalled.resolve();
        return prewarmStartup.promise;
      },
    });

    await harness.backend.start(harness.context, new AbortController().signal);
    await prewarmStartupCalled.promise;
    const handling = harness.backend.handleInput(
      harness.context,
      { text: "wait" },
      DRIVER_TEST_IDS.runId,
    );
    await queryCreated.promise;

    const stopping = harness.backend.stop(
      harness.context,
      "test.stop",
      new AbortController().signal,
    );
    void stopping.then(
      () => {
        stopSettled = true;
      },
      () => {
        stopSettled = true;
      },
    );
    await activeCleanupStarted.promise;
    const settled = Promise.allSettled([stopping, handling]);
    activeProcessExit.reject(activeCleanupError);
    await nextEventLoopTurn();
    expect(stopSettled).toBe(false);

    prewarmStartup.resolve({
      close: () => warmClosed.resolve(),
      query: () => fakeQuery([resultMessage()]),
      async [Symbol.asyncDispose]() {},
    });
    await warmClosed.promise;
    await nextEventLoopTurn();
    expect(stopSettled).toBe(false);

    prewarmProcessExit.resolve();
    expect(await settled).toEqual([
      { reason: activeCleanupError, status: "rejected" },
      { reason: activeCleanupError, status: "rejected" },
    ]);
    await harness.logger.destroy();

    expect(
      harness.events.some((event) =>
        ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
      ),
    ).toBe(false);
  });

  test.each(["cancel", "stop"] as const)(
    "%s during query option creation prevents the subprocess from starting",
    async (action) => {
      delete process.env[PREWARM_ENV];
      const options = Promise.withResolvers<ClaudeQueryOptions>();
      const optionsRequested = Promise.withResolvers<void>();
      let queryCalls = 0;
      const harness = createHarness({
        createQueryOptions: async () => {
          optionsRequested.resolve();
          return options.promise;
        },
        query: () => {
          queryCalls += 1;
          return fakeQuery([resultMessage()]);
        },
        startup: async () => {
          throw new Error("prewarm is disabled");
        },
      });
      const handling = harness.backend.handleInput(
        harness.context,
        { text: "hello" },
        DRIVER_TEST_IDS.runId,
      );
      await optionsRequested.promise;

      if (action === "cancel") {
        await harness.backend.cancelActiveTurn(harness.context, "test.cancel");
      } else {
        await harness.backend.stop(harness.context, "test.stop", new AbortController().signal);
      }
      options.resolve({});

      await expect(handling).rejects.toBeInstanceOf(DriverTurnCancelledError);
      expect(queryCalls).toBe(0);
      expect(
        harness.events.filter((event) =>
          ["run.started", "run.cancelled", "run.completed", "run.failed"].includes(event.kind),
        ),
      ).toMatchObject([
        { kind: "run.started", runId: DRIVER_TEST_IDS.runId },
        { kind: "run.cancelled", runId: DRIVER_TEST_IDS.runId },
      ]);
      await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
      await harness.logger.destroy();
    },
  );

  test("publishes run.started before a query option failure terminal", async () => {
    delete process.env[PREWARM_ENV];
    const harness = createHarness({
      createQueryOptions: async () => {
        throw new Error("query options failed");
      },
      query: () => fakeQuery([resultMessage()]),
      startup: async () => {
        throw new Error("prewarm is disabled");
      },
    });

    await expect(
      harness.backend.handleInput(harness.context, { text: "hello" }, DRIVER_TEST_IDS.runId),
    ).rejects.toThrow("query options failed");
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(
      harness.events.filter((event) =>
        ["run.started", "run.cancelled", "run.completed", "run.failed"].includes(event.kind),
      ),
    ).toMatchObject([
      { kind: "run.started", runId: DRIVER_TEST_IDS.runId },
      { kind: "run.failed", runId: DRIVER_TEST_IDS.runId },
    ]);
  });

  test("drains a spawned process when query creation fails", async () => {
    delete process.env[PREWARM_ENV];
    const queryCalled = Promise.withResolvers<void>();
    const processExit = Promise.withResolvers<void>();
    let processExited = false;
    let processTasks: Set<Promise<void>> | undefined;
    const harness = createHarness(
      {
        createQueryOptions: async (input) => {
          processTasks = input.processTasks;
          return {};
        },
        query: () => {
          const processTask = processExit.promise.then(() => {
            processExited = true;
          });
          processTasks?.add(processTask);
          const releaseProcess = () => processTasks?.delete(processTask);
          void processTask.then(releaseProcess, releaseProcess);
          queryCalled.resolve();
          throw new Error("query creation failed");
        },
        startup: async () => {
          throw new Error("prewarm is disabled");
        },
      },
      (events) => {
        if (events.some((event) => event.kind === "run.failed")) {
          expect(processExited).toBe(true);
        }
      },
    );

    const handling = harness.backend.handleInput(
      harness.context,
      { text: "hello" },
      DRIVER_TEST_IDS.runId,
    );
    await queryCalled.promise;
    await nextEventLoopTurn();
    expect(harness.events.some((event) => event.kind === "run.failed")).toBe(false);

    processExit.resolve();
    await expect(handling).rejects.toThrow("query creation failed");
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(processTasks?.size).toBe(0);
    expect(harness.events.some((event) => event.kind === "run.failed")).toBe(true);
  });

  test("does not create a query when publishing run.started fails", async () => {
    delete process.env[PREWARM_ENV];
    let queryCalls = 0;
    let rejectStarted = true;
    const harness = createHarness(
      {
        createQueryOptions: async () => ({}),
        query: () => {
          queryCalls += 1;
          return fakeQuery([resultMessage()]);
        },
        startup: async () => {
          throw new Error("prewarm is disabled");
        },
      },
      (events) => {
        if (rejectStarted && events.some((event) => event.kind === "run.started")) {
          rejectStarted = false;
          throw new Error("event sink unavailable");
        }
      },
    );

    await expect(
      harness.backend.handleInput(harness.context, { text: "hello" }, DRIVER_TEST_IDS.runId),
    ).rejects.toThrow("event sink unavailable");
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(queryCalls).toBe(0);
    expect(
      harness.events.some((event) =>
        ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
      ),
    ).toBe(false);
  });

  test("awaits query and process cleanup before publishing a completed terminal", async () => {
    delete process.env[PREWARM_ENV];
    const cleanupStarted = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const releaseProcess = Promise.withResolvers<void>();
    const releaseLateProcess = Promise.withResolvers<void>();
    let cleanupFinished = false;
    let lateProcessExited = false;
    let processExited = false;
    const harness = createHarness(
      {
        createQueryOptions: async (input) => {
          const processTask = releaseProcess.promise.then(() => {
            processExited = true;
            const lateProcessTask = releaseLateProcess.promise.then(() => {
              lateProcessExited = true;
            });
            input.processTasks?.add(lateProcessTask);
          });
          input.processTasks?.add(processTask);
          return {};
        },
        query: () =>
          fakeQuery(
            [resultMessage()],
            () => {},
            async () => undefined,
            async () => {
              cleanupStarted.resolve();
              await releaseCleanup.promise;
              cleanupFinished = true;
            },
          ),
        startup: async () => {
          throw new Error("prewarm is disabled");
        },
      },
      (events) => {
        if (events.some((event) => event.kind === "run.completed")) {
          expect(cleanupFinished).toBe(true);
          expect(lateProcessExited).toBe(true);
          expect(processExited).toBe(true);
        }
      },
    );

    const handling = harness.backend.handleInput(
      harness.context,
      { text: "finish" },
      DRIVER_TEST_IDS.runId,
    );
    await cleanupStarted.promise;
    expect(harness.events.some((event) => event.kind === "run.completed")).toBe(false);
    releaseCleanup.resolve();
    await nextEventLoopTurn();
    expect(harness.events.some((event) => event.kind === "run.completed")).toBe(false);
    releaseProcess.resolve();
    await nextEventLoopTurn();
    expect(harness.events.some((event) => event.kind === "run.completed")).toBe(false);
    releaseLateProcess.resolve();
    await handling;
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(harness.events.some((event) => event.kind === "run.completed")).toBe(true);
  });

  test("stop joins final result cleanup and propagates its failure", async () => {
    delete process.env[PREWARM_ENV];
    const cleanupError = new Error("final result process cleanup failed");
    const cleanupStarted = Promise.withResolvers<void>();
    const processExit = Promise.withResolvers<void>();
    let cleanupRetries = 0;
    let stopSettled = false;
    const harness = createHarness({
      createQueryOptions: async ({ processTasks }) => {
        processTasks?.add(processExit.promise);
        registerClaudeTaskRetry(processExit.promise, async () => {
          cleanupRetries += 1;
        });
        return {};
      },
      query: () =>
        fakeQuery(
          [resultMessage()],
          () => {},
          async () => undefined,
          async () => cleanupStarted.resolve(),
        ),
      startup: async () => {
        throw new Error("prewarm is disabled");
      },
    });

    const handling = harness.backend.handleInput(
      harness.context,
      { text: "finish" },
      DRIVER_TEST_IDS.runId,
    );
    await cleanupStarted.promise;

    const stopping = harness.backend.stop(
      harness.context,
      "test.stop",
      new AbortController().signal,
    );
    void stopping.then(
      () => {
        stopSettled = true;
      },
      () => {
        stopSettled = true;
      },
    );
    await nextEventLoopTurn();
    expect(stopSettled).toBe(false);

    const settled = Promise.allSettled([stopping, handling]);
    processExit.reject(cleanupError);
    expect(await settled).toEqual([
      { reason: cleanupError, status: "rejected" },
      { reason: cleanupError, status: "rejected" },
    ]);
    await expect(
      harness.backend.stop(harness.context, "test.stop.retry", new AbortController().signal),
    ).resolves.toBeUndefined();
    await harness.logger.destroy();

    expect(cleanupRetries).toBe(1);
    expect(
      harness.events.some((event) =>
        ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
      ),
    ).toBe(false);
  });

  test.each(["permission", "process"] as const)(
    "does not publish a terminal when a %s task rejects",
    async (taskKind) => {
      delete process.env[PREWARM_ENV];
      const task = Promise.withResolvers<void>();
      const taskError = new Error(`${taskKind} task failed`);
      const harness = createHarness({
        createQueryOptions: async (input) => {
          const tasks = taskKind === "permission" ? input.permissionTasks : input.processTasks;
          tasks?.add(task.promise);
          return {};
        },
        query: () => fakeQuery([resultMessage()]),
        startup: async () => {
          throw new Error("prewarm is disabled");
        },
      });

      const handling = harness.backend.handleInput(
        harness.context,
        { text: "finish" },
        DRIVER_TEST_IDS.runId,
      );
      await nextEventLoopTurn();
      expect(
        harness.events.some((event) =>
          ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
        ),
      ).toBe(false);

      task.reject(taskError);
      await expect(handling).rejects.toBe(taskError);
      await expect(
        harness.backend.stop(harness.context, "test.complete", new AbortController().signal),
      ).resolves.toBeUndefined();
      await harness.logger.destroy();

      expect(
        harness.events.some((event) =>
          ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
        ),
      ).toBe(false);
    },
  );

  test("publishes one cancelled terminal and closes the query once", async () => {
    delete process.env[PREWARM_ENV];
    const closed = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const releaseInterrupt = Promise.withResolvers<void>();
    const releasePermissionDelivery = Promise.withResolvers<void>();
    const queryCreated = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let cleanupFinished = false;
    let permissionResolved = false;
    let turnSignal: AbortSignal | undefined;
    let closes = 0;
    const terminalOrder: string[] = [];
    const harness = createHarness(
      {
        createQueryOptions: async ({ abortController, permissionTasks }) => {
          turnSignal = abortController.signal;
          const permissionTask = releasePermissionDelivery.promise.then(() => {
            permissionResolved = true;
            terminalOrder.push("permission.resolved");
          });
          permissionTasks?.add(permissionTask);
          const releasePermission = () => permissionTasks?.delete(permissionTask);
          void permissionTask.then(releasePermission, releasePermission);
          return {};
        },
        query: () => {
          queryCreated.resolve();
          return fakeQuery(
            (async function* () {
              await closed.promise;
              yield* [] as SDKMessage[];
            })(),
            () => {
              closes += 1;
              closed.resolve();
            },
            async () => {
              interrupted.resolve();
              await releaseInterrupt.promise;
            },
            async () => {
              cleanupStarted.resolve();
              await releaseCleanup.promise;
              cleanupFinished = true;
            },
          );
        },
        startup: async () => {
          throw new Error("prewarm is disabled");
        },
      },
      (events) => {
        if (events.some((event) => event.kind === "run.started")) {
          started.resolve();
        }
        if (events.some((event) => event.kind === "run.cancelled")) {
          expect(cleanupFinished).toBe(true);
          expect(permissionResolved).toBe(true);
          terminalOrder.push("run.cancelled");
        }
      },
    );
    const handling = harness.backend.handleInput(
      harness.context,
      { text: "wait" },
      DRIVER_TEST_IDS.runId,
    );
    await started.promise;
    await queryCreated.promise;

    const cancellation = harness.backend.cancelActiveTurn(harness.context, "test.cancel");
    await interrupted.promise;
    expect(turnSignal?.aborted).toBe(false);
    expect(closes).toBe(0);
    releaseInterrupt.resolve();
    await cleanupStarted.promise;
    expect(turnSignal?.aborted).toBe(true);
    expect(harness.events.some((event) => event.kind === "run.cancelled")).toBe(false);
    releaseCleanup.resolve();
    await nextEventLoopTurn();
    expect(harness.events.some((event) => event.kind === "run.cancelled")).toBe(false);
    releasePermissionDelivery.resolve();
    await cancellation;
    await expect(handling).rejects.toBeInstanceOf(DriverTurnCancelledError);
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(closes).toBe(1);
    expect(
      harness.events.filter((event) =>
        ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
      ),
    ).toMatchObject([{ kind: "run.cancelled", runId: DRIVER_TEST_IDS.runId }]);
    expect(terminalOrder).toEqual(["permission.resolved", "run.cancelled"]);
  });

  test("stop joins an in-flight cancellation and propagates its cleanup failure", async () => {
    delete process.env[PREWARM_ENV];
    const closed = Promise.withResolvers<void>();
    const cleanupError = new Error("provider process cleanup failed");
    const cleanupStarted = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<void>();
    const processExit = Promise.withResolvers<void>();
    const queryCreated = Promise.withResolvers<void>();
    const releaseInterrupt = Promise.withResolvers<void>();
    let cancellationSettled = false;
    let stopSettled = false;
    const harness = createHarness({
      createQueryOptions: async ({ processTasks }) => {
        processTasks?.add(processExit.promise);
        return {};
      },
      query: () => {
        queryCreated.resolve();
        return fakeQuery(
          (async function* () {
            await closed.promise;
            yield* [] as SDKMessage[];
          })(),
          () => closed.resolve(),
          async () => {
            interrupted.resolve();
            await releaseInterrupt.promise;
          },
          async () => cleanupStarted.resolve(),
        );
      },
      startup: async () => {
        throw new Error("prewarm is disabled");
      },
    });
    const handling = harness.backend.handleInput(
      harness.context,
      { text: "wait" },
      DRIVER_TEST_IDS.runId,
    );
    await queryCreated.promise;

    const cancellation = harness.backend.cancelActiveTurn(harness.context, "test.cancel");
    void cancellation.then(
      () => {
        cancellationSettled = true;
      },
      () => {
        cancellationSettled = true;
      },
    );
    await interrupted.promise;

    const stopping = harness.backend.stop(
      harness.context,
      "test.stop",
      new AbortController().signal,
    );
    void stopping.then(
      () => {
        stopSettled = true;
      },
      () => {
        stopSettled = true;
      },
    );
    await nextEventLoopTurn();
    expect(cancellationSettled).toBe(false);
    expect(stopSettled).toBe(false);

    releaseInterrupt.resolve();
    await cleanupStarted.promise;
    await nextEventLoopTurn();
    expect(cancellationSettled).toBe(false);
    expect(stopSettled).toBe(false);

    const settled = Promise.allSettled([cancellation, stopping, handling]);
    processExit.reject(cleanupError);
    expect(await settled).toEqual([
      { reason: cleanupError, status: "rejected" },
      { reason: cleanupError, status: "rejected" },
      { reason: cleanupError, status: "rejected" },
    ]);
    await harness.logger.destroy();

    expect(
      harness.events.some((event) =>
        ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
      ),
    ).toBe(false);
  });

  test("lets a dequeued result win a concurrent cancellation", async () => {
    delete process.env[PREWARM_ENV];
    const finishing = Promise.withResolvers<void>();
    const releaseFinish = Promise.withResolvers<void>();
    let closes = 0;
    const harness = createHarness(
      {
        createQueryOptions: async () => ({}),
        query: () => fakeQuery([resultMessage()], () => (closes += 1)),
        startup: async () => {
          throw new Error("prewarm is disabled");
        },
      },
      async (events) => {
        if (events.some((event) => event.kind === "run.completed")) {
          finishing.resolve();
          await releaseFinish.promise;
        }
      },
    );
    const handling = harness.backend.handleInput(
      harness.context,
      { text: "finish" },
      DRIVER_TEST_IDS.runId,
    );
    await finishing.promise;

    await harness.backend.cancelActiveTurn(harness.context, "test.cancel");
    releaseFinish.resolve();
    await expect(handling).resolves.toBeUndefined();
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(closes).toBe(1);
    expect(
      harness.events.filter((event) =>
        ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
      ),
    ).toMatchObject([{ kind: "run.completed", runId: DRIVER_TEST_IDS.runId }]);
  });

  test.each([
    { message: resultMessage(), terminal: "run.completed" },
    { message: errorResultMessage(), terminal: "run.failed" },
  ] as const)(
    "does not replace a selected $terminal provider terminal after its delivery fails",
    async ({ message, terminal }) => {
      delete process.env[PREWARM_ENV];
      const terminalAttempts: string[][] = [];
      const harness = createHarness(
        {
          createQueryOptions: async () => ({}),
          query: () => fakeQuery([message]),
          startup: async () => {
            throw new Error("prewarm is disabled");
          },
        },
        (events) => {
          const terminals = events
            .filter((event) =>
              ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
            )
            .map((event) => event.kind);
          if (terminals.length > 0) {
            terminalAttempts.push(terminals);
          }
          if (terminals.includes(terminal)) {
            throw new Error("terminal delivery unavailable");
          }
        },
      );

      await expect(
        harness.backend.handleInput(harness.context, { text: "finish" }, DRIVER_TEST_IDS.runId),
      ).rejects.toThrow("terminal delivery unavailable");
      await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
      await harness.logger.destroy();

      expect(terminalAttempts).toEqual([[terminal], [terminal]]);
    },
  );

  test("does not start a late prewarm after stop wins option creation", async () => {
    process.env[PREWARM_ENV] = "1";
    const options = Promise.withResolvers<ClaudeQueryOptions>();
    const optionsRequested = Promise.withResolvers<void>();
    const optionsReturned = Promise.withResolvers<void>();
    let startupCalls = 0;
    const harness = createHarness({
      createQueryOptions: async () => {
        optionsRequested.resolve();
        const value = await options.promise;
        optionsReturned.resolve();
        return value;
      },
      query: () => fakeQuery([resultMessage()]),
      startup: async () => {
        startupCalls += 1;
        throw new Error("late startup");
      },
    });

    await harness.backend.start(harness.context, new AbortController().signal);
    await optionsRequested.promise;
    const stopping = harness.backend.stop(
      harness.context,
      "test.stop",
      new AbortController().signal,
    );
    options.resolve({});
    await stopping;
    await optionsReturned.promise;
    await Promise.resolve();
    await harness.logger.destroy();

    expect(startupCalls).toBe(0);
  });

  test("fails a turn when its native session changes", async () => {
    delete process.env[PREWARM_ENV];
    let queryIndex = 0;
    const harness = createHarness({
      createQueryOptions: async () => ({}),
      query: () => fakeQuery([resultMessage(`native-session-${(queryIndex += 1)}`)]),
      startup: async () => {
        throw new Error("prewarm is disabled");
      },
    });

    await harness.backend.handleInput(harness.context, { text: "first" }, DRIVER_TEST_IDS.runId);
    await expect(
      harness.backend.handleInput(harness.context, { text: "second" }, DRIVER_TEST_IDS.secondRunId),
    ).rejects.toThrow("different native session");
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(
      harness.events.filter((event) =>
        ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
      ),
    ).toMatchObject([
      { kind: "run.completed", runId: DRIVER_TEST_IDS.runId },
      { kind: "run.failed", runId: DRIVER_TEST_IDS.secondRunId },
    ]);
  });

  test("adopts a conversation reset as the next native resume session", async () => {
    delete process.env[PREWARM_ENV];
    let queryIndex = 0;
    const optionSessionIds: Array<string | null> = [];
    const harness = createHarness({
      createQueryOptions: async (input) => {
        optionSessionIds.push(input.nativeSessionId);
        return {};
      },
      query: () => {
        queryIndex += 1;
        return queryIndex === 1
          ? fakeQuery([resultMessage("native-session-1")])
          : fakeQuery([
              {
                event: { message: { id: "old-message" }, type: "message_start" },
                parent_tool_use_id: null,
                session_id: "native-session-1",
                type: "stream_event",
                uuid: "old-stream",
              } as unknown as SDKMessage,
              {
                new_conversation_id: "native-session-2",
                session_id: "native-session-1",
                type: "conversation_reset",
                uuid: "reset-1",
              } as unknown as SDKMessage,
              resultMessage("native-session-2"),
            ]);
      },
      startup: async () => {
        throw new Error("prewarm is disabled");
      },
    });

    await harness.backend.handleInput(harness.context, { text: "first" }, DRIVER_TEST_IDS.runId);
    await harness.backend.handleInput(
      harness.context,
      { text: "second" },
      DRIVER_TEST_IDS.secondRunId,
    );
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(optionSessionIds).toEqual([null, "native-session-1"]);
    expect(
      harness.events.flatMap((event) => {
        if (
          event.kind !== "runtime.resume.updated" ||
          !isRecord(event.payload) ||
          typeof event.payload["resumePointer"] !== "string"
        ) {
          return [];
        }
        return [event.payload["resumePointer"]];
      }),
    ).toEqual(["native-session-1", "native-session-2"]);
    expect(harness.events.some(({ kind }) => kind === "message.cancelled")).toBe(true);
    expect(harness.events.filter(({ kind }) => kind === "run.completed")).toHaveLength(2);
  });

  test("requires one result frame and ignores provider frames after it", async () => {
    delete process.env[PREWARM_ENV];
    let queryIndex = 0;
    let lateFrameRead = false;
    const harness = createHarness({
      createQueryOptions: async () => ({}),
      query: () => {
        queryIndex += 1;

        if (queryIndex === 1) {
          return fakeQuery([]);
        }

        return fakeQuery(
          (async function* () {
            yield resultMessage();
            lateFrameRead = true;
            yield {
              message: { content: [{ text: "late", type: "text" }] },
              parent_tool_use_id: null,
              session_id: "native-session-1",
              type: "assistant",
              uuid: "late-assistant",
            } as unknown as SDKMessage;
          })(),
        );
      },
      startup: async () => {
        throw new Error("prewarm is disabled");
      },
    });

    await expect(
      harness.backend.handleInput(harness.context, { text: "empty" }, DRIVER_TEST_IDS.runId),
    ).rejects.toThrow("ended before a result frame");
    expect(harness.events.some((event) => event.kind === "run.completed")).toBe(false);

    await harness.backend.handleInput(
      harness.context,
      { text: "terminal" },
      DRIVER_TEST_IDS.secondRunId,
    );
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(lateFrameRead).toBe(false);
    expect(
      harness.events.some(
        (event) =>
          event.kind === "message.delta" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          "contentDelta" in event.payload &&
          event.payload.contentDelta === "late",
      ),
    ).toBe(false);
  });

  function recoveryPayload(
    recoveryMessages: DriverStartInput["execution"]["session"]["recoveryMessages"],
    nativeResumeRef: DriverStartInput["execution"]["session"]["nativeResumeRef"] = null,
  ): DriverStartInput {
    const base = {
      ...bootPayload,
      runtime: "claude-agent-sdk",
      runtimeTransport: "claude-agent-sdk",
    } as DriverStartInput;

    return {
      ...base,
      execution: {
        ...base.execution,
        session: {
          ...base.execution.session,
          nativeResumeRef,
          recoveryMessages,
        },
      },
    };
  }

  test("replays recovery messages in the first prompt when no native session exists", async () => {
    const prompts: string[] = [];
    const harness = createHarness(
      {
        createQueryOptions: async (input) =>
          ({ abortController: input.abortController }) as ClaudeQueryOptions,
        query: (input) => {
          prompts.push(String(input.prompt));
          return fakeQuery([resultMessage()]);
        },
        startup: async () => {
          throw new Error("prewarm is disabled");
        },
      },
      undefined,
      recoveryPayload([
        { content: "make a deck", role: "user" },
        { content: "deck saved to outputs/presentation/index.html", role: "assistant" },
      ]),
    );

    await harness.backend.handleInput(
      harness.context,
      { text: "add a page" },
      DRIVER_TEST_IDS.runId,
    );
    await harness.backend.handleInput(
      harness.context,
      { text: "now polish it" },
      DRIVER_TEST_IDS.secondRunId,
    );
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("<conversation_history>");
    expect(prompts[0]).toContain("[user]: make a deck");
    expect(prompts[0]).toContain("[assistant]: deck saved to outputs/presentation/index.html");
    expect(prompts[0]?.endsWith("add a page")).toBe(true);
    // The first turn established a native session, so the second turn resumes
    // natively and must not replay history again.
    expect(prompts[1]).toBe("now polish it");
  });

  test("does not replay recovery messages when a native resume ref is present", async () => {
    const prompts: string[] = [];
    const harness = createHarness(
      {
        createQueryOptions: async (input) =>
          ({ abortController: input.abortController }) as ClaudeQueryOptions,
        query: (input) => {
          prompts.push(String(input.prompt));
          return fakeQuery([resultMessage()]);
        },
        startup: async () => {
          throw new Error("prewarm is disabled");
        },
      },
      undefined,
      recoveryPayload([{ content: "make a deck", role: "user" }], {
        kind: "claude_session_id",
        runtimeId: "claude-agent-sdk",
        value: "native-session-1",
      }),
    );

    await harness.backend.handleInput(
      harness.context,
      { text: "add a page" },
      DRIVER_TEST_IDS.runId,
    );
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(prompts).toEqual(["add a page"]);
  });
});
