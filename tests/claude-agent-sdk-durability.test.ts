import { describe, expect, test } from "bun:test";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-event-envelope";
import { createDisabledLogger } from "../src/observability";
import type { DriverBootPayload } from "../src/protocol/boot";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverId } from "../src/protocol/id";
import type { EventId, RunId, SessionId } from "../src/protocol/id";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { toRuntimeEventInput } from "../src/runtime-events";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { ClaudeDurableEventTooLargeError } from "../src/runtimes/claude/agent-sdk-event-writer";
import { ClaudeAgentSdkMessageTranslator } from "../src/runtimes/claude/agent-sdk-message-translator";
import { ClaudePublicToolCallIdState } from "../src/runtimes/claude/agent-sdk-tool-id";
import { DriverEventPublisher } from "../src/runtimes/driver-event-publisher";
import { CMA_MAX_EVENT_BYTES, encodeCmaSseRecord } from "../src/stores/cma-store";
import { createCmaMemoryStore } from "../src/stores/memory";
import {
  DRIVER_TEST_IDS,
  driverBootPayload,
  driverStartInput as bootPayload,
} from "./driver-boot-payload-fixture";
import { isRecord, messageText } from "./claude-agent-sdk-test-helpers";

function payload(event: DriverEventInput): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function successResult(input: {
  readonly result?: string;
  readonly structuredOutput?: unknown;
}): SDKMessage {
  return {
    is_error: false,
    modelUsage: {},
    permission_denials: [],
    result: input.result ?? "",
    ...(input.structuredOutput === undefined ? {} : { structured_output: input.structuredOutput }),
    subtype: "success",
    total_cost_usd: 0,
    type: "result",
    usage: {},
    uuid: createDriverId(),
  } as unknown as SDKMessage;
}

function createCmaHarness() {
  const runId = createDriverId() as RunId;
  const sessionId = createDriverId() as SessionId;
  const events: DriverEventInput[] = [];
  const sseFrameBytes: number[] = [];
  const context = createAgentDriverContext({
    eventSink: {
      currentRunId: () => runId,
      pushEvents: async () => ({ accepted: [] }),
    },
    logger: createDisabledLogger(),
    payload: bootPayload,
    permission: { request: async () => "allow_once" },
  });
  const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
  const append = async (batch: readonly DriverEventInput[]) => {
    for (const event of batch) {
      events.push(event);
      const [envelope] = toRuntimeEventInput(
        {
          createId: () => createDriverId() as EventId,
          driverInstanceId: DRIVER_TEST_IDS.driverInstanceId,
          occurredAt: "2026-08-13T00:00:00.000Z",
          runId,
          sessionId,
        },
        event,
      );
      const records = await store.appendDriverEvent(sessionId, envelope!);
      sseFrameBytes.push(...records.map((record) => encodeCmaSseRecord(record).byteLength));
    }
  };
  const toolCallIds = new ClaudePublicToolCallIdState();
  const translator = new ClaudeAgentSdkMessageTranslator({
    publicToolCallId: (nativeToolCallId) => toolCallIds.publicId(nativeToolCallId),
    push: async (_context, _reason, batch) => append(batch),
    pushTerminal: async (_context, _reason, closures, terminal) => append([...closures, terminal]),
    recordNativeSessionId: async () => {},
    replaceNativeSessionId: async () => {},
  });

  return { context, events, runId, sseFrameBytes, translator };
}

describe("Claude Agent SDK durable event boundaries", () => {
  test("materializes a large result fallback as bounded lossless message chunks", async () => {
    const harness = createCmaHarness();
    const text = `开始😀${"x".repeat(1_200_000)}结束`;

    await harness.translator.handleSdkMessage(
      harness.context,
      successResult({ result: text }),
      harness.runId,
    );

    const terminal = harness.events.find((event) => event.kind === "run.completed");
    const finalMessageId = payload(terminal!)["finalMessageId"];
    const snapshots = harness.events.filter(
      (event) => event.kind === "message.added" || event.kind === "message.delta",
    );

    expect(typeof finalMessageId).toBe("string");
    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots.every((event) => event.delivery !== "best_effort")).toBe(true);
    expect(messageText(harness.events, finalMessageId as string)).toBe(text);
    expect(payload(terminal!)).not.toHaveProperty("finalMessageText");
    expect(harness.sseFrameBytes.every((bytes) => bytes < CMA_MAX_EVENT_BYTES)).toBe(true);
  });

  test("rejects oversized structured output before choosing completed closures", async () => {
    const harness = createCmaHarness();

    await harness.translator.handleSdkMessage(
      harness.context,
      {
        event: { message: { id: "native-open" }, type: "message_start" },
        type: "stream_event",
        uuid: "wire-open",
      } as unknown as SDKMessage,
      harness.runId,
    );
    await harness.translator.handleSdkMessage(
      harness.context,
      successResult({ structuredOutput: { data: "x".repeat(600_000) } }),
      harness.runId,
    );

    const failed = harness.events.find((event) => event.kind === "run.failed");
    expect(payload(failed!)["error"]).toMatchObject({
      code: "claude.structured_output_too_large",
    });
    expect(harness.events.map(({ kind }) => kind)).toContain("message.failed");
    expect(harness.events.map(({ kind }) => kind)).not.toContain("run.completed");
    expect(harness.events.map(({ kind }) => kind)).not.toContain("message.completed");
    expect(harness.sseFrameBytes.every((bytes) => bytes < CMA_MAX_EVENT_BYTES)).toBe(true);
  });

  test("keeps accepted structured output inside the real CMA and SSE boundary", async () => {
    const harness = createCmaHarness();

    await harness.translator.handleSdkMessage(
      harness.context,
      successResult({ structuredOutput: { data: "x".repeat(400_000) } }),
      harness.runId,
    );

    expect(harness.events.map(({ kind }) => kind)).toContain("run.completed");
    expect(harness.sseFrameBytes.every((bytes) => bytes < CMA_MAX_EVENT_BYTES)).toBe(true);
  });

  test("bounds oversized provider errors before terminal delivery", async () => {
    const harness = createCmaHarness();
    const providerError = "x".repeat(1_100_000);

    await harness.translator.handleSdkMessage(
      harness.context,
      {
        errors: [providerError],
        is_error: true,
        modelUsage: {},
        permission_denials: [],
        subtype: "error_during_execution",
        terminal_reason: "model_error",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: createDriverId(),
      } as unknown as SDKMessage,
      harness.runId,
    );

    const failed = harness.events.find((event) => event.kind === "run.failed");
    expect(payload(failed!)["error"]).toMatchObject({
      code: "claude.error_during_execution",
      details: { originalMessageUtf8Bytes: 1_100_000 },
      message: "Claude Agent SDK failure exceeded durable event capacity.",
    });
    expect(JSON.stringify(failed)).not.toContain(providerError);
    expect(harness.sseFrameBytes.every((bytes) => bytes < CMA_MAX_EVENT_BYTES)).toBe(true);
  });

  test("bounds oversized cancellation reasons before terminal delivery", async () => {
    const harness = createCmaHarness();
    const reason = "x".repeat(1_100_000);

    await harness.translator.cancelTurn(harness.context, harness.runId, reason);

    const cancelled = harness.events.find((event) => event.kind === "run.cancelled");
    expect(payload(cancelled!)).toMatchObject({
      originalReasonUtf8Bytes: 1_100_000,
      reason: "Claude cancellation reason exceeded durable event capacity.",
      stopReason: "cancelled",
    });
    expect(JSON.stringify(cancelled)).not.toContain(reason);
    expect(harness.sseFrameBytes.every((bytes) => bytes < CMA_MAX_EVENT_BYTES)).toBe(true);
  });

  test("stores one copy of a large tool result and fails closed on oversized structured output", async () => {
    const accepted = createCmaHarness();
    const content = "x".repeat(525_000);

    await accepted.translator.handleSdkMessage(
      accepted.context,
      {
        message: {
          content: [{ id: "tool-large", input: {}, name: "Read", type: "tool_use" }],
          id: "assistant-tool-large",
        },
        type: "assistant",
        uuid: "wire-tool-large",
      } as unknown as SDKMessage,
      accepted.runId,
    );
    await accepted.translator.handleSdkMessage(
      accepted.context,
      {
        message: {
          content: [{ content, tool_use_id: "tool-large", type: "tool_result" }],
        },
        type: "user",
        uuid: "wire-tool-large-result",
      } as unknown as SDKMessage,
      accepted.runId,
    );

    const acceptedResult = accepted.events.find(
      (event) => event.kind === "tool.call.updated" && payload(event)["content"] === content,
    );
    expect(acceptedResult).toBeDefined();
    expect(payload(acceptedResult!)).not.toHaveProperty("rawOutput");
    expect(accepted.sseFrameBytes.every((bytes) => bytes < CMA_MAX_EVENT_BYTES)).toBe(true);

    const rejected = createCmaHarness();
    await rejected.translator.handleSdkMessage(
      rejected.context,
      {
        message: {
          content: [{ id: "tool-oversized", input: {}, name: "Read", type: "tool_use" }],
          id: "assistant-tool-oversized",
        },
        type: "assistant",
        uuid: "wire-tool-oversized",
      } as unknown as SDKMessage,
      rejected.runId,
    );

    let failure: ClaudeDurableEventTooLargeError | null = null;
    try {
      await rejected.translator.handleSdkMessage(
        rejected.context,
        {
          message: {
            content: [{ content: "ok", tool_use_id: "tool-oversized", type: "tool_result" }],
          },
          tool_use_result: { data: "x".repeat(1_048_000) },
          type: "user",
          uuid: "wire-tool-oversized-result",
        } as unknown as SDKMessage,
        rejected.runId,
      );
    } catch (error) {
      if (error instanceof ClaudeDurableEventTooLargeError) {
        failure = error;
      } else {
        throw error;
      }
    }

    expect(failure?.code).toBe("claude.tool_result_too_large");
    await rejected.translator.failTurn(
      rejected.context,
      rejected.runId,
      failure!.code,
      failure!.message,
    );
    expect(
      rejected.events.some(
        (event) =>
          event.kind === "tool.call.updated" &&
          payload(event)["toolCallId"] === "tool-oversized" &&
          payload(event)["status"] === "completed",
      ),
    ).toBe(false);
    expect(
      rejected.events.some(
        (event) =>
          event.kind === "tool.call.updated" &&
          payload(event)["toolCallId"] === "tool-oversized" &&
          payload(event)["status"] === "failed",
      ),
    ).toBe(true);
    expect(
      payload(rejected.events.find((event) => event.kind === "run.failed")!)["error"],
    ).toMatchObject({ code: "claude.tool_result_too_large" });
    expect(rejected.sseFrameBytes.every((bytes) => bytes < CMA_MAX_EVENT_BYTES)).toBe(true);
  });

  test("rejects an oversized tool input before it can poison terminal delivery", async () => {
    const runId = DRIVER_TEST_IDS.runId;
    const claudeBootPayload = {
      ...driverBootPayload,
      runtime: "claude-agent-sdk",
      runtimeTransport: "claude-agent-sdk",
    } satisfies DriverBootPayload;
    const events: DriverEventInput[] = [];
    const sseFrameBytes: number[] = [];
    const store = createCmaMemoryStore({ sessions: [{ id: DRIVER_TEST_IDS.sessionId }] });
    let activeRunId: RunId | null = runId;
    let sequence = 0;
    const context = createAgentDriverContext({
      eventSink: {
        currentRunId: () => activeRunId,
        pushEvents: async ({ events: batch }) => {
          const envelopes = batch.flatMap((event) =>
            toDriverEventEnvelopes(claudeBootPayload, event, activeRunId),
          );
          for (const envelope of envelopes) {
            const records = await store.appendDriverEvent(
              DRIVER_TEST_IDS.sessionId,
              envelope.event,
            );
            events.push(envelope.event);
            sseFrameBytes.push(...records.map((record) => encodeCmaSseRecord(record).byteLength));
          }
          if (batch.some((event) => event.kind === "run.failed")) {
            activeRunId = null;
          }
          return {
            accepted: batch.map((event) => ({
              eventId: event.sourceEventId,
              seq: (sequence += 1),
              type: event.kind,
            })),
          };
        },
      },
      logger: createDisabledLogger(),
      payload: createDriverStartInputFromBootPayload(claudeBootPayload),
      permission: { request: async () => "allow_once" },
    });
    const publisher = new DriverEventPublisher("claude-agent-sdk", () => "native-session-1");
    const translator = new ClaudeAgentSdkMessageTranslator({
      publicToolCallId: (nativeToolCallId) => nativeToolCallId,
      push: (pushContext, reason, batch) => publisher.push(pushContext, reason, batch),
      pushTerminal: (pushContext, reason, closures, terminal) =>
        publisher.pushTerminal(pushContext, reason, closures, terminal),
      recordNativeSessionId: async () => {},
      replaceNativeSessionId: async () => {},
    });

    let failure: ClaudeDurableEventTooLargeError | null = null;
    try {
      await translator.handleSdkMessage(
        context,
        {
          message: {
            content: [
              {
                id: "tool-large-input",
                input: { data: "x".repeat(1_100_000) },
                name: "Write",
                type: "tool_use",
              },
            ],
            id: "assistant-large-input",
          },
          type: "assistant",
          uuid: "wire-large-input",
        } as unknown as SDKMessage,
        runId,
      );
    } catch (error) {
      if (error instanceof ClaudeDurableEventTooLargeError) failure = error;
      else throw error;
    }

    expect(failure?.code).toBe("claude.tool_input_too_large");
    await translator.failTurn(context, runId, failure!.code, failure!.message);
    expect(events.some((event) => event.kind === "run.failed")).toBe(true);
    expect(events.some((event) => payload(event)["rawInput"] !== undefined)).toBe(false);
    expect(sseFrameBytes.every((bytes) => bytes < CMA_MAX_EVENT_BYTES)).toBe(true);
  });

  test("closes a retained background task start before terminal failure", async () => {
    const runId = DRIVER_TEST_IDS.runId;
    const claudeBootPayload = {
      ...driverBootPayload,
      runtime: "claude-agent-sdk",
      runtimeTransport: "claude-agent-sdk",
    } satisfies DriverBootPayload;
    const events: DriverEventInput[] = [];
    let activeRunId: RunId | null = runId;
    let acceptDelivery = false;
    let sequence = 0;
    const context = createAgentDriverContext({
      eventSink: {
        currentRunId: () => activeRunId,
        pushEvents: async ({ events: batch }) => {
          if (!acceptDelivery) return { accepted: [] };
          const envelopes = batch.flatMap((event) =>
            toDriverEventEnvelopes(claudeBootPayload, event, activeRunId),
          );
          events.push(...envelopes.map(({ event }) => event));
          if (batch.some((event) => event.kind === "run.failed")) activeRunId = null;
          return {
            accepted: envelopes.map((envelope) => ({
              eventId: envelope.eventId,
              seq: (sequence += 1),
              type: envelope.event.kind,
            })),
          };
        },
      },
      logger: createDisabledLogger(),
      payload: createDriverStartInputFromBootPayload(claudeBootPayload),
      permission: { request: async () => "allow_once" },
    });
    const publisher = new DriverEventPublisher("claude-agent-sdk", () => "native-session-1");
    const translator = new ClaudeAgentSdkMessageTranslator({
      publicToolCallId: (nativeToolCallId) => nativeToolCallId,
      push: (pushContext, reason, batch) => publisher.push(pushContext, reason, batch),
      pushTerminal: (pushContext, reason, closures, terminal) =>
        publisher.pushTerminal(pushContext, reason, closures, terminal),
      recordNativeSessionId: async () => {},
      replaceNativeSessionId: async () => {},
    });

    await expect(
      translator.handleSdkMessage(
        context,
        {
          session_id: "native-session-1",
          subtype: "background_tasks_changed",
          tasks: [
            {
              description: "Inspect the repository",
              task_id: "task-1",
              task_type: "local_agent",
            },
          ],
          type: "system",
          uuid: "00000000-0000-0000-0000-000000000001",
        } as unknown as SDKMessage,
        runId,
      ),
    ).rejects.toThrow();

    acceptDelivery = true;
    await translator.failTurn(context, runId, "claude.task_delivery_failed", "delivery failed");

    expect(
      events
        .filter((event) => event.kind === "agent.tasks.replaced")
        .map((event) => payload(event)),
    ).toMatchObject([{ tasks: [{ taskId: "task-1" }] }, { tasks: [] }]);
    expect(events.at(-1)?.kind).toBe("run.failed");
  });

  test("maps oversized native tool IDs and rejects oversized tool names before durable state", async () => {
    const accepted = createCmaHarness();
    const nativeToolCallId = `tool-${"x".repeat(1_100_000)}`;

    await accepted.translator.handleSdkMessage(
      accepted.context,
      {
        message: {
          content: [{ id: nativeToolCallId, input: {}, name: "Read", type: "tool_use" }],
          id: "assistant-long-tool",
        },
        type: "assistant",
        uuid: "wire-long-tool",
      } as unknown as SDKMessage,
      accepted.runId,
    );
    await accepted.translator.handleSdkMessage(
      accepted.context,
      {
        decision_reason: "Blocked by policy",
        message: "Denied by policy",
        subtype: "permission_denied",
        tool_name: "Read",
        tool_use_id: nativeToolCallId,
        type: "system",
        uuid: "wire-long-tool-advisory",
      } as unknown as SDKMessage,
      accepted.runId,
    );
    await accepted.translator.handleSdkMessage(
      accepted.context,
      {
        is_error: false,
        modelUsage: {},
        permission_denials: [{ tool_input: {}, tool_name: "Read", tool_use_id: nativeToolCallId }],
        result: "done",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: {},
        uuid: "wire-long-tool-result",
      } as unknown as SDKMessage,
      accepted.runId,
    );

    const toolEvents = accepted.events.filter(
      (event) => event.kind === "item.started" || event.kind === "tool.call.updated",
    );
    const publicIds = toolEvents.flatMap((event) => {
      const value = payload(event)[event.kind === "item.started" ? "itemId" : "toolCallId"];
      return typeof value === "string" ? [value] : [];
    });
    expect(new Set(publicIds).size).toBe(1);
    expect(publicIds[0]).not.toBe(nativeToolCallId);
    expect(
      accepted.events.some(
        (event) =>
          event.kind === "tool.call.updated" &&
          payload(event)["decisionReason"] === "Blocked by policy",
      ),
    ).toBe(true);
    expect(JSON.stringify(accepted.events)).not.toContain(nativeToolCallId);
    expect(accepted.sseFrameBytes.every((bytes) => bytes < CMA_MAX_EVENT_BYTES)).toBe(true);

    const rejected = createCmaHarness();
    const oversizedName = "n".repeat(1_100_000);
    let failure: ClaudeDurableEventTooLargeError | null = null;
    try {
      await rejected.translator.handleSdkMessage(
        rejected.context,
        {
          message: {
            content: [{ id: "tool-long-name", input: {}, name: oversizedName, type: "tool_use" }],
            id: "assistant-long-name",
          },
          type: "assistant",
          uuid: "wire-long-name",
        } as unknown as SDKMessage,
        rejected.runId,
      );
    } catch (error) {
      if (error instanceof ClaudeDurableEventTooLargeError) failure = error;
      else throw error;
    }
    expect(failure?.code).toBe("claude.tool_start_too_large");
    await rejected.translator.failTurn(
      rejected.context,
      rejected.runId,
      failure!.code,
      failure!.message,
    );
    expect(rejected.events.some((event) => event.kind === "item.started")).toBe(false);
    expect(
      payload(rejected.events.find((event) => event.kind === "run.failed")!)["error"],
    ).toMatchObject({ code: "claude.tool_start_too_large" });
    expect(JSON.stringify(rejected.events)).not.toContain(oversizedName);
  });

  test("rejects oversized file paths before publishing a partial durable batch", async () => {
    const harness = createCmaHarness();
    let failure: ClaudeDurableEventTooLargeError | null = null;
    try {
      await harness.translator.handleSdkMessage(
        harness.context,
        {
          failed: [],
          files: [{ filename: "f".repeat(1_100_000) }],
          subtype: "files_persisted",
          type: "system",
        } as unknown as SDKMessage,
        harness.runId,
      );
    } catch (error) {
      if (error instanceof ClaudeDurableEventTooLargeError) failure = error;
      else throw error;
    }
    expect(failure?.code).toBe("claude.files_persisted_too_large");
    await harness.translator.failTurn(
      harness.context,
      harness.runId,
      failure!.code,
      failure!.message,
    );
    expect(harness.events.some((event) => event.kind === "file.change.updated")).toBe(false);
    expect(
      payload(harness.events.find((event) => event.kind === "run.failed")!)["error"],
    ).toMatchObject({ code: "claude.files_persisted_too_large" });
    expect(harness.sseFrameBytes.every((bytes) => bytes < CMA_MAX_EVENT_BYTES)).toBe(true);
  });

  test("bounds mirror errors and commits thought and retraction state only after delivery", async () => {
    const mirror = createCmaHarness();
    await mirror.translator.handleSdkMessage(
      mirror.context,
      {
        error: "x".repeat(525_000),
        key: { subpath: "events.jsonl" },
        subtype: "mirror_error",
        type: "system",
        uuid: "mirror-large",
      } as unknown as SDKMessage,
      mirror.runId,
    );
    const diagnostic = mirror.events.find((event) => event.kind === "diagnostic.reported");
    expect(diagnostic?.delivery).toBe("best_effort");
    expect(payload(diagnostic!)).toEqual({
      message: "Claude transcript mirror write failed.",
      raw: { errorBytes: 525_000, kind: "claude.mirror_error" },
      severity: "error",
    });
    expect(mirror.sseFrameBytes.every((bytes) => bytes < CMA_MAX_EVENT_BYTES)).toBe(true);

    const reasons: string[] = [];
    const replayedEvents: DriverEventInput[] = [];
    let rejectThought = true;
    let rejectToolRetraction = true;
    const runId = createDriverId() as RunId;
    const context = createAgentDriverContext({
      eventSink: { currentRunId: () => runId, pushEvents: async () => ({ accepted: [] }) },
      logger: createDisabledLogger(),
      payload: bootPayload,
      permission: { request: async () => "allow_once" },
    });
    const translator = new ClaudeAgentSdkMessageTranslator({
      publicToolCallId: (nativeToolCallId) => nativeToolCallId,
      push: async (_context, reason, events) => {
        reasons.push(reason);
        if (reason === "driver.claude.thought.completed" && rejectThought) {
          rejectThought = false;
          throw new Error("thought delivery failed");
        }
        if (reason === "driver.claude.tool.retracted" && rejectToolRetraction) {
          rejectToolRetraction = false;
          throw new Error("tool retraction failed");
        }
        replayedEvents.push(...events);
      },
      pushTerminal: async () => {},
      recordNativeSessionId: async () => {},
      replaceNativeSessionId: async () => {},
    });

    await translator.handleSdkMessage(
      context,
      {
        event: {
          content_block: { thinking: "", type: "thinking" },
          index: 0,
          type: "content_block_start",
        },
        type: "stream_event",
        uuid: "thought-wire",
      } as unknown as SDKMessage,
      runId,
    );
    const messageStop = {
      event: { type: "message_stop" },
      type: "stream_event",
      uuid: "thought-wire",
    } as unknown as SDKMessage;
    await expect(translator.handleSdkMessage(context, messageStop, runId)).rejects.toThrow(
      "thought delivery failed",
    );
    await expect(translator.handleSdkMessage(context, messageStop, runId)).resolves.toBe(false);
    expect(reasons.filter((reason) => reason === "driver.claude.thought.completed")).toHaveLength(
      2,
    );

    await translator.handleSdkMessage(
      context,
      {
        message: {
          content: [
            { text: "stale", type: "text" },
            { id: "tool-stale", input: {}, name: "Read", type: "tool_use" },
          ],
          id: "assistant-stale",
        },
        type: "assistant",
        uuid: "wire-stale",
      } as unknown as SDKMessage,
      runId,
    );
    const fallback = {
      retracted_message_uuids: ["wire-stale"],
      subtype: "model_refusal_fallback",
      type: "system",
      uuid: "fallback",
    } as unknown as SDKMessage;
    await expect(translator.handleSdkMessage(context, fallback, runId)).rejects.toThrow(
      "tool retraction failed",
    );
    await expect(translator.handleSdkMessage(context, fallback, runId)).resolves.toBe(false);
    expect(
      replayedEvents.filter(
        (event) => event.kind === "message.cancelled" && payload(event)["reason"] === "superseded",
      ),
    ).toHaveLength(1);
    expect(
      replayedEvents.filter(
        (event) =>
          event.kind === "tool.call.updated" &&
          payload(event)["toolCallId"] === "tool-stale" &&
          payload(event)["status"] === "cancelled",
      ),
    ).toHaveLength(1);
  });
});
