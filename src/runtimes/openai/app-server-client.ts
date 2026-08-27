import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";

import { toDurationMs } from "../../core/driver-runtime-timing";
import type { DriverStartInput } from "../../protocol/start";
import { raceWithAbort, settlePromiseWithTimeout } from "../../utils/async";
import { AGENT_DRIVER_VERSION } from "../../core/version";
import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { buildRuntimeChildProcessEnv } from "../child-process-env";
import {
  bindSpawnedProcess,
  createProcessTreeEnvironment,
  releaseLinuxProcessMarker,
  signalBoundProcessTree,
  signalLinuxProcessMarker,
  spawnLinuxProcessTreeWatchdog,
  waitForLinuxProcessMarkerExit,
} from "../child-process";
import type { BoundSpawnedProcess } from "../child-process";
import { summarizeOpenAiProxyEnv } from "./app-server-env";
import { isRecord, readNonEmptyString, toJsonRpcId } from "./app-server-json";
import type { JsonObject } from "./app-server-json";
import {
  materializeOpenAiApiKeyAuthState,
  materializeOpenAiModelProviderConfig,
} from "./auth-state";
import type {
  ClientRequestMethod,
  ClientRequestParams,
  ClientRequestResult,
  RequestId,
  ServerNotificationMethod,
  ServerNotificationParams,
} from "./app-server-protocol";
import {
  CLIENT_REQUEST_RESULT_PARSERS,
  isServerNotificationMethod,
  isServerRequestMethod,
  parseServerNotification,
  parseServerRequest,
} from "./app-server-protocol";
import { buildOpenAiMcpServerConfig } from "./mcp-config";
import { OpenAiAppServerRequestHandler } from "./app-server-request-handler";
import { jsonRpcResponseSchema } from "./app-server-protocol-client-schemas";
import { toOpenAiProtocolError } from "./app-server-event-mapping";

interface PendingJsonRpcRequest {
  accept: ((value: unknown) => Promise<unknown>) | null;
  method: string;
  parse(value: unknown): unknown;
  reject(error: Error): void;
  rejectAtBarrier: ((error: Error) => Promise<void>) | null;
  responseQueued: boolean;
  resolve(value: unknown): void;
}

interface OpenAiAppServerClientStartPhase {
  readonly durationMs: number;
  readonly name: string;
}

interface OpenAiAppServerClientStartResult {
  readonly phases: readonly OpenAiAppServerClientStartPhase[];
}

interface OpenAiClientContext extends AgentDriverContext {
  handleNotification<M extends ServerNotificationMethod>(
    method: M,
    params: ServerNotificationParams[M],
  ): Promise<void>;
  handleProtocolError(error: Error): Promise<void>;
  mapToolCallId(toolCallId: string): string;
}

function summarizeJsonRpcErrorData(value: unknown): JsonObject | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    return {
      length: value.length,
      type: "string",
    };
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return {
      type: typeof value,
    };
  }

  if (Array.isArray(value)) {
    return {
      length: value.length,
      type: "array",
    };
  }

  if (isRecord(value)) {
    return {
      keys: Object.keys(value).toSorted().slice(0, 12),
      type: "object",
    };
  }

  return {
    type: typeof value,
  };
}

const OPENAI_RUNTIME_HOME_ENV_NAME = "CODEX_HOME";
const DEFAULT_OPENAI_RUNTIME_EXECUTABLE = "codex";
const APP_SERVER_TERMINATE_TIMEOUT_MS = 2_000;
const APP_SERVER_KILL_TIMEOUT_MS = 1_000;
const APP_SERVER_REQUEST_TIMEOUT_MS = 60_000;
const MAX_APP_SERVER_MESSAGE_BYTES = 8 * 1_024 * 1_024;
const MAX_PENDING_SERVER_MESSAGES = 1_024;
const MAX_PENDING_SERVER_MESSAGE_BYTES = 32 * 1_024 * 1_024;
const PAUSE_PENDING_SERVER_MESSAGES = Math.floor(MAX_PENDING_SERVER_MESSAGES * 0.75);
const RESUME_PENDING_SERVER_MESSAGES = Math.floor(MAX_PENDING_SERVER_MESSAGES * 0.5);
const PAUSE_PENDING_SERVER_MESSAGE_BYTES = Math.floor(MAX_PENDING_SERVER_MESSAGE_BYTES * 0.75);
const RESUME_PENDING_SERVER_MESSAGE_BYTES = Math.floor(MAX_PENDING_SERVER_MESSAGE_BYTES * 0.5);

export function limitNdjsonLines(maxMessageBytes = MAX_APP_SERVER_MESSAGE_BYTES): Transform {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
    throw new RangeError("App-server message byte limit must be a positive safe integer.");
  }

  let pendingBytes = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      let lineStart = 0;

      for (
        let newline = chunk.indexOf(0x0a);
        newline >= 0;
        newline = chunk.indexOf(0x0a, lineStart)
      ) {
        pendingBytes += newline - lineStart;

        if (pendingBytes > maxMessageBytes) {
          callback(new Error(`App-server message exceeds ${maxMessageBytes} bytes.`));
          return;
        }

        pendingBytes = 0;
        lineStart = newline + 1;
      }

      pendingBytes += chunk.length - lineStart;

      if (pendingBytes > maxMessageBytes) {
        callback(new Error(`App-server message exceeds ${maxMessageBytes} bytes.`));
        return;
      }

      callback(null, chunk);
    },
  });
}

function readRuntimeExecutable(): string {
  const executable = process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"]?.trim();
  return executable && executable.length > 0 ? executable : DEFAULT_OPENAI_RUNTIME_EXECUTABLE;
}

function signalAppServerSession(
  target: BoundSpawnedProcess,
  processTreeMarker: string,
  signal: NodeJS.Signals,
): void {
  signalBoundProcessTree(target, processTreeMarker, signal);
}

async function awaitProcessTreeCleanup(cleanup: Promise<void>, marker: string): Promise<void> {
  try {
    await cleanup;
    await waitForLinuxProcessMarkerExit(marker);
  } catch (error) {
    signalLinuxProcessMarker(marker, "SIGKILL");
    await waitForLinuxProcessMarkerExit(marker);
    throw error;
  }
}

export class OpenAiAppServerClient {
  readonly #context: OpenAiClientContext;
  readonly #pendingRequests = new Map<RequestId, PendingJsonRpcRequest>();
  readonly #payload: DriverStartInput;
  readonly #requestHandler: OpenAiAppServerRequestHandler;
  #fatalError: Error | null = null;
  #nextId = 1;
  #pendingServerMessageBytes = 0;
  #pendingServerMessages = 0;
  #process: ChildProcessWithoutNullStreams | null = null;
  #processCleanupFailureReported = false;
  #processTarget: BoundSpawnedProcess | null = null;
  #processClosed: Promise<void> | null = null;
  #processTreeMarker: string | null = null;
  #protocolFailureCommit: Promise<void> | null = null;
  #protocolFailureTask: Promise<void> | null = null;
  #readline: ReadlineInterface | null = null;
  #serverMessageQueue: Promise<void> = Promise.resolve();
  #serverMessagesPaused = false;
  #startRequested = false;
  #stopRequested = false;
  #stopTask: Promise<void> | null = null;

  constructor(payload: DriverStartInput, context: OpenAiClientContext) {
    this.#payload = payload;
    this.#context = context;
    this.#requestHandler = new OpenAiAppServerRequestHandler({
      context,
      handleError: async (error) => {
        void this.#failProtocol(error);
      },
      isStopped: () => this.#stopRequested,
      mapToolCallId: context.mapToolCallId,
      respond: (id, result) => this.respond(id, result),
      respondError: (id, message) => this.respondError(id, message),
    });
  }

  async start(signal?: AbortSignal): Promise<OpenAiAppServerClientStartResult> {
    signal?.throwIfAborted();
    if (this.#startRequested || this.#stopRequested) {
      throw new Error("OpenAi app-server client cannot be started more than once.");
    }
    this.#startRequested = true;

    const mcpConfig = buildOpenAiMcpServerConfig(this.#payload.execution.session.mcpServers);
    const env = buildRuntimeChildProcessEnv(this.#payload.execution.environment.paths, {
      ...process.env,
      ...this.#payload.execution.environment.variables,
      ...mcpConfig.env,
      [OPENAI_RUNTIME_HOME_ENV_NAME]: this.#payload.execution.session.homePath,
      LOG_FORMAT: "json",
    });
    const onAbort = () => {
      this.#stopRequested = true;
      const child = this.#process;
      const target = this.#processTarget;
      const marker = this.#processTreeMarker;

      if (child !== null && target !== null && marker !== null) {
        signalAppServerSession(target, marker, "SIGKILL");
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const phases: OpenAiAppServerClientStartPhase[] = [];
    const measure = async <T>(name: string, task: () => Promise<T>): Promise<T> => {
      const startedAtMs = Date.now();

      try {
        signal?.throwIfAborted();
        return await raceWithAbort(task(), signal);
      } finally {
        phases.push({
          durationMs: toDurationMs(startedAtMs),
          name,
        });
      }
    };
    const { homePath } = this.#payload.execution.session;
    const runtimeHome = homePath;
    await measure("app_server.home.mkdir", () => mkdir(runtimeHome, { recursive: true }));

    const authState = await measure("app_server.auth_state", () =>
      materializeOpenAiApiKeyAuthState({
        runtimeHome,
        env,
      }),
    );
    const modelProviderConfig = await measure("app_server.config", () =>
      materializeOpenAiModelProviderConfig({
        env,
        mcpServers: mcpConfig.mcpServers,
        provider: this.#payload.execution.provider,
        providerOptions: this.#payload.execution.providerOptions,
        runtimeHome,
      }),
    );

    this.#context.logger.debug("driver.openai.auth_state.prepared", {
      authJsonWritten: authState.written,
      hasApiKey: authState.hasApiKey,
    });
    this.#context.logger.debug("driver.openai.model_provider_config.prepared", {
      configTomlWritten: modelProviderConfig.written,
      mcpServerCount: Object.keys(mcpConfig.mcpServers).length,
      provider: modelProviderConfig.provider,
    });
    this.#context.logger.debug("driver.openai.env.prepared", {
      proxyEnv: summarizeOpenAiProxyEnv(env),
    });

    if (this.#stopRequested) {
      signal?.throwIfAborted();
      throw this.#fatalError ?? new Error("OpenAi app-server client stopped during startup.");
    }

    await measure("app_server.spawn", async () => {
      const executable = readRuntimeExecutable();
      const processTree = createProcessTreeEnvironment(env);
      this.#processTreeMarker = processTree.marker;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(executable, ["app-server"], {
          cwd: this.#payload.execution.session.cwd,
          detached: true,
          env: processTree.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        this.#releaseProcessTreeMarker(processTree.marker);
        throw error;
      }
      const target = bindSpawnedProcess(child, process.platform, processTree);

      this.#process = child;
      this.#processTarget = target;
      const leaderClosed = Promise.withResolvers<void>();
      const supervisionReady = Promise.withResolvers<{ cleanup: Promise<void> }>();
      let supervisionRegistered = false;
      const registerSupervision = (cleanup: Promise<void>) => {
        if (supervisionRegistered) {
          return;
        }
        supervisionRegistered = true;
        void cleanup.catch(() => {});
        supervisionReady.resolve({ cleanup });
      };
      const processClosed = (async () => {
        await leaderClosed.promise;
        const supervision = await supervisionReady.promise;
        await awaitProcessTreeCleanup(supervision.cleanup, processTree.marker);
        this.#releaseProcessTreeMarker(processTree.marker);
      })();
      void processClosed.catch(() => {});
      this.#processClosed = processClosed;
      const clearProcessClosed = () => {
        if (this.#processClosed === processClosed) {
          this.#processClosed = null;
        }
      };
      void processClosed.then(clearProcessClosed, clearProcessClosed);
      const limitedStdout = child.stdout.pipe(limitNdjsonLines());
      const reader = createInterface({ input: limitedStdout });
      this.#readline = reader;

      reader.on("line", (line) => {
        this.#onLine(line);
      });
      limitedStdout.once("error", (error) => {
        void this.#failProtocol(error);
      });
      child.stdin.on("error", (error) => {
        void this.#failProtocol(error);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.#context.logger.debug("driver.openai.stderr", {
          chunk,
        });
      });
      child.once("close", (code, exitSignal) => {
        signal?.removeEventListener("abort", onAbort);
        signalLinuxProcessMarker(processTree.marker, "SIGKILL");
        leaderClosed.resolve();
        reader.close();

        if (this.#process === child) {
          this.#process = null;
          this.#processTarget = null;
          this.#readline = null;
        }

        if (this.#stopRequested) {
          return;
        }

        const error = new Error(
          `OpenAi app-server exited with ${code === null ? `signal ${exitSignal ?? "unknown"}` : `code ${code}`}.`,
        );
        void (async () => {
          let failure = error;
          try {
            await processClosed;
          } catch (cleanupError) {
            failure =
              cleanupError instanceof Error
                ? cleanupError
                : new Error("OpenAi app-server process-tree cleanup failed.");
          }
          await this.#failProtocol(failure);
        })();
      });

      try {
        await once(child, "spawn");
        if (process.platform === "linux") {
          const watchdog =
            child.pid === undefined
              ? null
              : spawnLinuxProcessTreeWatchdog(child.pid, processTree.marker);
          if (watchdog === null) {
            const error = new Error("OpenAi app-server process-tree watchdog could not start.");
            registerSupervision(
              (async () => {
                signalLinuxProcessMarker(processTree.marker, "SIGKILL");
                await waitForLinuxProcessMarkerExit(processTree.marker);
              })(),
            );
            void this.#failProtocol(error);
            throw error;
          }

          registerSupervision(watchdog.cleanup);
          const failSupervision = (error: Error) => {
            if (this.#process !== child) {
              return;
            }
            signalLinuxProcessMarker(processTree.marker, "SIGKILL");
            void this.#failProtocol(error);
          };
          void watchdog.cleanup.then(
            () =>
              failSupervision(
                new Error(
                  "OpenAi app-server process-tree watchdog exited while provider was live.",
                ),
              ),
            (watchdogError: unknown) =>
              failSupervision(
                new Error("OpenAi app-server process-tree watchdog failed.", {
                  cause: watchdogError,
                }),
              ),
          );
        } else {
          registerSupervision(Promise.resolve());
        }
      } catch (error) {
        if (!supervisionRegistered) {
          registerSupervision(
            (async () => {
              signalLinuxProcessMarker(processTree.marker, "SIGKILL");
              await waitForLinuxProcessMarkerExit(processTree.marker);
            })(),
          );
        }
        throw error;
      }
      child.on("error", (error) => {
        void this.#failProtocol(error);
      });
    });

    if (this.#stopRequested) {
      signal?.throwIfAborted();
      throw this.#fatalError ?? new Error("OpenAi app-server client stopped during startup.");
    }

    await measure("app_server.initialize", async () => {
      await this.request(
        "initialize",
        {
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
          clientInfo: {
            name: "mosoo_driver",
            title: "mosoo Driver",
            version: AGENT_DRIVER_VERSION,
          },
        },
        signal,
      );
      if (this.#stopRequested) {
        return;
      }

      this.notify("initialized", undefined);
    });

    return { phases };
  }

  async request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequestParams[M],
    signal?: AbortSignal,
  ): Promise<ClientRequestResult[M]> {
    return this.#request(method, params, CLIENT_REQUEST_RESULT_PARSERS[method], null, signal);
  }

  async requestAtWireBarrier<M extends ClientRequestMethod, R>(
    method: M,
    params: ClientRequestParams[M],
    handlers: {
      accept(result: ClientRequestResult[M]): Promise<R>;
      reject(error: Error): Promise<void>;
    },
    signal?: AbortSignal,
  ): Promise<R> {
    return this.#request(method, params, CLIENT_REQUEST_RESULT_PARSERS[method], handlers, signal);
  }

  async #request<T, R>(
    method: string,
    params: unknown,
    parseResult: (value: unknown) => T,
    handlers: { accept(result: T): Promise<R>; reject(error: Error): Promise<void> } | null,
    signal?: AbortSignal,
  ): Promise<R> {
    signal?.throwIfAborted();
    const id = this.#nextId;
    this.#nextId += 1;

    const response = Promise.withResolvers<R>();
    this.#pendingRequests.set(id, {
      accept: handlers === null ? null : async (value: unknown) => handlers.accept(value as T),
      method,
      parse: parseResult,
      reject: response.reject,
      rejectAtBarrier: handlers?.reject ?? null,
      responseQueued: false,
      resolve: response.resolve,
    });

    try {
      this.#send({
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    } catch (error) {
      this.#pendingRequests.delete(id);
      throw error;
    }

    try {
      const result = await settlePromiseWithTimeout(response.promise, {
        label: `App-server ${method} request`,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: APP_SERVER_REQUEST_TIMEOUT_MS,
      });

      if (result.status === "completed") {
        return result.value;
      }

      if (result.status === "timed_out") {
        await this.#failProtocol(result.error);
      }

      throw result.error;
    } finally {
      this.#pendingRequests.delete(id);
    }
  }

  notify(method: string, params: JsonObject | undefined): void {
    this.#send({
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async drainServerMessages(): Promise<void> {
    for (;;) {
      const tail = this.#serverMessageQueue;
      await tail;
      // Resuming stdout schedules the next buffered chunk on a later event-loop
      // turn. A microtask-only check can mistake that backpressure handoff for
      // an empty queue and return before the resumed notifications are admitted.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      if (tail === this.#serverMessageQueue) {
        if (this.#fatalError !== null) {
          throw this.#fatalError;
        }
        return;
      }
    }
  }

  respond(id: RequestId, result: unknown): void {
    this.#send({
      id,
      result,
    });
  }

  respondError(id: RequestId, message: string): void {
    this.#send({
      error: {
        code: -32_000,
        message,
      },
      id,
    });
  }

  abortServerRequests(reason: Error): Promise<void> {
    return this.#requestHandler.abortAll(reason);
  }

  stop(signal?: AbortSignal): Promise<void> {
    this.#stopRequested = true;
    if (this.#stopTask !== null) {
      return this.#stopTask;
    }

    const task = this.#performStop(signal).finally(() => {
      if (this.#stopTask === task) {
        this.#stopTask = null;
      }
    });
    this.#stopTask = task;
    return task;
  }

  async #performStop(signal?: AbortSignal): Promise<void> {
    const child = this.#process;
    const target = this.#processTarget;
    const processClosed = this.#processClosed;
    const processTreeMarker = this.#processTreeMarker ?? "";
    const onAbort = () => {
      if (child === null || target === null) {
        signalLinuxProcessMarker(processTreeMarker, "SIGKILL");
      } else {
        signalAppServerSession(target, processTreeMarker, "SIGKILL");
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }

    try {
      this.#readline?.close();
      this.#rejectPending(new Error("OpenAi app-server stopped."));
      void this.abortServerRequests(new Error("OpenAi app-server stopped.")).catch(() => {});

      if (processClosed === null) {
        signalLinuxProcessMarker(processTreeMarker, "SIGKILL");
        await waitForLinuxProcessMarkerExit(processTreeMarker, APP_SERVER_KILL_TIMEOUT_MS);
        this.#releaseProcessTreeMarker(processTreeMarker);
        return;
      }

      if (target !== null && !signal?.aborted) {
        signalAppServerSession(target, processTreeMarker, "SIGTERM");
      }

      const terminated = await settlePromiseWithTimeout(processClosed, {
        label: "OpenAi app-server termination",
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: APP_SERVER_TERMINATE_TIMEOUT_MS,
      });

      if (terminated.status === "completed") {
        return;
      }

      if (child === null || target === null) {
        signalLinuxProcessMarker(processTreeMarker, "SIGKILL");
      } else {
        signalAppServerSession(target, processTreeMarker, "SIGKILL");
      }

      if (process.platform === "linux") {
        try {
          await waitForLinuxProcessMarkerExit(processTreeMarker, APP_SERVER_KILL_TIMEOUT_MS);
        } catch (error) {
          this.#processCleanupFailureReported = true;
          throw error;
        }
        if (terminated.status === "failed" && !this.#processCleanupFailureReported) {
          this.#processCleanupFailureReported = true;
          throw terminated.error;
        }
        this.#releaseProcessTreeMarker(processTreeMarker);
        return;
      }

      const killed = await settlePromiseWithTimeout(processClosed, {
        label: "OpenAi app-server forced termination",
        timeoutMs: APP_SERVER_KILL_TIMEOUT_MS,
      });

      if (killed.status !== "completed") {
        throw killed.error;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #releaseProcessTreeMarker(marker: string): void {
    if (this.#processTreeMarker !== marker) {
      return;
    }
    this.#processTreeMarker = null;
    releaseLinuxProcessMarker(marker);
  }

  #send(message: Record<string, unknown>): void {
    if (this.#stopRequested) {
      throw new Error("OpenAi app-server client is stopping.");
    }

    const child = this.#process;

    if (child === null || child.stdin.destroyed) {
      throw new Error("OpenAi app-server is not running.");
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line: string): void {
    if (this.#stopRequested || this.#fatalError !== null) {
      return;
    }

    const trimmed = line.trim();

    if (trimmed.length === 0) {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(trimmed);
    } catch {
      void this.#failProtocol(new TypeError("OpenAi app-server stdout is not valid JSON."));
      return;
    }

    if (!isRecord(parsed)) {
      void this.#failProtocol(
        new TypeError("OpenAi app-server protocol message must be an object."),
      );
      return;
    }

    const method = readNonEmptyString(parsed, "method");
    const id = toJsonRpcId(parsed["id"]);

    if ("result" in parsed || "error" in parsed) {
      if (id === null) {
        void this.#failProtocol(new TypeError("OpenAi app-server response requires a valid id."));
        return;
      }

      this.#onResponse(id, parsed);
      return;
    }

    if (method !== null) {
      const bytes = Buffer.byteLength(trimmed, "utf8");

      if (
        this.#pendingServerMessages >= MAX_PENDING_SERVER_MESSAGES ||
        bytes > MAX_PENDING_SERVER_MESSAGE_BYTES - this.#pendingServerMessageBytes
      ) {
        void this.#failProtocol(new Error("App-server message queue limit exceeded."));
        return;
      }

      this.#pendingServerMessages += 1;
      this.#pendingServerMessageBytes += bytes;
      this.#pauseServerMessagesIfNeeded();
      this.#serverMessageQueue = this.#processMessage(
        this.#serverMessageQueue,
        parsed,
        method,
        id,
      ).finally(() => {
        this.#pendingServerMessages -= 1;
        this.#pendingServerMessageBytes -= bytes;
        this.#resumeServerMessagesIfReady();
      });
      return;
    }

    if (id !== null) {
      this.#onResponse(id, parsed);
      return;
    }

    void this.#failProtocol(
      new TypeError("OpenAi app-server protocol message requires a valid method or id."),
    );
  }

  #pauseServerMessagesIfNeeded(): void {
    if (
      this.#serverMessagesPaused ||
      (this.#pendingServerMessages < PAUSE_PENDING_SERVER_MESSAGES &&
        this.#pendingServerMessageBytes < PAUSE_PENDING_SERVER_MESSAGE_BYTES)
    ) {
      return;
    }

    this.#serverMessagesPaused = true;
    this.#context.logger.debug("driver.openai.server_message_queue.paused", {
      pendingBytes: this.#pendingServerMessageBytes,
      pendingMessages: this.#pendingServerMessages,
    });
    this.#process?.stdout.pause();
  }

  #resumeServerMessagesIfReady(): void {
    if (
      !this.#serverMessagesPaused ||
      this.#stopRequested ||
      this.#fatalError !== null ||
      this.#pendingServerMessages > RESUME_PENDING_SERVER_MESSAGES ||
      this.#pendingServerMessageBytes > RESUME_PENDING_SERVER_MESSAGE_BYTES
    ) {
      return;
    }

    this.#serverMessagesPaused = false;
    this.#context.logger.debug("driver.openai.server_message_queue.resumed", {
      pendingBytes: this.#pendingServerMessageBytes,
      pendingMessages: this.#pendingServerMessages,
    });
    this.#process?.stdout.resume();
  }

  #failProtocol(error: Error): Promise<void> {
    if (this.#stopRequested) {
      return Promise.resolve();
    }

    if (this.#protocolFailureTask !== null) {
      return this.#protocolFailureTask;
    }
    if (this.#fatalError !== null) {
      return this.#protocolFailureCommit ?? Promise.resolve();
    }

    this.#fatalError = error;
    this.#process?.stdout.pause();
    const barrier = this.#serverMessageQueue;
    const task = (async () => {
      await barrier;
      await this.#commitProtocolFailure(error);
    })();
    this.#protocolFailureTask = task;
    this.#serverMessageQueue = task;
    return task;
  }

  async #failQueuedProtocol(error: Error): Promise<void> {
    if (this.#stopRequested) {
      return;
    }

    // This message was admitted before any out-of-band failure waiting on the
    // queue barrier, so its failure is authoritative in wire order.
    if (this.#protocolFailureCommit === null) {
      this.#fatalError = error;
    }
    this.#process?.stdout.pause();
    await this.#commitProtocolFailure(this.#fatalError ?? error);
  }

  #commitProtocolFailure(error: Error): Promise<void> {
    if (this.#protocolFailureCommit !== null) {
      return this.#protocolFailureCommit;
    }

    const task = this.#finishProtocolFailure(error);
    this.#protocolFailureCommit = task;
    return task;
  }

  async #finishProtocolFailure(error: Error): Promise<void> {
    await this.#notifyProtocolError(error);
    this.#rejectPending(error);
    void this.stop().catch(() => {});
  }

  async #notifyProtocolError(error: Error): Promise<void> {
    try {
      await this.#context.handleProtocolError(error);
    } catch (protocolError) {
      this.#context.logger.error(
        "driver.openai.protocol_failure_handler.failed",
        protocolError,
        {},
      );
    }
  }

  async #processMessage(
    previousMessage: Promise<void>,
    message: JsonObject,
    method: string,
    id: RequestId | null,
  ): Promise<void> {
    try {
      await previousMessage;

      if (this.#stopRequested) {
        return;
      }

      await this.#onServerMessage(message, method, id);
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("OpenAi app-server protocol message failed.");
      this.#context.logger.error("driver.openai.server_message.failed", error, {
        method,
      });

      if (id === null) {
        await this.#failQueuedProtocol(failure);
        return;
      }

      if (!this.#stopRequested) {
        await this.#notifyProtocolError(failure);
      }

      if (id !== null && !this.#stopRequested) {
        try {
          this.respondError(id, failure.message);
        } catch (responseError) {
          this.#context.logger.error("driver.openai.server_error_response.failed", responseError, {
            method,
          });
        }
      }
    }
  }

  #onResponse(id: RequestId, message: JsonObject): void {
    const parsed = jsonRpcResponseSchema.safeParse(message);

    if (!parsed.success) {
      void this.#failProtocol(
        new TypeError("OpenAi app-server response envelope is invalid.", {
          cause: parsed.error,
        }),
      );
      return;
    }

    const pending = this.#pendingRequests.get(id);

    if (pending === undefined || pending.responseQueued) {
      return;
    }
    if (pending.accept === null) {
      this.#settleResponse(id, pending, parsed.data);
      return;
    }
    pending.responseQueued = true;
    this.#serverMessageQueue = this.#processResponse(
      this.#serverMessageQueue,
      id,
      pending,
      parsed.data,
    );
  }

  async #processResponse(
    previousMessage: Promise<void>,
    id: RequestId,
    pending: PendingJsonRpcRequest,
    response:
      | { error: { code: number; data?: unknown; message: string }; id: RequestId }
      | {
          id: RequestId;
          result: unknown;
        },
  ): Promise<void> {
    await previousMessage;

    if (this.#pendingRequests.get(id) !== pending) {
      return;
    }
    const accept = pending.accept;
    const rejectAtBarrier = pending.rejectAtBarrier;
    if (accept === null || rejectAtBarrier === null) {
      await this.#failQueuedProtocol(new Error("Wire-barrier response handlers are missing."));
      return;
    }

    if ("error" in response) {
      const error = this.#reportResponseError(pending, response.error);
      this.#pendingRequests.delete(id);
      try {
        await rejectAtBarrier(error);
        pending.reject(error);
      } catch (rejectionError) {
        const failure =
          rejectionError instanceof Error
            ? rejectionError
            : new Error("OpenAi app-server response rejection failed.");
        await this.#failQueuedProtocol(failure);
        pending.reject(failure);
      }
      return;
    }

    let result: unknown;
    try {
      result = pending.parse(response.result);
    } catch (parseError) {
      const error =
        parseError instanceof Error
          ? parseError
          : new Error("OpenAi app-server result parse failed.");
      await this.#failQueuedProtocol(error);
      return;
    }

    this.#pendingRequests.delete(id);
    try {
      pending.resolve(await accept(result));
    } catch (acceptError) {
      const error =
        acceptError instanceof Error
          ? acceptError
          : new Error("OpenAi app-server response acceptance failed.");
      await this.#failQueuedProtocol(error);
      pending.reject(error);
    }
  }

  #settleResponse(
    id: RequestId,
    pending: PendingJsonRpcRequest,
    response:
      | { error: { code: number; data?: unknown; message: string }; id: RequestId }
      | { id: RequestId; result: unknown },
  ): void {
    if ("error" in response) {
      this.#rejectResponse(id, pending, response.error);
      return;
    }

    try {
      pending.resolve(pending.parse(response.result));
      this.#pendingRequests.delete(id);
    } catch (parseError) {
      const error =
        parseError instanceof Error
          ? parseError
          : new Error("OpenAi app-server result parse failed.");
      void this.#failProtocol(error);
    }
  }

  #rejectResponse(
    id: RequestId,
    pending: PendingJsonRpcRequest,
    error: { code: number; data?: unknown; message: string },
  ): void {
    this.#pendingRequests.delete(id);
    pending.reject(this.#reportResponseError(pending, error));
  }

  #reportResponseError(
    pending: PendingJsonRpcRequest,
    error: { code: number; data?: unknown; message: string },
  ): Error {
    const failure = new Error(error.message);
    this.#context.logger.error(
      "driver.openai.client_request.failed",
      new Error(toOpenAiProtocolError({ message: error.message }).message),
      {
        data: summarizeJsonRpcErrorData(error.data),
        method: pending.method,
        responseCode: error.code,
      },
    );
    return failure;
  }

  async #onServerMessage(message: JsonObject, method: string, id: RequestId | null): Promise<void> {
    if (id === null) {
      if (isServerRequestMethod(method)) {
        parseServerRequest(message);
        throw new Error(`OpenAi app-server request ${method} is missing a valid id.`);
      }

      if (!isServerNotificationMethod(method)) {
        this.#context.logger.debug("driver.openai.server_notification.ignored", {
          method,
        });
        return;
      }

      const notification = parseServerNotification(message)!;

      if (notification.method === "serverRequest/resolved") {
        const requestId = notification.params["requestId"];

        if (typeof requestId !== "number" && typeof requestId !== "string") {
          throw new TypeError("serverRequest/resolved params.requestId is invalid.");
        }

        await this.#requestHandler.resolveElsewhere(requestId);
        await this.#context.handleNotification(notification.method, notification.params);
        return;
      }

      await this.#context.handleNotification(notification.method, notification.params);
      return;
    }

    if (!isServerRequestMethod(method)) {
      this.respondError(id, `Unsupported OpenAi app-server request: ${method}.`);
      return;
    }

    const request = parseServerRequest(message)!;

    if (this.#requestHandler.isPending(request.id)) {
      await this.#failQueuedProtocol(
        new Error(`OpenAi app-server request ${String(request.id)} is already pending.`),
      );
      return;
    }

    this.#requestHandler.dispatch(request.method, request.id, request.params);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pendingRequests.values()) {
      pending.reject(error);
    }

    this.#pendingRequests.clear();
  }
}
