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
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CmaSdkRequestOptions {
  readonly signal?: AbortSignal;
}

export interface CmaSdkStreamOptions extends CmaSdkRequestOptions {
  readonly afterCursor?: string;
}

export interface CmaSessionEventDispatchRecord {
  readonly command: RuntimeCommand;
  readonly event: CmaSessionEventRecord;
  readonly result: RuntimeCommandResult | null;
  readonly status: "accepted";
}

export interface CmaSdkClient {
  archiveEnvironment(id: string, options?: CmaSdkRequestOptions): Promise<CmaEnvironmentRecord>;
  createAgent(input: CmaCreateAgentInput, options?: CmaSdkRequestOptions): Promise<CmaAgentRecord>;
  createEnvironment(
    input: CmaCreateEnvironmentInput,
    options?: CmaSdkRequestOptions,
  ): Promise<CmaEnvironmentRecord>;
  createSession(
    input: CmaCreateSessionInput,
    options?: CmaSdkRequestOptions,
  ): Promise<CmaSessionRecord>;
  deleteEnvironment(id: string, options?: CmaSdkRequestOptions): Promise<void>;
  getAgent(id: string, options?: CmaSdkRequestOptions): Promise<CmaAgentRecord>;
  getEnvironment(id: string, options?: CmaSdkRequestOptions): Promise<CmaEnvironmentRecord>;
  getSession(id: string, options?: CmaSdkRequestOptions): Promise<CmaSessionRecord>;
  listAgents(options?: CmaSdkRequestOptions): Promise<readonly CmaAgentRecord[]>;
  listEnvironments(options?: CmaSdkRequestOptions): Promise<readonly CmaEnvironmentRecord[]>;
  listSessionEvents(
    sessionId: string,
    options?: CmaSdkRequestOptions,
  ): Promise<readonly CmaSessionEventRecord[]>;
  sendSessionEvent(
    sessionId: string,
    event: CmaInboundEvent,
    options?: CmaSdkRequestOptions,
  ): Promise<CmaSessionEventDispatchRecord>;
  streamSessionEvents(
    sessionId: string,
    options?: CmaSdkStreamOptions,
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
