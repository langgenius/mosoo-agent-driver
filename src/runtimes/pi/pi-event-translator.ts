import type { DriverEventInput } from "../../protocol/events";
import { createDriverId } from "../../protocol/id";
import { isJsonObject } from "../../protocol/json";
import type { JsonObject, JsonValue } from "../../protocol/json";
import { chunkJsonText } from "../provider-json";
import {
  createThoughtContentEvents,
  MAX_THOUGHT_CONTENT_BYTES,
  thoughtContentBytes,
  thoughtContentDeltaBytes,
} from "../thought-content";

const MAX_PI_THOUGHT_TEXT_BYTES = 512 * 1_024;
const MAX_PI_MESSAGE_THOUGHTS = 1_000;

interface PiThought {
  text: string;
  started: boolean;
  completed: boolean;
}

const USAGE_FIELDS = {
  input: "inputTokens",
  output: "outputTokens",
  cacheRead: "cachedReadTokens",
  cacheWrite: "cachedWriteTokens",
  reasoning: "thoughtTokens",
  totalTokens: "totalTokens",
} as const;

function textContent(value: JsonValue | undefined, type = "text"): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((block) =>
      isJsonObject(block) && block["type"] === type && typeof block[type] === "string"
        ? [block[type]]
        : [],
    )
    .join("");
}

export class PiEventTranslator {
  #messageId: string | null = null;
  #failure: string | null = null;
  #final: { id: string; text: string } | null = null;
  readonly #openMessages = new Set<string>();
  readonly #openTools = new Map<
    string,
    { title: string; parentMessageId: string; args: JsonObject }
  >();
  readonly #thoughts = new Map<string, PiThought>();
  #thoughtBytes = 0;
  readonly #toolMessageIds = new Map<string, string>();
  readonly #usage: Record<string, number> = {};

  get failure(): string | null {
    return this.#failure;
  }
  get finalMessage(): { id: string; text: string } | null {
    return this.#final;
  }

  accept(events: readonly DriverEventInput[]): void {
    for (const event of events) {
      const payload = event.payload;
      if (!isJsonObject(payload)) continue;
      if (typeof payload["thoughtId"] === "string") {
        const thought = this.#thoughts.get(payload["thoughtId"]);
        if (thought !== undefined) {
          if (event.kind === "thought.started") thought.started = true;
          if (event.kind === "thought.completed" || event.kind === "thought.cancelled")
            thought.completed = true;
        }
      }
      if (event.kind === "message.completed" && typeof payload["messageId"] === "string") {
        this.#openMessages.delete(payload["messageId"]);
        for (const [thoughtId, thought] of this.#thoughts) {
          if (thought.completed && thoughtId.startsWith(`${payload["messageId"]}:`)) {
            this.#thoughtBytes -= thoughtContentBytes(thought.text);
            this.#thoughts.delete(thoughtId);
          }
        }
      }
      if (
        event.kind === "tool.call.updated" &&
        payload["status"] !== "running" &&
        typeof payload["toolCallId"] === "string"
      ) {
        this.#openTools.delete(payload["toolCallId"]);
      }
    }
  }

  closeOpenItems(cancelled = false): DriverEventInput[] {
    const events = this.#closeThoughts(cancelled);
    for (const messageId of this.#openMessages) {
      events.push({
        kind: "message.completed",
        payload: { messageId, role: "agent" },
      });
    }
    for (const [toolCallId, tool] of this.#openTools) {
      events.push({
        kind: "tool.call.updated",
        payload: {
          toolCallId,
          parentMessageId: tool.parentMessageId,
          title: tool.title,
          kind: "tool",
          rawInput: JSON.stringify(tool.args),
          status: "failed",
        },
      });
    }
    this.#messageId = null;
    this.#openMessages.clear();
    this.#openTools.clear();
    this.#toolMessageIds.clear();
    return events;
  }

  translate(record: JsonObject): DriverEventInput[] {
    const type = record["type"];
    const message = isJsonObject(record["message"]) ? record["message"] : null;
    if (type === "message_start" && message?.["role"] === "assistant") {
      this.#messageId = createDriverId();
      this.#openMessages.add(this.#messageId);
      return [{ kind: "message.started", payload: { messageId: this.#messageId, role: "agent" } }];
    }
    if (type === "message_update" && this.#messageId !== null) {
      const update = record["assistantMessageEvent"];
      if (!isJsonObject(update)) throw new Error("Pi message update has no assistant event.");
      const delta = update["delta"];
      if (typeof delta === "string" && update["type"] === "text_delta") {
        return [
          {
            kind: "message.delta",
            delivery: "best_effort",
            payload: { contentDelta: delta, messageId: this.#messageId, role: "agent" },
          },
        ];
      }
      const thoughtId = `${this.#messageId}:${typeof update["contentIndex"] === "number" ? update["contentIndex"] : 0}`;
      const events: DriverEventInput[] = [];
      if (update["type"] === "thinking_start") {
        this.#ensureThought(thoughtId, events);
        return events;
      }
      if (update["type"] === "thinking_delta" && typeof delta === "string") {
        this.#appendThought(thoughtId, delta, events);
        return events;
      }
      if (update["type"] === "thinking_end") {
        this.#completeThought(
          thoughtId,
          typeof update["content"] === "string" ? update["content"] : undefined,
          events,
        );
        return events;
      }
      return [];
    }
    if (type === "message_end" && message?.["role"] === "assistant") {
      if (this.#messageId === null)
        throw new Error("Pi completed an assistant message without starting it.");
      const id = this.#messageId;
      const content = message["content"];
      const stop = message["stopReason"];
      const interrupted = stop === "error" || stop === "aborted" || stop === "length";
      const events: DriverEventInput[] = [];
      const thoughtIds = new Set<string>();
      if (Array.isArray(content)) {
        let bytes = this.#thoughtBytes;
        let count = this.#thoughts.size;
        for (const [index, block] of content.entries()) {
          if (
            !isJsonObject(block) ||
            block["type"] !== "thinking" ||
            typeof block["thinking"] !== "string"
          )
            continue;
          const thought = this.#thoughts.get(`${id}:${index}`);
          if (thought?.completed) continue;
          bytes +=
            thoughtContentBytes(block["thinking"]) - thoughtContentBytes(thought?.text ?? "");
          if (thought === undefined) count++;
        }
        if (bytes > MAX_THOUGHT_CONTENT_BYTES)
          throw new Error("Pi assistant message exceeds the thinking content byte limit.");
        if (count > MAX_PI_MESSAGE_THOUGHTS)
          throw new Error("Pi assistant message exceeds the thinking block limit.");
        this.#thoughtBytes = bytes;
        for (const [index, block] of content.entries()) {
          if (
            isJsonObject(block) &&
            block["type"] === "thinking" &&
            typeof block["thinking"] === "string"
          ) {
            const thoughtId = `${id}:${index}`;
            const thought = this.#ensureThought(thoughtId);
            if (!thought.completed) thought.text = block["thinking"];
            thoughtIds.add(thoughtId);
          }
          if (
            isJsonObject(block) &&
            block["type"] === "toolCall" &&
            typeof block["id"] === "string"
          ) {
            this.#toolMessageIds.set(block["id"], id);
          }
        }
      }
      for (const thoughtId of this.#thoughts.keys())
        if (thoughtId.startsWith(`${id}:`)) thoughtIds.add(thoughtId);
      events.push(...this.#closeThoughts(interrupted, thoughtIds));
      const text = textContent(message["content"]);
      this.#final = { id, text };
      this.#messageId = null;
      // A later successful retry clears an earlier transient provider failure.
      this.#failure = interrupted
        ? typeof message["errorMessage"] === "string"
          ? message["errorMessage"]
          : `Pi model stopped: ${stop}.`
        : null;
      events.push(
        ...(text.length > 0
          ? [
              {
                kind: "message.added",
                payload: { content: [{ type: "text", text }], messageId: id, role: "agent" },
              } satisfies DriverEventInput,
            ]
          : []),
        { kind: "message.completed", payload: { messageId: id, role: "agent" } },
      );
      events.push(...this.#accumulateUsage(message["usage"]));
      return events;
    }
    if (
      type === "tool_execution_start" ||
      type === "tool_execution_update" ||
      type === "tool_execution_end"
    ) {
      const toolCallId = record["toolCallId"];
      const title = record["toolName"];
      if (typeof toolCallId !== "string" || typeof title !== "string")
        throw new Error("Pi tool event has no tool identity.");
      const parentMessageId = this.#toolMessageIds.get(toolCallId);
      if (parentMessageId === undefined) throw new Error("Pi tool event has no assistant message.");
      if (type === "tool_execution_start") {
        this.#openTools.set(toolCallId, {
          title,
          parentMessageId,
          args: isJsonObject(record["args"]) ? record["args"] : {},
        });
        return [
          {
            kind: "tool.call.updated",
            payload: {
              toolCallId,
              parentMessageId,
              title,
              kind: "tool",
              status: "running",
            },
          },
        ];
      }
      const result = type === "tool_execution_end" ? record["result"] : record["partialResult"];
      const outputText = isJsonObject(result) ? textContent(result["content"]) : "";
      const args = this.#openTools.get(toolCallId)?.args;
      const events: DriverEventInput[] = [
        {
          kind: "tool.call.updated",
          payload: {
            toolCallId,
            parentMessageId,
            title,
            kind: "tool",
            ...(outputText.length > 0 ? { rawOutput: outputText } : {}),
            // Host treats rawInput as an args delta and persists terminal input.
            // Emit the complete native arguments once, when the tool settles.
            ...(type === "tool_execution_end" ? { rawInput: JSON.stringify(args ?? {}) } : {}),
            status:
              type === "tool_execution_update"
                ? "running"
                : record["isError"] === true
                  ? "failed"
                  : "completed",
          },
        },
      ];
      if (type === "tool_execution_end") {
        this.#toolMessageIds.delete(toolCallId);
        if (
          record["isError"] !== true &&
          (title === "write" || title === "edit") &&
          typeof args?.["path"] === "string"
        ) {
          events.push({
            actor: "tool",
            origin: "file",
            kind: "file.change.updated",
            payload: { changes: [{ change: "upsert", path: args["path"] }], status: "completed" },
          });
        }
      }
      return events;
    }
    if (type === "compaction_end") {
      const result = record["result"];
      if (
        record["aborted"] !== false ||
        record["errorMessage"] !== undefined ||
        !isJsonObject(result)
      )
        return [];
      // Pi's separate summarizer reports usage here, without an assistant message_end.
      return [
        { kind: "context.compacted", payload: { reason: "pi.compaction" } },
        ...this.#accumulateUsage(result["usage"]),
      ];
    }
    return [];
  }

  #ensureThought(thoughtId: string, events?: DriverEventInput[]): PiThought {
    let thought = this.#thoughts.get(thoughtId);
    if (thought === undefined) {
      if (this.#thoughts.size >= MAX_PI_MESSAGE_THOUGHTS)
        throw new Error("Pi assistant message exceeds the thinking block limit.");
      thought = { text: "", started: false, completed: false };
      this.#thoughts.set(thoughtId, thought);
    }
    if (!thought.started)
      events?.push({ kind: "thought.started", payload: { thoughtId, channel: "summary" } });
    return thought;
  }

  #appendThought(thoughtId: string, text: string, events: DriverEventInput[]): void {
    if (text.length === 0) return;
    const current = this.#thoughts.get(thoughtId);
    if (current?.completed) return;
    const bytes = thoughtContentDeltaBytes(current?.text ?? "", text);
    if (this.#thoughtBytes + bytes > MAX_THOUGHT_CONTENT_BYTES)
      throw new Error("Pi assistant message exceeds the thinking content byte limit.");
    const thought = this.#ensureThought(thoughtId, events);
    events.push(
      ...chunkJsonText(text, MAX_PI_THOUGHT_TEXT_BYTES).map((contentDelta): DriverEventInput => ({
        kind: "thought.delta",
        delivery: "best_effort",
        payload: { thoughtId, channel: "summary", contentDelta },
      })),
    );
    thought.text += text;
    this.#thoughtBytes += bytes;
  }

  #completeThought(
    thoughtId: string,
    text: string | undefined,
    events: DriverEventInput[],
    cancelled = false,
  ): void {
    const current = this.#thoughts.get(thoughtId);
    if (current?.completed) return;
    const content = text ?? current?.text ?? "";
    const bytes =
      this.#thoughtBytes - thoughtContentBytes(current?.text ?? "") + thoughtContentBytes(content);
    if (bytes > MAX_THOUGHT_CONTENT_BYTES)
      throw new Error("Pi assistant message exceeds the thinking content byte limit.");
    const thought = this.#ensureThought(thoughtId, events);
    events.push(...createThoughtContentEvents(thoughtId, content));
    thought.text = content;
    this.#thoughtBytes = bytes;
    events.push({
      kind: cancelled ? "thought.cancelled" : "thought.completed",
      payload: { thoughtId, channel: "summary" },
    });
  }

  #closeThoughts(
    cancelled: boolean,
    thoughtIds: Iterable<string> = this.#thoughts.keys(),
  ): DriverEventInput[] {
    const events: DriverEventInput[] = [];
    for (const thoughtId of thoughtIds)
      this.#completeThought(thoughtId, undefined, events, cancelled);
    return events;
  }

  #accumulateUsage(value: JsonValue | undefined): DriverEventInput[] {
    if (!isJsonObject(value)) return [];
    let updated = false;
    for (const [native, field] of Object.entries(USAGE_FIELDS)) {
      const count = value[native];
      if (typeof count !== "number" || count < 0 || !Number.isSafeInteger(count)) continue;
      const total = (this.#usage[field] ?? 0) + count;
      if (!Number.isSafeInteger(total)) continue;
      this.#usage[field] = total;
      updated = true;
    }
    const cost = isJsonObject(value["cost"]) ? value["cost"]["total"] : undefined;
    if (typeof cost === "number" && cost >= 0 && Number.isFinite(cost)) {
      const total = (this.#usage["costAmount"] ?? 0) + cost;
      if (Number.isFinite(total)) {
        this.#usage["costAmount"] = total;
        updated = true;
      }
    }
    if (!updated) return [];
    return [
      {
        kind: "usage.updated",
        payload: {
          ...this.#usage,
          ...(this.#usage["costAmount"] === undefined ? {} : { costCurrency: "USD" }),
          usageContract: "anthropic_bucketed",
          source: "session_update",
        },
      },
    ];
  }
}
