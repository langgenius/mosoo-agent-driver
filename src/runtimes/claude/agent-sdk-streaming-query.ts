import { randomUUID } from "node:crypto";

import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AsyncValueQueue } from "../../core/async-value-queue";
import { ClaudeSessionUsage } from "./agent-sdk-session-usage";
import type { ClaudeTranscriptCursor } from "./agent-sdk-transcript";

interface StreamingTurn {
  readonly messages: AsyncValueQueue<SDKMessage>;
  readonly userMessageId: ReturnType<typeof randomUUID>;
  recycle: boolean;
  lastAssistant: Extract<SDKMessage, { type: "assistant" }> | null;
}

/** One SDK input stream and reader per native process; only one Run may submit at a time. */
export class ClaudeStreamingQuery {
  readonly query: Query;
  readonly finished: Promise<void>;
  readonly #inputs = new AsyncValueQueue<SDKUserMessage>("Claude prompts", 1);
  readonly #onIdleMessage: (message: SDKMessage) => Promise<void>;
  readonly #onFailure: (error: unknown) => void;
  readonly #usage = new ClaudeSessionUsage();
  #closed = false;
  #failure: { readonly error: unknown } | null = null;
  #resultDelivery: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  #turn: StreamingTurn | null = null;
  #transcriptCursor: ClaudeTranscriptCursor | null = null;

  constructor(options: {
    createQuery: (prompts: AsyncIterable<SDKUserMessage>) => Query;
    onIdleMessage: (message: SDKMessage) => Promise<void>;
    onFailure: (error: unknown) => void;
  }) {
    this.#onIdleMessage = options.onIdleMessage;
    this.#onFailure = options.onFailure;
    this.query = options.createQuery(this.#inputs.values());
    // The reader also observes idle EOF/errors, so a dead process is never reused.
    this.finished = this.#read();
  }

  get reusable(): boolean {
    return !this.#closed;
  }

  get transcriptCursor(): ClaudeTranscriptCursor | null {
    return this.#transcriptCursor;
  }

  throwIfFailed(): void {
    if (this.#failure !== null) {
      throw this.#failure.error;
    }
  }

  submit(text: string): AsyncIterator<SDKMessage> {
    if (this.#closed || this.#turn !== null || this.#resultDelivery !== null) {
      throw new Error("Claude streaming query is not ready for input.");
    }
    const turn: StreamingTurn = {
      messages: new AsyncValueQueue(
        "Claude messages",
        1_024,
        32 * 1_024 * 1_024,
        (message: SDKMessage) => Buffer.byteLength(JSON.stringify(message), "utf8"),
      ),
      recycle: false,
      lastAssistant: null,
      userMessageId: randomUUID(),
    };
    this.#turn = turn;
    this.#transcriptCursor = null;
    this.#inputs.push({
      message: { content: text, role: "user" },
      parent_tool_use_id: null,
      type: "user",
      uuid: turn.userMessageId,
    });
    const responses = async function* (session: ClaudeStreamingQuery) {
      yield* turn.messages.values();
      session.throwIfFailed();
    };
    return responses(this);
  }

  closeInput(): void {
    this.#closed = true;
    this.#inputs.close({ discard: true });
    this.releaseTurn();
  }

  releaseTurn(): void {
    this.#resultDelivery?.resolve();
    this.#resultDelivery = null;
  }

  async #read(): Promise<void> {
    try {
      for (;;) {
        const iteration = await this.query.next();
        if (iteration.done) {
          break;
        }
        const message = iteration.value;
        if (message.type === "conversation_reset") {
          this.#usage.reset();
        }
        const turn = this.#turn;
        if (turn === null) {
          if (this.#closed) {
            continue;
          }
          if (
            hasToolActivity(message) ||
            ["assistant", "stream_event", "user", "result"].includes(message.type)
          ) {
            throw new Error("Claude emitted turn content without an active input.");
          }
          await this.#onIdleMessage(message);
          continue;
        }

        // EOF still owns tool-tree cleanup and trailing tool/resource events.
        // Do not let background or detached tools outlive a completed Mosoo Run.
        turn.recycle ||= hasToolActivity(message);
        if (message.type === "assistant") turn.lastAssistant = message;
        if (message.type === "result") {
          if (
            message.user_message_uuid !== undefined &&
            message.user_message_uuid !== turn.userMessageId
          ) {
            throw new Error("Claude result belongs to a different input.");
          }
          turn.recycle ||= message.subtype !== "success" || message.is_error;
          turn.messages.push(this.#usage.difference(message));
          if (turn.recycle) {
            this.closeInput();
          } else {
            this.#transcriptCursor =
              turn.lastAssistant === null
                ? null
                : {
                    contentJson: JSON.stringify(turn.lastAssistant.message.content),
                    messageId: turn.lastAssistant.uuid,
                    sessionId: message.session_id,
                  };
            this.#turn = null;
            const delivery = Promise.withResolvers<void>();
            this.#resultDelivery = delivery;
            turn.messages.close();
            // Do not apply an idle conversation reset while its preceding result
            // is still being translated/published under the old native session ID.
            await delivery.promise;
          }
        } else {
          turn.messages.push(message);
        }
      }
    } catch (error) {
      this.#failure = { error };
      this.#onFailure(error);
    } finally {
      this.closeInput();
      this.#turn?.messages.close();
      this.#turn = null;
    }
  }
}

function hasToolActivity(message: SDKMessage): boolean {
  if (message.type === "assistant") {
    return message.message.content.some((block) => block.type === "tool_use");
  }
  if (message.type === "stream_event") {
    return (
      message.event.type === "content_block_start" &&
      message.event.content_block.type === "tool_use"
    );
  }
  if (message.type === "user") {
    return (
      Array.isArray(message.message.content) &&
      message.message.content.some((block) => block.type === "tool_result")
    );
  }
  return (
    message.type === "tool_progress" ||
    (message.type === "system" &&
      (message.subtype === "task_started" ||
        message.subtype === "task_notification" ||
        (message.subtype === "background_tasks_changed" && message.tasks.length > 0)))
  );
}
