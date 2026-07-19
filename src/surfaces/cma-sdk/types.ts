import type { CmaInboundEvent } from "../../projections/cma";
import type { RuntimeCommand, RuntimeCommandResult } from "../../runtime-command";
import type {
  CmaAgentRecord,
  CmaCreateAgentInput,
  CmaCreateEnvironmentInput,
  CmaCreateSessionInput,
  CmaEnvironmentRecord,
  CmaSessionEventRecord,
  CmaSessionRecord,
} from "../../stores/cma-store";

export type CmaSdkFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CmaSdkBetaHeader {
  readonly name?: string;
  readonly value?: string;
}

export interface CmaSdkClientOptions {
  readonly baseUrl: string | URL;
  readonly betaHeader?: CmaSdkBetaHeader | false;
  readonly fetch?: CmaSdkFetch;
  readonly headers?: HeadersInit;
}

export interface CmaSessionEventDispatchRecord {
  readonly command: RuntimeCommand;
  readonly event: CmaSessionEventRecord;
  readonly result: RuntimeCommandResult | null;
  readonly status: "accepted";
}

export interface CmaSdkClient {
  archiveEnvironment(id: string): Promise<CmaEnvironmentRecord>;
  createAgent(input: CmaCreateAgentInput): Promise<CmaAgentRecord>;
  createEnvironment(input: CmaCreateEnvironmentInput): Promise<CmaEnvironmentRecord>;
  createSession(input: CmaCreateSessionInput): Promise<CmaSessionRecord>;
  deleteEnvironment(id: string): Promise<void>;
  getAgent(id: string): Promise<CmaAgentRecord>;
  getEnvironment(id: string): Promise<CmaEnvironmentRecord>;
  getSession(id: string): Promise<CmaSessionRecord>;
  listAgents(): Promise<readonly CmaAgentRecord[]>;
  listEnvironments(): Promise<readonly CmaEnvironmentRecord[]>;
  listSessionEvents(sessionId: string): Promise<readonly CmaSessionEventRecord[]>;
  sendSessionEvent(
    sessionId: string,
    event: CmaInboundEvent,
  ): Promise<CmaSessionEventDispatchRecord>;
  streamSessionEvents(
    sessionId: string,
    afterCursor?: string,
  ): AsyncIterable<CmaSessionEventRecord>;
}

export class CmaSdkError extends Error {
  readonly body: unknown;
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = "CmaSdkError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}
