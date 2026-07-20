import { describe, expect, test } from "bun:test";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  AuthorityOutcomeUnknownError,
  applyCommittedMutation,
  interactionSchema,
  validateSessionSnapshot,
} from "../src/contract";
import type {
  AuthorityOperation,
  CommittedMutation,
  InteractionResolution,
  Run,
  SessionSnapshot,
} from "../src/contract";
import { ClaudeContractAdapter } from "../src/runtimes/claude/contract-adapter";
import type {
  ContractAuthorityUpdate,
  ContractPreviewUpdate,
} from "../src/runtimes/contract-projection";

const SESSION_ID = protocolId(1);
const RUN_ID = protocolId(2);

function protocolId(value: number): string {
  return value.toString().padStart(26, "0");
}

function sdkMessage(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function activeRun(startedAt: string): Run {
  return {
    id: RUN_ID,
    input: [{ text: "hello", type: "text" }],
    origin: "user",
    startedAt,
    status: "active",
  };
}

function createInitialSnapshot(capturedAt: string): SessionSnapshot {
  return validateSessionSnapshot({
    capturedAt,
    interactions: [],
    items: [],
    protocolVersion: 2,
    revision: 0,
    runs: [activeRun(capturedAt)],
    session: {
      capabilities: {
        "interaction.permission": {},
        "item.artifact": {},
        "item.change": {},
        "item.plan": {},
        "item.reasoning": {},
        "item.terminal": {},
      },
      config: [],
      createdAt: capturedAt,
      id: SESSION_ID,
      status: "open",
      updatedAt: capturedAt,
    },
  });
}

function createHarness(
  interactionTimeoutMs = 5 * 60 * 1_000,
  maxToolInputBytes?: number,
  maxPendingPermissionBytes?: number,
  onAuthority?: (update: ContractAuthorityUpdate) => Promise<void> | void,
) {
  let nowMs = Date.parse("2026-07-16T08:00:00.000Z");
  let snapshot = createInitialSnapshot(new Date(nowMs).toISOString());
  let nextId = 100;
  const authority: ContractAuthorityUpdate[] = [];
  const previews: ContractPreviewUpdate[] = [];
  const commit = (cause: CommittedMutation["cause"], operations: AuthorityOperation[]): void => {
    const revision = snapshot.revision + 1;
    const mutation: CommittedMutation = {
      baseRevision: snapshot.revision,
      cause,
      committedAt: new Date(nowMs).toISOString(),
      mutationId: protocolId(1_000 + revision),
      operations,
      revision,
      sessionId: SESSION_ID,
    };
    snapshot = applyCommittedMutation(snapshot, mutation);
  };
  const adapter = new ClaudeContractAdapter({
    authority: async (update) => {
      authority.push(update);
      await onAuthority?.(update);
      commit(update.cause, [...update.operations] as AuthorityOperation[]);
    },
    createId: () => protocolId(nextId++),
    interactionTimeoutMs,
    maxPendingPermissionBytes,
    maxToolInputBytes,
    now: () => new Date(nowMs),
    preview: (update) => previews.push(update),
    sessionId: SESSION_ID,
  });

  return {
    adapter,
    advance(milliseconds: number) {
      nowMs += milliseconds;
    },
    authority,
    previews,
    settleInteraction(interactionId: string, resolution?: InteractionResolution) {
      const interaction = snapshot.interactions.find((entry) => entry.id === interactionId);

      if (interaction === undefined || interaction.status !== "open") {
        throw new Error("The test interaction must be open.");
      }

      if (resolution !== undefined && resolution.kind !== interaction.kind) {
        throw new Error("The test resolution kind must match the interaction kind.");
      }

      const endedAt = new Date(nowMs).toISOString();
      commit({ commandId: protocolId(2_000 + snapshot.revision + 1), type: "command" }, [
        {
          entity: "interaction",
          op: "put",
          value: interactionSchema.parse(
            resolution === undefined
              ? { ...interaction, endedAt, status: "expired" }
              : {
                  ...interaction,
                  endedAt,
                  resolution: resolution.value,
                  status: "resolved",
                },
          ),
        },
      ]);
    },
    snapshot: () => snapshot,
  };
}

async function registerRun(adapter: ClaudeContractAdapter): Promise<void> {
  adapter.attachRun(activeRun("2026-07-16T08:00:00.000Z"));
}

function permissionOptions(requestId: string, toolUseID: string) {
  return {
    requestId,
    signal: new AbortController().signal,
    title: "Run command?",
    toolUseID,
  } satisfies Parameters<CanUseTool>[2];
}

function permissionBytes(
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
): number {
  return new TextEncoder().encode(
    JSON.stringify({
      input,
      options: Object.fromEntries(Object.entries(options).filter(([name]) => name !== "signal")),
      toolName: "Bash",
    }),
  ).byteLength;
}

describe("Claude Contract adapter", () => {
  test("retries the exact cancelled snapshot after an unknown Authority outcome", async () => {
    const controller = new AbortController();
    const firstAbort = Promise.withResolvers<void>();
    const aborts: ContractAuthorityUpdate[] = [];
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, (update) => {
      if (update.event !== "permission/aborted") {
        return;
      }

      aborts.push(update);
      if (aborts.length === 1) {
        firstAbort.resolve();
        throw new AuthorityOutcomeUnknownError("Authority response was lost");
      }
    });
    await registerRun(harness.adapter);
    const interactionId = await harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { command: "pwd" },
      {
        requestId: "request-abort-unknown",
        signal: controller.signal,
        toolUseID: "tool-abort-unknown",
      },
    );

    controller.abort();
    await firstAbort.promise;
    await Promise.resolve();
    await expect(
      harness.adapter.resolveInteraction(interactionId, {
        kind: "permission",
        value: { type: "cancelled" },
      }),
    ).resolves.toBeNull();

    expect(aborts).toHaveLength(2);
    expect(aborts[1]?.mutationId).toBe(aborts[0]?.mutationId);
    expect(aborts[1]?.operations).toEqual(aborts[0]?.operations);
  });

  test("converges a permission aborted during its opening Authority write", async () => {
    const interactionWriting = Promise.withResolvers<void>();
    const releaseInteraction = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "permission/requested") {
        interactionWriting.resolve();
        await releaseInteraction.promise;
      }
      if (update.event === "permission/aborted") {
        aborted.resolve();
      }
    });
    await registerRun(harness.adapter);
    const controller = new AbortController();
    const opening = harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { command: "pwd" },
      {
        requestId: "request-abort-opening",
        signal: controller.signal,
        toolUseID: "tool-abort-opening",
      },
    );
    await interactionWriting.promise;

    controller.abort();
    releaseInteraction.resolve();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    await aborted.promise;
    expect(harness.snapshot().interactions[0]).toMatchObject({
      resolution: { type: "cancelled" },
      status: "resolved",
    });
  });

  test("retains an opening permission when its cancellation write is rejected", async () => {
    const input = { command: "pwd" };
    const controller = new AbortController();
    const options = {
      ...permissionOptions("request-orphan-1", "tool-orphan-1"),
      signal: controller.signal,
    };
    const interactionWriting = Promise.withResolvers<void>();
    const releaseInteraction = Promise.withResolvers<void>();
    let rejectCancellation = true;
    const requested: ContractAuthorityUpdate[] = [];
    const harness = createHarness(
      5 * 60 * 1_000,
      undefined,
      permissionBytes(input, options),
      async (update) => {
        if (update.event === "permission/requested") {
          requested.push(update);
          interactionWriting.resolve();
          await releaseInteraction.promise;
        }
        if (update.event === "permission/aborted" && rejectCancellation) {
          rejectCancellation = false;
          throw new Error("Authority unavailable");
        }
      },
    );
    await registerRun(harness.adapter);
    const opening = harness.adapter.openPermission(RUN_ID, "Bash", input, options);
    await interactionWriting.promise;

    const retryOptions = permissionOptions("request-orphan-2", "tool-orphan-2");
    controller.abort();
    releaseInteraction.resolve();
    await expect(opening).rejects.toThrow("Authority unavailable");

    const interactionId = harness.snapshot().interactions[0]?.id;
    expect(interactionId).toBeDefined();
    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", input, retryOptions),
    ).rejects.toThrow("pending permission budget");
    expect(requested).toHaveLength(1);
    await expect(
      harness.adapter.resolveInteraction(interactionId!, {
        kind: "permission",
        value: { type: "cancelled" },
      }),
    ).resolves.toBeNull();
    expect(harness.snapshot().interactions[0]).toMatchObject({
      id: interactionId,
      resolution: { type: "cancelled" },
      status: "resolved",
    });
    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", input, retryOptions),
    ).resolves.toBeDefined();
  });

  test("releases an opening permission reservation when its run finishes", async () => {
    const input = { command: "pwd" };
    const options = permissionOptions("request-late", "tool-late");
    const interactionAuthority = Promise.withResolvers<void>();
    const releaseAuthority = Promise.withResolvers<void>();
    const harness = createHarness(
      5 * 60 * 1_000,
      undefined,
      permissionBytes(input, options),
      async (update) => {
        if (update.event === "permission/requested") {
          interactionAuthority.resolve();
          await releaseAuthority.promise;
        }
      },
    );
    await registerRun(harness.adapter);
    const opening = harness.adapter.openPermission(RUN_ID, "Bash", input, options);
    await interactionAuthority.promise;

    const finishing = harness.adapter.handleMessage(
      sdkMessage({
        is_error: false,
        modelUsage: {},
        num_turns: 1,
        permission_denials: [],
        result: "done",
        session_id: "native-session-1",
        stop_reason: "end_turn",
        subtype: "success",
        total_cost_usd: 0,
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: "result-late-permission",
      }),
      RUN_ID,
    );
    releaseAuthority.resolve();
    await finishing;

    await expect(opening).rejects.toThrow("active Run");
    await expect(
      harness.adapter.openPermission(
        RUN_ID,
        "Bash",
        input,
        permissionOptions("request-next", "tool-next"),
      ),
    ).rejects.toThrow("unknown run");
  });

  test("translates a Coordinator expiry without rechecking its local deadline", async () => {
    const harness = createHarness(1_000);
    await registerRun(harness.adapter);
    const interactionId = await harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { command: "pwd" },
      {
        requestId: "request-expired",
        signal: new AbortController().signal,
        toolUseID: "tool-expired",
      },
    );
    harness.advance(1_001);
    harness.settleInteraction(interactionId);

    await expect(
      harness.adapter.resolveInteraction(interactionId, {
        kind: "permission",
        value: { type: "cancelled" },
      }),
    ).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    expect(harness.snapshot().interactions[0]).toMatchObject({ status: "expired" });
  });

  test("turns aborted result frames into a cancelled run and flushes active Preview", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        event: { type: "message_start" },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        event: {
          delta: { text: "partial", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        errors: ["aborted"],
        is_error: true,
        modelUsage: {},
        num_turns: 1,
        permission_denials: [],
        session_id: "native-session-1",
        stop_reason: null,
        subtype: "error_during_execution",
        terminal_reason: "aborted_streaming",
        total_cost_usd: 0,
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: "result-1",
      }),
      RUN_ID,
    );

    expect(harness.snapshot().runs[0]?.status).toBe("cancelled");
    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({
        content: [{ text: "partial", type: "text" }],
        kind: "message",
        status: "cancelled",
      }),
    );
  });

  test("bounds streamed and authoritative tool input and normalizes empty SDK labels", async () => {
    const harness = createHarness(5 * 60 * 1_000, 8);
    await registerRun(harness.adapter);
    await harness.adapter.handleMessage(
      sdkMessage({
        event: {
          content_block: { id: "tool-1", input: {}, name: "", type: "tool_use" },
          index: 0,
          type: "content_block_start",
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        event: {
          delta: { partial_json: '{"payload":"too-large"}', type: "input_json_delta" },
          index: 0,
          type: "content_block_delta",
        },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await harness.adapter.handleMessage(
      sdkMessage({
        event: { index: 0, type: "content_block_stop" },
        parent_tool_use_id: null,
        session_id: "native-session-1",
        type: "stream_event",
        uuid: "assistant-1",
      }),
      RUN_ID,
    );
    await expect(
      harness.adapter.handleMessage(
        sdkMessage({
          message: {
            content: [
              {
                id: "tool-1",
                input: { payload: "authoritative" },
                name: "",
                type: "tool_use",
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "native-session-1",
          type: "assistant",
          uuid: "assistant-1",
        }),
        RUN_ID,
      ),
    ).rejects.toThrow("exceeds its byte limit");

    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({
        input: {},
        kind: "tool",
        name: "Tool",
      }),
    );
  });
});
