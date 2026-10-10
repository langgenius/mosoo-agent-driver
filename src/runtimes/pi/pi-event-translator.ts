import type { DriverEventInput } from "../../protocol/events";
import { createDriverId } from "../../protocol/id";
import { isJsonObject } from "../../protocol/json";
import type { JsonObject, JsonValue } from "../../protocol/json";
import { chunkJsonText } from "../provider-json";

const MAX_PI_THOUGHT_TEXT_BYTES = 512 * 1_024;
const MAX_PI_MESSAGE_THOUGHT_BYTES = 16 * 1_024 * 1_024;
const MAX_PI_MESSAGE_THOUGHTS = 1_000;

interface PiThought {
  text: string;
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

  closeOpenItems(cancelled = false): DriverEventInput[] {
    const events = this.#closeThoughts(cancelled);
    if (this.#messageId !== null) {
      events.push({
        kind: "message.completed",
        payload: { messageId: this.#messageId, role: "agent" },
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
    this.#thoughts.clear();
    this.#thoughtBytes = 0;
    this.#openTools.clear();
    this.#toolMessageIds.clear();
    return events;
  }

  translate(record: JsonObject): DriverEventInput[] {
    const type = record["type"];
    const message = isJsonObject(record["message"]) ? record["message"] : null;
    if (type === "message_start" && message?.["role"] === "assistant") {
      this.#messageId = createDriverId();
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
      if (Array.isArray(content)) {
        // Validate every final block before scheduling any completion events.
        for (const [index, block] of content.entries()) {
          if (
            isJsonObject(block) &&
            block["type"] === "thinking" &&
            typeof block["thinking"] === "string"
          )
            this.#assertThoughtPrefix(`${id}:${index}`, block["thinking"]);
        }
        for (const [index, block] of content.entries()) {
          if (
            isJsonObject(block) &&
            block["type"] === "thinking" &&
            typeof block["thinking"] === "string"
          )
            this.#completeThought(`${id}:${index}`, block["thinking"], events, interrupted);
          if (
            isJsonObject(block) &&
            block["type"] === "toolCall" &&
            typeof block["id"] === "string"
          ) {
            this.#toolMessageIds.set(block["id"], id);
          }
        }
      }
      events.push(...this.#closeThoughts(interrupted));
      this.#thoughts.clear();
      this.#thoughtBytes = 0;
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
        this.#openTools.delete(toolCallId);
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

  #ensureThought(thoughtId: string, events: DriverEventInput[]): PiThought {
    let thought = this.#thoughts.get(thoughtId);
    if (thought === undefined) {
      if (this.#thoughts.size >= MAX_PI_MESSAGE_THOUGHTS)
        throw new Error("Pi assistant message exceeds the thinking block limit.");
      thought = { text: "", completed: false };
      this.#thoughts.set(thoughtId, thought);
      events.push({ kind: "thought.started", payload: { thoughtId, channel: "summary" } });
    }
    return thought;
  }

  #appendThought(thoughtId: string, text: string, events: DriverEventInput[]): void {
    if (text.length === 0) return;
    const bytes = Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
    if (this.#thoughtBytes + bytes > MAX_PI_MESSAGE_THOUGHT_BYTES)
      throw new Error("Pi assistant message exceeds the thinking content byte limit.");
    const thought = this.#ensureThought(thoughtId, events);
    if (thought.completed) throw new Error("Pi thinking delta arrived after completion.");
    events.push(
      ...chunkJsonText(text, MAX_PI_THOUGHT_TEXT_BYTES).map((contentDelta): DriverEventInput => ({
        kind: "thought.delta",
        delivery: "lossless",
        payload: { thoughtId, channel: "summary", contentDelta },
      })),
    );
    // The backend awaits lossless delivery before translating the next native record.
    thought.text += text;
    this.#thoughtBytes += bytes;
  }

  #assertThoughtPrefix(thoughtId: string, text: string): void {
    const thought = this.#thoughts.get(thoughtId);
    if (
      thought !== undefined &&
      (!text.startsWith(thought.text) || (thought.completed && text !== thought.text))
    )
      throw new Error("Pi final thinking content does not match the delivered prefix.");
  }

  #completeThought(
    thoughtId: string,
    text: string | undefined,
    events: DriverEventInput[],
    cancelled = false,
  ): void {
    if (text !== undefined) this.#assertThoughtPrefix(thoughtId, text);
    const thought = this.#ensureThought(thoughtId, events);
    if (thought.completed) return;
    if (text !== undefined) this.#appendThought(thoughtId, text.slice(thought.text.length), events);
    thought.completed = true;
    events.push({
      kind: cancelled ? "thought.cancelled" : "thought.completed",
      payload: { thoughtId, channel: "summary" },
    });
  }

  #closeThoughts(cancelled: boolean): DriverEventInput[] {
    const events: DriverEventInput[] = [];
    for (const thoughtId of this.#thoughts.keys())
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
