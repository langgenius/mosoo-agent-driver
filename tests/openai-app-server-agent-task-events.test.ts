import { describe, expect, test } from "bun:test";

import type { DriverEventInput } from "../src/protocol/events";
import { toDriverEventEnvelopes } from "../src/infrastructure/runtime/driver-event-envelope";
import {
  OpenAiAgentTaskState,
  openAiAgentTasksClosedEvent,
  type OpenAiSubAgentActivity,
} from "../src/runtimes/openai/app-server-agent-task-events";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";

function apply(state: OpenAiAgentTaskState, activity: OpenAiSubAgentActivity) {
  const update = state.prepare(activity);

  for (const event of update.events) {
    toDriverEventEnvelopes(driverBootPayload, event, DRIVER_TEST_IDS.runId);
  }
  update.commit();
  return update.events;
}

function tasks(events: readonly DriverEventInput[]) {
  const snapshot = events.find((event) => event.kind === "agent.tasks.replaced");

  if (snapshot === undefined) {
    throw new Error("Expected an OpenAI agent task snapshot.");
  }

  return (snapshot.payload as { tasks: unknown[] }).tasks;
}

describe("OpenAI app-server agent task snapshots", () => {
  test("projects interleaved completion-only activity as full active-set replacements", () => {
    const state = new OpenAiAgentTaskState();
    const activity = (
      agentId: string,
      kind: OpenAiSubAgentActivity["kind"],
    ): OpenAiSubAgentActivity => ({ agentId, agentPath: `/root/${agentId}`, kind });

    expect(tasks(apply(state, activity("agent-1", "started")))).toEqual([
      { taskId: "agent-1", taskType: "openai_subagent", title: "/root/agent-1" },
    ]);
    expect(tasks(apply(state, activity("agent-2", "interacted")))).toHaveLength(2);
    expect(tasks(apply(state, activity("agent-1", "started")))).toHaveLength(2);
    expect(tasks(apply(state, activity("agent-1", "completed")))).toEqual([
      { taskId: "agent-2", taskType: "openai_subagent", title: "/root/agent-2" },
    ]);
    expect(tasks(apply(state, activity("agent-1", "started")))).toEqual([
      { taskId: "agent-2", taskType: "openai_subagent", title: "/root/agent-2" },
    ]);
    expect(tasks(apply(state, activity("agent-1", "interacted")))).toHaveLength(2);
    expect(tasks(apply(state, activity("agent-1", "completed")))).toEqual([
      { taskId: "agent-2", taskType: "openai_subagent", title: "/root/agent-2" },
    ]);
    expect(tasks(apply(state, activity("agent-2", "interrupted")))).toEqual([]);

    state.reset();
    expect(tasks(apply(state, activity("agent-1", "interacted")))).toHaveLength(1);
  });

  test("keeps provider data bounded without truncating active membership", () => {
    const state = new OpenAiAgentTaskState();
    const privateMarker = `private-prompt-${"x".repeat(4_096)}`;
    let events: DriverEventInput[] = [];

    for (let index = 0; index < 256; index += 1) {
      events = apply(state, {
        agentId: `agent-${String(index)}`,
        agentPath: `${privateMarker}-${String(index)}`,
        kind: "started",
      });
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "diagnostic.reported",
        payload: expect.objectContaining({ code: "openai.agent_tasks_snapshot_too_large" }),
      }),
    );
    expect(tasks(events)).toEqual(
      Array.from({ length: 256 }, (_, index) => ({ taskId: `agent-${String(index)}` })),
    );
    expect(JSON.stringify(events)).not.toContain(privateMarker);
  });

  test("recovers an authoritative snapshot after the active set returns below 257", () => {
    const state = new OpenAiAgentTaskState();

    for (let index = 0; index < 256; index += 1) {
      apply(state, {
        agentId: `agent-${String(index)}`,
        agentPath: `/root/agent-${String(index)}`,
        kind: "started",
      });
    }

    const overflow = apply(state, {
      agentId: "agent-256",
      agentPath: "/root/agent-256",
      kind: "started",
    });
    expect(overflow).toEqual([
      expect.objectContaining({
        kind: "diagnostic.reported",
        payload: expect.objectContaining({ code: "openai.visible_agent_tasks_too_many" }),
      }),
    ]);

    const recovered = tasks(
      apply(state, {
        agentId: "agent-0",
        agentPath: "/root/agent-0",
        kind: "completed",
      }),
    );
    expect(recovered).toHaveLength(256);
    expect(recovered).not.toContainEqual(expect.objectContaining({ taskId: "agent-0" }));
    expect(recovered).toContainEqual(expect.objectContaining({ taskId: "agent-256" }));
  });

  test("fails at the bounded active activity-state limit", () => {
    const state = new OpenAiAgentTaskState();

    for (let index = 0; index < 1_024; index += 1) {
      apply(state, {
        agentId: `agent-${String(index)}`,
        agentPath: `/root/agent-${String(index)}`,
        kind: "started",
      });
    }

    expect(() =>
      state.prepare({ agentId: "agent-1024", agentPath: "/root/overflow", kind: "started" }),
    ).toThrow("exceeds 1024");
  });

  test("bounds completed replay protection without letting late starts revive", () => {
    const state = new OpenAiAgentTaskState();

    for (let index = 0; index < 1_024; index += 1) {
      apply(state, {
        agentId: `closed-${String(index)}`,
        agentPath: `/root/closed-${String(index)}`,
        kind: "completed",
      });
    }
    for (let index = 0; index < 1_024; index += 1) {
      expect(
        tasks(
          apply(state, {
            agentId: `closed-${String(index)}`,
            agentPath: `/root/closed-${String(index)}`,
            kind: "started",
          }),
        ),
      ).toEqual([]);
    }

    expect(() =>
      state.prepare({
        agentId: "closed-1024",
        agentPath: "/root/closed-1024",
        kind: "completed",
      }),
    ).toThrow("closed sub-agent count exceeds 1024");
    expect(
      tasks(
        apply(state, {
          agentId: "closed-0",
          agentPath: "/root/closed-0",
          kind: "started",
        }),
      ),
    ).toEqual([]);
  });

  test("uses deterministic bounded IDs and an authoritative empty terminal snapshot", () => {
    const state = new OpenAiAgentTaskState();
    const longId = "agent".repeat(100);
    const first = tasks(
      apply(state, { agentId: longId, agentPath: `${"a".repeat(4_095)}😀`, kind: "started" }),
    );

    state.reset();
    const replay = tasks(
      apply(state, { agentId: longId, agentPath: "/root/replayed", kind: "started" }),
    );
    expect(first[0]).toMatchObject({ taskId: expect.stringMatching(/^rid1_[A-Za-z0-9_-]{43}$/) });
    expect(replay[0]).toMatchObject({ taskId: (first[0] as { taskId: string }).taskId });
    expect((first[0] as { title: string }).title).toHaveLength(4_095);
    expect(openAiAgentTasksClosedEvent()).toEqual({
      delivery: "lossless",
      kind: "agent.tasks.replaced",
      payload: { tasks: [] },
      visibility: "participant",
    });
  });
});
