import { describe, expect, test } from "bun:test";

import type { SDKBackgroundTasksChangedMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  claudeBackgroundTasksClosedEvent,
  projectClaudeBackgroundTasksSnapshot,
} from "../src/runtimes/claude/agent-sdk-task-events";

function backgroundTasks(
  tasks: SDKBackgroundTasksChangedMessage["tasks"],
): SDKBackgroundTasksChangedMessage {
  return {
    session_id: "session-1",
    subtype: "background_tasks_changed",
    tasks,
    type: "system",
    uuid: "00000000-0000-0000-0000-000000000001",
  };
}

function task(
  taskId: string,
  description = "Inspect the repository",
  ambient = false,
): SDKBackgroundTasksChangedMessage["tasks"][number] {
  return {
    ...(ambient ? { ambient: true } : {}),
    description,
    task_id: taskId,
    task_type: "local_agent",
  };
}

function projection(tasks: SDKBackgroundTasksChangedMessage["tasks"]) {
  return projectClaudeBackgroundTasksSnapshot(backgroundTasks(tasks));
}

function snapshot(tasks: SDKBackgroundTasksChangedMessage["tasks"]) {
  return projection(tasks).snapshot;
}

describe("Claude Agent SDK task snapshots", () => {
  test("projects every SDK snapshot as one complete replacement", () => {
    const initial = {
      delivery: "lossless",
      kind: "agent.tasks.replaced",
      payload: {
        tasks: [
          {
            taskId: "task-1",
            taskType: "local_agent",
            title: "Inspect the repository",
          },
        ],
      },
      visibility: "participant",
    } as const;

    expect(snapshot([task("task-1")])).toEqual(initial);
    expect(snapshot([task("task-1")])).toEqual(initial);
    expect(snapshot([task("task-1", "Inspect tests")])).toEqual({
      ...initial,
      payload: { tasks: [{ ...initial.payload.tasks[0], title: "Inspect tests" }] },
    });
  });

  test("filters ambient tasks and publishes membership removal as an empty snapshot", () => {
    const event = snapshot([task("task-1"), task("ambient-task", "private ambient task", true)]);

    expect(event).toMatchObject({
      kind: "agent.tasks.replaced",
      payload: { tasks: [{ taskId: "task-1" }] },
    });
    expect(JSON.stringify(event)).not.toContain("private");
    expect(snapshot([task("task-1", "private", true)])).toEqual(claudeBackgroundTasksClosedEvent());
  });

  test("bounds task IDs, text, counts, and aggregate event size", () => {
    const bounded = snapshot([
      task("界".repeat(257), `${"x".repeat(4_095)}😀tail`),
      { description: "", task_id: "empty-metadata", task_type: "" },
    ]);
    expect(bounded).toMatchObject({
      payload: {
        tasks: [
          {
            taskId: expect.stringMatching(/^claude-task:[a-f0-9]{64}$/),
            title: expect.stringMatching(/^x{4095}$/),
          },
          { taskId: "empty-metadata" },
        ],
      },
    });

    const maximum = snapshot(Array.from({ length: 256 }, (_, index) => task(`task-${index}`)));
    expect(maximum).toMatchObject({ kind: "agent.tasks.replaced" });
    if (maximum === null) {
      throw new Error("Expected a task replacement snapshot.");
    }
    expect((maximum.payload as { tasks: unknown[] }).tasks).toHaveLength(256);

    expect(
      projection(Array.from({ length: 257 }, (_, index) => task(`visible-${index}`))),
    ).toMatchObject({
      diagnostic: {
        kind: "diagnostic.reported",
        payload: { code: "claude.visible_background_tasks_too_many" },
        visibility: "owner_debug",
      },
      snapshot: null,
    });
    expect(
      projection(Array.from({ length: 1_025 }, (_, index) => task(`ambient-${index}`, "x", true))),
    ).toMatchObject({
      diagnostic: {
        kind: "diagnostic.reported",
        payload: { code: "claude.background_tasks_snapshot_too_large" },
      },
      snapshot: null,
    });
    const oversizedMetadata = projection(
      Array.from({ length: 100 }, (_, index) => ({
        description: "界".repeat(4_096),
        task_id: `large-${index}`,
        task_type: "界".repeat(4_096),
      })),
    );
    expect(oversizedMetadata).toMatchObject({
      diagnostic: {
        kind: "diagnostic.reported",
        payload: { code: "claude.tasks_snapshot_too_large" },
      },
      snapshot: {
        delivery: "lossless",
        kind: "agent.tasks.replaced",
        visibility: "participant",
      },
    });
    if (oversizedMetadata.snapshot === null) {
      throw new Error("Expected an ID-only membership snapshot.");
    }
    expect(
      (oversizedMetadata.snapshot.payload as { tasks: Array<Record<string, unknown>> }).tasks,
    ).toEqual(Array.from({ length: 100 }, (_, index) => ({ taskId: `large-${index}` })));
  });

  test("uses an authoritative empty replacement for turn and process closure", () => {
    expect(claudeBackgroundTasksClosedEvent()).toEqual({
      delivery: "lossless",
      kind: "agent.tasks.replaced",
      payload: { tasks: [] },
      visibility: "participant",
    });
  });
});
