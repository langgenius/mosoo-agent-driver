import { itemSchema } from "../../contract";
import type { ContentBlock, FileChange, Item, ProtocolError, TokenUsage } from "../../contract";
import { asJsonValue, createProviderMeta } from "../contract-adapter-meta";
import { isRecord, readArray, readNonEmptyString, readRecord, readString } from "./app-server-json";
import type { JsonObject } from "./app-server-json";
import { filterOpenAiPrivateCitations } from "./private-citation-filter";

const PROVIDER_EXTENSION_ITEM = "openai.app-server/thread-item";
const providerMeta = createProviderMeta("openai");

export type NativeItemLifecycle = "completed" | "started";

export interface OpenAiItemTurn {
  readonly runId: string;
  readonly threadId: string;
  readonly turnId: string;
}

type DynamicToolContentItem =
  | { imageUrl: string; type: "inputImage" }
  | { text: string; type: "inputText" };

export function requireRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

export function requireString(value: JsonObject, key: string, label: string): string {
  const entry = readNonEmptyString(value, key);

  if (entry === null) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }

  return entry;
}

export function readFiniteNumber(value: JsonObject, key: string): number | null {
  const entry = value[key];
  return typeof entry === "number" && Number.isFinite(entry) ? entry : null;
}

const usageKeys = ["cachedInput", "input", "output", "reasoning", "total"] as const;
const nativeUsageKeys = {
  cachedInput: "cachedInputTokens",
  input: "inputTokens",
  output: "outputTokens",
  reasoning: "reasoningOutputTokens",
  total: "totalTokens",
} as const satisfies Record<(typeof usageKeys)[number], string>;

export function toUsage(value: JsonObject | null): TokenUsage | undefined {
  if (value === null) {
    return undefined;
  }

  const usage: TokenUsage = {};

  for (const key of usageKeys) {
    const entry = readFiniteNumber(value, nativeUsageKeys[key]);

    if (entry !== null && entry >= 0 && Number.isSafeInteger(entry)) {
      usage[key] = entry;
    }
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function subtractUsage(total: TokenUsage, baseline: TokenUsage): TokenUsage {
  const usage: TokenUsage = {};

  for (const key of usageKeys) {
    const value = total[key];

    if (value !== undefined) {
      usage[key] = Math.max(0, value - (baseline[key] ?? 0));
    }
  }

  return usage;
}

export function monotonicUsage(previous: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const usage: TokenUsage = {};

  for (const key of usageKeys) {
    const value = next[key] ?? previous?.[key];

    if (value !== undefined) {
      usage[key] = Math.max(value, previous?.[key] ?? 0);
    }
  }

  return usage;
}

export function latestTimestamp(previous: string | undefined, next: string): string {
  return previous !== undefined && Date.parse(previous) > Date.parse(next) ? previous : next;
}

export function textContent(text: string): ContentBlock[] {
  return text.length === 0 ? [] : [{ text, type: "text" }];
}

export function providerEventId(method: string, params: JsonObject): string {
  const ids = [
    readString(params, "turnId"),
    readString(readRecord(params, "turn"), "id"),
    readString(params, "itemId"),
    readString(readRecord(params, "item"), "id"),
  ].filter((entry) => entry !== null);
  return [method, ...ids].join(":").slice(0, 256);
}

export function provenance(
  event: string,
  input: { itemId?: string; requestId?: string; threadId: string; turnId: string },
) {
  return providerMeta.provenance(event, input);
}

export function itemStatus(item: JsonObject, lifecycle: NativeItemLifecycle): Item["status"] {
  if (lifecycle === "started") {
    return "active";
  }

  const status = readString(item, "status");

  if (status === "failed") {
    return "failed";
  }

  if (status === "declined") {
    return "cancelled";
  }

  return "completed";
}

export function itemError(item: JsonObject, type: string): ProtocolError {
  const error = readRecord(item, "error");

  return {
    code: `openai.${type}.failed`,
    message: readString(error, "message") ?? `${type} failed.`,
    retryable: false,
  };
}

export function toFileChanges(item: JsonObject): FileChange[] {
  return readArray(item, "changes").flatMap<FileChange>((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const path = readNonEmptyString(entry, "path");
    const kind = readRecord(entry, "kind");
    const type = readString(kind, "type");

    if (path === null || (type !== "add" && type !== "delete" && type !== "update")) {
      return [];
    }

    const movePath = readNonEmptyString(kind, "move_path");
    const diff = readString(entry, "diff");

    if (type === "update" && movePath !== null) {
      return [
        {
          ...(diff === null || diff.length === 0 ? {} : { diff: { text: diff, type: "text" } }),
          oldPath: path,
          operation: "move",
          path: movePath,
        },
      ];
    }

    return [
      {
        ...(diff === null || diff.length === 0 ? {} : { diff: { text: diff, type: "text" } }),
        operation: type === "add" ? "create" : type === "delete" ? "delete" : "update",
        path,
      },
    ];
  });
}

export function dynamicToolName(value: JsonObject): string | null {
  const tool = readNonEmptyString(value, "tool");
  const namespace = readNonEmptyString(value, "namespace");
  return tool === null ? null : namespace === null ? tool : `${namespace}/${tool}`;
}

export function toNativeToolContent(block: ContentBlock): DynamicToolContentItem[] {
  if (block.type === "text") {
    return [{ text: block.text, type: "inputText" }];
  }

  if (block.type === "json") {
    return [{ text: JSON.stringify(block.value), type: "inputText" }];
  }

  if (block.type === "resource_link" && block.mediaType?.startsWith("image/")) {
    return [{ imageUrl: block.uri, type: "inputImage" }];
  }

  if (block.type === "inline_blob" && block.mediaType.startsWith("image/")) {
    return [
      {
        imageUrl: `data:${block.mediaType};base64,${block.data}`,
        type: "inputImage",
      },
    ];
  }

  if (block.type === "extension") {
    return [{ text: JSON.stringify(block.value), type: "inputText" }];
  }

  return [];
}

export function fromNativeToolContent(value: JsonObject | null): ContentBlock[] {
  return readArray(value, "contentItems").flatMap<ContentBlock>((entry) => {
    if (!isRecord(entry)) {
      const json = asJsonValue(entry);
      return json === undefined ? [] : [{ type: "json", value: json }];
    }

    if (readString(entry, "type") === "inputText") {
      const text = readString(entry, "text");
      return text === null ? [] : [{ text, type: "text" }];
    }

    if (readString(entry, "type") === "inputImage") {
      const imageUrl = readNonEmptyString(entry, "imageUrl");
      const dataUrl = imageUrl?.match(/^data:([^;,]+);base64,(.+)$/su);

      if (dataUrl?.[1] !== undefined && dataUrl[2] !== undefined) {
        return [{ data: dataUrl[2], mediaType: dataUrl[1], type: "inline_blob" }];
      }

      if (imageUrl !== null && URL.canParse(imageUrl)) {
        return [{ type: "resource_link", uri: imageUrl }];
      }
    }

    const json = asJsonValue(entry);
    return json === undefined ? [] : [{ type: "json", value: json }];
  });
}

export function projectOpenAiItem(
  turn: OpenAiItemTurn,
  native: JsonObject,
  lifecycle: NativeItemLifecycle,
  occurredAt: string,
  event: string,
  lookupItem: (runId: string, itemId: string) => Item | undefined,
): Item | null {
  const id = readNonEmptyString(native, "id");
  const type = readString(native, "type");

  if (id === null || type === null || type === "userMessage") {
    return null;
  }

  const existing = lookupItem(turn.runId, id);
  const status = itemStatus(native, lifecycle);
  const updatedAt = latestTimestamp(existing?.updatedAt, occurredAt);
  const base = {
    audience: type === "hookPrompt" ? "operators" : "participants",
    createdAt: existing?.createdAt ?? occurredAt,
    ...(status === "active" ? {} : { endedAt: updatedAt }),
    ...(status === "failed" ? { error: itemError(native, type) } : {}),
    id,
    provenance: provenance(event, {
      itemId: id,
      threadId: turn.threadId,
      turnId: turn.turnId,
    }),
    runId: turn.runId,
    status,
    updatedAt,
  };
  if (type === "agentMessage") {
    const nativeText = readString(native, "text");

    if (nativeText === null) {
      return null;
    }

    const phase = readString(native, "phase");
    const text = filterOpenAiPrivateCitations(nativeText).text;
    return itemSchema.parse({
      ...base,
      content: textContent(text),
      kind: "message",
      ...(phase === "commentary"
        ? { phase: "commentary" }
        : phase === "final_answer"
          ? { phase: "final" }
          : {}),
      role: "agent",
    });
  }

  if (type === "reasoning") {
    const text = readArray(native, "summary")
      .filter((entry) => typeof entry === "string")
      .join("\n\n");

    return itemSchema.parse({
      ...base,
      content: textContent(text),
      kind: "reasoning",
    });
  }

  if (type === "commandExecution") {
    const command = readString(native, "command");

    if (command === null) {
      return null;
    }

    const exitCode = readFiniteNumber(native, "exitCode");
    const aggregatedOutput = readString(native, "aggregatedOutput") ?? "";
    const cwd = readNonEmptyString(native, "cwd");

    return itemSchema.parse({
      ...base,
      command,
      ...(cwd === null ? {} : { cwd }),
      ...(exitCode === null ? {} : { exitCode }),
      kind: "terminal",
      stderr: [],
      stdout: textContent(aggregatedOutput),
    });
  }

  if (type === "fileChange") {
    const changes = toFileChanges(native);

    return changes.length === 0 && existing?.kind !== "change"
      ? null
      : itemSchema.parse({ ...base, changes, kind: "change" });
  }

  if (type === "mcpToolCall") {
    const server = readNonEmptyString(native, "server");
    const tool = readNonEmptyString(native, "tool");

    if (server === null || tool === null) {
      return null;
    }

    const result = readRecord(native, "result");
    const jsonInput = asJsonValue(native["arguments"]);
    const output = readArray(result, "content").flatMap<ContentBlock>((entry) => {
      if (isRecord(entry) && readString(entry, "type") === "text") {
        const text = readString(entry, "text");

        if (text !== null) {
          return [{ text, type: "text" }];
        }
      }

      const value = asJsonValue(entry);
      return value === undefined ? [] : [{ type: "json", value }];
    });
    const structuredOutput = asJsonValue(result?.["structuredContent"]);

    return itemSchema.parse({
      ...base,
      category: "other",
      ...(jsonInput === undefined ? {} : { input: jsonInput }),
      kind: "tool",
      name: tool,
      origin: "mcp",
      ...(output.length === 0 ? {} : { output }),
      server,
      ...(structuredOutput === undefined || structuredOutput === null ? {} : { structuredOutput }),
    });
  }

  if (type === "webSearch") {
    const query = readString(native, "query");

    if (query === null) {
      return null;
    }

    const action = asJsonValue(native["action"]);
    const structuredOutput = asJsonValue(native["results"]);

    return itemSchema.parse({
      ...base,
      category: "search",
      input: {
        ...(action === undefined || action === null ? {} : { action }),
        query,
      },
      kind: "tool",
      name: "web_search",
      origin: "provider",
      ...(structuredOutput === undefined || structuredOutput === null ? {} : { structuredOutput }),
    });
  }

  if (type === "plan") {
    const text = readString(native, "text");

    if (text === null) {
      return null;
    }

    const completed = lifecycle === "completed" || readString(native, "status") === "completed";

    return itemSchema.parse({
      ...base,
      entries: [{ id: "0", status: completed ? "completed" : "pending", text }],
      kind: "plan",
    });
  }

  if (type === "imageGeneration") {
    const result = readNonEmptyString(native, "result");
    const revisedPrompt = readNonEmptyString(native, "revisedPrompt");
    const savedPath = readNonEmptyString(native, "savedPath");

    return itemSchema.parse({
      ...base,
      category: "other",
      ...(revisedPrompt === null ? {} : { input: { revisedPrompt } }),
      kind: "tool",
      ...(savedPath === null ? {} : { locations: [{ path: savedPath }] }),
      name: "image_generation",
      origin: "provider",
      ...(result === null
        ? {}
        : { output: [{ data: result, mediaType: "image/png", type: "inline_blob" }] }),
    });
  }

  if (type === "dynamicToolCall") {
    const name = dynamicToolName(native);

    if (name === null) {
      return null;
    }

    const input = asJsonValue(native["arguments"]);
    const output = fromNativeToolContent(native);

    return itemSchema.parse({
      ...base,
      category: "other",
      ...(input === undefined ? {} : { input }),
      kind: "tool",
      name,
      origin: "provider",
      ...(output.length === 0 ? {} : { output }),
    });
  }

  if (type === "collabAgentToolCall") {
    const name = readNonEmptyString(native, "tool");

    if (name === null) {
      return null;
    }

    const input = asJsonValue({
      model: native["model"] ?? null,
      prompt: native["prompt"] ?? null,
      reasoningEffort: native["reasoningEffort"] ?? null,
      receiverThreadIds: readArray(native, "receiverThreadIds"),
      senderThreadId: native["senderThreadId"] ?? null,
    });
    const structuredOutput = asJsonValue(native["agentsStates"]);

    return itemSchema.parse({
      ...base,
      category: "agent",
      ...(input === undefined ? {} : { input }),
      kind: "tool",
      name,
      origin: "provider",
      ...(structuredOutput === undefined ? {} : { structuredOutput }),
    });
  }

  if (type === "subAgentActivity") {
    const input = asJsonValue({
      agentPath: native["agentPath"] ?? null,
      agentThreadId: native["agentThreadId"] ?? null,
      kind: native["kind"] ?? null,
    });

    return itemSchema.parse({
      ...base,
      category: "agent",
      ...(input === undefined ? {} : { input }),
      kind: "tool",
      name: "sub_agent_activity",
      origin: "provider",
    });
  }

  if (type === "imageView" || type === "sleep") {
    const name =
      readNonEmptyString(native, "tool") ??
      (type === "imageView" ? "image_view" : type === "sleep" ? "sleep" : type);
    const input = native["arguments"] ?? native["path"] ?? native["durationMs"];
    const output = native["contentItems"];
    const jsonInput = asJsonValue(input);
    const jsonOutput = asJsonValue(output);

    return itemSchema.parse({
      ...base,
      category: type === "imageView" ? "read" : "other",
      ...(jsonInput === undefined ? {} : { input: jsonInput }),
      kind: "tool",
      name,
      origin: "provider",
      ...(jsonOutput !== undefined
        ? { output: [{ type: "json", value: jsonOutput }], structuredOutput: jsonOutput }
        : {}),
    });
  }

  return itemSchema.parse({
    ...base,
    kind: "extension",
    name: PROVIDER_EXTENSION_ITEM,
    value: asJsonValue(native) ?? { nativeType: type },
  });
}
