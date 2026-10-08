import type { DriverEventInput } from "../../protocol/events";
import { createDriverId } from "../../protocol/id";
import { isJsonObject } from "../../protocol/json";
import type { JsonObject, JsonValue } from "../../protocol/json";

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
  readonly #toolArgs = new Map<string, JsonObject>();
  readonly #toolMessageIds = new Map<string, string>();

  get failure(): string | null {
    return this.#failure;
  }
  get finalMessage(): { id: string; text: string } | null {
    return this.#final;
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
      if (update["type"] === "thinking_start")
        return [{ kind: "thought.started", payload: { thoughtId, channel: "summary" } }];
      if (update["type"] === "thinking_delta" && typeof delta === "string")
        return [
          {
            kind: "thought.delta",
            delivery: "best_effort",
            payload: { thoughtId, channel: "summary", contentDelta: delta },
          },
        ];
      if (update["type"] === "thinking_end")
        return [{ kind: "thought.completed", payload: { thoughtId, channel: "summary" } }];
      return [];
    }
    if (type === "message_end" && message?.["role"] === "assistant") {
      if (this.#messageId === null)
        throw new Error("Pi completed an assistant message without starting it.");
      const id = this.#messageId;
      const content = message["content"];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            isJsonObject(block) &&
            block["type"] === "toolCall" &&
            typeof block["id"] === "string"
          ) {
            this.#toolMessageIds.set(block["id"], id);
          }
        }
      }
      const text = textContent(message["content"]);
      this.#final = { id, text };
      this.#messageId = null;
      const stop = message["stopReason"];
      // A later successful retry clears an earlier transient provider failure.
      this.#failure =
        stop === "error" || stop === "aborted" || stop === "length"
          ? typeof message["errorMessage"] === "string"
            ? message["errorMessage"]
            : `Pi model stopped: ${stop}.`
          : null;
      const events: DriverEventInput[] = [
        ...(text.length > 0
          ? [
              {
                kind: "message.added",
                payload: { content: [{ type: "text", text }], messageId: id, role: "agent" },
              } satisfies DriverEventInput,
            ]
          : []),
        { kind: "message.completed", payload: { messageId: id, role: "agent" } },
      ];
      const usage = message["usage"];
      if (isJsonObject(usage)) {
        events.push({
          kind: "usage.updated",
          payload: {
            inputTokens: usage["input"],
            outputTokens: usage["output"],
            cachedReadTokens: usage["cacheRead"],
            cachedWriteTokens: usage["cacheWrite"],
            totalTokens: usage["totalTokens"],
            usageContract: "anthropic_bucketed",
            source: "session_update",
          },
        });
      }
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
        if (isJsonObject(record["args"])) this.#toolArgs.set(toolCallId, record["args"]);
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
      const args = this.#toolArgs.get(toolCallId);
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
        this.#toolArgs.delete(toolCallId);
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
    if (type === "auto_compaction_end")
      return [{ kind: "context.compacted", payload: { reason: "pi.auto_compaction" } }];
    return [];
  }
}
