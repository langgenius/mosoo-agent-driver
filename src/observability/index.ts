import {
  createLogger,
  createTraceparent,
  createWideEvent,
  generateRequestId,
  generateSpanId,
  generateTraceId,
  getContext,
  parseTraceparent,
  withContext,
  withContextAsync,
} from "vestig";
import type {
  LogContext,
  LogEntry,
  Logger,
  LoggerConfig,
  LogLevel,
  LogMetadata,
  Transport,
  TransportConfig,
  WideEventBuilder,
  WideEventConfig,
  WideEventEndOptions,
} from "vestig";

export type {
  LogContext,
  LogEntry,
  Logger,
  LogLevel,
  WideEventBuilder,
  WideEventEndOptions,
} from "vestig";

type PrimitiveLogValue = boolean | null | number | string;
type PrimitiveLogRecord = Record<string, PrimitiveLogValue>;

interface BaseLoggerOptions {
  context?: Record<string, unknown>;
  level?: LogLevel;
  namespace?: string;
  service: string;
}

interface BufferedSinkTransportOptions {
  flushIntervalMs?: number;
  level?: LogLevel;
  maxBatchSize?: number;
  maxBufferSize?: number;
  name?: string;
  onError?: (error: unknown, entries: readonly LogEntry[]) => void;
  sink: (entries: LogEntry[]) => Promise<void>;
}

interface BufferedSinkTransportConfig {
  flushIntervalMs: number;
  level: LogLevel;
  maxBatchSize: number;
  maxBufferSize: number;
  name: string;
  onError: (error: unknown, entries: readonly LogEntry[]) => void;
  sink: (entries: LogEntry[]) => Promise<void>;
}

interface CreateBufferedSinkLoggerOptions extends BaseLoggerOptions, BufferedSinkTransportOptions {}

interface NormalizedLogRecord {
  readonly [key: string]: NormalizedLogValue;
}

type NormalizedLogArray = readonly NormalizedLogValue[];
type NormalizedLogValue = NormalizedLogArray | NormalizedLogRecord | PrimitiveLogValue;

export interface TraceLogContext extends LogContext {
  parentSpanId?: string;
  requestId: string;
  service: string;
  spanId: string;
  traceId: string;
}

interface CreateTraceLogContextInput {
  context?: Record<string, unknown>;
  parentSpanId?: string | null;
  requestId?: string | null;
  service: string;
  spanId?: string | null;
  traceId?: string | null;
  traceparent?: string | null;
}

const CIRCULAR_REFERENCE_LABEL = "[Circular]";
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_BATCH_SIZE = 32;
const DEFAULT_MAX_BUFFER_SIZE = 512;
const FUNCTION_VALUE_LABEL = "[Function]";
const SERIALIZATION_FAILURE_LABEL = "[Unserializable]";

const ignoreBufferedSinkError: BufferedSinkTransportConfig["onError"] = (error, entries) => {
  Object.is(error, entries);
};

class BufferedSinkTransport implements Transport {
  readonly config: TransportConfig;
  readonly name: string;

  #buffer: LogEntry[] = [];
  #flushPromise: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: BufferedSinkTransportConfig;

  constructor(options: BufferedSinkTransportConfig) {
    this.options = options;
    this.name = options.name;
    this.config = {
      level: options.level,
      name: options.name,
    };
  }

  log(entry: LogEntry): void {
    if (this.#buffer.length >= this.options.maxBufferSize) {
      this.#buffer.shift();
    }

    this.#buffer.push(entry);

    if (this.#buffer.length >= this.options.maxBatchSize) {
      void this.flush();
      return;
    }

    this.#scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.#flushPromise !== null) {
      return this.#flushPromise;
    }

    this.#clearTimer();

    if (this.#buffer.length === 0) {
      return;
    }

    this.#flushPromise = this.#flushBatchesWithCleanup();

    return this.#flushPromise;
  }

  async destroy(): Promise<void> {
    this.#clearTimer();
    await this.flush();
  }

  #scheduleFlush(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.options.flushIntervalMs);
  }

  #clearTimer(): void {
    if (this.#timer === null) {
      return;
    }

    clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #flushBatchesWithCleanup(): Promise<void> {
    try {
      await this.#flushBatches();
    } finally {
      this.#flushPromise = null;
    }
  }

  async #flushBatches(): Promise<void> {
    if (this.#buffer.length === 0) {
      return;
    }

    const entries = this.#buffer.splice(0, this.options.maxBatchSize);

    try {
      await this.options.sink(entries);
    } catch (error) {
      this.#buffer = [...entries, ...this.#buffer];
      this.options.onError(error, entries);
      this.#scheduleFlush();
      return;
    }

    await this.#flushBatches();
  }
}

function formatSymbolValue(value: symbol): string {
  return value.description === undefined ? "Symbol()" : `Symbol(${value.description})`;
}

function formatFunctionName(name: string): string {
  return name.length > 0 ? `[Function ${name}]` : FUNCTION_VALUE_LABEL;
}

function normalizeValue(
  value: unknown,
  seenObjects: WeakSet<object> = new WeakSet<object>(),
): NormalizedLogValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack ?? null,
    };
  }

  if (Array.isArray(value)) {
    if (seenObjects.has(value)) {
      return CIRCULAR_REFERENCE_LABEL;
    }

    seenObjects.add(value);
    const entries = value.flatMap((entry): NormalizedLogValue[] => {
      const normalizedEntry = normalizeValue(entry, seenObjects);
      return normalizedEntry === undefined ? [] : [normalizedEntry];
    });
    seenObjects.delete(value);

    return entries;
  }

  if (typeof value === "object") {
    if (seenObjects.has(value)) {
      return CIRCULAR_REFERENCE_LABEL;
    }

    seenObjects.add(value);
    const normalizedRecord = Object.fromEntries(
      Object.entries(value).flatMap(([key, entryValue]) => {
        const normalizedEntry = normalizeValue(entryValue, seenObjects);
        return normalizedEntry === undefined ? [] : [[key, normalizedEntry]];
      }),
    );
    seenObjects.delete(value);

    return normalizedRecord;
  }

  if (typeof value === "symbol") {
    return formatSymbolValue(value);
  }

  if (typeof value === "function") {
    return formatFunctionName(value.name);
  }

  return SERIALIZATION_FAILURE_LABEL;
}

function toPrimitiveValue(value: unknown): PrimitiveLogValue | undefined {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (Array.isArray(value) || typeof value === "object") {
    return formatLogValue(value);
  }

  if (value === undefined) {
    return undefined;
  }

  return formatLogValue(value);
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.length > 0;
}

function readContextString(context: Partial<LogContext> | null | undefined, key: string): string {
  const value = context?.[key];
  return typeof value === "string" && value.length > 0 ? value : "";
}

function createBaseLogger(options: BaseLoggerOptions): Logger {
  const config: LoggerConfig = {
    context: normalizeLogContext({
      service: options.service,
      ...options.context,
    }),
    level: options.level ?? "info",
    sanitize: "default",
    structured: true,
    ...(options.namespace === undefined || options.namespace.length === 0
      ? {}
      : { namespace: options.namespace }),
  };

  return createLogger(config);
}

export function createConsoleLogger(options: BaseLoggerOptions): Logger {
  return createBaseLogger(options);
}

export function createBufferedSinkLogger(options: CreateBufferedSinkLoggerOptions): Logger {
  const logger = createBaseLogger(options);
  const level = options.level ?? "info";
  logger.removeTransport("console");

  logger.addTransport(
    new BufferedSinkTransport({
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      level,
      maxBatchSize: options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      maxBufferSize: options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE,
      name: options.name ?? "buffered-sink",
      onError: options.onError ?? ignoreBufferedSinkError,
      sink: options.sink,
    }),
  );

  return logger;
}

export function createErrorLogContext(error: unknown): LogMetadata {
  if (error instanceof Error) {
    return {
      error,
    };
  }

  return {
    error: {
      message: typeof error === "string" ? error : "Unknown error.",
      name: "UnknownError",
    },
  };
}

export function createRequestLogMetadata(request: Request): LogMetadata {
  const url = new URL(request.url);

  return {
    cfRay: request.headers.get("cf-ray"),
    method: request.method,
    path: url.pathname,
  };
}

export function createScopedWideEvent(config: WideEventConfig): WideEventBuilder {
  const activeContext = getActiveLogContext();
  const context = {
    ...activeContext,
    ...config.context,
  };

  return createWideEvent({
    type: config.type,
    ...(config.fields ? { fields: config.fields } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
  });
}

export function createTraceLogContext(input: CreateTraceLogContextInput): TraceLogContext {
  const parsedTraceparent = isNonEmptyString(input.traceparent)
    ? parseTraceparent(input.traceparent)
    : null;
  const traceId = input.traceId ?? parsedTraceparent?.traceId ?? generateTraceId();
  const spanId = input.spanId ?? generateSpanId();
  const parentSpanId = input.parentSpanId ?? parsedTraceparent?.spanId ?? null;
  const context = normalizeLogContext(input.context);

  return {
    ...context,
    requestId: input.requestId ?? generateRequestId(),
    service: input.service,
    spanId,
    traceId,
    ...(isNonEmptyString(parentSpanId) ? { parentSpanId } : {}),
  };
}

export function createRequestTraceLogContext(
  request: Request,
  input: {
    context?: Record<string, unknown>;
    service: string;
  },
): TraceLogContext {
  const requestUrl = new URL(request.url);
  const requestId = request.headers.get("x-request-id");
  const traceparent =
    request.headers.get("traceparent") ?? requestUrl.searchParams.get("traceparent");

  return createTraceLogContext({
    service: input.service,
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(isNonEmptyString(requestId) ? { requestId } : {}),
    ...(isNonEmptyString(traceparent) ? { traceparent } : {}),
  });
}

export function createTraceparentFromContext(context?: Partial<LogContext> | null): string {
  const activeContext = context ?? getContext();

  const traceId = readContextString(activeContext, "traceId");
  const spanId = readContextString(activeContext, "spanId");

  return createTraceparent(
    traceId.length > 0 ? traceId : generateTraceId(),
    spanId.length > 0 ? spanId : generateSpanId(),
  );
}

export function emitWideEvent(
  logger: Logger,
  builder: WideEventBuilder,
  options?: WideEventEndOptions,
): void {
  logger.emitWideEvent(builder.end(options));
}

export function formatLogValue(value: unknown): string {
  const normalized = normalizeValue(value);

  if (normalized === undefined) {
    return "";
  }

  if (normalized === null) {
    return "null";
  }

  if (typeof normalized === "boolean") {
    return normalized ? "true" : "false";
  }

  if (typeof normalized === "number") {
    return normalized.toString();
  }

  if (typeof normalized === "string") {
    return normalized;
  }

  try {
    return JSON.stringify(normalized);
  } catch {
    return SERIALIZATION_FAILURE_LABEL;
  }
}

export function getActiveLogContext(): LogContext | undefined {
  return getContext();
}

export function normalizeLogContext(context: Record<string, unknown> = {}): LogContext {
  return normalizeLogMetadata(context) as LogContext;
}

export function normalizeLogMetadata(metadata: Record<string, unknown> = {}): LogMetadata {
  return Object.fromEntries(
    Object.entries(metadata).flatMap(([key, value]) => {
      const normalized = normalizeValue(value);
      return normalized === undefined ? [] : [[key, normalized]];
    }),
  );
}

export function runWithLogContext<T>(context: Record<string, unknown>, fn: () => T): T {
  return withContext(normalizeLogContext(context), fn);
}

export async function runWithLogContextAsync<T>(
  context: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  return withContextAsync(normalizeLogContext(context), fn);
}

export function toPrimitiveLogRecord(metadata: Record<string, unknown> = {}): PrimitiveLogRecord {
  return Object.fromEntries(
    Object.entries(metadata).flatMap(([key, value]) => {
      const normalized = toPrimitiveValue(value);
      return normalized === undefined ? [] : [[key, normalized]];
    }),
  );
}
