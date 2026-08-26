import { z } from "zod";

import serverNotificationJsonSchema from "./generated-json-schema/ServerNotification.json" with { type: "json" };
import serverRequestJsonSchema from "./generated-json-schema/ServerRequest.json" with { type: "json" };
import { isRecord } from "./app-server-json";
import type { JsonObject } from "./app-server-json";
import type {
  ParsedServerNotification,
  ParsedServerRequest,
  ServerNotificationMethod,
  ServerRequestMethod,
} from "./app-server-protocol-types";
import { validateTurnStatusError } from "./app-server-turn-validation";

interface MethodDispatcher<Method extends string> {
  has(method: string): method is Method;
  parse(method: Method, value: unknown): JsonObject;
}

function expectObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }

  return value;
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new TypeError(`${label} must be an array of strings.`);
  }

  return value;
}

function branchMethod(branch: JsonObject): string {
  const properties = expectObject(branch["properties"], "Method schema properties");
  const method = expectObject(properties["method"], "Method schema discriminator");
  const variants = readStringArray(method["enum"], "Method schema discriminator enum");

  if (variants.length !== 1) {
    throw new TypeError("Method schema discriminator must contain exactly one value.");
  }

  return variants[0]!;
}

function createMethodDispatcher<Method extends string>(value: unknown): MethodDispatcher<Method> {
  const root = expectObject(value, "Root method schema");
  const branches = root["oneOf"];

  if (!Array.isArray(branches)) {
    throw new TypeError("Root method schema oneOf must be an array.");
  }

  const { oneOf: _oneOf, ...shared } = root;
  const sharedProperties = isRecord(shared["properties"]) ? shared["properties"] : {};
  const sharedRequired =
    shared["required"] === undefined
      ? []
      : readStringArray(shared["required"], "Root method schema required");
  const schemas = new Map<string, z.ZodType<JsonObject>>();

  for (const value of branches) {
    const branch = expectObject(value, "Method schema branch");
    const method = branchMethod(branch);
    const properties = expectObject(branch["properties"], `${method} schema properties`);
    const required = readStringArray(branch["required"], `${method} schema required`);
    const schema = z.fromJSONSchema({
      ...shared,
      ...branch,
      properties: { ...sharedProperties, ...properties },
      required: [...new Set([...sharedRequired, ...required])],
    } as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<JsonObject>;

    if (schemas.has(method)) {
      throw new TypeError(`Root method schema contains duplicate method ${method}.`);
    }

    schemas.set(method, schema);
  }

  return {
    has: (method: string): method is Method => schemas.has(method),
    parse: (method, input) => schemas.get(method)!.parse(input),
  };
}

const serverNotificationDispatcher = createMethodDispatcher<ServerNotificationMethod>(
  serverNotificationJsonSchema,
);
const serverRequestDispatcher =
  createMethodDispatcher<ServerRequestMethod>(serverRequestJsonSchema);

export function isServerNotificationMethod(method: string): method is ServerNotificationMethod {
  return serverNotificationDispatcher.has(method);
}

export function isServerRequestMethod(method: string): method is ServerRequestMethod {
  return serverRequestDispatcher.has(method);
}

export function parseServerNotification(value: unknown): ParsedServerNotification | null {
  const envelope = isRecord(value) ? value : null;
  const method = envelope?.["method"];

  if (typeof method !== "string" || !serverNotificationDispatcher.has(method)) {
    return null;
  }

  const parsed = serverNotificationDispatcher.parse(method, value);
  const params = parsed["params"];

  if (!isRecord(params)) {
    throw new TypeError(`${method} params must be an object.`);
  }

  if (method === "turn/completed") {
    const turn = expectObject(params["turn"], "turn/completed turn");
    const message = validateTurnStatusError(turn, true);

    if (message !== null) {
      throw new TypeError(`turn/completed ${message}`);
    }
  }

  const emittedAtMs = parsed["emittedAtMs"];

  return {
    ...(typeof emittedAtMs === "number" ? { emittedAtMs } : {}),
    method,
    params,
  };
}

export function parseServerRequest(value: unknown): ParsedServerRequest | null {
  const envelope = isRecord(value) ? value : null;
  const method = envelope?.["method"];

  if (typeof method !== "string" || !serverRequestDispatcher.has(method)) {
    return null;
  }

  const parsed = serverRequestDispatcher.parse(method, value);
  const id = parsed["id"];
  const params = parsed["params"];

  if ((typeof id !== "number" && typeof id !== "string") || !isRecord(params)) {
    throw new TypeError(`${method} request envelope is invalid.`);
  }

  return { id, method, params };
}
