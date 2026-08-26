declare const DriverIdBrand: unique symbol;
declare const SemanticDriverIdBrand: unique symbol;

export type DriverId = string & { readonly [DriverIdBrand]: "DriverId" };
export type SemanticDriverId<Name extends string> = DriverId & {
  readonly [SemanticDriverIdBrand]: Name;
};

export type DriverInstanceId = SemanticDriverId<"DriverInstanceId">;
export type EventId = SemanticDriverId<"EventId">;
export type SessionId = SemanticDriverId<"SessionId">;
export type MessageId = SemanticDriverId<"MessageId">;
export type RunId = SemanticDriverId<"RunId">;

export const DRIVER_ID_PATTERN = "^[0-9A-HJKMNP-TV-Z]{26}$";
export const DRIVER_ID_INPUT_PATTERN = "^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$";

const canonicalDriverIdPattern = new RegExp(DRIVER_ID_PATTERN, "u");
const inputDriverIdPattern = new RegExp(DRIVER_ID_INPUT_PATTERN, "u");
const driverIdAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const driverIdRandomLength = 16;
const driverIdTimeLength = 10;
const maxDriverIdTimeMs = 2 ** 48 - 1;

let lastDriverIdTimeMs = -1;
let lastDriverIdRandom: string | undefined;

interface DriverIdCrypto {
  getRandomValues(bytes: Uint8Array): Uint8Array;
}

export function isDriverId(value: unknown): value is DriverId {
  return typeof value === "string" && canonicalDriverIdPattern.test(value);
}

function brandDriverId(value: string): DriverId {
  return value as DriverId;
}

function formatDriverIdLabel(label: string | undefined): string {
  const normalized = label?.trim();
  return normalized && normalized.length > 0 ? normalized : "Driver ID";
}

export function normalizeDriverId(value: string, label?: string): DriverId {
  if (!inputDriverIdPattern.test(value)) {
    throw new TypeError(`${formatDriverIdLabel(label)} must be a valid ULID.`);
  }

  return brandDriverId(value.toUpperCase());
}

export function parseDriverId(value: unknown, label?: string): DriverId {
  if (typeof value !== "string") {
    throw new TypeError(`${formatDriverIdLabel(label)} must be a ULID string.`);
  }

  return normalizeDriverId(value, label);
}

export function parseRunId(value: unknown): RunId {
  return parseDriverId(value, "Run ID") as RunId;
}

function readRandomByte(): number {
  const crypto = (globalThis as typeof globalThis & { readonly crypto?: DriverIdCrypto }).crypto;

  if (crypto === undefined) {
    throw new TypeError("Driver ID generation requires globalThis.crypto.");
  }

  const bytes = new Uint8Array(1);
  crypto.getRandomValues(bytes);

  const byte = bytes[0];
  if (byte === undefined) {
    throw new TypeError("Driver ID generation failed to read random bytes.");
  }

  return byte;
}

function assertDriverIdTimeMs(timeMs: number): number {
  if (!Number.isFinite(timeMs) || !Number.isSafeInteger(timeMs)) {
    throw new TypeError("Driver ID timeMs must be a finite safe integer.");
  }

  if (timeMs < 0 || timeMs > maxDriverIdTimeMs) {
    throw new RangeError(
      `Driver ID timeMs must be within the ULID timestamp range 0..${maxDriverIdTimeMs}.`,
    );
  }

  return timeMs;
}

function encodeDriverIdTime(timeMs: number): string {
  let value = assertDriverIdTimeMs(timeMs);
  let encoded = "";

  for (let index = 0; index < driverIdTimeLength; index += 1) {
    encoded = driverIdAlphabet[value % driverIdAlphabet.length] + encoded;
    value = Math.floor(value / driverIdAlphabet.length);
  }

  return encoded;
}

function createDriverIdRandom(): string {
  let value = "";

  for (let index = 0; index < driverIdRandomLength; index += 1) {
    const character = driverIdAlphabet[readRandomByte() % driverIdAlphabet.length];

    if (character === undefined) {
      throw new TypeError("Driver ID generation failed to encode random bytes.");
    }

    value += character;
  }

  return value;
}

function incrementCrockfordBase32(value: string): string {
  const chars = value.split("");

  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const character = chars[index];
    const alphabetIndex = character === undefined ? -1 : driverIdAlphabet.indexOf(character);

    if (alphabetIndex < 0) {
      throw new TypeError("Driver ID monotonic random state is malformed.");
    }

    if (alphabetIndex < driverIdAlphabet.length - 1) {
      chars[index] = driverIdAlphabet[alphabetIndex + 1] ?? "0";
      return chars.join("");
    }

    chars[index] = "0";
  }

  return chars.join("");
}

export function createDriverId(): DriverId {
  const requestedTimeMs = assertDriverIdTimeMs(Date.now());

  if (requestedTimeMs <= lastDriverIdTimeMs && lastDriverIdRandom !== undefined) {
    lastDriverIdRandom = incrementCrockfordBase32(lastDriverIdRandom);
    return brandDriverId(`${encodeDriverIdTime(lastDriverIdTimeMs)}${lastDriverIdRandom}`);
  }

  lastDriverIdTimeMs = requestedTimeMs;
  lastDriverIdRandom = createDriverIdRandom();

  return brandDriverId(`${encodeDriverIdTime(requestedTimeMs)}${lastDriverIdRandom}`);
}
