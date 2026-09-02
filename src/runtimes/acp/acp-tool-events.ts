import { isDeepStrictEqual } from "node:util";

import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import {
  MAX_ACP_LOSSLESS_EVENT_BYTES,
  isRecord,
  readNonEmptyString,
  readNumber,
  readRecord,
  readString,
  stringifyForDisplay,
} from "./acp-types";
import type { JsonObject } from "./acp-types";

export type RuntimeToolStatus = "cancelled" | "completed" | "failed" | "running";

// Completed calls are retained only to suppress bounded late replays. They do
// not participate in terminal settlement admission: only open calls can emit
// terminal closures. The cache has its own independent memory bound.
const MAX_ACP_COMPLETED_TOOL_HISTORY_BYTES = MAX_ACP_LOSSLESS_EVENT_BYTES;
const MAX_ACP_COMPLETED_TOOL_HISTORY_ITEMS = 1_024;

interface AcpToolState {
  readonly completed: boolean;
  readonly hasNonzeroExit: boolean;
  readonly snapshot: JsonObject;
  readonly started: boolean;
}

function readToolDisplayString(value: unknown): string | undefined {
  const display = stringifyForDisplay(value);

  return display.length > 0 ? display : undefined;
}

function readToolContentString(value: unknown): string | undefined {
  if (isRecord(value)) {
    const text = readString(value, "text");

    if (text !== null && text.length > 0) {
      return text;
    }
  }

  return readToolDisplayString(value);
}

function hasNonzeroExecuteExit(kind: unknown, update: JsonObject | null): boolean {
  const metadata = readRecord(readRecord(update, "rawOutput"), "metadata");
  const exitCode = readNumber(metadata, "exit");

  return kind === "execute" && exitCode !== null && exitCode !== 0;
}

export class AcpToolEventState {
  #hadActivity = false;
  #tools = new Map<string, AcpToolState>();

  hasActivity(): boolean {
    return this.#hadActivity;
  }

  hasStarted(toolCallId: string): boolean {
    return this.#tools.get(toolCallId)?.started ?? false;
  }

  openItemCount(): number {
    let count = 0;

    for (const tool of this.#tools.values()) {
      if (tool.started && !tool.completed) {
        count += 1;
      }
    }

    return count;
  }

  retainedOpenState(): readonly JsonObject[] {
    return [...this.#tools.values()].flatMap((tool) =>
      tool.started && !tool.completed ? [tool.snapshot] : [],
    );
  }

  compactHistory(): void {
    this.#trimCompletedHistory();
  }

  clear(): void {
    this.#hadActivity = false;
    this.#tools.clear();
  }

  checkpoint(): () => void {
    const hadActivity = this.#hadActivity;
    const tools = new Map([...this.#tools].map(([toolCallId, tool]) => [toolCallId, { ...tool }]));

    return () => {
      this.#hadActivity = hadActivity;
      this.#tools = tools;
    };
  }

  patch(input: {
    parentMessageId?: string | undefined;
    status: RuntimeToolStatus | null;
    toolCallId: string;
    update: JsonObject | null;
  }): { changed: boolean; payload: JsonObject; status: RuntimeToolStatus } {
    const previous = this.#tools.get(input.toolCallId);
    const previousSnapshot = previous?.snapshot;
    const previousStatus = previousSnapshot?.["status"];
    const kind = readNonEmptyString(input.update, "kind") ?? previousSnapshot?.["kind"] ?? "tool";
    const nextStatus = input.status ?? "running";

    const hasNonzeroExit =
      (previous?.hasNonzeroExit ?? false) || hasNonzeroExecuteExit(kind, input.update);

    const status =
      previousStatus === "cancelled" ||
      previousStatus === "completed" ||
      previousStatus === "failed"
        ? previousStatus
        : nextStatus === "completed" && hasNonzeroExit
          ? "failed"
          : nextStatus;
    // The projection layer links tool calls to their assistant message via
    // parentMessageId; keep the first observed parent for the call's lifetime.
    const parentMessageId =
      (typeof previousSnapshot?.["parentMessageId"] === "string"
        ? previousSnapshot["parentMessageId"]
        : undefined) ?? input.parentMessageId;
    const title = readNonEmptyString(input.update, "title") ?? previousSnapshot?.["title"];
    const payload = {
      ...previousSnapshot,
      ...toToolCallPayload(input.toolCallId, status, input.update),
      kind,
      ...(parentMessageId === undefined ? {} : { parentMessageId }),
      status,
      ...(typeof title === "string" ? { title } : {}),
      toolCallId: input.toolCallId,
    };
    const changed = previousSnapshot === undefined || !isDeepStrictEqual(previousSnapshot, payload);

    if (changed || hasNonzeroExit !== previous?.hasNonzeroExit) {
      this.#tools.set(input.toolCallId, {
        completed: previous?.completed ?? false,
        hasNonzeroExit,
        snapshot: changed ? structuredClone(payload) : previous!.snapshot,
        started: previous?.started ?? false,
      });
    }

    return { changed, payload, status };
  }

  complete(input: {
    runId: RunId;
    status: RuntimeToolStatus;
    toolCallId: string;
    update: JsonObject | null;
  }): DriverEventInput | null {
    const tool = this.#tools.get(input.toolCallId);

    if (tool === undefined) {
      throw new Error("ACP tool completion requires a projected tool call.");
    }
    if (tool.completed) {
      this.#trimCompletedHistory();
      return null;
    }

    this.#tools.set(input.toolCallId, { ...tool, completed: true });
    this.#trimCompletedHistory();
    return {
      kind: "item.completed",
      payload: {
        error: input.status === "failed" ? readString(input.update, "error") : undefined,
        itemId: input.toolCallId,
        itemType: "tool_call",
        status: input.status,
      },
      runId: input.runId,
    };
  }

  completeOpen(input: {
    error?: string;
    runId: RunId;
    status: RuntimeToolStatus;
  }): DriverEventInput[] {
    const events: DriverEventInput[] = [];

    for (const [itemId, tool] of this.#tools) {
      if (!tool.started || tool.completed) {
        continue;
      }

      this.#tools.set(itemId, { ...tool, completed: true });
      events.push({
        kind: "tool.call.updated",
        payload: {
          ...(input.error === undefined ? {} : { error: input.error }),
          status: input.status,
          toolCallId: itemId,
        },
        runId: input.runId,
      });
      events.push({
        kind: "item.completed",
        payload: {
          ...(input.error === undefined ? {} : { error: input.error }),
          itemId,
          itemType: "tool_call",
          status: input.status,
        },
        runId: input.runId,
      });
    }

    this.#trimCompletedHistory();

    return events;
  }

  ensureStarted(input: {
    parentMessageId: string | undefined;
    runId: RunId;
    title: string;
    toolCallId: string;
  }): DriverEventInput[] {
    const tool = this.#tools.get(input.toolCallId);

    if (tool?.started) {
      return [];
    }
    if (tool === undefined) {
      throw new Error("ACP tool start requires a projected tool call.");
    }

    this.#hadActivity = true;
    this.#tools.set(input.toolCallId, { ...tool, started: true });
    return [
      {
        kind: "item.started",
        payload: {
          itemId: input.toolCallId,
          itemType: "tool_call",
          parentMessageId: input.parentMessageId,
          title: input.title,
        },
        runId: input.runId,
      },
    ];
  }

  #trimCompletedHistory(): void {
    const completed = [...this.#tools].filter(([, tool]) => tool.completed);
    let retainedItems = completed.length;
    let bytes = completed.reduce(
      (total, [toolCallId, tool]) =>
        total + Buffer.byteLength(JSON.stringify([toolCallId, tool.snapshot]), "utf8"),
      0,
    );

    for (const [toolCallId, tool] of completed) {
      if (
        retainedItems <= MAX_ACP_COMPLETED_TOOL_HISTORY_ITEMS &&
        bytes <= MAX_ACP_COMPLETED_TOOL_HISTORY_BYTES
      ) {
        break;
      }

      this.#tools.delete(toolCallId);
      retainedItems -= 1;
      bytes -= Buffer.byteLength(JSON.stringify([toolCallId, tool.snapshot]), "utf8");
    }
  }
}

export function toRuntimeToolStatus(status: string | null): RuntimeToolStatus {
  if (status === "completed") {
    return "completed";
  }

  if (status === "failed") {
    return "failed";
  }

  return "running";
}

export function toToolCallPayload(
  toolCallId: string,
  status: RuntimeToolStatus,
  update: JsonObject | null,
): JsonObject {
  const content = readToolContentString(update?.["content"]);
  const kind = readNonEmptyString(update, "kind");
  const name = readNonEmptyString(update, "name");
  const rawInput = readToolDisplayString(update?.["rawInput"]);
  const rawOutput = readToolDisplayString(update?.["rawOutput"]);
  const title = readNonEmptyString(update, "title");
  const locations = update?.["locations"];

  return {
    ...(content === undefined ? {} : { content }),
    ...(kind === null ? {} : { kind }),
    ...(locations === undefined || locations === null ? {} : { locations }),
    ...(rawInput === undefined ? {} : { rawInput }),
    ...(rawOutput === undefined || rawOutput === content ? {} : { rawOutput }),
    ...(name === null ? {} : { name }),
    status,
    ...(title === undefined || title === null ? {} : { title }),
    toolCallId,
  };
}
