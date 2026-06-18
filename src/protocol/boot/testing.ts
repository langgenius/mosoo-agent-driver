import type { DriverId, DriverInstanceId, EventId, MessageId, RunId, SessionId } from "../id";
import { normalizeDriverId } from "../id";
import type {
  AccountId,
  AgentDeploymentVersionId,
  AgentId,
  EnvironmentId,
  EnvironmentRevisionId,
  SandboxId,
  SkillId,
} from "./host-ids";

function fixture(value: string): DriverId {
  return normalizeDriverId(value, "Driver ID fixture");
}

export const DRIVER_ID_FIXTURES = {
  account: fixture("01J00000000000000000000001") as AccountId,
  agent: fixture("01J00000000000000000000002") as AgentId,
  agentDeploymentVersion: fixture("01J00000000000000000000006") as AgentDeploymentVersionId,
  driverInstance: fixture("01J00000000000000000000008") as DriverInstanceId,
  environment: fixture("01J0000000000000000000000A") as EnvironmentId,
  environmentRevision: fixture("01J0000000000000000000000B") as EnvironmentRevisionId,
  event: fixture("01J0000000000000000000000G") as EventId,
  message: fixture("01J0000000000000000000000M") as MessageId,
  run: fixture("01J0000000000000000000000N") as RunId,
  sandbox: fixture("01J0000000000000000000000J") as SandboxId,
  session: fixture("01J0000000000000000000000K") as SessionId,
  skill: fixture("01J0000000000000000000000P") as SkillId,
} as const;
