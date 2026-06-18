import type { DriverId, SessionId, RunId } from "../id";
import type {
  AccountId,
  AgentDeploymentVersionId,
  AgentId,
  EnvironmentId,
  EnvironmentRevisionId,
  SandboxId,
  SandboxSessionId,
} from "./host-ids";
import {
  parseId,
  parseNullableId,
  readNonEmptyString,
  readNumber,
  readRecord,
} from "./readers";

export interface DriverOrigin {
  readonly callerUserId: AccountId;
  readonly entrypoint: "api" | "chat";
  readonly executionOwnerUserId: AccountId;
  readonly type: "agent";
}

export interface DriverExecutionSessionContext {
  readonly homePath: string;
  readonly origin: DriverOrigin;
  readonly sandboxId: SandboxId;
  readonly sandboxKind: string;
  readonly sandboxSessionId: SandboxSessionId;
  readonly sandboxSubjectId: DriverId;
  readonly sandboxSubjectKind: string;
  readonly sessionOrganizationPath: string;
}

export interface DriverConfigRevision {
  readonly agentId: AgentId;
  readonly deploymentVersionId: AgentDeploymentVersionId | null;
  readonly deploymentVersionNumber: number | null;
  readonly environmentId: EnvironmentId;
  readonly environmentRevisionId: EnvironmentRevisionId;
  readonly runId: RunId | null;
  readonly sessionId: SessionId;
}

function readOrigin(value: unknown): DriverOrigin {
  const record = readRecord(value, "execution.session.context.origin");
  const entrypoint = readNonEmptyString(record, "entrypoint", "execution.session.context.origin");
  const type = readNonEmptyString(record, "type", "execution.session.context.origin");

  if (entrypoint !== "api" && entrypoint !== "chat") {
    throw new TypeError("execution.session.context.origin.entrypoint must be api or chat.");
  }

  if (type !== "agent") {
    throw new TypeError("execution.session.context.origin.type must be agent.");
  }

  return {
    callerUserId: parseId(record["callerUserId"], "Driver origin caller user ID") as AccountId,
    entrypoint,
    executionOwnerUserId: parseId(
      record["executionOwnerUserId"],
      "Driver origin execution owner user ID",
    ) as AccountId,
    type,
  };
}

export function readConfigRevision(value: unknown): DriverConfigRevision {
  const record = readRecord(value, "execution.configRevision");

  return {
    agentId: parseId(record["agentId"], "Driver config agent ID") as AgentId,
    deploymentVersionId: parseNullableId(
      record["deploymentVersionId"],
      "Driver config deployment version ID",
    ) as AgentDeploymentVersionId | null,
    deploymentVersionNumber:
      record["deploymentVersionNumber"] === null
        ? null
        : readNumber(record, "deploymentVersionNumber", "execution.configRevision"),
    environmentId: parseId(
      record["environmentId"],
      "Driver config environment ID",
    ) as EnvironmentId,
    environmentRevisionId: parseId(
      record["environmentRevisionId"],
      "Driver config environment revision ID",
    ) as EnvironmentRevisionId,
    runId: parseNullableId(record["runId"], "Driver config run ID") as RunId | null,
    sessionId: parseId(record["sessionId"], "Driver config session ID") as SessionId,
  };
}

export function readExecutionSessionContext(value: unknown): DriverExecutionSessionContext {
  const record = readRecord(value, "execution.session.context");

  return {
    homePath: readNonEmptyString(record, "homePath", "execution.session.context"),
    origin: readOrigin(record["origin"]),
    sandboxId: parseId(record["sandboxId"], "Driver execution sandbox ID") as SandboxId,
    sandboxKind: readNonEmptyString(record, "sandboxKind", "execution.session.context"),
    sandboxSessionId: parseId(
      record["sandboxSessionId"],
      "Driver execution sandbox session ID",
    ) as SandboxSessionId,
    sandboxSubjectId: parseId(record["sandboxSubjectId"], "Driver execution sandbox subject ID"),
    sandboxSubjectKind: readNonEmptyString(
      record,
      "sandboxSubjectKind",
      "execution.session.context",
    ),
    sessionOrganizationPath: readNonEmptyString(
      record,
      "sessionOrganizationPath",
      "execution.session.context",
    ),
  };
}
