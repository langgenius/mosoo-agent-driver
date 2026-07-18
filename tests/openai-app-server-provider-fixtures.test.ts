import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import type { AgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { OpenAiAppServerEventBridge } from "../src/runtimes/openai/app-server-event-bridge";
import {
  isServerRequestMethod,
  isServerNotificationMethod,
  OPENAI_APP_SERVER_SCHEMA_VERSION,
  parseClientRequestResult,
  parseServerNotificationParams,
} from "../src/runtimes/openai/generated/app-server-protocol";
import type { ServerNotificationMethod } from "../src/runtimes/openai/generated/app-server-protocol";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import { driverBootPayload as bootPayload } from "./driver-boot-payload-fixture";

interface EventBatch {
  readonly events: DriverEventInput[];
  readonly reason: string;
}

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
  readonly trackTurnAfterNotifications?: TrackTurnFixture | undefined;
}

const providerFixtureNames = [
  "agent-message-completed",
  "command-output-stream",
  "error-before-tracked-turn",
  "turn-completed-with-final-agent-message",
  "turn-plan-updated",
  "unknown-notification-ignored",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

function readTrackTurnFixture(value: unknown): TrackTurnFixture | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("Provider fixture trackTurnAfterNotifications must be an object.");
  }

  const expectation = value["expectation"];
  const turnId = value["turnId"];

  if ((expectation !== "reject" && expectation !== "resolve") || typeof turnId !== "string") {
    throw new Error("Provider fixture trackTurnAfterNotifications is malformed.");
  }

  return {
    expectation,
    turnId,
  };
}

function readProviderNotificationFixture(value: unknown): ProviderNotificationFixture {
  if (!isRecord(value)) {
    throw new Error("Provider fixture notification must be an object.");
  }

  const method = value["method"];

  if (typeof method !== "string") {
    throw new Error("Provider fixture notification method must be a string.");
  }

  return {
    method,
    params: value["params"],
  };
}

function readProviderFixtureCase(path: string): ProviderFixtureCase {
  const fixture = readJsonFixture(path);

  if (!isRecord(fixture)) {
    throw new Error("Provider fixture must be an object.");
  }

  const notifications = fixture["notifications"];
  const expectedEvents = fixture["expectedEvents"];

  if (!Array.isArray(notifications) || !Array.isArray(expectedEvents)) {
    throw new Error("Provider fixture must include notifications and expectedEvents arrays.");
  }

  return {
    expectedEvents,
    notifications: notifications.map(readProviderNotificationFixture),
    trackTurnAfterNotifications: readTrackTurnFixture(fixture["trackTurnAfterNotifications"]),
  };
}

function isIsoTimestamp(value: string): boolean {
  return value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}

function normalizeBridgeValue(value: unknown, fieldName?: string): unknown {
  if (typeof value === "string") {
    if (isDriverId(value)) {
      return "<driver-id>";
    }

    if (fieldName !== undefined && fieldName.endsWith("At") && isIsoTimestamp(value)) {
      return "<iso-timestamp>";
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeBridgeValue(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeBridgeValue(entry, key)]),
  );
}

function normalizeBridgeEvent(event: DriverEventInput): Record<string, unknown> {
  const eventRecord = event as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    kind: event.kind,
    payload: normalizeBridgeValue(event.payload),
  };

  for (const field of ["delivery", "native", "runId", "sourceEventId", "visibility"] as const) {
    if (eventRecord[field] !== undefined) {
      normalized[field] = normalizeBridgeValue(eventRecord[field], field);
    }
  }

  return normalized;
}

function createHarness() {
  const batches: EventBatch[] = [];
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "openai-app-server-provider-fixtures-test",
    sink: async () => {},
  });
  const context: AgentDriverContext = createAgentDriverContext({
    eventSink: {
      pushEvents: async () => {},
    },
    logger,
    payload: bootPayload,
    permission: {
      request: async () => "allow_once",
    },
  });
  const bridge = new OpenAiAppServerEventBridge({
    push: async (_context, reason, events) => {
      batches.push({ events, reason });
    },
    requireThreadId: () => "thread-1",
  });

  return {
    batches,
    bridge,
    context,
    events: () => batches.flatMap((batch) => batch.events),
    logger,
  };
}

async function dispatchProviderNotification(
  input: ProviderNotificationFixture,
  bridge: OpenAiAppServerEventBridge,
  context: AgentDriverContext,
): Promise<void> {
  if (!isServerNotificationMethod(input.method)) {
    await bridge.handleNotification(
      context,
      input.method as ServerNotificationMethod,
      input.params as never,
    );
    return;
  }

  await bridge.handleNotification(
    context,
    input.method,
    parseServerNotificationParams(input.method, input.params),
  );
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

describe("OpenAI app-server provider fixtures", () => {
  test("matches the 0.144.5 reasoning, MCP progress, and interactive request surface", () => {
    expect(OPENAI_APP_SERVER_SCHEMA_VERSION).toBe("0.144.5");
    expect(
      parseServerNotificationParams("item/reasoning/summaryPartAdded", {
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
      parseServerNotificationParams("item/mcpToolCall/progress", {
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
    expect(isServerRequestMethod("attestation/generate")).toBe(true);
    expect(isServerRequestMethod("currentTime/read")).toBe(true);
    expect(
      parseServerNotificationParams("serverRequest/resolved", {
        requestId: 7,
        threadId: "thread-1",
      }),
    ).toEqual({ requestId: 7, threadId: "thread-1" });
  });

  test.each([undefined, "inProgress", "unknown"])(
    "rejects non-terminal turn/completed status %p",
    (status) => {
      expect(() =>
        parseServerNotificationParams("turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", ...(status === undefined ? {} : { status }) },
        }),
      ).toThrow();
    },
  );

  test.each([
    "completedAt",
    "durationMs",
    "error",
    "items",
    "itemsView",
    "startedAt",
    "status",
  ] as const)("rejects turn/start without required Turn field %s", (missing) => {
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

    expect(() => parseClientRequestResult("turn/start", { turn })).toThrow(missing);
  });

  test("preserves the assistant item identity on text deltas", () => {
    expect(
      parseServerNotificationParams("item/agentMessage/delta", {
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
      parseServerNotificationParams("item/agentMessage/delta", {
        delta: "missing identity",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toThrow("itemId");
  });

  test("preserves the terminal turn item loading state", () => {
    expect(
      parseServerNotificationParams("turn/completed", {
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

  test.each(providerFixtureNames)("apps provider-native fixture %s", async (name) => {
    const fixture = readProviderFixtureCase(
      `./fixtures/providers/openai-app-server/cases/${name}.json`,
    );
    const { bridge, context, events, logger } = createHarness();

    for (const notification of fixture.notifications) {
      await dispatchProviderNotification(notification, bridge, context);
    }

    await assertTrackTurnFixture(bridge, fixture.trackTurnAfterNotifications);
    await logger.destroy();

    expect(events().map(normalizeBridgeEvent)).toEqual(fixture.expectedEvents);
  });
});
