import {
  CmaInvalidEventError,
  CmaUnsupportedFieldError,
  parseCmaInboundEvent,
} from "../../projections/cma";
import type { CmaInboundEvent } from "../../projections/cma";
import { projectCmaInboundToDriverCommand } from "../../projections/cma";
import type { RuntimeCommand, RuntimeCommandResult } from "../../runtime-command";
import { isDriverId } from "../../protocol/id";
import type {
  CmaCreateAgentInput,
  CmaCreateEnvironmentInput,
  CmaCreateSessionInput,
  CmaEnvironmentConfig,
  CmaEnvironmentLimitedNetworking,
  CmaEnvironmentNetworking,
  CmaEnvironmentPackages,
  CmaEnvironmentPackageManager,
  CmaInboundEventLease,
  CmaSessionEventRecord,
  CmaSessionRecord,
  CmaStore,
} from "../../stores/cma-store";
import {
  CMA_MAX_EVENT_BYTES,
  CmaSessionTerminatedError,
  CmaStoreConflictError,
  CmaStoreNotFoundError,
  encodeCmaSseRecord,
} from "../../stores/cma-store";
import { sleepPromise } from "../../utils/async";

type HttpMethod = "DELETE" | "GET" | "POST";

export const CMA_DEFAULT_BETA_HEADER_NAME = "anthropic-beta";
export const CMA_DEFAULT_BETA_HEADER_VALUE = "managed-agents-2026-04-01";

export interface CmaHttpAuthorizationContext {
  readonly request: Request;
  readonly segments: readonly string[];
}

export type CmaHttpAuthorizer = (
  context: CmaHttpAuthorizationContext,
) => Promise<Response | void> | Response | void;

export interface CmaHttpBetaHeaderRequirement {
  readonly name?: string;
  readonly value?: string;
}

export interface CmaHttpDriverCommandDispatchInput {
  readonly command: RuntimeCommand;
  readonly event: CmaInboundEvent;
  readonly session: CmaSessionRecord;
  readonly signal: AbortSignal;
}

export type CmaHttpDriverCommandDispatcher = (
  input: CmaHttpDriverCommandDispatchInput,
) => Promise<RuntimeCommandResult | void>;

export interface CmaHttpHandlerOptions {
  readonly authorize?: CmaHttpAuthorizer;
  readonly betaHeader?: CmaHttpBetaHeaderRequirement | false;
  readonly dispatchDriverCommand: CmaHttpDriverCommandDispatcher;
  readonly store: CmaStore;
}

export type CmaHttpHandler = (request: Request) => Promise<Response>;

class CmaHttpRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CmaHttpRequestError";
    this.status = status;
    this.code = code;
  }
}

class CmaHttpDriverDispatchError extends Error {
  constructor() {
    super("Driver command dispatch failed.");
    this.name = "CmaHttpDriverDispatchError";
  }
}

class CmaHttpCapabilityGapError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(`CMA capability is not supported in v0: ${feature}.`);
    this.name = "CmaHttpCapabilityGapError";
    this.feature = feature;
  }
}

const createAgentFields = new Set(["id", "metadata", "name"]);
const createEnvironmentFields = new Set(["config", "id", "metadata", "name"]);
const environmentConfigFields = new Set(["networking", "packages", "type"]);
const environmentLimitedNetworkingFields = new Set([
  "allow_mcp_servers",
  "allow_package_managers",
  "allowed_hosts",
  "type",
]);
const environmentPackageManagers = new Set<CmaEnvironmentPackageManager>([
  "apt",
  "cargo",
  "gem",
  "go",
  "npm",
  "pip",
]);
const environmentUnrestrictedNetworkingFields = new Set(["type"]);
const createSessionFields = new Set(["agentId", "environmentId", "id", "metadata"]);

function createJsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    status,
  });
}

function createDataResponse(data: unknown, status = 200): Response {
  return createJsonResponse({ data }, status);
}

function createErrorResponse(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return createJsonResponse(
    {
      error: {
        code,
        message,
        ...details,
      },
    },
    status,
  );
}

function createMethodNotAllowedResponse(methods: readonly HttpMethod[]): Response {
  return createErrorResponse(405, "CMA_METHOD_NOT_ALLOWED", "Method is not allowed.", {
    allow: methods,
  });
}

function createNotFoundResponse(): Response {
  return createErrorResponse(404, "CMA_ROUTE_NOT_FOUND", "Route was not found.");
}

function createBetaHeaderResponse(
  request: Request,
  requirement: CmaHttpBetaHeaderRequirement | false | undefined,
): Response | null {
  if (requirement === false) {
    return null;
  }

  const name = requirement?.name ?? CMA_DEFAULT_BETA_HEADER_NAME;
  const expectedValue = requirement?.value ?? CMA_DEFAULT_BETA_HEADER_VALUE;
  const actualValue = request.headers.get(name);

  if (!actualValue) {
    return createErrorResponse(
      400,
      "CMA_BETA_HEADER_REQUIRED",
      `CMA requires the ${name} header.`,
      {
        header: name,
      },
    );
  }

  const values = actualValue.split(",").map((value) => value.trim());

  if (!values.includes(expectedValue)) {
    return createErrorResponse(
      400,
      "CMA_UNSUPPORTED_BETA_HEADER",
      `CMA requires beta header ${expectedValue}.`,
      {
        expected: expectedValue,
        header: name,
      },
    );
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new CmaHttpRequestError(400, "CMA_INVALID_REQUEST", "Request body must be an object.");
  }

  return input;
}

function assertSupportedFields(
  input: Record<string, unknown>,
  supportedFields: ReadonlySet<string>,
  prefix = "",
): void {
  for (const field of Object.keys(input)) {
    if (!supportedFields.has(field)) {
      throw new CmaUnsupportedFieldError(`${prefix}${field}`);
    }
  }
}

function readString(input: Record<string, unknown>, field: string): string {
  const value = input[field];

  if (typeof value !== "string" || value.length === 0) {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_FIELD",
      `CMA field ${field} must be a non-empty string.`,
    );
  }

  return value;
}

function readBoolean(input: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = input[field];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_FIELD",
      `CMA field ${field} must be a boolean.`,
    );
  }

  return value;
}

function readOptionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_FIELD",
      `CMA field ${field} must be a non-empty string.`,
    );
  }

  return value;
}

function readOptionalStringArray(
  input: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const value = input[field];

  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_FIELD",
      `CMA field ${field} must be a non-empty string array.`,
    );
  }

  return [...value];
}

function readOptionalRecord(
  input: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = input[field];

  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_FIELD",
      `CMA field ${field} must be an object.`,
    );
  }

  return { ...value };
}

function readRequiredRecord(
  input: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = input[field];

  if (!isRecord(value)) {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_FIELD",
      `CMA field ${field} must be an object.`,
    );
  }

  return value;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");

  if (contentLength !== null && Number(contentLength) > CMA_MAX_EVENT_BYTES) {
    throw new CmaHttpRequestError(
      413,
      "CMA_REQUEST_BODY_TOO_LARGE",
      `Request body exceeds ${CMA_MAX_EVENT_BYTES} UTF-8 bytes.`,
    );
  }

  const reader = request.body?.getReader();

  if (!reader) {
    throw new CmaHttpRequestError(400, "CMA_INVALID_JSON", "Request body must be valid JSON.");
  }

  let body = new Uint8Array(0);
  let size = 0;

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      const nextSize = size + chunk.value.byteLength;

      if (nextSize > CMA_MAX_EVENT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CmaHttpRequestError(
          413,
          "CMA_REQUEST_BODY_TOO_LARGE",
          `Request body exceeds ${CMA_MAX_EVENT_BYTES} UTF-8 bytes.`,
        );
      }

      if (nextSize > body.byteLength) {
        const grown = new Uint8Array(
          Math.min(CMA_MAX_EVENT_BYTES, Math.max(nextSize, body.byteLength * 2, 1_024)),
        );
        grown.set(body);
        body = grown;
      }

      body.set(chunk.value, size);
      size = nextSize;
    }
  } catch (error) {
    if (error instanceof CmaHttpRequestError) {
      throw error;
    }

    throw new CmaHttpRequestError(400, "CMA_INVALID_JSON", "Request body must be valid JSON.");
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(new TextDecoder().decode(body.subarray(0, size))) as unknown;
  } catch {
    throw new CmaHttpRequestError(400, "CMA_INVALID_JSON", "Request body must be valid JSON.");
  }
}

function normalizeHttpsHosts(hosts: readonly string[], field: string): string[] {
  return hosts.map((host) => {
    let url: URL;

    try {
      url = new URL(host);
    } catch {
      throw new CmaHttpRequestError(
        400,
        "CMA_INVALID_FIELD",
        `CMA field ${field} entries must be HTTPS origins.`,
      );
    }

    if (
      url.protocol !== "https:" ||
      url.hostname.length === 0 ||
      url.hostname.includes("*") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new CmaHttpRequestError(
        400,
        "CMA_INVALID_FIELD",
        `CMA field ${field} entries must be HTTPS origins.`,
      );
    }

    return url.origin;
  });
}

function readEnvironmentPackages(input: Record<string, unknown>): CmaEnvironmentPackages {
  assertSupportedFields(input, environmentPackageManagers, "config.packages.");
  const packages: Partial<Record<CmaEnvironmentPackageManager, readonly string[]>> = {};

  for (const manager of environmentPackageManagers) {
    const value = readOptionalStringArray(input, manager);

    if (value !== undefined) {
      packages[manager] = value;
    }
  }

  return packages;
}

function readEnvironmentNetworking(input: unknown): CmaEnvironmentNetworking {
  if (input === undefined) {
    return {
      type: "unrestricted",
    };
  }

  const networking = assertObject(input);
  const type = readString(networking, "type");

  if (type === "unrestricted") {
    assertSupportedFields(
      networking,
      environmentUnrestrictedNetworkingFields,
      "config.networking.",
    );

    return {
      type,
    };
  }

  if (type === "limited") {
    assertSupportedFields(networking, environmentLimitedNetworkingFields, "config.networking.");
    const allowedHosts = normalizeHttpsHosts(
      readOptionalStringArray(networking, "allowed_hosts") ?? [],
      "config.networking.allowed_hosts",
    );

    return {
      allow_mcp_servers: readBoolean(networking, "allow_mcp_servers", false),
      allow_package_managers: readBoolean(networking, "allow_package_managers", false),
      allowed_hosts: allowedHosts,
      type,
    } satisfies CmaEnvironmentLimitedNetworking;
  }

  throw new CmaHttpCapabilityGapError(`environment.networking.${type}`);
}

function readEnvironmentConfig(input: unknown): CmaEnvironmentConfig {
  if (input === undefined) {
    return {
      networking: {
        type: "unrestricted",
      },
      packages: {},
      type: "cloud",
    };
  }

  const config = assertObject(input);
  assertSupportedFields(config, environmentConfigFields, "config.");
  const type = readString(config, "type");

  if (type !== "cloud") {
    throw new CmaHttpCapabilityGapError(`environment.config.${type}`);
  }

  const packages =
    config["packages"] === undefined
      ? {}
      : readEnvironmentPackages(readRequiredRecord(config, "packages"));

  return {
    networking: readEnvironmentNetworking(config["networking"]),
    packages,
    type,
  };
}

function readCreateAgentInput(input: unknown): CmaCreateAgentInput {
  const body = assertObject(input);
  assertSupportedFields(body, createAgentFields);
  const id = readOptionalString(body, "id");
  const metadata = readOptionalRecord(body, "metadata");

  return {
    ...(id === undefined ? {} : { id }),
    ...(metadata === undefined ? {} : { metadata }),
    name: readString(body, "name"),
  };
}

function readCreateEnvironmentInput(input: unknown): CmaCreateEnvironmentInput {
  const body = assertObject(input);
  assertSupportedFields(body, createEnvironmentFields);
  const id = readOptionalString(body, "id");
  const metadata = readOptionalRecord(body, "metadata");

  return {
    config: readEnvironmentConfig(body["config"]),
    ...(id === undefined ? {} : { id }),
    ...(metadata === undefined ? {} : { metadata }),
    name: readString(body, "name"),
  };
}

function readCreateSessionInput(input: unknown): CmaCreateSessionInput {
  const body = assertObject(input);
  assertSupportedFields(body, createSessionFields);
  const agentId = readOptionalString(body, "agentId");
  const environmentId = readOptionalString(body, "environmentId");
  const id = readOptionalString(body, "id");
  const metadata = readOptionalRecord(body, "metadata");

  return {
    ...(agentId === undefined ? {} : { agentId }),
    ...(environmentId === undefined ? {} : { environmentId }),
    ...(id === undefined ? {} : { id }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function keepClaimAlive(
  store: CmaStore,
  sessionId: string,
  commandId: string,
  initialLease: CmaInboundEventLease,
): { readonly signal: AbortSignal; stop(): void } {
  const stopped = new AbortController();
  const failed = new AbortController();

  void (async () => {
    let lease = initialLease;

    while (!stopped.signal.aborted) {
      await sleepPromise(
        Math.max(1_000, Date.parse(lease.renewAfter) - Date.now()),
        stopped.signal,
      );
      lease = await store.renewInboundEventClaim({
        commandId,
        leaseId: lease.id,
        sessionId,
      });
    }
  })().catch((error: unknown) => {
    if (!stopped.signal.aborted) {
      failed.abort(error);
    }
  });

  return {
    signal: failed.signal,
    stop: () => stopped.abort(),
  };
}

function readPathSegments(request: Request): readonly string[] {
  try {
    return new URL(request.url).pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_PATH",
      "Request path must use valid percent encoding.",
    );
  }
}

async function handleAgents(
  request: Request,
  segments: readonly string[],
  store: CmaStore,
): Promise<Response> {
  if (segments.length === 2) {
    if (request.method === "GET") {
      return createDataResponse(await store.listAgents());
    }

    if (request.method === "POST") {
      return createDataResponse(
        await store.createAgent(readCreateAgentInput(await readJsonBody(request))),
        201,
      );
    }

    return createMethodNotAllowedResponse(["GET", "POST"]);
  }

  if (segments.length === 3) {
    const agentId = segments[2];

    if (agentId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "GET") {
      const agent = await store.getAgent(agentId);
      return agent
        ? createDataResponse(agent)
        : createErrorResponse(404, "CMA_AGENT_NOT_FOUND", "Agent was not found.");
    }

    return createMethodNotAllowedResponse(["GET"]);
  }

  return createNotFoundResponse();
}

async function handleEnvironments(
  request: Request,
  segments: readonly string[],
  store: CmaStore,
): Promise<Response> {
  if (segments.length === 2) {
    if (request.method === "GET") {
      return createDataResponse(await store.listEnvironments());
    }

    if (request.method === "POST") {
      return createDataResponse(
        await store.createEnvironment(readCreateEnvironmentInput(await readJsonBody(request))),
        201,
      );
    }

    return createMethodNotAllowedResponse(["GET", "POST"]);
  }

  if (segments.length === 3) {
    const environmentId = segments[2];

    if (environmentId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "GET") {
      const environment = await store.getEnvironment(environmentId);
      return environment
        ? createDataResponse(environment)
        : createErrorResponse(404, "CMA_ENVIRONMENT_NOT_FOUND", "Environment was not found.");
    }

    if (request.method === "DELETE") {
      const deleted = await store.deleteEnvironment(environmentId);
      return deleted
        ? new Response(null, { status: 204 })
        : createErrorResponse(404, "CMA_ENVIRONMENT_NOT_FOUND", "Environment was not found.");
    }

    return createMethodNotAllowedResponse(["DELETE", "GET"]);
  }

  if (segments.length === 4 && segments[3] === "archive") {
    const environmentId = segments[2];

    if (environmentId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "POST") {
      return createDataResponse(await store.archiveEnvironment(environmentId));
    }

    return createMethodNotAllowedResponse(["POST"]);
  }

  return createNotFoundResponse();
}

async function handleGetSessionEvents(
  request: Request,
  sessionId: string,
  store: CmaStore,
): Promise<Response> {
  const session = await store.getSession(sessionId);

  if (!session) {
    return createErrorResponse(404, "CMA_SESSION_NOT_FOUND", "Session was not found.");
  }

  if (request.headers.get("accept")?.includes("text/event-stream") === true) {
    const afterCursor = request.headers.get("last-event-id")?.trim();

    if (afterCursor !== undefined && afterCursor.length > 0 && !isDriverId(afterCursor)) {
      throw new CmaHttpRequestError(
        400,
        "CMA_INVALID_LAST_EVENT_ID",
        "Last-Event-ID must be a ULID.",
      );
    }

    return createSseResponse(
      store.streamSessionEvents(
        sessionId,
        afterCursor === undefined || afterCursor.length === 0 ? undefined : afterCursor,
      ),
    );
  }

  return createDataResponse(await store.listSessionEvents(sessionId));
}

async function handlePostSessionEvent(
  request: Request,
  sessionId: string,
  store: CmaStore,
  dispatchDriverCommand: CmaHttpDriverCommandDispatcher,
): Promise<Response> {
  const session = await store.getSession(sessionId);

  if (!session) {
    return createErrorResponse(404, "CMA_SESSION_NOT_FOUND", "Session was not found.");
  }

  const body = await readJsonBody(request);
  const event = parseCmaInboundEvent(body);
  const command = projectCmaInboundToDriverCommand(event);
  const claim = await store.claimInboundEvent({
    command,
    event,
    sessionId,
  });

  if (!claim.claimed) {
    if (claim.event.commandStatus === "failed") {
      throw new CmaHttpDriverDispatchError();
    }

    return createDataResponse(
      {
        command,
        event: claim.event,
        result: claim.event.commandResult,
        status: "accepted",
      },
      202,
    );
  }

  const keeper = keepClaimAlive(store, sessionId, command.commandId, claim.lease);
  const signal = AbortSignal.any([request.signal, keeper.signal]);

  try {
    let commandResult: RuntimeCommandResult | null;

    try {
      signal.throwIfAborted();
      commandResult = (await dispatchDriverCommand({ command, event, session, signal })) ?? null;
      signal.throwIfAborted();
    } catch {
      if (!keeper.signal.aborted) {
        await store
          .settleInboundEvent({
            commandId: command.commandId,
            commandResult: null,
            leaseId: claim.lease.id,
            sessionId,
            status: "failed",
          })
          .catch(() => undefined);
      }
      throw new CmaHttpDriverDispatchError();
    }

    const record = await store.settleInboundEvent({
      commandId: command.commandId,
      commandResult,
      leaseId: claim.lease.id,
      sessionId,
      status: "completed",
    });

    return createDataResponse(
      {
        command,
        event: record,
        result: commandResult,
        status: "accepted",
      },
      202,
    );
  } finally {
    keeper.stop();
  }
}

async function handleSessions(
  request: Request,
  segments: readonly string[],
  options: CmaHttpHandlerOptions,
): Promise<Response> {
  if (segments.length === 2) {
    if (request.method === "POST") {
      return createDataResponse(
        await options.store.createSession(readCreateSessionInput(await readJsonBody(request))),
        201,
      );
    }

    return createMethodNotAllowedResponse(["POST"]);
  }

  if (segments.length === 3) {
    const sessionId = segments[2];

    if (sessionId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "GET") {
      const session = await options.store.getSession(sessionId);
      return session
        ? createDataResponse(session)
        : createErrorResponse(404, "CMA_SESSION_NOT_FOUND", "Session was not found.");
    }

    return createMethodNotAllowedResponse(["GET"]);
  }

  if (segments.length === 4 && segments[3] === "events") {
    const sessionId = segments[2];

    if (sessionId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "GET") {
      return handleGetSessionEvents(request, sessionId, options.store);
    }

    if (request.method === "POST") {
      return handlePostSessionEvent(
        request,
        sessionId,
        options.store,
        options.dispatchDriverCommand,
      );
    }

    return createMethodNotAllowedResponse(["GET", "POST"]);
  }

  return createNotFoundResponse();
}

function createSseResponse(events: AsyncIterable<CmaSessionEventRecord>): Response {
  let cleanupPromise: Promise<void> | undefined;
  let iterator: AsyncIterator<CmaSessionEventRecord> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      await iterator?.return?.();
    })());

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          iterator ??= events[Symbol.asyncIterator]();
          const result = await iterator.next();

          if (result.done) {
            await cleanup();
            controller.close();
            return;
          }

          controller.enqueue(encodeCmaSseRecord(result.value));
        } catch (error) {
          await cleanup().catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel() {
        await cleanup();
      },
    },
    { highWaterMark: 0 },
  );

  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    },
    status: 200,
  });
}

function createThrownErrorResponse(error: unknown): Response {
  if (error instanceof CmaInvalidEventError) {
    return createErrorResponse(400, "CMA_INVALID_EVENT", error.message);
  }

  if (error instanceof CmaUnsupportedFieldError) {
    return createErrorResponse(400, "CMA_UNSUPPORTED_FIELD", error.message, {
      field: error.field,
    });
  }

  if (error instanceof CmaHttpRequestError) {
    return createErrorResponse(error.status, error.code, error.message);
  }

  if (error instanceof CmaStoreConflictError) {
    return createErrorResponse(409, "CMA_RESOURCE_CONFLICT", error.message, {
      id: error.id,
      resource: error.resource,
    });
  }

  if (error instanceof CmaStoreNotFoundError) {
    return createErrorResponse(404, "CMA_RESOURCE_NOT_FOUND", error.message, {
      id: error.id,
      resource: error.resource,
    });
  }

  if (error instanceof CmaSessionTerminatedError) {
    return createErrorResponse(409, "CMA_SESSION_TERMINATED", error.message, {
      id: error.id,
    });
  }

  if (error instanceof CmaHttpDriverDispatchError) {
    return createErrorResponse(
      502,
      "CMA_DRIVER_COMMAND_DISPATCH_FAILED",
      "Driver command dispatch failed.",
    );
  }

  if (error instanceof CmaHttpCapabilityGapError) {
    return createErrorResponse(422, "CMA_CAPABILITY_GAP", error.message, {
      feature: error.feature,
    });
  }

  if (error instanceof RangeError) {
    return createErrorResponse(413, "CMA_RESOURCE_LIMIT", error.message);
  }

  return createErrorResponse(500, "CMA_INTERNAL_ERROR", "Internal server error.");
}

export function createCmaHttpHandler(options: CmaHttpHandlerOptions): CmaHttpHandler {
  return async (request) => {
    try {
      const segments = readPathSegments(request);

      if (segments[0] !== "v1") {
        return createNotFoundResponse();
      }

      const betaHeaderResponse = createBetaHeaderResponse(request, options.betaHeader);

      if (betaHeaderResponse) {
        return betaHeaderResponse;
      }

      const authorizationResponse = await options.authorize?.({ request, segments });

      if (authorizationResponse) {
        return authorizationResponse;
      }

      switch (segments[1]) {
        case "agents":
          return await handleAgents(request, segments, options.store);
        case "environments":
          return await handleEnvironments(request, segments, options.store);
        case "sessions":
          return await handleSessions(request, segments, options);
        default:
          return createNotFoundResponse();
      }
    } catch (error) {
      return createThrownErrorResponse(error);
    }
  };
}
