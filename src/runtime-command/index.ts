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
  readonly attachmentIds?: string[] | undefined;
  readonly text: string;
}

export interface DriverAppAccessSnapshotEntry {
  readonly canWrite: boolean;
  readonly mountPath: string;
  readonly spaceId: string;
  readonly type: "space";
}

export interface DriverAppAccessSnapshot {
  readonly entries: DriverAppAccessSnapshotEntry[];
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
  readonly appAccessSnapshot?: DriverAppAccessSnapshot | undefined;
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
  readonly toolName: string;
}

export interface PermissionResolveCommand {
  readonly commandId: string;
  readonly decision: "allow_once" | "reject_once";
  readonly kind: "permission.resolve";
  readonly requestId: string;
}

export interface AccessRefreshCommand {
  readonly commandId: string;
  readonly kind: "access.refresh";
  readonly appAccessSnapshot: DriverAppAccessSnapshot;
}

export type RuntimeCommand =
  | AccessRefreshCommand
  | InputStartCommand
  | McpExecuteCommand
  | PermissionResolveCommand
  | SessionStopCommand
  | TurnCancelCommand;

export interface InputStartCommandResult {
  readonly requestId: string;
}

export interface McpExecuteCommandResult {
  readonly outputText: string;
  readonly requestId: string;
  readonly serverId: string;
  readonly toolName: string;
}

export interface AccessRefreshCommandResult {
  readonly entryCount: number;
}

export type RuntimeCommandResult =
  | AccessRefreshCommandResult
  | InputStartCommandResult
  | McpExecuteCommandResult
  | null;

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

function readBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];

  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean.`);
  }

  return value;
}

function readStringArray(record: Record<string, unknown>, field: string): string[] | undefined {
  const value = record[field];

  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${field} must be an array of strings.`);
  }

  return [...value];
}

function readRuntimeCommandInput(value: unknown): RuntimeCommandInput {
  const record = readRecord(value, "input");
  const attachmentIds = readStringArray(record, "attachmentIds");

  return {
    ...(attachmentIds === undefined ? {} : { attachmentIds }),
    text: readNonEmptyString(record, "text"),
  };
}

function readAppAccessSnapshotEntry(value: unknown): DriverAppAccessSnapshotEntry {
  const record = readRecord(value, "appAccessSnapshot.entries[]");
  const type = readNonEmptyString(record, "type");

  if (type !== "space") {
    throw new TypeError("appAccessSnapshot.entries[].type must be space.");
  }

  return {
    canWrite: readBoolean(record, "canWrite"),
    mountPath: readNonEmptyString(record, "mountPath"),
    spaceId: readNonEmptyString(record, "spaceId"),
    type,
  };
}

function readAppAccessSnapshot(value: unknown): DriverAppAccessSnapshot {
  const record = readRecord(value, "appAccessSnapshot");
  const entries = record["entries"];

  if (!Array.isArray(entries)) {
    throw new TypeError("appAccessSnapshot.entries must be an array.");
  }

  return {
    entries: entries.map(readAppAccessSnapshotEntry),
  };
}

function readOptionalAppAccessSnapshot(
  record: Record<string, unknown>,
): DriverAppAccessSnapshot | undefined {
  const value = record["appAccessSnapshot"];

  if (value === undefined) {
    return undefined;
  }

  return readAppAccessSnapshot(value);
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
    case "access.refresh":
      return {
        commandId: readNonEmptyString(record, "commandId"),
        kind,
        appAccessSnapshot: readAppAccessSnapshot(record["appAccessSnapshot"]),
      };
    case "input.start": {
      const appAccessSnapshot = readOptionalAppAccessSnapshot(record);

      return {
        commandId: readNonEmptyString(record, "commandId"),
        input: readRuntimeCommandInput(record["input"]),
        kind,
        ...(appAccessSnapshot === undefined ? {} : { appAccessSnapshot }),
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
