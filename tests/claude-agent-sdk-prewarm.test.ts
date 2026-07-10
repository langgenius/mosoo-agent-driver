import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBufferedSinkLogger } from "../src/observability";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import type { AgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { ClaudeAgentSdkDriverBackend } from "../src/runtimes/claude/agent-sdk-driver-backend";
import { createPromiseDeferred } from "../src/utils/async";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

interface TestQuery extends AsyncIterable<never> {
  interrupt(): Promise<void>;
}

interface TestWarmQuery {
  close(): void;
  query(prompt: string): TestQuery;
}

interface StartupInput {
  readonly options?: {
    readonly abortController?: AbortController;
  };
}

let coldQueryCount = 0;
let startupImplementation: (input?: StartupInput) => Promise<TestWarmQuery>;
const originalPrewarmEnv = process.env["AGENT_DRIVER_CLAUDE_PREWARM"];

let runtimeRoots: string[] = [];

function createTestQuery(): TestQuery {
  return {
    async *[Symbol.asyncIterator]() {},
    interrupt: async () => {},
  };
}

async function waitUntil(label: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

async function createHarness(): Promise<{
  readonly backend: InstanceType<typeof ClaudeAgentSdkDriverBackend>;
  readonly context: AgentDriverContext;
  readonly destroy: () => Promise<void>;
  readonly logMessages: string[];
}> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "mosoo-claude-prewarm-"));
  runtimeRoots.push(runtimeRoot);
  const payload = createDriverStartInputFromBootPayload({
    ...driverBootPayload,
    execution: {
      ...driverBootPayload.execution,
      model: "claude-test",
      provider: "anthropic",
      session: {
        ...driverBootPayload.execution.session,
        context: {
          ...driverBootPayload.execution.session.context,
          homePath: runtimeRoot,
          sessionOrganizationPath: runtimeRoot,
        },
        cwd: runtimeRoot,
      },
    },
    runtime: "claude-agent-sdk",
    runtimeTransport: "claude-agent-sdk",
  });
  const logMessages: string[] = [];
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "claude-agent-sdk-prewarm-test",
    sink: async (entries) => {
      logMessages.push(...entries.map((entry) => entry.message));
    },
  });
  let eventSequence = 0;
  const context = createAgentDriverContext({
    eventSink: {
      pushEvents: async ({ events }) => ({
        accepted: events.map((event) => ({
          seq: (eventSequence += 1),
          type: event.kind,
        })),
      }),
    },
    logger,
    payload,
    permission: {
      request: async () => "allow_once",
    },
    ports: {
      skill: {
        materialize: async () => [],
      },
    },
  });

  return {
    backend: new ClaudeAgentSdkDriverBackend(payload, {
      query: () => {
        coldQueryCount += 1;
        return createTestQuery();
      },
      startup: (input) => startupImplementation(input),
    }),
    context,
    destroy: () => logger.destroy(),
    logMessages,
  };
}

beforeEach(() => {
  coldQueryCount = 0;
  process.env["AGENT_DRIVER_CLAUDE_PREWARM"] = "1";
  startupImplementation = async () => {
    throw new Error("Test startup implementation was not configured.");
  };
});

afterEach(async () => {
  if (originalPrewarmEnv === undefined) {
    delete process.env["AGENT_DRIVER_CLAUDE_PREWARM"];
  } else {
    process.env["AGENT_DRIVER_CLAUDE_PREWARM"] = originalPrewarmEnv;
  }
  await Promise.all(runtimeRoots.map((root) => rm(root, { force: true, recursive: true })));
  runtimeRoots = [];
});

describe("Claude Agent SDK prewarm lifecycle", () => {
  test("uses a completed prewarm for the first turn", async () => {
    const startupDeferred = createPromiseDeferred<TestWarmQuery>();
    let startupCalled = false;
    let warmCloseCount = 0;
    let warmQueryCount = 0;
    startupImplementation = async () => {
      startupCalled = true;
      return startupDeferred.promise;
    };
    const harness = await createHarness();

    await harness.backend.start(harness.context);
    await waitUntil("prewarm startup", () => startupCalled);
    startupDeferred.resolve({
      close: () => {
        warmCloseCount += 1;
      },
      query: () => {
        warmQueryCount += 1;
        return createTestQuery();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await harness.backend.handleInput(
      harness.context,
      { text: "warm turn" },
      DRIVER_TEST_IDS.runId,
    );

    expect(warmQueryCount).toBe(1);
    expect(warmCloseCount).toBe(0);
    expect(coldQueryCount).toBe(0);
    await harness.backend.stop(harness.context, "test.complete");
    await harness.destroy();
  });

  test("invalidates an in-flight prewarm when the first turn takes the cold path", async () => {
    const startupDeferred = createPromiseDeferred<TestWarmQuery>();
    let prewarmAbortController: AbortController | null = null;
    let warmCloseCount = 0;
    let warmQueryCount = 0;
    startupImplementation = async (input) => {
      prewarmAbortController = input?.options?.abortController ?? null;
      return startupDeferred.promise;
    };
    const warmQuery: TestWarmQuery = {
      close: () => {
        warmCloseCount += 1;
      },
      query: () => {
        warmQueryCount += 1;
        return createTestQuery();
      },
    };
    const harness = await createHarness();

    await harness.backend.start(harness.context);
    await waitUntil("prewarm startup", () => prewarmAbortController !== null);
    await harness.backend.handleInput(
      harness.context,
      { text: "first turn" },
      DRIVER_TEST_IDS.runId,
    );

    expect(prewarmAbortController?.signal.aborted).toBeTrue();
    expect(coldQueryCount).toBe(1);

    startupDeferred.resolve(warmQuery);
    await waitUntil("late warm query close", () => warmCloseCount === 1);
    await harness.backend.handleInput(
      harness.context,
      { text: "second turn" },
      DRIVER_TEST_IDS.secondRunId,
    );

    expect(warmQueryCount).toBe(0);
    expect(coldQueryCount).toBe(2);
    await harness.backend.stop(harness.context, "test.complete");
    await harness.destroy();
  });

  test("aborts a pending prewarm on stop and closes a late result", async () => {
    const startupDeferred = createPromiseDeferred<TestWarmQuery>();
    let prewarmAbortController: AbortController | null = null;
    let warmCloseCount = 0;
    startupImplementation = async (input) => {
      prewarmAbortController = input?.options?.abortController ?? null;
      return startupDeferred.promise;
    };
    const harness = await createHarness();

    await harness.backend.start(harness.context);
    await waitUntil("prewarm startup", () => prewarmAbortController !== null);
    await harness.backend.stop(harness.context, "test.stop");

    expect(prewarmAbortController?.signal.aborted).toBeTrue();
    startupDeferred.resolve({
      close: () => {
        warmCloseCount += 1;
      },
      query: () => createTestQuery(),
    });
    await waitUntil("stopped warm query close", () => warmCloseCount === 1);

    expect(coldQueryCount).toBe(0);
    await harness.destroy();
  });

  test("logs a close failure from a stale late prewarm without rejecting", async () => {
    const startupDeferred = createPromiseDeferred<TestWarmQuery>();
    let prewarmAbortController: AbortController | null = null;
    let warmCloseCount = 0;
    startupImplementation = async (input) => {
      prewarmAbortController = input?.options?.abortController ?? null;
      return startupDeferred.promise;
    };
    const harness = await createHarness();

    await harness.backend.start(harness.context);
    await waitUntil("prewarm startup", () => prewarmAbortController !== null);
    await harness.backend.stop(harness.context, "test.stop");

    startupDeferred.resolve({
      close: () => {
        warmCloseCount += 1;
        throw new Error("late close failed");
      },
      query: () => createTestQuery(),
    });
    await waitUntil("stale warm query close attempt", () => warmCloseCount === 1);
    await harness.context.logger.flush();

    expect(harness.logMessages).toContain("driver.claude.prewarm.close_failed");
    await harness.destroy();
  });
});
