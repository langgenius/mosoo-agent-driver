import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { OpenAiAppServerDriverBackend } from "../src/runtimes/openai/app-server-driver-backend";
import { driverBootPayload } from "./driver-boot-payload-fixture";

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
        : { id: request.id, result: {} };
    process.stdout.write(JSON.stringify(response) + "\\n");
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
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "openai-app-server-startup-test",
    sink: async () => {},
  });
  const context = createAgentDriverContext({
    eventSink: {
      commandUpdate: async () => {},
      pushEvents: async (input) => {
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
    permission: { request: async () => "allow_once" },
    ports: { skill: { materialize: async () => [] } },
  });

  return {
    backend: new OpenAiAppServerDriverBackend(payload),
    context,
    events,
    logger,
    requestLog,
  };
}

describe("OpenAI app-server startup", () => {
  test("injects platform transcript without publishing an unmaterialized thread", async () => {
    const { backend, context, events, logger, requestLog } = await createHarness(
      "no rollout found for thread id stale-thread",
    );

    await backend.start(context);

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
    await backend.stop(context, "test complete");
    await logger.destroy();
  });

  test("does not replace the thread for other resume failures", async () => {
    const { backend, context, events, logger } = await createHarness("Unauthorized");

    try {
      await expect(backend.start(context)).rejects.toThrow("Unauthorized");
      expect(events).toEqual([]);
    } finally {
      await backend.stop(context, "test complete");
      await logger.destroy();
    }
  });
});
