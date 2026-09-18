import { afterEach, describe, expect, test } from "bun:test";

import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { DriverTurnCancelledError } from "../src/core/driver-runtime-state";
import { createDisabledLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import type { DriverStartInput } from "../src/protocol/start";
import { ClaudeAgentSdkDriverBackend } from "../src/runtimes/claude/agent-sdk-driver-backend";
import type { createClaudeQueryOptions } from "../src/runtimes/claude/agent-sdk-query-options";
import { registerClaudeTaskRetry } from "../src/runtimes/claude/agent-sdk-tasks";
import { bootPayload, DRIVER_TEST_IDS } from "./driver-runtime-boundary-fixtures";

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

function result(prompt?: SDKUserMessage, count = 1): SDKMessage {
  return {
    duration_api_ms: 1,
    duration_ms: 1,
    is_error: false,
    modelUsage: {
      model: {
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: count,
        contextWindow: 200_000,
        costUSD: count / 10,
        inputTokens: count * 10,
        maxOutputTokens: 1_024,
        outputTokens: count,
        webSearchRequests: 0,
      },
    },
    num_turns: 1,
    permission_denials: [],
    result: "done",
    session_id: "native-session-1",
    stop_reason: "end_turn",
    subtype: "success",
    total_cost_usd: count / 10,
    type: "result",
    usage: {},
    user_message_uuid: prompt?.uuid,
    uuid: `result-${count}`,
  } as unknown as SDKMessage;
}

type OptionsInput = Parameters<typeof createClaudeQueryOptions>[0];

function harness(
  options: {
    respond?: (prompt: SDKUserMessage, turn: number) => AsyncIterable<SDKMessage>;
    prepare?: (input: OptionsInput) => Promise<void> | void;
    beforePush?: (events: readonly DriverEventInput[]) => Promise<void> | void;
    afterInput?: () => AsyncIterable<SDKMessage>;
    waitForTranscript?: (signal: AbortSignal) => Promise<boolean>;
  } = {},
) {
  const events: DriverEventInput[] = [];
  const prompts: SDKUserMessage[] = [];
  const preparations: OptionsInput[] = [];
  const exits: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  let currentRunId: RunId | null = null;
  let seq = 0;
  let creates = 0;
  let closes = 0;
  const payload = {
    ...bootPayload,
    execution: { ...bootPayload.execution, providerOptions: {} },
    runtime: "claude-agent-sdk",
    runtimeTransport: "claude-agent-sdk",
  } as DriverStartInput;
  const context = createAgentDriverContext({
    eventSink: {
      currentRunId: () => currentRunId,
      pushEvents: async ({ events: batch }) => {
        await options.beforePush?.(batch);
        events.push(...batch);
        return {
          accepted: batch.map((event) => ({
            eventId: event.sourceEventId!,
            seq: ++seq,
            type: event.kind,
          })),
        };
      },
    },
    logger: createDisabledLogger(),
    payload,
    permission: { request: async () => "allow_once" },
    ports: { skill: { materialize: async () => [] } },
  });
  const backend = new ClaudeAgentSdkDriverBackend(payload, {
    createQueryOptions: async (input) => {
      preparations.push(input);
      await options.prepare?.(input);
      return {};
    },
    query: ({ prompt }) => {
      expect(typeof prompt).not.toBe("string");
      creates += 1;
      const exit = Promise.withResolvers<void>();
      exits.push(exit);
      let closed = false;
      const output = (async function* () {
        for await (const input of prompt as AsyncIterable<SDKUserMessage>) {
          prompts.push(input);
          if (options.respond === undefined) {
            yield result(input, prompts.length);
          } else {
            yield* options.respond(input, prompts.length);
          }
        }
        if (options.afterInput !== undefined) {
          yield* options.afterInput();
        }
      })();
      return Object.assign(output, {
        close: () => {
          if (!closed) {
            closed = true;
            closes += 1;
            exit.resolve();
          }
        },
      }) as Query;
    },
    startup: async () => {
      throw new Error("unexpected prewarm");
    },
    waitForTranscript: (_configDir, _cursor, signal) =>
      options.waitForTranscript?.(signal) ?? Promise.resolve(true),
  });
  const stop = () => backend.stop(context, "test.stop", new AbortController().signal);
  stops.push(stop);
  return {
    backend,
    context,
    events,
    exits,
    preparations,
    prompts,
    get creates() {
      return creates;
    },
    get closes() {
      return closes;
    },
    run: async (runId: RunId, signal?: AbortSignal) => {
      currentRunId = runId;
      try {
        await backend.handleInput(context, { text: runId }, runId, signal);
      } finally {
        currentRunId = null;
      }
    },
    stop,
  };
}

describe("Claude persistent query", () => {
  test("stop during the transcript wait closes the process and preserves the selected result", async () => {
    const waiting = Promise.withResolvers<void>();
    const h = harness({
      waitForTranscript: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          waiting.resolve();
        }),
    });
    const running = h.run(DRIVER_TEST_IDS.runId);
    await waiting.promise;
    await h.stop();
    await running;
    expect(h.closes).toBe(1);
    expect(
      h.events
        .filter((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.kind))
        .map((event) => event.kind),
    ).toEqual(["run.completed"]);
  });
  test("does not publish completion or accept another input before transcript persistence", async () => {
    const persistence = Promise.withResolvers<boolean>();
    const waiting = Promise.withResolvers<void>();
    const h = harness({
      waitForTranscript: () => {
        waiting.resolve();
        return persistence.promise;
      },
    });
    const running = h.run(DRIVER_TEST_IDS.runId);
    await waiting.promise;
    expect(h.events.some((event) => event.kind === "run.completed")).toBe(false);
    await expect(
      h.backend.handleInput(h.context, { text: "overlap" }, DRIVER_TEST_IDS.secondRunId),
    ).rejects.toThrow("already has an active turn");
    persistence.resolve(true);
    await running;
    expect(h.closes).toBe(0);
    expect(h.events.some((event) => event.kind === "run.completed")).toBe(true);
  });

  test("unconfirmed transcript persistence drains and recycles the query before completion", async () => {
    const h = harness({
      waitForTranscript: async () => false,
      beforePush: (events) => {
        if (events.some((event) => event.kind === "run.completed")) {
          expect(h.closes).toBe(h.creates);
        }
      },
    });
    await h.run(DRIVER_TEST_IDS.runId);
    await h.run(DRIVER_TEST_IDS.secondRunId);
    expect(h.creates).toBe(2);
    expect(h.preparations[1]?.nativeSessionId).toBe("native-session-1");
  });

  test("reuses one process and reports only each Run's incremental usage", async () => {
    const h = harness();
    await h.run(DRIVER_TEST_IDS.runId);
    await h.run(DRIVER_TEST_IDS.secondRunId);
    expect(h.creates).toBe(1);
    expect(h.preparations).toHaveLength(1);
    expect(h.closes).toBe(0);
    expect(h.prompts.map((prompt) => prompt.message.content)).toEqual([
      DRIVER_TEST_IDS.runId,
      DRIVER_TEST_IDS.secondRunId,
    ]);
    expect(
      h.events.filter((event) => event.kind === "run.completed").map((event) => event.runId),
    ).toEqual([DRIVER_TEST_IDS.runId, DRIVER_TEST_IDS.secondRunId]);
    const usage = h.events.filter((event) => event.kind === "usage.updated");
    expect(usage).toHaveLength(2);
    expect(usage[0]?.payload).toMatchObject({ inputTokens: 10, outputTokens: 1, costAmount: 0.1 });
    expect(usage[1]?.payload).toEqual(usage[0]?.payload);
    await h.stop();
    expect(h.closes).toBe(1);
  });

  test("keeps process cleanup owned while idle and joins it on stop", async () => {
    const cleanup = Promise.withResolvers<void>();
    const h = harness({
      prepare: ({ processTasks }) => {
        processTasks?.add(cleanup.promise);
      },
    });
    await h.run(DRIVER_TEST_IDS.runId);
    let stopped = false;
    const stopping = h.stop().then(() => {
      stopped = true;
    });
    await nextTick();
    expect(stopped).toBe(false);
    expect(h.closes).toBe(1);
    cleanup.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  test("retains failed idle cleanup for a later stop retry", async () => {
    const cleanup = Promise.withResolvers<void>();
    let retries = 0;
    const h = harness({
      prepare: ({ processTasks }) => {
        processTasks?.add(cleanup.promise);
        registerClaudeTaskRetry(cleanup.promise, async () => {
          retries += 1;
        });
      },
    });
    await h.run(DRIVER_TEST_IDS.runId);
    const stopping = h.stop();
    cleanup.reject(new Error("cleanup failed"));
    await expect(stopping).rejects.toThrow("cleanup failed");
    await h.stop();
    expect(retries).toBe(1);
  });

  test("cancels a reused process once and resumes the same native session", async () => {
    const entered = Promise.withResolvers<void>();
    const h = harness({
      respond: async function* (prompt, turn) {
        if (turn === 2) {
          entered.resolve();
          await h.exits[0]!.promise;
          return;
        }
        yield result(prompt);
      },
    });
    await h.run(DRIVER_TEST_IDS.runId);
    const active = h.run(DRIVER_TEST_IDS.secondRunId);
    void active.catch(() => {});
    await entered.promise;
    await h.backend.cancelActiveTurn(h.context, "test.cancel");
    await expect(active).rejects.toBeInstanceOf(DriverTurnCancelledError);
    expect(h.closes).toBe(1);
    await h.run(DRIVER_TEST_IDS.thirdRunId);
    expect(h.creates).toBe(2);
    expect(h.preparations[1]?.nativeSessionId).toBe("native-session-1");
    expect(h.events.filter((event) => event.kind === "run.cancelled")).toHaveLength(1);
  });

  test("waits for permission callbacks before completing and admitting another Run", async () => {
    const permission = Promise.withResolvers<void>();
    const h = harness({
      prepare: ({ permissionTasks }) => {
        permissionTasks?.add(permission.promise);
      },
    });
    const running = h.run(DRIVER_TEST_IDS.runId);
    await nextTick();
    expect(h.events.some((event) => event.kind === "run.completed")).toBe(false);
    await expect(
      h.backend.handleInput(h.context, { text: "overlap" }, DRIVER_TEST_IDS.secondRunId),
    ).rejects.toThrow("already has an active turn");
    permission.resolve();
    await running;
    await h.run(DRIVER_TEST_IDS.secondRunId);
    expect(h.creates).toBe(1);
    expect(h.preparations[0]?.permissionTasks?.size).toBe(0);
  });

  test("recycles tool turns, drains trailing resource events, and waits for process cleanup", async () => {
    const cleanup = Promise.withResolvers<void>();
    const h = harness({
      prepare: ({ processTasks }) => {
        processTasks?.add(cleanup.promise);
      },
      respond: async function* (prompt) {
        yield {
          message: {
            content: [
              { id: "tool-1", input: { command: "echo done" }, name: "Bash", type: "tool_use" },
            ],
          },
          parent_tool_use_id: null,
          session_id: "native-session-1",
          type: "assistant",
          uuid: "assistant-1",
        } as unknown as SDKMessage;
        yield result(prompt);
      },
      afterInput: async function* () {
        yield {
          output_file: "/tmp/report.pdf",
          resource_links: [{ name: "report.pdf", uri: "file:///workspace/report.pdf" }],
          session_id: "native-session-1",
          status: "completed",
          subtype: "task_notification",
          summary: "done",
          task_id: "task-1",
          tool_use_id: "tool-1",
          type: "system",
          uuid: "tail-1",
        } as unknown as SDKMessage;
      },
    });
    const running = h.run(DRIVER_TEST_IDS.runId);
    await nextTick();
    expect(h.closes).toBe(1);
    expect(h.events.some((event) => event.kind === "run.completed")).toBe(false);
    cleanup.resolve();
    await running;
    const resourceIndex = h.events.findIndex(
      (event) =>
        event.kind === "tool.call.updated" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        "structuredOutput" in event.payload,
    );
    expect(resourceIndex).toBeGreaterThanOrEqual(0);
    expect(h.events.findIndex((event) => event.kind === "run.completed")).toBeGreaterThan(
      resourceIndex,
    );
    await h.run(DRIVER_TEST_IDS.secondRunId);
    expect(h.creates).toBe(2);
    expect(h.preparations[1]?.nativeSessionId).toBe("native-session-1");
  });

  test("rejects a result correlated to another input", async () => {
    const h = harness({
      respond: async function* (prompt) {
        yield { ...result(prompt), user_message_uuid: "another-input" } as SDKMessage;
      },
    });
    await expect(h.run(DRIVER_TEST_IDS.runId)).rejects.toThrow("different input");
    expect(h.events.some((event) => event.kind === "run.completed")).toBe(false);
    expect(h.closes).toBe(1);
  });

  test("a timed-out idle stop retains cleanup ownership until a later stop joins it", async () => {
    const cleanup = Promise.withResolvers<void>();
    const h = harness({
      prepare: ({ processTasks }) => {
        processTasks?.add(cleanup.promise);
      },
    });
    await h.run(DRIVER_TEST_IDS.runId);
    await expect(h.backend.stop(h.context, "deadline", AbortSignal.timeout(10))).rejects.toThrow();
    let stopped = false;
    const stopping = h.stop().then(() => {
      stopped = true;
    });
    await nextTick();
    expect(stopped).toBe(false);
    cleanup.resolve();
    await stopping;
    expect(h.closes).toBe(1);
  });

  test("an idle reader failure recycles the process before the next prompt", async () => {
    const failIdle = Promise.withResolvers<void>();
    const h = harness({
      respond: async function* (prompt, turn) {
        yield result(prompt);
        if (turn === 1) {
          await failIdle.promise;
          throw new Error("idle process crashed");
        }
      },
    });
    await h.run(DRIVER_TEST_IDS.runId);
    failIdle.resolve();
    await nextTick();
    await h.run(DRIVER_TEST_IDS.secondRunId);
    expect(h.creates).toBe(2);
    expect(h.closes).toBe(1);
    expect(h.preparations[1]?.nativeSessionId).toBe("native-session-1");
  });

  test("session cancellation while input is idle cannot leak a completed Run signal into the next one", async () => {
    const previousRun = new AbortController();
    const h = harness();
    await h.run(DRIVER_TEST_IDS.runId, previousRun.signal);
    previousRun.abort("previous Run released");
    await h.run(DRIVER_TEST_IDS.secondRunId);
    expect(h.creates).toBe(1);
    expect(h.events.filter((event) => event.kind === "run.completed")).toHaveLength(2);
  });

  test("a failed permission callback cannot publish a terminal on the retained path", async () => {
    const permission = Promise.withResolvers<void>();
    const h = harness({
      prepare: ({ permissionTasks }) => {
        permissionTasks?.add(permission.promise);
      },
    });
    const running = h.run(DRIVER_TEST_IDS.runId);
    void running.catch(() => {});
    await nextTick();
    permission.reject(new Error("permission settlement failed"));
    await expect(running).rejects.toThrow("permission settlement failed");
    expect(
      h.events.some((event) =>
        ["run.completed", "run.cancelled", "run.failed"].includes(event.kind),
      ),
    ).toBe(false);
    expect(h.closes).toBe(1);
  });

  test("stop during permission settlement waits for process cleanup before the terminal", async () => {
    const permission = Promise.withResolvers<void>();
    const processExit = Promise.withResolvers<void>();
    const h = harness({
      prepare: ({ permissionTasks, processTasks }) => {
        permissionTasks?.add(permission.promise);
        processTasks?.add(processExit.promise);
      },
    });
    const running = h.run(DRIVER_TEST_IDS.runId);
    await nextTick();
    const stopping = h.stop();
    permission.resolve();
    await nextTick();
    expect(h.events.some((event) => event.kind === "run.completed")).toBe(false);
    processExit.resolve();
    await Promise.all([running, stopping]);
    expect(h.closes).toBe(1);
    expect(h.events.filter((event) => event.kind === "run.completed")).toHaveLength(1);
  });

  test("unsolicited results after completion dispose the idle process without another terminal", async () => {
    const h = harness({
      respond: async function* (prompt, turn) {
        yield result(prompt);
        if (turn === 1) yield result(prompt);
      },
    });
    await h.run(DRIVER_TEST_IDS.runId);
    await nextTick();
    await h.run(DRIVER_TEST_IDS.secondRunId);
    expect(h.creates).toBe(2);
    expect(h.events.filter((event) => event.kind === "run.completed")).toHaveLength(2);
    expect(h.events.some((event) => event.kind === "run.failed")).toBe(false);
  });

  test("an idle conversation reset waits for the preceding terminal and resets usage", async () => {
    const terminalStarted = Promise.withResolvers<void>();
    const deliverTerminal = Promise.withResolvers<void>();
    const h = harness({
      beforePush: async (events) => {
        if (
          events.some(
            (event) => event.kind === "run.completed" && event.runId === DRIVER_TEST_IDS.runId,
          )
        ) {
          terminalStarted.resolve();
          await deliverTerminal.promise;
        }
      },
      respond: async function* (prompt, turn) {
        yield {
          ...result(prompt),
          session_id: turn === 1 ? "native-session-1" : "native-session-2",
        } as SDKMessage;
        if (turn === 1) {
          yield {
            new_conversation_id: "native-session-2",
            session_id: "native-session-1",
            type: "conversation_reset",
            uuid: "reset-1",
          } as unknown as SDKMessage;
        }
      },
    });
    const running = h.run(DRIVER_TEST_IDS.runId);
    await terminalStarted.promise;
    expect(h.events.filter((event) => event.kind === "runtime.resume.updated")).toHaveLength(1);
    deliverTerminal.resolve();
    await running;
    await nextTick();
    const terminalIndex = h.events.findIndex((event) => event.kind === "run.completed");
    const resetIndex = h.events.findLastIndex((event) => event.kind === "runtime.resume.updated");
    expect(resetIndex).toBeGreaterThan(terminalIndex);
    expect(h.events[resetIndex]?.runId).toBeNull();
    await h.run(DRIVER_TEST_IDS.secondRunId);
    expect(h.creates).toBe(1);
    const usage = h.events.filter((event) => event.kind === "usage.updated");
    expect(usage[1]?.payload).toEqual(usage[0]?.payload);
  });

  test("an empty background-task snapshot does not disable reuse", async () => {
    const h = harness({
      respond: async function* (prompt) {
        yield {
          session_id: "native-session-1",
          subtype: "background_tasks_changed",
          tasks: [],
          type: "system",
          uuid: "tasks-empty",
        } as unknown as SDKMessage;
        yield result(prompt);
      },
    });
    await h.run(DRIVER_TEST_IDS.runId);
    await h.run(DRIVER_TEST_IDS.secondRunId);
    expect(h.creates).toBe(1);
  });
});
