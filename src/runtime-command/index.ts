export type PrimitiveValue = string | number | boolean | null;
export type PrimitiveRecord = Record<string, PrimitiveValue>;

const D1_TABLE_ROW_MAX_UTF8_BYTES = 2_000_000;
const RUNTIME_COMMAND_ROW_RESERVED_UTF8_BYTES = 128 * 1_024;

export const DURABLE_RUN_ERROR_MAX_UTF8_BYTES = 1_020 * 1_024;
export const RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES = DURABLE_RUN_ERROR_MAX_UTF8_BYTES;
export const RUNTIME_COMMAND_MAX_UTF8_BYTES =
  D1_TABLE_ROW_MAX_UTF8_BYTES -
  RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES -
  RUNTIME_COMMAND_ROW_RESERVED_UTF8_BYTES;

const runtimeCommandEncoder = new TextEncoder();

export function measureRuntimeCommandJson(value: unknown): number {
  return runtimeCommandEncoder.encode(JSON.stringify(value)).byteLength;
}

export interface RunError {
  readonly code: string;
  readonly details: PrimitiveRecord;
  readonly message: string;
  readonly retryable: boolean;
}

export const RUNTIME_COMMAND_STATUSES = [
  "accepted",
  "cancelled",
  "completed",
  "delivered",
  "expired",
  "failed",
  "queued",
] as const;
export type RuntimeCommandStatus = (typeof RUNTIME_COMMAND_STATUSES)[number];

export interface RuntimeCommandInput {
  readonly attachmentIds?: readonly string[] | undefined;
  readonly text: string;
}

export interface TurnCancelCommand {
  readonly commandId: string;
  readonly kind: "turn.cancel";
  readonly reason?: string | undefined;
  readonly runId: string;
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
  readonly runId: string;
  readonly serverId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

type McpEffectErrorCommand = Pick<
  McpExecuteCommand,
  "commandId" | "requestId" | "runId" | "serverId" | "toolName"
>;

export function createMcpUnknownEffectRunError(
  command: McpEffectErrorCommand,
  effectId: string,
): RunError {
  return {
    code: "driver.external_tool_effect_unknown",
    details: {
      commandId: command.commandId,
      effectId,
      requestId: command.requestId,
      runId: command.runId,
      serverId: command.serverId,
      toolName: command.toolName,
    },
    message: `External effect ${effectId} for MCP tool ${command.toolName} has an unknown outcome and will not be replayed.`,
    retryable: false,
  };
}

export function createMcpUnsettledEffectRunError(
  command: Pick<McpEffectErrorCommand, "commandId" | "toolName">,
  effectId: string,
): RunError {
  return {
    code: "driver.command_failed.mcp.execute",
    details: { commandId: command.commandId, commandKind: "mcp.execute" },
    message: `External effect ${effectId} for MCP tool ${command.toolName} requires server-side repair.`,
    retryable: false,
  };
}

export interface PermissionResolveCommand {
  readonly commandId: string;
  readonly decision: "allow_once" | "reject_once";
  readonly kind: "permission.resolve";
  readonly requestId: string;
  readonly runId: string;
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

export interface McpExternalToolEffectExecution {
  readonly attempt: number;
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly kind: "claimed";
}

export type McpExternalToolEffectState =
  | {
      readonly effectId: string;
      readonly kind: "intent";
    }
  | McpExternalToolEffectExecution
  | {
      readonly effectId: string;
      readonly kind: "succeeded";
      readonly result: McpExecuteCommandResult;
    }
  | {
      readonly effectId: string;
      readonly kind: "unknown";
    };

export type McpExternalToolEffectClaim = Exclude<
  McpExternalToolEffectState,
  { readonly kind: "intent" }
>;

export type McpExternalToolEffectSettlement =
  | {
      readonly kind: "succeeded";
      readonly providerReceiptJson?: string | null | undefined;
      readonly result: McpExecuteCommandResult;
    }
  | { readonly kind: "unknown" };

export type RuntimeCommandResult = InputStartCommandResult | McpExecuteCommandResult | null;

export type DriverCommandUpdate =
  | {
      readonly commandId: string;
      readonly status: "accepted" | "cancelled";
    }
  | {
      readonly commandId: string;
      readonly result?: Exclude<RuntimeCommandResult, null> | undefined;
      readonly status: "completed";
    }
  | {
      readonly commandId: string;
      readonly error: RunError;
      readonly status: "failed";
    };

export const DRIVER_CAPABILITY_IDS = [
  "custom_tool_execute",
  "file_change",
  "input_start",
  "mcp_execute",
  "native_resume",
  "permission_request",
  "session_stop",
  "text_stream",
  "thinking_stream",
  "tool_stream",
  "turn_cancel",
  "usage",
  "visible_activity",
] as const;
export type DriverCapabilityId = (typeof DRIVER_CAPABILITY_IDS)[number];

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

function requireExactKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));

  if (unexpected !== undefined) {
    throw new TypeError(`${label}.${unexpected} is not allowed.`);
  }
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

export function normalizeDurableRunError(error: RunError): RunError {
  const byteLength = measureRuntimeCommandJson(error);

  return byteLength <= DURABLE_RUN_ERROR_MAX_UTF8_BYTES
    ? error
    : {
        code: "driver.error_oversized",
        details: { originalBytes: byteLength },
        message: `Driver error exceeded ${String(DURABLE_RUN_ERROR_MAX_UTF8_BYTES)} UTF-8 bytes and was omitted.`,
        retryable: false,
      };
}

function requireDurableRuntimeCommand<Command extends RuntimeCommand>(
  command: Command,
  storedCommand: unknown = command,
): Command {
  const byteLength = measureRuntimeCommandJson(storedCommand);

  if (byteLength > RUNTIME_COMMAND_MAX_UTF8_BYTES) {
    throw new RangeError(
      `Runtime command exceeds ${String(RUNTIME_COMMAND_MAX_UTF8_BYTES)} UTF-8 bytes.`,
    );
  }

  return command;
}

function readRuntimeCommandInput(value: unknown): RuntimeCommandInput {
  const record = readRecord(value, "input");
  requireExactKeys(record, ["attachmentIds", "text"], "input");
  const attachmentIds = record["attachmentIds"];
  const text = readNonEmptyString(record, "text");

  if (attachmentIds === undefined) {
    return { text };
  }

  if (
    !Array.isArray(attachmentIds) ||
    attachmentIds.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    throw new TypeError("input.attachmentIds must be an array of non-empty strings.");
  }

  return { attachmentIds: [...attachmentIds], text };
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
      requireExactKeys(
        record,
        ["commandId", "input", "kind", "requestId", "runId"],
        "runtime command",
      );
      const input = readRuntimeCommandInput(record["input"]);
      const command = {
        commandId: readNonEmptyString(record, "commandId"),
        input,
        kind,
        requestId: readNonEmptyString(record, "requestId"),
        runId: readNonEmptyString(record, "runId"),
      };

      return requireDurableRuntimeCommand(command);
    }
    case "mcp.execute":
      requireExactKeys(
        record,
        [
          "argumentsJson",
          "commandId",
          "kind",
          "requestId",
          "runId",
          "serverId",
          "toolCallId",
          "toolName",
        ],
        "runtime command",
      );
      return requireDurableRuntimeCommand({
        argumentsJson: readString(record, "argumentsJson"),
        commandId: readNonEmptyString(record, "commandId"),
        kind,
        requestId: readNonEmptyString(record, "requestId"),
        runId: readNonEmptyString(record, "runId"),
        serverId: readNonEmptyString(record, "serverId"),
        toolCallId: readNonEmptyString(record, "toolCallId"),
        toolName: readNonEmptyString(record, "toolName"),
      });
    case "permission.resolve":
      requireExactKeys(
        record,
        ["commandId", "decision", "kind", "requestId", "runId"],
        "runtime command",
      );
      return requireDurableRuntimeCommand({
        commandId: readNonEmptyString(record, "commandId"),
        decision: readPermissionDecision(record["decision"]),
        kind,
        requestId: readNonEmptyString(record, "requestId"),
        runId: readNonEmptyString(record, "runId"),
      });
    case "session.stop":
      requireExactKeys(record, ["commandId", "kind", "reason"], "runtime command");
      return requireDurableRuntimeCommand({
        commandId: readNonEmptyString(record, "commandId"),
        kind,
        reason: readNonEmptyString(record, "reason"),
      });
    case "turn.cancel": {
      requireExactKeys(record, ["commandId", "kind", "reason", "runId"], "runtime command");
      const reason = readOptionalString(record, "reason");

      return requireDurableRuntimeCommand({
        commandId: readNonEmptyString(record, "commandId"),
        kind,
        ...(reason === undefined ? {} : { reason }),
        runId: readNonEmptyString(record, "runId"),
      });
    }
    default:
      throw new TypeError(`Unsupported runtime command kind: ${kind}.`);
  }
}
