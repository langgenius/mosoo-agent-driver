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
  #completed = new Set<string>();
  #nonzeroExecuteExits = new Set<string>();
  #snapshots = new Map<string, JsonObject>();
  #started = new Set<string>();

  hasActivity(): boolean {
    return this.#started.size > 0;
  }

  hasStarted(toolCallId: string): boolean {
    return this.#started.has(toolCallId);
  }

  clear(): void {
    this.#completed.clear();
    this.#nonzeroExecuteExits.clear();
    this.#snapshots.clear();
    this.#started.clear();
  }

  checkpoint(): () => void {
    const completed = new Set(this.#completed);
    const nonzeroExecuteExits = new Set(this.#nonzeroExecuteExits);
    const snapshots = new Map(this.#snapshots);
    const started = new Set(this.#started);

    return () => {
      this.#completed = completed;
      this.#nonzeroExecuteExits = nonzeroExecuteExits;
      this.#snapshots = snapshots;
      this.#started = started;
    };
  }

  patch(input: {
    parentMessageId?: string | undefined;
    status: RuntimeToolStatus | null;
    toolCallId: string;
    update: JsonObject | null;
  }): { changed: boolean; payload: JsonObject; status: RuntimeToolStatus } {
    const previous = this.#snapshots.get(input.toolCallId);
    const previousStatus = previous?.["status"];
    const kind = readNonEmptyString(input.update, "kind") ?? previous?.["kind"] ?? "tool";
    const nextStatus = input.status ?? "running";

    const hasNonzeroExit =
      this.#nonzeroExecuteExits.has(input.toolCallId) || hasNonzeroExecuteExit(kind, input.update);

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
      (typeof previous?.["parentMessageId"] === "string"
        ? previous["parentMessageId"]
        : undefined) ?? input.parentMessageId;
    const title = readNonEmptyString(input.update, "title") ?? previous?.["title"];
    const payload = {
      ...previous,
      ...toToolCallPayload(input.toolCallId, status, input.update),
      kind,
      ...(parentMessageId === undefined ? {} : { parentMessageId }),
      status,
      ...(typeof title === "string" ? { title } : {}),
      toolCallId: input.toolCallId,
    };
    const changed = previous === undefined || !isDeepStrictEqual(previous, payload);

    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_ACP_LOSSLESS_EVENT_BYTES) {
      throw new RangeError(`ACP tool update exceeds ${MAX_ACP_LOSSLESS_EVENT_BYTES} UTF-8 bytes.`);
    }

    if (hasNonzeroExit) {
      this.#nonzeroExecuteExits.add(input.toolCallId);
    }

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
