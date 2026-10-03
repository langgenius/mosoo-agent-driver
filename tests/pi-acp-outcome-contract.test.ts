import { expect, spyOn, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createDisabledLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import * as acpProcess from "../src/runtimes/acp/acp-agent-process";
import { AcpDriverBackend } from "../src/runtimes/acp/acp-driver-backend";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import { createBootstrapFixture } from "./fixtures/pi-acp/bootstrap";
import { adapter } from "./fixtures/pi-acp/contract";

// Explicit opt-in validates the exact installed pair through createBootstrapFixture.
// An enabled gate fails on unsupported platforms rather than silently skipping it.
const contractTest = process.env["PI_ACP_PINNED_CONTRACT"] === "1" ? test : test.skip;

async function createOutcomeHarness(truncated: boolean) {
  if (process.platform !== "linux")
    throw new Error("Pi outcome backend contract requires Linux /proc");
  const fixture = await createBootstrapFixture();
  let requestCount = 0;
  const server = truncated
    ? createServer(async (request, response) => {
        for await (const _chunk of request) {
          /* Drain the local fixture request. */
        }
        requestCount++;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const frame = (delta: Record<string, unknown>, finish: string | null = null) => {
          response.write(
            `data: ${JSON.stringify({ id: "truncated", object: "chat.completion.chunk", created: 1, model: "gpt-6-astra", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
          );
        };
        frame({ role: "assistant" });
        frame({ content: "PI_TRUNCATED_ANSWER_PREFIX" });
        frame({}, "length");
        response.end("data: [DONE]\n\n");
      })
    : null;
  if (server) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server?.address();
  const payload =
    address && typeof address !== "string"
      ? {
          ...fixture.payload,
          execution: {
            ...fixture.payload.execution,
            environment: {
              ...fixture.payload.execution.environment,
              variables: {
                ...fixture.payload.execution.environment.variables,
                OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${address.port}/api/driver/llm/proxy/bootstrap-fixture`,
              },
            },
          },
        }
      : fixture.payload;
  const events: DriverEventInput[] = [];
  let activeRunId: RunId | null = null;
  let seq = 0;
  const context = createAgentDriverContext({
    payload,
    logger: createDisabledLogger(),
    permission: { request: async () => "reject_once" },
    ports: { skill: { materialize: async () => [] } },
    eventSink: {
      currentRunId: () => activeRunId,
      pushEvents: async ({ events: batch }) => {
        events.push(...batch);
        // Model the Durable authority: accepting a terminal immediately clears
        // admission. Later generic cleanup must not replace that terminal.
        if (
          batch.some((event) =>
            ["run.completed", "run.failed", "run.cancelled"].includes(event.kind),
          )
        )
          activeRunId = null;
        return {
          accepted: batch.map((event) => ({
            eventId: event.sourceEventId ?? event.id!,
            seq: ++seq,
            type: event.kind,
          })),
        };
      },
    },
  });
  const backend = new AcpDriverBackend(payload);
  const originalStart = acpProcess.startAcpAgentProcess;
  const launch = spyOn(acpProcess, "startAcpAgentProcess").mockImplementation(
    async (context, payload, env, signal, options) => {
      expect(options).toEqual({ command: "/usr/local/bin/pi-acp", args: [] });
      // Override retry only in the disposable fixture so a deterministic HTTP
      // failure cannot be hidden by provider retry delays.
      const settingsPath = join(fixture.agentDir, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      settings.retry = { enabled: false };
      await writeFile(settingsPath, JSON.stringify(settings));
      return originalStart(
        context,
        payload,
        {
          ...env,
          PATH: fixture.env["PATH"]!,
          TMPDIR: fixture.env["TMPDIR"]!,
          PI_ACP_PI_COMMAND: fixture.env["PI_ACP_PI_COMMAND"]!,
          NODE_OPTIONS: fixture.env["NODE_OPTIONS"]!,
          PI_CONTRACT_NETWORK_LOG: fixture.networkLog,
        },
        signal,
        { command: join(fixture.bin, "node"), args: [adapter] },
      );
    },
  );
  return {
    fixture,
    events,
    backend,
    context,
    requestCount: () => (server ? requestCount : fixture.requests.length),
    async run() {
      await fixture.materialize("FIRST");
      await backend.start(context, new AbortController().signal);
      activeRunId = DRIVER_TEST_IDS.runId;
      return backend
        .handleInput(context, { text: "Run a tool then answer" }, DRIVER_TEST_IDS.runId)
        .then(
          () => null,
          (error: unknown) => error,
        );
    },
    async cleanup() {
      try {
        await backend.stop(context, "outcome contract cleanup", new AbortController().signal);
      } finally {
        launch.mockRestore();
        try {
          await fixture.cleanup();
        } finally {
          if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        }
      }
    },
  };
}

contractTest(
  "Given actual Pi bash succeeds, When the next model request returns HTTP 500, Then Driver emits one classified failed terminal",
  async () => {
    const harness = await createOutcomeHarness(false);
    try {
      harness.fixture.steps.push({
        tools: [{ name: "bash", arguments: { command: "printf PI_OUTCOME_NATIVE_TOOL" } }],
      });
      const rejection = await harness.run();
      expect(harness.requestCount()).toBe(2);
      expect(JSON.stringify(harness.events)).toContain("PI_OUTCOME_NATIVE_TOOL");
      expect(
        harness.events.some(
          (event) =>
            event.kind === "tool.call.updated" &&
            JSON.stringify(event.payload).includes('"status":"completed"'),
        ),
      ).toBe(true);
      const terminals = harness.events.filter((event) =>
        ["run.completed", "run.failed", "run.cancelled"].includes(event.kind),
      );
      expect(terminals.map((event) => event.kind)).toEqual(["run.failed"]);
      expect(terminals[0]?.runId).toBe(DRIVER_TEST_IDS.runId);
      expect(JSON.stringify(terminals[0]?.payload)).toMatch(/provider|500|ACPRequestError/i);
      expect(rejection).toBeInstanceOf(Error);
      expect(harness.fixture.errors).toEqual([
        "Error: Unexpected model request (no scripted response)",
      ]);
    } finally {
      await harness.cleanup();
    }
  },
  60_000,
);

contractTest(
  "Given actual Pi streams partial text, When finish_reason is length, Then Driver emits one classified failed terminal instead of completing",
  async () => {
    const harness = await createOutcomeHarness(true);
    try {
      const rejection = await harness.run();
      expect(harness.requestCount()).toBe(1);
      expect(JSON.stringify(harness.events)).toContain("PI_TRUNCATED_ANSWER_PREFIX");
      const terminals = harness.events.filter((event) =>
        ["run.completed", "run.failed", "run.cancelled"].includes(event.kind),
      );
      expect(terminals.map((event) => event.kind)).toEqual(["run.failed"]);
      expect(terminals[0]?.runId).toBe(DRIVER_TEST_IDS.runId);
      expect(JSON.stringify(terminals[0]?.payload)).toMatch(/max_tokens|token|truncat/i);
      expect(rejection).toBeInstanceOf(Error);
      expect(harness.fixture.errors).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  },
  60_000,
);
