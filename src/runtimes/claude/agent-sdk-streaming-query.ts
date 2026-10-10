import { randomUUID } from "node:crypto";

import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AsyncValueQueue } from "../../core/async-value-queue";
import { requireClaudeNativeSessionId } from "./agent-sdk-resume";
import { ClaudeSessionUsage } from "./agent-sdk-session-usage";
import type { ClaudeTranscriptCursor } from "./agent-sdk-transcript";

interface StreamingTurn {
  readonly messages: AsyncValueQueue<SDKMessage>;
  readonly userMessageId: ReturnType<typeof randomUUID>;
  recycle: boolean;
  resultReceived: boolean;
  lastAssistant: Extract<SDKMessage, { type: "assistant" }> | null;
}

/** One SDK input stream and reader per native process; only one Run may submit at a time. */
export class ClaudeStreamingQuery {
  readonly query: Query;
  readonly finished: Promise<void>;
  readonly #inputs = new AsyncValueQueue<SDKUserMessage>("Claude prompts", 1);
  readonly #onIdleMessage: (message: SDKMessage) => Promise<void>;
  readonly #onFailure: (error: unknown) => void;
  readonly #ready: Promise<void>;
  readonly #reuse: boolean;
  readonly #usage = new ClaudeSessionUsage();
  readonly #pendingControls: { readonly bytes: number; readonly message: SDKMessage }[] = [];
  #closed = false;
  #controlDelivery: Promise<void> | null = null;
  #failure: { readonly error: unknown } | null = null;
  #observedNativeSessionId: string | null = null;
  #pendingControlBytes = 0;
  #turn: StreamingTurn | null = null;
  #turnReleased = true;
  #transcriptCursor: ClaudeTranscriptCursor | null = null;

  constructor(options: {
    createQuery: (prompts: AsyncIterable<SDKUserMessage>) => Query;
    onIdleMessage: (message: SDKMessage) => Promise<void>;
    onFailure: (error: unknown) => void;
    reuse: boolean;
  }) {
    this.#onIdleMessage = options.onIdleMessage;
    this.#onFailure = options.onFailure;
    this.#reuse = options.reuse;
    this.query = options.createQuery(this.#inputs.values());
    this.#ready = this.#usage.initialize(this.query);
    // The reader also observes idle EOF/errors, so a dead process is never reused.
    this.finished = this.#read();
  }

  get reusable(): boolean {
    return !this.#closed;
  }

  get transcriptCursor(): ClaudeTranscriptCursor | null {
    return this.#transcriptCursor;
  }

  get observedNativeSessionId(): string | null {
    return this.#observedNativeSessionId;
  }

  get hasPendingControls(): boolean {
    return this.#pendingControls.length > 0;
  }

  throwIfFailed(): void {
    if (this.#failure !== null) {
      throw this.#failure.error;
    }
  }

  submit(text: string): AsyncIterator<SDKMessage> {
    if (this.#closed || this.#turn !== null || !this.#turnReleased || this.hasPendingControls) {
      throw new Error("Claude streaming query is not ready for input.");
    }
    const turn: StreamingTurn = {
      messages: new AsyncValueQueue(
        "Claude messages",
        1_024,
        32 * 1_024 * 1_024,
        (message: SDKMessage) => Buffer.byteLength(JSON.stringify(message), "utf8"),
      ),
      recycle: !this.#reuse,
      resultReceived: false,
      lastAssistant: null,
      userMessageId: randomUUID(),
    };
    this.#turn = turn;
    this.#turnReleased = false;
    this.#transcriptCursor = null;
    void this.#ready
      .then(() => {
        if (this.#closed || this.#turn !== turn) return;
        this.#inputs.push({
          message: { content: text, role: "user" },
          parent_tool_use_id: null,
          type: "user",
          uuid: turn.userMessageId,
        });
      })
      .catch((error: unknown) => this.#fail(error));
    const responses = async function* (session: ClaudeStreamingQuery) {
      yield* turn.messages.values();
      session.throwIfFailed();
    };
    return responses(this);
  }

  closeInput(): void {
    this.#closed = true;
    this.#inputs.close({ discard: true });
  }

  async releaseTurn(): Promise<void> {
    this.#turnReleased = true;
    await this.flushControls();
  }

  async flushControls(): Promise<void> {
    if (!this.#turnReleased && this.hasPendingControls) {
      throw new Error("Claude session controls are waiting for the preceding Run terminal.");
    }
    while (this.hasPendingControls || this.#controlDelivery !== null) {
      if (this.#controlDelivery === null) {
        this.#controlDelivery = (async () => {
          while (this.#pendingControls.length > 0) {
            const control = this.#pendingControls[0]!;
            await this.#onIdleMessage(control.message);
            this.#pendingControls.shift();
            this.#pendingControlBytes -= control.bytes;
          }
        })()
          .catch((error: unknown) => {
            this.#fail(error);
            throw error;
          })
          .finally(() => {
            this.#controlDelivery = null;
          });
      }
      await this.#controlDelivery;
    }
  }

  #queueControl(message: SDKMessage): void {
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (this.#pendingControls.length >= 64 || bytes > 64 * 1_024 - this.#pendingControlBytes) {
      throw new Error("Claude pending session controls exceed 64 messages or 64 KiB.");
    }
    this.#pendingControls.push({ bytes, message });
    this.#pendingControlBytes += bytes;
    if (this.#turnReleased) {
      void this.flushControls().catch(() => {});
    }
  }

  #fail(error: unknown): void {
    if (this.#failure === null) {
      this.#failure = { error };
      this.#onFailure(error);
    }
    this.closeInput();
  }

  async #read(): Promise<void> {
    try {
      await this.#ready;
      for (;;) {
        const iteration = await this.query.next();
        if (iteration.done) {
          break;
        }
        const message = iteration.value;
        if (message.type === "conversation_reset") {
          this.#usage.reset();
          this.#observedNativeSessionId = requireClaudeNativeSessionId(message.new_conversation_id);
        } else if (
          this.#observedNativeSessionId === null &&
          "session_id" in message &&
          typeof message.session_id === "string"
        ) {
          this.#observedNativeSessionId = requireClaudeNativeSessionId(message.session_id);
        }
        const turn = this.#turn;
        if (turn === null) {
          if (
            hasToolActivity(message) ||
            ["assistant", "stream_event", "user", "result"].includes(message.type)
          ) {
            throw new Error("Claude emitted turn content without an active input.");
          }
          this.#queueControl(message);
          continue;
        }
        if (message.type === "conversation_reset" && turn.resultReceived) {
          this.#queueControl(message);
          continue;
        }

        // EOF still owns tool-tree cleanup and trailing tool/resource events.
        // Do not let background or detached tools outlive a completed Mosoo Run.
        turn.recycle ||= hasToolActivity(message);
        if (message.type === "assistant") turn.lastAssistant = message;
        if (message.type === "result") {
          turn.resultReceived = true;
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
            turn.messages.close();
            // Reading must reach EOF even while host delivery waits for this Run's terminal.
          }
        } else {
          turn.messages.push(message);
        }
      }
    } catch (error) {
      this.#fail(error);
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
