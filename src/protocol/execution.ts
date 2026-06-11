import type {
  DriverBootMcpServer,
  DriverExecutionEnvironment,
  DriverExecutionSpec,
  DriverNativeRuntimeRef,
  DriverResolvedSkill,
  DriverSkillCatalogEntry,
} from "./boot";
import type { RunId, SessionId } from "./id";

export interface DriverExecutionMountAlias {
  readonly aliasPath: string;
  readonly globalMountPath: string;
  readonly name: string;
}

export interface DriverExecutionRunInput {
  readonly runId: RunId | null;
  readonly sessionId: SessionId;
}

export interface DriverExecutionSessionInput {
  readonly additionalDirectories: string[];
  readonly cwd: string;
  readonly homePath: string;
  readonly mcpServers: DriverBootMcpServer[];
  readonly mountAliases: DriverExecutionMountAlias[];
  readonly nativeResumeRef: DriverNativeRuntimeRef | null;
  readonly sharedRootPath: string;
}

export interface DriverExecutionInput {
  readonly environment: DriverExecutionEnvironment;
  readonly model: string;
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
    environment: execution.environment,
    model: execution.model,
    provider: execution.provider,
    providerOptions: execution.providerOptions,
    run: {
      runId: execution.configRevision.runId,
      sessionId: execution.configRevision.sessionId,
    },
    session: {
      additionalDirectories: execution.session.additionalDirectories,
      cwd: execution.session.cwd,
      homePath: execution.session.context.homePath,
      mcpServers: execution.session.mcpServers,
      mountAliases: execution.session.context.spaceAliases.map((alias) => ({
        aliasPath: alias.aliasPath,
        globalMountPath: alias.globalMountPath,
        name: alias.spaceName,
      })),
      nativeResumeRef: execution.session.nativeResumeRef,
      sharedRootPath: execution.session.context.sessionOrganizationPath,
    },
    skillCatalog: execution.skillCatalog,
    skills: execution.skills,
    systemPrompt: execution.profilePrompt,
  };
}
