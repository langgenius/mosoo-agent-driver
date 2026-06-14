import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import type { AgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { OpenAiAppServerEventBridge } from "../src/runtimes/openai/app-server-event-bridge";
import {
  isServerNotificationMethod,
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
