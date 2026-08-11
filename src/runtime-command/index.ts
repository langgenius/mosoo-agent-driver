export type PrimitiveValue = string | number | boolean | null;
export type PrimitiveRecord = Record<string, PrimitiveValue>;

export interface RunError {
  readonly code: string;
  readonly details: PrimitiveRecord;
  readonly message: string;
  readonly retryable: boolean;
}

export type RuntimeCommandStatus =
  | "accepted"
  | "cancelled"
  | "completed"
  | "delivered"
  | "expired"
  | "failed"
  | "queued";

export interface RuntimeCommandInput {
  readonly text: string;
}

export interface TurnCancelCommand {
  readonly commandId: string;
  readonly kind: "turn.cancel";
  readonly reason?: string | undefined;
}

export interface InputStartCommand {
  readonly commandId: string;
  readonly input: RuntimeCommandInput;
  readonly kind: "input.start";
  readonly requestId: string;
  readonly runId: string;
}

export interface SessionStopCommand {
  readonly commandId: string;
  readonly kind: "session.stop";
  readonly reason: string;
}

export interface McpExecuteCommand {
  readonly argumentsJson: string;
  readonly commandId: string;
  readonly kind: "mcp.execute";
  readonly requestId: string;
  readonly serverId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface PermissionResolveCommand {
  readonly commandId: string;
  readonly decision: "allow_once" | "reject_once";
  readonly kind: "permission.resolve";
  readonly requestId: string;
}

export type RuntimeCommand =
  | InputStartCommand
  | McpExecuteCommand
  | PermissionResolveCommand
  | SessionStopCommand
  | TurnCancelCommand;

export interface InputStartCommandResult {
  readonly requestId: string;
}

export interface McpExecuteCommandResult {
  readonly isError?: boolean | undefined;
  readonly outputText: string;
  readonly requestId: string;
  readonly serverId: string;
  readonly toolName: string;
}

/**
 * The public command result remains provider-neutral. The optional receipt is
 * retained solely by the durable effect ledger for post-failure diagnosis.
 */
export interface McpExternalToolExecutionResult extends McpExecuteCommandResult {
  readonly providerReceiptJson?: string | null | undefined;
}

/**
 * The API-owned decision made immediately before the Driver invokes an
 * external MCP provider. The key survives Driver replacement and is conveyed
 * to providers through MCP request metadata.
 */
export interface McpExternalToolEffectExecution {
  readonly effectId: string;
  readonly idempotencyKey: string;
}

export type McpExternalToolEffectClaim =
  | {
      readonly attempt: number;
      readonly effectId: string;
      readonly idempotencyKey: string;
      readonly kind: "execute";
    }
  | {
      readonly effectId: string;
      readonly kind: "completed";
      readonly result: McpExecuteCommandResult;
    }
  | {
      readonly effectId: string;
      readonly kind: "unknown";
    };

export type RuntimeCommandResult = InputStartCommandResult | McpExecuteCommandResult | null;

export type DriverCapabilityId =
  | "custom_tool_execute"
  | "file_change"
  | "input_start"
  | "mcp_execute"
  | "native_resume"
  | "permission_request"
  | "session_stop"
  | "text_stream"
  | "thinking_stream"
  | "tool_stream"
  | "turn_cancel"
  | "usage"
  | "visible_activity";

export interface DriverCapability {
  readonly details?: string | undefined;
  readonly id: DriverCapabilityId;
  readonly status: "supported" | "unsupported";
  readonly version: 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }

  return value;
}

function readNonEmptyString(record: Record<string, unknown>, field: string): string {
  const value = record[field];

  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }

  return value;
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];

  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string.`);
  }

  return value;
}

function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string.`);
  }

  return value;
}

function readRuntimeCommandInput(value: unknown): RuntimeCommandInput {
  const record = readRecord(value, "input");

  if ("attachmentIds" in record) {
    throw new TypeError("input.attachmentIds is unsupported.");
  }

  return {
    text: readNonEmptyString(record, "text"),
  };
}

function readPermissionDecision(value: unknown): PermissionResolveCommand["decision"] {
  if (value === "allow_once" || value === "reject_once") {
    return value;
  }

  throw new TypeError("decision must be allow_once or reject_once.");
}

export function parseRuntimeCommand(value: unknown): RuntimeCommand {
  const record = readRecord(value, "runtime command");
  const kind = readString(record, "kind");

  switch (kind) {
    case "input.start": {
      return {
        commandId: readNonEmptyString(record, "commandId"),
        input: readRuntimeCommandInput(record["input"]),
        kind,
        requestId: readNonEmptyString(record, "requestId"),
        runId: readNonEmptyString(record, "runId"),
      };
    }
    case "mcp.execute":
      return {
        argumentsJson: readString(record, "argumentsJson"),
        commandId: readNonEmptyString(record, "commandId"),
        kind,
        requestId: readNonEmptyString(record, "requestId"),
        serverId: readNonEmptyString(record, "serverId"),
        toolCallId: readNonEmptyString(record, "toolCallId"),
        toolName: readNonEmptyString(record, "toolName"),
      };
    case "permission.resolve":
      return {
        commandId: readNonEmptyString(record, "commandId"),
        decision: readPermissionDecision(record["decision"]),
        kind,
        requestId: readNonEmptyString(record, "requestId"),
      };
    case "session.stop":
      return {
        commandId: readNonEmptyString(record, "commandId"),
        kind,
        reason: readNonEmptyString(record, "reason"),
      };
    case "turn.cancel": {
      const reason = readOptionalString(record, "reason");

      return {
        commandId: readNonEmptyString(record, "commandId"),
        kind,
        ...(reason === undefined ? {} : { reason }),
      };
    }
    default:
      throw new TypeError(`Unsupported runtime command kind: ${kind}.`);
  }
}
