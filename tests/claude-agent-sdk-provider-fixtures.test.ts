import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import type { RunId } from "../src/protocol/id";
import type { AgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { ClaudeAgentSdkMessageTranslator } from "../src/runtimes/claude/agent-sdk-message-translator";
import { driverBootPayload as bootPayload } from "./driver-boot-payload-fixture";

interface EventBatch {
  readonly events: DriverEventInput[];
  readonly reason: string;
}

interface ClaudeProviderFixtureCase {
  readonly expectedEvents: readonly unknown[];
  readonly expectedNativeSessionIds: readonly string[];
  readonly messages: readonly unknown[];
  readonly runId: RunId;
}

const claudeFixtureNames = [
  "assistant-final-message",
  "result-failure-diagnostic",
  "stream-text-thinking-tool-result",
  "system-files-and-session",
  "unknown-message-ignored",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

function readClaudeProviderFixtureCase(path: string): ClaudeProviderFixtureCase {
  const fixture = readJsonFixture(path);

  if (!isRecord(fixture)) {
    throw new Error("Claude provider fixture must be an object.");
  }

  const messages = fixture["messages"];
  const expectedEvents = fixture["expectedEvents"];
  const expectedNativeSessionIds = fixture["expectedNativeSessionIds"] ?? [];
  const runId = fixture["runId"];

  if (
    !Array.isArray(messages) ||
    !Array.isArray(expectedEvents) ||
    !Array.isArray(expectedNativeSessionIds) ||
    typeof runId !== "string"
  ) {
    throw new Error("Claude provider fixture shape is malformed.");
  }

  if (!expectedNativeSessionIds.every((entry) => typeof entry === "string")) {
    throw new Error("Claude provider fixture expectedNativeSessionIds must be strings.");
  }

  return {
    expectedEvents,
    expectedNativeSessionIds,
    messages,
    runId,
  };
}

function collectDriverIds(value: unknown, ids: Set<string>): void {
  if (typeof value === "string") {
    if (isDriverId(value)) {
      ids.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDriverIds(entry, ids);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const entry of Object.values(value)) {
    collectDriverIds(entry, ids);
  }
}

function isIsoTimestamp(value: string): boolean {
  return value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}

function normalizeClaudeValue(
  value: unknown,
  driverIds: ReadonlySet<string>,
  fieldName?: string,
): unknown {
  if (typeof value === "string") {
    for (const driverId of driverIds) {
      if (value === driverId) {
        return "<driver-id>";
      }

      if (value.startsWith(`${driverId}:`)) {
        return value.replace(driverId, "<driver-id>");
      }
    }

    if (fieldName !== undefined && fieldName.endsWith("At") && isIsoTimestamp(value)) {
      return "<iso-timestamp>";
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeClaudeValue(entry, driverIds));
  }

  if (!isRecord(value)) {
    return value;
  }

  const entries = Object.entries(value).flatMap(([key, entry]): [string, unknown][] =>
    entry === undefined ? [] : [[key, normalizeClaudeValue(entry, driverIds, key)]],
  );

  return Object.fromEntries(entries);
}

function normalizeClaudeEvents(events: readonly DriverEventInput[]): unknown[] {
  const driverIds = new Set<string>();

  for (const event of events) {
    collectDriverIds(event, driverIds);
  }

  return events.map((event) => normalizeClaudeValue(event, driverIds));
}

function createHarness() {
  const batches: EventBatch[] = [];
  const nativeSessionIds: string[] = [];
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "claude-agent-sdk-provider-fixtures-test",
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
  const translator = new ClaudeAgentSdkMessageTranslator({
    push: async (_context, reason, events) => {
      batches.push({ events, reason });
    },
    recordNativeSessionId: async (_context, sessionId) => {
      nativeSessionIds.push(sessionId);
    },
  });

  return {
    context,
    events: () => batches.flatMap((batch) => batch.events),
    logger,
    nativeSessionIds,
    translator,
  };
}

describe("Claude Agent SDK provider fixtures", () => {
  test.each(claudeFixtureNames)("apps provider-native fixture %s", async (name) => {
    const fixture = readClaudeProviderFixtureCase(
      `./fixtures/providers/claude-agent-sdk/cases/${name}.json`,
    );
    const { context, events, logger, nativeSessionIds, translator } = createHarness();

    for (const message of fixture.messages) {
      await translator.handleSdkMessage(context, message as SDKMessage, fixture.runId);
    }

    await logger.destroy();

    expect(nativeSessionIds).toEqual(fixture.expectedNativeSessionIds);
    expect(normalizeClaudeEvents(events())).toEqual(fixture.expectedEvents);
  });
});
