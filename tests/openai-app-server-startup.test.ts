import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDriverPermissionPort } from "../src/host-ports";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { OpenAiAppServerDriverBackend } from "../src/runtimes/openai/app-server-driver-backend";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";
import { settlePromiseWithTimeout } from "../src/utils/async";

const originalExecutable = process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalExecutable === undefined) {
    delete process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"];
  } else {
    process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"] = originalExecutable;
  }

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createHarness(
  resumeErrorMessage: string,
  recoveryMessages = [
    { content: "Earlier question", role: "user" as const },
    { content: "Earlier answer", role: "assistant" as const },
  ],
  holdTurnTiming = false,
  requestPermission: AgentDriverPermissionPort["request"] = async () => "allow_once",
  emitApproval = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "mosoo-openai-startup-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "fake-app-server");
  const requestLog = join(directory, "requests.jsonl");
  await Bun.write(
    executable,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
    const response = request.method === "thread/resume"
      ? { id: request.id, error: { code: -32600, message: ${JSON.stringify(resumeErrorMessage)} } }
      : request.method === "thread/start"
        ? { id: request.id, result: { thread: { id: "fresh-thread" } } }
        : request.method === "turn/start"
          ? { id: request.id, result: { turn: {
              completedAt: null,
              durationMs: null,
              error: null,
              id: "turn-1",
              items: [],
              itemsView: "notLoaded",
              startedAt: null,
              status: "inProgress",
            } } }
        : { id: request.id, result: {} };
    process.stdout.write(JSON.stringify(response) + "\\n");
    if (${JSON.stringify(emitApproval)} && request.method === "turn/start") {
      process.stdout.write(JSON.stringify({
        id: 91,
        method: "item/commandExecution/requestApproval",
        params: { itemId: "item-1", threadId: "fresh-thread", turnId: "turn-1" },
      }) + "\\n");
    }
    newline = buffer.indexOf("\\n");
  }
});
`,
  );
  await chmod(executable, 0o755);
  process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"] = executable;

  const payload = createDriverStartInputFromBootPayload({
    ...driverBootPayload,
    execution: {
      ...driverBootPayload.execution,
      session: {
        ...driverBootPayload.execution.session,
        context: {
          ...driverBootPayload.execution.session.context,
          homePath: join(directory, "home"),
          sessionOrganizationPath: directory,
        },
        cwd: directory,
        nativeResumeRef: {
          kind: "openai_thread_id",
          runtimeId: "openai-runtime",
          value: "stale-thread",
        },
        recoveryMessages,
      },
    },
  });
  const events: DriverEventInput[] = [];
  const turnTimingEntered = Promise.withResolvers<void>();
  const turnTimingGate = Promise.withResolvers<void>();
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "openai-app-server-startup-test",
    sink: async () => {},
  });
  const context = createAgentDriverContext({
    eventSink: {
      commandUpdate: async () => {},
      pushEvents: async (input) => {
        if (
          holdTurnTiming &&
          input.events.some((event) => event.sourceEventId === "openai.provider.turn_start:turn-1")
        ) {
          turnTimingEntered.resolve();
          await turnTimingGate.promise;
        }
        events.push(...input.events);
        return {
          accepted: input.events.map((event, index) => ({
            seq: index + 1,
            type: event.kind,
          })),
        };
      },
    },
    logger,
    payload,
    permission: { request: requestPermission },
    ports: { skill: { materialize: async () => [] } },
  });

  return {
    backend: new OpenAiAppServerDriverBackend(payload),
    context,
    events,
    logger,
    releaseTurnTiming: () => turnTimingGate.resolve(),
    requestLog,
    turnTimingEntered: turnTimingEntered.promise,
  };
}

describe("OpenAI app-server startup", () => {
  test("injects platform transcript without publishing an unmaterialized thread", async () => {
    const { backend, context, events, logger, requestLog } = await createHarness(
      "no rollout found for thread id stale-thread",
    );

    await backend.start(context, new AbortController().signal);

    expect(events.some((event) => event.kind === "runtime.resume.updated")).toBe(false);
    const requests = (await readFile(requestLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: unknown });
    expect(requests.find((request) => request.method === "thread/inject_items")?.params).toEqual({
      items: [
        {
          content: [{ text: "Earlier question", type: "input_text" }],
          role: "user",
          type: "message",
        },
        {
          content: [{ text: "Earlier answer", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
      ],
      threadId: "fresh-thread",
    });
    await backend.stop(context, "test complete", new AbortController().signal);
    await logger.destroy();
  });

  test("does not replace the thread for other resume failures", async () => {
    const { backend, context, events, logger } = await createHarness("Unauthorized");

    try {
      await expect(backend.start(context, new AbortController().signal)).rejects.toThrow(
        "Unauthorized",
      );
      expect(events).toEqual([]);
    } finally {
      await backend.stop(context, "test complete", new AbortController().signal);
      await logger.destroy();
    }
  });

  test.each(["cancel", "stop"] as const)(
    "%s closes a turn whose start response is waiting on event delivery",
    async (operation) => {
      const harness = await createHarness("no rollout found for thread id stale-thread", [], true);
      let stopped = false;

      try {
        await harness.backend.start(harness.context, new AbortController().signal);
        const input = harness.backend.handleInput(
          harness.context,
          { text: "hello" },
          DRIVER_TEST_IDS.runId,
        );
        await harness.turnTimingEntered;
        const lifecycle =
          operation === "cancel"
            ? harness.backend.cancelActiveTurn(harness.context, "test.cancel")
            : harness.backend.stop(
                harness.context,
                "test.stop",
                new AbortController().signal,
              );

        await Bun.sleep(10);
        harness.releaseTurnTiming();
        await lifecycle;
        stopped = operation === "stop";

        const settled = await settlePromiseWithTimeout(input, {
          label: `${operation} during turn registration`,
          timeoutMs: 250,
        });
        expect(settled).toMatchObject({
          error: { message: operation === "cancel" ? "test.cancel" : "test.stop" },
          status: "failed",
        });

        const requests = (await readFile(harness.requestLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method: string });
        if (operation === "cancel") {
          expect(requests.some((request) => request.method === "turn/interrupt")).toBe(true);
        }
      } finally {
        harness.releaseTurnTiming();
        if (!stopped) {
          await harness.backend.stop(
            harness.context,
            "test complete",
            new AbortController().signal,
          );
        }
        await harness.logger.destroy();
      }
    },
  );

  test("cancellation aborts an active server request without a late reply", async () => {
    const permissionStarted = Promise.withResolvers<void>();
    const permissionAborted = Promise.withResolvers<void>();
    const permissionGate = Promise.withResolvers<void>();
    const harness = await createHarness(
      "no rollout found for thread id stale-thread",
      [],
      false,
      async (_input, signal) => {
        permissionStarted.resolve();
        signal?.addEventListener("abort", () => permissionAborted.resolve(), { once: true });
        await permissionGate.promise;
        return "allow_once";
      },
      true,
    );

    try {
      await harness.backend.start(harness.context, new AbortController().signal);
      const input = harness.backend.handleInput(
        harness.context,
        { text: "hello" },
        DRIVER_TEST_IDS.runId,
      );
      void input.catch(() => {});
      await permissionStarted.promise;
      const cancellation = harness.backend.cancelActiveTurn(harness.context, "test.cancel");

      await expect(
        settlePromiseWithTimeout(permissionAborted.promise, {
          label: "permission cancellation",
          timeoutMs: 250,
        }),
      ).resolves.toMatchObject({ status: "completed" });
      permissionGate.resolve();
      await cancellation;
      await expect(input).rejects.toThrow("test.cancel");
      await Bun.sleep(25);

      const messages = (await readFile(harness.requestLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id?: number; method?: string });
      expect(messages.some((message) => message.id === 91 && message.method === undefined)).toBe(
        false,
      );
    } finally {
      permissionGate.resolve();
      await harness.backend.stop(
        harness.context,
        "test complete",
        new AbortController().signal,
      );
      await harness.logger.destroy();
    }
  });
});
