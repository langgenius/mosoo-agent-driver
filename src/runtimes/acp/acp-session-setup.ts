import type {
  DriverExecutionSessionContext,
  DriverAppAccessSnapshotOutput,
} from "../../protocol/boot";
import type { DriverStartInput } from "../../protocol/start";
import {
  buildAcpMcpServers,
  enforceAcpMcpSupport,
  supportsAcpSessionLoad,
  supportsAcpSessionResume,
  toAcpRequestMeta,
} from "./acp-configuration";
import type { AcpJsonRpcConnection } from "./acp-json";
import { parseAcpSessionSetupResult } from "./acp-types";
import type { JsonObject } from "./acp-types";

export type AcpSessionSetupMode = "created" | "loaded" | "resumed";

export interface AcpSessionSetup {
  readonly mode: AcpSessionSetupMode;
  readonly raw: JsonObject;
  readonly sessionId: string;
}

interface AcpSessionSetupInput {
  readonly agentCapabilities: JsonObject | null;
  readonly connection: AcpJsonRpcConnection;
  readonly currentSessionId: string | null;
  readonly appAccessSnapshot: DriverAppAccessSnapshotOutput;
  readonly payload: DriverStartInput;
  readonly sessionContext: DriverExecutionSessionContext;
  replaySession<T>(operation: () => Promise<T>): Promise<T>;
}

export async function setupAcpSession(input: AcpSessionSetupInput): Promise<AcpSessionSetup> {
  const mcpServers = buildAcpMcpServers(input.payload);
  enforceAcpMcpSupport(input.agentCapabilities, mcpServers);
  const existingSessionId = input.currentSessionId;
  const baseParams = {
    _meta: toAcpRequestMeta({
      appAccessSnapshot: input.appAccessSnapshot,
      sessionContext: input.sessionContext,
    }),
    additionalDirectories: input.payload.execution.session.additionalDirectories,
    cwd: input.payload.execution.session.cwd,
    mcpServers,
  };

  if (existingSessionId !== null && supportsAcpSessionResume(input.agentCapabilities)) {
    const result = parseAcpSessionSetupResult(
      await input.connection.request("session/resume", {
        ...baseParams,
        sessionId: existingSessionId,
      }),
    );
    return {
      mode: "resumed",
      raw: result.raw,
      sessionId: existingSessionId,
    };
  }

  if (existingSessionId !== null && supportsAcpSessionLoad(input.agentCapabilities)) {
    return input.replaySession(async () => {
      const result = parseAcpSessionSetupResult(
        await input.connection.request("session/load", {
          ...baseParams,
          sessionId: existingSessionId,
        }),
      );
      return {
        mode: "loaded",
        raw: result.raw,
        sessionId: existingSessionId,
      };
    });
  }

  const result = parseAcpSessionSetupResult(
    await input.connection.request("session/new", baseParams),
  );

  if (result.sessionId === null) {
    throw new Error("ACP driver backend agent returned an empty session id.");
  }

  return {
    mode: "created",
    raw: result.raw,
    sessionId: result.sessionId,
  };
}
