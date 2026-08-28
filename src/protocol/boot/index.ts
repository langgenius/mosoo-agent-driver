import { z } from "zod";

import type { DriverInstanceId } from "../id";
import type { JsonObject } from "../json";
import { readJsonObject } from "../json";
import type { DriverNativeRuntimeRef } from "../runtime";
import {
  isSupportedDriverRuntime,
  isSupportedDriverRuntimeTransport,
  parseDriverNativeRuntimeRef,
  SUPPORTED_DRIVER_NATIVE_RUNTIME_REF_KINDS,
  SUPPORTED_DRIVER_RUNTIMES,
  SUPPORTED_DRIVER_RUNTIME_TRANSPORTS,
} from "../runtime";
import type { CredentialId, McpServerId, SandboxId, SkillId, SkillSnapshotId } from "./host-ids";
import {
  createDriverIdSchema,
  driverConfigRevisionSchema,
  driverExecutionSessionContextSchema,
  ownArraySchema,
  ownObjectSchema,
} from "./host-snapshot";

export type {
  AccountId,
  AgentDeploymentVersionId,
  AgentId,
  CredentialId,
  EnvironmentId,
  EnvironmentRevisionId,
  McpServerId,
  SandboxId,
  SandboxSessionId,
  SkillId,
  SkillSnapshotId,
} from "./host-ids";
export type {
  DriverConfigRevision,
  DriverExecutionSessionContext,
  DriverOrigin,
} from "./host-snapshot";

/**
 * Version 2 requires the durable external-tool-effect RPCs. Refusing an older
 * Driver is safer than letting it invoke an MCP tool without the persistence
 * fence during a rolling deployment.
 */
export const DRIVER_PROTOCOL_VERSION = 2;
export const DRIVER_CONTROL_PORT_MIN = 20_000;
export const DRIVER_CONTROL_PORT_MAX = 59_999;
export const DRIVER_BOOT_PAYLOAD_ENV_NAME = "MOSOO_DRIVER_BOOT_PAYLOAD";
export const DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME = "MOSOO_DRIVER_BOOT_PAYLOAD_FILE";

export {
  isSupportedDriverRuntime,
  isSupportedDriverRuntimeTransport,
  SUPPORTED_DRIVER_NATIVE_RUNTIME_REF_KINDS,
  SUPPORTED_DRIVER_RUNTIMES,
  SUPPORTED_DRIVER_RUNTIME_TRANSPORTS,
};
export type {
  DriverNativeRuntimeRef,
  DriverNativeRuntimeRefKind,
  DriverRuntime,
  DriverRuntimeTransport,
} from "../runtime";

const nonEmptyStringSchema = z.string().min(1);
const nullableOptionalStringSchema = z.string().nullable().optional();
const resolutionModeSchema = z.enum(["auto", "explicit", "tombstone"]);
const runtimeTransportByRuntime = {
  "acp-fallback": "acp-fallback",
  "claude-agent-sdk": "claude-agent-sdk",
  "openai-runtime": "openai-app-server",
} as const;
const controlUrlSchema = z
  .url()
  .refine((value) => /^(?:https?|wss?):/iu.test(value), "must use http, https, ws, or wss");

function omitUndefinedProperties<Value extends Record<string, unknown>>(value: Value): Value {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Value;
}

const absolutePathSchema = nonEmptyStringSchema.refine(
  (path) => path.startsWith("/") && !path.includes("\0") && !path.includes(":"),
  "must be an absolute path without null bytes or path delimiters",
);

const environmentEntrySchema = z.tuple([
  z
    .string()
    .refine(
      (name) => name.length > 0 && !name.includes("=") && !name.includes("\0"),
      "must be a valid environment entry",
    ),
  z.string().refine((value) => !value.includes("\0"), "must be a valid environment entry"),
]);

const environmentVariablesSchema = z
  .unknown()
  .refine(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
    "must be an object",
  )
  .transform((value) => Object.entries(value as Record<string, unknown>))
  .pipe(z.array(environmentEntrySchema))
  .transform((entries) => Object.fromEntries(entries));

const jsonObjectSchema = z.unknown().transform((value, context): JsonObject => {
  try {
    return readJsonObject(value, "execution.providerOptions");
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "must be a JSON object",
    });
    return z.NEVER;
  }
});

const driverExecutionEnvironmentSchema = ownObjectSchema({
  paths: ownObjectSchema({
    executable: ownArraySchema(absolutePathSchema),
    node: ownArraySchema(absolutePathSchema),
    python: ownArraySchema(absolutePathSchema),
  }).optional(),
  variables: environmentVariablesSchema,
}).transform(omitUndefinedProperties);

export type DriverExecutionEnvironment = z.infer<typeof driverExecutionEnvironmentSchema>;

const driverBuiltInToolNameSchema = z.enum([
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
  "web_fetch",
  "web_search",
  "write",
]);

export type DriverBuiltInToolName = z.infer<typeof driverBuiltInToolNameSchema>;

const driverBuiltInToolConfigSchema = ownObjectSchema({
  enabled: z.boolean(),
  name: driverBuiltInToolNameSchema,
});

export type DriverBuiltInToolConfig = z.infer<typeof driverBuiltInToolConfigSchema>;

const driverSkillCatalogFrontmatterSummarySchema = ownObjectSchema({
  author: nullableOptionalStringSchema.transform((value) => value ?? null),
  description: nullableOptionalStringSchema.transform((value) => value ?? null),
  version: nullableOptionalStringSchema.transform((value) => value ?? null),
});

export type DriverSkillCatalogFrontmatterSummary = z.infer<
  typeof driverSkillCatalogFrontmatterSummarySchema
>;

const driverSkillCatalogEntrySchema = ownObjectSchema({
  frontmatter: driverSkillCatalogFrontmatterSummarySchema,
  mountPath: nonEmptyStringSchema,
  resolutionMode: resolutionModeSchema,
  skillId: createDriverIdSchema<SkillId>(),
  skillName: nonEmptyStringSchema,
});

export type DriverSkillCatalogEntry = z.infer<typeof driverSkillCatalogEntrySchema>;

const driverResolvedSkillSchema = ownObjectSchema({
  archiveFormat: z.literal("zip"),
  blobSha256: nonEmptyStringSchema,
  compression: z.literal("deflate"),
  downloadUrl: nonEmptyStringSchema,
  materializationStatus: z.enum(["failed", "pending", "ready", "skipped"]),
  mountPath: nonEmptyStringSchema,
  resolutionMode: resolutionModeSchema,
  skillId: createDriverIdSchema<SkillId>(),
  skillName: nonEmptyStringSchema,
  snapshotId: createDriverIdSchema<SkillSnapshotId>().nullable().optional(),
  warningCode: nullableOptionalStringSchema,
}).transform(omitUndefinedProperties);

export type DriverResolvedSkill = z.infer<typeof driverResolvedSkillSchema>;

const bootMcpServerCommonShape = {
  authType: nonEmptyStringSchema,
  credentialScope: nonEmptyStringSchema,
  credentialStatus: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  serverId: createDriverIdSchema<McpServerId>(),
  subjectLabel: nullableOptionalStringSchema,
};

const authorizedDriverBootMcpServerSchema = ownObjectSchema({
  ...bootMcpServerCommonShape,
  authorizationState: z.literal("active"),
  credentialId: createDriverIdSchema<CredentialId>(),
  proxyGrantId: nonEmptyStringSchema,
  proxyUrl: nonEmptyStringSchema,
});

export type AuthorizedDriverBootMcpServer = z.infer<typeof authorizedDriverBootMcpServerSchema>;

const unavailableDriverBootMcpServerSchema = ownObjectSchema({
  ...bootMcpServerCommonShape,
  authorizationState: z.enum(["authorization_required", "disabled", "expired", "revoked"]),
});

export type UnavailableDriverBootMcpServer = z.infer<typeof unavailableDriverBootMcpServerSchema>;

const driverBootMcpServerSchema = z
  .union([authorizedDriverBootMcpServerSchema, unavailableDriverBootMcpServerSchema])
  .transform(omitUndefinedProperties);

export type DriverBootMcpServer = z.infer<typeof driverBootMcpServerSchema>;

const driverRecoveryMessageSchema = ownObjectSchema({
  content: nonEmptyStringSchema,
  role: z.enum(["assistant", "user"]),
});

export type DriverRecoveryMessage = z.infer<typeof driverRecoveryMessageSchema>;

const driverNativeRuntimeRefSchema = z
  .unknown()
  .transform((value, context): DriverNativeRuntimeRef => {
    try {
      return parseDriverNativeRuntimeRef(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "must be a valid native runtime ref",
      });
      return z.NEVER;
    }
  });

const driverExecutionSessionSpecSchema = ownObjectSchema({
  additionalDirectories: ownArraySchema(nonEmptyStringSchema),
  context: driverExecutionSessionContextSchema,
  cwd: nonEmptyStringSchema,
  mcpServers: ownArraySchema(driverBootMcpServerSchema),
  nativeResumeRef: driverNativeRuntimeRefSchema.nullable(),
  recoveryMessages: ownArraySchema(driverRecoveryMessageSchema).default([]),
});

export type DriverExecutionSessionSpec = z.infer<typeof driverExecutionSessionSpecSchema>;

/**
 * How the driver mediates tool-permission requests.
 *
 * - `full_access` (default): the sandbox is the isolation boundary, so
 *   provider permission gates are auto-approved without a control-plane
 *   round-trip.
 * - `supervised`: permission requests surfaced by the provider are routed to
 *   the control plane for an interactive allow/deny decision. Providers may
 *   still auto-approve actions they classify as trusted or read-only.
 */
const driverPermissionPolicySchema = z
  .enum(["full_access", "supervised"])
  .nullish()
  .transform((value) => value ?? "full_access");

export type DriverPermissionPolicy = z.infer<typeof driverPermissionPolicySchema>;

export const DEFAULT_DRIVER_PERMISSION_POLICY = "full_access" satisfies DriverPermissionPolicy;

const driverExecutionSpecSchema = ownObjectSchema({
  builtInTools: ownArraySchema(driverBuiltInToolConfigSchema),
  configRevision: driverConfigRevisionSchema,
  environment: driverExecutionEnvironmentSchema,
  model: nonEmptyStringSchema,
  permissionPolicy: driverPermissionPolicySchema,
  profilePrompt: z.string(),
  provider: nonEmptyStringSchema,
  providerOptions: jsonObjectSchema.default({}),
  session: driverExecutionSessionSpecSchema,
  skillCatalog: ownArraySchema(driverSkillCatalogEntrySchema),
  skills: ownArraySchema(driverResolvedSkillSchema),
});

export type DriverExecutionSpec = z.infer<typeof driverExecutionSpecSchema>;

const driverBootPayloadSchema = ownObjectSchema({
  bootToken: nonEmptyStringSchema,
  controlUrl: controlUrlSchema,
  driverControlPort: z.number().int().min(DRIVER_CONTROL_PORT_MIN).max(DRIVER_CONTROL_PORT_MAX),
  driverGeneration: z.number().int().nonnegative(),
  driverInstanceId: createDriverIdSchema<DriverInstanceId>(),
  execution: driverExecutionSpecSchema,
  heartbeatIntervalMs: z.number().finite().min(250),
  protocolVersion: z.literal(DRIVER_PROTOCOL_VERSION, {
    error: `protocolVersion must be ${DRIVER_PROTOCOL_VERSION}`,
  }),
  runtime: z.enum(SUPPORTED_DRIVER_RUNTIMES),
  runtimeTransport: z.enum(SUPPORTED_DRIVER_RUNTIME_TRANSPORTS),
  sandboxId: createDriverIdSchema<SandboxId>(),
  traceparent: nonEmptyStringSchema,
}).superRefine((payload, context) => {
  if (payload.sandboxId !== payload.execution.session.context.sandboxId) {
    context.addIssue({
      code: "custom",
      message: "Driver boot payload sandbox IDs must match",
      path: ["sandboxId"],
    });
  }

  if (payload.runtimeTransport !== runtimeTransportByRuntime[payload.runtime]) {
    context.addIssue({
      code: "custom",
      message: `runtime ${payload.runtime} does not match transport ${payload.runtimeTransport}`,
      path: ["runtimeTransport"],
    });
  }

  const nativeResumeRef = payload.execution.session.nativeResumeRef;
  if (nativeResumeRef !== null && nativeResumeRef.runtimeId !== payload.runtime) {
    context.addIssue({
      code: "custom",
      message: `native resume runtime ${nativeResumeRef.runtimeId} does not match runtime ${payload.runtime}`,
      path: ["execution", "session", "nativeResumeRef", "runtimeId"],
    });
  }
});

export type DriverBootPayload = z.infer<typeof driverBootPayloadSchema>;

export function parseDriverBootPayload(value: unknown): DriverBootPayload {
  const result = driverBootPayloadSchema.safeParse(value);

  if (!result.success) {
    throw new TypeError(z.prettifyError(result.error));
  }

  return result.data;
}

export function parseDriverBootPayloadJson(raw: string): DriverBootPayload {
  if (!raw.trim()) {
    throw new Error("Driver boot payload is empty.");
  }

  return parseDriverBootPayload(JSON.parse(raw));
}
