import type {
  DriverBootMcpServer,
  DriverExecutionEnvironment,
  DriverExecutionSessionContext,
  DriverExecutionSpec,
  DriverNativeRuntimeRef,
  DriverPermissionPolicy,
  DriverRecoveryMessage,
  DriverResolvedSkill,
  DriverSkillCatalogEntry,
} from "./boot";
import type { RunId, SessionId } from "./id";

export interface DriverExecutionRunInput {
  readonly runId: RunId | null;
  readonly sessionId: SessionId;
}

export interface DriverExecutionSessionInput {
  readonly additionalDirectories: string[];
  readonly context: DriverExecutionSessionContext;
  readonly cwd: string;
  readonly homePath: string;
  readonly mcpServers: DriverBootMcpServer[];
  readonly nativeResumeRef: DriverNativeRuntimeRef | null;
  readonly recoveryMessages: DriverRecoveryMessage[];
  readonly sharedRootPath: string;
}

export interface DriverExecutionInput {
  readonly builtInTools: DriverExecutionSpec["builtInTools"];
  readonly environment: DriverExecutionEnvironment;
  readonly model: string;
  readonly permissionPolicy: DriverPermissionPolicy;
  readonly provider: string;
  readonly providerOptions: DriverExecutionSpec["providerOptions"];
  readonly run: DriverExecutionRunInput;
  readonly session: DriverExecutionSessionInput;
  readonly skillCatalog: DriverSkillCatalogEntry[];
  readonly skills: DriverResolvedSkill[];
  readonly systemPrompt: string;
}

export function createDriverExecutionInputFromBootExecution(
  execution: DriverExecutionSpec,
): DriverExecutionInput {
  return {
    builtInTools: execution.builtInTools,
    environment: execution.environment,
    model: execution.model,
    permissionPolicy: execution.permissionPolicy,
    provider: execution.provider,
    providerOptions: execution.providerOptions,
    run: {
      runId: execution.configRevision.runId,
      sessionId: execution.configRevision.sessionId,
    },
    session: {
      additionalDirectories: execution.session.additionalDirectories,
      context: execution.session.context,
      cwd: execution.session.cwd,
      homePath: execution.session.context.homePath,
      mcpServers: execution.session.mcpServers,
      nativeResumeRef: execution.session.nativeResumeRef,
      recoveryMessages: execution.session.recoveryMessages,
      sharedRootPath: execution.session.context.sessionOrganizationPath,
    },
    skillCatalog: execution.skillCatalog,
    skills: execution.skills,
    systemPrompt: execution.profilePrompt,
  };
}
