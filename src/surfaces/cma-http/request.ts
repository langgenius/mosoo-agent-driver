import { CmaUnsupportedFieldError } from "../../projections/cma";
import type {
  CmaCreateAgentInput,
  CmaCreateEnvironmentInput,
  CmaCreateSessionInput,
  CmaEnvironmentConfig,
  CmaEnvironmentLimitedNetworking,
  CmaEnvironmentNetworking,
  CmaEnvironmentPackages,
  CmaEnvironmentPackageManager,
} from "../../stores/cma-store";
import { CMA_MAX_EVENT_BYTES } from "../../stores/cma-store";
import {
  CMA_ENVIRONMENT_PACKAGE_MANAGERS,
  createDefaultCmaEnvironmentConfig,
} from "../../stores/cma-environment";
import { CmaHttpCapabilityGapError, CmaHttpRequestError } from "./contract";

const createAgentFields = new Set(["id", "metadata", "name"]);
const createEnvironmentFields = new Set(["config", "id", "metadata", "name"]);
const environmentConfigFields = new Set(["networking", "packages", "type"]);
const environmentLimitedNetworkingFields = new Set([
  "allow_mcp_servers",
  "allow_package_managers",
  "allowed_hosts",
  "type",
]);
const environmentPackageManagers = new Set<CmaEnvironmentPackageManager>(
  CMA_ENVIRONMENT_PACKAGE_MANAGERS,
);
const environmentUnrestrictedNetworkingFields = new Set(["type"]);
const createSessionFields = new Set(["agentId", "environmentId", "id", "metadata"]);

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

export async function readCmaJsonBody(request: Request): Promise<unknown> {
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

    return { type };
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
    return createDefaultCmaEnvironmentConfig();
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

export function readCreateAgentInput(input: unknown): CmaCreateAgentInput {
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

export function readCreateEnvironmentInput(input: unknown): CmaCreateEnvironmentInput {
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

export function readCreateSessionInput(input: unknown): CmaCreateSessionInput {
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

export function readCmaPathSegments(request: Request): readonly string[] {
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
