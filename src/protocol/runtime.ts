export const SUPPORTED_DRIVER_RUNTIMES = [
  "openai-runtime",
  "claude-agent-sdk",
  "acp-fallback",
  "pi",
] as const;

export const SUPPORTED_DRIVER_RUNTIME_TRANSPORTS = [
  "openai-app-server",
  "claude-agent-sdk",
  "acp-fallback",
  "pi-rpc",
] as const;

export const SUPPORTED_DRIVER_NATIVE_RUNTIME_REF_KINDS = [
  "openai_thread_id",
  "claude_session_id",
  "acp_session_id",
  "pi_session_path",
] as const;

export type DriverRuntime = (typeof SUPPORTED_DRIVER_RUNTIMES)[number];
export type DriverRuntimeTransport = (typeof SUPPORTED_DRIVER_RUNTIME_TRANSPORTS)[number];
export type DriverNativeRuntimeRefKind = (typeof SUPPORTED_DRIVER_NATIVE_RUNTIME_REF_KINDS)[number];

export interface DriverNativeRuntimeRef {
  readonly kind: DriverNativeRuntimeRefKind;
  readonly runtimeId: DriverRuntime;
  readonly value: string;
}

export function isSupportedDriverRuntime(value: string): value is DriverRuntime {
  return (SUPPORTED_DRIVER_RUNTIMES as readonly string[]).includes(value);
}

export function isSupportedDriverRuntimeTransport(value: string): value is DriverRuntimeTransport {
  return (SUPPORTED_DRIVER_RUNTIME_TRANSPORTS as readonly string[]).includes(value);
}

export function isSupportedDriverNativeRuntimeRefKind(
  value: string,
): value is DriverNativeRuntimeRefKind {
  return (SUPPORTED_DRIVER_NATIVE_RUNTIME_REF_KINDS as readonly string[]).includes(value);
}

export function getExpectedDriverNativeRuntimeRefKind(
  runtimeId: DriverRuntime,
): DriverNativeRuntimeRefKind {
  switch (runtimeId) {
    case "openai-runtime": {
      return "openai_thread_id";
    }
    case "claude-agent-sdk": {
      return "claude_session_id";
    }
    case "acp-fallback": {
      return "acp_session_id";
    }
    case "pi": {
      return "pi_session_path";
    }
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function readNonEmptyString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];

  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label}.${field} must be a non-empty string.`);
  }

  return value;
}

export function parseDriverNativeRuntimeRef(value: unknown): DriverNativeRuntimeRef {
  const record = readRecord(value, "Driver native runtime ref");
  const runtimeId = readNonEmptyString(record, "runtimeId", "Driver native runtime ref");
  const kind = readNonEmptyString(record, "kind", "Driver native runtime ref");

  if (!isSupportedDriverRuntime(runtimeId)) {
    throw new TypeError(`Unsupported native runtime ref runtime: ${runtimeId}.`);
  }

  const expectedKind = getExpectedDriverNativeRuntimeRefKind(runtimeId);

  if (kind !== expectedKind) {
    throw new TypeError(`Native runtime ref kind ${kind} does not match runtime ${runtimeId}.`);
  }

  return {
    kind,
    runtimeId,
    value: readNonEmptyString(record, "value", "Driver native runtime ref"),
  };
}
