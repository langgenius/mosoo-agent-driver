import type { CmaInboundEvent } from "../../projections/cma";
import type {
  CmaAgentRecord,
  CmaCreateAgentInput,
  CmaCreateEnvironmentInput,
  CmaCreateSessionInput,
  CmaEnvironmentRecord,
  CmaSessionEventRecord,
  CmaSessionRecord,
} from "../../stores/cma-store";
import { CMA_DEFAULT_BETA_HEADER_NAME, CMA_DEFAULT_BETA_HEADER_VALUE } from "../cma-http";
import { decodeCmaSseBytes } from "./sse-bytes-decoder";
import {
  CmaSdkError,
  type CmaSdkClient,
  type CmaSdkClientOptions,
  type CmaSdkFetch,
  type CmaSessionEventDispatchRecord,
} from "./types";

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

export function createCmaSdkClient(options: CmaSdkClientOptions): CmaSdkClient {
  return new CmaSdkClientCore(options);
}

class CmaSdkClientCore implements CmaSdkClient {
  readonly #baseUrl: URL;
  readonly #fetch: CmaSdkFetch;
  readonly #headers: Headers;

  constructor(options: CmaSdkClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#fetch = options.fetch ?? fetch;
    this.#headers = new Headers(options.headers);

    if (options.betaHeader !== false) {
      this.#headers.set(
        options.betaHeader?.name ?? CMA_DEFAULT_BETA_HEADER_NAME,
        options.betaHeader?.value ?? CMA_DEFAULT_BETA_HEADER_VALUE,
      );
    }
  }

  async archiveEnvironment(id: string): Promise<CmaEnvironmentRecord> {
    return this.#requestData<CmaEnvironmentRecord>(
      `/v1/environments/${encodeURIComponent(id)}/archive`,
      { method: "POST" },
    );
  }

  async createAgent(input: CmaCreateAgentInput): Promise<CmaAgentRecord> {
    return this.#requestData<CmaAgentRecord>("/v1/agents", {
      body: JSON.stringify(input),
      method: "POST",
    });
  }

  async createEnvironment(input: CmaCreateEnvironmentInput): Promise<CmaEnvironmentRecord> {
    return this.#requestData<CmaEnvironmentRecord>("/v1/environments", {
      body: JSON.stringify(input),
      method: "POST",
    });
  }

  async createSession(input: CmaCreateSessionInput): Promise<CmaSessionRecord> {
    return this.#requestData<CmaSessionRecord>("/v1/sessions", {
      body: JSON.stringify(input),
      method: "POST",
    });
  }

  async deleteEnvironment(id: string): Promise<void> {
    await this.#request(`/v1/environments/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async getAgent(id: string): Promise<CmaAgentRecord> {
    return this.#requestData<CmaAgentRecord>(`/v1/agents/${encodeURIComponent(id)}`);
  }

  async getEnvironment(id: string): Promise<CmaEnvironmentRecord> {
    return this.#requestData<CmaEnvironmentRecord>(`/v1/environments/${encodeURIComponent(id)}`);
  }

  async getSession(id: string): Promise<CmaSessionRecord> {
    return this.#requestData<CmaSessionRecord>(`/v1/sessions/${encodeURIComponent(id)}`);
  }

  async listAgents(): Promise<readonly CmaAgentRecord[]> {
    return this.#requestData<readonly CmaAgentRecord[]>("/v1/agents");
  }

  async listEnvironments(): Promise<readonly CmaEnvironmentRecord[]> {
    return this.#requestData<readonly CmaEnvironmentRecord[]>("/v1/environments");
  }

  async listSessionEvents(sessionId: string): Promise<readonly CmaSessionEventRecord[]> {
    return this.#requestData<readonly CmaSessionEventRecord[]>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
    );
  }

  async sendSessionEvent(
    sessionId: string,
    event: CmaInboundEvent,
  ): Promise<CmaSessionEventDispatchRecord> {
    return this.#requestData<CmaSessionEventDispatchRecord>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      { body: JSON.stringify(event), method: "POST" },
    );
  }

  async *streamSessionEvents(
    sessionId: string,
    afterCursor?: string,
  ): AsyncIterable<CmaSessionEventRecord> {
    const response = await this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      headers: {
        accept: "text/event-stream",
        ...(afterCursor === undefined ? {} : { "last-event-id": afterCursor }),
      },
    });

    if (!response.body) {
      throw new CmaSdkError(
        500,
        "CMA_SDK_STREAM_UNAVAILABLE",
        "CMA event stream is unavailable.",
        null,
      );
    }

    yield* decodeCmaSseBytes(response.body);
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      ...init,
      headers: this.#createHeaders(init.headers),
    });

    if (response.ok) {
      return response;
    }

    const body = await this.#readResponseBody(response);
    throw new CmaSdkError(
      response.status,
      readErrorCode(body),
      readErrorMessage(body, `CMA request failed with status ${response.status}.`),
      body,
    );
  }

  async #requestData<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#request(path, init);
    return readData(await this.#readResponseBody(response)) as T;
  }

  #createHeaders(input: HeadersInit | undefined): Headers {
    const headers = new Headers(this.#headers);

    if (input !== undefined) {
      for (const [name, value] of new Headers(input).entries()) {
        headers.set(name, value);
      }
    }

    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    return headers;
  }

  async #readResponseBody(response: Response): Promise<unknown> {
    if (response.status === 204) {
      return null;
    }

    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}
