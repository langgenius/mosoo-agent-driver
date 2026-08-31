import { describe, expect, test } from "bun:test";

import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import type { DriverEventInput } from "../src/protocol/events";
import { OpenAiAppServerEventBridge } from "../src/runtimes/openai/app-server-event-bridge";
import { parseServerNotification } from "../src/runtimes/openai/app-server-protocol-server";
import { OpenAiTurnTracker } from "../src/runtimes/openai/app-server-turn-tracker";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import {
  createOpenAiBridgeHarness as createHarness,
  readEventPayloadString,
} from "./openai-app-server-event-bridge-fixture";

async function handleOfficialNotification(
  bridge: OpenAiAppServerEventBridge,
  context: AgentDriverContext,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  const notification = parseServerNotification({ method, params });

  expect(notification).not.toBeNull();
  if (notification === null) {
    throw new Error(`Expected ${method} to be an official OpenAI notification.`);
  }

  await bridge.handleNotification(context, notification.method, notification.params);
}

describe("OpenAi app-server event bridge", () => {
  test("keeps bounded provider identities stable across lifecycle boundaries", () => {
    const { bridge } = createHarness();
    const nativeId = "native".repeat(100);
    const publicItemId = bridge.mapToolCallId(nativeId);
    const publicTurnId = bridge.publicTurnId(nativeId);

    bridge.clearActiveTurns();

    for (const candidate of [bridge, createHarness().bridge]) {
      expect(candidate.mapToolCallId(nativeId)).toBe(publicItemId);
      expect(candidate.publicTurnId(nativeId)).toBe(publicTurnId);
    }
    expect(publicItemId).not.toBe(publicTurnId);
    expect(publicItemId).toBe("rid1_KnwXRN9srTgnCleHSt-EmI8jC7h9g2foozL7GxrsP9o");
    expect(publicItemId.length).toBeLessThan(nativeId.length);
    expect(publicTurnId.length).toBeLessThan(nativeId.length);
    expect(bridge.mapToolCallId(`rid1_${"x".repeat(43)}`)).not.toBe(`rid1_${"x".repeat(43)}`);
    expect(bridge.mapToolCallId("\ud800".repeat(86))).not.toBe(
      bridge.mapToolCallId("\ud801".repeat(86)),
    );
  });

  test.each([
    [
      "agent message",
      async (harness: ReturnType<typeof createHarness>, itemId: string, turnId: string) =>
        harness.bridge.handleNotification(harness.context, "item/completed", {
          item: { id: itemId, text: "stable reply", type: "agentMessage" },
          threadId: "thread-1",
          turnId,
        }),
    ],
    [
      "reasoning",
      async (harness: ReturnType<typeof createHarness>, itemId: string, turnId: string) =>
        harness.bridge.handleNotification(harness.context, "item/reasoning/summaryTextDelta", {
          delta: "stable thought",
          itemId,
          summaryIndex: 0,
          threadId: "thread-1",
          turnId,
        }),
    ],
    [
      "tool",
      async (harness: ReturnType<typeof createHarness>, itemId: string, turnId: string) =>
        harness.bridge.handleNotification(harness.context, "item/started", {
          item: { id: itemId, status: "inProgress", type: "commandExecution" },
          threadId: "thread-1",
          turnId,
        }),
    ],
  ] as const)("keeps complete oversized %s replay events stable", async (_kind, replay) => {
    const itemId = `item-${"i".repeat(300)}`;
    const turnId = `turn-${"t".repeat(300)}`;
    const attempts: DriverEventInput[][] = [];

    for (let generation = 0; generation < 2; generation += 1) {
      const harness = createHarness();
      await replay(harness, itemId, turnId);
      attempts.push(harness.events());
    }

    expect(attempts[0]?.length).toBeGreaterThan(0);
    expect(attempts[1]).toEqual(attempts[0]);
  });

  test("keeps item messages and synthetic tool parents independent of notification order", async () => {
    const project = async (order: readonly ("message" | "tool")[]) => {
      const harness = createHarness();

      for (const kind of order) {
        if (kind === "message") {
          await harness.bridge.handleNotification(harness.context, "item/completed", {
            item: { id: "message-1", text: "reply", type: "agentMessage" },
            threadId: "thread-1",
            turnId: "turn-1",
          });
        } else {
          await harness.bridge.handleNotification(harness.context, "item/started", {
            item: { id: "tool-1", status: "inProgress", type: "commandExecution" },
            threadId: "thread-1",
            turnId: "turn-1",
          });
        }
      }

      const message = harness.events().find((event) => event.kind === "message.added");
      const tool = harness
        .events()
        .find(
          (event) =>
            event.kind === "item.started" &&
            readEventPayloadString(event, "itemType") === "tool_call",
        );
      return {
        messageId: message === undefined ? null : readEventPayloadString(message, "messageId"),
        toolParentId: tool === undefined ? null : readEventPayloadString(tool, "parentMessageId"),
      };
    };

    const messageFirst = await project(["message", "tool"]);
    const toolFirst = await project(["tool", "message"]);

    expect(toolFirst).toEqual(messageFirst);
    expect(toolFirst.messageId).not.toBe(toolFirst.toolParentId);
  });

  test("separates provider tuples and lone-surrogate identities", async () => {
    const identities: Array<readonly [string | null, string | undefined, string | undefined]> = [];

    for (const [turnId, itemId] of [
      ["a", "b:c"],
      ["a:b", "c"],
      ["unicode", "\ud800".repeat(86)],
      ["unicode", "\ud801".repeat(86)],
    ]) {
      const harness = createHarness();
      await harness.bridge.handleNotification(harness.context, "item/completed", {
        item: { id: itemId, text: "reply", type: "agentMessage" },
        threadId: "thread-1",
        turnId,
      });
      const started = harness.events().find((event) => event.kind === "message.started");
      const added = harness.events().find((event) => event.kind === "message.added");
      const toolHarness = createHarness();
      await toolHarness.bridge.handleNotification(toolHarness.context, "item/started", {
        item: { id: itemId, status: "inProgress", type: "commandExecution" },
        threadId: "thread-1",
        turnId,
      });
      identities.push([
        started === undefined ? null : readEventPayloadString(started, "messageId"),
        added?.sourceEventId,
        toolHarness.events().find((event) => event.kind === "item.started")?.sourceEventId,
      ]);
    }

    expect(new Set(identities.map(([messageId]) => messageId)).size).toBe(identities.length);
    expect(new Set(identities.map(([, sourceEventId]) => sourceEventId)).size).toBe(
      identities.length,
    );
    expect(new Set(identities.map(([, , sourceEventId]) => sourceEventId)).size).toBe(
      identities.length,
    );
    expect(identities[0]).toEqual([
      "10DF94GHQDTF5928TMBEZSWHQ4",
      "openai.item.completed:sid1_U4oWh4UGZEw808sI5zy0_aOCd0-dwfUwV07Mia3XjNA:0",
      "openai.item.started:sid1_0MMp18iqK51t_lCY7b8CZMB4CuwCFtDacjitEs2EkVE",
    ]);
  });

  test("bounds terminal turn deduplication and clears it on shutdown", () => {
    const tracker = new OpenAiTurnTracker();

    for (let index = 0; index <= 1_024; index += 1) {
      tracker.settle(`turn-${index}`, { kind: "completed" });
    }

    expect(tracker.hasTerminal("turn-0")).toBe(false);
    expect(tracker.hasTerminal("turn-1")).toBe(true);
    expect(tracker.markTurnStarted("turn-1")).toBe(false);

    tracker.clearActiveTurns();
    expect(tracker.hasTerminal("turn-1")).toBe(false);
  });

  test("treats rejected turns as terminal", async () => {
    const tracker = new OpenAiTurnTracker();
    const tracked = tracker.track("turn-1", DRIVER_TEST_IDS.runId);

    tracker.rejectTurn("turn-1", new Error("cancelled"));

    await expect(tracked).rejects.toThrow("cancelled");
    await expect(tracker.track("turn-1", DRIVER_TEST_IDS.runId)).rejects.toThrow("cancelled");
    expect(tracker.hasTerminal("turn-1")).toBe(true);
    expect(tracker.markTurnStarted("turn-1")).toBe(false);
  });

  test("rejects active waiters when teardown interrupts terminal settlement", async () => {
    const tracker = new OpenAiTurnTracker();
    const tracked = tracker.track("turn-1", DRIVER_TEST_IDS.runId);

    expect(tracker.beginSettlement("turn-1")).toBe(true);
    expect(tracker.activeRunId("turn-1")).toBeNull();
    tracker.rejectActiveTurns(new Error("driver stopped"));

    await expect(tracked).rejects.toThrow("driver stopped");
    expect(tracker.hasTerminal("turn-1")).toBe(true);
  });

  test("rejects settling turns with bounded retained identities", async () => {
    const tracker = new OpenAiTurnTracker();
    const turnId = "turn".repeat(150_000);
    const tracked = tracker.track(turnId, DRIVER_TEST_IDS.runId);

    expect(tracker.beginSettlement(turnId)).toBe(true);
    tracker.rejectActiveTurns(new Error("driver stopped"));

    await expect(tracked).rejects.toThrow("driver stopped");
    expect(tracker.activeTurnIds()).toEqual([]);
    expect(tracker.hasTerminal(turnId)).toBe(true);
  });

  test("shares duplicate turn tracking without orphaning the first waiter", async () => {
    const tracker = new OpenAiTurnTracker();
    const first = tracker.track("turn-1", DRIVER_TEST_IDS.runId);
    const duplicate = tracker.track("turn-1", DRIVER_TEST_IDS.runId);

    await expect(tracker.track("turn-1", DRIVER_TEST_IDS.secondRunId)).rejects.toThrow(
      "another run",
    );
    tracker.settle("turn-1", { kind: "completed" });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([undefined, undefined]);
  });

  test("closes visible message, tool, and run state when a turn is cancelled", async () => {
    const { bridge, context, events } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "item/started", {
      item: {
        id: "tool-1",
        status: "inProgress",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.cancelTurn(context, "turn-1", "test.cancel");

    await expect(trackedTurn).rejects.toThrow("test.cancel");
    expect(events()).toMatchObject([
      { kind: "message.started" },
      { kind: "item.started" },
      { kind: "tool.call.updated", payload: { status: "running", toolCallId: "tool-1" } },
      { kind: "agent.tasks.replaced", payload: { tasks: [] } },
      { kind: "run.cancel.requested", runId: DRIVER_TEST_IDS.runId },
      { kind: "message.cancelled" },
      { kind: "tool.call.updated", payload: { status: "cancelled", toolCallId: "tool-1" } },
      { kind: "item.completed", payload: { itemId: "tool-1", status: "cancelled" } },
      { kind: "run.cancelled", runId: DRIVER_TEST_IDS.runId },
    ]);
    const terminalEventCount = events().length;

    await bridge.handleNotification(context, "item/completed", {
      item: {
        aggregatedOutput: "late",
        id: "tool-1",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(events()).toHaveLength(terminalEventCount);
  });

  test("accepts only a completed sub-agent activity after its parent turn terminal", async () => {
    const { bridge, context, events } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "completed" },
    });
    await trackedTurn;
    const terminalEventCount = events().length;

    await bridge.handleNotification(context, "item/completed", {
      item: {
        agentPath: "/root/worker",
        agentThreadId: "agent-1",
        id: "activity-1",
        kind: "completed",
        type: "subAgentActivity",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(events().slice(terminalEventCount)).toEqual([
      {
        delivery: "lossless",
        kind: "agent.task.updated",
        payload: {
          active: false,
          activityKind: "completed",
          agentId: "agent-1",
          agentPath: "/root/worker",
          status: "completed",
          taskId: "agent-1",
          title: "Sub-agent completed",
        },
        sourceEventId: "openai.derived:sid1_kECA0eVWvzfAvIr0LN7vWra6VGTB8rTQoAgf7EHr7Rg",
      },
    ]);

    await bridge.handleNotification(context, "item/completed", {
      item: { id: "late-message", text: "late", type: "agentMessage" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(events()).toHaveLength(terminalEventCount + 1);
  });

  test("closes open item state when the provider interrupts a turn", async () => {
    const { bridge, context, events } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "item/started", {
      item: { id: "tool-1", status: "inProgress", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted" },
    });

    await expect(trackedTurn).rejects.toThrow("interrupted");
    expect(events().slice(-4)).toMatchObject([
      { kind: "message.cancelled" },
      { kind: "tool.call.updated", payload: { status: "cancelled", toolCallId: "tool-1" } },
      { kind: "item.completed", payload: { itemId: "tool-1", status: "cancelled" } },
      {
        kind: "run.cancelled",
        payload: { requestedBy: "provider", stopReason: "cancelled" },
        runId: DRIVER_TEST_IDS.runId,
      },
    ]);
  });

  test("closes open item state before a failed turn", async () => {
    const { bridge, context, events } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "item/started", {
      item: { id: "tool-1", status: "inProgress", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        error: { additionalDetails: null, codexErrorInfo: null, message: "command failed" },
        id: "turn-1",
        status: "failed",
      },
    });

    await expect(trackedTurn).rejects.toThrow("command failed");
    expect(events().slice(-4)).toMatchObject([
      {
        kind: "message.failed",
        payload: {
          error: { code: "openai.turn_failed", message: "command failed", retryable: false },
        },
      },
      { kind: "tool.call.updated", payload: { status: "failed", toolCallId: "tool-1" } },
      { kind: "item.completed", payload: { itemId: "tool-1", status: "failed" } },
      { kind: "run.failed", runId: DRIVER_TEST_IDS.runId },
    ]);
  });

  test("closes open item state before a successful turn without loaded items", async () => {
    const { bridge, context, events } = createHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await bridge.handleNotification(context, "item/started", {
      item: { id: "tool-1", status: "inProgress", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "completed" },
    });

    await expect(trackedTurn).resolves.toBeUndefined();
    const terminalIndex = events().findIndex((event) => event.kind === "run.completed");
    expect(events().slice(terminalIndex - 3, terminalIndex + 1)).toMatchObject([
      { kind: "message.completed" },
      { kind: "tool.call.updated", payload: { status: "completed", toolCallId: "tool-1" } },
      { kind: "item.completed", payload: { itemId: "tool-1", status: "completed" } },
      { kind: "run.completed", runId: DRIVER_TEST_IDS.runId },
    ]);
  });

  test("drains pending item delivery before cancellation and leaves the next turn clean", async () => {
    const harness = createHarness({ holdReason: "driver.openai.item.completed" });
    const trackedTurn = harness.bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);

    await harness.bridge.handleNotification(harness.context, "item/started", {
      item: { id: "tool-1", status: "inProgress", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const completion = harness.bridge.handleNotification(harness.context, "item/completed", {
      item: {
        aggregatedOutput: "done",
        id: "tool-1",
        status: "completed",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await harness.heldPush;
    const cancellation = harness.bridge.cancelTurn(
      harness.context,
      "turn-1",
      "test.cancel",
      async () => completion,
    );
    let cancellationSettled = false;
    void cancellation.finally(() => {
      cancellationSettled = true;
    });
    await Promise.resolve();
    expect(cancellationSettled).toBe(false);
    harness.releasePush();
    await cancellation;

    await expect(trackedTurn).rejects.toThrow("test.cancel");
    await expect(harness.bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId)).rejects.toThrow(
      "test.cancel",
    );
    expect(
      harness
        .events()
        .filter((event) => ["run.cancelled", "run.completed", "run.failed"].includes(event.kind)),
    ).toMatchObject([{ kind: "run.cancelled", runId: DRIVER_TEST_IDS.runId }]);

    const nextTurn = harness.bridge.trackTurn("turn-2", DRIVER_TEST_IDS.secondRunId);
    await harness.bridge.handleNotification(harness.context, "item/started", {
      item: { id: "tool-1", status: "inProgress", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-2",
    });
    await harness.bridge.handleNotification(harness.context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", items: [], itemsView: "notLoaded", status: "completed" },
    });
    await expect(nextTurn).resolves.toBeUndefined();
    expect(
      harness
        .events()
        .filter(
          (event) =>
            event.kind === "item.started" && readEventPayloadString(event, "itemId") === "tool-1",
        ),
    ).toHaveLength(2);
  });

  test.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["declined", "failed"],
  ] as const)("maps completed native tool status %s to %s", async (nativeStatus, status) => {
    const { bridge, context, events } = createHarness();

    await bridge.handleNotification(context, "item/completed", {
      item: {
        aggregatedOutput: "output",
        id: "tool-1",
        status: nativeStatus,
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(
      events()
        .filter((event) => event.kind === "tool.call.updated")
        .map((event) => readEventPayloadString(event, "status")),
    ).toEqual(["running", status]);
    expect(events().find((event) => event.kind === "item.completed")?.payload).toMatchObject({
      status,
    });
  });

  test("replays an item completion after delivery rejection before committing state", async () => {
    const harness = createHarness({ failReasonOnce: "driver.openai.item.completed" });
    const notification = {
      item: {
        id: "message-1",
        phase: "final_answer",
        text: "authoritative answer",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    } as const;

    await expect(
      harness.bridge.handleNotification(harness.context, "item/completed", notification),
    ).rejects.toThrow("first attempt");
    await harness.bridge.handleNotification(harness.context, "item/completed", notification);
    await harness.bridge.handleNotification(harness.context, "item/completed", notification);

    const attempts = harness.attempts.filter(
      ({ reason }) => reason === "driver.openai.item.completed",
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.events.map(({ sourceEventId }) => sourceEventId)).toEqual(
      attempts[1]!.events.map(({ sourceEventId }) => sourceEventId),
    );
    expect(
      harness
        .events()
        .filter((event) => event.kind === "message.added" || event.kind === "message.completed"),
    ).toHaveLength(2);
  });

  test("replays a full task snapshot before committing its active set", async () => {
    const harness = createHarness({ failReasonOnce: "driver.openai.item.completed" });
    const nativeTaskId = "agent".repeat(100);
    const notification = {
      item: {
        agentPath: "/root/worker",
        agentThreadId: nativeTaskId,
        id: "activity-1",
        kind: "started",
        type: "subAgentActivity",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    } as const;

    await expect(
      harness.bridge.handleNotification(harness.context, "item/completed", notification),
    ).rejects.toThrow("first attempt");
    await harness.bridge.handleNotification(harness.context, "item/completed", notification);
    await harness.bridge.handleNotification(harness.context, "item/completed", notification);

    const attempts = harness.attempts.filter(
      ({ reason }) => reason === "driver.openai.item.completed",
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.events).toEqual(attempts[1]!.events);
    const taskUpdate = harness.events().find((event) => event.kind === "agent.task.updated");
    const taskSnapshot = harness.events().find((event) => event.kind === "agent.tasks.replaced");
    const taskId = taskUpdate === undefined ? null : readEventPayloadString(taskUpdate, "taskId");
    expect(taskId).toMatch(/^rid1_[A-Za-z0-9_-]{43}$/);
    expect(taskUpdate === undefined ? null : readEventPayloadString(taskUpdate, "agentId")).toBe(
      taskId,
    );
    expect(taskSnapshot).toMatchObject({
      payload: { tasks: [{ taskId }] },
    });
  });

  test("bounds collaboration thread identities consistently", async () => {
    const harness = createHarness();
    const nativeThreadId = `agent-${"a".repeat(300)}`;

    await harness.bridge.handleNotification(harness.context, "item/completed", {
      item: {
        agentsStates: { [nativeThreadId]: { message: "done", status: "completed" } },
        id: "collab-1",
        model: null,
        prompt: null,
        reasoningEffort: null,
        receiverThreadIds: [nativeThreadId],
        senderThreadId: nativeThreadId,
        status: "completed",
        tool: "wait",
        type: "collabAgentToolCall",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const terminal = harness
      .events()
      .find(
        (event) =>
          event.kind === "tool.call.updated" &&
          readEventPayloadString(event, "status") === "completed",
      );
    const agentId = terminal === undefined ? null : readEventPayloadString(terminal, "agentId");
    const structuredOutput =
      terminal?.payload !== null &&
      typeof terminal?.payload === "object" &&
      !Array.isArray(terminal.payload)
        ? (terminal.payload as Record<string, unknown>)["structuredOutput"]
        : null;

    expect(agentId).toMatch(/^rid1_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(structuredOutput)).not.toContain(nativeThreadId);
    expect(structuredOutput).toMatchObject({
      agentsStates: { [agentId!]: { message: "done", status: "completed" } },
      receiverThreadIds: [agentId],
      senderThreadId: agentId,
    });
  });

  test("replays a plan delta after delivery rejection without duplicating content", async () => {
    const harness = createHarness({ failReasonOnce: "driver.openai.plan.delta" });
    const notification = {
      delta: "step",
      itemId: "plan-1",
      threadId: "thread-1",
      turnId: "turn-1",
    } as const;

    await expect(
      harness.bridge.handleNotification(harness.context, "item/plan/delta", notification),
    ).rejects.toThrow("first attempt");
    await harness.bridge.handleNotification(harness.context, "item/plan/delta", notification);

    await harness.bridge.handleNotification(harness.context, "item/plan/delta", {
      ...notification,
      delta: " two",
    });

    const accepted = harness.batches.filter((batch) => batch.reason === "driver.openai.plan.delta");
    expect(accepted.at(-1)?.events[0]?.payload).toMatchObject({
      entries: [{ content: "step two", status: "in_progress" }],
    });
    expect(accepted.every((batch) => batch.events[0]?.sourceEventId === undefined)).toBe(true);
    expect(JSON.stringify(accepted)).not.toContain("stepstep");
  });

  test("does not invent cross-process occurrence IDs for unsequenced provider updates", async () => {
    const planHarness = createHarness();
    for (const step of ["A", "B", "A"]) {
      await planHarness.bridge.handleNotification(planHarness.context, "turn/plan/updated", {
        explanation: null,
        plan: [{ status: "inProgress", step }],
        threadId: "thread-1",
        turnId: "turn-1",
      });
    }
    const planEvents = planHarness.events().filter((event) => event.kind === "plan.updated");
    expect(planEvents.map((event) => event.sourceEventId)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    const reasoningHarness = createHarness();
    for (const delta of ["same", "same"]) {
      await reasoningHarness.bridge.handleNotification(
        reasoningHarness.context,
        "item/reasoning/summaryTextDelta",
        {
          delta,
          itemId: "reasoning-1",
          summaryIndex: 0,
          threadId: "thread-1",
          turnId: "turn-1",
        },
      );
    }
    const reasoningDeltas = reasoningHarness
      .events()
      .filter((event) => event.kind === "thought.delta");
    expect(reasoningDeltas.map((event) => event.sourceEventId)).toEqual([undefined, undefined]);
    expect(reasoningDeltas.map((event) => readEventPayloadString(event, "contentDelta"))).toEqual([
      "same",
      "same",
    ]);
  });

  test("retries message start with the same identity after delivery rejection", async () => {
    const harness = createHarness({ failReasonOnce: "driver.openai.message.started" });
    const notification = {
      delta: "hello",
      itemId: "message-1",
      threadId: "thread-1",
      turnId: "turn-1",
    } as const;

    await expect(
      harness.bridge.handleNotification(harness.context, "item/agentMessage/delta", notification),
    ).rejects.toThrow("first attempt");
    await harness.bridge.handleNotification(
      harness.context,
      "item/agentMessage/delta",
      notification,
    );

    const attempts = harness.attempts.filter(
      ({ reason }) => reason === "driver.openai.message.started",
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.events[0]?.sourceEventId).toBe(attempts[1]!.events[0]?.sourceEventId);
    expect(harness.events().filter((event) => event.kind === "message.started")).toHaveLength(1);
    expect(
      harness
        .events()
        .filter((event) => event.kind === "message.delta")
        .map((event) => readEventPayloadString(event, "contentDelta")),
    ).toEqual(["hello"]);
  });

  test("replays terminal closures after rejection before settling the turn", async () => {
    const harness = createHarness({ failTerminalOnce: true });
    const trackedTurn = harness.bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    await harness.bridge.handleNotification(harness.context, "item/started", {
      item: { id: "tool-1", status: "inProgress", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const completion = {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "completed" },
    } as const;

    await expect(
      harness.bridge.handleNotification(harness.context, "turn/completed", completion),
    ).rejects.toThrow("first attempt");
    await harness.bridge.handleNotification(harness.context, "turn/completed", completion);
    await expect(trackedTurn).resolves.toBeUndefined();

    expect(harness.terminalAttempts).toHaveLength(2);
    expect(harness.terminalAttempts[0]!.closures).toEqual(harness.terminalAttempts[1]!.closures);
    expect(
      harness
        .events()
        .filter((event) => event.kind === "tool.call.updated")
        .map((event) => readEventPayloadString(event, "status")),
    ).toEqual(["running", "completed"]);
    expect(harness.events().filter((event) => event.kind === "run.completed")).toHaveLength(1);
  });

  test("replays cancellation closures after rejection before rejecting the turn", async () => {
    const harness = createHarness({ failTerminalOnce: true });
    const trackedTurn = harness.bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    await harness.bridge.handleNotification(harness.context, "item/started", {
      item: { id: "tool-1", status: "inProgress", type: "commandExecution" },
      threadId: "thread-1",
      turnId: "turn-1",
    });

    await expect(
      harness.bridge.cancelTurn(harness.context, "turn-1", "test.cancel"),
    ).rejects.toThrow("first attempt");
    await harness.bridge.cancelTurn(harness.context, "turn-1", "test.cancel");
    await expect(trackedTurn).rejects.toThrow("test.cancel");

    expect(harness.terminalAttempts).toHaveLength(2);
    expect(harness.terminalAttempts[0]!.closures).toEqual(harness.terminalAttempts[1]!.closures);
    expect(harness.events().filter((event) => event.kind === "run.cancelled")).toHaveLength(1);
  });

  test("waits for a failed concurrent settlement before claiming cancellation", async () => {
    const harness = createHarness({ failTerminalOnce: true, holdFailedTerminalOnce: true });
    const trackedTurn = harness.bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    const completion = harness.bridge.handleNotification(harness.context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "completed" },
    });
    void completion.catch(() => {});
    await harness.terminalHeld;
    let drained = false;
    const cancellation = harness.bridge.cancelTurn(
      harness.context,
      "turn-1",
      "test.cancel",
      async () => {
        await completion.catch(() => {});
        drained = true;
      },
    );

    await Promise.resolve();
    expect(drained).toBe(false);
    harness.releaseTerminal();
    await expect(completion).rejects.toThrow("first attempt");
    await cancellation;
    await expect(trackedTurn).rejects.toThrow("test.cancel");
    expect(drained).toBe(true);
    expect(harness.terminalAttempts.map(({ terminal }) => terminal.kind)).toEqual([
      "run.completed",
      "run.cancelled",
    ]);
  });

  test("orders cancellation after an in-flight item update", async () => {
    const { bridge, context, events, heldPush, releasePush } = createHarness({
      holdReason: "driver.openai.message.started",
    });
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    const itemUpdate = bridge.handleNotification(context, "item/started", {
      item: {
        id: "tool-1",
        status: "inProgress",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await heldPush;
    const cancellation = bridge.cancelTurn(
      context,
      "turn-1",
      "test.cancel",
      async () => itemUpdate,
    );

    releasePush();
    await Promise.all([cancellation, itemUpdate]);
    await expect(trackedTurn).rejects.toThrow("test.cancel");
    expect(events().at(-1)?.kind).toBe("run.cancelled");
    expect(
      events().findLastIndex(
        (event) =>
          event.kind === "tool.call.updated" &&
          readEventPayloadString(event, "status") === "running",
      ),
    ).toBeLessThan(events().findLastIndex((event) => event.kind === "run.cancelled"));
  });

  test("maps hooks and automatic approval reviews to their exact lifecycle events", async () => {
    const { bridge, context, events } = createHarness();

    const hookRun = {
      displayOrder: 0,
      entries: [],
      eventName: "interrupt",
      executionMode: "sync",
      handlerType: "command",
      id: "hook-1",
      scope: "turn",
      sourcePath: "/tmp/hook",
      startedAt: 1,
    };
    const action = { command: "echo ok", cwd: "/tmp", source: "shell", type: "command" };

    await handleOfficialNotification(bridge, context, "hook/started", {
      run: { ...hookRun, status: "running" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await handleOfficialNotification(bridge, context, "hook/completed", {
      run: { ...hookRun, completedAt: 2, durationMs: 1, status: "completed" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await handleOfficialNotification(bridge, context, "item/autoApprovalReview/started", {
      action,
      review: { status: "inProgress" },
      reviewId: "review-1",
      startedAtMs: 1,
      targetItemId: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await handleOfficialNotification(bridge, context, "item/autoApprovalReview/completed", {
      action,
      completedAtMs: 2,
      decisionSource: "agent",
      review: { riskLevel: "low", status: "approved", userAuthorization: "high" },
      reviewId: "review-1",
      startedAtMs: 1,
      targetItemId: "tool-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(events().map((event) => event.kind)).toEqual([
      "hook.started",
      "hook.completed",
      "permission.review.started",
      "permission.review.completed",
    ]);
    expect(events()[2]?.payload).toMatchObject({ reviewId: "review-1", targetItemId: "tool-1" });
  });

  test("preserves bounded permission profiles in automatic approval reviews", async () => {
    const { bridge, context, events } = createHarness();
    const permissions = {
      fileSystem: { read: ["/workspace"], write: ["/tmp"] },
      network: { enabled: true },
    };

    await handleOfficialNotification(bridge, context, "item/autoApprovalReview/started", {
      action: { permissions, reason: "Inspect generated files", type: "requestPermissions" },
      review: { status: "inProgress" },
      reviewId: "review-permissions",
      startedAtMs: 1,
      targetItemId: null,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(events()[0]?.payload).toMatchObject({
      action: {
        permissions,
        reason: "Inspect generated files",
        type: "requestPermissions",
      },
    });

    await handleOfficialNotification(bridge, context, "item/autoApprovalReview/started", {
      action: {
        approvalId: "approval-1",
        cwd: "/workspace",
        processId: "process-1",
        stdin: "secret input\n",
        type: "writeStdin",
      },
      review: { status: "inProgress" },
      reviewId: "review-stdin",
      startedAtMs: 2,
      targetItemId: "command-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(events()[1]?.payload).toMatchObject({
      action: {
        approvalId: "approval-1",
        cwd: "/workspace",
        processId: "process-1",
        stdinUtf8Bytes: 13,
        type: "writeStdin",
      },
    });
    await handleOfficialNotification(bridge, context, "item/autoApprovalReview/completed", {
      action: {
        approvalId: "approval-1",
        cwd: "/workspace",
        processId: "process-1",
        stdin: "secret input\n",
        type: "writeStdin",
      },
      completedAtMs: 3,
      decisionSource: "agent",
      review: {
        rationale: "The terminal input contains secret input",
        riskLevel: "high",
        status: "denied",
        userAuthorization: "high",
      },
      reviewId: "review-stdin",
      startedAtMs: 2,
      targetItemId: "command-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(events()[2]?.payload).toMatchObject({
      review: { riskLevel: "high", status: "denied", userAuthorization: "high" },
    });
    expect(JSON.stringify(events().slice(1))).not.toContain("secret input");
  });

  test("keeps mapped MCP progress and terminal interaction visible", async () => {
    const { bridge, context, events } = createHarness();
    const nativeItemId = `mcp-${"x".repeat(300)}`;
    const nativeCommandId = `command-${"y".repeat(300)}`;

    await handleOfficialNotification(bridge, context, "item/mcpToolCall/progress", {
      itemId: "unknown-mcp",
      message: "ignored",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(events()).toEqual([]);
    await handleOfficialNotification(bridge, context, "item/started", {
      item: {
        arguments: { path: "src" },
        id: nativeItemId,
        server: "filesystem",
        status: "inProgress",
        tool: "inspect",
        type: "mcpToolCall",
      },
      startedAtMs: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const publicToolCallId = readEventPayloadString(
      events().find((event) => event.kind === "item.started")!,
      "itemId",
    );
    expect(publicToolCallId).not.toBeNull();
    expect(publicToolCallId).not.toBe(nativeItemId);

    await handleOfficialNotification(bridge, context, "item/mcpToolCall/progress", {
      itemId: nativeItemId,
      message: "Reading project files",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await handleOfficialNotification(bridge, context, "item/commandExecution/terminalInteraction", {
      itemId: "unknown-command",
      processId: "process-1",
      stdin: "ignored\n",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(events().some((event) => event.kind === "shell.command.updated")).toBe(false);
    await handleOfficialNotification(bridge, context, "item/started", {
      item: {
        aggregatedOutput: null,
        command: "printf done",
        commandActions: [],
        cwd: "/workspace",
        durationMs: null,
        exitCode: null,
        id: nativeCommandId,
        pluginId: null,
        processId: null,
        scriptPath: null,
        source: "agent",
        status: "inProgress",
        type: "commandExecution",
      },
      startedAtMs: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const publicCommandId = readEventPayloadString(
      events()
        .filter((event) => event.kind === "item.started")
        .at(-1)!,
      "itemId",
    );
    expect(publicCommandId).not.toBe(nativeCommandId);
    await handleOfficialNotification(bridge, context, "item/commandExecution/terminalInteraction", {
      itemId: nativeCommandId,
      processId: "process-1",
      stdin: "y\n",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(
      events().find(
        (event) =>
          event.kind === "tool.call.updated" &&
          readEventPayloadString(event, "rawOutput") === "Reading project files",
      ),
    ).toMatchObject({
      delivery: "best_effort",
      payload: {
        status: "running",
        toolCallId: publicToolCallId,
      },
    });
    expect(events().at(-1)).toMatchObject({
      delivery: "best_effort",
      kind: "shell.command.updated",
      payload: {
        itemId: publicCommandId,
        processId: "process-1",
        status: "running",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(JSON.stringify(events())).not.toContain("y\\n");
  });

  test("publishes model, MCP server, and user-facing warning notifications", async () => {
    const { bridge, context, events } = createHarness();

    await handleOfficialNotification(bridge, context, "mcpServer/startupStatus/updated", {
      error: null,
      failureReason: null,
      name: "filesystem",
      status: "ready",
      threadId: "thread-1",
    });
    await handleOfficialNotification(bridge, context, "model/rerouted", {
      fromModel: "gpt-a",
      reason: "highRiskCyberActivity",
      threadId: "thread-1",
      toModel: "gpt-b",
      turnId: "turn-1",
    });
    await handleOfficialNotification(bridge, context, "model/verification", {
      threadId: "thread-1",
      turnId: "turn-1",
      verifications: [],
    });
    await handleOfficialNotification(bridge, context, "model/safetyBuffering/updated", {
      fasterModel: null,
      model: "gpt-b",
      reasons: ["policy"],
      showBufferingUi: true,
      threadId: "thread-1",
      turnId: "turn-1",
      useCases: ["agent"],
    });
    await handleOfficialNotification(bridge, context, "warning", {
      message: "Provider warning",
      threadId: "thread-1",
    });
    await handleOfficialNotification(bridge, context, "guardianWarning", {
      message: "Guardian warning",
      threadId: "thread-1",
    });
    await handleOfficialNotification(bridge, context, "windows/worldWritableWarning", {
      extraCount: 2,
      failedScan: true,
      samplePaths: ["C:\\unsafe-one", "C:\\unsafe-two"],
    });

    expect(events().map((event) => event.kind)).toEqual([
      "mcp.server.updated",
      "model.routing.updated",
      "model.verification.updated",
      "model.routing.updated",
      "message.added",
      "message.added",
      "message.added",
    ]);
    expect(
      events()
        .slice(-3)
        .map((event) => event.payload),
    ).toMatchObject([
      { content: "Provider warning", level: "warning" },
      { content: "Guardian warning", level: "warning" },
      {
        extraCount: 2,
        failedScan: true,
        level: "warning",
        samplePaths: ["C:\\unsafe-one", "C:\\unsafe-two"],
        subtype: "windows_world_writable_warning",
      },
    ]);
    const worldWritableContent = readEventPayloadString(events().at(-1)!, "content");
    expect(worldWritableContent).toContain("C:\\unsafe-one");
    expect(worldWritableContent).toContain("2 additional affected paths");
    expect(worldWritableContent).toContain("scan did not complete");
  });
});
