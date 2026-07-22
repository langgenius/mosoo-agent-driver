import type { RuntimeCommand } from "../../runtime-command";

type CmaInboundType =
  | "user.custom_tool_result"
  | "user.interrupt"
  | "user.message"
  | "user.tool_confirmation";

export class CmaInvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmaInvalidEventError";
  }
}

export class CmaUnsupportedFieldError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Unsupported CMA field: ${field}.`);
    this.name = "CmaUnsupportedFieldError";
    this.field = field;
  }
}

export interface CmaUserMessageEvent {
  readonly commandId: string;
  readonly requestId: string;
  readonly runId: string;
  readonly text: string;
  readonly type: "user.message";
}

export interface CmaUserInterruptEvent {
  readonly commandId: string;
  readonly reason?: string;
  readonly type: "user.interrupt";
}

export interface CmaUserToolConfirmationEvent {
  readonly commandId: string;
  readonly decision: "allow_once" | "reject_once";
  readonly requestId: string;
  readonly type: "user.tool_confirmation";
}

export interface CmaUserCustomToolResultEvent {
  readonly argumentsJson: string;
  readonly commandId: string;
  readonly requestId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly type: "user.custom_tool_result";
}

export type CmaInboundEvent =
  | CmaUserCustomToolResultEvent
  | CmaUserInterruptEvent
  | CmaUserMessageEvent
  | CmaUserToolConfirmationEvent;

const supportedFieldsByInboundType = {
  "user.custom_tool_result": new Set([
    "argumentsJson",
    "commandId",
    "requestId",
    "serverId",
    "toolName",
    "type",
  ]),
  "user.interrupt": new Set(["commandId", "reason", "type"]),
  "user.message": new Set(["commandId", "requestId", "runId", "text", "type"]),
  "user.tool_confirmation": new Set(["commandId", "decision", "requestId", "type"]),
} satisfies Record<CmaInboundType, ReadonlySet<string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];

  if (typeof value !== "string" || value.length === 0) {
    throw new CmaInvalidEventError(`CMA field ${field} must be a non-empty string.`);
  }

  return value;
}

function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new CmaInvalidEventError(`CMA field ${field} must be a string.`);
  }

  return value;
}

function readInboundType(input: unknown): CmaInboundType {
  if (!isRecord(input)) {
    throw new CmaInvalidEventError("CMA inbound event must be an object.");
  }

  const type = input["type"];

  if (
    type !== "user.custom_tool_result" &&
    type !== "user.interrupt" &&
    type !== "user.message" &&
    type !== "user.tool_confirmation"
  ) {
    throw new CmaInvalidEventError(`Unsupported CMA event type: ${String(type)}.`);
  }

  return type;
}

function assertSupportedFields(type: CmaInboundType, input: Record<string, unknown>): void {
  const supportedFields = supportedFieldsByInboundType[type];

  for (const field of Object.keys(input)) {
    if (!supportedFields.has(field)) {
      throw new CmaUnsupportedFieldError(field);
    }
  }
}

export function parseCmaInboundEvent(input: unknown): CmaInboundEvent {
  const type = readInboundType(input);
  const record = input as Record<string, unknown>;
  assertSupportedFields(type, record);

  switch (type) {
    case "user.message": {
      return {
        commandId: readString(record, "commandId"),
        requestId: readString(record, "requestId"),
        runId: readString(record, "runId"),
        text: readString(record, "text"),
        type,
      };
    }
    case "user.interrupt": {
      const reason = readOptionalString(record, "reason");

      return {
        commandId: readString(record, "commandId"),
        ...(reason === undefined ? {} : { reason }),
        type,
      };
    }
    case "user.tool_confirmation": {
      const decision = readString(record, "decision");

      if (decision !== "allow_once" && decision !== "reject_once") {
        throw new CmaInvalidEventError("CMA field decision must be allow_once or reject_once.");
      }

      return {
        commandId: readString(record, "commandId"),
        decision,
        requestId: readString(record, "requestId"),
        type,
      };
    }
    case "user.custom_tool_result": {
      return {
        argumentsJson: readString(record, "argumentsJson"),
        commandId: readString(record, "commandId"),
        requestId: readString(record, "requestId"),
        serverId: readString(record, "serverId"),
        toolName: readString(record, "toolName"),
        type,
      };
    }
  }
}

export function projectCmaInboundToDriverCommand(input: unknown): RuntimeCommand {
  const event = parseCmaInboundEvent(input);

  switch (event.type) {
    case "user.message":
      return {
        commandId: event.commandId,
        input: {
          text: event.text,
        },
        kind: "input.start",
        requestId: event.requestId,
        runId: event.runId,
      };
    case "user.interrupt":
      return {
        commandId: event.commandId,
        kind: "turn.cancel",
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      };
    case "user.tool_confirmation":
      return {
        commandId: event.commandId,
        decision: event.decision,
        kind: "permission.resolve",
        requestId: event.requestId,
      };
    case "user.custom_tool_result":
      return {
        argumentsJson: event.argumentsJson,
        commandId: event.commandId,
        kind: "mcp.execute",
        requestId: event.requestId,
        serverId: event.serverId,
        toolName: event.toolName,
      };
  }
}
