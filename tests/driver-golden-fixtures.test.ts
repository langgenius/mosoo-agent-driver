import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { DRIVER_ID_FIXTURES } from "../src/protocol/boot/testing";
import { parseRuntimeCommand } from "../src/runtime-command";
import { ingestRuntimeEventInput } from "../src/runtime-events";
import type { RuntimeEventBuildContext } from "../src/runtime-events";

const occurredAt = "2026-05-26T00:00:00.000Z";

const commandFixtures = [
  "input-start",
  "mcp-execute",
  "permission-resolve",
  "session-stop",
  "turn-cancel",
] as const;

const runtimeEventFixtures = [
  "diagnostic-reported",
  "message-delta",
  "permission-requested",
  "run-started",
  "tool-call-updated",
  "usage-updated",
] as const;

function readJsonFixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

function createRuntimeEventContext(): RuntimeEventBuildContext {
  return {
    createId: () => DRIVER_ID_FIXTURES.event,
    driverInstanceId: DRIVER_ID_FIXTURES.driverInstance,
    occurredAt,
    runId: DRIVER_ID_FIXTURES.run,
    runtimeId: "runtime-1",
    sessionId: DRIVER_ID_FIXTURES.session,
    traceId: "trace-1",
  };
}

describe("Driver golden fixtures", () => {
  test.each(commandFixtures)("parses runtime command fixture %s", (name) => {
    const fixture = readJsonFixture(`./fixtures/driver/commands/${name}.json`);
    expect(parseRuntimeCommand(fixture)).toEqual(fixture);
  });

  test.each(runtimeEventFixtures)("ingests runtime event fixture %s", (name) => {
    const outcome = ingestRuntimeEventInput(
      createRuntimeEventContext(),
      readJsonFixture(`./fixtures/driver/runtime-event-drafts/${name}.json`),
    );

    expect(outcome).toMatchObject({
      status: "accepted",
    });

    if (outcome.status !== "accepted") {
      throw new Error(outcome.rejection.message);
    }

    expect(outcome.event).toEqual(
      readJsonFixture(`./fixtures/driver/runtime-event-envelopes/${name}.json`),
    );
  });
});
