import { describe, expect, test } from "bun:test";
import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";

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
  test("retries the exact permission intent after an ambiguous authority result", async () => {
    let failAfterCommit = true;
    const harness = createHarness(
      5 * 60 * 1_000,
      undefined,
      undefined,
      undefined,
      async (update) => {
        if (failAfterCommit && update.event === "permission/requested") {
          failAfterCommit = false;
          throw new Error("ambiguous authority result");
        }
      },
    );
    await registerRun(harness.adapter);
    const request = {
      options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
      sessionId: NATIVE_SESSION_ID,
      toolCall: { title: "Run command", toolCallId: "tool-ambiguous" },
    } satisfies RequestPermissionRequest;

    await expect(harness.adapter.openPermission(RUN_ID, request)).rejects.toThrow("ambiguous");
    const first = harness.authority.filter((update) => update.event === "permission/requested")[0]!;
    harness.advance(1_000);
    await expect(
      harness.adapter.openPermission(RUN_ID, {
        ...request,
        toolCall: { ...request.toolCall, toolCallId: "tool-other" },
      }),
    ).rejects.toBeInstanceOf(AuthorityOutcomeUnknownError);
    await expect(harness.adapter.openPermission(RUN_ID, request)).resolves.toBe(
      (first.operations[0] as { value: { id: string } }).value.id,
    );
    const retries = harness.authority.filter((update) => update.event === "permission/requested");

    expect(retries).toHaveLength(2);
    expect(retries[1]).toEqual(first);
  });

  test.each(["cancelled", "selected"] as const)(
    "coordinates an unknown permission replay after the Interaction is %s",
    async (outcome) => {
      let loseResult = true;
      const request = {
        options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
        sessionId: NATIVE_SESSION_ID,
        toolCall: { title: "Run command", toolCallId: "tool-resolved-unknown" },
      } satisfies RequestPermissionRequest;
      const limit = new TextEncoder().encode(JSON.stringify(request)).byteLength;
      const harness = createHarness(5 * 60 * 1_000, undefined, limit, undefined, async (update) => {
        if (loseResult && update.event === "permission/requested") {
          loseResult = false;
          throw new Error("authority result lost");
        }
      });
      await registerRun(harness.adapter);

      await expect(harness.adapter.openPermission(RUN_ID, request)).rejects.toBeInstanceOf(
        AuthorityOutcomeUnknownError,
      );
      const first = harness.authority.find((update) => update.event === "permission/requested")!;
      const interactionId = (first.operations[0] as { value: { id: string } }).value.id;
      const resolution =
        outcome === "selected"
          ? ({
              kind: "permission",
              value: { optionId: "permission-option:yes", type: "selected" },
            } satisfies InteractionResolution)
          : ({
              kind: "permission",
              value: { type: "cancelled" },
            } satisfies InteractionResolution);
      harness.settleInteraction(interactionId, resolution);
      await expect(harness.adapter.resolveInteraction(interactionId, resolution)).resolves.toEqual(
        outcome === "selected"
          ? { outcome: { optionId: "yes", outcome: "selected" } }
          : { outcome: { outcome: "cancelled" } },
      );
      await expect(
        harness.adapter.openPermission(RUN_ID, {
          ...request,
          toolCall: { ...request.toolCall, toolCallId: "tool-changed" },
        }),
      ).rejects.toBeInstanceOf(AuthorityOutcomeUnknownError);

      harness.advance(1_000);
      await expect(harness.adapter.openPermission(RUN_ID, request)).resolves.toBe(interactionId);
      const retries = harness.authority.filter((update) => update.event === "permission/requested");
      expect(retries).toEqual([first, first]);
      expect(harness.snapshot().interactions.find(({ id }) => id === interactionId)?.status).toBe(
        "resolved",
      );
      await expect(
        harness.adapter.openPermission(RUN_ID, {
          ...request,
          toolCall: { ...request.toolCall, toolCallId: "tool-next-permission" },
        }),
      ).resolves.toBeDefined();
    },
  );

  test("releases a retained permission budget when its unknown retry is definitely rejected", async () => {
    const request = (toolCallId: string) =>
      ({
        options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
        sessionId: NATIVE_SESSION_ID,
        toolCall: { title: "Run command", toolCallId },
      }) satisfies RequestPermissionRequest;
    const first = request("tool-a");
    const second = request("tool-b");
    const limit = new TextEncoder().encode(JSON.stringify(first)).byteLength;
    let rejectRetry = false;
    let loseFirstResult = true;
    const harness = createHarness(
      5 * 60 * 1_000,
      undefined,
      limit,
      async (update) => {
        if (rejectRetry && update.event === "permission/requested") {
          rejectRetry = false;
          throw new Error("authority unavailable");
        }
      },
      async (update) => {
        if (loseFirstResult && update.event === "permission/requested") {
          loseFirstResult = false;
          rejectRetry = true;
          throw new Error("authority result lost");
        }
      },
    );
    await registerRun(harness.adapter);

    await expect(harness.adapter.openPermission(RUN_ID, first)).rejects.toBeInstanceOf(
      AuthorityOutcomeUnknownError,
    );
    await expect(harness.adapter.openPermission(RUN_ID, first)).rejects.toThrow(
      "authority unavailable",
    );
    await expect(harness.adapter.openPermission(RUN_ID, second)).resolves.toBeDefined();
  });

  test("applies the permission byte budget atomically", async () => {
    const request = (toolCallId: string) =>
      ({
        options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
        sessionId: NATIVE_SESSION_ID,
        toolCall: { title: "Run command", toolCallId },
      }) satisfies RequestPermissionRequest;
    const firstRequest = request("tool-aaa");
    const secondRequest = request("tool-bbb");
    const limit = new TextEncoder().encode(JSON.stringify(firstRequest)).byteLength;
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, limit, async () => {
      if (first) {
        first = false;
        blocked.resolve();
        await release.promise;
      }
    });
    await registerRun(harness.adapter);
    const firstPermission = harness.adapter.openPermission(RUN_ID, firstRequest);
    await blocked.promise;
    const secondPermission = harness.adapter.openPermission(RUN_ID, secondRequest);
    let secondState: "pending" | "rejected" | "resolved" = "pending";
    void secondPermission.then(
      () => {
        secondState = "resolved";
      },
      () => {
        secondState = "rejected";
      },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(secondState).toBe("rejected");

    release.resolve();
    await expect(firstPermission).resolves.toBeDefined();
    await expect(secondPermission).rejects.toThrow("pending permission budget");
    expect(harness.snapshot().interactions).toHaveLength(1);
  });

  test.each([
    ["tool", "permission/requested.tool"],
    ["interaction", "permission/requested"],
  ] as const)(
    "releases permission budget after a definite %s Authority rejection",
    async (_stage, failedEvent) => {
      const request = (toolCallId: string) =>
        ({
          options: [{ kind: "allow_once", name: "Allow", optionId: "yes" }],
          sessionId: NATIVE_SESSION_ID,
          toolCall: { title: "Run command", toolCallId },
        }) satisfies RequestPermissionRequest;
      const firstRequest = request("tool-aaa");
      const secondRequest = request("tool-bbb");
      const limit = new TextEncoder().encode(JSON.stringify(firstRequest)).byteLength;
      let fail = true;
      const harness = createHarness(5 * 60 * 1_000, undefined, limit, async (update) => {
        if (fail && update.event === failedEvent) {
          fail = false;
          throw new Error("authority unavailable");
        }
      });
      await registerRun(harness.adapter);

      await expect(harness.adapter.openPermission(RUN_ID, firstRequest)).rejects.toThrow(
        "authority unavailable",
      );
      const interactionId = await harness.adapter.openPermission(RUN_ID, secondRequest);
      const resolution = {
        kind: "permission",
        value: { type: "cancelled" },
      } satisfies InteractionResolution;
      harness.settleInteraction(interactionId, resolution);
      await harness.adapter.resolveInteraction(interactionId, resolution);
      await expect(harness.adapter.openPermission(RUN_ID, firstRequest)).resolves.toBeDefined();
    },
  );

  test("fails queued updates after the first projection failure", async () => {
    let attempts = 0;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "session/agent_message_chunk") {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("authority unavailable");
        }
      }
    });
    await registerRun(harness.adapter);
    const update = (messageId: string) =>
      harness.adapter.handleSessionUpdate(
        RUN_ID,
        notification({
          content: { text: messageId, type: "text" },
          messageId,
          sessionUpdate: "agent_message_chunk",
        }),
      );
    const settled = await Promise.allSettled([update("first"), update("second")]);

    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(attempts).toBe(1);
    await expect(
      harness.adapter.completePrompt(RUN_ID, { stopReason: "end_turn" }),
    ).rejects.toThrow("authority unavailable");
  });

  test("recovers an ambiguous session update after rejecting a changed retry", async () => {
    const mutationIds: string[] = [];
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "session/tool_call") {
        mutationIds.push(update.mutationId);

        if (mutationIds.length === 1) {
          throw new AuthorityOutcomeUnknownError("authority result lost");
        }
      }
    });
    await registerRun(harness.adapter);
    const tool = {
      content: [],
      kind: "execute",
      rawInput: { command: "true" },
      sessionUpdate: "tool_call",
      status: "in_progress",
      title: "Run command",
      toolCallId: "tool-1",
    } satisfies SessionNotification["update"];
    const update = notification(tool);
    await expect(harness.adapter.handleSessionUpdate(RUN_ID, update)).rejects.toThrow(
      "authority result lost",
    );
    harness.advance(1_000);

    await expect(
      harness.adapter.handleSessionUpdate(
        RUN_ID,
        notification({ ...tool, title: "Changed command" }),
      ),
    ).rejects.toThrow("changed while its outcome was unknown");
    expect(mutationIds).toHaveLength(1);

    await harness.adapter.handleSessionUpdate(RUN_ID, update);
    await harness.adapter.completePrompt(RUN_ID, { stopReason: "end_turn" });

    expect(mutationIds).toEqual([mutationIds[0], mutationIds[0]]);
    expect(harness.snapshot().runs[0]?.status).toBe("completed");
  });
});
