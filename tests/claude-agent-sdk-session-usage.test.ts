import { expect, test } from "bun:test";
import type {
  ModelUsage,
  Query,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import { ClaudeAgentSdkMessageTranslator } from "../src/runtimes/claude/agent-sdk-message-translator";
import { ClaudeRunUsage, ClaudeSessionUsage } from "../src/runtimes/claude/agent-sdk-session-usage";
import { createClaudeAgentSdkHarness } from "./claude-agent-sdk-test-helpers";

function modelUsage(count: number): ModelUsage {
  return {
    cacheCreationInputTokens: count,
    cacheReadInputTokens: count * 2,
    contextWindow: 200_000,
    costUSD: count / 10,
    inputTokens: count * 10,
    maxOutputTokens: 1_024,
    outputTokens: count * 5,
    thinkingTokens: count,
    webSearchRequests: count,
  };
}

function result(models: Record<string, ModelUsage>, cost: number): SDKResultMessage {
  return {
    modelUsage: models,
    total_cost_usd: cost,
    usage: { input_tokens: 5 },
  } as unknown as SDKResultMessage;
}

test("differences cumulative counters by model while preserving limits and per-turn usage", () => {
  const usage = new ClaudeSessionUsage();
  usage.difference(result({ first: modelUsage(1) }, 0.1));
  const next = usage.difference(result({ first: modelUsage(3), second: modelUsage(1) }, 0.4));
  expect(next.modelUsage["first"]).toMatchObject({
    ...modelUsage(2),
    costUSD: expect.closeTo(0.2),
  });
  expect(next.modelUsage["second"]).toEqual(modelUsage(1));
  expect(next.total_cost_usd).toBeCloseTo(0.3);
  expect(next.usage).toEqual({ input_tokens: 5 });
});

test("a conversation reset starts a fresh accounting epoch", () => {
  const usage = new ClaudeSessionUsage();
  usage.difference(result({ first: modelUsage(3) }, 0.3));
  usage.reset();
  const next = result({ first: modelUsage(1) }, 0.1);
  expect(usage.difference(next)).toEqual(next);
});

test("zeroed crash results do not produce negative usage", () => {
  const usage = new ClaudeSessionUsage();
  usage.difference(result({ first: modelUsage(3) }, 0.3));
  const next = result({ first: modelUsage(0) }, 0);
  expect(usage.difference(next)).toEqual(next);
});

test("invalid cumulative samples repair their baseline before publishing another delta", () => {
  const usage = new ClaudeSessionUsage();
  usage.difference(result({ first: modelUsage(1) }, 0.1));
  usage.difference(
    result(
      { first: { ...modelUsage(1), inputTokens: -5, outputTokens: Infinity, costUSD: NaN } },
      NaN,
    ),
  );
  const next = usage.difference(result({ first: modelUsage(3) }, 0.3));
  expect(next.modelUsage["first"]?.inputTokens).toBeNaN();
  expect(next.modelUsage["first"]?.outputTokens).toBeNaN();
  expect(next.modelUsage["first"]?.costUSD).toBeNaN();
  expect(next.modelUsage["first"]?.cacheReadInputTokens).toBe(4);
  expect(next.total_cost_usd).toBeNaN();
  const recovered = usage.difference(result({ first: modelUsage(4) }, 0.4));
  expect(recovered.modelUsage["first"]).toMatchObject({
    ...modelUsage(1),
    costUSD: expect.closeTo(0.1),
  });
  expect(recovered.total_cost_usd).toBeCloseTo(0.1);
});

test.each([-5, NaN, Infinity])(
  "an invalid first thinking count (%s) cannot become a baseline",
  (thinkingTokens) => {
    const usage = new ClaudeSessionUsage();
    usage.difference(result({ first: { ...modelUsage(1), thinkingTokens } }, 0.1));
    expect(
      usage.difference(result({ first: modelUsage(3) }, 0.3)).modelUsage["first"]?.thinkingTokens,
    ).toBeNaN();
    expect(
      usage.difference(result({ first: modelUsage(4) }, 0.4)).modelUsage["first"]?.thinkingTokens,
    ).toBe(1);
  },
);

test.each([{}, { first: null }, null, undefined])(
  "missing or malformed models invalidate their cumulative boundary",
  (models) => {
    const usage = new ClaudeSessionUsage();
    usage.difference(result({ first: modelUsage(1) }, 0.1));
    usage.difference(result(models as unknown as Record<string, ModelUsage>, 0.2));
    const next = usage.difference(result({ first: modelUsage(3) }, 0.3));
    expect(next.modelUsage["first"]?.inputTokens).toBeNaN();
    expect(next.modelUsage["first"]?.outputTokens).toBeNaN();
    expect(next.modelUsage["first"]?.costUSD).toBeNaN();
    expect(next.total_cost_usd).toBeCloseTo(0.1);
    expect(
      usage.difference(result({ first: modelUsage(4) }, 0.4)).modelUsage["first"]?.inputTokens,
    ).toBe(10);
  },
);

test("a model first seen after malformed session totals repairs an unknown baseline", () => {
  const usage = new ClaudeSessionUsage();
  usage.difference(result(undefined as unknown as Record<string, ModelUsage>, NaN));
  expect(
    usage.difference(result({ first: modelUsage(3) }, 0.3)).modelUsage["first"]?.inputTokens,
  ).toBeNaN();
  expect(
    usage.difference(result({ first: modelUsage(4) }, 0.4)).modelUsage["first"]?.inputTokens,
  ).toBe(10);
});

test("native resume reads the complete model baseline only after initialization", async () => {
  const initialized = Promise.withResolvers<void>();
  let requested = false;
  const query = {
    initializationResult: () => initialized.promise,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (options: unknown) => {
      expect(options).toEqual({ skipBehaviors: true });
      requested = true;
      return {
        session: {
          total_cost_usd: 0.3,
          model_usage: { main: modelUsage(2), subagent: modelUsage(1) },
        },
      };
    },
  } as unknown as Query;
  const usage = new ClaudeSessionUsage();
  const baseline = usage.initialize(query);
  await Promise.resolve();
  expect(requested).toBe(false);
  initialized.resolve();
  await baseline;
  const next = usage.difference(result({ main: modelUsage(3), subagent: modelUsage(2) }, 0.5));
  expect(next.modelUsage["main"]).toMatchObject({
    inputTokens: 10,
    outputTokens: 5,
    thinkingTokens: 1,
  });
  expect(next.modelUsage["subagent"]).toMatchObject({
    inputTokens: 10,
    outputTokens: 5,
    thinkingTokens: 1,
  });
  expect(next.total_cost_usd).toBeCloseTo(0.2);
});

test("a fresh or crash-restored native zero baseline does not inherit host totals", async () => {
  const usage = new ClaudeSessionUsage();
  usage.difference(result({ main: modelUsage(5) }, 0.5));
  await usage.initialize({
    initializationResult: async () => ({}),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      session: { total_cost_usd: 0, model_usage: {} },
    }),
  } as unknown as Query);
  const next = result({ main: modelUsage(1) }, 0.1);
  expect(usage.difference(next)).toEqual(next);
});

test("a missing optional native thinking baseline stays unknown until repaired", async () => {
  const usage = new ClaudeSessionUsage();
  await usage.initialize({
    initializationResult: async () => ({}),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      session: {
        total_cost_usd: 0.1,
        model_usage: { main: { ...modelUsage(1), thinkingTokens: undefined } },
      },
    }),
  } as unknown as Query);
  expect(
    usage.difference(result({ main: modelUsage(2) }, 0.2)).modelUsage["main"]?.thinkingTokens,
  ).toBeNaN();
  expect(
    usage.difference(result({ main: modelUsage(3) }, 0.3)).modelUsage["main"]?.thinkingTokens,
  ).toBe(1);
});

test.each([
  { total_cost_usd: NaN, model_usage: {} },
  { total_cost_usd: 0 },
  { total_cost_usd: 0, model_usage: { main: { ...modelUsage(1), inputTokens: -1 } } },
  { total_cost_usd: 0, model_usage: { main: { ...modelUsage(1), thinkingTokens: Infinity } } },
])(
  "an invalid native baseline is rejected without changing the retained accounting",
  async (session) => {
    const usage = new ClaudeSessionUsage();
    usage.difference(result({ main: modelUsage(1) }, 0.1));
    await expect(
      usage.initialize({
        initializationResult: async () => ({}),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ session }),
      } as unknown as Query),
    ).rejects.toThrow("baseline");
    expect(
      usage.difference(result({ main: modelUsage(2) }, 0.2)).modelUsage["main"]?.inputTokens,
    ).toBe(10);
  },
);

const runId = "run-1" as RunId;

function stream(event: Record<string, unknown>, parent: string | null = null): SDKMessage {
  return {
    event,
    parent_tool_use_id: parent,
    type: "stream_event",
    uuid: "stream-envelope",
  } as unknown as SDKMessage;
}

function assistant(id: string, usage: Record<string, unknown>, uuid = id): SDKMessage {
  return {
    message: { content: [], id, usage },
    parent_tool_use_id: null,
    type: "assistant",
    uuid,
  } as unknown as SDKMessage;
}

function runResult(models: Record<string, ModelUsage>, cost: number): SDKResultMessage {
  return {
    ...result(models, cost),
    is_error: false,
    permission_denials: [],
    result: "",
    subtype: "success",
    type: "result",
    uuid: "result-1",
  } as unknown as SDKResultMessage;
}

function usageSnapshots(events: readonly DriverEventInput[]) {
  return events.filter((event) => event.kind === "usage.updated").map((event) => event.payload);
}

test("stream and assistant samples publish the complete known Run usage without counting a response twice", async () => {
  const h = createClaudeAgentSdkHarness();
  await h.handleMessages([
    stream({
      type: "message_start",
      message: {
        id: "response-1",
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 8 },
      },
    }),
    stream({
      type: "message_delta",
      usage: { output_tokens: 4, output_tokens_details: { thinking_tokens: 1 } },
    }),
    stream({ type: "message_stop" }),
    assistant(
      "response-1",
      { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 8 },
      "block-1",
    ),
    assistant("response-1", { input_tokens: 10, output_tokens: 4 }, "block-2"),
    stream({
      type: "message_start",
      message: { id: "response-2", usage: { input_tokens: 3, output_tokens: 0 } },
    }),
    stream({ type: "message_delta", usage: { output_tokens: 2 } }),
    stream({ type: "message_delta", usage: { output_tokens: 2 } }),
    stream({ type: "message_delta", usage: { used: 100, size: 200_000 } }),
  ]);
  expect(usageSnapshots(h.events())).toHaveLength(4);
  expect(usageSnapshots(h.events()).at(-1)).toMatchObject({
    cachedReadTokens: 8,
    costAmount: null,
    inputTokens: 13,
    outputTokens: 6,
    thoughtTokens: 1,
    totalTokens: 19,
  });

  const authoritative = runResult({ main: modelUsage(1), subagent: modelUsage(2) }, 0.5);
  await h.translator.prepareResult(h.context, authoritative, runId);
  await h.translator.prepareResult(h.context, authoritative, runId);
  expect(usageSnapshots(h.events())).toHaveLength(5);
  expect(usageSnapshots(h.events()).at(-1)).toMatchObject({
    cachedReadTokens: 6,
    cachedWriteTokens: 3,
    costAmount: 0.5,
    costCurrency: "USD",
    inputTokens: 30,
    outputTokens: 15,
    thoughtTokens: 3,
    totalTokens: 45,
  });
});

test("interleaved subagent streams have separate response identities", async () => {
  const h = createClaudeAgentSdkHarness();
  await h.handleMessages([
    stream({
      type: "message_start",
      message: { id: "same-native-id", usage: { input_tokens: 10, output_tokens: 0 } },
    }),
    stream(
      {
        type: "message_start",
        message: { id: "same-native-id", usage: { input_tokens: 3, output_tokens: 0 } },
      },
      "tool-task",
    ),
    stream({ type: "message_delta", usage: { output_tokens: 4 } }),
    stream({ type: "message_delta", usage: { output_tokens: 2 } }, "tool-task"),
  ]);
  expect(usageSnapshots(h.events()).at(-1)).toMatchObject({
    inputTokens: 13,
    outputTokens: 6,
    totalTokens: 19,
  });
});

test.each(["cancel", "fail"])(
  "%s without a result retains confirmed responses and the next Run starts at zero",
  async (terminal) => {
    const h = createClaudeAgentSdkHarness();
    await h.handleMessages([
      assistant("response-1", { input_tokens: 10, output_tokens: 4 }),
      assistant("response-2", { input_tokens: 3, output_tokens: 2 }),
    ]);
    if (terminal === "cancel") {
      await h.translator.cancelTurn(h.context, runId, "test.cancel");
    } else {
      await h.translator.failTurn(h.context, runId, "test.failure", "Failed before result.");
    }
    expect(usageSnapshots(h.events()).at(-1)).toMatchObject({
      costAmount: null,
      inputTokens: 13,
      outputTokens: 6,
      totalTokens: 19,
    });
    h.translator.resetTurnMessageState();
    await h.handleMessages(
      [assistant("response-1", { input_tokens: 1, output_tokens: 1 })],
      "run-2" as RunId,
    );
    expect(usageSnapshots(h.events()).at(-1)).toMatchObject({
      costAmount: null,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    });
  },
);

test("unattributed deltas wait for a native assistant ID instead of inventing a second charge", async () => {
  const h = createClaudeAgentSdkHarness();
  await h.handleMessages([stream({ type: "message_delta", usage: { output_tokens: 5 } })]);
  expect(usageSnapshots(h.events())).toEqual([]);
  expect(h.events()).toContainEqual(
    expect.objectContaining({
      kind: "diagnostic.reported",
      payload: expect.objectContaining({ severity: "warn" }),
    }),
  );
  await h.handleMessages([assistant("response-1", { input_tokens: 10, output_tokens: 5 })]);
  expect(usageSnapshots(h.events()).at(-1)).toMatchObject({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
});

test("a conversation reset preserves earlier confirmed consumption within the Run", async () => {
  const h = createClaudeAgentSdkHarness();
  await h.handleMessages([
    assistant("response-1", { input_tokens: 10, output_tokens: 4 }),
    {
      type: "conversation_reset",
      session_id: "native-1",
      new_conversation_id: "native-2",
      uuid: "reset-1",
    } as unknown as SDKMessage,
    assistant("response-2", { input_tokens: 3, output_tokens: 2 }),
  ]);
  await h.translator.prepareResult(
    h.context,
    runResult({ main: { ...modelUsage(0), inputTokens: 3, outputTokens: 2 } }, 0.1),
    runId,
  );
  expect(usageSnapshots(h.events()).at(-1)).toMatchObject({
    inputTokens: 13,
    outputTokens: 6,
    totalTokens: 19,
    costAmount: 0.1,
  });
});

test("a rejected usage delivery can retry without adding the response again", async () => {
  const { context } = createClaudeAgentSdkHarness();
  const events: DriverEventInput[] = [];
  let rejectUsage = true;
  const translator = new ClaudeAgentSdkMessageTranslator({
    publicToolCallId: (id) => id,
    push: async (_context, reason, batch) => {
      if (reason === "driver.claude.usage.updated" && rejectUsage) {
        rejectUsage = false;
        throw new Error("delivery rejected");
      }
      events.push(...batch);
    },
    pushTerminal: async () => {},
    recordNativeSessionId: async () => {},
    replaceNativeSessionId: async () => {},
    sessionId: context.payload.execution.run.sessionId,
  });
  const message = assistant("response-1", { input_tokens: 10, output_tokens: 5 });
  await expect(translator.handleSdkMessage(context, message, runId)).rejects.toThrow(
    "delivery rejected",
  );
  await translator.handleSdkMessage(context, message, runId);
  await translator.handleSdkMessage(context, message, runId);
  await translator.handleSdkMessage(
    context,
    assistant("response-2", { input_tokens: 3, output_tokens: 2 }),
    runId,
  );
  expect(usageSnapshots(events)).toHaveLength(2);
  expect(usageSnapshots(events).at(-1)).toMatchObject({
    inputTokens: 13,
    outputTokens: 7,
    totalTokens: 20,
  });
});

test("valid result totals replace response counters while invalid values retain known counts", () => {
  const usage = new ClaudeRunUsage();
  usage.updateResponse("response-1", { input_tokens: 10, output_tokens: 5, thinking_tokens: 2 });
  usage.updateResponse("response-1", {
    input_tokens: -5,
    output_tokens: NaN,
    thinking_tokens: Infinity,
  });
  usage.updateResult(
    result(
      { main: { ...modelUsage(1), inputTokens: NaN, outputTokens: 3, thinkingTokens: -5 } },
      NaN,
    ),
  );
  expect(usage.snapshot()).toMatchObject({
    usage: { input_tokens: 10, output_tokens: 3, thinking_tokens: 2 },
    cost: null,
  });
});

test.each([undefined, -5, NaN, Infinity])(
  "an incomplete model total cannot replace known response counts (%s)",
  (inputTokens) => {
    const usage = new ClaudeRunUsage();
    usage.updateResponse("response-1", { input_tokens: 10, output_tokens: 5, thinking_tokens: 2 });
    usage.updateResponse("response-2", { input_tokens: 20, output_tokens: 10, thinking_tokens: 3 });
    usage.updateResult(
      result(
        {
          main: modelUsage(1),
          subagent: {
            ...modelUsage(1),
            inputTokens,
            thinkingTokens: undefined,
          } as unknown as ModelUsage,
        },
        0.2,
      ),
    );
    expect(usage.snapshot()).toMatchObject({
      usage: { input_tokens: 30, output_tokens: 10, thinking_tokens: 5 },
      cost: 0.2,
    });
  },
);

test("an unknown result boundary cannot reassign a previous Run's confirmed consumption", () => {
  const session = new ClaudeSessionUsage();
  const usage = new ClaudeRunUsage();
  usage.updateResponse("response-1", { input_tokens: 10, output_tokens: 5 });
  usage.updateResult(
    session.difference(result({ main: { ...modelUsage(1), outputTokens: NaN } }, NaN)),
  );
  expect(usage.snapshot()).toMatchObject({
    usage: { input_tokens: 10, output_tokens: 5 },
    cost: null,
  });

  usage.reset();
  usage.updateResponse("response-2", { input_tokens: 3, output_tokens: 7 });
  usage.updateResult(
    session.difference(
      result(
        {
          main: {
            ...modelUsage(2),
            inputTokens: 13,
            outputTokens: 12,
          },
        },
        0.2,
      ),
    ),
  );
  expect(usage.snapshot()).toMatchObject({
    usage: { input_tokens: 3, output_tokens: 7 },
    cost: null,
  });
});

test("a missing known model cannot turn a result into an authoritative partial total", () => {
  const session = new ClaudeSessionUsage();
  session.difference(result({ main: modelUsage(1), subagent: modelUsage(1) }, 0.2));
  const usage = new ClaudeRunUsage();
  usage.updateResponse("response-1", { input_tokens: 30, output_tokens: 15 });
  usage.updateResult(session.difference(result({ main: modelUsage(2) }, 0.4)));
  expect(usage.snapshot()).toMatchObject({
    usage: { input_tokens: 30, output_tokens: 15 },
    cost: 0.2,
  });
});
