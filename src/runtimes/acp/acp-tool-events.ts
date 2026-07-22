import { isDeepStrictEqual } from "node:util";

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
  readonly #snapshots = new Map<string, JsonObject>();
  readonly #started = new Set<string>();

  hasActivity(): boolean {
    return this.#started.size > 0;
  }

  hasStarted(toolCallId: string): boolean {
    return this.#started.has(toolCallId);
  }

  clear(): void {
    this.#completed.clear();
    this.#snapshots.clear();
    this.#started.clear();
  }

  patch(input: {
    parentMessageId?: string | undefined;
    status: RuntimeToolStatus | null;
    toolCallId: string;
    update: JsonObject | null;
  }): { changed: boolean; payload: JsonObject; status: RuntimeToolStatus } {
    const previous = this.#snapshots.get(input.toolCallId);
    const previousStatus = previous?.["status"];
    const status =
      previousStatus === "completed" || previousStatus === "failed"
        ? previousStatus
        : (input.status ?? "running");
    // The projection layer links tool calls to their assistant message via
    // parentMessageId; keep the first observed parent for the call's lifetime.
    const parentMessageId =
      (typeof previous?.["parentMessageId"] === "string"
        ? previous["parentMessageId"]
        : undefined) ?? input.parentMessageId;
    const payload = {
      ...previous,
      ...toToolCallPayload(input.toolCallId, status, input.update),
      kind: readNonEmptyString(input.update, "kind") ?? previous?.["kind"] ?? "tool",
      ...(parentMessageId === undefined ? {} : { parentMessageId }),
      status,
      title: readNullableString(input.update, "title") ?? previous?.["title"] ?? null,
      toolCallId: input.toolCallId,
    };
    const changed = previous === undefined || !isDeepStrictEqual(previous, payload);

    if (changed) {
      this.#snapshots.set(input.toolCallId, structuredClone(payload));
    }

    return { changed, payload, status };
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
  const kind = readNonEmptyString(update, "kind");
  const rawInput = readToolDisplayString(update?.["rawInput"]);
  const rawOutput = readToolDisplayString(update?.["rawOutput"]);
  const title = readNullableString(update, "title");
  const locations = update?.["locations"];

  return {
    ...(content === undefined ? {} : { content }),
    ...(kind === null ? {} : { kind }),
    ...(locations === undefined || locations === null ? {} : { locations }),
    ...(rawInput === undefined ? {} : { rawInput }),
    ...(rawOutput === undefined ? {} : { rawOutput }),
    status,
    ...(title === undefined || title === null ? {} : { title }),
    toolCallId,
  };
}
