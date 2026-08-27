import type { CmaInboundEvent } from "../../projections/cma";
import { CMA_MAX_REPLAY_BYTES } from "../../stores/cma-store";
import type {
  CmaAgentRecord,
  CmaCreateAgentInput,
  CmaCreateEnvironmentInput,
  CmaCreateSessionInput,
  CmaEnvironmentRecord,
  CmaSessionEventRecord,
  CmaSessionRecord,
} from "../../stores/cma-store";
import { raceWithAbort } from "../../utils/async";
import { CMA_DEFAULT_BETA_HEADER_NAME, CMA_DEFAULT_BETA_HEADER_VALUE } from "../cma-http";
import { decodeCmaSseBytes } from "./sse-bytes-decoder";
import {
  CmaSdkError,
  type CmaSdkClient,
  type CmaSdkClientOptions,
  type CmaSdkFetch,
  type CmaSdkRequestOptions,
  type CmaSdkStreamOptions,
  type CmaSessionEventDispatchRecord,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorCode(body: unknown): string {
  if (!isRecord(body)) {
    return "CMA_SDK_HTTP_ERROR";
  }

  const error = body["error"];

  if (!isRecord(error)) {
    return "CMA_SDK_HTTP_ERROR";
  }

  const code = error["code"];
  return typeof code === "string" && code.length > 0 ? code : "CMA_SDK_HTTP_ERROR";
}

function readErrorMessage(body: unknown, fallback: string): string {
  if (!isRecord(body)) {
    return fallback;
  }

  const error = body["error"];

  if (!isRecord(error)) {
    return fallback;
  }

  const message = error["message"];
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

function readData(body: unknown): unknown {
  if (!isRecord(body) || !("data" in body)) {
    throw new CmaSdkError(500, "CMA_SDK_INVALID_RESPONSE", "CMA response is missing data.", body);
  }

  return body["data"];
}

function assertIntegerInRange(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function responseTooLarge(maxResponseBytes: number): CmaSdkError {
  return new CmaSdkError(
    500,
    "CMA_SDK_RESPONSE_TOO_LARGE",
    `CMA response exceeds ${maxResponseBytes} bytes.`,
    null,
  );
}

async function readResponseBody(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const contentLength = Number(response.headers.get("content-length"));

  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw responseTooLarge(maxResponseBytes);
  }

  const reader = response.body?.getReader();

  if (!reader) {
    return null;
  }

  let body = new Uint8Array(0);
  let cancellation: Promise<void> | undefined;
  let completed = false;
  let size = 0;
  const cancel = () =>
    (cancellation ??= reader.cancel(signal.reason).then(
      () => undefined,
      () => undefined,
    ));
  const onAbort = () => void cancel();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    signal.throwIfAborted();

    while (true) {
      const chunk = await raceWithAbort(reader.read(), signal);
      signal.throwIfAborted();

      if (chunk.done) {
        completed = true;
        break;
      }

      if (chunk.value.byteLength > maxResponseBytes - size) {
        throw responseTooLarge(maxResponseBytes);
      }

      const nextSize = size + chunk.value.byteLength;

      if (nextSize > body.byteLength) {
        const grown = new Uint8Array(
          Math.min(maxResponseBytes, Math.max(nextSize, body.byteLength * 2, 1_024)),
        );
        grown.set(body);
        body = grown;
      }

      body.set(chunk.value, size);
      size = nextSize;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);

    if (!completed) {
      await cancel();
    }

    reader.releaseLock();
  }

  try {
    return JSON.parse(new TextDecoder().decode(body.subarray(0, size))) as unknown;
  } catch {
    return null;
  }
}

export function createCmaSdkClient(options: CmaSdkClientOptions): CmaSdkClient {
  return new CmaSdkClientCore(options);
}

class CmaSdkClientCore implements CmaSdkClient {
  readonly #baseUrl: URL;
  readonly #fetch: CmaSdkFetch;
  readonly #headers: Headers;
  readonly #maxResponseBytes: number;
  readonly #signal: AbortSignal | undefined;
  readonly #timeoutMs: number;

  constructor(options: CmaSdkClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#fetch = options.fetch ?? fetch;
    this.#headers = new Headers(options.headers);
    this.#maxResponseBytes = options.maxResponseBytes ?? CMA_MAX_REPLAY_BYTES;
    this.#signal = options.signal;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertIntegerInRange(this.#maxResponseBytes, "maxResponseBytes", 1, Number.MAX_SAFE_INTEGER);
    assertIntegerInRange(this.#timeoutMs, "timeoutMs", 0, MAX_TIMER_MS);

    if (options.betaHeader !== false) {
      this.#headers.set(
        options.betaHeader?.name ?? CMA_DEFAULT_BETA_HEADER_NAME,
        options.betaHeader?.value ?? CMA_DEFAULT_BETA_HEADER_VALUE,
      );
    }
  }

  async archiveEnvironment(
    id: string,
    options?: CmaSdkRequestOptions,
  ): Promise<CmaEnvironmentRecord> {
    return this.#requestData<CmaEnvironmentRecord>(
      `/v1/environments/${encodeURIComponent(id)}/archive`,
      { method: "POST" },
      options,
    );
  }

  async createAgent(
    input: CmaCreateAgentInput,
    options?: CmaSdkRequestOptions,
  ): Promise<CmaAgentRecord> {
    return this.#requestData<CmaAgentRecord>(
      "/v1/agents",
      {
        body: JSON.stringify(input),
        method: "POST",
      },
      options,
    );
  }

  async createEnvironment(
    input: CmaCreateEnvironmentInput,
    options?: CmaSdkRequestOptions,
  ): Promise<CmaEnvironmentRecord> {
    return this.#requestData<CmaEnvironmentRecord>(
      "/v1/environments",
      {
        body: JSON.stringify(input),
        method: "POST",
      },
      options,
    );
  }

  async createSession(
    input: CmaCreateSessionInput,
    options?: CmaSdkRequestOptions,
  ): Promise<CmaSessionRecord> {
    return this.#requestData<CmaSessionRecord>(
      "/v1/sessions",
      {
        body: JSON.stringify(input),
        method: "POST",
      },
      options,
    );
  }

  async deleteEnvironment(id: string, options?: CmaSdkRequestOptions): Promise<void> {
    await this.#requestBody(
      `/v1/environments/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      options,
    );
  }

  async getAgent(id: string, options?: CmaSdkRequestOptions): Promise<CmaAgentRecord> {
    return this.#requestData<CmaAgentRecord>(`/v1/agents/${encodeURIComponent(id)}`, {}, options);
  }

  async getEnvironment(id: string, options?: CmaSdkRequestOptions): Promise<CmaEnvironmentRecord> {
    return this.#requestData<CmaEnvironmentRecord>(
      `/v1/environments/${encodeURIComponent(id)}`,
      {},
      options,
    );
  }

  async getSession(id: string, options?: CmaSdkRequestOptions): Promise<CmaSessionRecord> {
    return this.#requestData<CmaSessionRecord>(
      `/v1/sessions/${encodeURIComponent(id)}`,
      {},
      options,
    );
  }

  async listAgents(options?: CmaSdkRequestOptions): Promise<readonly CmaAgentRecord[]> {
    return this.#requestData<readonly CmaAgentRecord[]>("/v1/agents", {}, options);
  }

  async listEnvironments(options?: CmaSdkRequestOptions): Promise<readonly CmaEnvironmentRecord[]> {
    return this.#requestData<readonly CmaEnvironmentRecord[]>("/v1/environments", {}, options);
  }

  async listSessionEvents(
    sessionId: string,
    options?: CmaSdkRequestOptions,
  ): Promise<readonly CmaSessionEventRecord[]> {
    return this.#requestData<readonly CmaSessionEventRecord[]>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      {},
      options,
    );
  }

  async sendSessionEvent(
    sessionId: string,
    event: CmaInboundEvent,
    options?: CmaSdkRequestOptions,
  ): Promise<CmaSessionEventDispatchRecord> {
    return this.#requestData<CmaSessionEventDispatchRecord>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      { body: JSON.stringify(event), method: "POST" },
      options,
    );
  }

  streamSessionEvents(
    sessionId: string,
    options: CmaSdkStreamOptions = {},
  ): AsyncIterable<CmaSessionEventRecord> {
    const controller = new AbortController();
    const signal = this.#combineSignals(options.signal, controller.signal);
    const iterator = this.#streamSessionEvents(sessionId, options.afterCursor, signal);
    const stream: AsyncIterableIterator<CmaSessionEventRecord> = {
      [Symbol.asyncIterator]() {
        return stream;
      },
      next() {
        return iterator.next();
      },
      return() {
        controller.abort();
        return iterator.return(undefined);
      },
    };
    return stream;
  }

  async *#streamSessionEvents(
    sessionId: string,
    afterCursor: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<CmaSessionEventRecord> {
    const request = this.#startRequest(signal);
    let response: Response;

    try {
      response = await this.#request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
        {
          headers: {
            accept: "text/event-stream",
            ...(afterCursor === undefined ? {} : { "last-event-id": afterCursor }),
          },
        },
        request.signal,
      );
    } finally {
      request.stop();
    }

    if (!response.body) {
      signal.throwIfAborted();
      throw new CmaSdkError(
        500,
        "CMA_SDK_STREAM_UNAVAILABLE",
        "CMA event stream is unavailable.",
        null,
      );
    }

    yield* decodeCmaSseBytes(response.body, signal);
  }

  async #request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    const response = await raceWithAbort(
      this.#fetch(new URL(path, this.#baseUrl), {
        ...init,
        headers: this.#createHeaders(init.headers, init.body !== null && init.body !== undefined),
        signal,
      }),
      signal,
    );

    if (response.ok) {
      return response;
    }

    const body = await readResponseBody(response, this.#maxResponseBytes, signal);
    throw new CmaSdkError(
      response.status,
      readErrorCode(body),
      readErrorMessage(body, `CMA request failed with status ${response.status}.`),
      body,
    );
  }

  async #requestBody(
    path: string,
    init: RequestInit,
    options: CmaSdkRequestOptions | undefined,
  ): Promise<unknown> {
    const request = this.#startRequest(options?.signal);

    try {
      const response = await this.#request(path, init, request.signal);
      return await readResponseBody(response, this.#maxResponseBytes, request.signal);
    } finally {
      request.stop();
    }
  }

  async #requestData<T>(
    path: string,
    init: RequestInit,
    options: CmaSdkRequestOptions | undefined,
  ): Promise<T> {
    return readData(await this.#requestBody(path, init, options)) as T;
  }

  #combineSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
    const defined = [this.#signal, ...signals].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    return defined.length === 1 ? defined[0]! : AbortSignal.any(defined);
  }

  #startRequest(signal?: AbortSignal): { readonly signal: AbortSignal; stop(): void } {
    const deadline = new AbortController();
    const timeoutId = setTimeout(() => {
      deadline.abort(
        new DOMException(`CMA request timed out after ${this.#timeoutMs}ms.`, "TimeoutError"),
      );
    }, this.#timeoutMs);

    return {
      signal: this.#combineSignals(signal, deadline.signal),
      stop: () => clearTimeout(timeoutId),
    };
  }

  #createHeaders(input: HeadersInit | undefined, hasBody: boolean): Headers {
    const headers = new Headers(this.#headers);

    if (input !== undefined) {
      for (const [name, value] of new Headers(input).entries()) {
        headers.set(name, value);
      }
    }

    if (hasBody && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    return headers;
  }
}
