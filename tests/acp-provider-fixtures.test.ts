import { describe, expect, test } from "bun:test";
import type { StopReason } from "@agentclientprotocol/sdk";

import type { DriverEventInput } from "../src/protocol/events";
import {
  AcpAssistantTranscriptState,
  type AcpAssistantTranscriptStateInput,
} from "../src/runtimes/acp/acp-assistant-transcript-state";
import { toSessionReadyEvents } from "../src/runtimes/acp/acp-session-events";
import { normalizeAcpProviderEvents, readProviderFixture } from "./provider-fixture-test-helpers";

interface AcpProviderFixtureCase {
  readonly begin?: AcpAssistantTranscriptStateInput | undefined;
  readonly completePrompt?:
    | { readonly stopReason: StopReason; readonly usage: unknown }
    | undefined;
  readonly expectedEvents: readonly unknown[];
  readonly failPrompt?:
    | {
        readonly code: string;
        readonly message: string;
        readonly recoverable?: boolean | undefined;
      }
    | undefined;
  readonly permissionRequest?: { readonly params: unknown; readonly requestId: string } | undefined;
  readonly sessionReady?:
    | {
        readonly mode: "created" | "loaded" | "resumed";
        readonly nativeSessionId: string;
        readonly setup: Record<string, unknown>;
      }
    | undefined;
  readonly updates: readonly unknown[];
}

const acpFixtureNames = [
  "max-turn-failure",
  "permission-request",
  "session-ready",
  "thought-and-unknown-update",
  "turn-text-tool-usage",
] as const;

function appAcpFixture(fixture: AcpProviderFixtureCase): DriverEventInput[] {
  const state = new AcpAssistantTranscriptState();
  const events: DriverEventInput[] = [];

  if (fixture.begin !== undefined) {
    state.begin(fixture.begin);
  }

  if (fixture.sessionReady !== undefined) {
    events.push(...toSessionReadyEvents(fixture.sessionReady));
  }

  for (const update of fixture.updates) {
    events.push(...state.translateUpdate(update));
  }

  if (fixture.permissionRequest !== undefined) {
    events.push(...state.translatePermission(fixture.permissionRequest).events);
  }

  if (fixture.failPrompt !== undefined) {
    events.push(
      ...state.failPrompt({
        code: fixture.failPrompt.code,
        message: fixture.failPrompt.message,
        ...(fixture.failPrompt.recoverable === undefined
          ? {}
          : { recoverable: fixture.failPrompt.recoverable }),
      }),
    );
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
    const fixture = readProviderFixture<AcpProviderFixtureCase>(
      `./fixtures/providers/acp/cases/${name}.json`,
      { arrays: ["expectedEvents", "updates"] },
    );

    expect(normalizeAcpProviderEvents(appAcpFixture(fixture))).toEqual(fixture.expectedEvents);
  });
});
