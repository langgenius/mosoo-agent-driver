import type { DriverInstanceId } from "../id";
import type { JsonObject } from "../json";
import { readJsonObject } from "../json";
import type { DriverNativeRuntimeRef, DriverRuntime, DriverRuntimeTransport } from "../runtime";
import {
  isSupportedDriverRuntime,
  isSupportedDriverRuntimeTransport,
  SUPPORTED_DRIVER_NATIVE_RUNTIME_REF_KINDS,
  SUPPORTED_DRIVER_RUNTIMES,
  SUPPORTED_DRIVER_RUNTIME_TRANSPORTS,
} from "../runtime";
import type { CredentialId, McpServerId, SandboxId, SkillId, SkillSnapshotId } from "./host-ids";
import type { DriverConfigRevision, DriverExecutionSessionContext } from "./host-snapshot";
import { readConfigRevision, readExecutionSessionContext } from "./host-snapshot";
import {
  parseId,
  readArray,
  readInteger,
  readNonEmptyString,
  readNumber,
  readOptionalNullableString,
  readRecord,
  readString,
  readStringArray,
} from "./readers";

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
  SpaceId,
} from "./host-ids";
export type {
  DriverConfigRevision,
  DriverExecutionSessionContext,
  DriverAppAccessSnapshotOutput,
  DriverOrigin,
  DriverSpaceAliasBinding,
} from "./host-snapshot";

export const DRIVER_PROTOCOL_VERSION = 1 as const;
export const DRIVER_CONTROL_PORT_MIN = 20_000 as const;
export const DRIVER_CONTROL_PORT_MAX = 59_999 as const;
export const DRIVER_CONTROL_PORT_COUNT = 40_000 as const;
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

export interface DriverExecutionEnvironment {
  readonly variables: Record<string, string>;
}

export interface DriverSkillCatalogFrontmatterSummary {
  readonly author: string | null;
  readonly description: string | null;
  readonly version: string | null;
}

export interface DriverSkillCatalogEntry {
  readonly frontmatter: DriverSkillCatalogFrontmatterSummary;
  readonly mountPath: string;
  readonly resolutionMode: "auto" | "explicit" | "tombstone";
  readonly skillId: SkillId;
  readonly skillName: string;
}

export interface DriverResolvedSkill {
  readonly archiveFormat: "zip";
  readonly blobSha256: string;
  readonly compression: "deflate";
  readonly downloadUrl: string;
  readonly materializationStatus: "failed" | "pending" | "ready" | "skipped";
  readonly mountPath: string;
  readonly resolutionMode: "auto" | "explicit" | "tombstone";
  readonly skillId: SkillId;
  readonly skillName: string;
  readonly snapshotId?: SkillSnapshotId | null | undefined;
  readonly warningCode?: string | null | undefined;
}

export interface AuthorizedDriverBootMcpServer {
  readonly authType: string;
  readonly authorizationState: "active";
  readonly credentialId: CredentialId;
  readonly credentialScope: string;
  readonly credentialStatus: string;
  readonly name: string;
  readonly proxyGrantId: string;
  readonly proxyUrl: string;
  readonly serverId: McpServerId;
  readonly subjectLabel?: string | null | undefined;
}

export interface UnavailableDriverBootMcpServer {
  readonly authType: string;
  readonly authorizationState: "authorization_required" | "disabled" | "expired" | "revoked";
  readonly credentialScope: string;
  readonly credentialStatus: string;
  readonly name: string;
  readonly serverId: McpServerId;
  readonly subjectLabel?: string | null | undefined;
}

export type DriverBootMcpServer = AuthorizedDriverBootMcpServer | UnavailableDriverBootMcpServer;

export interface DriverExecutionSessionSpec {
  readonly additionalDirectories: string[];
  readonly context: DriverExecutionSessionContext;
  readonly cwd: string;
  readonly mcpServers: DriverBootMcpServer[];
  readonly nativeResumeRef: DriverNativeRuntimeRef | null;
}

export interface DriverExecutionSpec {
  readonly configRevision: DriverConfigRevision;
  readonly environment: DriverExecutionEnvironment;
  readonly model: string;
  readonly profilePrompt: string;
  readonly provider: string;
  readonly providerOptions: JsonObject;
  readonly session: DriverExecutionSessionSpec;
  readonly skillCatalog: DriverSkillCatalogEntry[];
  readonly skills: DriverResolvedSkill[];
}

export interface DriverBootPayload {
  readonly bootToken: string;
  readonly driverControlPort: number;
  readonly driverGeneration: number;
  readonly driverInstanceId: DriverInstanceId;
  readonly execution: DriverExecutionSpec;
  readonly heartbeatIntervalMs: number;
  readonly protocolVersion: typeof DRIVER_PROTOCOL_VERSION;
  readonly runtime: DriverRuntime;
  readonly runtimeTransport: DriverRuntimeTransport;
  readonly sandboxId: SandboxId;
  readonly traceparent: string;
}

function readVariables(value: unknown): Record<string, string> {
  const record = readRecord(value, "execution.environment.variables");
  const variables: Record<string, string> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      throw new TypeError(`execution.environment.variables.${key} must be a string.`);
    }

    variables[key] = entry;
  }

  return variables;
}

function readNativeRuntimeRef(value: unknown): DriverNativeRuntimeRef | null {
  if (value === null) {
    return null;
  }

  const record = readRecord(value, "execution.session.nativeResumeRef");
  const kind = readNonEmptyString(record, "kind", "execution.session.nativeResumeRef");
  const runtimeId = readNonEmptyString(record, "runtimeId", "execution.session.nativeResumeRef");

  if (kind !== "openai_thread_id" && kind !== "claude_session_id" && kind !== "acp_session_id") {
    throw new TypeError("execution.session.nativeResumeRef.kind is unsupported.");
  }

  if (!isSupportedDriverRuntime(runtimeId)) {
    throw new TypeError("execution.session.nativeResumeRef.runtimeId is unsupported.");
  }

  return {
    kind,
    runtimeId,
    value: readNonEmptyString(record, "value", "execution.session.nativeResumeRef"),
  };
}

function readSkillFrontmatter(value: unknown, label: string): DriverSkillCatalogFrontmatterSummary {
  const record = readRecord(value, `${label}.frontmatter`);

  return {
    author: readOptionalNullableString(record, "author", `${label}.frontmatter`) ?? null,
    description: readOptionalNullableString(record, "description", `${label}.frontmatter`) ?? null,
    version: readOptionalNullableString(record, "version", `${label}.frontmatter`) ?? null,
  };
}

function readResolutionMode(value: unknown, label: string): DriverResolvedSkill["resolutionMode"] {
  if (value === "auto" || value === "explicit" || value === "tombstone") {
    return value;
  }

  throw new TypeError(`${label}.resolutionMode is unsupported.`);
}

function readSkillCatalogEntry(value: unknown, index: number): DriverSkillCatalogEntry {
  const label = `execution.skillCatalog[${index}]`;
  const record = readRecord(value, label);

  return {
    frontmatter: readSkillFrontmatter(record["frontmatter"], label),
    mountPath: readNonEmptyString(record, "mountPath", label),
    resolutionMode: readResolutionMode(record["resolutionMode"], label),
    skillId: parseId(record["skillId"], `${label}.skillId`) as SkillId,
    skillName: readNonEmptyString(record, "skillName", label),
  };
}

function readResolvedSkill(value: unknown, index: number): DriverResolvedSkill {
  const label = `execution.skills[${index}]`;
  const record = readRecord(value, label);
  const archiveFormat = readNonEmptyString(record, "archiveFormat", label);
  const compression = readNonEmptyString(record, "compression", label);
  const materializationStatus = readNonEmptyString(record, "materializationStatus", label);
  const snapshotId = readOptionalNullableString(record, "snapshotId", label);
  const warningCode = readOptionalNullableString(record, "warningCode", label);

  if (archiveFormat !== "zip") {
    throw new TypeError(`${label}.archiveFormat must be zip.`);
  }

  if (compression !== "deflate") {
    throw new TypeError(`${label}.compression must be deflate.`);
  }

  if (
    materializationStatus !== "failed" &&
    materializationStatus !== "pending" &&
    materializationStatus !== "ready" &&
    materializationStatus !== "skipped"
  ) {
    throw new TypeError(`${label}.materializationStatus is unsupported.`);
  }

  return {
    archiveFormat,
    blobSha256: readNonEmptyString(record, "blobSha256", label),
    compression,
    downloadUrl: readNonEmptyString(record, "downloadUrl", label),
    materializationStatus,
    mountPath: readNonEmptyString(record, "mountPath", label),
    resolutionMode: readResolutionMode(record["resolutionMode"], label),
    skillId: parseId(record["skillId"], `${label}.skillId`) as SkillId,
    skillName: readNonEmptyString(record, "skillName", label),
    ...(snapshotId === undefined
      ? {}
      : {
          snapshotId:
            snapshotId === null
              ? null
              : (parseId(snapshotId, `${label}.snapshotId`) as SkillSnapshotId),
        }),
    ...(warningCode === undefined ? {} : { warningCode }),
  };
}

function readBootMcpServer(value: unknown, index: number): DriverBootMcpServer {
  const label = `execution.session.mcpServers[${index}]`;
  const record = readRecord(value, label);
  const authorizationState = readNonEmptyString(record, "authorizationState", label);
  const subjectLabel = readOptionalNullableString(record, "subjectLabel", label);
  const common = {
    authType: readNonEmptyString(record, "authType", label),
    credentialScope: readNonEmptyString(record, "credentialScope", label),
    credentialStatus: readNonEmptyString(record, "credentialStatus", label),
    name: readNonEmptyString(record, "name", label),
    serverId: parseId(record["serverId"], `${label}.serverId`) as McpServerId,
    ...(subjectLabel === undefined ? {} : { subjectLabel }),
  };

  if (authorizationState === "active") {
    return {
      ...common,
      authorizationState,
      credentialId: parseId(record["credentialId"], `${label}.credentialId`) as CredentialId,
      proxyGrantId: readNonEmptyString(record, "proxyGrantId", label),
      proxyUrl: readNonEmptyString(record, "proxyUrl", label),
    };
  }

  if (
    authorizationState !== "authorization_required" &&
    authorizationState !== "disabled" &&
    authorizationState !== "expired" &&
    authorizationState !== "revoked"
  ) {
    throw new TypeError(`${label}.authorizationState is unsupported.`);
  }

  return {
    ...common,
    authorizationState,
  };
}

function readExecutionSession(value: unknown): DriverExecutionSessionSpec {
  const record = readRecord(value, "execution.session");

  return {
    additionalDirectories: readStringArray(record, "additionalDirectories", "execution.session"),
    context: readExecutionSessionContext(record["context"]),
    cwd: readNonEmptyString(record, "cwd", "execution.session"),
    mcpServers: readArray(record["mcpServers"], "execution.session.mcpServers").map(
      readBootMcpServer,
    ),
    nativeResumeRef: readNativeRuntimeRef(record["nativeResumeRef"]),
  };
}

function readExecution(value: unknown): DriverExecutionSpec {
  const record = readRecord(value, "execution");
  const environment = readRecord(record["environment"], "execution.environment");

  return {
    configRevision: readConfigRevision(record["configRevision"]),
    environment: {
      variables: readVariables(environment["variables"]),
    },
    model: readNonEmptyString(record, "model", "execution"),
    profilePrompt: readString(record, "profilePrompt", "execution"),
    provider: readNonEmptyString(record, "provider", "execution"),
    providerOptions:
      record["providerOptions"] === undefined
        ? {}
        : readJsonObject(record["providerOptions"], "execution.providerOptions"),
    session: readExecutionSession(record["session"]),
    skillCatalog: readArray(record["skillCatalog"], "execution.skillCatalog").map(
      readSkillCatalogEntry,
    ),
    skills: readArray(record["skills"], "execution.skills").map(readResolvedSkill),
  };
}

export function parseDriverBootPayload(value: unknown): DriverBootPayload {
  const record = readRecord(value, "Driver boot payload");
  const driverControlPort = readInteger(record, "driverControlPort", "Driver boot payload");
  const driverGeneration = readInteger(record, "driverGeneration", "Driver boot payload");
  const heartbeatIntervalMs = readNumber(record, "heartbeatIntervalMs", "Driver boot payload");
  const protocolVersion = readInteger(record, "protocolVersion", "Driver boot payload");
  const runtime = readNonEmptyString(record, "runtime", "Driver boot payload");
  const runtimeTransport = readNonEmptyString(record, "runtimeTransport", "Driver boot payload");

  if (driverControlPort < DRIVER_CONTROL_PORT_MIN || driverControlPort > DRIVER_CONTROL_PORT_MAX) {
    throw new TypeError(
      `Driver boot payload.driverControlPort must be between ${DRIVER_CONTROL_PORT_MIN} and ${DRIVER_CONTROL_PORT_MAX}.`,
    );
  }

  if (driverGeneration < 0) {
    throw new TypeError("Driver boot payload.driverGeneration must be non-negative.");
  }

  if (heartbeatIntervalMs < 250) {
    throw new TypeError("Driver boot payload.heartbeatIntervalMs must be at least 250.");
  }

  if (protocolVersion !== DRIVER_PROTOCOL_VERSION) {
    throw new TypeError(`Driver boot payload.protocolVersion must be ${DRIVER_PROTOCOL_VERSION}.`);
  }

  if (!isSupportedDriverRuntime(runtime)) {
    throw new TypeError(`Unsupported runtime: ${runtime}.`);
  }

  if (!isSupportedDriverRuntimeTransport(runtimeTransport)) {
    throw new TypeError(`Unsupported runtime transport: ${runtimeTransport}.`);
  }

  return {
    bootToken: readNonEmptyString(record, "bootToken", "Driver boot payload"),
    driverControlPort,
    driverGeneration,
    driverInstanceId: parseId(record["driverInstanceId"], "Driver instance ID") as DriverInstanceId,
    execution: readExecution(record["execution"]),
    heartbeatIntervalMs,
    protocolVersion,
    runtime,
    runtimeTransport,
    sandboxId: parseId(record["sandboxId"], "Driver sandbox ID") as SandboxId,
    traceparent: readNonEmptyString(record, "traceparent", "Driver boot payload"),
  };
}

export function parseDriverBootPayloadJson(raw: string): DriverBootPayload {
  if (!raw.trim()) {
    throw new Error("Driver boot payload is empty.");
  }

  return parseDriverBootPayload(JSON.parse(raw));
}
