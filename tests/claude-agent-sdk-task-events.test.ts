import { describe, expect, test } from "bun:test";

import type { SDKBackgroundTasksChangedMessage } from "@anthropic-ai/claude-agent-sdk";

import type { DriverEventInput } from "../src/protocol/events";
import { ClaudeAgentSdkTaskEvents } from "../src/runtimes/claude/agent-sdk-task-events";

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

function commit(
  projection: ClaudeAgentSdkTaskEvents,
  message: SDKBackgroundTasksChangedMessage,
): readonly DriverEventInput[] {
  const prepared = projection.prepare(message);
  prepared.commit();
  return prepared.events;
}

describe("Claude Agent SDK task events", () => {
  test("projects replacement snapshots and metadata changes", () => {
    const projection = new ClaudeAgentSdkTaskEvents();

    expect(commit(projection, backgroundTasks([task("task-1")]))).toEqual([
      {
        delivery: "lossless",
        kind: "agent.task.updated",
        payload: {
          active: true,
          taskId: "task-1",
          taskType: "local_agent",
          title: "Inspect the repository",
        },
      },
    ]);
    expect(commit(projection, backgroundTasks([task("task-1")]))).toEqual([]);
    expect(commit(projection, backgroundTasks([task("task-1", "Inspect tests")]))).toEqual([
      {
        delivery: "lossless",
        kind: "agent.task.updated",
        payload: { taskId: "task-1", title: "Inspect tests" },
      },
    ]);
  });

  test("treats removal and ambient changes as visibility, not guessed completion", () => {
    const projection = new ClaudeAgentSdkTaskEvents();
    commit(projection, backgroundTasks([task("task-1")]));

    expect(commit(projection, backgroundTasks([task("task-1", undefined, true)]))).toEqual([
      {
        delivery: "lossless",
        kind: "agent.task.updated",
        payload: { active: false, taskId: "task-1" },
      },
    ]);
    expect(commit(projection, backgroundTasks([task("task-1")]))[0]).toMatchObject({
      payload: { active: true, taskId: "task-1" },
    });
    expect(commit(projection, backgroundTasks([]))).toEqual([
      {
        delivery: "lossless",
        kind: "agent.task.updated",
        payload: { active: false, taskId: "task-1" },
      },
    ]);
  });

  test("bounds visible tasks, IDs, and text", () => {
    const projection = new ClaudeAgentSdkTaskEvents();
    const events = commit(
      projection,
      backgroundTasks(
        Array.from({ length: 256 }, (_, index) =>
          task(index === 0 ? "界".repeat(257) : `task-${index}`, `${"x".repeat(4_095)}😀tail`),
        ),
      ),
    );

    expect(events).toHaveLength(256);
    expect(events[0]?.payload).toMatchObject({
      taskId: expect.stringMatching(/^claude-task:[a-f0-9]{64}$/),
      title: expect.stringMatching(/^x{4095}$/),
    });
    expect(projection.prepareClosure().events).toHaveLength(256);
  });

  test("filters ambient prefixes and omits empty metadata", () => {
    const projection = new ClaudeAgentSdkTaskEvents();
    const ambient = Array.from({ length: 1_023 }, (_, index) =>
      task(`ambient-${index}`, "private", true),
    );

    expect(
      commit(
        projection,
        backgroundTasks([...ambient, { description: "", task_id: "visible", task_type: "" }]),
      ),
    ).toEqual([
      {
        delivery: "lossless",
        kind: "agent.task.updated",
        payload: { active: true, taskId: "visible" },
      },
    ]);

    const oversized = projection.prepare(
      backgroundTasks(Array.from({ length: 257 }, (_, index) => task(`visible-${index}`))),
    );
    expect(oversized.events).toMatchObject([
      {
        kind: "diagnostic.reported",
        payload: { code: "claude.visible_background_tasks_too_many" },
        visibility: "owner_debug",
      },
    ]);
    oversized.commit();
    expect(projection.prepareClosure().events).toHaveLength(1);

    expect(
      projection.prepare(
        backgroundTasks(
          Array.from({ length: 1_025 }, (_, index) => task(`raw-${index}`, "x", true)),
        ),
      ).events,
    ).toMatchObject([
      {
        kind: "diagnostic.reported",
        payload: { code: "claude.background_tasks_snapshot_too_large" },
      },
    ]);
    expect(projection.prepareClosure().events).toHaveLength(1);
  });

  test("retains only the durably accepted prefix", () => {
    const projection = new ClaudeAgentSdkTaskEvents();
    const prepared = projection.prepare(backgroundTasks([task("task-1"), task("task-2")]));

    expect(prepared.events).toHaveLength(2);
    prepared.beforePublish(0);
    prepared.commitAccepted(0);
    expect(projection.prepareClosure().events).toEqual([
      {
        delivery: "lossless",
        kind: "agent.task.updated",
        payload: { active: false, taskId: "task-1" },
      },
    ]);
  });

  test("commits closure only after durable publication", () => {
    const projection = new ClaudeAgentSdkTaskEvents();
    commit(projection, backgroundTasks([task("task-1")]));

    const closure = projection.prepareClosure();
    expect(closure.events).toEqual([
      {
        delivery: "lossless",
        kind: "agent.task.updated",
        payload: { active: false, taskId: "task-1" },
      },
    ]);
    expect(projection.prepareClosure().events).toEqual(closure.events);
    closure.commit();
    expect(projection.prepareClosure().events).toEqual([]);
  });
});
