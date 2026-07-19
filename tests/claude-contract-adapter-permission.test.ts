import { describe, expect, test } from "bun:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

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
  test("bounds pending permission payloads and restores budget after resolution", async () => {
    const input = { command: "pwd" };
    const firstOptions = permissionOptions("request-1", "tool-1");
    const secondOptions = permissionOptions("request-2", "tool-2");
    const maxPendingPermissionBytes = permissionBytes(input, firstOptions);
    const harness = createHarness(5 * 60 * 1_000, undefined, maxPendingPermissionBytes);
    await registerRun(harness.adapter);
    const interactionId = await harness.adapter.openPermission(RUN_ID, "Bash", input, firstOptions);
    const authorityCount = harness.authority.length;

    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", input, secondOptions),
    ).rejects.toThrow("pending permission budget");
    expect(harness.authority).toHaveLength(authorityCount);

    const resolution = {
      kind: "permission",
      value: { type: "cancelled" },
    } satisfies InteractionResolution;
    harness.settleInteraction(interactionId, resolution);
    await harness.adapter.resolveInteraction(interactionId, resolution);
    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", input, secondOptions),
    ).resolves.toBeDefined();
  });

  test("reserves permission budget before the first Authority await", async () => {
    const input = { command: "pwd" };
    const firstOptions = permissionOptions("request-concurrent-1", "tool-concurrent-1");
    const secondOptions = permissionOptions("request-concurrent-2", "tool-concurrent-2");
    const firstAuthority = Promise.withResolvers<void>();
    const releaseAuthority = Promise.withResolvers<void>();
    let toolCommits = 0;
    const harness = createHarness(
      5 * 60 * 1_000,
      undefined,
      permissionBytes(input, firstOptions),
      async (update) => {
        if (update.event === "permission/requested.tool" && ++toolCommits === 1) {
          firstAuthority.resolve();
          await releaseAuthority.promise;
        }
      },
    );
    await registerRun(harness.adapter);
    const first = harness.adapter.openPermission(RUN_ID, "Bash", input, firstOptions);
    await firstAuthority.promise;

    try {
      await expect(
        harness.adapter.openPermission(RUN_ID, "Bash", input, secondOptions),
      ).rejects.toThrow("pending permission budget");
    } finally {
      releaseAuthority.resolve();
    }

    await expect(first).resolves.toBeDefined();
    expect(toolCommits).toBe(1);
  });

  test("rolls back a permission reservation when Authority rejects it", async () => {
    const input = { command: "pwd" };
    const firstOptions = permissionOptions("request-failed", "tool-failed");
    const secondOptions = permissionOptions("request-retry", "tool-retry");
    let rejectNext = true;
    const harness = createHarness(
      5 * 60 * 1_000,
      undefined,
      permissionBytes(input, firstOptions),
      (update) => {
        if (rejectNext && update.event === "permission/requested.tool") {
          rejectNext = false;
          throw new Error("Authority unavailable");
        }
      },
    );
    await registerRun(harness.adapter);

    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", input, firstOptions),
    ).rejects.toThrow("Authority unavailable");
    await expect(
      harness.adapter.openPermission(RUN_ID, "Bash", input, secondOptions),
    ).resolves.toBeDefined();
  });

  test.each(["permission/requested.tool", "permission/requested"] as const)(
    "retries the exact %s write after an unknown Authority outcome",
    async (event) => {
      const writes: ContractAuthorityUpdate[] = [];
      const harness = createHarness(5 * 60 * 1_000, undefined, undefined, (update) => {
        if (update.event !== event) {
          return;
        }

        writes.push(update);
        if (writes.length === 1) {
          throw new AuthorityOutcomeUnknownError("Authority response was lost");
        }
      });
      await registerRun(harness.adapter);

      await expect(
        harness.adapter.openPermission(
          RUN_ID,
          "Bash",
          { command: "pwd" },
          permissionOptions(`request-unknown-${event}`, `tool-unknown-${event}`),
        ),
      ).resolves.toBeDefined();

      expect(writes).toHaveLength(2);
      expect(writes[1]?.mutationId).toBe(writes[0]?.mutationId);
      expect(writes[1]?.operations).toEqual(writes[0]?.operations);
      expect(harness.snapshot().interactions).toHaveLength(1);
    },
  );

  test("coalesces concurrent redelivery of the same permission request", async () => {
    const input = { command: "pwd" };
    const options = permissionOptions("request-redelivered", "tool-redelivered");
    const firstAuthority = Promise.withResolvers<void>();
    const releaseAuthority = Promise.withResolvers<void>();
    let toolCommits = 0;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "permission/requested.tool" && ++toolCommits === 1) {
        firstAuthority.resolve();
        await releaseAuthority.promise;
      }
    });
    await registerRun(harness.adapter);
    const first = harness.adapter.openPermission(RUN_ID, "Bash", input, options);
    await firstAuthority.promise;
    const replay = harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { ...input },
      {
        ...options,
        signal: new AbortController().signal,
      },
    );
    releaseAuthority.resolve();

    const [interactionId, replayedInteractionId] = await Promise.all([first, replay]);
    expect(replayedInteractionId).toBe(interactionId);
    expect(toolCommits).toBe(1);
    expect(harness.snapshot().interactions).toHaveLength(1);
  });

  test("cancels an opening permission when a replay signal aborts", async () => {
    const interactionWriting = Promise.withResolvers<void>();
    const releaseInteraction = Promise.withResolvers<void>();
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, async (update) => {
      if (update.event === "permission/requested") {
        interactionWriting.resolve();
        await releaseInteraction.promise;
      }
    });
    await registerRun(harness.adapter);
    const firstController = new AbortController();
    const replayController = new AbortController();
    const options = {
      ...permissionOptions("request-opening-replay", "tool-opening-replay"),
      signal: firstController.signal,
    };
    const first = harness.adapter.openPermission(RUN_ID, "Bash", { command: "pwd" }, options);
    await interactionWriting.promise;
    const replay = harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { command: "pwd" },
      {
        ...options,
        signal: replayController.signal,
      },
    );

    replayController.abort();
    releaseInteraction.resolve();

    expect(await Promise.allSettled([first, replay])).toMatchObject([
      { reason: { name: "AbortError" }, status: "rejected" },
      { reason: { name: "AbortError" }, status: "rejected" },
    ]);
    expect(harness.snapshot().interactions).toMatchObject([
      { resolution: { type: "cancelled" }, status: "resolved" },
    ]);
  });

  test("does not allow a pending permission after a replay signal aborts", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    const options = permissionOptions("request-pending-replay", "tool-pending-replay");
    const interactionId = await harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { command: "pwd" },
      options,
    );
    const replayController = new AbortController();
    await harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { command: "pwd" },
      {
        ...options,
        signal: replayController.signal,
      },
    );
    const interaction = harness.snapshot().interactions[0];
    const allowOnceId =
      interaction?.kind === "permission"
        ? interaction.request.options.find(
            (option) => option.effect === "allow" && option.scope === "once",
          )?.id
        : undefined;

    replayController.abort();
    await expect(
      harness.adapter.resolveInteraction(interactionId, {
        kind: "permission",
        value: { optionId: allowOnceId!, type: "selected" },
      }),
    ).resolves.toBeNull();
    expect(harness.snapshot().interactions[0]).toMatchObject({
      resolution: { type: "cancelled" },
      status: "resolved",
    });
  });

  test("rejects an already-aborted permission without creating Authority state", async () => {
    const harness = createHarness();
    await registerRun(harness.adapter);
    const controller = new AbortController();
    controller.abort();

    await expect(
      harness.adapter.openPermission(
        RUN_ID,
        "Bash",
        { command: "pwd" },
        {
          requestId: "request-aborted",
          signal: controller.signal,
          toolUseID: "tool-aborted",
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.authority).toHaveLength(0);
    expect(harness.snapshot().items).toHaveLength(0);
    expect(harness.snapshot().interactions).toHaveLength(0);
  });

  test("resolves and releases a pending permission when its SDK signal aborts", async () => {
    const input = { command: "pwd" };
    const controller = new AbortController();
    const options = {
      ...permissionOptions("request-abort-pending", "tool-abort-pending"),
      signal: controller.signal,
    };
    const harness = createHarness(5 * 60 * 1_000, undefined, permissionBytes(input, options));
    await registerRun(harness.adapter);
    const interactionId = await harness.adapter.openPermission(RUN_ID, "Bash", input, options);

    controller.abort();
    await expect(
      harness.adapter.resolveInteraction(interactionId, {
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
      harness.adapter.openPermission(
        RUN_ID,
        "Bash",
        input,
        permissionOptions("request-abort-reuse", "tool-abort-reuse"),
      ),
    ).resolves.toBeDefined();
  });

  test("retries an aborted permission after a rejected Authority write", async () => {
    const controller = new AbortController();
    const firstAbort = Promise.withResolvers<void>();
    let rejectAbort = true;
    const harness = createHarness(5 * 60 * 1_000, undefined, undefined, (update) => {
      if (update.event === "permission/aborted" && rejectAbort) {
        rejectAbort = false;
        firstAbort.resolve();
        throw new Error("Authority unavailable");
      }
    });
    await registerRun(harness.adapter);
    const interactionId = await harness.adapter.openPermission(
      RUN_ID,
      "Bash",
      { command: "pwd" },
      {
        requestId: "request-abort-retry",
        signal: controller.signal,
        toolUseID: "tool-abort-retry",
      },
    );

    controller.abort();
    await firstAbort.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.snapshot().interactions[0]?.status).toBe("open");

    await expect(
      harness.adapter.resolveInteraction(interactionId, {
        kind: "permission",
        value: { type: "cancelled" },
      }),
    ).resolves.toBeNull();
    expect(harness.snapshot().interactions[0]).toMatchObject({
      resolution: { type: "cancelled" },
      status: "resolved",
    });
  });
});
