import { describe, expect, test } from "bun:test";

import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import type { AgentDriverPermissionPort, DriverPermissionRequest } from "../src/host-ports";
import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-instance-socket";
import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import { DriverEventPublisher } from "../src/runtimes/driver-event-publisher";
import { OpenAiAppServerEventBridge } from "../src/runtimes/openai/app-server-event-bridge";
import {
  parseServerNotification,
  parseServerRequest,
} from "../src/runtimes/openai/app-server-protocol-server";
import { OpenAiAppServerRequestHandler } from "../src/runtimes/openai/app-server-request-handler";
import { createCmaMemoryStore } from "../src/stores/memory";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import { driverBootPayload, driverStartInput as bootPayload } from "./driver-boot-payload-fixture";
import {
  createOpenAiBridgeHarness as createHarness,
  readAssistantMessageId,
  readEventPayloadString,
} from "./openai-app-server-event-bridge-fixture";

function expectRunFinalReferences(
  events: readonly DriverEventInput[],
  expectedContent: string,
): void {
  const terminal = events.find((event) => event.kind === "run.completed");
  const messageId =
    terminal === undefined ? null : readEventPayloadString(terminal, "finalMessageId");
  const snapshots = events.filter(
    (event) =>
      event.delivery === "lossless" &&
      readEventPayloadString(event, "messageId") === messageId &&
      (event.kind === "message.added" || event.kind === "message.delta"),
  );
  const content = snapshots
    .map((event) =>
      readEventPayloadString(event, event.kind === "message.added" ? "content" : "contentDelta"),
    )
    .join("");

  expect(terminal).toBeDefined();
  expect(messageId).not.toBeNull();
  expect(snapshots[0]?.kind).toBe("message.added");
  expect(content).toBe(expectedContent);
  expect(terminal!.payload).not.toHaveProperty("finalMessageText");
}

function createPublisherHarness(
  options: {
    partialSourcePrefix?: string;
    requestPermission?: AgentDriverPermissionPort["request"];
    threadId?: string;
  } = {},
) {
  const threadId = options.threadId ?? "thread-1";
  const delivered: DriverEventInput[] = [];
  const partialAttempts: DriverEventInput[][] = [];
  const store = createCmaMemoryStore({ sessions: [{ id: DRIVER_TEST_IDS.sessionId }] });
  let nextSeq = 1;
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "openai-app-server-event-bridge-publisher-test",
    sink: async () => {},
  });
  const context: AgentDriverContext = createAgentDriverContext({
    eventSink: {
      currentRunId: () => DRIVER_TEST_IDS.runId,
      pushEvents: async ({ events }) => {
        const partialSourcePrefix = options.partialSourcePrefix;
        const isPartialAttempt =
          partialSourcePrefix !== undefined &&
          events[0]?.sourceEventId?.startsWith(partialSourcePrefix) === true;

        if (isPartialAttempt) {
          partialAttempts.push(events);
          if (partialAttempts.length === 2) {
            throw new Error("transient snapshot delivery failure");
          }
        }

        const acceptedEvents =
          isPartialAttempt && partialAttempts.length === 1 ? events.slice(0, 1) : events;
        for (const event of acceptedEvents) {
          for (const envelope of toDriverEventEnvelopes(
            driverBootPayload,
            event,
            DRIVER_TEST_IDS.runId,
          )) {
            await store.appendDriverEvent(DRIVER_TEST_IDS.sessionId, envelope.event);
          }
        }
        delivered.push(...acceptedEvents);
        return {
          accepted: acceptedEvents.map((event) => ({
            eventId: event.sourceEventId,
            seq: nextSeq++,
            type: event.kind,
          })),
        };
      },
    },
    logger,
    payload: bootPayload,
    permission: {
      request: options.requestPermission ?? (async () => "allow_once"),
    },
  });
  const publisher = new DriverEventPublisher("openai-runtime", () => threadId);
  const bridge = new OpenAiAppServerEventBridge({
    push: (pushContext, reason, events) => publisher.push(pushContext, reason, events),
    pushSession: (pushContext, reason, events) =>
      publisher.pushSession(pushContext, reason, events),
    pushTerminal: (pushContext, reason, closures, terminal) =>
      publisher.pushTerminal(pushContext, reason, closures, terminal),
    requireThreadId: () => threadId,
  });

  return { bridge, context, delivered, logger, partialAttempts };
}

describe("OpenAi app-server event bridge", () => {
  test("reports monotonic per-turn usage from cumulative thread totals", async () => {
    const harness = createHarness();
    const trackedTurn = harness.bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    const notify = async (last: readonly number[], total: readonly number[]) => {
      const usage = (values: readonly number[]) => ({
        cacheWriteInputTokens: values[0]!,
        cachedInputTokens: values[1]!,
        inputTokens: values[2]!,
        outputTokens: values[3]!,
        reasoningOutputTokens: values[4]!,
        totalTokens: values[5]!,
      });

      await harness.bridge.handleNotification(harness.context, "thread/tokenUsage/updated", {
        threadId: "thread-1",
        tokenUsage: { last: usage(last), modelContextWindow: 200_000, total: usage(total) },
        turnId: "turn-1",
      });
    };

    await notify([3, 2, 10, 4, 1, 14], [33, 22, 110, 54, 11, 164]);
    await notify([4, 1, 3, 2, 1, 5], [37, 23, 113, 56, 12, 169]);
    await notify([1, 0, 1, 1, 0, 2], [34, 22, 111, 55, 11, 165]);

    expect(
      harness
        .events()
        .filter((event) => event.kind === "usage.updated")
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({
        cachedReadTokens: 2,
        cachedWriteTokens: 3,
        inputTokens: 10,
        outputTokens: 4,
        thoughtTokens: 1,
        totalTokens: 14,
      }),
      expect.objectContaining({
        cachedReadTokens: 3,
        cachedWriteTokens: 7,
        inputTokens: 13,
        outputTokens: 6,
        thoughtTokens: 2,
        totalTokens: 19,
      }),
    ]);
    harness.bridge.rejectTurn("turn-1", new Error("test complete"));
    await harness.logger.destroy();
  });

  test("replays usage after delivery rejection before committing its baseline", async () => {
    const harness = createHarness({ failReasonOnce: "driver.openai.usage.updated" });
    const trackedTurn = harness.bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    const params = {
      threadId: "thread-1",
      tokenUsage: {
        last: {
          cacheWriteInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 10,
          outputTokens: 4,
          reasoningOutputTokens: 1,
          totalTokens: 14,
        },
        modelContextWindow: 200_000,
        total: {
          cacheWriteInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 10,
          outputTokens: 4,
          reasoningOutputTokens: 1,
          totalTokens: 14,
        },
      },
      turnId: "turn-1",
    } as const;

    await expect(
      harness.bridge.handleNotification(harness.context, "thread/tokenUsage/updated", params),
    ).rejects.toThrow("first attempt");
    await harness.bridge.handleNotification(harness.context, "thread/tokenUsage/updated", params);

    expect(harness.events().filter((event) => event.kind === "usage.updated")).toHaveLength(1);
    harness.bridge.rejectTurn("turn-1", new Error("test complete"));
    await harness.logger.destroy();
  });

  test("attributes cumulative usage growth across turns without replaying the previous total", async () => {
    const harness = createHarness();
    const usage = (totalTokens: number) => ({
      cacheWriteInputTokens: 0,
      cachedInputTokens: 0,
      inputTokens: totalTokens,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens,
    });
    const notify = async (turnId: string, last: number, total: number) => {
      await harness.bridge.handleNotification(harness.context, "thread/tokenUsage/updated", {
        threadId: "thread-1",
        tokenUsage: {
          last: usage(last),
          modelContextWindow: 200_000,
          total: usage(total),
        },
        turnId,
      });
    };

    await notify("resume-snapshot", 20, 100);

    const turn1 = harness.bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void turn1.catch(() => {});
    await notify("turn-1", 30, 130);
    harness.bridge.rejectTurn("turn-1", new Error("turn complete"));

    const turn2 = harness.bridge.trackTurn("turn-2", DRIVER_TEST_IDS.runId);
    void turn2.catch(() => {});
    await notify("turn-2", 30, 130);
    await notify("turn-2", 30, 160);

    expect(
      harness
        .events()
        .filter((event) => event.kind === "usage.updated")
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ size: 200_000, totalTokens: 30, used: 30 }),
      expect.objectContaining({ size: 200_000, totalTokens: 30, used: 30 }),
    ]);
    harness.bridge.rejectTurn("turn-2", new Error("test complete"));
    await harness.logger.destroy();
  });

  test.each([
    ["completed", "run.completed", true],
    ["failed", "run.failed", false],
    ["cancelled", "run.cancelled", false],
  ] as const)(
    "%s turns never emit resume metadata after the terminal event",
    async (outcome, terminalKind, publishesResume) => {
      const { bridge, context, events, logger } = createHarness();
      const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
      void trackedTurn.catch(() => {});

      if (outcome === "cancelled") {
        await bridge.cancelTurn(context, "turn-1", "test.cancel");
      } else {
        await bridge.handleNotification(context, "turn/completed", {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: outcome,
          },
        });
      }

      if (outcome === "completed") {
        await expect(trackedTurn).resolves.toBeUndefined();
      } else {
        await expect(trackedTurn).rejects.toBeInstanceOf(Error);
      }

      const allEvents = events();
      const terminalIndex = allEvents.findIndex((event) => event.kind === terminalKind);
      const resumeIndexes = allEvents
        .map((event, index) => (event.kind === "runtime.resume.updated" ? index : -1))
        .filter((index) => index >= 0);

      expect(terminalIndex).toBeGreaterThanOrEqual(0);
      expect(resumeIndexes).toHaveLength(publishesResume ? 1 : 0);
      expect(resumeIndexes.every((index) => index < terminalIndex)).toBe(true);
      expect(allEvents.slice(terminalIndex + 1)).toEqual([]);
      await logger.destroy();
    },
  );

  test("drops reordered usage and diagnostics once terminal settlement starts", async () => {
    const harness = createHarness({
      holdReason: "driver.openai.native_resume_ref.updated",
    });
    const trackedTurn = harness.bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    const usage = {
      threadId: "thread-1",
      tokenUsage: {
        last: {
          cacheWriteInputTokens: 3,
          cachedInputTokens: 2,
          inputTokens: 10,
          outputTokens: 4,
          reasoningOutputTokens: 1,
          totalTokens: 14,
        },
        modelContextWindow: 200_000,
        total: {
          cacheWriteInputTokens: 3,
          cachedInputTokens: 2,
          inputTokens: 10,
          outputTokens: 4,
          reasoningOutputTokens: 1,
          totalTokens: 14,
        },
      },
      turnId: "turn-1",
    } as const;
    const diff = {
      diff: "diff --git a/file b/file",
      threadId: "thread-1",
      turnId: "turn-1",
    };

    await harness.bridge.handleNotification(harness.context, "thread/tokenUsage/updated", usage);
    await harness.bridge.handleNotification(harness.context, "turn/diff/updated", diff);
    expect(harness.events().find((event) => event.kind === "usage.updated")?.payload).toMatchObject(
      {
        cachedWriteTokens: 3,
      },
    );

    const completion = harness.bridge.handleNotification(harness.context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "notLoaded",
        status: "completed",
      },
    });
    await harness.heldPush;

    await harness.bridge.handleNotification(harness.context, "thread/tokenUsage/updated", usage);
    await harness.bridge.handleNotification(harness.context, "turn/diff/updated", diff);
    harness.releasePush();
    await completion;
    await trackedTurn;

    await harness.bridge.handleNotification(harness.context, "thread/tokenUsage/updated", usage);
    await harness.bridge.handleNotification(harness.context, "turn/diff/updated", diff);

    expect(
      harness
        .events()
        .filter((event) =>
          ["usage.updated", "diagnostic.reported", "run.completed"].includes(event.kind),
        ),
    ).toMatchObject([
      { kind: "usage.updated", runId: DRIVER_TEST_IDS.runId },
      { kind: "diagnostic.reported", runId: DRIVER_TEST_IDS.runId },
      { kind: "run.completed", runId: DRIVER_TEST_IDS.runId },
    ]);
    await harness.logger.destroy();
  });

  test("bounds a large turn diff before real CMA admission", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    const diff = "x".repeat(1_100_000);

    const notification = parseServerNotification({
      method: "turn/diff/updated",
      params: { diff, threadId: "thread-1", turnId: "turn-1" },
    });
    expect(notification).not.toBeNull();
    await bridge.handleNotification(context, notification!.method, notification!.params);

    const diagnostic = delivered.find(
      (event) =>
        event.kind === "diagnostic.reported" &&
        readEventPayloadString(event, "message") === "OpenAI turn diff updated.",
    );
    expect(diagnostic).toMatchObject({
      delivery: "best_effort",
      payload: { details: { utf8Bytes: 1_100_000 } },
    });
    expect(JSON.stringify(diagnostic)).not.toContain(diff.slice(0, 1_024));
    bridge.rejectTurn("turn-1", new Error("test complete"));
    await logger.destroy();
  });

  test("bounds non-durable official telemetry before real CMA admission", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const large = "x".repeat(1_100_000);
    const notifications = [
      parseServerNotification({
        method: "hook/completed",
        params: {
          run: {
            completedAt: 2,
            displayOrder: 0,
            durationMs: 1,
            entries: [{ kind: "context", text: large }],
            eventName: "preToolUse",
            executionMode: "sync",
            handlerType: "command",
            id: "hook-1",
            scope: "turn",
            source: "user",
            sourcePath: "/tmp/hook",
            startedAt: 1,
            status: "completed",
            statusMessage: null,
          },
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }),
      parseServerNotification({
        method: "item/autoApprovalReview/started",
        params: {
          action: { command: "echo ok", cwd: "/tmp", source: "shell", type: "command" },
          review: { rationale: large, status: "inProgress" },
          reviewId: "review-1",
          startedAtMs: 1,
          targetItemId: "tool-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }),
      parseServerNotification({
        method: "mcpServer/startupStatus/updated",
        params: {
          error: large,
          failureReason: null,
          name: "filesystem",
          status: "failed",
          threadId: "thread-1",
        },
      }),
      parseServerNotification({
        method: "model/rerouted",
        params: {
          fromModel: large,
          reason: "highRiskCyberActivity",
          threadId: "thread-1",
          toModel: "gpt-b",
          turnId: "turn-1",
        },
      }),
      parseServerNotification({
        method: "model/safetyBuffering/updated",
        params: {
          fasterModel: null,
          model: "gpt-b",
          reasons: ["policy"],
          showBufferingUi: true,
          threadId: "thread-1",
          turnId: "turn-1",
          useCases: [large],
        },
      }),
    ];
    expect(notifications.every((notification) => notification !== null)).toBe(true);

    for (const notification of notifications) {
      await bridge.handleNotification(context, notification!.method, notification!.params);
    }

    expect(delivered.map((event) => event.kind)).toEqual([
      "hook.completed",
      "permission.review.started",
      "mcp.server.updated",
      "model.routing.updated",
      "model.routing.updated",
    ]);
    expect(delivered.every((event) => event.delivery === "best_effort")).toBe(true);
    expect(delivered.every((event) => Buffer.byteLength(JSON.stringify(event)) < 1_048_576)).toBe(
      true,
    );
    expect(JSON.stringify(delivered)).not.toContain(large);
    await logger.destroy();
  });

  test("maps official approval identities and bounds terminal telemetry before CMA", async () => {
    const permission = Promise.withResolvers<DriverPermissionRequest>();
    const nativeThreadId = `thread-${"i".repeat(300)}`;
    const { bridge, context, delivered, logger } = createPublisherHarness({
      requestPermission: async (input) => {
        permission.resolve(input);
        return "allow_once";
      },
      threadId: nativeThreadId,
    });
    const nativeItemId = `command-${"i".repeat(300)}`;
    const nativeMcpItemId = `mcp-${"i".repeat(300)}`;
    const nativeTurnId = `turn-${"i".repeat(300)}`;
    const large = "x".repeat(1_100_000);
    const trackedTurn = bridge.trackTurn(nativeTurnId, DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    const itemStarts = [
      parseServerNotification({
        method: "item/started",
        params: {
          item: {
            aggregatedOutput: null,
            command: "printf ok",
            commandActions: [],
            cwd: "/tmp",
            durationMs: null,
            exitCode: null,
            id: nativeItemId,
            pluginId: null,
            processId: null,
            scriptPath: null,
            source: "agent",
            status: "inProgress",
            type: "commandExecution",
          },
          startedAtMs: 1,
          threadId: nativeThreadId,
          turnId: nativeTurnId,
        },
      }),
      parseServerNotification({
        method: "item/started",
        params: {
          item: {
            appContext: null,
            arguments: {},
            durationMs: null,
            error: null,
            id: nativeMcpItemId,
            pluginId: null,
            readOnlyHint: null,
            result: null,
            server: "filesystem",
            status: "inProgress",
            tool: "read_file",
            type: "mcpToolCall",
          },
          startedAtMs: 1,
          threadId: nativeThreadId,
          turnId: nativeTurnId,
        },
      }),
    ];
    expect(itemStarts.every((notification) => notification !== null)).toBe(true);
    for (const notification of itemStarts) {
      await bridge.handleNotification(context, notification!.method, notification!.params);
    }

    const request = parseServerRequest({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: {
        environmentId: null,
        itemId: nativeItemId,
        startedAtMs: 2,
        threadId: nativeThreadId,
        turnId: nativeTurnId,
      },
    });
    expect(request).not.toBeNull();
    const response = Promise.withResolvers<unknown>();
    const errors: Error[] = [];
    const handler = new OpenAiAppServerRequestHandler({
      context,
      handleError: async (error) => {
        errors.push(error);
      },
      isStopped: () => false,
      mapToolCallId: (toolCallId) => bridge.mapToolCallId(toolCallId),
      respond: (_id, result) => response.resolve(result),
      respondError: (_id, message) => errors.push(new Error(message)),
    });
    handler.dispatch(request!.method, request!.id, request!.params);
    await expect(response.promise).resolves.toEqual({ decision: "accept" });

    const notifications = [
      parseServerNotification({
        method: "item/autoApprovalReview/started",
        params: {
          action: { command: "printf ok", cwd: "/tmp", source: "shell", type: "command" },
          review: {
            rationale: null,
            riskLevel: null,
            status: "inProgress",
            userAuthorization: null,
          },
          reviewId: "review-1",
          startedAtMs: 2,
          targetItemId: nativeItemId,
          threadId: nativeThreadId,
          turnId: nativeTurnId,
        },
      }),
      parseServerNotification({
        method: "item/mcpToolCall/progress",
        params: {
          itemId: nativeMcpItemId,
          message: large,
          threadId: nativeThreadId,
          turnId: nativeTurnId,
        },
      }),
      parseServerNotification({
        method: "item/commandExecution/terminalInteraction",
        params: {
          itemId: nativeItemId,
          processId: large,
          stdin: "",
          threadId: nativeThreadId,
          turnId: nativeTurnId,
        },
      }),
      parseServerNotification({
        method: "turn/diff/updated",
        params: {
          diff: "diff --git a/file b/file",
          threadId: nativeThreadId,
          turnId: nativeTurnId,
        },
      }),
    ];
    expect(notifications.every((notification) => notification !== null)).toBe(true);
    for (const notification of notifications) {
      await bridge.handleNotification(context, notification!.method, notification!.params);
    }

    const publicItemId = bridge.mapToolCallId(nativeItemId);
    const permissionInput = await permission.promise;
    const review = delivered.find((event) => event.kind === "permission.review.started");
    const progress = delivered.find(
      (event) =>
        event.kind === "tool.call.updated" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        !Array.isArray(event.payload) &&
        (event.payload as Record<string, unknown>)["rawOutputUtf8Bytes"] === 1_100_000,
    );
    const shell = delivered.find((event) => event.kind === "shell.command.updated");
    const diff = delivered.find(
      (event) =>
        event.kind === "diagnostic.reported" &&
        readEventPayloadString(event, "message") === "OpenAI turn diff updated.",
    );
    expect(isDriverId(publicItemId)).toBe(true);
    expect(permissionInput.toolCallId).toBe(publicItemId);
    expect(readEventPayloadString(review!, "targetItemId")).toBe(publicItemId);
    expect(progress?.payload).toMatchObject({
      rawOutputUtf8Bytes: 1_100_000,
      status: "running",
      toolCallId: expect.any(String),
    });
    expect(progress?.payload).not.toHaveProperty("rawOutput");
    expect(shell?.payload).toMatchObject({
      itemId: publicItemId,
      processIdUtf8Bytes: 1_100_000,
      status: "running",
    });
    expect(shell?.payload).not.toHaveProperty("processId");
    expect(isDriverId(readEventPayloadString(shell!, "threadId"))).toBe(true);
    expect(isDriverId(readEventPayloadString(shell!, "turnId"))).toBe(true);
    expect(readEventPayloadString(diff!, "turnId")).toBe(readEventPayloadString(shell!, "turnId"));
    expect(delivered.every((event) => Buffer.byteLength(JSON.stringify(event)) < 1_048_576)).toBe(
      true,
    );
    expect(errors).toEqual([]);
    bridge.rejectTurn(nativeTurnId, new Error("test complete"));
    await handler.abortAll(new Error("test complete"));
    await logger.destroy();
  });

  test("chunks large user-facing warnings and bounds world-writable samples for CMA", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const large = "x".repeat(1_100_000);
    const notifications = [
      parseServerNotification({
        method: "warning",
        params: { message: large, threadId: "thread-1" },
      }),
      parseServerNotification({
        method: "guardianWarning",
        params: { message: large, threadId: "thread-1" },
      }),
      parseServerNotification({
        method: "autoApprovalReview/strictReviewRequired",
        params: { startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" },
      }),
      parseServerNotification({
        method: "windows/worldWritableWarning",
        params: { extraCount: 2, failedScan: false, samplePaths: [large] },
      }),
    ];
    expect(notifications.every((notification) => notification !== null)).toBe(true);

    for (const notification of notifications) {
      await bridge.handleNotification(context, notification!.method, notification!.params);
    }

    for (const subtype of ["warning", "guardian_warning"] as const) {
      const events = delivered.filter(
        (event) => readEventPayloadString(event, "subtype") === subtype,
      );
      expect(events.map((event) => readEventPayloadString(event, "content")).join("")).toBe(large);
      expect(events.length).toBeGreaterThan(1);
      expect(events.every((event) => event.delivery === "lossless")).toBe(true);
    }
    const strictReview = delivered.find(
      (event) => readEventPayloadString(event, "subtype") === "strict_review_required",
    );
    expect(strictReview?.delivery).toBe("lossless");
    expect(strictReview?.payload).toMatchObject({ startedAtMs: 1 });
    const worldWritable = delivered.find(
      (event) => readEventPayloadString(event, "subtype") === "windows_world_writable_warning",
    );
    expect(worldWritable?.payload).toMatchObject({ extraCount: 3, samplePaths: [] });
    expect(delivered.every((event) => Buffer.byteLength(JSON.stringify(event)) < 1_048_576)).toBe(
      true,
    );
    await logger.destroy();
  });

  test("bounds an official failed-turn error before terminal CMA admission", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    const large = "x".repeat(1_100_000);
    const notification = parseServerNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          completedAt: 2,
          durationMs: 1,
          error: { additionalDetails: large, codexErrorInfo: null, message: large },
          id: "turn-1",
          items: [],
          itemsView: "notLoaded",
          startedAt: 1,
          status: "failed",
        },
      },
    });
    expect(notification).not.toBeNull();

    await bridge.handleNotification(context, notification!.method, notification!.params);
    await expect(trackedTurn).rejects.toThrow("was omitted");

    const terminal = delivered.at(-1);
    expect(terminal).toMatchObject({
      kind: "run.failed",
      payload: {
        error: {
          details: {
            additionalDetailsUtf8Bytes: 1_100_000,
            messageUtf8Bytes: 1_100_000,
          },
        },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(terminal))).toBeLessThan(1_048_576);
    await logger.destroy();
  });

  test("removes OpenAI private citation markup from streamed and final assistant text", async () => {
    const { bridge, context, events, logger } = createHarness();
    const privateCitation = "\uE200cite\uE202turn7search12\uE202turn8view0\uE201";

    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "before\uE200ci",
      itemId: "message-final",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "te\uE202turn7search12\uE202turn8view0",
      itemId: "message-final",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "\uE201after",
      itemId: "message-final",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-final",
        text: `before${privateCitation}after`,
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          {
            id: "message-final",
            text: `before${privateCitation}after`,
            type: "agentMessage",
          },
        ],
        status: "completed",
      },
    });
    await logger.destroy();

    const allEvents = events();
    const streamedText = allEvents
      .filter((event) => event.kind === "message.delta")
      .map((event) => readEventPayloadString(event, "contentDelta") ?? "")
      .join("");
    const runCompleted = allEvents.find((event) => event.kind === "run.completed");
    const diagnostics = allEvents.filter(
      (event) =>
        event.kind === "diagnostic.reported" &&
        readEventPayloadString(event, "code") === "openai.private_citation_markup_removed",
    );

    expect(streamedText).toBe("beforeafter");
    expect(runCompleted).toBeDefined();
    expectRunFinalReferences(allEvents, "beforeafter");
    expect(diagnostics).toHaveLength(1);
  });

  test("flushes incomplete private markup when an item completes without a text snapshot", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "before\uE200cite\uE202turn7search12",
      itemId: "message-final",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-final",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await logger.destroy();

    const streamedText = events()
      .filter((event) => event.kind === "message.delta")
      .map((event) => readEventPayloadString(event, "contentDelta") ?? "")
      .join("");

    expect(streamedText).toBe("before\uE200cite\uE202turn7search12");
  });

  test("does not fall back to progress when the final turn item is incomplete", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-progress",
        text: "PROGRESS",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          { id: "message-progress", text: "PROGRESS", type: "agentMessage" },
          { id: "message-final", type: "agentMessage" },
        ],
        status: "completed",
      },
    });
    await logger.destroy();

    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    expect(readEventPayloadString(runCompleted, "finalMessageId")).toBeNull();
    expect(runCompleted.payload).not.toHaveProperty("finalMessageText");
  });

  test("uses the last completed assistant snapshot when turn items are omitted", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "PROGRESS",
      itemId: "message-progress",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-progress",
        text: "PROGRESS",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/agentMessage/delta", {
      delta: "最终回答：中文 Markdown ✅",
      itemId: "message-final",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-final",
        text: "最终回答：中文 Markdown ✅",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
      },
    });
    await logger.destroy();

    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    expectRunFinalReferences(events(), "最终回答：中文 Markdown ✅");
  });

  test("uses completed snapshots when terminal items are not loaded", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/completed", {
      item: { id: "message-final", text: "FINAL", type: "agentMessage" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: {
        delivery: "async",
        id: "message-async-progress",
        phase: "final_answer",
        text: "ASYNC PROGRESS",
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "notLoaded",
        status: "completed",
      },
    });
    await logger.destroy();

    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    expectRunFinalReferences(events(), "FINAL");
  });

  test("does not fall back when a full terminal item list has no assistant", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "item/completed", {
      item: { id: "message-progress", text: "PROGRESS", type: "agentMessage" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "full",
        status: "completed",
      },
    });
    await logger.destroy();

    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    expect(runCompleted.payload).not.toHaveProperty("finalMessageText");
  });

  test("uses first-seen item order when older completions arrive late", async () => {
    const { bridge, context, events, logger } = createHarness();

    for (const [itemId, delta] of [
      ["message-progress", "PROGRESS"],
      ["message-final", "FINAL"],
    ] as const) {
      await bridge.handleNotification(context, "item/agentMessage/delta", {
        delta,
        itemId,
        threadId: "thread-1",
        turnId: "turn-1",
      });
    }
    await bridge.handleNotification(context, "item/completed", {
      item: { id: "message-final", text: "FINAL", type: "agentMessage" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "item/completed", {
      item: { id: "message-progress", text: "PROGRESS", type: "agentMessage" },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await logger.destroy();

    const runCompleted = events().find((event) => event.kind === "run.completed");

    if (runCompleted === undefined) {
      throw new Error("Expected a run.completed event.");
    }

    expectRunFinalReferences(events(), "FINAL");
  });

  test("publishes more than 31 open tool closures before the run terminal", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const completion = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    const toolCount = 40;

    for (let index = 0; index < toolCount; index += 1) {
      await bridge.handleNotification(context, "item/started", {
        item: {
          id: `tool-${String(index)}`,
          status: "inProgress",
          type: "commandExecution",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      });
    }

    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "notLoaded",
        status: "completed",
      },
    });
    await expect(completion).resolves.toBeUndefined();
    await logger.destroy();

    expect(
      delivered.filter(
        (event) =>
          event.kind === "tool.call.updated" &&
          readEventPayloadString(event, "status") === "completed",
      ),
    ).toHaveLength(toolCount);
    expect(
      delivered.filter(
        (event) =>
          event.kind === "item.completed" &&
          readEventPayloadString(event, "status") === "completed",
      ),
    ).toHaveLength(toolCount);
    expect(delivered.filter((event) => event.kind === "run.completed")).toHaveLength(1);
    expect(delivered.at(-1)?.kind).toBe("run.completed");
  });

  test("publishes a final snapshot larger than the terminal byte limit by reference", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const completion = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    const finalText = "x".repeat(1_100_000);

    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-final",
        text: finalText,
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "notLoaded",
        status: "completed",
      },
    });
    await expect(completion).resolves.toBeUndefined();
    await logger.destroy();

    expectRunFinalReferences(delivered, finalText);
    expect(delivered.at(-1)?.kind).toBe("run.completed");
  });

  test("commits a chunked snapshot once after a partial transport retry", async () => {
    const sourcePrefix = "openai.item.completed:turn-1:message-partial:";
    const { bridge, context, delivered, logger, partialAttempts } = createPublisherHarness({
      partialSourcePrefix: sourcePrefix,
    });
    const completion = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    const finalText = "x".repeat(1_100_000);
    const notification = {
      item: {
        id: "message-partial",
        text: finalText,
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    };

    await bridge.handleNotification(context, "item/completed", notification);
    const deliveredAfterCompletion = delivered.length;
    await bridge.handleNotification(context, "item/completed", notification);
    expect(delivered).toHaveLength(deliveredAfterCompletion);

    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "completed" },
    });
    await expect(completion).resolves.toBeUndefined();

    expect(partialAttempts).toHaveLength(3);
    expect(partialAttempts[2]?.map((event) => event.sourceEventId)).toEqual(
      partialAttempts[1]?.map((event) => event.sourceEventId),
    );
    const deliveredSnapshotIds = delivered
      .filter((event) => event.sourceEventId?.startsWith(sourcePrefix) === true)
      .map((event) => event.sourceEventId);
    expect(new Set(deliveredSnapshotIds).size).toBe(deliveredSnapshotIds.length);
    expect(
      delivered.filter(
        (event) =>
          event.kind === "message.completed" &&
          event.sourceEventId?.startsWith(sourcePrefix) === true,
      ),
    ).toHaveLength(1);
    expectRunFinalReferences(delivered, finalText);
    expect(delivered.at(-1)?.kind).toBe("run.completed");
    await logger.destroy();
  });

  test("publishes a multi-byte final snapshot through CMA-safe lossless chunks", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const completion = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    const finalText = "界".repeat(400_000);

    await bridge.handleNotification(context, "item/completed", {
      item: {
        id: "message-final",
        memoryCitation: { source: "memory-1" },
        phase: "final_answer",
        text: finalText,
        type: "agentMessage",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "notLoaded",
        status: "completed",
      },
    });
    await expect(completion).resolves.toBeUndefined();

    expectRunFinalReferences(delivered, finalText);
    const snapshot = delivered.find(
      (event) => event.delivery === "lossless" && event.kind === "message.added",
    );
    expect(snapshot?.payload).toMatchObject({
      memoryCitation: { source: "memory-1" },
      phase: "final",
    });
    await logger.destroy();
  });

  test("publishes a large command result once without exceeding CMA admission", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const output = "x".repeat(525_000);

    await bridge.handleNotification(context, "item/completed", {
      item: {
        aggregatedOutput: output,
        command: "generate-output",
        id: "tool-large",
        status: "completed",
        type: "commandExecution",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const completion = delivered.find(
      (event) =>
        event.kind === "tool.call.updated" &&
        readEventPayloadString(event, "toolCallId") === "tool-large" &&
        readEventPayloadString(event, "status") === "completed",
    );
    expect(readEventPayloadString(completion!, "rawOutput")).toBe(output);
    expect(completion?.payload).not.toHaveProperty("content");
    await logger.destroy();
  });

  test("publishes a large dynamic result once through structured output", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const text = "x".repeat(600_000);
    const notification = parseServerNotification({
      method: "item/completed",
      params: {
        completedAtMs: 1,
        item: {
          arguments: { query: "migration" },
          contentItems: [{ text, type: "inputText" }],
          durationMs: 9,
          id: "dynamic-large",
          namespace: "project",
          status: "completed",
          success: true,
          tool: "lookup",
          type: "dynamicToolCall",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(notification).not.toBeNull();

    await bridge.handleNotification(context, notification!.method, notification!.params);

    const completion = delivered.find(
      (event) =>
        event.kind === "tool.call.updated" &&
        readEventPayloadString(event, "toolCallId") === "dynamic-large" &&
        readEventPayloadString(event, "status") === "completed",
    );
    expect(completion?.payload).not.toHaveProperty("rawOutput");
    expect(completion?.payload).toMatchObject({
      structuredOutput: { contentItems: [{ text, type: "inputText" }] },
    });
    await logger.destroy();
  });

  test("fails closed when one dynamic structured result exceeds CMA admission", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    const notification = parseServerNotification({
      method: "item/completed",
      params: {
        completedAtMs: 1,
        item: {
          arguments: {},
          contentItems: [{ text: "x".repeat(1_100_000), type: "inputText" }],
          durationMs: 9,
          id: "dynamic-oversized",
          namespace: "project",
          status: "completed",
          success: true,
          tool: "lookup",
          type: "dynamicToolCall",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(notification).not.toBeNull();
    let failure: Error | null = null;

    try {
      await bridge.handleNotification(context, notification!.method, notification!.params);
    } catch (error) {
      failure = error instanceof Error ? error : new Error("dynamic completion failed");
    }

    expect(failure?.message).toContain("durable event capacity");
    await bridge.failActiveTurns(context, failure!);
    await expect(trackedTurn).rejects.toThrow("durable event capacity");
    expect(
      delivered.find(
        (event) =>
          event.kind === "tool.call.updated" &&
          readEventPayloadString(event, "toolCallId") === "dynamic-oversized" &&
          readEventPayloadString(event, "status") === "completed",
      ),
    ).toBeUndefined();
    await logger.destroy();
  });

  test("fails the active turn instead of claiming an oversized tool result completed", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    const output = "x".repeat(1_100_000);
    let failure: Error | null = null;

    try {
      await bridge.handleNotification(context, "item/completed", {
        item: {
          aggregatedOutput: output,
          command: "generate-output",
          id: "tool-oversized",
          status: "completed",
          type: "commandExecution",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error("tool completion failed");
    }

    expect(failure).not.toBeNull();
    expect(failure?.message).toContain("UTF-8 bytes");
    await bridge.failActiveTurns(context, failure!);
    await expect(trackedTurn).rejects.toThrow("durable event capacity");

    expect(
      delivered.find(
        (event) =>
          event.kind === "tool.call.updated" &&
          readEventPayloadString(event, "toolCallId") === "tool-oversized" &&
          readEventPayloadString(event, "status") === "completed",
      ),
    ).toBeUndefined();
    expect(
      delivered.find(
        (event) =>
          event.kind === "tool.call.updated" &&
          readEventPayloadString(event, "toolCallId") === "tool-oversized" &&
          readEventPayloadString(event, "status") === "failed",
      ),
    ).toBeDefined();
    expect(delivered.find((event) => event.kind === "run.failed")?.payload).toMatchObject({
      error: { message: expect.stringContaining("UTF-8 bytes") },
    });
    await logger.destroy();
  });

  test("budgets the first message chunk around large citation metadata", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    const text = "a".repeat(512 * 1_024);
    const notification = parseServerNotification({
      method: "item/completed",
      params: {
        completedAtMs: 1,
        item: {
          id: "message-citation",
          memoryCitation: {
            entries: [
              {
                lineEnd: 1,
                lineStart: 0,
                note: "x".repeat(600_000),
                path: "/memory.md",
              },
            ],
            threadIds: ["memory-thread"],
          },
          phase: "final_answer",
          text,
          type: "agentMessage",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(notification).not.toBeNull();

    await bridge.handleNotification(context, notification!.method, notification!.params);
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "completed" },
    });
    await expect(trackedTurn).resolves.toBeUndefined();
    expectRunFinalReferences(delivered, text);
    expect(
      delivered.filter(
        (event) =>
          event.delivery === "lossless" &&
          (event.kind === "message.added" || event.kind === "message.delta"),
      ).length,
    ).toBeGreaterThan(1);
    await logger.destroy();
  });

  test("budgets snapshot chunks after adding a long provider item identity", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    const itemId = `message-${"i".repeat(100_000)}`;
    const text = "a".repeat(512 * 1_024);
    const notification = parseServerNotification({
      method: "item/completed",
      params: {
        completedAtMs: 1,
        item: {
          id: itemId,
          memoryCitation: {
            entries: [
              {
                lineEnd: 1,
                lineStart: 0,
                note: "x".repeat(600_000),
                path: "/memory.md",
              },
            ],
            threadIds: ["memory-thread"],
          },
          phase: "final_answer",
          text,
          type: "agentMessage",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(notification).not.toBeNull();

    await bridge.handleNotification(context, notification!.method, notification!.params);
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "completed" },
    });
    await expect(trackedTurn).resolves.toBeUndefined();
    expectRunFinalReferences(delivered, text);
    await logger.destroy();
  });

  test("maps long provider reasoning identity before durable CMA delivery", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    const itemId = `reasoning-${"i".repeat(262_000)}`;
    const text = "x".repeat(512 * 1_024);
    const notification = parseServerNotification({
      method: "item/reasoning/summaryTextDelta",
      params: {
        delta: text,
        itemId,
        summaryIndex: 0,
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(notification).not.toBeNull();

    await bridge.handleNotification(context, notification!.method, notification!.params);
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "completed" },
    });
    await expect(trackedTurn).resolves.toBeUndefined();

    const reasoningEvents = delivered.filter((event) => event.kind.startsWith("thought."));
    const thoughtIds = reasoningEvents.map((event) => readEventPayloadString(event, "thoughtId"));
    expect(thoughtIds.every((thoughtId) => thoughtId !== null && isDriverId(thoughtId))).toBe(true);
    expect(new Set(thoughtIds).size).toBe(1);
    expect(
      reasoningEvents
        .filter((event) => event.kind === "thought.delta")
        .map((event) => readEventPayloadString(event, "contentDelta"))
        .join(""),
    ).toBe(text);
    expect(reasoningEvents.some((event) => event.sourceEventId?.includes(itemId) === true)).toBe(
      false,
    );
    await logger.destroy();
  });

  test("maps long provider item and tool identities before durable CMA delivery", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    const contextItemId = `compact-${"i".repeat(525_000)}`;
    const toolItemId = `tool-${"i".repeat(525_000)}`;
    const notifications = [
      parseServerNotification({
        method: "item/completed",
        params: {
          completedAtMs: 1,
          item: { id: contextItemId, type: "contextCompaction" },
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }),
      parseServerNotification({
        method: "item/completed",
        params: {
          completedAtMs: 2,
          item: {
            aggregatedOutput: "done",
            command: "printf done",
            commandActions: [],
            cwd: "/tmp",
            durationMs: 1,
            exitCode: 0,
            id: toolItemId,
            pluginId: null,
            processId: null,
            scriptPath: null,
            source: "agent",
            status: "completed",
            type: "commandExecution",
          },
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }),
    ];
    expect(notifications.every((notification) => notification !== null)).toBe(true);

    for (const notification of notifications) {
      await bridge.handleNotification(context, notification!.method, notification!.params);
    }
    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "completed" },
    });
    await expect(trackedTurn).resolves.toBeUndefined();

    const compactedId = readEventPayloadString(
      delivered.find((event) => event.kind === "context.compacted")!,
      "itemId",
    );
    const toolIds = delivered
      .filter(
        (event) =>
          event.kind === "tool.call.updated" ||
          (event.kind === "item.started" &&
            readEventPayloadString(event, "itemType") === "tool_call") ||
          (event.kind === "item.completed" &&
            readEventPayloadString(event, "itemType") === "tool_call"),
      )
      .map(
        (event) =>
          readEventPayloadString(event, "toolCallId") ?? readEventPayloadString(event, "itemId"),
      );
    expect(compactedId !== null && isDriverId(compactedId)).toBe(true);
    expect(toolIds.every((toolId) => toolId !== null && isDriverId(toolId))).toBe(true);
    expect(new Set(toolIds).size).toBe(1);
    expect(
      delivered.some(
        (event) =>
          event.sourceEventId?.includes(contextItemId) === true ||
          event.sourceEventId?.includes(toolItemId) === true,
      ),
    ).toBe(false);
    await logger.destroy();
  });

  test("fails closed before CMA when one official plan update exceeds durable capacity", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    const notification = parseServerNotification({
      method: "item/plan/delta",
      params: {
        delta: "x".repeat(1_050_000),
        itemId: "plan-large",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(notification).not.toBeNull();
    let failure: Error | null = null;

    try {
      await bridge.handleNotification(context, notification!.method, notification!.params);
    } catch (error) {
      failure = error instanceof Error ? error : new Error("plan update failed");
    }

    expect(failure?.message).toContain("durable event capacity");
    await bridge.failActiveTurns(context, failure!);
    await expect(trackedTurn).rejects.toThrow("durable event capacity");
    expect(delivered.some((event) => event.kind === "plan.updated")).toBe(false);
    expect(delivered.at(-1)?.kind).toBe("run.failed");
    await logger.destroy();
  });

  test.each([
    [
      "MCP server",
      {
        arguments: {},
        id: "mcp-server-large",
        server: "s".repeat(1_050_000),
        status: "inProgress",
        tool: "inspect",
        type: "mcpToolCall",
      },
    ],
    [
      "MCP tool",
      {
        arguments: {},
        id: "mcp-tool-large",
        server: "filesystem",
        status: "inProgress",
        tool: "t".repeat(1_050_000),
        type: "mcpToolCall",
      },
    ],
    [
      "dynamic tool",
      {
        arguments: {},
        id: "dynamic-tool-large",
        status: "inProgress",
        tool: "t".repeat(1_050_000),
        type: "dynamicToolCall",
      },
    ],
  ] as const)("fails %s start before poisoning CMA terminal delivery", async (_label, item) => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    const notification = parseServerNotification({
      method: "item/started",
      params: { item, startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" },
    });
    expect(notification).not.toBeNull();
    let failure: Error | null = null;

    try {
      await bridge.handleNotification(context, notification!.method, notification!.params);
    } catch (error) {
      failure = error instanceof Error ? error : new Error("tool start failed");
    }

    expect(failure?.message).toContain("tool start exceeds durable event capacity");
    await expect(bridge.failActiveTurns(context, failure!)).resolves.toBe(true);
    await expect(trackedTurn).rejects.toThrow("tool start exceeds durable event capacity");
    expect(delivered.some((event) => event.kind === "item.started")).toBe(false);
    expect(delivered.some((event) => event.kind === "tool.call.updated")).toBe(false);
    expect(delivered.at(-1)?.kind).toBe("run.failed");
    await logger.destroy();
  });

  test("completes a large renamed file patch without duplicating its diff", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    const diff = "x".repeat(1_050_000);
    const change = {
      diff,
      kind: { move_path: "/tmp/renamed.txt", type: "update" },
      path: "/tmp/file.txt",
    };
    const notification = parseServerNotification({
      method: "item/fileChange/patchUpdated",
      params: {
        changes: [change],
        itemId: "patch-large",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(notification).not.toBeNull();

    await bridge.handleNotification(context, notification!.method, notification!.params);
    const completion = parseServerNotification({
      method: "item/completed",
      params: {
        completedAtMs: 1,
        item: {
          changes: [change],
          id: "patch-large",
          status: "completed",
          type: "fileChange",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(completion).not.toBeNull();
    await bridge.handleNotification(context, completion!.method, completion!.params);

    expect(delivered.find((event) => event.kind === "file.change.updated")?.payload).toMatchObject({
      changes: [
        { change: "delete", path: "/tmp/file.txt" },
        { change: "upsert", path: "/tmp/renamed.txt" },
      ],
    });
    expect(
      delivered.some(
        (event) =>
          event.kind === "tool.call.updated" && readEventPayloadString(event, "rawOutput") === diff,
      ),
    ).toBe(false);
    expect(
      delivered.some(
        (event) =>
          event.kind === "tool.call.updated" &&
          readEventPayloadString(event, "toolCallId") === "patch-large" &&
          readEventPayloadString(event, "status") === "completed",
      ),
    ).toBe(true);
    expect(
      delivered.some(
        (event) =>
          event.kind === "item.completed" &&
          readEventPayloadString(event, "itemId") === "patch-large",
      ),
    ).toBe(true);

    await bridge.failActiveTurns(context, new Error("test complete"));
    await expect(trackedTurn).rejects.toThrow("test complete");
    await logger.destroy();
  });

  test("fails closed when citation metadata alone exceeds CMA snapshot capacity", async () => {
    const { bridge, context, delivered, logger } = createPublisherHarness();
    const trackedTurn = bridge.trackTurn("turn-1", DRIVER_TEST_IDS.runId);
    void trackedTurn.catch(() => {});
    const notification = parseServerNotification({
      method: "item/completed",
      params: {
        completedAtMs: 1,
        item: {
          id: "message-citation",
          memoryCitation: {
            entries: [
              {
                lineEnd: 1,
                lineStart: 0,
                note: "x".repeat(1_100_000),
                path: "/memory.md",
              },
            ],
            threadIds: ["memory-thread"],
          },
          phase: "final_answer",
          text: "short",
          type: "agentMessage",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(notification).not.toBeNull();
    let failure: Error | null = null;

    try {
      await bridge.handleNotification(context, notification!.method, notification!.params);
    } catch (error) {
      failure = error instanceof Error ? error : new Error("message completion failed");
    }

    expect(failure?.message).toContain("message snapshot message-citation");
    await bridge.failActiveTurns(context, failure!);
    await expect(trackedTurn).rejects.toThrow("durable event capacity");
    expect(delivered.find((event) => event.kind === "message.added")).toBeUndefined();
    expect(delivered.find((event) => event.kind === "message.completed")).toBeUndefined();
    expect(delivered.find((event) => event.kind === "message.failed")).toBeDefined();
    expect(delivered.find((event) => event.kind === "run.failed")).toBeDefined();
    expect(JSON.stringify(delivered)).not.toContain("memory-thread");
    await logger.destroy();
  });

  test("completed turns app final items before run finish", async () => {
    const { bridge, context, events, logger } = createHarness();

    await bridge.handleNotification(context, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          {
            id: "message-1",
            text: "pong",
            type: "agentMessage",
          },
        ],
        status: "completed",
      },
    });
    await logger.destroy();
    const assistantMessageId = readAssistantMessageId(events());

    expect(events()).toMatchObject([
      {
        kind: "run.started",
        payload: {
          startedAt: expect.any(String),
        },
      },
      {
        kind: "message.started",
        payload: {
          messageId: assistantMessageId,
          role: "agent",
        },
      },
      {
        delivery: "lossless",
        kind: "message.added",
        payload: {
          content: "pong",
          messageId: assistantMessageId,
          role: "agent",
        },
      },
      {
        kind: "message.completed",
        payload: {
          messageId: assistantMessageId,
          role: "agent",
        },
      },
      {
        kind: "runtime.resume.updated",
        payload: {
          resumePointer: "thread-1",
          threadId: "thread-1",
        },
      },
      {
        kind: "run.completed",
        payload: {
          stopReason: "end_turn",
        },
      },
    ]);
  });
});
