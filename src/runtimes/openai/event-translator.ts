import type { DriverEventInput } from "../../protocol/events";
import { toRuntimePublicId } from "../runtime-public-id";
import {
  isRecord,
  readArray,
  readNonEmptyString,
  readRecord,
  readString,
  stringifyForDisplay,
} from "./app-server-json";
import type { JsonObject } from "./app-server-json";

function withoutPrivateMeta(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutPrivateMeta);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      key === "_meta" ? [] : [[key, withoutPrivateMeta(entry)]],
    ),
  );
}

export function toOpenAiMessagePhase(item: JsonObject): "commentary" | "final" | null {
  if (readString(item, "delivery") === "async") return "commentary";

  switch (readString(item, "phase")) {
    case "commentary":
      return "commentary";
    case "final_answer":
      return "final";
    default:
      return null;
  }
}

export function toOpenAiToolName(item: JsonObject): string | null {
  const itemType = readString(item, "type");

  switch (itemType) {
    case "commandExecution":
      return "Shell";
    case "fileChange":
      return "File change";
    case "mcpToolCall": {
      const server = readNonEmptyString(item, "server");
      const tool = readNonEmptyString(item, "tool");

      return server !== null && tool !== null ? `${server}.${tool}` : (tool ?? "MCP tool");
    }
    case "dynamicToolCall":
      return readString(item, "tool") ?? "Tool";
    case "collabAgentToolCall":
      switch (readString(item, "tool")) {
        case "spawnAgent":
          return "Spawn agent";
        case "sendInput":
          return "Send input to agent";
        case "resumeAgent":
          return "Resume agent";
        case "wait":
          return "Wait for agents";
        case "closeAgent":
          return "Close agent";
        case "sendMessage":
          return "Send message to agent";
        case "followupTask":
          return "Follow up with agent";
        case "interruptAgent":
          return "Interrupt agent";
        case "listAgents":
          return "List agents";
        default:
          return null;
      }
    case "webSearch":
      return "Web search";
    case "imageView":
      return "View image";
    case "sleep":
      return "Sleep";
    case "imageGeneration":
      return "Image generation";
    default:
      return null;
  }
}

export function toOpenAiCollaborationOutput(item: JsonObject): JsonObject | null {
  if (readString(item, "type") !== "collabAgentToolCall") {
    return null;
  }

  const agentsStates = readRecord(item, "agentsStates") ?? {};
  const senderThreadId = readString(item, "senderThreadId");

  return {
    agentsStates: Object.fromEntries(
      Object.entries(agentsStates).map(([threadId, state]) => [
        toRuntimePublicId(threadId, "openai-thread"),
        state,
      ]),
    ),
    model: readString(item, "model"),
    prompt: readString(item, "prompt"),
    reasoningEffort: readString(item, "reasoningEffort"),
    receiverThreadIds: readArray(item, "receiverThreadIds")
      .filter((entry): entry is string => typeof entry === "string")
      .map((threadId) => toRuntimePublicId(threadId, "openai-thread")),
    senderThreadId:
      senderThreadId === null ? null : toRuntimePublicId(senderThreadId, "openai-thread"),
    status: readString(item, "status"),
    tool: readString(item, "tool"),
  };
}

export function toOpenAiToolResultText(item: JsonObject): string | null {
  const itemType = readString(item, "type");

  if (itemType === "commandExecution") {
    return readString(item, "aggregatedOutput");
  }

  if (itemType === "fileChange") {
    // file.change.updated is the durable authority for file paths. Repeating
    // provider diffs here can exceed CMA admission without adding information.
    return null;
  }

  if (itemType === "mcpToolCall") {
    const error = readRecord(item, "error");
    if (error !== null) {
      return readString(error, "message") ?? "MCP tool failed.";
    }

    return stringifyForDisplay(withoutPrivateMeta(readRecord(item, "result")?.["content"]));
  }

  if (itemType === "dynamicToolCall") {
    return stringifyForDisplay(item["contentItems"] ?? item["success"]);
  }

  if (itemType === "collabAgentToolCall") {
    return stringifyForDisplay(toOpenAiCollaborationOutput(item));
  }

  if (itemType === "webSearch") {
    return readString(item, "query");
  }

  if (itemType === "sleep") {
    const durationMs = item["durationMs"];
    return typeof durationMs === "number" && Number.isSafeInteger(durationMs)
      ? `Slept for ${String(durationMs)} ms.`
      : null;
  }

  if (itemType === "imageView") {
    return readString(item, "path");
  }

  if (itemType === "imageGeneration") {
    if (readString(item, "status") === "failed") {
      return "Image generation failed.";
    }

    return "Image generated.";
  }

  return null;
}

export function toOpenAiToolRawInput(item: JsonObject): string | null {
  switch (readString(item, "type")) {
    case "commandExecution":
      return readString(item, "command");
    case "mcpToolCall":
    case "dynamicToolCall":
      return item["arguments"] === undefined ? null : (JSON.stringify(item["arguments"]) ?? null);
    default:
      return null;
  }
}

export function toOpenAiToolStructuredOutput(item: JsonObject): unknown | null {
  switch (readString(item, "type")) {
    case "commandExecution":
      return {
        commandActions: item["commandActions"] ?? [],
        cwd: item["cwd"] ?? null,
        durationMs: item["durationMs"] ?? null,
        exitCode: item["exitCode"] ?? null,
        pluginId: item["pluginId"] ?? null,
        processId: item["processId"] ?? null,
        scriptPath: item["scriptPath"] ?? null,
        source: item["source"] ?? null,
      };
    case "mcpToolCall":
      return withoutPrivateMeta(readRecord(item, "result")?.["structuredContent"] ?? null);
    case "dynamicToolCall":
      return {
        contentItems: item["contentItems"] ?? null,
        durationMs: item["durationMs"] ?? null,
        namespace: item["namespace"] ?? null,
        success: item["success"] ?? null,
      };
    case "imageGeneration": {
      const failure = readRecord(item, "failure");
      return failure === null ? null : { failure };
    }
    default:
      return null;
  }
}

export function toOpenAiFileChangeEvents(item: JsonObject): DriverEventInput[] {
  if (readString(item, "type") !== "fileChange") {
    return [];
  }

  return readArray(item, "changes").flatMap((change) => {
    if (!isRecord(change)) {
      return [];
    }

    const path = readNonEmptyString(change, "path");
    const kind = readRecord(change, "kind");
    const changeType = readString(kind, "type");

    if (path === null) {
      return [];
    }

    const movePath = changeType === "update" ? readNonEmptyString(kind, "move_path") : null;
    const changes =
      movePath === null || movePath === path
        ? [{ change: changeType === "delete" ? ("delete" as const) : ("upsert" as const), path }]
        : [
            { change: "delete" as const, path },
            { change: "upsert" as const, path: movePath },
          ];

    return [
      {
        actor: "tool",
        kind: "file.change.updated",
        origin: "file",
        payload: {
          changes,
          status: "completed",
        },
      },
    ] satisfies DriverEventInput[];
  });
}
