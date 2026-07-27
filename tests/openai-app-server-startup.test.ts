import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDriverPermissionPort } from "../src/host-ports";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverPermissionPolicy } from "../src/protocol/boot";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import { ACTIVE_TURN_CANCEL_GRACE_MS } from "../src/core/driver-command-dispatcher";
import { OpenAiAppServerClient } from "../src/runtimes/openai/app-server-client";
import { OpenAiAppServerDriverBackend } from "../src/runtimes/openai/app-server-driver-backend";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";
import { settlePromiseWithTimeout } from "../src/utils/async";

const originalExecutable = process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"];
const temporaryDirectories: string[] = [];

interface CancellationHarnessOptions {
  readonly backgroundTerminalCleanFailure?: "error" | "timeout";
  readonly emitInterruptedTurnOnStart?: boolean;
  readonly failCancellationRequest?: boolean;
  readonly failInitialThreadStart?: boolean;
  readonly holdCancellationRequest?: boolean;
  readonly holdRunCancellation?: boolean;
  readonly restartResumeError?: string;
}

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

async function readFirstLaunchPid(processLog: string): Promise<number> {
  const firstLine = (await readFile(processLog, "utf8")).trim().split("\n")[0] ?? "{}";
  return (JSON.parse(firstLine) as { pid: number }).pid;
}

async function createHarness(
  resumeErrorMessage: string,
  recoveryMessages = [
    { content: "Earlier question", role: "user" as const },
    { content: "Earlier answer", role: "assistant" as const },
  ],
  holdTurnTiming = false,
  requestPermission: AgentDriverPermissionPort["request"] = async () => "allow_once",
  emitApproval = false,
  permissionPolicy: DriverPermissionPolicy = "full_access",
  holdFirstTurnStartResponse = false,
  cancellationOptions: CancellationHarnessOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "mosoo-openai-startup-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "fake-app-server");
  const requestLog = join(directory, "requests.jsonl");
  const processLog = join(directory, "processes.jsonl");
  const launchCountFile = join(directory, "launch-count");
  const turnStartHeldMarker = join(directory, "turn-start-held");
  const turnStartReleaseMarker = join(directory, "turn-start-release");
  await Bun.write(
    executable,
    `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
let buffer = "";
let turnStartCount = 0;
const launchNumber = existsSync(${JSON.stringify(launchCountFile)})
  ? Number(readFileSync(${JSON.stringify(launchCountFile)}, "utf8")) + 1
  : 1;
writeFileSync(${JSON.stringify(launchCountFile)}, String(launchNumber));
appendFileSync(${JSON.stringify(processLog)}, JSON.stringify({ launchNumber, pid: process.pid }) + "\\n");
const sendInterrupted = (turnId) => process.stdout.write(JSON.stringify({
  method: "turn/completed",
  params: {
    threadId: "fresh-thread",
    turn: {
      completedAt: Date.now(),
      durationMs: 1,
      error: null,
      id: turnId,
      items: [],
      itemsView: "notLoaded",
      startedAt: null,
      status: "interrupted",
    },
  },
}) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
    const turnNumber = request.method === "turn/start" ? ++turnStartCount : 0;
    const turnId = launchNumber === 1
      ? "turn-" + turnNumber
      : "turn-" + launchNumber + "-" + turnNumber;
    const configuredResumeError = ${JSON.stringify(resumeErrorMessage)};
    const restartResumeError = ${JSON.stringify(cancellationOptions.restartResumeError ?? null)};
    const resumeError =
      launchNumber > 1 && restartResumeError !== null
        ? restartResumeError
        : configuredResumeError.startsWith("no rollout found for thread id ")
          ? "no rollout found for thread id " + request.params.threadId
          : configuredResumeError;
    const terminalTurn = launchNumber > 1 || turnNumber > 1;
    const holdTurnStart =
      ${JSON.stringify(holdFirstTurnStartResponse)} &&
      launchNumber === 1 &&
      request.method === "turn/start" &&
      turnNumber === 1;
    const response =
      request.method === "thread/backgroundTerminals/clean" &&
      ${JSON.stringify(cancellationOptions.backgroundTerminalCleanFailure ?? null)} === "error"
        ? { id: request.id, error: { code: -32600, message: "background clean failed" } }
      : request.method === "thread/start" &&
          launchNumber === 1 &&
          ${JSON.stringify(cancellationOptions.failInitialThreadStart ?? false)}
        ? { id: request.id, error: { code: -32600, message: "initial thread start failed" } }
      : request.method === "thread/resume"
      ? { id: request.id, error: { code: -32600, message: resumeError } }
      : request.method === "thread/start"
        ? { id: request.id, result: { thread: { id: "fresh-thread" } } }
        : request.method === "turn/start"
          ? { id: request.id, result: { turn: {
              completedAt: terminalTurn ? Date.now() : null,
              durationMs: null,
              error: null,
              id: turnId,
              items: [],
              itemsView: "notLoaded",
              startedAt: null,
              status: terminalTurn ? "completed" : "inProgress",
            } } }
        : { id: request.id, result: {} };
    const sendApproval = () => process.stdout.write(JSON.stringify({
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: { itemId: "item-1", threadId: "fresh-thread", turnId: "turn-1" },
    }) + "\\n");
    const sendResponse = () => {
      if (
        request.method === "thread/backgroundTerminals/clean" &&
        ${JSON.stringify(cancellationOptions.backgroundTerminalCleanFailure ?? null)} === "timeout"
      ) return;
      process.stdout.write(JSON.stringify(response) + "\\n");
      if (${JSON.stringify(emitApproval)} && request.method === "turn/start" && !holdTurnStart) {
        sendApproval();
      }
      if (
        request.method === "turn/start" &&
        ${JSON.stringify(cancellationOptions.emitInterruptedTurnOnStart ?? false)}
      ) {
        setTimeout(() => sendInterrupted(turnId), 5);
      }
    };
    if (holdTurnStart) {
      if (${JSON.stringify(emitApproval)}) sendApproval();
      writeFileSync(${JSON.stringify(turnStartHeldMarker)}, "");
      const gate = setInterval(() => {
        if (existsSync(${JSON.stringify(turnStartReleaseMarker)})) {
          clearInterval(gate);
          sendResponse();
        }
      }, 1);
    } else {
      sendResponse();
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
      permissionPolicy,
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
  let cancellationRequestFailures = 0;
  const cancellationRequestEntered = Promise.withResolvers<void>();
  const cancellationRequestGate = Promise.withResolvers<void>();
  const runCancellationEntered = Promise.withResolvers<void>();
  const runCancellationGate = Promise.withResolvers<void>();
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
        if (input.events.some((event) => event.kind === "run.cancel.requested")) {
          if (cancellationOptions.holdCancellationRequest === true) {
            cancellationRequestEntered.resolve();
            await cancellationRequestGate.promise;
          }
          if (
            cancellationOptions.failCancellationRequest === true &&
            cancellationRequestFailures++ === 0
          ) {
            throw new Error("cancel request delivery failed");
          }
        }
        if (
          cancellationOptions.holdRunCancellation === true &&
          input.events.some((event) => event.kind === "run.cancelled")
        ) {
          runCancellationEntered.resolve();
          await runCancellationGate.promise;
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
    cancellationRequestEntered: cancellationRequestEntered.promise,
    context,
    events,
    logger,
    payload,
    processLog,
    releaseCancellationRequest: () => cancellationRequestGate.resolve(),
    releaseRunCancellation: () => runCancellationGate.resolve(),
    releaseTurnTiming: () => turnTimingGate.resolve(),
    releaseTurnStartResponse: () => Bun.write(turnStartReleaseMarker, ""),
    requestLog,
    runCancellationEntered: runCancellationEntered.promise,
    turnTimingEntered: turnTimingEntered.promise,
    turnStartHeldMarker,
  };
}

function createCancellationHarness(options: CancellationHarnessOptions) {
  return createHarness(
    "no rollout found for thread id stale-thread",
    [],
    false,
    async () => "allow_once",
    false,
    "full_access",
    false,
    options,
  );
}

describe("OpenAI app-server startup", () => {
  test("maps supervised permissions to untrusted thread and turn policies", async () => {
    const harness = await createHarness(
      "no rollout found for thread id stale-thread",
      [],
      true,
      async () => "allow_once",
      false,
      "supervised",
    );
    let stopped = false;

    try {
      await harness.backend.start(harness.context, new AbortController().signal);
      const input = harness.backend.handleInput(
        harness.context,
        { text: "hello" },
        DRIVER_TEST_IDS.runId,
      );
      void input.catch(() => {});
      await harness.turnTimingEntered;

      const requests = (await readFile(harness.requestLog, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method: string;
              params?: { approvalPolicy?: string };
            },
        );
      expect(
        requests
          .filter((request) =>
            ["thread/resume", "thread/start", "turn/start"].includes(request.method),
          )
          .map((request) => request.params?.approvalPolicy),
      ).toEqual(["untrusted", "untrusted", "untrusted"]);

      const stop = harness.backend.stop(
        harness.context,
        "test complete",
        new AbortController().signal,
      );
      harness.releaseTurnTiming();
      await stop;
      stopped = true;
      await expect(input).rejects.toThrow("test complete");
    } finally {
      harness.releaseTurnTiming();
      if (!stopped) {
        await harness.backend.stop(harness.context, "test complete", new AbortController().signal);
      }
      await harness.logger.destroy();
    }
  });

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

  test("stop cleans background terminals even when the thread has no active turn", async () => {
    const { backend, context, logger, requestLog } = await createCancellationHarness({});

    try {
      await backend.start(context, new AbortController().signal);
      await backend.stop(context, "test complete", new AbortController().signal);

      const methods = (await readFile(requestLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { method?: string }).method);
      expect(methods).toContain("thread/backgroundTerminals/clean");
    } finally {
      await backend.stop(context, "test complete", new AbortController().signal).catch(() => {});
      await logger.destroy();
    }
  });

  test.each(["error", "timeout"] as const)(
    "idle cancellation closes and replaces the client when background cleanup returns %s",
    async (failure) => {
      const harness = await createCancellationHarness({
        backgroundTerminalCleanFailure: failure,
      });

      try {
        await harness.backend.start(harness.context, new AbortController().signal);
        const firstPid = await readFirstLaunchPid(harness.processLog);

        await expect(
          settlePromiseWithTimeout(
            harness.backend.cancelActiveTurn(harness.context, "test.cancel"),
            {
              label: "idle background cleanup fallback",
              timeoutMs: ACTIVE_TURN_CANCEL_GRACE_MS,
            },
          ),
        ).resolves.toMatchObject({ status: "completed" });
        expect(() => process.kill(firstPid, 0)).toThrow();

        await expect(
          harness.backend.handleInput(
            harness.context,
            { text: "second" },
            DRIVER_TEST_IDS.secondRunId,
          ),
        ).resolves.toBeUndefined();
        expect((await readFile(harness.processLog, "utf8")).trim().split("\n")).toHaveLength(2);
      } finally {
        await harness.backend
          .stop(harness.context, "test complete", new AbortController().signal)
          .catch(() => {});
        await harness.logger.destroy();
      }
    },
  );

  test("cancels input while replacement client startup is pending", async () => {
    const harness = await createCancellationHarness({
      backgroundTerminalCleanFailure: "error",
    });

    try {
      await harness.backend.start(harness.context, new AbortController().signal);
      await harness.backend.cancelActiveTurn(harness.context, "replace client");

      const clientStartEntered = Promise.withResolvers<void>();
      let clientStartSignal: AbortSignal | null = null;
      const startSpy = spyOn(OpenAiAppServerClient.prototype, "start").mockImplementation(
        async (signal) => {
          clientStartSignal = signal ?? null;
          clientStartEntered.resolve();
          await new Promise<never>((_resolve, reject) => {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return { phases: [] };
        },
      );

      try {
        const input = harness.backend.handleInput(
          harness.context,
          { text: "cancel during replacement startup" },
          DRIVER_TEST_IDS.runId,
        );
        void input.catch(() => {});
        await clientStartEntered.promise;

        await harness.backend.cancelActiveTurn(harness.context, "test.cancel");
        expect((clientStartSignal as AbortSignal | null)?.aborted).toBe(true);
        await expect(input).rejects.toThrow("test.cancel");
        expect(
          harness.events
            .filter(
              (event) =>
                event.runId === DRIVER_TEST_IDS.runId &&
                ["run.started", "run.cancel.requested", "run.cancelled"].includes(event.kind),
            )
            .map((event) => event.kind),
        ).toEqual(["run.started", "run.cancel.requested", "run.cancelled"]);
      } finally {
        startSpy.mockRestore();
      }

      await expect(
        harness.backend.handleInput(
          harness.context,
          { text: "after replacement startup cancellation" },
          DRIVER_TEST_IDS.secondRunId,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await harness.backend.stop(harness.context, "test complete", new AbortController().signal);
      await harness.logger.destroy();
    }
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

  test("cleans the initialized app-server when initial thread startup fails", async () => {
    const harness = await createCancellationHarness({ failInitialThreadStart: true });

    try {
      await expect(
        harness.backend.start(harness.context, new AbortController().signal),
      ).rejects.toThrow("initial thread start failed");
      const childPid = await readFirstLaunchPid(harness.processLog);
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      await harness.backend
        .stop(harness.context, "test complete", new AbortController().signal)
        .catch(() => {});
      await harness.logger.destroy();
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
        void input.catch(() => {});
        await harness.turnTimingEntered;
        const lifecycle =
          operation === "cancel"
            ? harness.backend.cancelActiveTurn(harness.context, "test.cancel")
            : harness.backend.stop(harness.context, "test.stop", new AbortController().signal);

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

        const firstPid = await readFirstLaunchPid(harness.processLog);
        expect(() => process.kill(firstPid, 0)).toThrow();
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

  test.each(["cancel", "stop"] as const)(
    "%s is bounded while the turn start response is pending",
    async (operation) => {
      const harness = await createHarness(
        "no rollout found for thread id stale-thread",
        [],
        false,
        async () => "allow_once",
        false,
        "full_access",
        true,
        operation === "cancel"
          ? {
              restartResumeError:
                "failed to read thread: thread-store internal error: failed to read thread /tmp/rollout.jsonl: rollout at /tmp/rollout.jsonl is empty",
            }
          : {},
      );
      const reason = `test.${operation}`;

      try {
        await harness.backend.start(harness.context, new AbortController().signal);
        const input = harness.backend.handleInput(
          harness.context,
          { text: "first" },
          DRIVER_TEST_IDS.runId,
        );
        void input.catch(() => {});
        await expect(
          settlePromiseWithTimeout(
            (async () => {
              while (!(await Bun.file(harness.turnStartHeldMarker).exists())) {
                await Bun.sleep(1);
              }
            })(),
            { label: "held turn/start response", timeoutMs: 250 },
          ),
        ).resolves.toMatchObject({ status: "completed" });

        const lifecycle =
          operation === "cancel"
            ? harness.backend.cancelActiveTurn(harness.context, reason)
            : harness.backend.stop(harness.context, reason, new AbortController().signal);
        await expect(
          settlePromiseWithTimeout(lifecycle, {
            label: `${operation} during turn/start`,
            timeoutMs: 250,
          }),
        ).resolves.toMatchObject({ status: "completed" });

        await expect(
          settlePromiseWithTimeout(input, {
            label: "input after app-server close",
            timeoutMs: 250,
          }),
        ).resolves.toMatchObject({
          error: { message: reason },
          status: "failed",
        });
        await Bun.sleep(25);

        expect(
          harness.events
            .filter(
              (event) =>
                event.runId === DRIVER_TEST_IDS.runId &&
                ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
            )
            .map((event) => event.kind),
        ).toEqual(operation === "cancel" ? ["run.cancelled"] : []);

        if (operation === "cancel") {
          await expect(
            settlePromiseWithTimeout(
              harness.backend.handleInput(
                harness.context,
                { text: "second" },
                DRIVER_TEST_IDS.secondRunId,
              ),
              { label: "turn after registration-window cancellation", timeoutMs: 250 },
            ),
          ).resolves.toMatchObject({ status: "completed" });
          expect(
            harness.events
              .filter(
                (event) =>
                  event.runId === DRIVER_TEST_IDS.secondRunId &&
                  ["run.cancelled", "run.completed", "run.failed"].includes(event.kind),
              )
              .map((event) => event.kind),
          ).toEqual(["run.completed"]);
        }
      } finally {
        await harness.releaseTurnStartResponse();
        await harness.backend.stop(harness.context, "test complete", new AbortController().signal);
        await harness.logger.destroy();
      }
    },
  );

  test("dispatcher cancellation closes a pending turn start and recovers on a new client", async () => {
    const harness = await createHarness(
      "no rollout found for thread id stale-thread",
      [],
      false,
      async () => "allow_once",
      true,
      "supervised",
      true,
    );
    const kernel = new AgentDriverKernelCore({
      backendFactory: (payload) => new OpenAiAppServerDriverBackend(payload),
      hostPorts: {
        skill: {
          materialize: async () => [],
        },
      },
      logger: harness.logger,
    });
    const eventStream = kernel.events()[Symbol.asyncIterator]();
    const lifecycleKinds: string[] = [];

    try {
      await kernel.start(harness.payload);
      const firstInput = kernel.dispatch({
        commandId: "pending-turn-start",
        input: { text: "first" },
        kind: "input.start",
        requestId: "pending-turn-request",
        runId: DRIVER_TEST_IDS.runId,
      });
      void firstInput.catch(() => {});
      await expect(
        settlePromiseWithTimeout(
          (async () => {
            while (!(await Bun.file(harness.turnStartHeldMarker).exists())) {
              await Bun.sleep(1);
            }
          })(),
          { label: "dispatcher held turn/start response", timeoutMs: 1_000 },
        ),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        settlePromiseWithTimeout(
          (async () => {
            for (;;) {
              const event = (await eventStream.next()).value;
              if (event === undefined) {
                throw new Error("Kernel event stream ended before permission.requested.");
              }
              if (
                [
                  "permission.requested",
                  "permission.resolved",
                  "run.started",
                  "run.cancel.requested",
                  "run.cancelled",
                ].includes(event.kind)
              ) {
                lifecycleKinds.push(event.kind);
              }
              if (event.kind === "permission.requested") {
                return;
              }
            }
          })(),
          { label: "pending turn permission request", timeoutMs: 1_000 },
        ),
      ).resolves.toMatchObject({ status: "completed" });

      const cancellation = settlePromiseWithTimeout(
        Promise.all([firstInput, kernel.cancel("test.cancel")]),
        {
          label: "dispatcher turn/start cancellation",
          timeoutMs: ACTIVE_TURN_CANCEL_GRACE_MS,
        },
      );
      await expect(cancellation).resolves.toEqual({
        status: "completed",
        value: [undefined, undefined],
      });
      await expect(
        settlePromiseWithTimeout(
          (async () => {
            for (;;) {
              const event = (await eventStream.next()).value;
              if (event === undefined) {
                throw new Error("Kernel event stream ended before run.cancelled.");
              }
              if (
                [
                  "permission.requested",
                  "permission.resolved",
                  "run.started",
                  "run.cancel.requested",
                  "run.cancelled",
                ].includes(event.kind)
              ) {
                lifecycleKinds.push(event.kind);
              }
              if (event.kind === "run.cancelled") {
                return;
              }
            }
          })(),
          { label: "registration cancellation lifecycle", timeoutMs: 250 },
        ),
      ).resolves.toMatchObject({ status: "completed" });

      expect(lifecycleKinds).toEqual([
        "permission.requested",
        "permission.resolved",
        "run.started",
        "run.cancel.requested",
        "run.cancelled",
      ]);

      const firstPid = await readFirstLaunchPid(harness.processLog);
      expect(() => process.kill(firstPid, 0)).toThrow();

      await expect(
        settlePromiseWithTimeout(
          kernel.dispatch({
            commandId: "input-after-pending-turn",
            input: { text: "second" },
            kind: "input.start",
            requestId: "request-after-pending-turn",
            runId: DRIVER_TEST_IDS.secondRunId,
          }),
          {
            label: "input after pending turn cancellation",
            timeoutMs: 1_000,
          },
        ),
      ).resolves.toEqual({
        status: "completed",
        value: { requestId: "request-after-pending-turn" },
      });

      const requests = (await readFile(harness.requestLog, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method: string;
              params?: { threadId?: string };
            },
        );
      expect(requests.filter((request) => request.method === "initialize")).toHaveLength(2);
      expect(
        requests
          .filter((request) => request.method === "thread/resume")
          .map((request) => request.params?.threadId),
      ).toEqual(["stale-thread", "fresh-thread"]);
      expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
    } finally {
      await harness.releaseTurnStartResponse();
      await kernel.stop("test complete").catch(() => {});
      await harness.logger.destroy();
    }
  });

  test("cleans the client before a queued provider cancellation terminal is delivered", async () => {
    const harness = await createCancellationHarness({
      emitInterruptedTurnOnStart: true,
      holdRunCancellation: true,
    });

    try {
      await harness.backend.start(harness.context, new AbortController().signal);
      const input = harness.backend.handleInput(
        harness.context,
        { text: "hello" },
        DRIVER_TEST_IDS.runId,
      );
      void input.catch(() => {});
      await harness.runCancellationEntered;
      const firstPid = await readFirstLaunchPid(harness.processLog);
      expect(() => process.kill(firstPid, 0)).toThrow();

      const cancellation = harness.backend.cancelActiveTurn(harness.context, "test.cancel");
      harness.releaseRunCancellation();

      await cancellation;
      await expect(input).rejects.toThrow("OpenAI turn was interrupted");
    } finally {
      harness.releaseRunCancellation();
      await harness.backend.stop(harness.context, "test complete", new AbortController().signal);
      await harness.logger.destroy();
    }
  });

  test("fails a turn when the provider exits before turn/start responds", async () => {
    const harness = await createHarness(
      "no rollout found for thread id stale-thread",
      [],
      false,
      async () => "allow_once",
      false,
      "full_access",
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
      while (!(await Bun.file(harness.turnStartHeldMarker).exists())) {
        await Bun.sleep(1);
      }
      const providerPid = await readFirstLaunchPid(harness.processLog);
      process.kill(providerPid, "SIGKILL");

      await expect(input).rejects.toThrow("OpenAi app-server exited");
      expect(
        harness.events
          .filter((event) => event.runId === DRIVER_TEST_IDS.runId)
          .map((event) => event.kind),
      ).toEqual(["run.started", "run.failed"]);
    } finally {
      await harness.releaseTurnStartResponse();
      await harness.backend
        .stop(harness.context, "test complete", new AbortController().signal)
        .catch(() => {});
      await harness.logger.destroy();
    }
  }, 10_000);

  test("retries a retained cancellation terminal on the replacement client", async () => {
    const harness = await createCancellationHarness({
      failCancellationRequest: true,
    });

    try {
      await harness.backend.start(harness.context, new AbortController().signal);
      const input = harness.backend.handleInput(
        harness.context,
        { text: "hello" },
        DRIVER_TEST_IDS.runId,
      );
      void input.catch(() => {});
      await expect(
        settlePromiseWithTimeout(
          (async () => {
            while (!harness.events.some((event) => event.kind === "run.started")) {
              await Bun.sleep(1);
            }
          })(),
          { label: "OpenAI active turn", timeoutMs: 250 },
        ),
      ).resolves.toMatchObject({ status: "completed" });

      await expect(
        harness.backend.cancelActiveTurn(harness.context, "test.cancel"),
      ).resolves.toBeUndefined();
      await expect(input).rejects.toThrow("test.cancel");
      await expect(
        harness.backend.handleInput(
          harness.context,
          { text: "second" },
          DRIVER_TEST_IDS.secondRunId,
        ),
      ).resolves.toBeUndefined();
      expect(
        harness.events
          .filter(
            (event) =>
              event.runId === DRIVER_TEST_IDS.runId &&
              ["run.cancel.requested", "run.cancelled"].includes(event.kind),
          )
          .map((event) => event.kind),
      ).toEqual(["run.cancel.requested", "run.cancelled"]);
    } finally {
      await harness.backend.stop(harness.context, "test complete", new AbortController().signal);
      await harness.logger.destroy();
    }
  });

  test("cleans the process tree before publishing a bounded cancellation terminal", async () => {
    const harness = await createCancellationHarness({
      holdCancellationRequest: true,
    });

    try {
      await harness.backend.start(harness.context, new AbortController().signal);
      const input = harness.backend.handleInput(
        harness.context,
        { text: "hello" },
        DRIVER_TEST_IDS.runId,
      );
      void input.catch(() => {});
      await expect(
        settlePromiseWithTimeout(
          (async () => {
            while (!harness.events.some((event) => event.kind === "run.started")) {
              await Bun.sleep(1);
            }
          })(),
          { label: "OpenAI active turn", timeoutMs: 250 },
        ),
      ).resolves.toMatchObject({ status: "completed" });

      const cancellation = harness.backend.cancelActiveTurn(harness.context, "test.cancel");
      void cancellation.catch(() => {});
      await harness.cancellationRequestEntered;
      const firstPid = await readFirstLaunchPid(harness.processLog);
      expect(() => process.kill(firstPid, 0)).toThrow();
      await expect(
        settlePromiseWithTimeout(cancellation, {
          label: "active cancellation with held terminal",
          timeoutMs: ACTIVE_TURN_CANCEL_GRACE_MS,
        }),
      ).resolves.toMatchObject({ status: "completed" });

      harness.releaseCancellationRequest();
      await expect(input).rejects.toThrow("test.cancel");
      await expect(
        settlePromiseWithTimeout(
          (async () => {
            while (!harness.events.some((event) => event.kind === "run.cancelled")) {
              await Bun.sleep(1);
            }
          })(),
          { label: "cancel terminal after process cleanup", timeoutMs: 250 },
        ),
      ).resolves.toMatchObject({ status: "completed" });
    } finally {
      harness.releaseCancellationRequest();
      await harness.backend.stop(harness.context, "test complete", new AbortController().signal);
      await harness.logger.destroy();
    }
  });

  test("retains a client when cancellation cleanup fails so shutdown can retry", async () => {
    const harness = await createCancellationHarness({});
    const nativeKill = process.kill;
    const nativeStop = OpenAiAppServerClient.prototype.stop;
    let failNextStop = false;
    const stopSpy = spyOn(OpenAiAppServerClient.prototype, "stop").mockImplementation(function (
      this: OpenAiAppServerClient,
      signal?: AbortSignal,
    ) {
      if (failNextStop) {
        failNextStop = false;
        return Promise.reject(new Error("test cancellation cleanup failed"));
      }
      return nativeStop.call(this, signal);
    });
    let childPid = 0;
    let stopped = false;

    try {
      await harness.backend.start(harness.context, new AbortController().signal);
      const input = harness.backend.handleInput(
        harness.context,
        { text: "hello" },
        DRIVER_TEST_IDS.runId,
      );
      void input.catch(() => {});
      await expect(
        settlePromiseWithTimeout(
          (async () => {
            while (!harness.events.some((event) => event.kind === "run.started")) {
              await Bun.sleep(1);
            }
          })(),
          { label: "OpenAI turn before failed cancellation cleanup", timeoutMs: 250 },
        ),
      ).resolves.toMatchObject({ status: "completed" });
      childPid = await readFirstLaunchPid(harness.processLog);
      failNextStop = true;

      await expect(
        harness.backend.cancelActiveTurn(harness.context, "test.cancel"),
      ).rejects.toThrow("test cancellation cleanup failed");
      await expect(input).rejects.toThrow("test cancellation cleanup failed");
      expect(() => nativeKill(childPid, 0)).not.toThrow();

      await harness.backend.stop(harness.context, "test complete", new AbortController().signal);
      stopped = true;
      expect(() => nativeKill(childPid, 0)).toThrow();
    } finally {
      failNextStop = false;
      if (!stopped) {
        await harness.backend
          .stop(harness.context, "test complete", new AbortController().signal)
          .catch(() => {});
      }
      if (childPid > 0) {
        try {
          nativeKill(childPid, "SIGKILL");
        } catch {}
      }
      stopSpy.mockRestore();
      await harness.logger.destroy();
    }
  }, 10_000);

  test("retains a client whose process stop fails so shutdown can retry", async () => {
    const harness = await createCancellationHarness({});
    let stopped = false;

    try {
      await harness.backend.start(harness.context, new AbortController().signal);
      const first = new AbortController();
      first.abort(new Error("first stop aborted"));
      await expect(harness.backend.stop(harness.context, "first", first.signal)).rejects.toThrow(
        "first stop aborted",
      );

      const second = new AbortController();
      second.abort(new Error("second stop aborted"));
      await expect(harness.backend.stop(harness.context, "second", second.signal)).rejects.toThrow(
        "second stop aborted",
      );

      await harness.backend.stop(harness.context, "final", new AbortController().signal);
      stopped = true;
    } finally {
      if (!stopped) {
        await harness.backend
          .stop(harness.context, "test complete", new AbortController().signal)
          .catch(() => {});
      }
      await harness.logger.destroy();
    }
  });

  test("retains a failed restart client until shutdown retries its cleanup", async () => {
    const harness = await createCancellationHarness({
      restartResumeError: "restart resume failed",
    });
    const nativeKill = process.kill;
    const nativeStop = OpenAiAppServerClient.prototype.stop;
    let failNextStop = false;
    const stopSpy = spyOn(OpenAiAppServerClient.prototype, "stop").mockImplementation(function (
      this: OpenAiAppServerClient,
      signal?: AbortSignal,
    ) {
      if (failNextStop) {
        failNextStop = false;
        return Promise.reject(new Error("test restart cleanup failed"));
      }
      return nativeStop.call(this, signal);
    });
    let secondPid = 0;
    let stopped = false;

    try {
      await harness.backend.start(harness.context, new AbortController().signal);
      const firstInput = harness.backend.handleInput(
        harness.context,
        { text: "first" },
        DRIVER_TEST_IDS.runId,
      );
      void firstInput.catch(() => {});
      await expect(
        settlePromiseWithTimeout(
          (async () => {
            while (!harness.events.some((event) => event.kind === "run.started")) {
              await Bun.sleep(1);
            }
          })(),
          { label: "first OpenAI turn", timeoutMs: 250 },
        ),
      ).resolves.toMatchObject({ status: "completed" });
      await harness.backend.cancelActiveTurn(harness.context, "test.cancel");
      await expect(firstInput).rejects.toThrow("test.cancel");

      failNextStop = true;
      await expect(
        settlePromiseWithTimeout(
          harness.backend.handleInput(
            harness.context,
            { text: "restart" },
            DRIVER_TEST_IDS.secondRunId,
          ),
          {
            label: "failed restart cleanup",
            timeoutMs: 4_000,
          },
        ),
      ).resolves.toMatchObject({
        error: { message: expect.stringContaining("test restart cleanup failed") },
        status: "failed",
      });
      secondPid = (
        JSON.parse((await readFile(harness.processLog, "utf8")).trim().split("\n")[1] ?? "{}") as {
          pid: number;
        }
      ).pid;
      expect(() => nativeKill(secondPid, 0)).not.toThrow();

      await harness.backend.stop(harness.context, "test complete", new AbortController().signal);
      stopped = true;
      expect(() => nativeKill(secondPid, 0)).toThrow();
    } finally {
      failNextStop = false;
      if (!stopped) {
        await harness.backend
          .stop(harness.context, "test complete", new AbortController().signal)
          .catch(() => {});
      }
      if (secondPid > 0) {
        try {
          nativeKill(secondPid, "SIGKILL");
        } catch {}
      }
      stopSpy.mockRestore();
      await harness.logger.destroy();
    }
  }, 10_000);

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
      await harness.backend.stop(harness.context, "test complete", new AbortController().signal);
      await harness.logger.destroy();
    }
  });

  test("does not publish a cancellation terminal when a server request ignores abort", async () => {
    const permissionStarted = Promise.withResolvers<void>();
    const permissionGate = Promise.withResolvers<void>();
    const harness = await createHarness(
      "no rollout found for thread id stale-thread",
      [],
      false,
      async () => {
        permissionStarted.resolve();
        await permissionGate.promise;
        return "allow_once";
      },
      true,
      "supervised",
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
      await expect(
        settlePromiseWithTimeout(
          (async () => {
            while (!harness.events.some((event) => event.kind === "run.started")) {
              await Bun.sleep(1);
            }
          })(),
          { label: "turn with non-cooperative server request", timeoutMs: 250 },
        ),
      ).resolves.toMatchObject({ status: "completed" });

      await expect(
        harness.backend.cancelActiveTurn(harness.context, "test.cancel"),
      ).rejects.toThrow();
      await expect(input).rejects.toThrow();
      expect(
        harness.events.some(
          (event) => event.runId === DRIVER_TEST_IDS.runId && event.kind === "run.cancelled",
        ),
      ).toBe(false);
    } finally {
      permissionGate.resolve();
      await harness.backend
        .stop(harness.context, "test complete", new AbortController().signal)
        .catch(() => {});
      await harness.logger.destroy();
    }
  }, 10_000);
});
