import { describe, expect, test } from "bun:test";

import type { DriverEventInput } from "../src/protocol/events";
import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { OpenAiAppServerEventBridge } from "../src/runtimes/openai/app-server-event-bridge";
import { isRecord } from "../src/runtimes/openai/app-server-json";
import {
  CLIENT_RESULT_SCHEMAS,
  isServerRequestMethod,
  parseServerNotification,
} from "../src/runtimes/openai/app-server-protocol";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import { createOpenAiBridgeHarness as createHarness } from "./openai-app-server-event-bridge-fixture";
import {
  normalizeOpenAiProviderEvents as normalizeBridgeEvents,
  readProviderFixture,
} from "./provider-fixture-test-helpers";

interface ProviderNotificationFixture {
  readonly method: string;
  readonly params: unknown;
}

interface TrackTurnFixture {
  readonly expectation: "reject" | "resolve";
  readonly turnId: string;
}

interface ProviderFixtureCase {
  readonly expectedEvents: readonly unknown[];
  readonly notifications: readonly ProviderNotificationFixture[];
  readonly trackTurnBeforeNotifications?: TrackTurnFixture | undefined;
  readonly trackTurnAfterNotifications?: TrackTurnFixture | undefined;
}

const providerFixtureNames = [
  "agent-message-completed",
  "command-output-stream",
  "error-before-tracked-turn",
  "reasoning-empty-summary",
  "root-with-parallel-child-turns",
  "turn-completed-with-final-agent-message",
  "turn-plan-updated",
  "unknown-notification-ignored",
] as const;

function readProviderFixtureCase(path: string): ProviderFixtureCase {
  const fixture = readProviderFixture<ProviderFixtureCase>(path, {
    arrays: ["expectedEvents", "notifications"],
  });

  for (const notification of fixture.notifications) {
    if (!isRecord(notification) || typeof notification["method"] !== "string") {
      throw new TypeError(`Provider fixture ${path} has a malformed notification.`);
    }
  }

  for (const trackTurn of [
    fixture.trackTurnBeforeNotifications,
    fixture.trackTurnAfterNotifications,
  ]) {
    if (
      trackTurn !== undefined &&
      (!isRecord(trackTurn) ||
        (trackTurn["expectation"] !== "reject" && trackTurn["expectation"] !== "resolve") ||
        typeof trackTurn["turnId"] !== "string")
    ) {
      throw new TypeError(`Provider fixture ${path} has malformed turn tracking.`);
    }
  }

  return fixture;
}

async function dispatchProviderNotification(
  input: ProviderNotificationFixture,
  bridge: OpenAiAppServerEventBridge,
  context: AgentDriverContext,
): Promise<void> {
  const notification = parseServerNotification({
    method: input.method,
    params: input.params,
  });

  if (notification === null) {
    return;
  }

  await bridge.handleNotification(context, notification.method, notification.params);
}

function parseNotificationParams(method: string, params: unknown) {
  const notification = parseServerNotification({ method, params });

  if (notification === null) {
    throw new Error(`Unknown OpenAI app-server notification ${method}.`);
  }

  return notification.params;
}

function createOfficialStatusToolItem(
  type:
    | "collabAgentToolCall"
    | "commandExecution"
    | "dynamicToolCall"
    | "fileChange"
    | "imageGeneration"
    | "mcpToolCall",
  status: "failed" | "inProgress" | "in_progress",
  id: string,
): Record<string, unknown> {
  switch (type) {
    case "commandExecution":
      return {
        aggregatedOutput: null,
        command: "true",
        commandActions: [],
        cwd: "/workspace",
        durationMs: null,
        exitCode: status === "failed" ? 1 : null,
        id,
        pluginId: null,
        processId: null,
        scriptPath: null,
        source: "agent",
        status,
        type,
      };
    case "fileChange":
      return { changes: [], id, status, type };
    case "mcpToolCall":
      return {
        appContext: null,
        arguments: {},
        durationMs: null,
        error: status === "failed" ? { message: "failed" } : null,
        id,
        pluginId: null,
        readOnlyHint: null,
        result: null,
        server: "test",
        status,
        tool: "inspect",
        type,
      };
    case "dynamicToolCall":
      return {
        arguments: {},
        contentItems: null,
        durationMs: null,
        id,
        namespace: null,
        status,
        success: status === "failed" ? false : null,
        tool: "inspect",
        type,
      };
    case "collabAgentToolCall":
      return {
        agentsStates: {},
        id,
        model: null,
        prompt: null,
        reasoningEffort: null,
        receiverThreadIds: [],
        senderThreadId: "thread-1",
        status,
        tool: "wait",
        type,
      };
    case "imageGeneration":
      return {
        id,
        result: "",
        revisedPrompt: null,
        status,
        type,
      };
  }
}

async function assertTrackTurnFixture(
  bridge: OpenAiAppServerEventBridge,
  trackTurn: TrackTurnFixture | undefined,
): Promise<void> {
  if (trackTurn === undefined) {
    return;
  }

  const result = bridge.trackTurn(trackTurn.turnId, DRIVER_TEST_IDS.runId);

  if (trackTurn.expectation === "reject") {
    await expect(result).rejects.toThrow();
    return;
  }

  await expect(result).resolves.toBeUndefined();
}

function createThreadFixture(id = "thread-1") {
  return {
    agentNickname: null,
    agentRole: null,
    canAcceptDirectInput: true,
    cliVersion: "0.151.0",
    createdAt: 1_700_000_000,
    cwd: "/workspace",
    ephemeral: false,
    extra: null,
    forkedFromId: null,
    gitInfo: null,
    historyMode: "paginated",
    id,
    modelProvider: "openai",
    name: null,
    parentThreadId: null,
    path: null,
    preview: "Hello",
    projectId: null,
    recencyAt: null,
    section: null,
    sectionEnteredAt: null,
    sessionId: "session-1",
    source: "appServer",
    status: { type: "idle" },
    threadSource: null,
    turns: [],
    updatedAt: 1_700_000_001,
  } as const;
}

function createThreadStartFixture() {
  return {
    activePermissionProfile: null,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    cwd: "/workspace",
    instructionSources: ["/workspace/AGENTS.md"],
    model: "gpt-5.6",
    modelProvider: "openai",
    multiAgentMode: "explicitRequestOnly",
    reasoningEffort: "high",
    runtimeWorkspaceRoots: ["/workspace"],
    sandbox: {
      excludeSlashTmp: false,
      excludeTmpdirEnvVar: false,
      networkAccess: false,
      type: "workspaceWrite",
      writableRoots: ["/workspace"],
    },
    serviceTier: null,
    thread: createThreadFixture(),
  } as const;
}

function createTurnFixture() {
  return {
    completedAt: null,
    durationMs: null,
    error: null,
    id: "turn-1",
    items: [],
    itemsView: "full",
    startedAt: 1_700_000_002,
    status: "inProgress",
  } as const;
}

describe("OpenAI app-server provider fixtures", () => {
  test("normalizes generated IDs without collapsing their equivalence classes", () => {
    const [normalized] = normalizeBridgeEvents([
      {
        kind: "diagnostic.reported",
        payload: {
          first: DRIVER_TEST_IDS.runId,
          repeated: DRIVER_TEST_IDS.runId,
          second: DRIVER_TEST_IDS.secondRunId,
        },
        sourceEventId: `test:${DRIVER_TEST_IDS.thirdRunId}`,
      } as unknown as DriverEventInput,
    ]);

    expect(normalized?.["payload"]).toEqual({
      first: "<driver-id>",
      repeated: "<driver-id>",
      second: "<driver-id-2>",
    });
    expect(normalized?.["sourceEventId"]).toBe("test:<driver-id-3>");
  });

  test("matches the installed reasoning, MCP progress, and interactive request surface", () => {
    expect(
      parseNotificationParams("item/reasoning/summaryPartAdded", {
        itemId: "reasoning-1",
        summaryIndex: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toEqual({
      itemId: "reasoning-1",
      summaryIndex: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(
      parseNotificationParams("item/mcpToolCall/progress", {
        itemId: "tool-1",
        message: "Working",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toEqual({
      itemId: "tool-1",
      message: "Working",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(isServerRequestMethod("item/tool/requestUserInput")).toBe(true);
    expect(isServerRequestMethod("item/tool/call")).toBe(true);
    expect(isServerRequestMethod("mcpServer/elicitation/request")).toBe(true);
    expect(isServerRequestMethod("account/chatgptAuthTokens/refresh")).toBe(true);
    expect(isServerRequestMethod("applyPatchApproval")).toBe(true);
    expect(isServerRequestMethod("attestation/generate")).toBe(true);
    expect(isServerRequestMethod("currentTime/read")).toBe(true);
    expect(isServerRequestMethod("execCommandApproval")).toBe(true);
    expect(parseServerNotification({ method: "account/updated", params: {} })).toEqual({
      method: "account/updated",
      params: {},
    });
    expect(
      parseNotificationParams("serverRequest/resolved", {
        requestId: 7,
        threadId: "thread-1",
      }),
    ).toEqual({ requestId: 7, threadId: "thread-1" });
    expect(
      parseNotificationParams("thread/tokenUsage/updated", {
        threadId: "thread-1",
        tokenUsage: {
          last: {
            cacheWriteInputTokens: 3,
            cachedInputTokens: 2,
            inputTokens: 10,
            outputTokens: 4,
            reasoningOutputTokens: 1,
            totalTokens: 14,
          },
          modelContextWindow: 200_000,
          total: {
            cacheWriteInputTokens: 30,
            cachedInputTokens: 20,
            inputTokens: 100,
            outputTokens: 40,
            reasoningOutputTokens: 10,
            totalTokens: 140,
          },
        },
        turnId: "turn-1",
      }),
    ).toEqual({
      threadId: "thread-1",
      tokenUsage: {
        last: {
          cacheWriteInputTokens: 3,
          cachedInputTokens: 2,
          inputTokens: 10,
          outputTokens: 4,
          reasoningOutputTokens: 1,
          totalTokens: 14,
        },
        modelContextWindow: 200_000,
        total: {
          cacheWriteInputTokens: 30,
          cachedInputTokens: 20,
          inputTokens: 100,
          outputTokens: 40,
          reasoningOutputTokens: 10,
          totalTokens: 140,
        },
      },
      turnId: "turn-1",
    });
  });

  test("classifies unused MCP-stream and realtime timeline notifications explicitly", async () => {
    const { bridge, context, events } = createHarness();
    const realtimeItem = {
      id: "realtime-item-1",
      realtimeSessionId: "realtime-1",
      type: "realtimeSessionStarted",
    } as const;
    const notifications: ProviderNotificationFixture[] = [
      {
        method: "mcpServer/event/stream/notification",
        params: {
          notification: { method: "notifications/tools/list_changed", params: {} },
          subscriptionId: "subscription-1",
        },
      },
      {
        method: "thread/realtime/item/started",
        params: { item: realtimeItem, threadId: "thread-1" },
      },
      {
        method: "thread/realtime/item/transcript/delta",
        params: { delta: "hello", itemId: realtimeItem.id, threadId: "thread-1" },
      },
      {
        method: "thread/realtime/item/completed",
        params: { item: realtimeItem, threadId: "thread-1" },
      },
    ];

    for (const notification of notifications) {
      expect(parseServerNotification(notification)).not.toBeNull();
      await dispatchProviderNotification(notification, bridge, context);
    }

    expect(events()).toEqual([]);
  });

  test.each([undefined, "unknown", "inProgress"])(
    "rejects non-terminal turn/completed status %p",
    (status) => {
      expect(() =>
        parseNotificationParams("turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", items: [], ...(status === undefined ? {} : { status }) },
        }),
      ).toThrow();
    },
  );

  test.each([
    ["failed", null],
    ["completed", { message: "unexpected" }],
    ["interrupted", { message: "unexpected" }],
  ] as const)("rejects turn/completed status %s with contradictory error", (status, error) => {
    expect(() =>
      parseNotificationParams("turn/completed", {
        threadId: "thread-1",
        turn: { error, id: "turn-1", items: [], status },
      }),
    ).toThrow("turn.error must be present exactly when the turn failed");
  });

  test("accepts a failed turn/completed with its required error", () => {
    expect(
      parseNotificationParams("turn/completed", {
        threadId: "thread-1",
        turn: { error: { message: "failed" }, id: "turn-1", items: [], status: "failed" },
      }),
    ).toMatchObject({ turn: { error: { message: "failed" }, status: "failed" } });
  });

  test.each(["id", "items", "status"] as const)(
    "rejects turn/start without schema-required Turn field %s",
    (missing) => {
      const turn: Record<string, unknown> = {
        completedAt: null,
        durationMs: null,
        error: null,
        id: "turn-1",
        items: [],
        itemsView: "notLoaded",
        startedAt: null,
        status: "inProgress",
      };
      delete turn[missing];

      expect(() => CLIENT_RESULT_SCHEMAS["turn/start"].parse({ turn })).toThrow(missing);
    },
  );

  test.each(["codexHome", "platformFamily", "platformOs", "userAgent"] as const)(
    "rejects initialize without required response field %s",
    (missing) => {
      const response: Record<string, unknown> = {
        codexHome: "/tmp/openai-home",
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "test-app-server/0.151.0",
      };
      delete response[missing];

      expect(() => CLIENT_RESULT_SCHEMAS.initialize.parse(response)).toThrow(missing);
    },
  );

  test("preserves the complete initialize response", () => {
    const response = {
      codexHome: "/tmp/openai-home",
      platformFamily: "unix",
      platformOs: "linux",
      userAgent: "test-app-server/0.151.0",
    };

    expect(CLIENT_RESULT_SCHEMAS.initialize.parse(response)).toEqual(response);
  });

  test.each([
    "approvalPolicy",
    "approvalsReviewer",
    "cwd",
    "model",
    "modelProvider",
    "sandbox",
    "thread",
  ] as const)("rejects thread/start without schema-required response field %s", (missing) => {
    const response: Record<string, unknown> = { ...createThreadStartFixture() };
    delete response[missing];

    expect(() => CLIENT_RESULT_SCHEMAS["thread/start"].parse(response)).toThrow(missing);
  });

  test("preserves the complete thread/start response and rejects a sparse thread", () => {
    const response = createThreadStartFixture();

    expect(CLIENT_RESULT_SCHEMAS["thread/start"].parse(response)).toEqual(response);
    expect(() =>
      CLIENT_RESULT_SCHEMAS["thread/start"].parse({
        ...response,
        thread: { id: "thread-1" },
      }),
    ).toThrow("sessionId");
  });

  test.each(["thread/start", "thread/resume"] as const)(
    "preserves omitted optional %s wire fields",
    (method: "thread/resume" | "thread/start") => {
      const response: Record<string, unknown> = {
        ...createThreadStartFixture(),
        ...(method === "thread/resume"
          ? {
              initialTurnsPage: null,
              itemsBackwardsCursor: null,
              turnsBackwardsCursor: null,
            }
          : {}),
      };
      delete response["reasoningEffort"];
      delete response["serviceTier"];

      expect(CLIENT_RESULT_SCHEMAS[method].parse(response)).toEqual(response);
    },
  );

  test("applies the official thread/resume pagination defaults", () => {
    const response = createThreadStartFixture();

    expect(CLIENT_RESULT_SCHEMAS["thread/resume"].parse(response)).toEqual({
      ...response,
      initialTurnsPage: null,
      itemsBackwardsCursor: null,
      turnsBackwardsCursor: null,
    });
  });

  test("preserves the complete thread/resume pagination response", () => {
    const response = {
      ...createThreadStartFixture(),
      initialTurnsPage: {
        backwardsCursor: "turn-head",
        data: [createTurnFixture()],
        nextCursor: null,
      },
      itemsBackwardsCursor: "item-head",
      turnsBackwardsCursor: "turn-head",
    };

    expect(CLIENT_RESULT_SCHEMAS["thread/resume"].parse(response)).toEqual(response);
  });

  test("preserves structured turn errors and rejects unknown thread items", () => {
    const turn = {
      ...createTurnFixture(),
      error: {
        additionalDetails: "HTTP 502 from upstream.",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
        message: "Response stream disconnected.",
        misalignment: null,
      },
      status: "failed",
    };

    expect(CLIENT_RESULT_SCHEMAS["turn/start"].parse({ turn })).toEqual({ turn });
    expect(() =>
      CLIENT_RESULT_SCHEMAS["turn/start"].parse({
        turn: { ...createTurnFixture(), items: [{ id: "item-1", type: "futureItem" }] },
      }),
    ).toThrow("Invalid input");
  });

  test.each([
    ["failed", null],
    ["completed", { message: "unexpected" }],
    ["interrupted", { message: "unexpected" }],
    ["inProgress", { message: "unexpected" }],
  ] as const)("rejects turn/start status %s with contradictory error", (status, error) => {
    expect(() =>
      CLIENT_RESULT_SCHEMAS["turn/start"].parse({
        turn: { error, id: "turn-1", items: [], status },
      }),
    ).toThrow("turn.error must be present exactly when the turn failed");
  });

  test("accepts an in-progress turn/start without an error", () => {
    expect(
      CLIENT_RESULT_SCHEMAS["turn/start"].parse({
        turn: { id: "turn-1", items: [], status: "inProgress" },
      }),
    ).toMatchObject({ turn: { status: "inProgress" } });
  });

  test("accepts omitted optional TurnError wire fields without inventing classification", () => {
    expect(
      parseNotificationParams("error", {
        error: { message: "Provider failed." },
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
      }),
    ).toEqual({
      error: { additionalDetails: null, message: "Provider failed.", misalignment: null },
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
    });
  });

  test("rejects a non-object thread/inject_items response", () => {
    expect(() => CLIENT_RESULT_SCHEMAS["thread/inject_items"].parse(null)).toThrow(
      "expected object",
    );
  });

  test("preserves the assistant item identity on text deltas", () => {
    expect(
      parseNotificationParams("item/agentMessage/delta", {
        delta: "中文 delta",
        itemId: "message-1",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toEqual({
      delta: "中文 delta",
      itemId: "message-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(() =>
      parseNotificationParams("item/agentMessage/delta", {
        delta: "missing identity",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toThrow("itemId");
  });

  test("preserves the terminal turn item loading state", () => {
    expect(
      parseNotificationParams("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          itemsView: "notLoaded",
          status: "completed",
        },
      }),
    ).toMatchObject({
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "notLoaded",
        status: "completed",
      },
    });
  });

  test("maps official collaboration items to complete tool lifecycles", async () => {
    const { bridge, context, events } = createHarness();
    const cases = [
      {
        agentStatus: "completed",
        id: "collab-ok",
        message: "result",
        publicStatus: "completed",
        status: "completed",
      },
      {
        agentStatus: "errored",
        id: "collab-failed",
        message: "boom",
        publicStatus: "failed",
        status: "failed",
      },
      {
        agentStatus: "interrupted",
        id: "collab-interrupted",
        message: "stopped",
        publicStatus: "cancelled",
        status: "interrupted",
      },
    ] as const;

    for (const item of cases) {
      await dispatchProviderNotification(
        {
          method: "item/started",
          params: {
            item: {
              agentsStates: {},
              id: item.id,
              model: "gpt-5.4",
              prompt: "Inspect the migration",
              reasoningEffort: "high",
              receiverThreadIds: ["agent-1"],
              senderThreadId: "thread-1",
              status: "inProgress",
              tool: "wait",
              type: "collabAgentToolCall",
            },
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
        bridge,
        context,
      );
      await dispatchProviderNotification(
        {
          method: "item/completed",
          params: {
            completedAtMs: 2,
            item: {
              agentsStates: {
                "agent-1": { message: item.message, status: item.agentStatus },
              },
              id: item.id,
              model: "gpt-5.4",
              prompt: "Inspect the migration",
              reasoningEffort: "high",
              receiverThreadIds: ["agent-1"],
              senderThreadId: "thread-1",
              status: item.status,
              tool: "wait",
              type: "collabAgentToolCall",
            },
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
        bridge,
        context,
      );
    }

    for (const item of cases) {
      const updates = events().filter(
        (event) =>
          event.kind === "tool.call.updated" &&
          isRecord(event.payload) &&
          event.payload["toolCallId"] === item.id,
      );

      expect(
        updates.map((event) => (isRecord(event.payload) ? event.payload["status"] : null)),
      ).toEqual(["running", item.publicStatus]);
      expect(updates.at(-1)).toMatchObject({
        payload: {
          agentId: "agent-1",
          structuredOutput: {
            agentsStates: {
              "agent-1": { message: item.message, status: item.agentStatus },
            },
            model: "gpt-5.4",
            prompt: "Inspect the migration",
            reasoningEffort: "high",
            receiverThreadIds: ["agent-1"],
            senderThreadId: "thread-1",
            status: item.status,
            tool: "wait",
          },
        },
      });
    }
  });

  test.each([
    ["sendMessage", "Send message to agent"],
    ["followupTask", "Follow up with agent"],
    ["interruptAgent", "Interrupt agent"],
    ["listAgents", "List agents"],
  ] as const)("maps the new %s collaboration tool lifecycle", async (tool, title) => {
    const { bridge, context, events } = createHarness();
    const baseItem = {
      agentsStates: {},
      id: `collab-${tool}`,
      model: null,
      prompt: null,
      reasoningEffort: null,
      receiverThreadIds: [],
      senderThreadId: "thread-1",
      tool,
      type: "collabAgentToolCall",
    } as const;

    for (const [method, status] of [
      ["item/started", "inProgress"],
      ["item/completed", "completed"],
    ] as const) {
      await dispatchProviderNotification(
        {
          method,
          params: {
            ...(method === "item/started" ? { startedAtMs: 1 } : { completedAtMs: 2 }),
            item: { ...baseItem, status },
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
        bridge,
        context,
      );
    }

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "tool.call.updated",
        payload: expect.objectContaining({ status: "running", title }),
      }),
    );
    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "tool.call.updated",
        payload: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  test("maps official sleep items to tool lifecycle", async () => {
    const { bridge, context, events } = createHarness();
    const item = { durationMs: 2_000, id: "sleep-1", type: "sleep" } as const;

    for (const method of ["item/started", "item/completed"] as const) {
      await dispatchProviderNotification(
        {
          method,
          params: {
            ...(method === "item/started" ? { startedAtMs: 1 } : { completedAtMs: 2 }),
            item,
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
        bridge,
        context,
      );
    }

    const updates = events().filter(
      (event) =>
        event.kind === "tool.call.updated" &&
        isRecord(event.payload) &&
        event.payload["toolCallId"] === item.id,
    );
    expect(
      updates.map((event) => (isRecord(event.payload) ? event.payload["status"] : null)),
    ).toEqual(["running", "completed"]);
    expect(updates.at(-1)).toMatchObject({ payload: { rawOutput: "Slept for 2000 ms." } });
  });

  test("preserves command, MCP, and dynamic tool inputs and structured results", async () => {
    const { bridge, context, events } = createHarness();
    const items = [
      {
        aggregatedOutput: "ok\n",
        command: "bun test",
        commandActions: [{ command: "bun test", type: "unknown" }],
        cwd: "/workspace",
        durationMs: 42,
        exitCode: 0,
        id: "command-audit",
        pluginId: "plugin.test",
        processId: "process-1",
        scriptPath: "scripts/test.ts",
        source: "agent",
        status: "completed",
        type: "commandExecution",
      },
      {
        appContext: null,
        arguments: { depth: 2, path: "src" },
        durationMs: 7,
        error: null,
        id: "mcp-audit",
        pluginId: null,
        readOnlyHint: true,
        result: {
          _meta: { private: true },
          content: [{ _meta: { blockPrivate: true }, text: "done", type: "text" }],
          structuredContent: {
            _meta: { structuredPrivate: true },
            files: ["src/index.ts"],
          },
        },
        server: "filesystem",
        status: "completed",
        tool: "inspect",
        type: "mcpToolCall",
      },
      {
        arguments: { query: "migration" },
        contentItems: [{ text: "found", type: "inputText" }],
        durationMs: 9,
        id: "dynamic-audit",
        namespace: "project",
        status: "completed",
        success: true,
        tool: "lookup",
        type: "dynamicToolCall",
      },
    ] as const;

    for (const item of items) {
      await dispatchProviderNotification(
        {
          method: "item/completed",
          params: { completedAtMs: 2, item, threadId: "thread-1", turnId: "turn-1" },
        },
        bridge,
        context,
      );
    }

    const terminalPayload = (toolCallId: string) =>
      events().find(
        (event) =>
          event.kind === "tool.call.updated" &&
          isRecord(event.payload) &&
          event.payload["toolCallId"] === toolCallId &&
          event.payload["status"] === "completed",
      )?.payload;
    expect(terminalPayload("command-audit")).toMatchObject({
      rawInput: "bun test",
      rawOutput: "ok\n",
      structuredOutput: {
        commandActions: [{ command: "bun test", type: "unknown" }],
        cwd: "/workspace",
        durationMs: 42,
        exitCode: 0,
        pluginId: "plugin.test",
        processId: "process-1",
        scriptPath: "scripts/test.ts",
        source: "agent",
      },
    });
    expect(terminalPayload("mcp-audit")).toMatchObject({
      rawInput: '{"depth":2,"path":"src"}',
      rawOutput: '[{"text":"done","type":"text"}]',
      structuredOutput: { files: ["src/index.ts"] },
    });
    expect(JSON.stringify(terminalPayload("mcp-audit"))).not.toContain("_meta");
    expect(JSON.stringify(terminalPayload("mcp-audit"))).not.toContain("private");
    expect(terminalPayload("dynamic-audit")).toMatchObject({
      rawInput: '{"query":"migration"}',
      structuredOutput: {
        contentItems: [{ text: "found", type: "inputText" }],
        durationMs: 9,
        namespace: "project",
        success: true,
      },
    });
  });

  test("fails closed when no durable image transport is available", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const { bridge, context, events } = createHarness();

    await expect(
      dispatchProviderNotification(
        {
          method: "item/completed",
          params: {
            completedAtMs: 2,
            item: {
              id: "image-outside",
              result: pngBase64,
              revisedPrompt: null,
              savedPath: "/untrusted/provider.png",
              status: "completed",
              type: "imageGeneration",
            },
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
        bridge,
        context,
      ),
    ).rejects.toThrow("without a supported durable image transport");
    expect(JSON.stringify(events())).not.toContain("/untrusted/provider.png");
  });

  test("maps the remaining official ThreadItem variants without silent data loss", async () => {
    const { bridge, context, events } = createHarness();
    const completedItems = [
      {
        action: { queries: ["OpenAI app-server 0.147"], query: null, type: "search" },
        id: "web-1",
        query: "OpenAI app-server 0.147",
        results: [{ title: "Protocol release", url: "https://example.test/release" }],
        type: "webSearch",
      },
      { id: "image-view-1", path: "/tmp/image.png", type: "imageView" },
      { id: "review-enter-1", review: "Review changes", type: "enteredReviewMode" },
      { id: "review-exit-1", review: "Review complete", type: "exitedReviewMode" },
      { id: "compact-1", type: "contextCompaction" },
    ] as const;

    for (const item of completedItems) {
      await dispatchProviderNotification(
        {
          method: "item/completed",
          params: {
            completedAtMs: 2,
            item,
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
        bridge,
        context,
      );
    }

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "tool.call.updated",
        payload: expect.objectContaining({
          structuredOutput: {
            action: { queries: ["OpenAI app-server 0.147"], query: null, type: "search" },
            query: "OpenAI app-server 0.147",
            results: [{ title: "Protocol release", url: "https://example.test/release" }],
          },
          toolCallId: "web-1",
        }),
      }),
    );
    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "tool.call.updated",
        payload: expect.objectContaining({
          rawOutput: "/tmp/image.png",
          toolCallId: "image-view-1",
        }),
      }),
    );
    expect(events().filter((event) => event.kind === "review.updated")).toMatchObject([
      { payload: { mode: "entered", review: "Review changes", status: "completed" } },
      { payload: { mode: "exited", review: "Review complete", status: "completed" } },
    ]);
    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "context.compacted",
        payload: { itemId: "compact-1", status: "completed" },
      }),
    );

    const eventCount = events().length;
    for (const item of [
      { clientId: null, content: [], id: "user-echo-1", type: "userMessage" },
      {
        fragments: [{ hookRunId: "hook-1", text: "provider echo" }],
        id: "hook-echo-1",
        type: "hookPrompt",
      },
      {
        id: "function-output-echo-1",
        name: "lookup",
        namespace: "project",
        output: "provider echo",
        type: "functionCallOutput",
      },
    ] as const) {
      for (const method of ["item/started", "item/completed"] as const) {
        await dispatchProviderNotification(
          {
            method,
            params: {
              ...(method === "item/started" ? { startedAtMs: 2 } : { completedAtMs: 3 }),
              item,
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
          bridge,
          context,
        );
      }
    }
    expect(events()).toHaveLength(eventCount);
  });

  test.each(["started", "interacted", "interrupted", "completed"] as const)(
    "publishes official %s sub-agent activity from completion-only delivery",
    async (activityKind) => {
      const { bridge, context, events } = createHarness();
      const item = {
        agentPath: "/root/worker",
        agentThreadId: "agent-1",
        id: `activity-${activityKind}`,
        kind: activityKind,
        type: "subAgentActivity",
      } as const;

      await dispatchProviderNotification(
        {
          method: "item/completed",
          params: { completedAtMs: 2, item, threadId: "thread-1", turnId: "turn-1" },
        },
        bridge,
        context,
      );
      expect(events()).toEqual([
        {
          delivery: "lossless",
          kind: "agent.task.updated",
          payload: {
            ...(activityKind === "started"
              ? { active: true, status: "running" }
              : activityKind === "interacted"
                ? {}
                : {
                    active: false,
                    status: activityKind === "interrupted" ? "cancelled" : "completed",
                  }),
            activityKind,
            agentId: "agent-1",
            agentPath: "/root/worker",
            taskId: "agent-1",
            title: `Sub-agent ${activityKind}`,
          },
          sourceEventId: expect.stringMatching(/^openai\.derived:sid1_/),
        },
        {
          delivery: "lossless",
          kind: "agent.tasks.replaced",
          payload: {
            tasks:
              activityKind === "started" || activityKind === "interacted"
                ? [
                    {
                      taskId: "agent-1",
                      taskType: "openai_subagent",
                      title: "/root/worker",
                    },
                  ]
                : [],
          },
          sourceEventId: expect.stringMatching(/^openai\.derived:sid1_/),
          visibility: "participant",
        },
      ]);
    },
  );

  test("publishes sub-agent activity and ignores tool-output echo from a terminal snapshot", async () => {
    const { bridge, context, events } = createHarness();

    await dispatchProviderNotification(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-snapshot",
            items: [
              {
                id: "function-output-snapshot",
                name: "lookup",
                namespace: null,
                output: "provider echo",
                type: "functionCallOutput",
              },
              {
                agentPath: "/root/replayed-worker",
                agentThreadId: "agent-replayed",
                id: "activity-replayed",
                kind: "interacted",
                type: "subAgentActivity",
              },
            ],
            status: "completed",
          },
        },
      },
      bridge,
      context,
    );

    expect(events()).toContainEqual({
      delivery: "lossless",
      kind: "agent.task.updated",
      payload: {
        activityKind: "interacted",
        agentId: "agent-replayed",
        agentPath: "/root/replayed-worker",
        taskId: "agent-replayed",
        title: "Sub-agent interacted",
      },
      sourceEventId: expect.stringMatching(/^openai\.derived:sid1_/),
    });
    const snapshots = events().filter((event) => event.kind === "agent.tasks.replaced");
    expect(snapshots).toMatchObject([
      { payload: { tasks: [{ taskId: "agent-replayed" }] } },
      { delivery: "lossless", payload: { tasks: [] }, visibility: "participant" },
    ]);
    expect(events().findIndex((event) => event.kind === "agent.tasks.replaced")).toBeLessThan(
      events().findIndex((event) => event.kind === "run.completed"),
    );
  });

  test.each([
    ["commandExecution", "inProgress"],
    ["fileChange", "inProgress"],
    ["mcpToolCall", "inProgress"],
    ["dynamicToolCall", "inProgress"],
    ["collabAgentToolCall", "inProgress"],
    ["imageGeneration", "in_progress"],
  ] as const)(
    "fails closed on a schema-valid nonterminal %s completion before mutating state",
    async (type, runningStatus) => {
      const { bridge, context, events } = createHarness();
      const id = `nonterminal-${type}`;

      await expect(
        dispatchProviderNotification(
          {
            method: "item/completed",
            params: {
              completedAtMs: 2,
              item: createOfficialStatusToolItem(type, runningStatus, id),
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
          bridge,
          context,
        ),
      ).rejects.toThrow(`OpenAI ${type} completed with non-terminal status ${runningStatus}`);

      // A valid terminal retry for the same item must still publish, proving rejection did not
      // poison the completion dedupe or tool state.
      await dispatchProviderNotification(
        {
          method: "item/completed",
          params: {
            completedAtMs: 3,
            item: createOfficialStatusToolItem(type, "failed", id),
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
        bridge,
        context,
      );

      expect(events()).toContainEqual(
        expect.objectContaining({
          kind: "tool.call.updated",
          payload: expect.objectContaining({ status: "failed", toolCallId: id }),
        }),
      );
    },
  );

  test("rejects completed images and diagnoses provider-declared image failure", async () => {
    const { bridge, context, events } = createHarness();

    await expect(
      dispatchProviderNotification(
        {
          method: "item/completed",
          params: {
            completedAtMs: 2,
            item: {
              id: "image-invalid",
              result: "not base64",
              revisedPrompt: null,
              status: "completed",
              type: "imageGeneration",
            },
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
        bridge,
        context,
      ),
    ).rejects.toThrow("without a supported durable image transport");

    await dispatchProviderNotification(
      {
        method: "item/completed",
        params: {
          completedAtMs: 3,
          item: {
            failure: {
              limitId: "image_generation",
              resetsAt: null,
              type: "usageLimitExceeded",
            },
            id: "image-failed",
            result: "",
            revisedPrompt: "Failed prompt",
            savedPath: "/untrusted/failed.png",
            status: "failed",
            type: "imageGeneration",
          },
          threadId: "thread-1",
          turnId: "turn-1",
        },
      },
      bridge,
      context,
    );

    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "diagnostic.reported",
        payload: expect.objectContaining({ code: "openai.image_generation.failed" }),
        visibility: "owner_debug",
      }),
    );
    expect(events()).toContainEqual(
      expect.objectContaining({
        kind: "tool.call.updated",
        payload: expect.objectContaining({
          status: "failed",
          structuredOutput: {
            failure: {
              limitId: "image_generation",
              resetsAt: null,
              type: "usageLimitExceeded",
            },
          },
          toolCallId: "image-failed",
        }),
      }),
    );
    expect(JSON.stringify(events())).not.toContain("/untrusted/failed.png");
  });

  test.each(providerFixtureNames)("apps provider-native fixture %s", async (name) => {
    const fixture = readProviderFixtureCase(
      `./fixtures/providers/openai-app-server/cases/${name}.json`,
    );
    const { bridge, context, events } = createHarness();

    const trackedTurn = fixture.trackTurnBeforeNotifications;
    const trackedCompletion =
      trackedTurn === undefined
        ? null
        : bridge.trackTurn(trackedTurn.turnId, DRIVER_TEST_IDS.runId);

    for (const notification of fixture.notifications) {
      await dispatchProviderNotification(notification, bridge, context);
    }

    if (trackedCompletion !== null) {
      if (trackedTurn?.expectation === "reject") {
        await expect(trackedCompletion).rejects.toThrow();
      } else {
        await expect(trackedCompletion).resolves.toBeUndefined();
      }
    }
    await assertTrackTurnFixture(bridge, fixture.trackTurnAfterNotifications);

    expect(normalizeBridgeEvents(events())).toEqual(fixture.expectedEvents);
  });
});
