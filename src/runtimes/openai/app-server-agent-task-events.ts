import type { DriverEventInput } from "../../protocol/events";
import { toRuntimePublicId } from "../runtime-public-id";
import {
  assertOpenAiDurableEventFits,
  MAX_OPENAI_DURABLE_EVENT_BYTES,
} from "./app-server-event-state";

const MAX_OPENAI_ACTIVE_AGENT_TASKS = 1_024;
const MAX_OPENAI_CLOSED_AGENT_TASKS = 1_024;
const MAX_OPENAI_VISIBLE_AGENT_TASKS = 256;
const MAX_OPENAI_AGENT_TASK_TEXT_LENGTH = 4_096;
const OPENAI_AGENT_TASK_EVENT_ENVELOPE_RESERVE_BYTES = 1_024;

export interface OpenAiSubAgentActivity {
  readonly agentId: string;
  readonly agentPath: string;
  readonly kind: "completed" | "interacted" | "interrupted" | "started";
}

interface OpenAiAgentTask {
  readonly taskId: string;
  readonly taskType?: string;
  readonly title?: string;
}

interface OpenAiAgentTaskUpdate {
  readonly commit: () => void;
  readonly events: DriverEventInput[];
}

export function toOpenAiAgentTaskId(nativeTaskId: string): string {
  return toRuntimePublicId(nativeTaskId, "openai-thread");
}

function boundedTaskText(value: string): string | undefined {
  const text = value.slice(0, MAX_OPENAI_AGENT_TASK_TEXT_LENGTH);
  const finalCodeUnit = text.charCodeAt(text.length - 1);
  const bounded = finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? text.slice(0, -1) : text;
  return bounded.length === 0 ? undefined : bounded;
}

function taskSnapshot(tasks: readonly OpenAiAgentTask[]): DriverEventInput {
  return {
    delivery: "lossless",
    kind: "agent.tasks.replaced",
    payload: { tasks },
    visibility: "participant",
  };
}

function taskSnapshotDiagnostic(
  code: string,
  taskCount: number,
  message: string,
): DriverEventInput {
  const event: DriverEventInput = {
    delivery: "best_effort",
    kind: "diagnostic.reported",
    payload: {
      code,
      details: { taskCount },
      message,
      severity: "warn",
      source: "openai",
    },
    visibility: "owner_debug",
  };
  assertOpenAiDurableEventFits(event, "sub-agent task snapshot diagnostic");
  return event;
}

export function openAiAgentTasksClosedEvent(): DriverEventInput {
  return taskSnapshot([]);
}

export class OpenAiAgentTaskState {
  #closedTaskIds = new Set<string>();
  #tasks = new Map<string, OpenAiAgentTask>();

  prepare(activity: OpenAiSubAgentActivity): OpenAiAgentTaskUpdate {
    const closedTaskIds = new Set(this.#closedTaskIds);
    const tasks = new Map(this.#tasks);
    const taskId = toOpenAiAgentTaskId(activity.agentId);

    if (activity.kind === "interacted") {
      closedTaskIds.delete(taskId);
      this.#upsertTask(tasks, taskId, activity.agentPath);
    } else if (activity.kind === "started") {
      if (!closedTaskIds.has(taskId)) {
        this.#upsertTask(tasks, taskId, activity.agentPath);
      }
    } else {
      tasks.delete(taskId);
      if (!closedTaskIds.has(taskId) && closedTaskIds.size === MAX_OPENAI_CLOSED_AGENT_TASKS) {
        throw new RangeError("OpenAI closed sub-agent count exceeds 1024.");
      }
      closedTaskIds.add(taskId);
    }

    let snapshot = taskSnapshot([...tasks.values()]);
    const events: DriverEventInput[] = [];

    if (tasks.size > MAX_OPENAI_VISIBLE_AGENT_TASKS) {
      events.push(
        taskSnapshotDiagnostic(
          "openai.visible_agent_tasks_too_many",
          tasks.size,
          "OpenAI active sub-agent count exceeded the supported snapshot size.",
        ),
      );
    } else if (
      Buffer.byteLength(JSON.stringify(snapshot), "utf8") >
      MAX_OPENAI_DURABLE_EVENT_BYTES - OPENAI_AGENT_TASK_EVENT_ENVELOPE_RESERVE_BYTES
    ) {
      snapshot = taskSnapshot([...tasks.values()].map(({ taskId: id }) => ({ taskId: id })));
      assertOpenAiDurableEventFits(snapshot, "sub-agent task membership snapshot");
      events.push(
        taskSnapshotDiagnostic(
          "openai.agent_tasks_snapshot_too_large",
          tasks.size,
          "OpenAI sub-agent task metadata exceeded the supported snapshot size.",
        ),
        snapshot,
      );
    } else {
      assertOpenAiDurableEventFits(snapshot, "sub-agent task snapshot");
      events.push(snapshot);
    }

    return {
      commit: () => {
        this.#closedTaskIds = closedTaskIds;
        this.#tasks = tasks;
      },
      events,
    };
  }

  reset(): void {
    this.#closedTaskIds.clear();
    this.#tasks.clear();
  }

  #upsertTask(tasks: Map<string, OpenAiAgentTask>, taskId: string, agentPath: string): void {
    if (!tasks.has(taskId) && tasks.size === MAX_OPENAI_ACTIVE_AGENT_TASKS) {
      throw new RangeError("OpenAI active sub-agent count exceeds 1024.");
    }

    const title = boundedTaskText(agentPath);
    tasks.set(taskId, {
      taskId,
      taskType: "openai_subagent",
      ...(title === undefined ? {} : { title }),
    });
  }
}
