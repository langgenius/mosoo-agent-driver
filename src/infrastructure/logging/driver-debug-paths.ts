import { createHash } from "node:crypto";

import type { DriverBootPayload } from "../../protocol/boot";
import { isSandboxOrganizationPath, isSandboxSessionPath } from "../../protocol/paths";

type PathKind =
  | "other_absolute"
  | "relative_or_unknown"
  | "session_organization"
  | "organization_other";

interface PathCollectionSummary {
  count: number;
  fingerprint?: string | null;
  kindCounts: Record<PathKind, number>;
}

const PATH_KINDS: PathKind[] = [
  "session_organization",
  "organization_other",
  "other_absolute",
  "relative_or_unknown",
] as const;

function getPathKind(path: string): PathKind {
  if (isSandboxSessionPath(path)) {
    return "session_organization";
  }

  if (isSandboxOrganizationPath(path)) {
    return "organization_other";
  }

  if (path.startsWith("/")) {
    return "other_absolute";
  }

  return "relative_or_unknown";
}

export function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function summarizeTextDigest(
  value: string | null | undefined,
): { length: number; sha256: string } | null {
  if (typeof value !== "string") {
    return null;
  }

  return {
    length: value.length,
    sha256: digestText(value),
  };
}

export function summarizePath(
  path: string | null | undefined,
): { kind: PathKind; sha256: string } | null {
  if (typeof path !== "string") {
    return null;
  }

  return {
    kind: getPathKind(path),
    sha256: digestText(path),
  };
}

export function summarizePathCollection(
  paths: readonly string[],
  options: {
    includeFingerprint?: boolean;
  } = {},
): PathCollectionSummary {
  const kindCounts = Object.fromEntries(PATH_KINDS.map((kind) => [kind, 0])) as Record<
    PathKind,
    number
  >;
  const uniquePaths = [...new Set(paths.filter((path) => path.length > 0))];

  for (const path of uniquePaths) {
    kindCounts[getPathKind(path)] += 1;
  }

  return {
    count: uniquePaths.length,
    ...(options.includeFingerprint === true
      ? {
          fingerprint:
            uniquePaths.length > 0 ? digestText([...uniquePaths].toSorted().join("\n")) : null,
        }
      : {}),
    kindCounts,
  };
}

export function summarizeDriverBootPayload(payload: DriverBootPayload): Record<string, unknown> {
  const { session } = payload.execution;
  const { context } = session;

  return {
    driverControlPort: payload.driverControlPort,
    driverInstanceId: payload.driverInstanceId,
    execution: {
      additionalDirectories: summarizePathCollection(session.additionalDirectories, {
        includeFingerprint: true,
      }),
      configRevision: payload.execution.configRevision,
      cwd: summarizePath(session.cwd),
      envVarCount: Object.keys(payload.execution.environment.variables).length,
      mcpServerCount: session.mcpServers.length,
      profilePrompt: summarizeTextDigest(payload.execution.profilePrompt),
      readySkillCount: payload.execution.skills.filter((skill) => skill.snapshotId).length,
      sessionContext: {
        homePath: summarizePath(context.homePath),
        origin: {
          entrypoint: context.origin.entrypoint,
          type: context.origin.type,
        },
        sessionOrganizationPath: summarizePath(context.sessionOrganizationPath),
      },
      skillCatalogCount: payload.execution.skillCatalog.length,
      skillCount: payload.execution.skills.length,
    },
    heartbeatIntervalMs: payload.heartbeatIntervalMs,
    protocolVersion: payload.protocolVersion,
    runtime: payload.runtime,
    sandboxId: payload.sandboxId,
  };
}
