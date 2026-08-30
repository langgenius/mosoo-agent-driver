import { describe, expect, test } from "bun:test";

import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import type { DriverEventInput } from "../src/protocol/events";
import type { RuntimeCommand } from "../src/runtime-command";
import {
  DRIVER_TEST_IDS,
  bootPayload,
  createBackend,
  settleBackendInput,
} from "./driver-runtime-boundary-fixtures";

describe("AgentDriverKernelCore", () => {
  test("commits a custom event sink terminal through the kernel lifecycle owner", async () => {
    const backend = createBackend();
    const delivered: DriverEventInput[] = [];
    backend.handleInput = async (context, _input, runId, signal) => {
      expect(context.ports.eventSink.currentRunId()).toBe(runId);
      await settleBackendInput(context, runId, signal);
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
      hostPorts: {
        eventSink: {
          commandUpdate: async () => {},
          currentRunId: () => DRIVER_TEST_IDS.secondRunId,
          pushEvents: async ({ events }) => {
            delivered.push(...structuredClone(events));
            return {
              accepted: events.map((event, index) => ({
                eventId: event.sourceEventId!,
                seq: index + 1,
                type: event.kind,
              })),
            };
          },
        },
      },
    });

    await kernel.start(bootPayload);
    await expect(
      kernel.dispatch({
        commandId: "custom-sink-input",
        input: { text: "complete" },
        kind: "input.start",
        requestId: "custom-sink-request",
        runId: DRIVER_TEST_IDS.runId,
      }),
    ).resolves.toEqual({ requestId: "custom-sink-request" });

    expect(delivered).toContainEqual(
      expect.objectContaining({ kind: "run.completed", runId: DRIVER_TEST_IDS.runId }),
    );
    expect(kernel.currentRunId()).toBeNull();
    await expect(kernel.stop("custom sink complete")).resolves.toBeUndefined();
  });

  test("refuses to synthesize an in-memory MCP effect ledger", async () => {
    const kernel = new AgentDriverKernelCore({ backendFactory: () => createBackend() });

    await expect(
      kernel.claimExternalToolEffect(
        {
          claimToken: "00000000-0000-4000-8000-000000000001",
          commandId: "mcp-command-without-durable-ledger",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/durable external tool effect ledger/);
  });

  test.each(["input", "mcp"] as const)(
    "replays a completed %s command without repeating its side effect",
    async (kind) => {
      const backend = createBackend();
      let calls = 0;
      const effectResults = new Map<
        string,
        { outputText: string; requestId: string; serverId: string; toolName: string }
      >();
      const activeRunEntered = Promise.withResolvers<void>();
      const releaseActiveRun = Promise.withResolvers<void>();
      backend.handleInput = async (context, _input, runId, signal) => {
        if (kind === "mcp") {
          activeRunEntered.resolve();
          await releaseActiveRun.promise;
          await settleBackendInput(context, runId, signal);
          return;
        }
        calls += 1;
        await settleBackendInput(context, runId, signal);
      };
      const kernel = new AgentDriverKernelCore({
        backendFactory: () => backend,
        externalToolEffectLedger: {
          claimExternalToolEffect: async ({ commandId }) => {
            const result = effectResults.get(commandId);
            const effectId = `test-effect-${commandId}`;

            return result === undefined
              ? { attempt: 1, effectId, idempotencyKey: effectId, kind: "claimed" as const }
              : { effectId, kind: "succeeded" as const, result };
          },
          observeExternalToolEffect: async ({ commandId }) => {
            const result = effectResults.get(commandId);
            const effectId = `test-effect-${commandId}`;
            return result === undefined
              ? { effectId, kind: "intent" as const }
              : { effectId, kind: "succeeded" as const, result };
          },
          settleExternalToolEffect: async ({ commandId, effectId, settlement }) => {
            if (settlement.kind === "unknown") {
              return { effectId, kind: "unknown" as const };
            }
            effectResults.set(commandId, structuredClone(settlement.result));
            return { effectId, kind: "succeeded" as const, result: settlement.result };
          },
        },
        hostPorts: {
          mcp: {
            prepare: async (command) => ({
              async execute() {
                calls += 1;
                return {
                  outputText: `ran ${command.toolName}`,
                  requestId: command.requestId,
                  serverId: command.serverId,
                  toolName: command.toolName,
                };
              },
              async [Symbol.asyncDispose]() {},
            }),
          },
        },
      });
      const command: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "replayed-command",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "request-replay",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              argumentsJson: '{"issue":"A-1"}',
              commandId: "replayed-command",
              kind: "mcp.execute",
              requestId: "request-replay",
              runId: DRIVER_TEST_IDS.runId,
              serverId: "mcp-linear",
              toolCallId: "tool-replay",
              toolName: "createIssue",
            };

      await kernel.start(bootPayload);
      const activeRun =
        kind === "mcp"
          ? kernel.dispatch({
              commandId: "active-run-command",
              input: { text: "keep the run active" },
              kind: "input.start",
              requestId: "active-run-request",
              runId: DRIVER_TEST_IDS.runId,
            })
          : null;
      if (activeRun !== null) {
        await activeRunEntered.promise;
      }
      const first = await kernel.dispatch(command);
      if (typeof first === "object" && first !== null) {
        Reflect.set(first, "requestId", "caller-mutated");
      }
      const replay = await kernel.dispatch(structuredClone(command));
      releaseActiveRun.resolve();
      await activeRun;
      await kernel.stop("test.stop");

      expect(replay).toEqual(
        kind === "input"
          ? { requestId: "request-replay" }
          : {
              outputText: "ran createIssue",
              requestId: "request-replay",
              serverId: "mcp-linear",
              toolName: "createIssue",
            },
      );
      expect(calls).toBe(1);
    },
  );

  test("exposes provider events through the kernel event stream", async () => {
    const backend = createBackend();
    const event: DriverEventInput = {
      kind: "message.started",
      payload: {
        messageId: "message-1",
        role: "agent",
      },
    };
    backend.handleInput = async (context: AgentDriverContext, _input, runId, signal) => {
      await context.ports.eventSink.pushEvents({ events: [event] });
      await settleBackendInput(context, runId, signal);
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
    });
    const events = kernel.events()[Symbol.asyncIterator]();

    await kernel.start(bootPayload);
    const dispatch = kernel.dispatch({
      commandId: "input-1",
      input: {
        text: "hello",
      },
      kind: "input.start",
      requestId: "request-1",
      runId: DRIVER_TEST_IDS.runId,
    });

    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: event,
    });
    await expect(dispatch).resolves.toEqual({
      requestId: "request-1",
    });
    await kernel.stop("test.stop");
  });

  test("turn cancel dispatches through the active backend", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    backend.handleInput = async (context, _input, runId, signal) => {
      inputEntered.resolve();
      await releaseInput.promise;
      await settleBackendInput(context, runId, signal);
    };
    backend.cancelActiveTurn = async (_context, reason) => {
      backend.cancelledReasons.push(reason);
      releaseInput.resolve();
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => backend,
    });

    await kernel.start(bootPayload);
    const input = kernel.dispatch({
      commandId: "cancel-active-input",
      input: { text: "wait" },
      kind: "input.start",
      requestId: "cancel-active-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    await inputEntered.promise;
    await kernel.cancel("test.cancel");
    await input;
    expect(backend.cancelledReasons).toEqual(["test.cancel"]);
    await kernel.stop("test.stop");

    expect(backend.cancelledReasons).toEqual(["test.cancel", "test.stop"]);
  });

  test("completes turn cancellation only after the active input settles", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const releaseInput = Promise.withResolvers<void>();
    const cancelEntered = Promise.withResolvers<void>();
    backend.handleInput = async (context, _input, runId, signal) => {
      inputEntered.resolve();
      await releaseInput.promise;
      await settleBackendInput(context, runId, signal);
    };
    backend.cancelActiveTurn = async (_context, reason) => {
      backend.cancelledReasons.push(reason);
      cancelEntered.resolve();
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
    const cancel = kernel.cancel("test.cancel");
    await cancelEntered.promise;

    expect(await Promise.race([cancel.then(() => true), Bun.sleep(10).then(() => false)])).toBe(
      false,
    );

    releaseInput.resolve();
    await expect(Promise.all([input, cancel])).resolves.toEqual([undefined, undefined]);
    await kernel.stop("test.stop");
  });

  test("keeps an ordinary input error failed after the local abort", async () => {
    const backend = createBackend();
    const inputEntered = Promise.withResolvers<void>();
    const cancelInput = Promise.withResolvers<void>();
    backend.handleInput = async () => {
      inputEntered.resolve();
      await cancelInput.promise;
    };
    backend.cancelActiveTurn = async () => {
      cancelInput.reject(new Error("native cancellation"));
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    await kernel.start(bootPayload);
    const input = kernel.dispatch({
      commandId: "cancelled-input",
      input: { text: "wait" },
      kind: "input.start",
      requestId: "cancelled-request",
      runId: DRIVER_TEST_IDS.runId,
    });
    await inputEntered.promise;

    await expect(Promise.all([input, kernel.cancel("test.cancel")])).rejects.toThrow(
      "native cancellation",
    );
    await expect(kernel.stop("test.stop")).resolves.toBeUndefined();
  });

  test.each(["allow_once", "reject_once"] as const)(
    "ignores a stale %s permission completion after its cancelled run",
    async (decision) => {
      const backend = createBackend();
      const inputEntered = Promise.withResolvers<void>();
      const releaseInput = Promise.withResolvers<void>();
      const nextInputEntered = Promise.withResolvers<void>();
      const releaseNextInput = Promise.withResolvers<void>();
      const resolutionPublishing = Promise.withResolvers<void>();
      const releaseResolution = Promise.withResolvers<void>();
      let inputCount = 0;
      let permission: Promise<unknown> | null = null;
      let resolutionRunId: unknown;
      backend.handleInput = async (context, _input, runId, signal) => {
        inputCount += 1;

        if (inputCount > 1) {
          nextInputEntered.resolve();
          await releaseNextInput.promise;
          await settleBackendInput(context, runId, signal);
          return;
        }

        permission = context.ports.permission.request({
          rawInput: null,
          requestId: "permission-stale",
          title: "Allow test tool?",
          toolCallId: "tool-call-stale",
          toolKind: "test",
        });
        inputEntered.resolve();
        await releaseInput.promise;
        await settleBackendInput(context, runId, signal);
      };
      backend.cancelActiveTurn = async () => {
        releaseInput.resolve();
      };
      const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
      const pushEvents = kernel.pushEvents.bind(kernel);
      kernel.pushEvents = async (input) => {
        const resolution = input.events.find((event) => event.kind === "permission.resolved");
        if (resolution !== undefined) {
          resolutionRunId = resolution.runId;
          resolutionPublishing.resolve();
          await releaseResolution.promise;
        }

        return pushEvents(input);
      };
      const payload = {
        ...bootPayload,
        execution: {
          ...bootPayload.execution,
          permissionPolicy: "supervised" as const,
        },
      };

      await kernel.start(payload);
      const firstInput = kernel.dispatch({
        commandId: "permission-input",
        input: { text: "wait for permission" },
        kind: "input.start",
        requestId: "permission-request",
        runId: DRIVER_TEST_IDS.runId,
      });
      await inputEntered.promise;
      const cancellation = kernel.cancel("test.cancel");
      await resolutionPublishing.promise;
      releaseResolution.resolve();
      await expect(Promise.all([firstInput, cancellation])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      await expect(
        kernel.dispatch({
          commandId: "resolve-stale-permission",
          decision,
          kind: "permission.resolve",
          requestId: "permission-stale",
          runId: DRIVER_TEST_IDS.runId,
        }),
      ).rejects.toThrow("does not target the active run");
      const nextInput = kernel.dispatch({
        commandId: "next-input",
        input: { text: "continue" },
        kind: "input.start",
        requestId: "next-request",
        runId: DRIVER_TEST_IDS.secondRunId,
      });
      await nextInputEntered.promise;
      await expect(permission).resolves.toBe("reject_once");
      expect(resolutionRunId).toBe(DRIVER_TEST_IDS.runId);
      releaseNextInput.resolve();
      await expect(nextInput).resolves.toEqual({ requestId: "next-request" });
      await kernel.stop("test.stop");
    },
  );

  test.each(["requested", "resolved"] as const)(
    "fails closed when a cancelled permission.%s event cannot be delivered",
    async (phase) => {
      const backend = createBackend();
      const inputEntered = Promise.withResolvers<void>();
      const deliveryEntered = Promise.withResolvers<void>();
      const releaseDelivery = Promise.withResolvers<void>();
      backend.handleInput = async (context) => {
        inputEntered.resolve();
        await context.ports.permission.request({
          rawInput: null,
          requestId: "permission-delivery-failure",
          title: "Allow test tool?",
          toolCallId: "tool-call-delivery-failure",
          toolKind: "test",
        });
      };
      const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
      const pushEvents = kernel.pushEvents.bind(kernel);
      kernel.pushEvents = async (input) => {
        if (input.events.some((event) => event.kind === `permission.${phase}`)) {
          deliveryEntered.resolve();
          await releaseDelivery.promise;
          throw new Error("permission event delivery failed");
        }

        return pushEvents(input);
      };
      const payload = {
        ...bootPayload,
        execution: {
          ...bootPayload.execution,
          permissionPolicy: "supervised" as const,
        },
      };

      await kernel.start(payload);
      const input = kernel.dispatch({
        commandId: "permission-delivery-input",
        input: { text: "wait for permission" },
        kind: "input.start",
        requestId: "permission-delivery-request",
        runId: DRIVER_TEST_IDS.runId,
      });
      void input.catch(() => {});
      await inputEntered.promise;
      const cancel = kernel.cancel("test.cancel");
      void cancel.catch(() => {});
      await deliveryEntered.promise;
      releaseDelivery.resolve();

      await expect(input).rejects.toThrow("could not be delivered");
      await cancel.catch(() => {});
      await expect(
        kernel.dispatch({
          commandId: "input-after-permission-delivery-failure",
          input: { text: "must not continue" },
          kind: "input.start",
          requestId: "request-after-permission-delivery-failure",
          runId: DRIVER_TEST_IDS.secondRunId,
        }),
      ).rejects.toThrow("not accepting commands: failed");
      await expect(kernel.stop("test.stop")).rejects.toThrow("could not be delivered");
    },
  );

  test("propagates a lifecycle failure raised during backend startup", async () => {
    const backend = createBackend();
    const failure = new Error("provider failed during startup");
    backend.start = async (context) => {
      context.lifecycle.fail(failure);
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    await expect(kernel.start(bootPayload)).rejects.toBe(failure);
    await expect(kernel.stop("join failed startup")).rejects.toBe(failure);
  });

  test.each([
    ["factory", 0],
    ["backend start", 1],
  ] as const)("closes the kernel after a %s failure", async (stage, expectedStopCount) => {
    const backend = createBackend();
    let stopCount = 0;
    backend.start = async () => {
      if (stage === "backend start") {
        throw new Error("startup failed");
      }
    };
    backend.stop = async () => {
      stopCount += 1;
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: () => {
        if (stage === "factory") {
          throw new Error("startup failed");
        }

        return backend;
      },
    });
    const events = kernel.events()[Symbol.asyncIterator]();

    await expect(kernel.start(bootPayload)).rejects.toThrow("startup failed");
    await expect(kernel.stop("test.stop")).rejects.toThrow("startup failed");
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(
      kernel.dispatch({
        commandId: "after-start-failure",
        kind: "turn.cancel",
        reason: "test",
        runId: DRIVER_TEST_IDS.runId,
      }),
    ).rejects.toThrow("not accepting commands: failed");
    expect(stopCount).toBe(expectedStopCount);
  });

  test.each([
    ["successful", null],
    ["failed", new Error("cleanup failed")],
  ] as const)(
    "joins %s startup cleanup from every concurrent stop",
    async (_name, cleanupError) => {
      const backend = createBackend();
      const cleanupEntered = Promise.withResolvers<void>();
      const releaseCleanup = Promise.withResolvers<void>();
      let stopCount = 0;
      backend.start = async () => {
        throw new Error("startup failed");
      };
      backend.stop = async () => {
        stopCount += 1;
        cleanupEntered.resolve();
        await releaseCleanup.promise;

        if (cleanupError !== null) {
          throw cleanupError;
        }
      };
      const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
      const events = kernel.events()[Symbol.asyncIterator]();
      const startOutcome = kernel.start(bootPayload).then(
        () => null,
        (error: unknown) => error,
      );

      await cleanupEntered.promise;
      const stopOutcome = Promise.all([kernel.stop("first stop"), kernel.stop("second stop")]).then(
        () => null,
        (error: unknown) => error,
      );

      expect(
        await Promise.race([stopOutcome.then(() => true), Bun.sleep(10).then(() => false)]),
      ).toBe(false);

      releaseCleanup.resolve();
      const startupError = await startOutcome;
      expect(startupError).toMatchObject({ message: "startup failed" });
      expect(await stopOutcome).toBe(startupError);

      expect(stopCount).toBe(1);
      if (cleanupError === null) {
        await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
      }
    },
  );

  test("joins concurrent stop calls with an in-flight start", async () => {
    const backend = createBackend();
    const startEntered = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    let stopCount = 0;
    let stopReason: string | null = null;
    backend.start = async () => {
      startEntered.resolve();
      await releaseStart.promise;
    };
    backend.stop = async (_context, reason) => {
      stopCount += 1;
      stopReason = reason;
      releaseStart.resolve();
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });
    const events = kernel.events()[Symbol.asyncIterator]();

    const start = kernel.start(bootPayload);
    await startEntered.promise;
    const firstStop = kernel.stop("first stop");
    const secondStop = kernel.stop("second stop");

    await expect(start).resolves.toBeUndefined();
    await expect(Promise.all([firstStop, secondStop])).resolves.toEqual([undefined, undefined]);
    await expect(kernel.stop("third stop")).resolves.toBeUndefined();
    expect(stopCount).toBe(2);
    expect(stopReason).toBe("first stop");
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("stops resources created while the original startup task settles", async () => {
    const backend = createBackend();
    const startEntered = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    let resourceActive = false;
    let stopCount = 0;
    backend.start = async () => {
      startEntered.resolve();
      await releaseStart.promise;
      resourceActive = true;
    };
    backend.stop = async () => {
      stopCount += 1;
      resourceActive = false;
    };
    const kernel = new AgentDriverKernelCore({ backendFactory: () => backend });

    const start = kernel.start(bootPayload);
    await startEntered.promise;
    const stop = kernel.stop("startup stop");

    expect(await Promise.race([stop.then(() => true), Bun.sleep(10).then(() => false)])).toBe(
      false,
    );
    releaseStart.resolve();

    await expect(stop).resolves.toBeUndefined();
    await expect(start).resolves.toBeUndefined();
    expect(stopCount).toBe(2);
    expect(resourceActive).toBe(false);
  });
});
