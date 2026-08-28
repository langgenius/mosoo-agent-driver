export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(
  value: unknown,
  label: string,
  ancestors = new WeakSet<object>(),
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError(`${label} must be JSON-serializable.`);
    }

    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`${label}[${index}] must be JSON-serializable.`);
      }
      assertJsonValue(value[index], `${label}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }

  if (isJsonObject(value)) {
    if (ancestors.has(value)) {
      throw new TypeError(`${label} must be JSON-serializable.`);
    }

    ancestors.add(value);
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${label}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return;
  }

  throw new TypeError(`${label} must be JSON-serializable.`);
}

export function readJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }

  assertJsonValue(value, label);
  return structuredClone(value);
}
