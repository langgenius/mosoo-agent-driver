import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

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
import { ClaudeAgentSdkDriverBackend } from "../src/runtimes/claude/agent-sdk-driver-backend";
import { ClaudeAgentSdkMessageTranslator } from "../src/runtimes/claude/agent-sdk-message-translator";
import { toRuntimePublicId } from "../src/runtimes/runtime-public-id";
import {
  DriverEventPublisher,
  DriverNativeCheckpointCleanupError,
} from "../src/runtimes/driver-event-publisher";
import { createNativeCheckpoint } from "../src/runtimes/native-checkpoint";
import { CMA_MAX_EVENT_BYTES, encodeCmaSseRecord } from "../src/stores/cma-store";
import { createCmaMemoryStore } from "../src/stores/memory";
import {
  DRIVER_TEST_IDS,
  createTestNativeCheckpoint,
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

function createCmaHarness(ids: { readonly runId?: RunId; readonly sessionId?: SessionId } = {}) {
  const runId = ids.runId ?? (createDriverId() as RunId);
  const sessionId = ids.sessionId ?? (createDriverId() as SessionId);
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
          runtimeId: "claude-agent-sdk",
          sessionId,
        },
        event,
      );
      const records = await store.appendDriverEvent(sessionId, envelope!);
      sseFrameBytes.push(...records.map((record) => encodeCmaSseRecord(record).byteLength));
    }
  };
  const translator = new ClaudeAgentSdkMessageTranslator({
    publicToolCallId: (nativeToolCallId) => toRuntimePublicId(nativeToolCallId, "claude-tool"),
    push: async (_context, _reason, batch) => append(batch),
    pushTerminal: async (_context, _reason, closures, terminal) =>
      append([
        ...closures,
        terminal.kind === "run.completed"
          ? {
              ...terminal,
              payload: {
                ...payload(terminal),
                checkpoint: createTestNativeCheckpoint(runId, "claude-agent-sdk"),
              },
            }
          : terminal,
      ]),
    recordNativeSessionId: async () => {},
    replaceNativeSessionId: async () => {},
    sessionId,
  });

  return { context, events, runId, sessionId, sseFrameBytes, translator };
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
              eventId: event.sourceEventId!,
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
      sessionId: context.payload.execution.run.sessionId,
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
      sessionId: context.payload.execution.run.sessionId,
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
    const replayed = createCmaHarness({ runId: accepted.runId, sessionId: accepted.sessionId });
    const nativeToolCallId = `tool-${"x".repeat(1_100_000)}`;
    const frames = [
      {
        message: {
          content: [{ id: nativeToolCallId, input: {}, name: "Read", type: "tool_use" }],
          id: "assistant-long-tool",
        },
        type: "assistant",
        uuid: "wire-long-tool",
      },
      {
        decision_reason: "Blocked by policy",
        message: "Denied by policy",
        subtype: "permission_denied",
        tool_name: "Read",
        tool_use_id: nativeToolCallId,
        type: "system",
        uuid: "wire-long-tool-advisory",
      },
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
      },
    ] as unknown as SDKMessage[];

    for (const harness of [accepted, replayed]) {
      for (const frame of frames) {
        await harness.translator.handleSdkMessage(harness.context, frame, harness.runId);
      }
    }

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
    expect(replayed.events).toEqual(accepted.events);

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
      sessionId: context.payload.execution.run.sessionId,
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
    await expect(translator.handleSdkMessage(context, messageStop, runId)).resolves.toBeNull();
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
    await expect(translator.handleSdkMessage(context, fallback, runId)).resolves.toBeNull();
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

async function createCheckpointCleanupHarness() {
  const cwd = await mkdtemp(join(tmpdir(), "claude-cleanup-barrier-"));
  const checkpointDirectory = join(cwd, ".state", "native-checkpoints");
  const retainedDirectory = `${checkpointDirectory}.retained`;
  const events: DriverEventInput[] = [];
  const resetAttempts: string[] = [];
  const prompts: SDKUserMessage[] = [];
  const resetQueued = Promise.withResolvers<void>();
  let runId: RunId | null = null;
  let seq = 0;
  let blocked = false;
  let resetHook = async () => {};
  const startInput = {
    ...bootPayload,
    runtime: "claude-agent-sdk" as const,
    runtimeTransport: "claude-agent-sdk" as const,
    execution: {
      ...bootPayload.execution,
      providerOptions: {},
      session: {
        ...bootPayload.execution.session,
        cwd,
        homePath: cwd,
        sharedRootPath: cwd,
      },
    },
  };
  const context = createAgentDriverContext({
    eventSink: {
      currentRunId: () => runId,
      pushEvents: async ({ events: batch }) => {
        for (const event of batch) {
          toDriverEventEnvelopes(
            {
              ...driverBootPayload,
              runtime: "claude-agent-sdk",
              runtimeTransport: "claude-agent-sdk",
            },
            event,
            runId,
          );
          if (event.kind === "run.completed" && event.runId === DRIVER_TEST_IDS.runId) {
            await resetQueued.promise;
            await rename(checkpointDirectory, retainedDirectory);
            await writeFile(checkpointDirectory, "checkpoint cleanup is blocked");
            blocked = true;
          }
          if (event.kind === "runtime.session.reset") {
            resetAttempts.push(event.sourceEventId!);
            // The reset can be attempted only after the acknowledged checkpoint survived cleanup.
            expect(
              await readFile(
                join(checkpointDirectory, DRIVER_TEST_IDS.runId, "session.jsonl"),
                "utf8",
              ),
            ).toBe("native-session-1\n");
            await resetHook();
          }
        }
        events.push(...batch);
        return {
          accepted: batch.map((event) => ({
            eventId: event.sourceEventId!,
            seq: ++seq,
            type: event.kind,
          })),
        };
      },
    },
    logger: createDisabledLogger(),
    payload: startInput,
    permission: { request: async () => "allow_once" },
    ports: { skill: { materialize: async () => [] } },
  });
  const backend = new ClaudeAgentSdkDriverBackend(startInput, {
    createNativeCheckpoint: async ({ root, runId: checkpointRunId, sessionId, signal }) =>
      createNativeCheckpoint({
        root,
        runId: checkpointRunId,
        nativeRef: { runtimeId: "claude-agent-sdk", kind: "claude_session_id", value: sessionId },
        signal,
        write: async (directory) => {
          await writeFile(join(directory, "session.jsonl"), `${sessionId}\n`);
        },
      }),
    restoreNativeCheckpoint: async () => {},
    createQueryOptions: async () => ({}),
    waitForTranscript: async () => true,
    startup: async () => {
      throw new Error("Unexpected prewarm in checkpoint test.");
    },
    query: ({ prompt }) => {
      const output = (async function* () {
        for await (const input of prompt as AsyncIterable<SDKUserMessage>) {
          prompts.push(input);
          const sessionId = prompts.length === 1 ? "native-session-1" : "native-session-2";
          yield {
            message: {
              id: `message-${prompts.length}`,
              role: "assistant",
              content: [{ type: "text", text: "done" }],
            },
            session_id: sessionId,
            type: "assistant",
            uuid: `assistant-${prompts.length}`,
          } as unknown as SDKMessage;
          yield {
            ...successResult({ result: "done" }),
            session_id: sessionId,
            user_message_uuid: input.uuid,
          } as unknown as SDKMessage;
          if (prompts.length === 1) {
            yield {
              new_conversation_id: "native-session-2",
              session_id: sessionId,
              type: "conversation_reset",
              uuid: "cleanup-reset",
            } as unknown as SDKMessage;
            resetQueued.resolve();
          }
        }
      })();
      return Object.assign(output, {
        close: () => {},
        initializationResult: async () => {},
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
          session: { total_cost_usd: 0, model_usage: {} },
        }),
      }) as unknown as Query;
    },
  });
  const unblock = async () => {
    if (blocked) {
      await rm(checkpointDirectory);
      await rename(retainedDirectory, checkpointDirectory);
      blocked = false;
    }
  };
  await backend.start(context, AbortSignal.timeout(2_000));
  return {
    events,
    prompts,
    resetAttempts,
    setResetHook: (hook: () => Promise<void>) => {
      resetHook = hook;
    },
    unblock,
    stop: () => backend.stop(context, "test.stop", AbortSignal.timeout(2_000)),
    run: async (id: RunId) => {
      runId = id;
      try {
        await backend.handleInput(context, { text: "test" }, id);
      } finally {
        runId = null;
      }
    },
    dispose: async () => {
      resetHook = async () => {};
      await unblock();
      try {
        await backend.stop(context, "test.cleanup", AbortSignal.timeout(2_000));
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

describe("Claude acknowledged checkpoint cleanup", () => {
  test("stop keeps queued reset behind failed cleanup and waits for its receipt after retry", async () => {
    const h = await createCheckpointCleanupHarness();
    const resetEntered = Promise.withResolvers<void>();
    const acknowledgeReset = Promise.withResolvers<void>();
    try {
      await expect(h.run(DRIVER_TEST_IDS.runId)).rejects.toBeInstanceOf(
        DriverNativeCheckpointCleanupError,
      );
      expect(h.events.filter((event) => event.kind === "run.completed")).toHaveLength(1);
      expect(h.resetAttempts).toEqual([]);
      await expect(h.stop()).rejects.toBeInstanceOf(DriverNativeCheckpointCleanupError);
      expect(h.resetAttempts).toEqual([]);
      await h.unblock();
      h.setResetHook(async () => {
        resetEntered.resolve();
        await acknowledgeReset.promise;
      });
      let stopped = false;
      const stopping = h.stop().then(() => {
        stopped = true;
      });
      await resetEntered.promise;
      expect(stopped).toBe(false);
      expect(h.events.some((event) => event.kind === "runtime.session.reset")).toBe(false);
      acknowledgeReset.resolve();
      await stopping;
      const reset = h.events.find((event) => event.kind === "runtime.session.reset");
      expect(reset?.runId).toBeNull();
      expect(payload(reset!)).toMatchObject({
        previousCheckpoint: {
          formatVersion: 1,
          runId: DRIVER_TEST_IDS.runId,
          nativeRef: {
            runtimeId: "claude-agent-sdk",
            kind: "claude_session_id",
            value: "native-session-1",
          },
        },
        previousNativeRef: { value: "native-session-1" },
        newNativeRef: { value: "native-session-2" },
      });
      expect(
        h.events
          .filter((event) =>
            ["run.completed", "run.failed", "run.cancelled", "runtime.session.reset"].includes(
              event.kind,
            ),
          )
          .map((event) => event.kind),
      ).toEqual(["run.completed", "runtime.session.reset"]);
      expect(h.prompts).toHaveLength(1);
    } finally {
      acknowledgeReset.resolve();
      await h.dispose();
    }
  });

  test("next input retries cleanup and a rejected reset before admitting another prompt", async () => {
    const h = await createCheckpointCleanupHarness();
    try {
      await expect(h.run(DRIVER_TEST_IDS.runId)).rejects.toBeInstanceOf(
        DriverNativeCheckpointCleanupError,
      );
      await expect(h.run(DRIVER_TEST_IDS.secondRunId)).rejects.toBeInstanceOf(
        DriverNativeCheckpointCleanupError,
      );
      expect(h.prompts).toHaveLength(1);
      expect(h.resetAttempts).toEqual([]);
      expect(
        h.events.some(
          (event) => event.kind === "run.started" && event.runId === DRIVER_TEST_IDS.secondRunId,
        ),
      ).toBe(false);
      await h.unblock();
      h.setResetHook(async () => {
        if (h.resetAttempts.length === 1) throw new Error("reset receipt lost");
      });
      await expect(h.run(DRIVER_TEST_IDS.secondRunId)).rejects.toThrow("reset receipt lost");
      expect(h.prompts).toHaveLength(1);
      expect(
        h.events.some(
          (event) => event.kind === "run.started" && event.runId === DRIVER_TEST_IDS.secondRunId,
        ),
      ).toBe(false);
      await h.run(DRIVER_TEST_IDS.secondRunId);
      expect(h.resetAttempts).toHaveLength(2);
      expect(h.resetAttempts[0]).toBe(h.resetAttempts[1]);
      expect(h.prompts).toHaveLength(2);
      expect(
        h.events
          .filter((event) =>
            [
              "run.started",
              "run.completed",
              "run.failed",
              "run.cancelled",
              "runtime.session.reset",
            ].includes(event.kind),
          )
          .map((event) => event.kind),
      ).toEqual([
        "run.started",
        "run.completed",
        "runtime.session.reset",
        "run.started",
        "run.completed",
      ]);
    } finally {
      await h.dispose();
    }
  });
});
