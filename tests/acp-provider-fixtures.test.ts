import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { DriverEventInput } from "../src/protocol/events";
import {
  AcpTurnEventState,
  toAcpSessionReadyEvents,
} from "../src/runtimes/acp/acp-event-translator";
import type { AcpTurnEventStateInput } from "../src/runtimes/acp/acp-event-translator";
import type { AcpPromptStopReason } from "../src/runtimes/acp/acp-types";

interface CompletePromptFixture {
  readonly stopReason: AcpPromptStopReason;
  readonly usage: unknown;
}

interface FailPromptFixture {
  readonly code: string;
  readonly message: string;
  readonly recoverable?: boolean | undefined;
}

interface PermissionRequestFixture {
  readonly params: unknown;
  readonly requestId: string;
}

interface SessionReadyFixture {
  readonly mode: "created" | "loaded" | "resumed";
  readonly nativeSessionId: string;
  readonly setup: Record<string, unknown>;
}

interface AcpProviderFixtureCase {
  readonly begin?: AcpTurnEventStateInput | undefined;
  readonly completePrompt?: CompletePromptFixture | undefined;
  readonly expectedEvents: readonly unknown[];
  readonly failPrompt?: FailPromptFixture | undefined;
  readonly permissionRequest?: PermissionRequestFixture | undefined;
  readonly sessionReady?: SessionReadyFixture | undefined;
  readonly updates: readonly unknown[];
}

const acpFixtureNames = [
  "max-turn-failure",
  "permission-request",
  "session-ready",
  "thought-and-unknown-update",
  "turn-text-tool-usage",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

function readStringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];

  if (typeof value !== "string") {
    throw new Error(`ACP provider fixture field ${field} must be a string.`);
  }

  return value;
}

function readRecordField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];

  if (!isRecord(value)) {
    throw new Error(`ACP provider fixture field ${field} must be an object.`);
  }

  return value;
}

function readBeginFixture(value: unknown): AcpTurnEventStateInput | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("ACP provider fixture begin must be an object.");
  }

  return {
    messageId: readStringField(value, "messageId"),
    runId: readStringField(value, "runId"),
    sessionId: readStringField(value, "sessionId"),
  };
}

function readCompletePromptFixture(value: unknown): CompletePromptFixture | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("ACP provider fixture completePrompt must be an object.");
  }

  const stopReason = readStringField(value, "stopReason");

  if (
    stopReason !== "cancelled" &&
    stopReason !== "end_turn" &&
    stopReason !== "max_tokens" &&
    stopReason !== "max_turn_requests" &&
    stopReason !== "refusal"
  ) {
    throw new Error("ACP provider fixture completePrompt stopReason is unsupported.");
  }

  return {
    stopReason,
    usage: value["usage"],
  };
}

function readFailPromptFixture(value: unknown): FailPromptFixture | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("ACP provider fixture failPrompt must be an object.");
  }

  const recoverable = value["recoverable"];

  if (recoverable !== undefined && typeof recoverable !== "boolean") {
    throw new Error("ACP provider fixture failPrompt recoverable must be a boolean.");
  }

  return {
    code: readStringField(value, "code"),
    message: readStringField(value, "message"),
    ...(recoverable === undefined ? {} : { recoverable }),
  };
}

function readPermissionRequestFixture(value: unknown): PermissionRequestFixture | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("ACP provider fixture permissionRequest must be an object.");
  }

  return {
    params: value["params"],
    requestId: readStringField(value, "requestId"),
  };
}

function readSessionReadyFixture(value: unknown): SessionReadyFixture | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("ACP provider fixture sessionReady must be an object.");
  }

  const mode = readStringField(value, "mode");

  if (mode !== "created" && mode !== "loaded" && mode !== "resumed") {
    throw new Error("ACP provider fixture sessionReady mode is unsupported.");
  }

  return {
    mode,
    nativeSessionId: readStringField(value, "nativeSessionId"),
    setup: readRecordField(value, "setup"),
  };
}

function readAcpProviderFixtureCase(path: string): AcpProviderFixtureCase {
  const fixture = readJsonFixture(path);

  if (!isRecord(fixture)) {
    throw new Error("ACP provider fixture must be an object.");
  }

  const updates = fixture["updates"] ?? [];
  const expectedEvents = fixture["expectedEvents"];

  if (!Array.isArray(updates) || !Array.isArray(expectedEvents)) {
    throw new Error("ACP provider fixture updates and expectedEvents must be arrays.");
  }

  return {
    begin: readBeginFixture(fixture["begin"]),
    completePrompt: readCompletePromptFixture(fixture["completePrompt"]),
    expectedEvents,
    failPrompt: readFailPromptFixture(fixture["failPrompt"]),
    permissionRequest: readPermissionRequestFixture(fixture["permissionRequest"]),
    sessionReady: readSessionReadyFixture(fixture["sessionReady"]),
    updates,
  };
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }

  if (!isRecord(value)) {
    return value;
  }

  const entries = Object.entries(value).flatMap(([key, entry]): [string, unknown][] =>
    entry === undefined ? [] : [[key, stripUndefined(entry)]],
  );

  return Object.fromEntries(entries);
}

function normalizeAcpEvent(event: DriverEventInput): Record<string, unknown> {
  const eventRecord = stripUndefined(event);

  if (!isRecord(eventRecord)) {
    throw new Error("ACP translator event must be an object.");
  }

  return eventRecord;
}

function appAcpFixture(fixture: AcpProviderFixtureCase): DriverEventInput[] {
  const state = new AcpTurnEventState();
  const events: DriverEventInput[] = [];

  if (fixture.begin !== undefined) {
    state.begin(fixture.begin);
  }

  if (fixture.sessionReady !== undefined) {
    events.push(...toAcpSessionReadyEvents(fixture.sessionReady));
  }

  for (const update of fixture.updates) {
    events.push(...state.translateUpdate(update));
  }

  if (fixture.permissionRequest !== undefined) {
    events.push(...state.translatePermissionRequest(fixture.permissionRequest).events);
  }

  if (fixture.failPrompt !== undefined) {
    events.push(...state.failPrompt(fixture.failPrompt));
  }

  if (fixture.completePrompt !== undefined) {
    events.push(
      ...state.completePrompt(fixture.completePrompt.stopReason, fixture.completePrompt.usage),
    );
  }

  return events;
}

describe("ACP provider fixtures", () => {
  test.each(acpFixtureNames)("apps provider-native fixture %s", (name) => {
    const fixture = readAcpProviderFixtureCase(`./fixtures/providers/acp/cases/${name}.json`);

    expect(appAcpFixture(fixture).map(normalizeAcpEvent)).toEqual(fixture.expectedEvents);
  });
});
