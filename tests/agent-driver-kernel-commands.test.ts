import { describe, expect, test } from "bun:test";

import type {
  AgentDriverContext,
  AgentDriverContextPortOverrides,
} from "../src/core/agent-driver-backend";
import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import type { DriverEventInput } from "../src/protocol/events";
import type { RuntimeCommand } from "../src/runtime-command";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { DRIVER_TEST_IDS, bootPayload, createBackend } from "./driver-runtime-boundary-fixtures";

describe("AgentDriverKernelCore", () => {
  test("automatically retries final cleanup after shutdown times out during startup", async () => {
    const backend = createBackend();
    const startEntered = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    const finalCleanup = Promise.withResolvers<void>();
    let resourceActive = false;
    let stopCount = 0;
    let startSignal: AbortSignal | undefined;
    backend.start = async (_context, signal) => {
      startSignal = signal;
      startEntered.resolve();
      await releaseStart.promise;
      signal.throwIfAborted();
      resourceActive = true;
    };
    backend.stop = async () => {
      stopCount += 1;
      resourceActive = false;

      if (stopCount === 2) {
        finalCleanup.resolve();
      }
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const nativeSetTimeout = globalThis.setTimeout;
    const acceleratedSetTimeout = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => nativeSetTimeout(callback, delay === 5_000 ? 10 : delay, ...args);
    globalThis.setTimeout = acceleratedSetTimeout as typeof setTimeout;

    try {
      const start = kernel.start(bootPayload);
      await startEntered.promise;
      await expect(kernel.stop("startup stop")).rejects.toThrow("timed out");
      expect(startSignal?.aborted).toBe(true);
      expect(startSignal?.reason).toMatchObject({ message: "startup stop" });
      releaseStart.resolve();
      await start;

      const cleaned = await Promise.race([
        finalCleanup.promise.then(() => true),
        Bun.sleep(50).then(() => false),
      ]);
      expect(cleaned).toBe(true);
      expect(stopCount).toBe(2);
      expect(resourceActive).toBe(false);
    } finally {
      releaseStart.resolve();
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("enforces the command queue UTF-8 JSON byte budget", async () => {
    const backend = createBackend();
    const pollEntered = Promise.withResolvers<void>();
    const failure = new Error("release queued commands");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
      hostPorts: {
        commandSource: {
          nextCommand: async () => {
            pollEntered.resolve();
            return new Promise<never>(() => {});
          },
        },
      },
    });
    const text = "x".repeat(17 * 1_024 * 1_024);

    await kernel.start(bootPayload);
    await pollEntered.promise;
    const first = kernel.dispatch({
      commandId: "large-command-1",
      input: { text },
      kind: "input.start",
      requestId: "large-request-1",
      runId: DRIVER_TEST_IDS.runId,
    });
    void first.catch(() => {});
    await expect(
      kernel.dispatch({
        commandId: "large-command-2",
        input: { text },
        kind: "input.start",
        requestId: "large-request-2",
        runId: DRIVER_TEST_IDS.runId,
      }),
    ).rejects.toThrow("UTF-8 JSON bytes");

    (context as AgentDriverContext | null)?.lifecycle.fail(failure);
    await expect(first).rejects.toBe(failure);
    await expect(kernel.stop("join failure")).rejects.toBe(failure);
  });

  test.each([
    ["poll", "resolve"],
    ["poll", "reject"],
    ["accepted ACK", "resolve"],
    ["accepted ACK", "reject"],
  ] as const)(
    "backend failure bounds a non-compliant %s and absorbs its late %s",
    async (boundary, lateOutcome) => {
      const backend = createBackend();
      const entered = Promise.withResolvers<void>();
      const late = Promise.withResolvers<unknown>();
      const failure = new Error(`provider failed during ${boundary}`);
      let context: AgentDriverContext | null = null;
      backend.start = async (startedContext) => {
        context = startedContext;
      };
      const hostPorts: AgentDriverContextPortOverrides =
        boundary === "poll"
          ? {
              commandSource: {
                nextCommand: async () => {
                  entered.resolve();
                  return late.promise as Promise<RuntimeCommand | null>;
                },
              },
            }
          : {
              eventSink: {
                commandUpdate: async () => {
                  entered.resolve();
                  await late.promise;
                },
                pushEvents: async ({ events }) => ({
                  accepted: events.map((event, index) => ({
                    seq: index + 1,
                    type: event.kind,
                  })),
                }),
              },
            };
      const kernel = new AgentDriverKernelCore({
        backendFactory: () => backend,
        hostPorts,
      });

      await kernel.start(bootPayload);
      const command =
        boundary === "accepted ACK"
          ? kernel
              .dispatch({
                commandId: "blocked-accepted-command",
                kind: "turn.cancel",
                reason: "test.cancel",
              })
              .catch(() => {})
          : null;
      await entered.promise;
      (context as AgentDriverContext | null)?.lifecycle.fail(failure);

      const stopped = await settlePromiseWithTimeout(kernel.stop("join failure"), {
        label: `Kernel ${boundary} failure shutdown`,
        timeoutMs: 100,
      });
      expect(stopped).toEqual({ error: failure, status: "failed" });
      await command;

      if (lateOutcome === "resolve") {
        late.resolve(boundary === "poll" ? null : undefined);
      } else {
        late.reject(new Error("late host port failure"));
      }
      await Bun.sleep(0);
    },
  );

  test("an idle backend failure enters the supervised shutdown path", async () => {
    const backend = createBackend();
    const failure = new Error("provider process exited");
    let context: AgentDriverContext | null = null;
    let stopCount = 0;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    backend.stop = async () => {
      stopCount += 1;
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    (context as AgentDriverContext | null)?.lifecycle.fail(failure);
    await expect(kernel.stop("wait for failure cleanup")).rejects.toBe(failure);

    expect(stopCount).toBe(1);
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("an active backend failure rejects input and publishes run.failed before shutdown", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    const failure = new Error("provider process exited during input");
    let context: AgentDriverContext | null = null;
    backend.start = async (startedContext) => {
      context = startedContext;
    };
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
    };
    backend.stop = async () => {
      releaseInput.resolve();
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    const input = kernel.dispatch({
      commandId: "failing-active-input",
      input: { text: "wait" },
      kind: "input.start",
      requestId: "failing-active-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    await inputEntered.promise;
    (context as AgentDriverContext | null)?.lifecycle.fail(failure);

    await expect(input).rejects.toBe(failure);
    await expect(kernel.stop("wait for failure cleanup")).rejects.toBe(failure);
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "run.failed", runId: DRIVER_TEST_IDS.runId },
    });
  });

  test("stop bypasses a full ordinary command queue", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    let stopCount = 0;
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
    };
    backend.stop = async () => {
      stopCount += 1;
      releaseInput.resolve();
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    const pending = [
      kernel
        .dispatch({
          commandId: "blocking-input",
          input: { text: "wait" },
          kind: "input.start",
          requestId: "blocking-request",
          runId: DRIVER_TEST_IDS.runId,
        })
        .catch(() => {}),
    ];
    await inputEntered.promise;
    pending.push(
      kernel
        .dispatch({
          commandId: "queued-input",
          input: { text: "wait again" },
          kind: "input.start",
          requestId: "queued-request",
          runId: DRIVER_TEST_IDS.runId,
        })
        .catch(() => {}),
    );
    await Bun.sleep(0);

    for (let index = 0; index < 1_024; index += 1) {
      pending.push(
        kernel
          .dispatch({
            commandId: `queued-cancel-${index}`,
            kind: "turn.cancel",
            reason: "queued",
          })
          .catch(() => {}),
      );
    }

    await expect(kernel.stop("queue full stop")).resolves.toBeUndefined();
    await Promise.all(pending);
    expect(stopCount).toBe(1);
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "run.completed" },
    });
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("cancels and settles an active input before releasing the backend", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    let stopCount = 0;
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
    };
    backend.cancelActiveTurn = async (_context, reason) => {
      backend.cancelledReasons.push(reason);
      releaseInput.resolve();
    };
    backend.stop = async () => {
      stopCount += 1;
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    await kernel.start(bootPayload);
    const input = kernel.dispatch({
      commandId: "active-input",
      input: { text: "wait" },
      kind: "input.start",
      requestId: "active-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    await inputEntered.promise;
    const stop = kernel.stop("active stop");

    await expect(input).resolves.toBeUndefined();
    await expect(stop).resolves.toBeUndefined();
    expect(backend.cancelledReasons).toEqual(["active stop"]);
    expect(stopCount).toBe(1);
  });

  test("never reports a successful stop while an owned input task is still running", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    let inputSettled = false;
    backend.handleInput = async () => {
      inputEntered.resolve();
      await releaseInput.promise;
      inputSettled = true;
    };
    backend.cancelActiveTurn = async () => {};
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    await kernel.start(bootPayload);
    const input = kernel
      .dispatch({
        commandId: "stuck-input",
        input: { text: "wait" },
        kind: "input.start",
        requestId: "stuck-request",
        runId: DRIVER_TEST_IDS.runId,
      })
      .catch(() => {});
    await inputEntered.promise;

    const first = await Promise.allSettled([kernel.stop("first stop")]);
    const second = await Promise.allSettled([kernel.stop("second stop")]);
    const settledBeforeRelease = inputSettled;
    releaseInput.resolve();
    await input;

    expect(first[0]?.status).toBe("rejected");
    expect(second[0]?.status).toBe("rejected");
    expect(settledBeforeRelease).toBe(false);
  }, 10_000);

  test("keeps cleanup event delivery available across a transient stop failure", async () => {
    const backend = createBackend();
    let stopCount = 0;
    backend.stop = async (context) => {
      stopCount += 1;

      if (stopCount === 1) {
        throw new Error("cleanup failed");
      }

      await context.ports.eventSink.pushEvents({
        events: [
          {
            kind: "diagnostic.reported",
            payload: {
              code: "cleanup.retried",
              details: {},
              message: "Cleanup retry completed.",
              severity: "info",
              source: "core",
            },
          },
        ],
      });
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    await expect(kernel.stop("first stop")).rejects.toThrow("cleanup failed");
    await expect(kernel.stop("second stop")).resolves.toBeUndefined();

    const received: DriverEventInput[] = [];

    for await (const event of { [Symbol.asyncIterator]: () => events }) {
      received.push(event);
    }

    expect(stopCount).toBe(2);
    expect(received.map((event) => event.kind)).toEqual(["run.completed", "diagnostic.reported"]);
  });

  test.each([
    ["transient", 1, "fulfilled", 2],
    ["persistent", Number.POSITIVE_INFINITY, "rejected", 3],
  ] as const)(
    "retries %s backend cleanup during and after a stop call",
    async (_name, failures, secondStatus, expectedStops) => {
      const backend = createBackend();
      let stopCount = 0;
      backend.stop = async () => {
        stopCount += 1;

        if (stopCount <= failures) {
          throw new Error("cleanup failed");
        }
      };
      const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
      const events = kernel.events()[Symbol.asyncIterator]();

      await kernel.start(bootPayload);
      await expect(kernel.stop("test.stop")).rejects.toThrow("cleanup failed");
      const [second] = await Promise.allSettled([kernel.stop("test.stop.again")]);

      expect(second?.status).toBe(secondStatus);
      expect(stopCount).toBe(expectedStops);
      await expect(events.next()).resolves.toMatchObject({
        done: false,
        value: { kind: "run.completed" },
      });
      if (secondStatus === "fulfilled") {
        await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
      }
      await expect(
        kernel.dispatch({
          commandId: "after-stop-failure",
          kind: "turn.cancel",
          reason: "test",
        }),
      ).rejects.toThrow("not accepting commands: failed");
    },
  );

  test("starts a new cleanup attempt after the previous one times out", async () => {
    const backend = createBackend();
    const firstStopAborted = Promise.withResolvers<void>();
    const stopSignals: AbortSignal[] = [];
    let stopCount = 0;
    backend.stop = async (_context, _reason, signal) => {
      stopCount += 1;
      stopSignals.push(signal);

      if (stopCount === 1) {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              firstStopAborted.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const nativeSetTimeout = globalThis.setTimeout;
    const acceleratedSetTimeout = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => nativeSetTimeout(callback, delay === 5_000 ? 10 : delay, ...args);
    globalThis.setTimeout = acceleratedSetTimeout as typeof setTimeout;

    try {
      await kernel.start(bootPayload);
      const firstError = await kernel.stop("first stop").then(
        () => null,
        (error: unknown) => error,
      );
      expect(firstError).toBeInstanceOf(Error);
      expect((firstError as Error).message).toContain("timed out");
      await firstStopAborted.promise;
      expect(stopSignals[0]?.reason).toMatchObject({
        message: "Driver kernel backend shutdown timed out after 5000ms.",
      });
      await expect(kernel.stop("second stop")).resolves.toBeUndefined();
      expect(stopCount).toBe(2);
      expect(stopSignals[1]).not.toBe(stopSignals[0]);
      expect(stopSignals[1]?.aborted).toBe(false);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("passes host ports into backend context", async () => {
    const backend = createBackend();
    let mcpOutput: string | null = null;
    let materializedSkillName: string | null = null;
    backend.start = async (context: AgentDriverContext) => {
      const [skill] = await context.ports.skill.materialize(context.payload.execution);
      materializedSkillName = skill?.skillName ?? null;
    };
    backend.handleInput = async (context: AgentDriverContext) => {
      const result = await context.ports.mcp.execute(
        {
          argumentsJson: '{"ok":true}',
          commandId: "mcp-port-1",
          kind: "mcp.execute",
          requestId: "request-1",
          serverId: "server-1",
          toolCallId: "tool-1",
          toolName: "complete",
        },
        new AbortController().signal,
      );
      mcpOutput = result.outputText;
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
      hostPorts: {
        mcp: {
          execute: async (command) => ({
            outputText: `port:${command.toolName}`,
            requestId: command.requestId,
            serverId: command.serverId,
            toolName: command.toolName,
          }),
        },
        skill: {
          materialize: async () => [
            {
              mountPath: "/workspace/.mosoo/skill/review",
              skillId: "skill-1",
              skillMarkdownPath: "/workspace/.mosoo/skill/review/SKILL.md",
              skillName: "review",
              snapshotId: "snapshot-1",
            },
          ],
        },
      },
    });

    await kernel.start(bootPayload);
    await kernel.dispatch({
      commandId: "input-ports-1",
      input: {
        text: "hello",
      },
      kind: "input.start",
      requestId: "request-1",
      runId: DRIVER_TEST_IDS.runId,
    });
    await kernel.stop("test.stop");

    expect(mcpOutput).toBe("port:complete");
    expect(materializedSkillName).toBe("review");
  });
});
