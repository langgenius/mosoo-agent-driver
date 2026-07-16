import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import {
  isRecord,
  readNonEmptyString,
  readNullableString,
  readString,
  stringifyForDisplay,
} from "./acp-types";
import type { JsonObject } from "./acp-types";

export type RuntimeToolStatus = "completed" | "failed" | "running";

const TERMINAL_TOOL_STATUSES = new Set(["cancelled", "completed", "failed"]);

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

export class AcpToolEventState {
  readonly #completed = new Set<string>();
  readonly #started = new Set<string>();

  hasActivity(): boolean {
    return this.#started.size > 0;
  }

  clear(): void {
    this.#completed.clear();
    this.#started.clear();
  }

  complete(input: {
    runId: RunId;
    status: RuntimeToolStatus;
    toolCallId: string;
    update: JsonObject | null;
  }): DriverEventInput | null {
    if (this.#completed.has(input.toolCallId)) {
      return null;
    }

    this.#completed.add(input.toolCallId);
    return {
      kind: "item.completed",
      payload: {
        error: input.status === "failed" ? readString(input.update, "error") : undefined,
        itemId: input.toolCallId,
        itemType: "tool_call",
        result: input.update?.["rawOutput"],
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

    for (const itemId of this.#started) {
      if (this.#completed.has(itemId)) {
        continue;
      }

      this.#completed.add(itemId);
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

    return events;
  }

  ensureStarted(input: {
    parentMessageId: string | undefined;
    runId: RunId;
    title: string;
    toolCallId: string;
  }): DriverEventInput[] {
    if (this.#started.has(input.toolCallId)) {
      return [];
    }

    this.#started.add(input.toolCallId);
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
}

export function isTerminalToolStatus(status: string | null): boolean {
  return status !== null && TERMINAL_TOOL_STATUSES.has(status);
}

export function toRuntimeToolStatus(status: string | null): RuntimeToolStatus {
  if (status === "completed") {
    return "completed";
  }

  if (status === "failed" || status === "cancelled") {
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
  const rawInput = readToolDisplayString(update?.["rawInput"]);
  const rawOutput = readToolDisplayString(update?.["rawOutput"]);

  return {
    ...(content === undefined ? {} : { content }),
    kind: readNonEmptyString(update, "kind") ?? "tool",
    locations: update?.["locations"],
    ...(rawInput === undefined ? {} : { rawInput }),
    ...(rawOutput === undefined ? {} : { rawOutput }),
    status,
    title: readNullableString(update, "title") ?? null,
    toolCallId,
  };
}
