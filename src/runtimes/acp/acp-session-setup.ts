import { methods as acpMethods } from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  ClientContext,
  LoadSessionRequest,
  NewSessionRequest,
  ResumeSessionRequest,
} from "@agentclientprotocol/sdk";

import type { DriverExecutionSessionContext } from "../../protocol/boot";
import type { DriverStartInput } from "../../protocol/start";
import {
  buildMcpServers,
  assertMcpSupport,
  supportsAdditionalDirs,
  supportsSessionLoad,
  supportsSessionResume,
  toRequestMeta,
} from "./acp-configuration";
import { isRecord } from "./acp-types";
import type { JsonObject } from "./acp-types";

export type AcpSessionSetupMode = "created" | "loaded" | "resumed";

export interface AcpSessionSetup {
  readonly droppedAdditionalDirectories: readonly string[];
  readonly mode: AcpSessionSetupMode;
  readonly raw: JsonObject;
  readonly sessionId: string;
}

interface AcpSessionSetupInput {
  readonly agentCapabilities: AgentCapabilities | null;
  readonly connection: ClientContext;
  readonly currentSessionId: string | null;
  readonly payload: DriverStartInput;
  readonly sessionContext: DriverExecutionSessionContext;
  replaySession<T>(operation: () => Promise<T>): Promise<T>;
}

export async function setupAcpSession(input: AcpSessionSetupInput): Promise<AcpSessionSetup> {
  const mcpServers = buildMcpServers(input.payload);
  assertMcpSupport(input.agentCapabilities, mcpServers);
  const existingSessionId = input.currentSessionId;
  const requestedAdditionalDirectories = input.payload.execution.session.additionalDirectories;

  // Agents that do not advertise sessionCapabilities.additionalDirectories
  // (OpenCode never has) used to receive the field anyway and silently ignore
  // it. Failing the whole session here turns that long-standing silent
  // degradation into an outage, so drop the directories instead and let the
  // caller surface the degradation.
  const supportsDirs = supportsAdditionalDirs(input.agentCapabilities);
  const additionalDirectories = supportsDirs ? requestedAdditionalDirectories : [];
  const droppedAdditionalDirectories = supportsDirs ? [] : requestedAdditionalDirectories;

  const baseParams = {
    _meta: toRequestMeta({
      sessionContext: input.sessionContext,
    }),
    ...(additionalDirectories.length === 0 ? {} : { additionalDirectories }),
    cwd: input.payload.execution.session.cwd,
    mcpServers,
  } satisfies NewSessionRequest;

  if (existingSessionId !== null && supportsSessionResume(input.agentCapabilities)) {
    const params = { ...baseParams, sessionId: existingSessionId } satisfies ResumeSessionRequest;
    const result = await input.connection.request(acpMethods.agent.session.resume, params);
    return {
      droppedAdditionalDirectories,
      mode: "resumed",
      raw: isRecord(result) ? result : {},
      sessionId: existingSessionId,
    };
  }

  if (existingSessionId !== null && supportsSessionLoad(input.agentCapabilities)) {
    return input.replaySession(async () => {
      const params = { ...baseParams, sessionId: existingSessionId } satisfies LoadSessionRequest;
      const result = await input.connection.request(acpMethods.agent.session.load, params);
      return {
        droppedAdditionalDirectories,
        mode: "loaded",
        raw: isRecord(result) ? result : {},
        sessionId: existingSessionId,
      };
    });
  }

  const result = await input.connection.request(acpMethods.agent.session.new, baseParams);

  if (result.sessionId.trim().length === 0) {
    throw new Error("ACP driver backend agent returned an empty session id.");
  }

  return {
    droppedAdditionalDirectories,
    mode: "created",
    raw: isRecord(result) ? result : {},
    sessionId: result.sessionId,
  };
}
