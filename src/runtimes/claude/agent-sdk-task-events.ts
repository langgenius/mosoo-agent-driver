import { createHash } from "node:crypto";

import type { SDKBackgroundTasksChangedMessage } from "@anthropic-ai/claude-agent-sdk";

import type { DriverEventInput } from "../../protocol/events";
import { assertClaudeDurableEventFits } from "./agent-sdk-event-writer";

interface ClaudeBackgroundTask {
  readonly taskType?: string | undefined;
  readonly title?: string | undefined;
}

export interface ClaudeTaskProjection {
  readonly beforePublish: (index: number) => void;
  readonly commit: () => void;
  readonly commitAccepted: (index: number) => void;
  readonly events: readonly DriverEventInput[];
}

const MAX_CLAUDE_TASK_ID_BYTES = 256;
const MAX_CLAUDE_BACKGROUND_TASK_ENTRIES = 1_024;
const MAX_CLAUDE_TASK_TEXT_LENGTH = 4_096;
const MAX_CLAUDE_VISIBLE_BACKGROUND_TASKS = 256;
const EMPTY_CLAUDE_TASK_PROJECTION: ClaudeTaskProjection = {
  beforePublish: () => {},
  commit: () => {},
  commitAccepted: () => {},
  events: [],
};

function rejectedTaskSnapshot(code: string, taskCount: number): ClaudeTaskProjection {
  const event: DriverEventInput = {
    delivery: "best_effort",
    kind: "diagnostic.reported",
    payload: {
      code,
      details: { taskCount },
      message: "Claude background task snapshot exceeded the supported task bound.",
      severity: "warn",
      source: "claude",
    },
    visibility: "owner_debug",
  };
  assertClaudeDurableEventFits(event, code, "background task snapshot diagnostic");
  return { ...EMPTY_CLAUDE_TASK_PROJECTION, events: [event] };
}

function publicTaskId(nativeTaskId: string): string | null {
  const bytes = Buffer.byteLength(nativeTaskId, "utf8");
  if (bytes === 0) {
    return null;
  }
  return bytes <= MAX_CLAUDE_TASK_ID_BYTES
    ? nativeTaskId
    : `claude-task:${createHash("sha256").update(nativeTaskId).digest("hex")}`;
}

function boundedTaskText(value: string): string | undefined {
  const text = value.slice(0, MAX_CLAUDE_TASK_TEXT_LENGTH);
  const finalCodeUnit = text.charCodeAt(text.length - 1);
  const bounded = finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? text.slice(0, -1) : text;
  return bounded.length === 0 ? undefined : bounded;
}

function taskEvent(taskId: string, payload: Record<string, unknown>): DriverEventInput {
  const event: DriverEventInput = {
    delivery: "lossless",
    kind: "agent.task.updated",
    payload: { taskId, ...payload },
  };
  assertClaudeDurableEventFits(event, "claude.task_update_too_large", "task update");
  return event;
}

export class ClaudeAgentSdkTaskEvents {
  #backgroundTasks = new Map<string, ClaudeBackgroundTask>();

  reset(): void {
    this.#backgroundTasks.clear();
  }

  prepare(message: SDKBackgroundTasksChangedMessage): ClaudeTaskProjection {
    if (message.tasks.length > MAX_CLAUDE_BACKGROUND_TASK_ENTRIES) {
      return rejectedTaskSnapshot(
        "claude.background_tasks_snapshot_too_large",
        message.tasks.length,
      );
    }

    const next = new Map<string, ClaudeBackgroundTask>();
    for (const task of message.tasks) {
      if (task.ambient === true) {
        continue;
      }
      if (next.size >= MAX_CLAUDE_VISIBLE_BACKGROUND_TASKS) {
        return rejectedTaskSnapshot(
          "claude.visible_background_tasks_too_many",
          message.tasks.length,
        );
      }
      const taskId = publicTaskId(task.task_id);
      if (taskId !== null) {
        next.set(taskId, {
          taskType: boundedTaskText(task.task_type),
          title: boundedTaskText(task.description),
        });
      }
    }

    const changes: Array<{
      readonly optimistic: boolean;
      readonly task: ClaudeBackgroundTask | null;
      readonly taskId: string;
    }> = [];
    const events: DriverEventInput[] = [];
    const working = new Map(this.#backgroundTasks);
    const add = (
      event: DriverEventInput,
      taskId: string,
      task: ClaudeBackgroundTask | null,
      optimistic = false,
    ): void => {
      events.push(event);
      changes.push({ optimistic, task, taskId });
    };

    for (const taskId of this.#backgroundTasks.keys()) {
      if (!next.has(taskId)) {
        working.delete(taskId);
        add(taskEvent(taskId, { active: false }), taskId, null);
      }
    }

    for (const [taskId, task] of next) {
      const previous = working.get(taskId);
      const normalizedTask = {
        taskType: task.taskType ?? previous?.taskType,
        title: task.title ?? previous?.title,
      };
      next.set(taskId, normalizedTask);
      if (previous === undefined) {
        working.set(taskId, normalizedTask);
        add(
          taskEvent(taskId, {
            active: true,
            ...(normalizedTask.taskType === undefined ? {} : { taskType: normalizedTask.taskType }),
            ...(normalizedTask.title === undefined ? {} : { title: normalizedTask.title }),
          }),
          taskId,
          normalizedTask,
          true,
        );
        continue;
      }

      const patch: Record<string, unknown> = {};
      if (normalizedTask.taskType !== undefined && previous.taskType !== normalizedTask.taskType) {
        patch["taskType"] = normalizedTask.taskType;
      }
      if (normalizedTask.title !== undefined && previous.title !== normalizedTask.title) {
        patch["title"] = normalizedTask.title;
      }
      if (Object.keys(patch).length > 0) {
        working.set(taskId, normalizedTask);
        add(taskEvent(taskId, patch), taskId, normalizedTask);
      }
    }

    return {
      beforePublish: (index) => {
        const change = changes[index];
        if (change?.optimistic === true && change.task !== null) {
          this.#backgroundTasks.set(change.taskId, change.task);
        }
      },
      commit: () => {
        this.#backgroundTasks = next;
      },
      commitAccepted: (index) => {
        const change = changes[index];
        if (change !== undefined) {
          if (change.task === null) this.#backgroundTasks.delete(change.taskId);
          else this.#backgroundTasks.set(change.taskId, change.task);
        }
      },
      events,
    };
  }

  prepareClosure(): ClaudeTaskProjection {
    const taskIds = [...this.#backgroundTasks.keys()];
    const events = taskIds.map((taskId) => taskEvent(taskId, { active: false }));

    return {
      beforePublish: () => {},
      commit: () => {
        this.#backgroundTasks.clear();
      },
      commitAccepted: (index) => {
        const taskId = taskIds[index];
        if (taskId !== undefined) this.#backgroundTasks.delete(taskId);
      },
      events,
    };
  }
}
