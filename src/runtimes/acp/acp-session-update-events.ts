import type { DriverEventInput } from "../../protocol/events";
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

// Keep in sync with acp-lifecycle-events.ts: ACP usage is Anthropic-bucketed.
const ACP_USAGE_CONTRACT = "anthropic_bucketed";

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

export function toCapabilityEvents(setup: JsonObject | null): DriverEventInput[] {
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

export function toModelEvents(setup: JsonObject | null): DriverEventInput[] {
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
