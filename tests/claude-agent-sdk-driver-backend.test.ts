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
import type { DriverStartInput } from "../src/protocol/start";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { ClaudeAgentSdkDriverBackend } from "../src/runtimes/claude/agent-sdk-driver-backend";
import { bootPayload, DRIVER_TEST_IDS } from "./driver-runtime-boundary-fixtures";

const PREWARM_ENV = "AGENT_DRIVER_CLAUDE_PREWARM";
const previousPrewarm = process.env[PREWARM_ENV];

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
): Query {
  const source =
    Symbol.asyncIterator in Object(messages)
      ? (messages as AsyncIterable<SDKMessage>)
      : (async function* () {
          yield* messages as readonly SDKMessage[];
        })();
  const iterator = source[Symbol.asyncIterator]();

  return Object.assign(iterator, { close }) as Query;
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(
  dependencies: ConstructorParameters<typeof ClaudeAgentSdkDriverBackend>[1],
  beforePush?: (events: readonly DriverEventInput[]) => Promise<void> | void,
) {
  const events: DriverEventInput[] = [];
  let seq = 0;
  const logger = createBufferedSinkLogger({
    level: "error",
    service: "claude-agent-sdk-driver-backend-test",
    sink: async () => {},
  });
  const payload = {
    ...bootPayload,
    runtime: "claude-agent-sdk",
    runtimeTransport: "claude-agent-sdk",
  } as DriverStartInput;
  const context = createAgentDriverContext({
    eventSink: {
      pushEvents: async ({ events: batch }) => {
        await beforePush?.(batch);
        events.push(...batch);
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
    const warmClosed = Promise.withResolvers<void>();
    let warmSignal: AbortSignal | undefined;
    const harness = createHarness({
      createQueryOptions: async (input) => ({ abortController: input.abortController }),
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
    await stopping;
    await warmClosed.promise;
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
          ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
        ),
      ).toMatchObject([{ kind: "run.cancelled", runId: DRIVER_TEST_IDS.runId }]);
      await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
      await harness.logger.destroy();
    },
  );

  test("closes an owned query when publishing run.started fails", async () => {
    delete process.env[PREWARM_ENV];
    let closes = 0;
    let rejectStarted = true;
    const harness = createHarness(
      {
        createQueryOptions: async () => ({}),
        query: () => fakeQuery([resultMessage()], () => (closes += 1)),
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

    expect(closes).toBe(1);
  });

  test("publishes one cancelled terminal and closes the query once", async () => {
    delete process.env[PREWARM_ENV];
    const closed = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let closes = 0;
    const harness = createHarness(
      {
        createQueryOptions: async () => ({}),
        query: () =>
          fakeQuery(
            (async function* () {
              await closed.promise;
              yield* [] as SDKMessage[];
            })(),
            () => {
              closes += 1;
              closed.resolve();
            },
          ),
        startup: async () => {
          throw new Error("prewarm is disabled");
        },
      },
      (events) => {
        if (events.some((event) => event.kind === "run.started")) {
          started.resolve();
        }
      },
    );
    const handling = harness.backend.handleInput(
      harness.context,
      { text: "wait" },
      DRIVER_TEST_IDS.runId,
    );
    await started.promise;

    await harness.backend.cancelActiveTurn(harness.context, "test.cancel");
    await expect(handling).rejects.toBeInstanceOf(DriverTurnCancelledError);
    await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
    await harness.logger.destroy();

    expect(closes).toBe(1);
    expect(
      harness.events.filter((event) =>
        ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
      ),
    ).toMatchObject([{ kind: "run.cancelled", runId: DRIVER_TEST_IDS.runId }]);
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
      let rejectTerminal = true;
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
          if (rejectTerminal && terminals.includes(terminal)) {
            rejectTerminal = false;
            throw new Error("terminal delivery unavailable");
          }
        },
      );

      await expect(
        harness.backend.handleInput(harness.context, { text: "finish" }, DRIVER_TEST_IDS.runId),
      ).rejects.toThrow("terminal delivery unavailable");
      await harness.backend.stop(harness.context, "test.complete", new AbortController().signal);
      await harness.logger.destroy();

      expect(terminalAttempts).toEqual([[terminal]]);
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
});
