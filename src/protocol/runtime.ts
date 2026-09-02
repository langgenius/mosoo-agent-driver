import { z } from "zod";

export const SUPPORTED_DRIVER_RUNTIMES = [
  "openai-runtime",
  "claude-agent-sdk",
  "acp-fallback",
] as const;

export const SUPPORTED_DRIVER_RUNTIME_TRANSPORTS = [
  "openai-app-server",
  "claude-agent-sdk",
  "acp-fallback",
] as const;

export const SUPPORTED_DRIVER_NATIVE_RUNTIME_REF_KINDS = [
  "openai_thread_id",
  "claude_session_id",
  "acp_session_id",
] as const;

export type DriverRuntime = (typeof SUPPORTED_DRIVER_RUNTIMES)[number];
export type DriverRuntimeTransport = (typeof SUPPORTED_DRIVER_RUNTIME_TRANSPORTS)[number];
export type DriverNativeRuntimeRefKind = (typeof SUPPORTED_DRIVER_NATIVE_RUNTIME_REF_KINDS)[number];

export function isSupportedDriverRuntime(value: string): value is DriverRuntime {
  return (SUPPORTED_DRIVER_RUNTIMES as readonly string[]).includes(value);
}

export function isSupportedDriverRuntimeTransport(value: string): value is DriverRuntimeTransport {
  return (SUPPORTED_DRIVER_RUNTIME_TRANSPORTS as readonly string[]).includes(value);
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
  }
}

const nativeRuntimeRefKeys = ["kind", "runtimeId", "value"] as const;
const driverNativeRuntimeRefSchema = z.preprocess(
  (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value;
    }

    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      nativeRuntimeRefKeys
        .filter((key) => Object.hasOwn(record, key))
        .map((key) => [key, record[key]]),
    );
  },
  z
    .object({
      kind: z.enum(SUPPORTED_DRIVER_NATIVE_RUNTIME_REF_KINDS),
      runtimeId: z.enum(SUPPORTED_DRIVER_RUNTIMES),
      value: z.string().min(1),
    })
    .superRefine((reference, context) => {
      if (reference.kind !== getExpectedDriverNativeRuntimeRefKind(reference.runtimeId)) {
        context.addIssue({
          code: "custom",
          message: `kind ${reference.kind} does not match runtime ${reference.runtimeId}`,
          path: ["kind"],
        });
      }
    }),
);

export type DriverNativeRuntimeRef = Readonly<z.infer<typeof driverNativeRuntimeRefSchema>>;

export function parseDriverNativeRuntimeRef(value: unknown): DriverNativeRuntimeRef {
  try {
    const result = driverNativeRuntimeRefSchema.safeParse(value);

    if (!result.success) {
      throw new TypeError(z.prettifyError(result.error));
    }

    return result.data;
  } catch (error) {
    if (error instanceof TypeError) {
      throw error;
    }

    throw new TypeError("Driver native runtime ref could not be read.", { cause: error });
  }
}
