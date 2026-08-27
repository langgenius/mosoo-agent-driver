import type { RuntimeCommand, RuntimeCommandResult } from "../../runtime-command";
import type { CmaSessionEventRecord } from "../../stores/cma-store";

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
