import { describe, expect, test } from "bun:test";

import { AgentDriverKernelCore } from "../src/core/agent-driver-kernel";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import type { AgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { driverBootPayload } from "./driver-boot-payload-fixture";
import {
  DRIVER_TEST_IDS,
  bootPayload,
  createBackend,
} from "./driver-runtime-boundary-fixtures";

describe("AgentDriverKernelCore", () => {
  test("starts from a driver start input without boot transport fields", async () => {
    const backend = createBackend();
    const startInput = createDriverStartInputFromBootPayload(driverBootPayload);
    const kernel = new AgentDriverKernelCore({
      backendFactory: async () => backend,
    });

    await kernel.start(startInput);
    await kernel.stop("test.stop");

    expect(startInput).not.toHaveProperty("bootToken");
    expect(startInput).not.toHaveProperty("driverControlPort");
    expect(startInput).not.toHaveProperty("heartbeatIntervalMs");
    expect(startInput).not.toHaveProperty("traceparent");
    expect(startInput.execution).not.toHaveProperty("configRevision");
    expect(startInput.execution).toHaveProperty("run");
    expect(startInput.execution.session).not.toHaveProperty("context");
    expect(startInput.execution.session).toHaveProperty("sharedRootPath");
  });

  test("starts a backend and dispatches runtime commands without process transport", async () => {
    const backend = createBackend();
    const kernel = new AgentDriverKernelCore({
      backendFactory: async () => backend,
    });

    await kernel.start(bootPayload);
    const result = await kernel.dispatch({
      commandId: "input-1",
      input: {
        text: "hello",
      },
      kind: "input.start",
      requestId: "request-1",
      runId: DRIVER_TEST_IDS.runId,
    });
    await kernel.stop("test.stop");

    expect(result).toEqual({
      requestId: "request-1",
    });
    expect(backend.handledInputs).toHaveLength(1);
  });

  test("exposes provider events through the kernel event stream", async () => {
    const backend = createBackend();
    const event: DriverEventInput = {
      kind: "message.started",
      payload: {
        messageId: "message-1",
        role: "agent",
      },
    };
    backend.handleInput = async (context: AgentDriverContext) => {
      await context.ports.eventSink.pushEvents({ events: [event] });
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: async () => backend,
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

    await expect(events.next()).resolves.toEqual({
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
    const kernel = new AgentDriverKernelCore({
      backendFactory: async () => backend,
    });

    await kernel.start(bootPayload);
    await kernel.cancel("test.cancel");
    await kernel.stop("test.stop");

    expect(backend.cancelledReasons).toEqual(["test.cancel"]);
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
      const result = await context.ports.mcp.execute({
        argumentsJson: '{"ok":true}',
        commandId: "mcp-port-1",
        kind: "mcp.execute",
        requestId: "request-1",
        serverId: "server-1",
        toolName: "complete",
      });
      mcpOutput = result.outputText;
    };
    const kernel = new AgentDriverKernelCore({
      backendFactory: async () => backend,
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
