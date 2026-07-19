import type {
  ContentBlock as AcpContentBlock,
  SessionConfigOption,
  ToolCall,
  ToolCallContent,
  ToolKind,
  Usage,
} from "@agentclientprotocol/sdk";

import { configOptionSchema } from "../../contract";
import type {
  ConfigOption,
  ContentBlock,
  FileChange,
  ItemStatus,
  ProtocolError,
  TokenUsage,
  ToolItem,
} from "../../contract";
import { asJsonValue, nonEmpty } from "../contract-projection";

const SELECT_GROUPS_EXTENSION = "agentclientprotocol.v1/select-groups";

function resourceName(uri: string): string {
  try {
    const path = new URL(uri).pathname;
    return decodeURIComponent(path.split("/").filter(Boolean).at(-1) ?? "resource").slice(0, 1_024);
  } catch {
    return "resource";
  }
}

export function toContentBlocks(block: AcpContentBlock): ContentBlock[] {
  switch (block.type) {
    case "text":
      return [{ text: block.text, type: "text" }];
    case "image":
    case "audio":
      return [{ data: block.data, mediaType: block.mimeType, type: "inline_blob" }];
    case "resource_link": {
      if (URL.canParse(block.uri)) {
        return [
          {
            ...(block.mimeType === undefined || block.mimeType === null
              ? {}
              : { mediaType: block.mimeType }),
            name: nonEmpty(block.name, resourceName(block.uri)),
            type: "resource_link",
            uri: block.uri,
          },
        ];
      }

      const value = asJsonValue(block);
      return value === undefined ? [] : [{ type: "json", value }];
    }
    case "resource": {
      const resource = block.resource;

      if ("text" in resource) {
        const content: ContentBlock[] = [{ text: resource.text, type: "text" }];

        if (URL.canParse(resource.uri)) {
          content.unshift({
            ...(resource.mimeType === undefined || resource.mimeType === null
              ? {}
              : { mediaType: resource.mimeType }),
            name: resourceName(resource.uri),
            type: "resource_link",
            uri: resource.uri,
          });
        }

        return content;
      }

      return [
        {
          data: resource.blob,
          mediaType: resource.mimeType ?? "application/octet-stream",
          name: resourceName(resource.uri),
          type: "inline_blob",
        },
      ];
    }
  }
}

export function toolCategory(kind: ToolKind | null | undefined): ToolItem["category"] {
  switch (kind) {
    case "read":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "search":
      return "search";
    case "execute":
      return "execute";
    case "fetch":
      return "fetch";
    default:
      return "other";
  }
}

export function itemStatus(status: ToolCall["status"] | null | undefined): ItemStatus {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : "active";
}

export function toolError(title: string): ProtocolError {
  return {
    code: "agent_client_protocol.tool_failed",
    message: `${title} failed.`,
    retryable: false,
  };
}

export function toOutput(content: readonly ToolCallContent[]): ContentBlock[] {
  return content.flatMap((entry) =>
    entry.type === "content" ? toContentBlocks(entry.content) : [],
  );
}

export function toChanges(content: readonly ToolCallContent[]): FileChange[] {
  return content.flatMap<FileChange>((entry) => {
    if (entry.type !== "diff" || entry.path.trim().length === 0) {
      return [];
    }

    return [
      {
        diff: {
          type: "json",
          value: {
            newText: entry.newText,
            oldText: entry.oldText ?? null,
          },
        },
        operation: entry.oldText === undefined || entry.oldText === null ? "create" : "update",
        path: entry.path,
      },
    ];
  });
}

export function toUsage(usage: Usage, previous: TokenUsage | undefined): TokenUsage {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const cachedInput = usage.cachedReadTokens;
  const reasoning = usage.thoughtTokens;
  const total = usage.totalTokens;

  return {
    ...previous,
    ...(cachedInput !== undefined &&
    cachedInput !== null &&
    Number.isSafeInteger(cachedInput) &&
    cachedInput >= (previous?.cachedInput ?? 0)
      ? { cachedInput }
      : {}),
    ...(Number.isSafeInteger(input) && input >= (previous?.input ?? 0) ? { input } : {}),
    ...(Number.isSafeInteger(output) && output >= (previous?.output ?? 0) ? { output } : {}),
    ...(reasoning !== undefined &&
    reasoning !== null &&
    Number.isSafeInteger(reasoning) &&
    reasoning >= (previous?.reasoning ?? 0)
      ? { reasoning }
      : {}),
    ...(Number.isSafeInteger(total) && total >= (previous?.total ?? 0) ? { total } : {}),
  };
}

function configDescription(value: string | null | undefined) {
  return value === undefined || value === null ? {} : { description: value };
}

export function toConfigOptions(options: readonly SessionConfigOption[]): ConfigOption[] {
  return options.map((option) => {
    const base = {
      ...(option.category === undefined || option.category === null || option.category.length === 0
        ? {}
        : { category: option.category }),
      ...configDescription(option.description),
      id: option.id,
      label: nonEmpty(option.name, option.id),
    };

    if (option.type === "boolean") {
      return configOptionSchema.parse({ ...base, type: "boolean", value: option.currentValue });
    }

    const groups = option.options.flatMap((entry) => ("group" in entry ? [entry] : []));
    const choices = option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));

    return configOptionSchema.parse({
      ...base,
      choices: choices.map((choice) => ({
        ...configDescription(choice.description),
        id: choice.value,
        label: nonEmpty(choice.name, choice.value),
      })),
      ...(groups.length === 0
        ? {}
        : {
            extensions: {
              [SELECT_GROUPS_EXTENSION]: groups.map((group) => ({
                id: group.group,
                label: group.name,
                optionIds: group.options.map((choice) => choice.value),
              })),
            },
          }),
      type: "select",
      value: option.currentValue,
    });
  });
}
