import type { InitializeResponse } from "@agentclientprotocol/sdk";

import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import {
  isRecord,
  readNonEmptyString,
  readNullableString,
  readNumber,
  readRecord,
  readString,
  stringifyForDisplay,
} from "./acp-types";
import type { JsonObject } from "./acp-types";

const ACP_USAGE_CONTRACT = "openai_total_with_cached_breakdown";

export function toInitializeEvents(result: InitializeResponse): DriverEventInput[] {
  const events: DriverEventInput[] = [
    {
      kind: "runtime.capabilities.updated",
      payload: {
        capabilities: result.agentCapabilities ?? {},
        protocolVersion: result.protocolVersion,
      },
      visibility: "owner_debug",
    },
  ];

  if (result.authMethods !== undefined && result.authMethods.length > 0) {
    events.push({
      kind: "auth.methods.updated",
      payload: {
        methods: result.authMethods,
      },
      visibility: "owner_debug",
    });
  }

  return events;
}

export function toPromptStartEvents(input: {
  messageId: string;
  runId: RunId;
  text: string;
}): DriverEventInput[] {
  return [
    {
      actor: "user",
      kind: "message.added",
      origin: "viewer",
      payload: {
        content: [
          {
            text: input.text,
            type: "text",
          },
        ],
        messageId: input.messageId,
        role: "user",
      },
      runId: input.runId,
    },
    {
      actor: "api",
      kind: "run.dispatched",
      origin: "api",
      payload: {
        inputSummary: input.text.slice(0, 240),
        userMessageId: input.messageId,
      },
      runId: input.runId,
    },
    {
      kind: "run.started",
      payload: {
        inputItemIds: [input.messageId],
        startedAt: new Date().toISOString(),
      },
      runId: input.runId,
    },
  ];
}

export function toSessionReadyEvents(input: {
  mode: "created" | "loaded" | "resumed";
  nativeSessionId: string;
  setup: JsonObject;
}): DriverEventInput[] {
  return [
    {
      kind: input.mode === "created" ? "session.created" : "session.resumed",
      payload:
        input.mode === "created"
          ? {
              mode: "acp",
              topology: "stdio",
            }
          : {
              reason: input.mode,
              resumePointer: input.nativeSessionId,
            },
    },
    {
      kind: "runtime.resume.updated",
      payload: {
        resumePointer: input.nativeSessionId,
      },
      visibility: "owner_debug",
    },
    ...toModeEvents(input.setup),
    ...toModelEvents(input.setup),
    ...toConfigEvents(input.setup),
    ...toCapabilityEvents(input.setup),
  ];
}

export function toAuthEvent(input: {
  methodId: string;
  status: "authenticated" | "failed";
}): DriverEventInput {
  return {
    kind: "auth.session.updated",
    payload: {
      methodId: input.methodId,
      status: input.status,
    },
    visibility: "owner_debug",
  };
}

export function shouldIgnoreReplay(params: unknown): boolean {
  const record = isRecord(params) ? params : {};
  const update = readRecord(record, "update");

  switch (readString(update, "sessionUpdate")) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "plan":
    case "tool_call":
    case "tool_call_update":
    case "user_message_chunk": {
      return true;
    }
    default: {
      return false;
    }
  }
}

export function normalizePromptUsage(raw: unknown): JsonObject | null {
  if (!isRecord(raw)) {
    return null;
  }

  const rawTotal = readNumber(raw, "totalTokens") ?? readNumber(raw, "total_tokens");
  const rawInput = readNumber(raw, "inputTokens") ?? readNumber(raw, "input_tokens");
  const rawOutput = readNumber(raw, "outputTokens") ?? readNumber(raw, "output_tokens");
  const totalTokens =
    rawTotal !== null && Number.isSafeInteger(rawTotal) && rawTotal >= 0 ? rawTotal : null;
  const inputTokens =
    rawInput !== null && Number.isSafeInteger(rawInput) && rawInput >= 0 ? rawInput : null;
  const outputTokens =
    rawOutput !== null && Number.isSafeInteger(rawOutput) && rawOutput >= 0 ? rawOutput : null;

  if (totalTokens === null && inputTokens === null && outputTokens === null) {
    return null;
  }

  return {
    ...(inputTokens === null ? {} : { inputTokens }),
    ...(outputTokens === null ? {} : { outputTokens }),
    raw,
    source: "prompt_response",
    ...(totalTokens === null ? {} : { totalTokens }),
    usageContract: ACP_USAGE_CONTRACT,
  };
}

export function summarizeContentBlock(content: unknown): string | null {
  if (!isRecord(content)) {
    return null;
  }

  switch (content["type"]) {
    case "text": {
      return readString(content, "text");
    }
    case "image": {
      return summarizeLabel("image", content);
    }
    case "audio": {
      return summarizeLabel("audio", content);
    }
    case "resource":
    case "resource_link": {
      return summarizeLabel("resource", content);
    }
    default: {
      return stringifyForDisplay(content);
    }
  }
}

function summarizeLabel(label: string, record: JsonObject): string {
  const title =
    readString(record, "title") ?? readString(record, "name") ?? readString(record, "uri");
  return title === null ? `[${label}]` : `[${label}: ${title}]`;
}

function normalizeCommands(raw: unknown): JsonObject[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const commands = raw.flatMap((entry): JsonObject[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const name = readNonEmptyString(entry, "name");

    if (name === null) {
      return [];
    }

    return [
      {
        description: readNullableString(entry, "description") ?? "",
        input: entry["input"] ?? null,
        name,
      },
    ];
  });

  return commands;
}

function normalizeChoices(raw: unknown, group?: { id: string; name: string }): JsonObject[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry): JsonObject[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const nestedOptions = entry["options"];
    const groupId = readNonEmptyString(entry, "group");

    if (Array.isArray(nestedOptions) && groupId !== null) {
      return normalizeChoices(nestedOptions, {
        id: groupId,
        name: readNonEmptyString(entry, "name") ?? groupId,
      });
    }

    const value = readNonEmptyString(entry, "value");

    if (value === null) {
      return [];
    }

    const description = readNullableString(entry, "description");
    return [
      {
        ...(description === undefined ? {} : { description }),
        ...(group === undefined ? {} : { group: group.id, groupName: group.name }),
        name: readNonEmptyString(entry, "name") ?? value,
        value,
      },
    ];
  });
}

function normalizeConfigOptions(raw: unknown): JsonObject[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  return raw.flatMap((entry): JsonObject[] => {
    if (!isRecord(entry) || (entry["type"] !== "select" && entry["type"] !== "boolean")) {
      return [];
    }

    const id = readNonEmptyString(entry, "id");

    if (id === null) {
      return [];
    }

    const category = readNullableString(entry, "category");
    const description = readNullableString(entry, "description");
    const name = readNonEmptyString(entry, "name");

    if (entry["type"] === "boolean") {
      const currentValue = entry["currentValue"];

      if (typeof currentValue !== "boolean") {
        return [];
      }

      return [
        {
          ...(category === undefined ? {} : { category }),
          currentValue,
          ...(description === undefined ? {} : { description }),
          id,
          ...(name === null ? {} : { name }),
          type: "boolean",
        },
      ];
    }

    const currentValue = readString(entry, "currentValue");
    const rawOptions = entry["options"];
    const values = normalizeChoices(rawOptions);

    return [
      {
        ...(category === undefined ? {} : { category }),
        ...(currentValue === null ? {} : { currentValue }),
        ...(description === undefined ? {} : { description }),
        id,
        ...(name === null ? {} : { name }),
        type: "select",
        ...(Array.isArray(rawOptions) ? { values } : {}),
      },
    ];
  });
}

function normalizePlan(raw: unknown): JsonObject[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry, index): JsonObject[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const content = readNonEmptyString(entry, "content");

    if (content === null) {
      return [];
    }

    return [
      {
        content,
        id: readNonEmptyString(entry, "id") ?? `plan-${index + 1}`,
        priority: readNullableString(entry, "priority") ?? null,
        status: readNullableString(entry, "status") ?? "pending",
      },
    ];
  });
}

export function toCommandEvents(update: JsonObject | null): DriverEventInput[] {
  const commands = normalizeCommands(update?.["availableCommands"] ?? update?.["commands"]);

  if (commands === null) {
    return [];
  }

  return [
    {
      kind: "session.commands.updated",
      payload: {
        commands,
      },
    },
  ];
}

export function toPlanEvents(update: JsonObject | null): DriverEventInput[] {
  const rawEntries = update?.["entries"];
  const entries = normalizePlan(rawEntries);

  if (!Array.isArray(rawEntries) || (rawEntries.length > 0 && entries.length === 0)) {
    return [];
  }

  return [
    {
      kind: "plan.updated",
      payload: {
        entries,
        source: "acp",
      },
    },
  ];
}

function toCapabilityEvents(setup: JsonObject | null): DriverEventInput[] {
  const capabilities =
    readRecord(setup, "capabilities") ?? readRecord(setup, "sessionCapabilities");

  if (capabilities === null) {
    return [];
  }

  return [
    {
      kind: "session.capabilities.updated",
      payload: {
        capabilities,
      },
      visibility: "owner_debug",
    },
  ];
}

export function toConfigEvents(update: JsonObject | null): DriverEventInput[] {
  const options = normalizeConfigOptions(update?.["configOptions"] ?? update?.["options"]);

  if (options === null) {
    return [];
  }

  return [
    {
      kind: "session.config.updated",
      payload: {
        options,
      },
    },
  ];
}

export function toInfoEvents(update: JsonObject | null): DriverEventInput[] {
  const title = readNullableString(update, "title");
  const goal = readNullableString(update, "goal");
  const workspace = update?.["workspace"];

  if (title === undefined && goal === undefined && workspace === undefined) {
    return [];
  }

  return [
    {
      kind: "session.info.updated",
      payload: {
        ...(goal === undefined ? {} : { goal }),
        ...(title === undefined ? {} : { title }),
        ...(workspace === undefined ? {} : { workspace }),
      },
    },
  ];
}

export function toModeEvents(update: JsonObject | null): DriverEventInput[] {
  const currentMode =
    readNullableString(update, "currentModeId") ??
    readNullableString(update, "currentMode") ??
    undefined;
  const availableModes =
    update?.["availableModes"] ?? update?.["visibleModes"] ?? update?.["modes"];

  if (currentMode === undefined && availableModes === undefined) {
    return [];
  }

  return [
    {
      kind: "session.mode.updated",
      payload: {
        ...(availableModes === undefined ? {} : { availableModes }),
        ...(currentMode === undefined ? {} : { currentMode }),
      },
    },
  ];
}

function toModelEvents(setup: JsonObject | null): DriverEventInput[] {
  const currentModel = readNullableString(setup, "currentModel") ?? undefined;
  const availableModels = setup?.["availableModels"] ?? setup?.["models"];
  const providers = setup?.["providers"];

  if (currentModel === undefined && availableModels === undefined && providers === undefined) {
    return [];
  }

  return [
    {
      kind: "session.models.updated",
      payload: {
        ...(availableModels === undefined ? {} : { availableModels }),
        ...(currentModel === undefined ? {} : { currentModel }),
        ...(providers === undefined ? {} : { providers }),
      },
    },
  ];
}

export function toUsageEvents(update: JsonObject | null): DriverEventInput[] {
  const rawUsed = readNumber(update, "used");
  const rawSize = readNumber(update, "size");
  const cost = readRecord(update, "cost");
  const rawCostAmount = readNumber(cost, "amount");
  const used = rawUsed !== null && Number.isSafeInteger(rawUsed) && rawUsed >= 0 ? rawUsed : null;
  const size = rawSize !== null && Number.isSafeInteger(rawSize) && rawSize >= 0 ? rawSize : null;
  const costAmount = rawCostAmount !== null && rawCostAmount >= 0 ? rawCostAmount : null;
  const costCurrency = readNullableString(cost, "currency");

  if (used === null && size === null && costAmount === null) {
    return [];
  }

  return [
    {
      kind: "usage.updated",
      payload: {
        ...(costAmount === null ? {} : { costAmount }),
        ...(costAmount === null || costCurrency === undefined ? {} : { costCurrency }),
        ...(size === null ? {} : { size }),
        source: "session_update",
        usageContract: ACP_USAGE_CONTRACT,
        ...(used === null ? {} : { used }),
      },
    },
  ];
}
