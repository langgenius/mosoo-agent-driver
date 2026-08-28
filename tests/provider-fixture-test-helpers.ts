import { readFileSync } from "node:fs";

import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readProviderFixture<T>(
  path: string,
  required: { readonly arrays: readonly string[]; readonly strings?: readonly string[] },
): T {
  const value: unknown = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

  if (
    !isRecord(value) ||
    required.arrays.some((field) => !Array.isArray(value[field])) ||
    required.strings?.some((field) => typeof value[field] !== "string") === true
  ) {
    throw new TypeError(`Provider fixture ${path} is malformed.`);
  }

  return value as T;
}

type ProviderFixtureKind = "acp" | "claude" | "openai";

function collectDriverIds(
  value: unknown,
  aliases: Map<string, string>,
  provider: ProviderFixtureKind,
  fieldName?: string,
): void {
  if (typeof value === "string") {
    const candidates =
      provider === "openai" && fieldName === "sourceEventId" ? value.split(":") : [value];

    for (const candidate of candidates) {
      if (isDriverId(candidate) && !aliases.has(candidate)) {
        aliases.set(
          candidate,
          aliases.size === 0 ? "<driver-id>" : `<driver-id-${aliases.size + 1}>`,
        );
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDriverIds(entry, aliases, provider);
    }
    return;
  }

  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      collectDriverIds(entry, aliases, provider, key);
    }
  }
}

function normalizeValue(
  value: unknown,
  aliases: ReadonlyMap<string, string>,
  provider: ProviderFixtureKind,
  fieldName?: string,
): unknown {
  if (typeof value === "string") {
    if (provider === "claude") {
      for (const [driverId, alias] of aliases) {
        if (value === driverId || value.startsWith(`${driverId}:`)) {
          return `${alias}${value.slice(driverId.length)}`;
        }
      }
    } else {
      const alias = aliases.get(value);
      if (alias !== undefined) {
        return alias;
      }
    }

    if (
      fieldName?.endsWith("At") === true &&
      value.endsWith("Z") &&
      !Number.isNaN(Date.parse(value))
    ) {
      return "<iso-timestamp>";
    }

    return provider === "openai" && fieldName === "sourceEventId"
      ? value
          .split(":")
          .map((part) => aliases.get(part) ?? part)
          .join(":")
      : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, aliases, provider));
  }

  if (!isRecord(value)) {
    return value;
  }

  const entries = Object.entries(value);
  return Object.fromEntries(
    provider !== "openai"
      ? entries.flatMap(([key, entry]) =>
          entry === undefined ? [] : [[key, normalizeValue(entry, aliases, provider, key)]],
        )
      : entries.map(([key, entry]) => [key, normalizeValue(entry, aliases, provider, key)]),
  );
}

function normalizeProviderEvents(
  events: readonly DriverEventInput[],
  provider: ProviderFixtureKind,
): Record<string, unknown>[] {
  const aliases = new Map<string, string>();

  for (const event of events) {
    if (provider === "acp") {
      const payload = isRecord(event.payload) ? event.payload : null;
      const messageId = payload?.["messageId"];

      if (
        event.kind === "message.started" &&
        payload?.["role"] === "agent" &&
        typeof messageId === "string" &&
        !aliases.has(messageId)
      ) {
        aliases.set(messageId, `assistant-message-${aliases.size + 1}`);
      }
    } else {
      collectDriverIds(event, aliases, provider);
    }
  }

  return events.map((event) => {
    if (provider !== "openai") {
      return normalizeValue(event, aliases, provider) as Record<string, unknown>;
    }

    const eventRecord = event as unknown as Record<string, unknown>;
    const normalized: Record<string, unknown> = {
      kind: event.kind,
      payload: normalizeValue(event.payload, aliases, provider),
    };

    for (const field of ["delivery", "native", "runId", "sourceEventId", "visibility"] as const) {
      if (eventRecord[field] !== undefined) {
        normalized[field] = normalizeValue(eventRecord[field], aliases, provider, field);
      }
    }

    return normalized;
  });
}

export function normalizeAcpProviderEvents(
  events: readonly DriverEventInput[],
): Record<string, unknown>[] {
  return normalizeProviderEvents(events, "acp");
}

export function normalizeClaudeProviderEvents(
  events: readonly DriverEventInput[],
): Record<string, unknown>[] {
  return normalizeProviderEvents(events, "claude");
}

export function normalizeOpenAiProviderEvents(
  events: readonly DriverEventInput[],
): Record<string, unknown>[] {
  return normalizeProviderEvents(events, "openai");
}
