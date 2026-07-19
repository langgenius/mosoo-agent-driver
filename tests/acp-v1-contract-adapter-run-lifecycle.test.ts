import { describe, expect, test } from "bun:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";

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
import { AcpV1ContractAdapter } from "../src/runtimes/acp/v1-contract-adapter";
import {
  type ContractAuthorityUpdate,
  type ContractPreviewUpdate,
} from "../src/runtimes/contract-projection";

const SESSION_ID = protocolId(1);
const RUN_ID = protocolId(2);
const NATIVE_SESSION_ID = "native-session-1";

function protocolId(value: number): string {
  return value.toString().padStart(26, "0");
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
  previewCheckpointBytes?: number,
  maxPendingPermissionBytes?: number,
  beforeAuthority?: (update: ContractAuthorityUpdate) => Promise<void>,
  afterAuthority?: (update: ContractAuthorityUpdate) => Promise<void>,
) {
  let nowMs = Date.parse("2026-07-16T08:00:00.000Z");
  let snapshot = createInitialSnapshot(new Date(nowMs).toISOString());
  let nextId = 100;
  const authority: ContractAuthorityUpdate[] = [];
  const committedMutationIds = new Set<string>();
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
  const adapter = new AcpV1ContractAdapter({
    authority: async (update) => {
      await beforeAuthority?.(update);
      authority.push(update);
      if (!committedMutationIds.has(update.mutationId)) {
        committedMutationIds.add(update.mutationId);
        commit(update.cause, [...update.operations] as AuthorityOperation[]);
      }
      try {
        await afterAuthority?.(update);
      } catch (cause) {
        throw new AuthorityOutcomeUnknownError(
          cause instanceof Error ? cause.message : "Authority outcome is unknown.",
          { cause },
        );
      }
    },
    createId: () => protocolId(nextId++),
    interactionTimeoutMs,
    maxPendingPermissionBytes,
    nativeSessionId: NATIVE_SESSION_ID,
    now: () => new Date(nowMs),
    preview: (update) => previews.push(update),
    previewCheckpointBytes,
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

async function registerRun(adapter: AcpV1ContractAdapter): Promise<void> {
  adapter.attachRun(activeRun("2026-07-16T08:00:00.000Z"));
}

function notification(update: SessionNotification["update"]): SessionNotification {
  return { sessionId: NATIVE_SESSION_ID, update };
}

describe("ACP V1 Contract adapter", () => {
  test("checkpoints full terminal snapshots without retaining or duplicating large Preview text", async () => {
    const harness = createHarness(5 * 60 * 1_000, 5);
    await registerRun(harness.adapter);
    await harness.adapter.registerTerminal(RUN_ID, "terminal-1");
    const beforeCheckpoint = harness.authority.length;

    await harness.adapter.handleTerminalOutput(RUN_ID, "terminal-1", {
      exitStatus: null,
      output: "abcdef",
      truncated: true,
    });
    expect(harness.authority).toHaveLength(beforeCheckpoint + 1);
    expect(harness.previews).toHaveLength(0);
    expect(harness.snapshot().items[0]).toMatchObject({
      kind: "terminal",
      status: "active",
      stdout: [{ text: "abcdef", type: "text" }],
    });

    await harness.adapter.handleTerminalOutput(RUN_ID, "terminal-1", {
      exitStatus: null,
      output: "abcdef",
      truncated: false,
    });
    expect(harness.authority).toHaveLength(beforeCheckpoint + 1);

    await harness.adapter.handleTerminalExit(RUN_ID, "terminal-1", {
      exitCode: 0,
      signal: null,
    });
    expect(harness.snapshot().items[0]).toMatchObject({ kind: "terminal", status: "active" });

    await harness.adapter.completePrompt(RUN_ID, { stopReason: "end_turn" });
    expect(harness.snapshot().items[0]).toMatchObject({
      extensions: {
        "agentclientprotocol.v1/terminal-output": { truncated: true },
      },
      exitCode: 0,
      kind: "terminal",
      status: "completed",
      stdout: [{ text: "abcdef", type: "text" }],
    });
  });

  test("accepts the final terminal snapshot after wait-for-exit resolves", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.registerTerminal(RUN_ID, "terminal-tail");
    await harness.adapter.handleTerminalOutput(RUN_ID, "terminal-tail", {
      exitStatus: null,
      output: "prefix",
      truncated: false,
    });
    await harness.adapter.handleTerminalExit(RUN_ID, "terminal-tail", {
      exitCode: 0,
      signal: null,
    });
    await harness.adapter.handleTerminalOutput(RUN_ID, "terminal-tail", {
      exitStatus: { exitCode: 0, signal: null },
      output: "prefix-tail",
      truncated: false,
    });

    expect(harness.snapshot().items[0]).toMatchObject({
      exitCode: 0,
      kind: "terminal",
      status: "completed",
      stdout: [{ text: "prefix-tail", type: "text" }],
    });
  });

  test("ignores draft v1 plan operations that were not negotiated", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);

    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        plan: {
          entries: [],
          planId: "draft-plan",
          type: "items",
        },
        sessionUpdate: "plan_update",
      }),
    );

    expect(harness.snapshot().items).toHaveLength(0);
  });

  test("honors explicit empty collection replacements in tool updates", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: [
          { content: { text: "temporary", type: "text" }, type: "content" },
          {
            newText: "new",
            oldText: "old",
            path: "/workspace/file.txt",
            type: "diff",
          },
          { terminalId: "terminal-1", type: "terminal" },
        ],
        sessionUpdate: "tool_call",
        title: "Read",
        toolCallId: "tool-1",
      }),
    );
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: [],
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
      }),
    );

    const tool = harness.snapshot().items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({
      kind: "tool",
      output: [],
    });
    expect(tool).not.toHaveProperty("terminalItemId");
    expect(harness.snapshot().items.find((item) => item.kind === "change")).toMatchObject({
      changes: [],
      status: "active",
    });
  });

  test("treats nullable v1 tool patch fields as omitted", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: [
          { content: { text: "kept", type: "text" }, type: "content" },
          {
            newText: "new",
            oldText: "old",
            path: "/workspace/file.txt",
            type: "diff",
          },
          { terminalId: "terminal-1", type: "terminal" },
        ],
        kind: "edit",
        locations: [{ line: 2, path: "/workspace/file.txt" }],
        rawInput: { path: "/workspace/file.txt" },
        rawOutput: { changed: true },
        sessionUpdate: "tool_call",
        title: "Edit",
        toolCallId: "tool-1",
      }),
    );
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: null,
        kind: null,
        locations: null,
        rawInput: null,
        rawOutput: null,
        sessionUpdate: "tool_call_update",
        status: null,
        title: null,
        toolCallId: "tool-1",
      }),
    );

    expect(harness.snapshot().items.find((item) => item.kind === "tool")).toMatchObject({
      category: "edit",
      input: { path: "/workspace/file.txt" },
      locations: [{ line: 2, path: "/workspace/file.txt" }],
      output: [{ text: "kept", type: "text" }],
      status: "active",
      structuredOutput: { changed: true },
      terminalItemId: "terminal:terminal-1",
      title: "Edit",
    });
    expect(harness.snapshot().items.find((item) => item.kind === "change")).toMatchObject({
      changes: [expect.objectContaining({ path: "/workspace/file.txt" })],
      status: "active",
    });
  });

  test.each([
    ["raw output", { rawOutput: { late: true } }, { structuredOutput: { late: true } }],
    [
      "locations",
      { locations: [{ line: 7, path: "/workspace/late.txt" }] },
      { locations: [{ line: 7, path: "/workspace/late.txt" }] },
    ],
    [
      "content",
      { content: [{ content: { text: "late", type: "text" }, type: "content" }] },
      { output: [{ text: "late", type: "text" }] },
    ],
    [
      "terminal reference",
      { content: [{ terminalId: "terminal-late", type: "terminal" }] },
      { terminalItemId: "terminal:terminal-late" },
    ],
  ] as const)("enriches a completed tool with a later %s patch", async (_name, patch, expected) => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        kind: "execute",
        rawInput: { command: "true" },
        sessionUpdate: "tool_call",
        status: "completed",
        title: "Run command",
        toolCallId: "tool-late",
      }),
    );
    const endedAt = harness.snapshot().items.find((item) => item.kind === "tool")?.endedAt;

    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        ...patch,
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-late",
      } as SessionNotification["update"]),
    );

    expect(harness.snapshot().items.find((item) => item.kind === "tool")).toMatchObject({
      category: "execute",
      endedAt,
      input: { command: "true" },
      status: "completed",
      title: "Run command",
      ...expected,
    });
  });

  test("ignores a completed tool replay that carries no new content", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        kind: "execute",
        rawInput: { command: "true" },
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: "Run command",
        toolCallId: "tool-replay",
      }),
    );
    const completed = notification({
      rawOutput: { exitCode: 0 },
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolCallId: "tool-replay",
    });
    await harness.adapter.handleSessionUpdate(RUN_ID, completed);
    const authorityCount = harness.authority.length;

    harness.advance(1_000);
    await expect(harness.adapter.handleSessionUpdate(RUN_ID, completed)).resolves.toBeNull();

    expect(harness.authority).toHaveLength(authorityCount);
    expect(harness.snapshot().items.find((item) => item.kind === "tool")).toMatchObject({
      input: { command: "true" },
      status: "completed",
      structuredOutput: { exitCode: 0 },
    });
  });

  test.each(["completed", "failed"] as const)(
    "propagates status-only %s tool updates to existing file changes",
    async (status) => {
      const harness = createHarness();
      await registerRun(harness.adapter);
      await harness.adapter.handleSessionUpdate(
        RUN_ID,
        notification({
          content: [
            {
              newText: "new",
              oldText: "old",
              path: "/workspace/file.txt",
              type: "diff",
            },
          ],
          sessionUpdate: "tool_call",
          title: "Edit",
          toolCallId: "tool-1",
        }),
      );
      await harness.adapter.handleSessionUpdate(
        RUN_ID,
        notification({
          sessionUpdate: "tool_call_update",
          status,
          toolCallId: "tool-1",
        }),
      );

      expect(harness.snapshot().items.find((item) => item.kind === "change")).toMatchObject({
        changes: [
          {
            diff: {
              type: "json",
              value: { newText: "new", oldText: "old" },
            },
            operation: "update",
            path: "/workspace/file.txt",
          },
        ],
        status,
      });
    },
  );

  test("rejects empty permission choices before creating authority state", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);

    await expect(
      harness.adapter.openPermission(RUN_ID, {
        options: [],
        sessionId: NATIVE_SESSION_ID,
        toolCall: { title: "Read", toolCallId: "tool-1" },
      }),
    ).rejects.toThrow("at least one option");
    expect(harness.snapshot().items).toHaveLength(0);
    expect(harness.snapshot().interactions).toHaveLength(0);
  });

  test.each([Number.POSITIVE_INFINITY, 1.5])("rejects invalid timeout %p", (value) => {
    expect(() => createHarness(value)).toThrow("finite and positive");
  });

  test.each([Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid pending permission limit %p",
    (value) => {
      expect(() => createHarness(5 * 60 * 1_000, undefined, value)).toThrow("finite and positive");
    },
  );
});
