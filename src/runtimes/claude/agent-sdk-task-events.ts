import type { SDKBackgroundTasksChangedMessage } from "@anthropic-ai/claude-agent-sdk";

import type { DriverEventInput } from "../../protocol/events";
import { toRuntimePublicId } from "../runtime-public-id";
import {
  assertClaudeDurableEventFits,
  ClaudeDurableEventTooLargeError,
} from "./agent-sdk-event-writer";

const MAX_CLAUDE_BACKGROUND_TASK_ENTRIES = 1_024;
const MAX_CLAUDE_TASK_TEXT_LENGTH = 4_096;
const MAX_CLAUDE_VISIBLE_BACKGROUND_TASKS = 256;

export interface ClaudeBackgroundTasksProjection {
  readonly diagnostic?: DriverEventInput;
  readonly snapshot?: DriverEventInput;
}

function taskSnapshotDiagnostic(code: string, taskCount: number): DriverEventInput {
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
  return event;
}

function rejectedTaskProjection(code: string, taskCount: number): ClaudeBackgroundTasksProjection {
  return {
    diagnostic: taskSnapshotDiagnostic(code, taskCount),
  };
}

function publicTaskId(nativeTaskId: string): string | null {
  if (nativeTaskId.length === 0) {
    return null;
  }
  return toRuntimePublicId(nativeTaskId, "claude-task");
}

function boundedTaskText(value: string): string | undefined {
  const text = value.slice(0, MAX_CLAUDE_TASK_TEXT_LENGTH);
  const finalCodeUnit = text.charCodeAt(text.length - 1);
  const bounded = finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? text.slice(0, -1) : text;
  return bounded.length === 0 ? undefined : bounded;
}

export function claudeBackgroundTasksClosedEvent(): DriverEventInput {
  return {
    delivery: "lossless",
    kind: "agent.tasks.replaced",
    payload: { tasks: [] },
    visibility: "participant",
  };
}

export function projectClaudeBackgroundTasksSnapshot(
  message: SDKBackgroundTasksChangedMessage,
): ClaudeBackgroundTasksProjection {
  if (message.tasks.length > MAX_CLAUDE_BACKGROUND_TASK_ENTRIES) {
    return rejectedTaskProjection(
      "claude.background_tasks_snapshot_too_large",
      message.tasks.length,
    );
  }

  const tasks = new Map<
    string,
    { readonly taskId: string; readonly taskType?: string; readonly title?: string }
  >();
  for (const task of message.tasks) {
    if (task.ambient === true) {
      continue;
    }

    const taskId = publicTaskId(task.task_id);
    if (taskId === null) {
      continue;
    }

    const taskType = boundedTaskText(task.task_type);
    const title = boundedTaskText(task.description);
    tasks.set(taskId, {
      taskId,
      ...(taskType === undefined ? {} : { taskType }),
      ...(title === undefined ? {} : { title }),
    });
    if (tasks.size > MAX_CLAUDE_VISIBLE_BACKGROUND_TASKS) {
      return rejectedTaskProjection("claude.visible_background_tasks_too_many", tasks.size);
    }
  }

  const event: DriverEventInput = {
    delivery: "lossless",
    kind: "agent.tasks.replaced",
    payload: { tasks: [...tasks.values()] },
    visibility: "participant",
  };

  try {
    assertClaudeDurableEventFits(event, "claude.tasks_snapshot_too_large", "task snapshot");
  } catch (error) {
    if (!(error instanceof ClaudeDurableEventTooLargeError)) {
      throw error;
    }
    const membership: DriverEventInput = {
      ...event,
      payload: {
        tasks: [...tasks.values()].map(({ taskId }) => ({ taskId })),
      },
    };
    assertClaudeDurableEventFits(
      membership,
      "claude.tasks_membership_snapshot_too_large",
      "task membership snapshot",
    );
    return {
      diagnostic: taskSnapshotDiagnostic("claude.tasks_snapshot_too_large", message.tasks.length),
      snapshot: membership,
    };
  }

  return { snapshot: event };
}
