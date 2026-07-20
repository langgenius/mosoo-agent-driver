import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { itemSchema } from "../../contract";
import type { ContentBlock } from "../../contract";
import { asJsonValue, ContractProjection, nonEmpty } from "../contract-projection";
import { isRecord, readNumber, readRecord, readString } from "./agent-sdk-json";
import type { JsonObject } from "./agent-sdk-json";
import { toContentBlocks, toolCategory } from "./contract-items";
import { createProviderMeta } from "../contract-adapter-meta";
import { ClaudeContractTranscriptState } from "./contract-transcript-state";
import { finishClaudeResult } from "./contract-result";

const { cause: providerCause, provenance } = createProviderMeta("anthropic");

export interface ClaudeContractTranscriptOptions {
  readonly createId: () => string;
  readonly maxToolInputBytes: number;
  readonly onRunReleased: (runId: string) => void;
  readonly projection: ContractProjection;
}

export class ClaudeContractTranscript {
  readonly #createId: () => string;
  readonly #onRunReleased: (runId: string) => void;
  readonly #projection: ContractProjection;
  readonly #state: ClaudeContractTranscriptState;

  constructor(options: ClaudeContractTranscriptOptions) {
    this.#createId = options.createId;
    this.#onRunReleased = options.onRunReleased;
    this.#projection = options.projection;
    this.#state = new ClaudeContractTranscriptState(options.createId, options.maxToolInputBytes);
  }

  async handleMessage(message: SDKMessage, runId: string): Promise<boolean> {
    switch (message.type) {
      case "assistant":
        await this.#onAssistant(message, runId);
        return false;
      case "result":
        await this.#onResult(message, runId);
        return true;
      case "stream_event":
        await this.#onStreamEvent(message, runId);
        return false;
      case "tool_progress":
        await this.#onToolProgress(message, runId);
        return false;
      case "user":
        await this.#onUserMessage(message, runId);
        return false;
      case "system":
        await this.#onSystemMessage(message, runId);
        return false;
      default:
        return false;
    }
  }

  async #onAssistant(
    message: Extract<SDKMessage, { type: "assistant" }>,
    runId: string,
  ): Promise<void> {
    const event = "assistant/message";
    const occurredAt = this.#projection.now().toISOString();
    const messageId = this.id(runId, "message", message.uuid);
    const reasoningId = this.#reasoningId(runId, messageId);
    const text: ContentBlock[] = [];
    const reasoning: ContentBlock[] = [];

    for (const block of message.message.content) {
      if (!isRecord(block)) {
        continue;
      }

      if (block["type"] === "text") {
        const content = toContentBlocks(block);

        if (content.length > 0) {
          await this.#ensureMessage(runId, messageId, event, message.uuid);
          text.push(...content);
        }
        continue;
      }

      if (block["type"] === "thinking") {
        const thinking = readString(block, "thinking");
        if (thinking !== null) {
          await this.#ensureReasoning(runId, messageId, event, message.uuid);
          reasoning.push({ text: thinking, type: "text" });
        }
        continue;
      }

      if (this.#isToolUse(block)) {
        await this.#putToolUse(runId, messageId, block, event, occurredAt);
        continue;
      }

      const toolUseId = readString(block, "tool_use_id");
      if (toolUseId !== null) {
        await this.#completeTool(runId, toolUseId, block, undefined, event, occurredAt);
      }
    }

    if (text.length > 0 || this.#projection.item(runId, messageId)?.kind === "message") {
      const current = this.#projection.item(runId, messageId);
      if (current?.status === "active" || current === undefined) {
        await this.#projection.putItem(
          runId,
          event,
          providerCause(event, message.uuid),
          itemSchema.parse({
            audience: "participants",
            content: text,
            createdAt: current?.createdAt ?? occurredAt,
            endedAt: occurredAt,
            ...(message.error === undefined
              ? { status: "completed" }
              : {
                  error: {
                    code: `anthropic.${message.error}`,
                    message: `Assistant message failed: ${message.error}.`,
                    retryable:
                      message.error === "overloaded" ||
                      message.error === "rate_limit" ||
                      message.error === "server_error",
                  },
                  status: "failed",
                }),
            id: messageId,
            kind: "message",
            phase: "final",
            provenance: provenance(event, {
              messageId: message.uuid,
              ...(message.parent_tool_use_id === null
                ? {}
                : { parentToolUseId: message.parent_tool_use_id }),
            }),
            role: "agent",
            runId,
            updatedAt: occurredAt,
            ...(message.supersedes === undefined && message.timestamp === undefined
              ? {}
              : {
                  extensions: {
                    ...(message.timestamp === undefined
                      ? {}
                      : { "anthropic.agent-sdk/source-timestamp": message.timestamp }),
                    ...(message.supersedes === undefined
                      ? {}
                      : { "anthropic.agent-sdk/supersedes": message.supersedes }),
                  },
                }),
          }),
        );
      }
    }

    const currentReasoning = this.#projection.item(runId, reasoningId);
    if (reasoning.length > 0 || currentReasoning?.kind === "reasoning") {
      if (currentReasoning?.status === "active" || currentReasoning === undefined) {
        await this.#projection.putItem(
          runId,
          event,
          providerCause(event, message.uuid),
          itemSchema.parse({
            audience: "participants",
            content: reasoning,
            createdAt: currentReasoning?.createdAt ?? occurredAt,
            endedAt: occurredAt,
            id: reasoningId,
            kind: "reasoning",
            provenance: provenance(event, { messageId: message.uuid }),
            runId,
            status: "completed",
            updatedAt: occurredAt,
            ...(message.timestamp === undefined
              ? {}
              : {
                  extensions: {
                    "anthropic.agent-sdk/source-timestamp": message.timestamp,
                  },
                }),
          }),
        );
      }
    }
  }

  async #onStreamEvent(
    message: Extract<SDKMessage, { type: "stream_event" }>,
    runId: string,
  ): Promise<void> {
    const event = isRecord(message.event) ? message.event : null;
    const eventType = readString(event, "type");
    const messageId = this.id(runId, "message", message.uuid);

    if (eventType === "message_start") {
      return;
    }

    if (eventType === "content_block_start") {
      const block = readRecord(event, "content_block");
      const index = readNumber(event, "index");

      if (block?.["type"] === "text") {
        await this.#ensureMessage(runId, messageId, "stream/content_block_start", message.uuid);
        const text = readString(block, "text");
        if (text !== null) {
          await this.#appendText(
            runId,
            messageId,
            "message.text",
            text,
            "stream/content_block_start",
          );
        }
      } else if (block?.["type"] === "thinking") {
        const reasoningId = await this.#ensureReasoning(
          runId,
          messageId,
          "stream/content_block_start",
          message.uuid,
        );
        const text = readString(block, "thinking");
        if (text !== null) {
          await this.#appendText(
            runId,
            reasoningId,
            "reasoning.text",
            text,
            "stream/content_block_start",
          );
        }
      } else if (block !== null && this.#isToolUse(block)) {
        const toolId = await this.#putToolUse(
          runId,
          messageId,
          block,
          "stream/content_block_start",
          this.#projection.now().toISOString(),
        );
        if (index !== null && !this.#state.hasAuthoritativeToolInput(`${runId}:${toolId}`)) {
          this.#state.setBlockToolId(`${runId}:${message.uuid}:${index}`, toolId);
        }
      }
      return;
    }

    if (eventType === "content_block_delta") {
      const delta = readRecord(event, "delta");
      const deltaType = readString(delta, "type");

      if (deltaType === "text_delta") {
        await this.#ensureMessage(runId, messageId, "stream/text_delta", message.uuid);
        await this.#appendText(
          runId,
          messageId,
          "message.text",
          readString(delta, "text") ?? "",
          "stream/text_delta",
        );
      } else if (deltaType === "thinking_delta") {
        const reasoningId = await this.#ensureReasoning(
          runId,
          messageId,
          "stream/thinking_delta",
          message.uuid,
        );
        await this.#appendText(
          runId,
          reasoningId,
          "reasoning.text",
          readString(delta, "thinking") ?? "",
          "stream/thinking_delta",
        );
      } else if (deltaType === "input_json_delta") {
        const index = readNumber(event, "index");
        const toolId =
          index === null ? undefined : this.#state.blockToolId(`${runId}:${message.uuid}:${index}`);
        const fragment = readString(delta, "partial_json");
        if (toolId !== undefined && fragment !== null) {
          this.#state.appendToolInput(`${runId}:${toolId}`, fragment);
        }
      }
      return;
    }

    if (eventType === "content_block_stop") {
      const index = readNumber(event, "index");
      const key = index === null ? null : `${runId}:${message.uuid}:${index}`;
      const toolId = key === null ? undefined : this.#state.blockToolId(key);

      if (toolId !== undefined) {
        const item = this.#projection.item(runId, toolId);
        const fragmentKey = `${runId}:${toolId}`;
        const buffer = this.#state.toolInputBuffer(fragmentKey);
        if (
          item?.kind === "tool" &&
          item.status === "active" &&
          buffer !== undefined &&
          !buffer.overflowed &&
          !this.#state.hasAuthoritativeToolInput(fragmentKey)
        ) {
          try {
            const input = this.toolInput(JSON.parse(buffer.text));
            if (input !== undefined) {
              await this.#projection.putItem(
                runId,
                "stream/input_json",
                providerCause("stream/input_json", toolId),
                itemSchema.parse({
                  ...item,
                  input,
                  updatedAt: this.#projection.now().toISOString(),
                }),
              );
            }
          } catch {}
        }
        this.#state.dropToolInput(fragmentKey);
      }
      if (key !== null) {
        this.#state.deleteBlockToolId(key);
      }
      return;
    }
  }

  async #onUserMessage(
    message: Extract<SDKMessage, { type: "user" }>,
    runId: string,
  ): Promise<void> {
    const blocks = Array.isArray(message.message.content) ? message.message.content : [];
    const occurredAt = this.#projection.now().toISOString();

    for (const block of blocks) {
      if (!isRecord(block) || block["type"] !== "tool_result") {
        continue;
      }

      const toolUseId = readString(block, "tool_use_id");
      if (toolUseId !== null) {
        await this.#completeTool(
          runId,
          toolUseId,
          block,
          message.tool_use_result,
          "user/tool_result",
          occurredAt,
        );
      }
    }
  }

  async #onToolProgress(
    message: Extract<SDKMessage, { type: "tool_progress" }>,
    runId: string,
  ): Promise<void> {
    const itemId = this.id(runId, "tool", message.tool_use_id);
    const name = nonEmpty(message.tool_name, "Tool");
    let item = this.#projection.item(runId, itemId);

    if (item === undefined) {
      const now = this.#projection.now().toISOString();
      item = await this.#projection.putItem(
        runId,
        "tool/progress",
        providerCause("tool/progress", message.tool_use_id),
        itemSchema.parse({
          audience: "participants",
          category: toolCategory(name),
          createdAt: now,
          id: itemId,
          kind: "tool",
          name,
          origin: name.startsWith("mcp__") ? "mcp" : "provider",
          provenance: provenance("tool/progress", { toolUseId: message.tool_use_id }),
          runId,
          status: "active",
          updatedAt: now,
        }),
      );
    }

    if (item.status === "active") {
      await this.#projection.replacePreview({
        channel: "tool.progress",
        itemId,
        runId,
        text: `${name} (${message.elapsed_time_seconds.toFixed(1)}s)`,
      });
    }
  }

  async #onSystemMessage(
    message: Extract<SDKMessage, { type: "system" }>,
    runId: string,
  ): Promise<void> {
    if (message.subtype === "files_persisted" && message.files.length > 0) {
      const changes = message.files.flatMap((file) =>
        file.filename.trim().length === 0 ? [] : [{ operation: "update", path: file.filename }],
      );

      if (changes.length === 0) {
        return;
      }

      const now = this.#projection.now().toISOString();
      const id = this.id(runId, "files", message.uuid);

      if (this.#projection.item(runId, id) !== undefined) {
        return;
      }

      await this.#projection.putItem(
        runId,
        "system/files_persisted",
        providerCause("system/files_persisted", message.uuid),
        itemSchema.parse({
          audience: "participants",
          changes,
          createdAt: now,
          endedAt: now,
          id,
          kind: "change",
          provenance: provenance("system/files_persisted", { messageId: message.uuid }),
          runId,
          status: "completed",
          updatedAt: now,
        }),
      );
      return;
    }

    if (message.subtype === "task_started") {
      const now = this.#projection.now().toISOString();
      const id = this.id(runId, "task", message.task_id);

      if (this.#projection.item(runId, id) !== undefined) {
        return;
      }

      const name = nonEmpty(
        message.subagent_type ?? message.workflow_name ?? message.task_type,
        "Agent",
      );
      await this.#projection.putItem(
        runId,
        "system/task_started",
        providerCause("system/task_started", message.task_id),
        itemSchema.parse({
          audience: message.skip_transcript === true ? "operators" : "participants",
          category: "agent",
          createdAt: now,
          id,
          input: message.prompt,
          kind: "tool",
          name,
          origin: "provider",
          provenance: provenance("system/task_started", { taskId: message.task_id }),
          runId,
          status: "active",
          ...(message.description.trim().length === 0 ? {} : { title: message.description }),
          updatedAt: now,
        }),
      );
      return;
    }

    if (message.subtype === "task_progress") {
      const id = this.id(runId, "task", message.task_id);
      const item = this.#projection.item(runId, id);
      if (item?.kind === "tool" && item.status === "active") {
        await this.#projection.replacePreview({
          channel: "tool.progress",
          itemId: id,
          runId,
          text: message.summary ?? message.description,
        });
      }
      return;
    }

    if (message.subtype === "task_updated") {
      const id = this.id(runId, "task", message.task_id);
      const item = this.#projection.item(runId, id);
      const status = message.patch.status;
      if (item?.kind === "tool" && item.status === "active" && status !== undefined) {
        await this.#projection.replacePreview({
          channel: "tool.progress",
          itemId: id,
          runId,
          text: nonEmpty(message.patch.description, `Agent task ${status}`),
        });
      }
      return;
    }

    if (message.subtype === "task_notification") {
      const id = this.id(runId, "task", message.task_id);
      const item = this.#projection.item(runId, id);
      if (item?.kind === "tool" && item.status === "active") {
        const now = this.#projection.now().toISOString();
        const failed = message.status === "failed";
        await this.#projection.putItem(
          runId,
          "system/task_notification",
          providerCause("system/task_notification", message.task_id),
          itemSchema.parse({
            ...item,
            endedAt: now,
            ...(failed
              ? {
                  error: {
                    code: "anthropic.task_failed",
                    message: nonEmpty(message.summary, "Agent task failed."),
                    retryable: false,
                  },
                }
              : {}),
            output: toContentBlocks(message.summary),
            status: failed ? "failed" : message.status === "stopped" ? "cancelled" : "completed",
            structuredOutput: asJsonValue(message.usage),
            updatedAt: now,
          }),
        );
      }
    }
  }

  async #onResult(message: Extract<SDKMessage, { type: "result" }>, runId: string): Promise<void> {
    await finishClaudeResult({
      id: (id, kind, nativeId) => this.id(id, kind, nativeId),
      message,
      onRunReleased: this.#onRunReleased,
      projection: this.#projection,
      runId,
    });
  }

  async #ensureMessage(
    runId: string,
    messageId: string,
    event: string,
    nativeMessageId: string,
  ): Promise<void> {
    if (this.#projection.item(runId, messageId) !== undefined) {
      return;
    }

    const now = this.#projection.now().toISOString();
    await this.#projection.putItem(
      runId,
      event,
      providerCause(event, nativeMessageId),
      itemSchema.parse({
        audience: "participants",
        content: [],
        createdAt: now,
        id: messageId,
        kind: "message",
        phase: "final",
        provenance: provenance(event, { messageId: nativeMessageId }),
        role: "agent",
        runId,
        status: "active",
        updatedAt: now,
      }),
    );
  }

  async #ensureReasoning(
    runId: string,
    messageId: string,
    event: string,
    nativeMessageId: string,
  ): Promise<string> {
    const id = this.#reasoningId(runId, messageId);

    if (this.#projection.item(runId, id) === undefined) {
      const now = this.#projection.now().toISOString();
      await this.#projection.putItem(
        runId,
        event,
        providerCause(event, nativeMessageId),
        itemSchema.parse({
          audience: "participants",
          content: [],
          createdAt: now,
          id,
          kind: "reasoning",
          provenance: provenance(event, { messageId: nativeMessageId }),
          runId,
          status: "active",
          updatedAt: now,
        }),
      );
    }

    return id;
  }

  async #appendText(
    runId: string,
    itemId: string,
    channel: "message.text" | "reasoning.text",
    delta: string,
    event: string,
  ): Promise<void> {
    await this.#projection.appendText({
      cause: providerCause(event, itemId),
      channel,
      delta,
      event,
      itemId,
      runId,
    });
  }

  async #putToolUse(
    runId: string,
    parentMessageId: string,
    block: JsonObject,
    event: string,
    occurredAt: string,
  ): Promise<string> {
    const nativeId = readString(block, "id") ?? this.#createId();
    const id = this.id(runId, "tool", nativeId);
    const existing = this.#projection.item(runId, id);
    const inputKey = `${runId}:${id}`;
    const authoritative = event === "assistant/message";

    if (existing !== undefined && existing.status !== "active") {
      return id;
    }

    if (!authoritative && this.#state.hasAuthoritativeToolInput(inputKey)) {
      return id;
    }

    if (authoritative) {
      this.#state.dropToolInput(inputKey);
      this.#state.deleteBlockToolIdsForTool(id);
    }

    const name = nonEmpty(readString(block, "name"), "Tool");
    const type = readString(block, "type");
    const server = readString(block, "server_name");
    const input = this.toolInput(block["input"]);
    await this.#projection.putItem(
      runId,
      event,
      providerCause(event, nativeId),
      itemSchema.parse({
        audience: "participants",
        category: toolCategory(name),
        createdAt: existing?.createdAt ?? occurredAt,
        id,
        input,
        kind: "tool",
        name,
        origin: type === "mcp_tool_use" || name.startsWith("mcp__") ? "mcp" : "provider",
        provenance: provenance(event, { messageId: parentMessageId, toolUseId: nativeId }),
        runId,
        ...(server === null || server.trim().length === 0 ? {} : { server }),
        status: "active",
        title: name,
        updatedAt: occurredAt,
      }),
    );
    if (authoritative) {
      this.#state.markAuthoritativeToolInput(runId, id);
    }
    return id;
  }

  async #completeTool(
    runId: string,
    nativeToolId: string,
    block: JsonObject,
    structuredOutput: unknown,
    event: string,
    occurredAt: string,
  ): Promise<void> {
    const id = this.id(runId, "tool", nativeToolId);
    const existing = this.#projection.item(runId, id);

    if (existing !== undefined && (existing.kind !== "tool" || existing.status !== "active")) {
      return;
    }

    const failed = block["is_error"] === true;
    const output = toContentBlocks(block["content"]);
    const structured = asJsonValue(structuredOutput);
    const errorText = output
      .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
      .join("\n");
    await this.#projection.putItem(
      runId,
      event,
      providerCause(event, nativeToolId),
      itemSchema.parse({
        audience: "participants",
        category: existing?.kind === "tool" ? existing.category : "other",
        createdAt: existing?.createdAt ?? occurredAt,
        endedAt: occurredAt,
        ...(failed
          ? {
              error: {
                code: "anthropic.tool_failed",
                message: errorText || "Tool failed.",
                retryable: false,
              },
            }
          : {}),
        id,
        input: existing?.kind === "tool" ? existing.input : undefined,
        kind: "tool",
        name: existing?.kind === "tool" ? existing.name : "Tool",
        origin: existing?.kind === "tool" ? existing.origin : "provider",
        output,
        provenance: provenance(event, { toolUseId: nativeToolId }),
        runId,
        status: failed ? "failed" : "completed",
        ...(structured === undefined ? {} : { structuredOutput: structured }),
        title: existing?.kind === "tool" ? existing.title : undefined,
        updatedAt: occurredAt,
      }),
    );
  }

  #reasoningId(runId: string, messageId: string): string {
    return this.#state.reasoningId(runId, messageId);
  }

  id(runId: string, kind: string, nativeId: string): string {
    return this.#state.id(runId, kind, nativeId);
  }

  #isToolUse(block: JsonObject): boolean {
    return ["mcp_tool_use", "server_tool_use", "tool_use"].includes(
      readString(block, "type") ?? "",
    );
  }

  markAuthoritativeToolInput(runId: string, itemId: string): void {
    this.#state.markAuthoritativeToolInput(runId, itemId);
  }

  toolInput(value: unknown) {
    return this.#state.toolInput(value);
  }

  releaseRun(runId: string): void {
    this.#state.releaseRun(runId);
  }

  dispose(): void {
    this.#state.dispose();
  }
}
