import { describe, expect, test } from "bun:test";

import { DriverRuntimeStateMachine } from "../src/core/driver-runtime-state";
import type { RuntimeCommand } from "../src/runtime-command";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import {
  FakeDriverRuntimeIo,
  createBackend,
  createDispatcher,
} from "./driver-runtime-boundary-fixtures";

describe("driver runtime boundary", () => {
  test.each(["input", "mcp"] as const)(
    "serializes a replayed %s acceptance before its terminal update",
    async (kind) => {
      const backend = createBackend();
      const releaseEffect = Promise.withResolvers<void>();
      const secondAccepted = Promise.withResolvers<void>();
      const releaseAccepted = Promise.withResolvers<void>();
      let sideEffects = 0;
      let terminalStarted = false;
      backend.handleInput = async () => {
        sideEffects += 1;
        await releaseEffect.promise;
      };
      const command: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "serialized-input-replay",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "serialized-request",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              argumentsJson: "{}",
              commandId: "serialized-mcp-replay",
              kind: "mcp.execute",
              requestId: "serialized-request",
              serverId: "mcp-linear",
              toolCallId: "tool-serialized",
              toolName: "createIssue",
            };
      const socket = new FakeDriverRuntimeIo([command, structuredClone(command)]);
      const recordUpdate = socket.commandUpdate.bind(socket);
      let accepted = 0;
      socket.commandUpdate = async (update, signal) => {
        if (update.status === "accepted") {
          accepted += 1;
          if (accepted === 2) {
            secondAccepted.resolve();
            await releaseAccepted.promise;
          }
        } else {
          terminalStarted = true;
        }
        await recordUpdate(update, signal);
      };
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const { dispatcher, logger } = createDispatcher({
        backend,
        isShuttingDown: () =>
          socket.updates.some(
            (update) => update.commandId === command.commandId && update.status === "completed",
          ),
        mcpExecute: async (mcpCommand) => {
          sideEffects += 1;
          await releaseEffect.promise;
          return {
            outputText: "done",
            requestId: mcpCommand.requestId,
            serverId: mcpCommand.serverId,
            toolName: mcpCommand.toolName,
          };
        },
        runtimeState,
      });
      const run = dispatcher.run(socket, logger);

      await secondAccepted.promise;
      releaseEffect.resolve();
      await Bun.sleep(10);
      expect(terminalStarted).toBe(false);
      releaseAccepted.resolve();
      await run;

      expect(sideEffects).toBe(1);
      expect(socket.updates.map((update) => update.status)).toEqual([
        "accepted",
        "accepted",
        "completed",
      ]);
    },
  );

  test.each(["input", "mcp"] as const)(
    "joins an in-flight %s terminal delivery before idempotently replaying it",
    async (kind) => {
      const backend = createBackend();
      let sideEffects = 0;
      backend.handleInput = async () => {
        sideEffects += 1;
      };
      const command: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "joined-input-replay",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "joined-request",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              argumentsJson: "{}",
              commandId: "joined-mcp-replay",
              kind: "mcp.execute",
              requestId: "joined-request",
              serverId: "mcp-linear",
              toolCallId: "tool-joined",
              toolName: "createIssue",
            };
      const socket = new FakeDriverRuntimeIo([command, structuredClone(command)]);
      const terminalEntered = Promise.withResolvers<void>();
      const releaseTerminal = Promise.withResolvers<void>();
      const nextCommand = socket.nextCommand.bind(socket);
      let reads = 0;
      socket.nextCommand = async (signal) => {
        reads += 1;
        if (reads === 2) {
          await terminalEntered.promise;
        }
        return nextCommand(signal);
      };
      const recordUpdate = socket.commandUpdate.bind(socket);
      let terminalAttempts = 0;
      socket.commandUpdate = async (update, signal) => {
        if (update.status !== "accepted") {
          terminalAttempts += 1;
          if (terminalAttempts === 1) {
            terminalEntered.resolve();
            await releaseTerminal.promise;
          }
        }
        await recordUpdate(update, signal);
      };
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const { commandReads, dispatcher, logger } = createDispatcher({
        backend,
        isShuttingDown: () =>
          socket.updates.filter(
            (update) => update.commandId === command.commandId && update.status === "completed",
          ).length === 2,
        mcpExecute: async (mcpCommand) => {
          sideEffects += 1;
          return {
            outputText: "done",
            requestId: mcpCommand.requestId,
            serverId: mcpCommand.serverId,
            toolName: mcpCommand.toolName,
          };
        },
        runtimeState,
      });
      const run = dispatcher.run(socket, logger);

      await terminalEntered.promise;
      while (commandReads.count < 2) {
        await Bun.sleep(0);
      }
      await Bun.sleep(0);
      expect(terminalAttempts).toBe(1);
      expect(socket.updates.filter((update) => update.status === "accepted")).toHaveLength(1);
      releaseTerminal.resolve();
      await run;

      expect(sideEffects).toBe(1);
      expect(terminalAttempts).toBe(2);
      expect(socket.updates.map((update) => update.status)).toEqual([
        "accepted",
        "completed",
        "completed",
      ]);
    },
  );

  test.each(["input", "mcp"] as const)(
    "shares a failing in-flight %s terminal delivery with its replay",
    async (kind) => {
      const backend = createBackend();
      let sideEffects = 0;
      backend.handleInput = async () => {
        sideEffects += 1;
      };
      const command: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "failed-joined-input-replay",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "failed-joined-request",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              argumentsJson: "{}",
              commandId: "failed-joined-mcp-replay",
              kind: "mcp.execute",
              requestId: "failed-joined-request",
              serverId: "mcp-linear",
              toolCallId: "tool-failed-joined",
              toolName: "createIssue",
            };
      const socket = new FakeDriverRuntimeIo([command, structuredClone(command)]);
      const terminalEntered = Promise.withResolvers<void>();
      const releaseTerminal = Promise.withResolvers<void>();
      const nextCommand = socket.nextCommand.bind(socket);
      let reads = 0;
      socket.nextCommand = async (signal) => {
        reads += 1;
        if (reads === 2) {
          await terminalEntered.promise;
        }
        return nextCommand(signal);
      };
      const recordUpdate = socket.commandUpdate.bind(socket);
      let released = false;
      let terminalAttempts = 0;
      socket.commandUpdate = async (update, signal) => {
        if (update.status === "accepted") {
          await recordUpdate(update, signal);
          return;
        }

        terminalAttempts += 1;
        if (terminalAttempts === 1) {
          terminalEntered.resolve();
          await releaseTerminal.promise;
        } else if (!released) {
          await recordUpdate(update, signal);
          return;
        }

        throw new Error("terminal transport unavailable");
      };
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const { commandReads, dispatcher, logger } = createDispatcher({
        backend,
        isShuttingDown: () =>
          socket.updates.some(
            (update) => update.commandId === command.commandId && update.status === "completed",
          ),
        mcpExecute: async (mcpCommand) => {
          sideEffects += 1;
          return {
            outputText: "done",
            requestId: mcpCommand.requestId,
            serverId: mcpCommand.serverId,
            toolName: mcpCommand.toolName,
          };
        },
        runtimeState,
      });
      const run = dispatcher.run(socket, logger);

      await terminalEntered.promise;
      while (commandReads.count < 2) {
        await Bun.sleep(0);
      }
      await Bun.sleep(0);
      const attemptsBeforeRelease = terminalAttempts;
      released = true;
      releaseTerminal.resolve();
      const outcome = await settlePromiseWithTimeout(run, {
        label: `${kind} shared terminal failure`,
        timeoutMs: 1_500,
      });

      expect(attemptsBeforeRelease).toBe(1);
      expect(outcome).toMatchObject({
        error: { message: expect.stringContaining("terminal status could not be delivered") },
        status: "failed",
      });
      expect(sideEffects).toBe(1);
      expect(terminalAttempts).toBe(3);
      expect(socket.updates.map((update) => update.status)).toEqual(["accepted"]);
      expect(runtimeState.status()).toBe("failed");
    },
  );

  test.each(["completed", "failed"] as const)(
    "isolates a cached %s update from synchronous and awaited sink mutation",
    async (terminalStatus) => {
      const backend = createBackend();
      const command: RuntimeCommand = {
        argumentsJson: "{}",
        commandId: `sink-mutation-${terminalStatus}`,
        kind: "mcp.execute",
        requestId: "sink-mutation-request",
        serverId: "mcp-linear",
        toolCallId: "tool-sink-mutation",
        toolName: "createIssue",
      };
      const socket = new FakeDriverRuntimeIo([command, structuredClone(command)]);
      const terminalEntered = Promise.withResolvers<void>();
      const releaseTerminal = Promise.withResolvers<void>();
      const nextCommand = socket.nextCommand.bind(socket);
      let reads = 0;
      socket.nextCommand = async (signal) => {
        reads += 1;
        if (reads === 2) {
          await terminalEntered.promise;
        }
        return nextCommand(signal);
      };
      const recordUpdate = socket.commandUpdate.bind(socket);
      const terminalSnapshots: Parameters<typeof recordUpdate>[0][] = [];
      let deliveredTerminals = 0;
      socket.commandUpdate = async (update, signal) => {
        if (update.status === "accepted") {
          await recordUpdate(update, signal);
          return;
        }

        terminalSnapshots.push(structuredClone(update));
        if (terminalSnapshots.length === 1) {
          if (update.result !== undefined && update.result !== null) {
            Reflect.set(update.result, "outputText", "mutated synchronously");
          }
          if (update.error !== undefined) {
            Reflect.set(update.error, "message", "mutated synchronously");
          }
          terminalEntered.resolve();
          await releaseTerminal.promise;

          const debug =
            update.result === undefined || update.result === null
              ? undefined
              : (Reflect.get(update.result, "debug") as { nested?: string } | undefined);
          if (debug !== undefined) {
            debug.nested = "mutated after await";
          }
          if (update.error !== undefined) {
            Reflect.set(update.error.details, "commandId", "mutated after await");
          }
        }

        await recordUpdate(update, signal);
        deliveredTerminals += 1;
      };
      let executeCalls = 0;
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const { dispatcher, logger } = createDispatcher({
        backend,
        isShuttingDown: () => deliveredTerminals === 2,
        mcpExecute: async (mcpCommand) => {
          executeCalls += 1;
          if (terminalStatus === "failed") {
            throw new Error("MCP failed");
          }

          const result = {
            debug: { nested: "original" },
            outputText: "original",
            requestId: mcpCommand.requestId,
            serverId: mcpCommand.serverId,
            toolName: mcpCommand.toolName,
          };
          return result;
        },
        runtimeState,
      });
      const run = dispatcher.run(socket, logger);

      await terminalEntered.promise;
      releaseTerminal.resolve();
      await run;

      expect(executeCalls).toBe(1);
      expect(terminalSnapshots).toHaveLength(2);
      expect(terminalSnapshots[1]).toEqual(terminalSnapshots[0]);
      expect(terminalSnapshots[1]?.status).toBe(terminalStatus);
    },
  );

  test.each(["input", "mcp"] as const)(
    "keeps retrying a cached %s terminal update without repeating its side effect",
    async (kind) => {
      const backend = createBackend();
      let sideEffects = 0;
      backend.handleInput = async () => {
        sideEffects += 1;
      };
      const runtimeState = new DriverRuntimeStateMachine("ready");
      const command: RuntimeCommand =
        kind === "input"
          ? {
              commandId: "input-report-failure",
              input: { text: "hello" },
              kind: "input.start",
              requestId: "request-report-failure",
              runId: DRIVER_TEST_IDS.runId,
            }
          : {
              argumentsJson: "{}",
              commandId: "mcp-report-failure",
              kind: "mcp.execute",
              requestId: "request-report-failure",
              serverId: "mcp-linear",
              toolCallId: "tool-report-failure",
              toolName: "createIssue",
            };
      const socket = new FakeDriverRuntimeIo([command]);
      const recordUpdate = socket.commandUpdate.bind(socket);
      const terminalAttempts: string[] = [];
      socket.commandUpdate = async (update, signal) => {
        if (update.status !== "accepted") {
          terminalAttempts.push(update.status);

          if (terminalAttempts.length <= 2) {
            throw new Error("control socket unavailable");
          }
        }

        await recordUpdate(update, signal);
      };
      const { dispatcher, logger, shutdownCalls } = createDispatcher({
        backend,
        isShuttingDown: () =>
          socket.updates.some(
            (update) => update.commandId === command.commandId && update.status === "completed",
          ),
        mcpExecute: async (mcpCommand) => {
          sideEffects += 1;
          return {
            outputText: `ran ${mcpCommand.toolName}`,
            requestId: mcpCommand.requestId,
            serverId: mcpCommand.serverId,
            toolName: mcpCommand.toolName,
          };
        },
        runtimeState,
      });

      await dispatcher.run(socket, logger);

      expect(sideEffects).toBe(1);
      expect(terminalAttempts).toEqual(["completed", "completed", "completed"]);
      expect(socket.updates.map((update) => update.status)).toEqual(["accepted", "completed"]);
      expect(shutdownCalls).toEqual([]);
    },
  );
});
