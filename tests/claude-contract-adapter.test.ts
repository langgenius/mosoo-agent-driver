import { describe, expect, test } from "bun:test";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  AuthorityOutcomeUnknownError,
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

function permissionOptions(requestId: string, toolUseID: string) {
  return {
    requestId,
    signal: new AbortController().signal,
    title: "Run command?",
    toolUseID,
  } satisfies Parameters<CanUseTool>[2];
}

function permissionBytes(
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
): number {
  return new TextEncoder().encode(
    JSON.stringify({
      input,
      options: Object.fromEntries(Object.entries(options).filter(([name]) => name !== "signal")),
      toolName: "Bash",
    }),
  ).byteLength;
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
    options.suggestions[0].rules[0]!.toolName = "Changed";
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

  test("bounds pending permission payloads and restores budget after resolution", async () => {
    const input = { command: "pwd" };
    const firstOptions = permissionOptions("request-1", "tool-1");
    const secondOptions = permissionOptions("request-2", "tool-2");
    const maxPendingPermissionBytes = permissionBytes(input, firstOptions);
    const harness = createHarness(5 * 60 * 1_000, undefined, maxPendingPermissionBytes);
    await registerRun(harness.adapter);
    const interactionId = await harness.adapter.openPermission(RUN_ID, "Bash", input, firstOptions);
    const authorityCount = harness.authority.length;

    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", input, secondOptions),
    ).rejects.toThrow("pending permission budget");
    expect(harness.authority).toHaveLength(authorityCount);

    const resolution = {
      kind: "permission",
      value: { type: "cancelled" },
    } satisfies InteractionResolution;
    harness.settleInteraction(interactionId, resolution);
    await harness.adapter.resolveInteraction(interactionId, resolution);
    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", input, secondOptions),
    ).resolves.toBeDefined();
  });

  test("reserves permission budget before the first Authority await", async () => {
    const input = { command: "pwd" };
    const firstOptions = permissionOptions("request-concurrent-1", "tool-concurrent-1");
    const secondOptions = permissionOptions("request-concurrent-2", "tool-concurrent-2");
    const firstAuthority = Promise.withResolvers<void>();
    const releaseAuthority = Promise.withResolvers<void>();
    let toolCommits = 0;
    const harness = createHarness(
      5 * 60 * 1_000,
      undefined,
      permissionBytes(input, firstOptions),
      async (update) => {
        if (update.event === "permission/requested.tool" && ++toolCommits === 1) {
          firstAuthority.resolve();
          await releaseAuthority.promise;
        }
      },
    );
    await registerRun(harness.adapter);
    const first = harness.adapter.openPermission(RUN_ID, "Bash", input, firstOptions);
    await firstAuthority.promise;

    try {
      await expect(
        harness.adapter.openPermission(RUN_ID, "Bash", input, secondOptions),
      ).rejects.toThrow("pending permission budget");
    } finally {
      releaseAuthority.resolve();
    }

    await expect(first).resolves.toBeDefined();
    expect(toolCommits).toBe(1);
  });

  test("rolls back a permission reservation when Authority rejects it", async () => {
    const input = { command: "pwd" };
    const firstOptions = permissionOptions("request-failed", "tool-failed");
    const secondOptions = permissionOptions("request-retry", "tool-retry");
    let rejectNext = true;
    const harness = createHarness(
      5 * 60 * 1_000,
      undefined,
      permissionBytes(input, firstOptions),
      (update) => {
        if (rejectNext && update.event === "permission/requested.tool") {
          rejectNext = false;
          throw new Error("Authority unavailable");
        }
      },
    );
    await registerRun(harness.adapter);

    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", input, firstOptions),
    ).rejects.toThrow("Authority unavailable");
    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", input, secondOptions),
    ).resolves.toBeDefined();
  });

  test.each(["permission/requested.tool", "permission/requested"] as const)(
    "retries the exact %s write after an unknown Authority outcome",
    async (event) => {
      const writes: ContractAuthorityUpdate[] = [];
      const harness = createHarness(5 * 60 * 1_000, undefined, undefined, (update) => {
        if (update.event !== event) {
          return;
        }

        writes.push(update);
        if (writes.length === 1) {
          throw new AuthorityOutcomeUnknownError("Authority response was lost");
        }
      });
      await registerRun(harness.adapter);

      await expect(
        harness.adapter.openPermission(
          RUN_ID,
          "Bash",
          { command: "pwd" },
          permissionOptions(`request-unknown-${event}`, `tool-unknown-${event}`),
        ),
      ).resolves.toBeDefined();

      expect(writes).toHaveLength(2);
      expect(writes[1]?.mutationId).toBe(writes[0]?.mutationId);
      expect(writes[1]?.operations).toEqual(writes[0]?.operations);
      expect(harness.snapshot().interactions).toHaveLength(1);
    },
  );

  test("coalesces concurrent redelivery of the same permission request", async () => {
    const input = { command: "pwd" };
    const options = permissionOptions("request-redelivered", "tool-redelivered");
    const firstAuthority = Promise.withResolvers<void>();
    const releaseAuthority = Promise.withResolvers<void>();
    let toolCommits = 0;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "permission/requested.tool" && ++toolCommits === 1) {
        firstAuthority.resolve();
        await releaseAuthority.promise;
      }
    });
    await registerRun(harness.adapter);
    const first = harness.adapter.openPermission(RUN_ID, "Bash", input, options);
    await firstAuthority.promise;
    const replay = harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { ...input },
      {
        ...options,
        signal: new AbortController().signal,
      },
    );
    releaseAuthority.resolve();

    const [interactionId, replayedInteractionId] = await Promise.all([first, replay]);
    expect(replayedInteractionId).toBe(interactionId);
    expect(toolCommits).toBe(1);
    expect(harness.snapshot().interactions).toHaveLength(1);
  });

  test("cancels an opening permission when a replay signal aborts", async () => {
    const interactionWriting = Promise.withResolvers<void>();
    const releaseInteraction = Promise.withResolvers<void>();
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "permission/requested") {
        interactionWriting.resolve();
        await releaseInteraction.promise;
      }
    });
    await registerRun(harness.adapter);
    const firstController = new AbortController();
    const replayController = new AbortController();
    const options = {
      ...permissionOptions("request-opening-replay", "tool-opening-replay"),
      signal: firstController.signal,
    };
    const first = harness.adapter.openPermission(RUN_ID, "Bash", { command: "pwd" }, options);
    await interactionWriting.promise;
    const replay = harness.adapter.openPermission(RUN_ID, "Bash", { command: "pwd" }, {
      ...options,
      signal: replayController.signal,
    });

    replayController.abort();
    releaseInteraction.resolve();

    expect(await Promise.allSettled([first, replay])).toMatchObject([
      { reason: { name: "AbortError" }, status: "rejected" },
      { reason: { name: "AbortError" }, status: "rejected" },
    ]);
    expect(harness.snapshot().interactions).toMatchObject([
      { resolution: { type: "cancelled" }, status: "resolved" },
    ]);
  });

  test("does not allow a pending permission after a replay signal aborts", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    const options = permissionOptions("request-pending-replay", "tool-pending-replay");
    const interactionId = await harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { command: "pwd" },
      options,
    );
    const replayController = new AbortController();
    await harness.adapter.openPermission(RUN_ID, "Bash", { command: "pwd" }, {
      ...options,
      signal: replayController.signal,
    });
    const interaction = harness.snapshot().interactions[0];
    const allowOnceId =
      interaction?.kind === "permission"
        ? interaction.request.options.find(
            (option) => option.effect === "allow" && option.scope === "once",
          )?.id
        : undefined;

    replayController.abort();
    await expect(
      harness.adapter.resolveInteraction(interactionId, {
        kind: "permission",
        value: { optionId: allowOnceId!, type: "selected" },
      }),
    ).resolves.toBeNull();
    expect(harness.snapshot().interactions[0]).toMatchObject({
      resolution: { type: "cancelled" },
      status: "resolved",
    });
  });

  test("rejects an already-aborted permission without creating Authority state", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    const controller = new AbortController();
    controller.abort();

    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", { command: "pwd" }, {
        requestId: "request-aborted",
        signal: controller.signal,
        toolUseID: "tool-aborted",
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.authority).toHaveLength(0);
    expect(harness.snapshot().items).toHaveLength(0);
    expect(harness.snapshot().interactions).toHaveLength(0);
  });

  test("resolves and releases a pending permission when its SDK signal aborts", async () => {
    const input = { command: "pwd" };
    const controller = new AbortController();
    const options = {
      ...permissionOptions("request-abort-pending", "tool-abort-pending"),
      signal: controller.signal,
    };
    const harness = createHarness(5 * 60 * 1_000, undefined, permissionBytes(input, options));
    await registerRun(harness.adapter);
    const interactionId = await harness.adapter.openPermission(RUN_ID, "Bash", input, options);

    controller.abort();
    await expect(
      harness.adapter.resolveInteraction(interactionId, {
        kind: "permission",
        value: { type: "cancelled" },
      }),
    ).resolves.toBeNull();

    expect(harness.snapshot().interactions[0]).toMatchObject({
      id: interactionId,
      resolution: { type: "cancelled" },
      status: "resolved",
    });
    await expect(
      harness.adapter.openPermission(
        RUN_ID,
        "Bash",
        input,
        permissionOptions("request-abort-reuse", "tool-abort-reuse"),
      ),
    ).resolves.toBeDefined();
  });

  test("retries an aborted permission after a rejected Authority write", async () => {
    const controller = new AbortController();
    const firstAbort = Promise.withResolvers<void>();
    let rejectAbort = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, (update) => {
      if (update.event === "permission/aborted" && rejectAbort) {
        rejectAbort = false;
        firstAbort.resolve();
        throw new Error("Authority unavailable");
      }
    });
    await registerRun(harness.adapter);
    const interactionId = await harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { command: "pwd" },
      {
        requestId: "request-abort-retry",
        signal: controller.signal,
        toolUseID: "tool-abort-retry",
      },
    );

    controller.abort();
    await firstAbort.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.snapshot().interactions[0]?.status).toBe("open");

    await expect(
      harness.adapter.resolveInteraction(interactionId, {
        kind: "permission",
        value: { type: "cancelled" },
      }),
    ).resolves.toBeNull();
    expect(harness.snapshot().interactions[0]).toMatchObject({
      resolution: { type: "cancelled" },
      status: "resolved",
    });
  });

  test("retries the exact cancelled snapshot after an unknown Authority outcome", async () => {
    const controller = new AbortController();
    const firstAbort = Promise.withResolvers<void>();
    const aborts: ContractAuthorityUpdate[] = [];
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, (update) => {
      if (update.event !== "permission/aborted") {
        return;
      }

      aborts.push(update);
      if (aborts.length === 1) {
        firstAbort.resolve();
        throw new AuthorityOutcomeUnknownError("Authority response was lost");
      }
    });
    await registerRun(harness.adapter);
    const interactionId = await harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { command: "pwd" },
      {
        requestId: "request-abort-unknown",
        signal: controller.signal,
        toolUseID: "tool-abort-unknown",
      },
    );

    controller.abort();
    await firstAbort.promise;
    await Promise.resolve();
    await expect(
      harness.adapter.resolveInteraction(interactionId, {
        kind: "permission",
        value: { type: "cancelled" },
      }),
    ).resolves.toBeNull();

    expect(aborts).toHaveLength(2);
    expect(aborts[1]?.mutationId).toBe(aborts[0]?.mutationId);
    expect(aborts[1]?.operations).toEqual(aborts[0]?.operations);
  });

  test("converges a permission aborted during its opening Authority write", async () => {
    const interactionWriting = Promise.withResolvers<void>();
    const releaseInteraction = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "permission/requested") {
        interactionWriting.resolve();
        await releaseInteraction.promise;
      }
      if (update.event === "permission/aborted") {
        aborted.resolve();
      }
    });
    await registerRun(harness.adapter);
    const controller = new AbortController();
    const opening = harness.adapter.openPermission(RUN_ID, "Bash", { command: "pwd" }, {
      requestId: "request-abort-opening",
      signal: controller.signal,
      toolUseID: "tool-abort-opening",
    });
    await interactionWriting.promise;

    controller.abort();
    releaseInteraction.resolve();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    await aborted.promise;
    expect(harness.snapshot().interactions[0]).toMatchObject({
      resolution: { type: "cancelled" },
      status: "resolved",
    });
  });

  test("retains an opening permission when its cancellation write is rejected", async () => {
    const input = { command: "pwd" };
    const controller = new AbortController();
    const options = {
      ...permissionOptions("request-orphan-1", "tool-orphan-1"),
      signal: controller.signal,
    };
    const interactionWriting = Promise.withResolvers<void>();
    const releaseInteraction = Promise.withResolvers<void>();
    let rejectCancellation = true;
    const requested: ContractAuthorityUpdate[] = [];
    const harness = createHarness(
      5 * 60 * 1_000,
      undefined,
      permissionBytes(input, options),
      async (update) => {
        if (update.event === "permission/requested") {
          requested.push(update);
          interactionWriting.resolve();
          await releaseInteraction.promise;
        }
        if (update.event === "permission/aborted" && rejectCancellation) {
          rejectCancellation = false;
          throw new Error("Authority unavailable");
        }
      },
    );
    await registerRun(harness.adapter);
    const opening = harness.adapter.openPermission(RUN_ID, "Bash", input, options);
    await interactionWriting.promise;

    const retryOptions = permissionOptions("request-orphan-2", "tool-orphan-2");
    controller.abort();
    releaseInteraction.resolve();
    await expect(opening).rejects.toThrow("Authority unavailable");

    const interactionId = harness.snapshot().interactions[0]?.id;
    expect(interactionId).toBeDefined();
    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", input, retryOptions),
    ).rejects.toThrow("pending permission budget");
    expect(requested).toHaveLength(1);
    await expect(
      harness.adapter.resolveInteraction(interactionId!, {
        kind: "permission",
        value: { type: "cancelled" },
      }),
    ).resolves.toBeNull();
    expect(harness.snapshot().interactions[0]).toMatchObject({
      id: interactionId,
      resolution: { type: "cancelled" },
      status: "resolved",
    });
    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", input, retryOptions),
    ).resolves.toBeDefined();
  });

  test("releases an opening permission reservation when its run finishes", async () => {
    const input = { command: "pwd" };
    const options = permissionOptions("request-late", "tool-late");
    const interactionAuthority = Promise.withResolvers<void>();
    const releaseAuthority = Promise.withResolvers<void>();
    const harness = createHarness(
      5 * 60 * 1_000,
      undefined,
      permissionBytes(input, options),
      async (update) => {
        if (update.event === "permission/requested") {
          interactionAuthority.resolve();
          await releaseAuthority.promise;
        }
      },
    );
    await registerRun(harness.adapter);
    const opening = harness.adapter.openPermission(RUN_ID, "Bash", input, options);
    await interactionAuthority.promise;

    const finishing = harness.adapter.handleMessage(
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
        uuid: "result-late-permission",
      }),
      RUN_ID,
    );
    releaseAuthority.resolve();
    await finishing;

    await expect(opening).rejects.toThrow("active Run");
    await expect(
      harness.adapter.openPermission(
        RUN_ID,
        "Bash",
        input,
        permissionOptions("request-next", "tool-next"),
      ),
    ).rejects.toThrow("unknown run");
  });

  test("translates a Coordinator expiry without rechecking its local deadline", async () => {
    const harness = createHarness(1_000);
    await registerRun(harness.adapter);
    const interactionId = await harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { command: "pwd" },
      {
        requestId: "request-expired",
        signal: new AbortController().signal,
        toolUseID: "tool-expired",
      },
    );
    harness.advance(1_001);
    harness.settleInteraction(interactionId);

    await expect(
      harness.adapter.resolveInteraction(interactionId, {
        kind: "permission",
        value: { type: "cancelled" },
      }),
    ).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    expect(harness.snapshot().interactions[0]).toMatchObject({ status: "expired" });
  });

  test("turns aborted result frames into a cancelled run and flushes active Preview", async () => {
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
          delta: { text: "partial", type: "text_delta" },
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
        errors: ["aborted"],
        is_error: true,
        modelUsage: {},
        num_turns: 1,
        permission_denials: [],
        session_id: "native-session-1",
        stop_reason: null,
        subtype: "error_during_execution",
        terminal_reason: "aborted_streaming",
        total_cost_usd: 0,
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: "result-1",
      }),
      RUN_ID,
    );

    expect(harness.snapshot().runs[0]?.status).toBe("cancelled");
    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({
        content: [{ text: "partial", type: "text" }],
        kind: "message",
        status: "cancelled",
      }),
    );
  });

  test("bounds streamed and authoritative tool input and normalizes empty SDK labels", async () => {
    const harness = createHarness(5 * 60 * 1_000, 8);
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        event: {
          content_block: { id: "tool-1", input: {}, name: "", type: "tool_use" },
          index: 0,
          type: "content_block_start",
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
        event: {
          delta: { partial_json: '{"payload":"too-large"}', type: "input_json_delta" },
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
        event: { index: 0, type: "content_block_stop" },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await expect(
      harness.adapter.handleMessage(
        sdkMessage({
          message: {
            content: [
              {
                id: "tool-1",
                input: { payload: "authoritative" },
                name: "",
                type: "tool_use",
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "native-session-1",
          type: "assistant",
          uuid: "assistant-1",
        }),
        RUN_ID,
      ),
    ).rejects.toThrow("exceeds its byte limit");

    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({
        input: {},
        kind: "tool",
        name: "Tool",
      }),
    );
  });

  test("does not let a late stream stop overwrite authoritative tool input", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        event: {
          content_block: { id: "tool-1", input: {}, name: "Read", type: "tool_use" },
          index: 0,
          type: "content_block_start",
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
        event: {
          delta: { partial_json: '{"value":1}', type: "input_json_delta" },
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
          content: [{ id: "tool-1", input: { value: 2 }, name: "Read", type: "tool_use" }],
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "assistant",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        event: { index: 0, type: "content_block_stop" },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );

    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({ id: "tool:tool-1", input: { value: 2 } }),
    );
  });

  test("rejects oversized permission input before creating Authority state", async () => {
    const harness = createHarness(5 * 60 * 1_000, 8);
    await registerRun(harness.adapter);

    await expect(
      harness.adapter.openPermission(
        RUN_ID,
        "Bash",
        { payload: "too-large" },
        {
          requestId: "oversized-request",
          signal: new AbortController().signal,
          toolUseID: "tool-oversized",
        },
      ),
    ).rejects.toThrow("exceeds its byte limit");
    expect(harness.snapshot().items).toHaveLength(0);
    expect(harness.snapshot().interactions).toHaveLength(0);
  });

  test.each([Number.POSITIVE_INFINITY, 1.5])("rejects invalid tool input limit %p", (value) => {
    expect(() => createHarness(5 * 60 * 1_000, value)).toThrow(
      "limits must be finite and positive",
    );
  });

  test.each([Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid pending permission limit %p",
    (value) => {
      expect(() => createHarness(5 * 60 * 1_000, undefined, value)).toThrow(
        "limits must be finite and positive",
      );
    },
  );

  test("preserves first-seen assistant block order", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        message: {
          content: [
            { text: "before tool", type: "text" },
            { id: "tool-1", input: {}, name: "Read", type: "tool_use" },
            { thinking: "after tool", type: "thinking" },
          ],
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "assistant",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );

    expect(harness.snapshot().items.map((item) => item.kind)).toEqual([
      "message",
      "tool",
      "reasoning",
    ]);
  });

  test("isolates streamed tool indexes by assistant and drops invalid JSON fragments", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);

    for (const [uuid, toolId] of [
      ["assistant-a", "tool-a"],
      ["assistant-b", "tool-b"],
      ["assistant-c", "tool-c"],
    ] as const) {
      await harness.adapter.handleMessage(
        sdkMessage({
          event: {
            content_block: { id: toolId, name: "Read", type: "tool_use" },
            index: 0,
            type: "content_block_start",
          },
          parent_tool_use_id: null,
          session_id: "native-session-1",
          type: "stream_event",
          uuid,
        }),
        RUN_ID,
      );
    }

    for (const [uuid, partialJson] of [
      ["assistant-a", '{"a":1}'],
      ["assistant-b", '{"b":2}'],
      ["assistant-c", "{"],
    ] as const) {
      await harness.adapter.handleMessage(
        sdkMessage({
          event: {
            delta: { partial_json: partialJson, type: "input_json_delta" },
            index: 0,
            type: "content_block_delta",
          },
          parent_tool_use_id: null,
          session_id: "native-session-1",
          type: "stream_event",
          uuid,
        }),
        RUN_ID,
      );
    }

    for (const uuid of ["assistant-a", "assistant-b", "assistant-c"] as const) {
      await harness.adapter.handleMessage(
        sdkMessage({
          event: { index: 0, type: "content_block_stop" },
          parent_tool_use_id: null,
          session_id: "native-session-1",
          type: "stream_event",
          uuid,
        }),
        RUN_ID,
      );
    }

    expect(harness.snapshot().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool:tool-a", input: { a: 1 } }),
        expect.objectContaining({ id: "tool:tool-b", input: { b: 2 } }),
      ]),
    );
    const invalid = harness.snapshot().items.find((item) => item.id === "tool:tool-c");
    expect(invalid).toMatchObject({ id: "tool:tool-c", kind: "tool" });
    expect(invalid?.kind === "tool" ? invalid.input : null).toBeUndefined();
  });

  test("avoids phantom messages and cancels unresolved items at a successful result boundary", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        event: { type: "message_start" },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-empty",
      }),
      RUN_ID,
    );
    expect(harness.snapshot().items).toHaveLength(0);

    await harness.adapter.handleMessage(
      sdkMessage({
        elapsed_time_seconds: 1,
        session_id: "native-session-1",
        tool_name: "Read",
        tool_use_id: "tool-pending",
        type: "tool_progress",
        uuid: "progress-1",
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
        stop_reason: null,
        subtype: "success",
        terminal_reason: "background_requested",
        total_cost_usd: 0,
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: "result-1",
      }),
      RUN_ID,
    );

    expect(harness.snapshot().runs[0]).toMatchObject({
      finishReason: "other",
      status: "completed",
    });
    expect(harness.snapshot().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool:tool-pending", status: "cancelled" }),
        expect.objectContaining({ content: [{ text: "done", type: "text" }], status: "completed" }),
      ]),
    );
  });

  test("fences native sessions", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        mcp_servers: [],
        model: "sonnet",
        permissionMode: "default",
        session_id: "native-session-1",
        subtype: "init",
        tools: [],
        type: "system",
        uuid: "init-1",
      }),
      RUN_ID,
    );
    await expect(
      harness.adapter.handleMessage(
        sdkMessage({
          mcp_servers: [],
          model: "sonnet",
          permissionMode: "default",
          session_id: "native-session-2",
          subtype: "init",
          tools: [],
          type: "system",
          uuid: "init-2",
        }),
        RUN_ID,
      ),
    ).rejects.toThrow("different native session");
  });

  test.each([
    ["error_max_turns", "max_turns"],
    ["error_max_budget_usd", "budget_exhausted"],
    ["error_max_structured_output_retries", "structured_output_retry_exhausted"],
  ] as const)("treats %s as a limit", async (subtype, terminalReason) => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        errors: [`Run stopped at ${terminalReason}`],
        is_error: true,
        modelUsage: {},
        num_turns: 10,
        permission_denials: [],
        session_id: "native-session-1",
        stop_reason: null,
        subtype,
        terminal_reason: terminalReason,
        total_cost_usd: 0,
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: "result-1",
      }),
      RUN_ID,
    );

    expect(harness.snapshot().runs[0]).toMatchObject({
      finishReason: "limit",
      status: "completed",
    });
  });

  test("waits for task notification before making a task immutable", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        description: "Research",
        session_id: "native-session-1",
        subtype: "task_started",
        task_id: "task-1",
        type: "system",
        uuid: "task-start-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        description: "Research replay",
        session_id: "native-session-1",
        subtype: "task_started",
        task_id: "task-1",
        type: "system",
        uuid: "task-start-2",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        patch: { status: "completed" },
        session_id: "native-session-1",
        subtype: "task_updated",
        task_id: "task-1",
        type: "system",
        uuid: "task-update-1",
      }),
      RUN_ID,
    );
    expect(harness.snapshot().items[0]?.status).toBe("active");

    await harness.adapter.handleMessage(
      sdkMessage({
        output_file: "/tmp/task-1.output",
        session_id: "native-session-1",
        status: "completed",
        subtype: "task_notification",
        summary: "Research complete",
        task_id: "task-1",
        type: "system",
        usage: { duration_ms: 10, tool_uses: 1, total_tokens: 20 },
        uuid: "task-result-1",
      }),
      RUN_ID,
    );
    expect(harness.snapshot().items[0]).toMatchObject({
      output: [{ text: "Research complete", type: "text" }],
      status: "completed",
    });
  });
});
