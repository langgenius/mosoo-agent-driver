import { describe, expect, test } from "bun:test";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  applyCommittedMutation,
  interactionSchema,
  validateSessionSnapshot,
} from "../src/contract";
import type {
  AuthorityOperation,
  CommittedMutation,
  InteractionResolution,
  Run,
  SessionSnapshot,
} from "../src/contract";
import { ClaudeContractAdapter } from "../src/runtimes/claude/contract-adapter";
import type {
  ContractAuthorityUpdate,
  ContractPreviewUpdate,
} from "../src/runtimes/contract-projection";

const SESSION_ID = protocolId(1);
const RUN_ID = protocolId(2);

function protocolId(value: number): string {
  return value.toString().padStart(26, "0");
}

function sdkMessage(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function resultMessage(usage: unknown, totalCostUsd: number): SDKMessage {
  return sdkMessage({
    is_error: false,
    modelUsage: {},
    num_turns: 1,
    permission_denials: [],
    result: "",
    session_id: "native-session-1",
    stop_reason: null,
    subtype: "success",
    total_cost_usd: totalCostUsd,
    type: "result",
    usage,
    uuid: "result-1",
  });
}

function activeRun(startedAt: string): Run {
  return {
    id: RUN_ID,
    input: [{ text: "hello", type: "text" }],
    origin: "user",
    startedAt,
    status: "active",
  };
}

function createInitialSnapshot(capturedAt: string): SessionSnapshot {
  return validateSessionSnapshot({
    capturedAt,
    interactions: [],
    items: [],
    protocolVersion: 2,
    revision: 0,
    runs: [activeRun(capturedAt)],
    session: {
      capabilities: {
        "interaction.permission": {},
        "item.artifact": {},
        "item.change": {},
        "item.plan": {},
        "item.reasoning": {},
        "item.terminal": {},
      },
      config: [],
      createdAt: capturedAt,
      id: SESSION_ID,
      status: "open",
      updatedAt: capturedAt,
    },
  });
}

function createHarness(
  interactionTimeoutMs = 5 * 60 * 1_000,
  maxToolInputBytes?: number,
  maxPendingPermissionBytes?: number,
  onAuthority?: (update: ContractAuthorityUpdate) => Promise<void> | void,
) {
  let nowMs = Date.parse("2026-07-16T08:00:00.000Z");
  let snapshot = createInitialSnapshot(new Date(nowMs).toISOString());
  let nextId = 100;
  const authority: ContractAuthorityUpdate[] = [];
  const previews: ContractPreviewUpdate[] = [];
  const commit = (cause: CommittedMutation["cause"], operations: AuthorityOperation[]): void => {
    const revision = snapshot.revision + 1;
    const mutation: CommittedMutation = {
      baseRevision: snapshot.revision,
      cause,
      committedAt: new Date(nowMs).toISOString(),
      mutationId: protocolId(1_000 + revision),
      operations,
      revision,
      sessionId: SESSION_ID,
    };
    snapshot = applyCommittedMutation(snapshot, mutation);
  };
  const adapter = new ClaudeContractAdapter({
    authority: async (update) => {
      authority.push(update);
      await onAuthority?.(update);
      commit(update.cause, [...update.operations] as AuthorityOperation[]);
    },
    createId: () => protocolId(nextId++),
    interactionTimeoutMs,
    maxPendingPermissionBytes,
    maxToolInputBytes,
    now: () => new Date(nowMs),
    preview: (update) => previews.push(update),
    sessionId: SESSION_ID,
  });

  return {
    adapter,
    advance(milliseconds: number) {
      nowMs += milliseconds;
    },
    authority,
    previews,
    settleInteraction(interactionId: string, resolution?: InteractionResolution) {
      const interaction = snapshot.interactions.find((entry) => entry.id === interactionId);

      if (interaction === undefined || interaction.status !== "open") {
        throw new Error("The test interaction must be open.");
      }

      if (resolution !== undefined && resolution.kind !== interaction.kind) {
        throw new Error("The test resolution kind must match the interaction kind.");
      }

      const endedAt = new Date(nowMs).toISOString();
      commit({ commandId: protocolId(2_000 + snapshot.revision + 1), type: "command" }, [
        {
          entity: "interaction",
          op: "put",
          value: interactionSchema.parse(
            resolution === undefined
              ? { ...interaction, endedAt, status: "expired" }
              : {
                  ...interaction,
                  endedAt,
                  resolution: resolution.value,
                  status: "resolved",
                },
          ),
        },
      ]);
    },
    snapshot: () => snapshot,
  };
}

async function registerRun(adapter: ClaudeContractAdapter): Promise<void> {
  adapter.attachRun(activeRun("2026-07-16T08:00:00.000Z"));
}

describe("Claude Contract adapter", () => {
  test("ignores model-call usage deltas until the Run-level result snapshot", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    const before = harness.authority.length;

    await harness.adapter.handleMessage(
      sdkMessage({
        event: {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          type: "message_delta",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );

    expect(harness.authority).toHaveLength(before);
    expect(harness.snapshot().runs[0]?.usage).toBeUndefined();
  });

  test.each([
    {
      expected: undefined,
      label: "MAX_VALUE input and output",
      usage: {
        cache_read_input_tokens: Number.MAX_VALUE,
        input_tokens: Number.MAX_VALUE,
        output_tokens: Number.MAX_VALUE,
      },
    },
    {
      expected: { cachedInput: 3, output: 2, total: 2 },
      label: "negative input",
      usage: { cache_read_input_tokens: 3, input_tokens: -1, output_tokens: 2 },
    },
    {
      expected: { cachedInput: 3, input: 2, total: 2 },
      label: "fractional output",
      usage: { cache_read_input_tokens: 3, input_tokens: 2, output_tokens: 1.5 },
    },
    {
      expected: { output: 2, total: 2 },
      label: "unsafe input and cached input",
      usage: {
        cache_read_input_tokens: Number.MAX_SAFE_INTEGER + 1,
        input_tokens: Number.MAX_SAFE_INTEGER + 1,
        output_tokens: 2,
      },
    },
    {
      expected: { input: Number.MAX_SAFE_INTEGER, output: 1 },
      label: "unsafe derived total",
      usage: {
        cache_read_input_tokens: Number.NaN,
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: 1,
      },
    },
  ])("drops $label without blocking Run completion", async ({ expected, usage }) => {
    const harness = createHarness();
    await registerRun(harness.adapter);

    await harness.adapter.handleMessage(resultMessage(usage, Number.NaN), RUN_ID);

    expect(harness.snapshot().runs[0]).toMatchObject({ status: "completed" });
    expect(harness.snapshot().runs[0]?.usage).toEqual(expected);
  });

  test.each([
    { label: "negative", value: -0.01 },
    { label: "Infinity", value: Infinity },
    { label: "-Infinity", value: -Infinity },
    { label: "NaN", value: Number.NaN },
  ])("drops $label cost without blocking Run completion", async ({ value }) => {
    const harness = createHarness();
    await registerRun(harness.adapter);

    await harness.adapter.handleMessage(
      resultMessage({ input_tokens: 1, output_tokens: 2 }, value),
      RUN_ID,
    );

    expect(harness.snapshot().runs[0]).toMatchObject({
      status: "completed",
      usage: { input: 1, output: 2, total: 3 },
    });
    expect(harness.snapshot().runs[0]?.usage?.cost).toBeUndefined();
  });

  test("repairs streamed text from the authoritative message and keeps source time as metadata", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        event: { type: "message_start" },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        event: {
          delta: { text: "hel", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        message: {
          content: [{ text: "hello", type: "text" }],
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        supersedes: ["assistant-old"],
        timestamp: "2020-01-01T00:00:00.000Z",
        type: "assistant",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        is_error: false,
        modelUsage: {},
        num_turns: 1,
        permission_denials: [],
        result: "hello",
        session_id: "native-session-1",
        stop_reason: "max_tokens",
        structured_output: { answer: 42 },
        subtype: "success",
        total_cost_usd: 0.01,
        type: "result",
        usage: {
          cache_read_input_tokens: 2,
          input_tokens: 3,
          output_tokens: 5,
        },
        uuid: "result-1",
      }),
      RUN_ID,
    );

    expect(harness.previews.map((entry) => entry.update)).toMatchObject([
      { op: "append", text: "hel" },
    ]);
    expect(harness.snapshot().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: [{ text: "hello", type: "text" }],
          extensions: {
            "anthropic.agent-sdk/source-timestamp": "2020-01-01T00:00:00.000Z",
            "anthropic.agent-sdk/supersedes": ["assistant-old"],
          },
          id: "message:assistant-1",
          kind: "message",
          status: "completed",
        }),
        expect.objectContaining({
          content: [{ type: "json", value: { answer: 42 } }],
          kind: "artifact",
          name: "structured-output.json",
          status: "completed",
        }),
      ]),
    );
    expect(harness.snapshot().runs[0]).toMatchObject({
      finishReason: "limit",
      status: "completed",
      usage: {
        cachedInput: 2,
        cost: { amount: 0.01, currency: "USD" },
        input: 3,
        output: 5,
        total: 8,
      },
    });
  });

  test("round-trips permission decisions and keeps only session-scoped suggestions", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    const input = { command: "pwd" };
    const options = {
      requestId: "request-1",
      signal: new AbortController().signal,
      suggestions: [
        {
          behavior: "allow",
          destination: "session",
          rules: [{ toolName: "Bash" }],
          type: "addRules",
        },
        {
          behavior: "allow",
          destination: "userSettings",
          rules: [{ toolName: "Bash" }],
          type: "addRules",
        },
      ],
      title: "Run command?",
      toolUseID: "tool-1",
    } satisfies Parameters<CanUseTool>[2];
    const interactionId = await harness.adapter.openPermission(RUN_ID, "Bash", input, options);
    expect(
      await harness.adapter.openPermission(
        RUN_ID,
        "Bash",
        { command: "pwd" },
        {
          ...options,
          signal: new AbortController().signal,
        },
      ),
    ).toBe(interactionId);
    expect(harness.snapshot().interactions).toHaveLength(1);
    const interaction = harness.snapshot().interactions.find((entry) => entry.id === interactionId);
    const allowSessionId =
      interaction?.kind === "permission"
        ? interaction.request.options.find((option) => option.scope === "session")?.id
        : undefined;
    const resolution = {
      kind: "permission",
      value: { optionId: allowSessionId!, type: "selected" },
    } satisfies InteractionResolution;

    input.command = "rm -rf /";
    options.suggestions[0]!.rules[0]!.toolName = "Changed";
    harness.settleInteraction(interactionId, resolution);
    await expect(harness.adapter.resolveInteraction(interactionId, resolution)).resolves.toEqual({
      behavior: "allow",
      toolUseID: "tool-1",
      updatedInput: { command: "pwd" },
      updatedPermissions: [
        {
          behavior: "allow",
          destination: "session",
          rules: [{ toolName: "Bash" }],
          type: "addRules",
        },
      ],
    });
    await harness.adapter.handleMessage(
      sdkMessage({
        message: {
          content: [
            {
              content: [{ text: "/workspace", type: "text" }],
              tool_use_id: "tool-1",
              type: "tool_result",
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        timestamp: "2020-01-01T00:00:00.000Z",
        type: "user",
        uuid: "user-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        is_error: false,
        modelUsage: {},
        num_turns: 1,
        permission_denials: [],
        result: "done",
        session_id: "native-session-1",
        stop_reason: "end_turn",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: "result-1",
      }),
      RUN_ID,
    );

    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({
        id: "tool:tool-1",
        kind: "tool",
        output: [{ text: "/workspace", type: "text" }],
        status: "completed",
      }),
    );
    expect(harness.snapshot().interactions[0]?.status).toBe("resolved");
  });

  test.each([
    ["tool name", "Read", { command: "pwd" }, {}],
    ["tool input", "Bash", { command: "rm -rf /" }, {}],
    ["prompt metadata", "Bash", { command: "pwd" }, { title: "Changed prompt" }],
  ] as const)(
    "rejects a permission replay with changed %s",
    async (_name, replayToolName, replayInput, optionChanges) => {
      const harness = createHarness();
      await registerRun(harness.adapter);
      const options = {
        requestId: "request-replay",
        signal: new AbortController().signal,
        title: "Run command?",
        toolUseID: "tool-replay",
      } satisfies Parameters<CanUseTool>[2];
      await harness.adapter.openPermission(RUN_ID, "Bash", { command: "pwd" }, options);
      const before = harness.authority.length;

      await expect(
        harness.adapter.openPermission(RUN_ID, replayToolName, replayInput, {
          ...options,
          ...optionChanges,
        }),
      ).rejects.toThrow("changed identity");
      expect(harness.authority).toHaveLength(before);
      expect(harness.snapshot().interactions).toHaveLength(1);
    },
  );
});
