import { describe, expect, test } from "bun:test";
import type {
  CreateTerminalRequest,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionNotification,
} from "@agentclientprotocol/sdk";

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
import { AcpV1ContractAdapter, toConfigOptions } from "../src/runtimes/acp/v1-contract-adapter";
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
  test("rejects a pre-admitted follower without locking out an explicit retry", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const mutationIds: string[] = [];
    let first = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event !== "session/tool_call") {
        return;
      }

      mutationIds.push(update.mutationId);
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
        throw new AuthorityOutcomeUnknownError("authority result lost");
      }
    });
    await registerRun(harness.adapter);
    const update = notification({
      sessionUpdate: "tool_call",
      status: "in_progress",
      title: "Run command",
      toolCallId: "tool-follower",
    });
    const leader = harness.adapter.handleSessionUpdate(RUN_ID, update);
    await entered.promise;
    const follower = harness.adapter.handleSessionUpdate(RUN_ID, update);
    release.resolve();

    const settled = await Promise.allSettled([leader, follower]);
    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(
      settled.every(
        (result) =>
          result.status === "rejected" && result.reason instanceof AuthorityOutcomeUnknownError,
      ),
    ).toBe(true);
    expect(mutationIds).toHaveLength(1);

    await harness.adapter.handleSessionUpdate(RUN_ID, update);
    expect(mutationIds).toEqual([mutationIds[0], mutationIds[0]]);
  });

  test("coalesces concurrent exact retries of one unknown session update", async () => {
    let first = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (first && update.event === "session/agent_message_chunk") {
        first = false;
        throw new AuthorityOutcomeUnknownError("authority result lost");
      }
    });
    await registerRun(harness.adapter);
    const update = notification({
      content: { text: "x", type: "text" },
      messageId: "message-retry",
      sessionUpdate: "agent_message_chunk",
    });
    await expect(harness.adapter.handleSessionUpdate(RUN_ID, update)).rejects.toBeInstanceOf(
      AuthorityOutcomeUnknownError,
    );

    await Promise.all([
      harness.adapter.handleSessionUpdate(RUN_ID, update),
      harness.adapter.handleSessionUpdate(RUN_ID, update),
    ]);
    await harness.adapter.completePrompt(RUN_ID, { stopReason: "end_turn" });

    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({
        content: [{ text: "x", type: "text" }],
        id: "message:message-retry",
      }),
    );
  });

  test("freezes a permission tool mutation across an unknown exact retry", async () => {
    const mutationIds: string[] = [];
    let first = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event !== "permission/requested.tool") {
        return;
      }

      mutationIds.push(update.mutationId);
      if (first) {
        first = false;
        throw new AuthorityOutcomeUnknownError("authority result lost");
      }
    });
    await registerRun(harness.adapter);
    const request = {
      options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
      sessionId: NATIVE_SESSION_ID,
      toolCall: { title: "Run command", toolCallId: "tool-time" },
    } satisfies RequestPermissionRequest;

    await expect(harness.adapter.openPermission(RUN_ID, request)).rejects.toBeInstanceOf(
      AuthorityOutcomeUnknownError,
    );
    harness.advance(1_000);
    await expect(harness.adapter.openPermission(RUN_ID, request)).resolves.toBeDefined();

    expect(mutationIds).toEqual([mutationIds[0], mutationIds[0]]);
  });

  test("freezes terminal registration across an unknown exact retry", async () => {
    const mutationIds: string[] = [];
    let first = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event !== "terminal/created") {
        return;
      }

      mutationIds.push(update.mutationId);
      if (first) {
        first = false;
        throw new AuthorityOutcomeUnknownError("authority result lost");
      }
    });
    await registerRun(harness.adapter);
    const request = {
      command: "true",
      sessionId: NATIVE_SESSION_ID,
    } satisfies CreateTerminalRequest;

    await expect(
      harness.adapter.registerTerminal(RUN_ID, "terminal-time", request),
    ).rejects.toBeInstanceOf(AuthorityOutcomeUnknownError);
    harness.advance(1_000);
    await expect(harness.adapter.registerTerminal(RUN_ID, "terminal-time", request)).resolves.toBe(
      "terminal:terminal-time",
    );

    expect(mutationIds).toEqual([mutationIds[0], mutationIds[0]]);
  });

  test("drains streamed updates before completing the Run", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "session/agent_message_chunk") {
        blocked.resolve();
        await release.promise;
      }
    });
    await registerRun(harness.adapter);
    const update = harness.adapter.handleSessionUpdate(
      RUN_ID,
      notification({
        content: { text: "last", type: "text" },
        messageId: "message-last",
        sessionUpdate: "agent_message_chunk",
      }),
    );
    await blocked.promise;
    let completed = false;
    const completion = harness.adapter
      .completePrompt(RUN_ID, { stopReason: "end_turn" })
      .then(() => {
        completed = true;
      });
    await Bun.sleep(0);
    const completedBeforeUpdate = completed;

    release.resolve();
    await Promise.all([update, completion]);
    expect(completedBeforeUpdate).toBe(false);
    expect(harness.snapshot().runs[0]?.status).toBe("completed");
    expect(harness.snapshot().items).toContainEqual(
      expect.objectContaining({
        content: [{ text: "last", type: "text" }],
        kind: "message",
        status: "completed",
      }),
    );
  });

  test("drains terminal authority writes before completing the Run", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = createHarness(5 * 60 * 1_000, 5, undefined, async (update) => {
      if (update.event === "preview/replace.checkpoint") {
        blocked.resolve();
        await release.promise;
      }
    });
    await registerRun(harness.adapter);
    await harness.adapter.registerTerminal(RUN_ID, "terminal-1");
    const output = harness.adapter.handleTerminalOutput(RUN_ID, "terminal-1", {
      exitStatus: null,
      output: "abcdef",
      truncated: false,
    });
    await blocked.promise;
    let completed = false;
    const completion = harness.adapter
      .completePrompt(RUN_ID, { stopReason: "end_turn" })
      .then(() => {
        completed = true;
      });
    await Bun.sleep(0);

    expect(completed).toBe(false);
    release.resolve();
    await Promise.all([output, completion]);
    expect(harness.snapshot().runs[0]?.status).toBe("completed");
  });

  test("drains a permission authority write before completing the Run", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "permission/requested") {
        blocked.resolve();
        await release.promise;
      }
    });
    await registerRun(harness.adapter);
    const permission = harness.adapter.openPermission(RUN_ID, {
      options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
      sessionId: NATIVE_SESSION_ID,
      toolCall: { title: "Run command", toolCallId: "tool-last" },
    });
    await blocked.promise;
    let completed = false;
    const completion = harness.adapter
      .completePrompt(RUN_ID, { stopReason: "end_turn" })
      .then(() => {
        completed = true;
      });
    await Bun.sleep(0);

    expect(completed).toBe(false);
    release.resolve();
    await Promise.all([permission, completion]);
    expect(harness.snapshot().runs[0]?.status).toBe("completed");
    expect(harness.snapshot().interactions.every((entry) => entry.status !== "open")).toBe(true);
  });

  test.each([
    [
      "prompt completion",
      (adapter: AcpV1ContractAdapter) => adapter.completePrompt(RUN_ID, { stopReason: "end_turn" }),
    ],
    [
      "session update",
      (adapter: AcpV1ContractAdapter) =>
        adapter.handleSessionUpdate(
          RUN_ID,
          notification({
            content: { text: "late", type: "text" },
            messageId: "late-message",
            sessionUpdate: "agent_message_chunk",
          }),
        ),
    ],
    [
      "terminal output",
      (adapter: AcpV1ContractAdapter) =>
        adapter.handleTerminalOutput(RUN_ID, "terminal-late", {
          exitStatus: null,
          output: "late",
          truncated: false,
        }),
    ],
    [
      "terminal exit",
      (adapter: AcpV1ContractAdapter) =>
        adapter.handleTerminalExit(RUN_ID, "terminal-late", {
          exitCode: 0,
          signal: null,
        }),
    ],
  ] as const)("ignores late %s after the Run is terminal", async (_name, lateEvent) => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    await harness.adapter.registerTerminal(RUN_ID, "terminal-late");
    await harness.adapter.completePrompt(RUN_ID, { stopReason: "end_turn" });
    const before = harness.authority.length;

    await lateEvent(harness.adapter);
    expect(harness.authority).toHaveLength(before);
  });

  test("returns session-scoped updates and rejects the wrong native session", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    const update = {
      configOptions: [],
      sessionUpdate: "config_option_update",
    } satisfies SessionNotification["update"];

    await expect(
      harness.adapter.handleSessionUpdate(RUN_ID, notification(update)),
    ).resolves.toEqual(update);
    await expect(
      harness.adapter.handleSessionUpdate(RUN_ID, {
        sessionId: "other-session",
        update,
      }),
    ).rejects.toThrow("active native session");
  });

  test("maps stable boolean and grouped select options into the Session config", () => {
    const options = [
      {
        currentValue: true,
        id: "auto-approve",
        name: "Auto approve",
        type: "boolean",
      },
      {
        currentValue: "fast",
        id: "model",
        name: "Model",
        options: [
          {
            group: "recommended",
            name: "Recommended",
            options: [{ name: "Fast", value: "fast" }],
          },
        ],
        type: "select",
      },
    ] satisfies SessionConfigOption[];

    expect(toConfigOptions(options)).toEqual([
      {
        id: "auto-approve",
        label: "Auto approve",
        type: "boolean",
        value: true,
      },
      {
        choices: [{ id: "fast", label: "Fast" }],
        extensions: {
          "agentclientprotocol.v1/select-groups": [
            { id: "recommended", label: "Recommended", optionIds: ["fast"] },
          ],
        },
        id: "model",
        label: "Model",
        type: "select",
        value: "fast",
      },
    ]);
  });
});
