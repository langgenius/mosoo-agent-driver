import type { CmaInboundEvent, CmaProjectedDriverCommand } from "../../projections/cma";
import type { RuntimeCommandResult } from "../../runtime-command";
import type { CmaSessionRecord, CmaStore } from "../../stores/cma-store";

type HttpMethod = "DELETE" | "GET" | "POST";

export const CMA_DEFAULT_BETA_HEADER_NAME = "anthropic-beta";
export const CMA_DEFAULT_BETA_HEADER_VALUE = "managed-agents-2026-04-01";

export interface CmaHttpAuthorizationContext {
  readonly request: Request;
  readonly segments: readonly string[];
}

export type CmaHttpAuthorizer = (
  context: CmaHttpAuthorizationContext,
) => Promise<Response | void> | Response | void;

export interface CmaHttpBetaHeaderRequirement {
  readonly name?: string;
  readonly value?: string;
}

export interface CmaHttpDriverCommandDispatchInput {
  readonly command: CmaProjectedDriverCommand;
  readonly event: CmaInboundEvent;
  readonly session: CmaSessionRecord;
  readonly signal: AbortSignal;
}

export type CmaHttpDriverCommandDispatcher = (
  input: CmaHttpDriverCommandDispatchInput,
) => Promise<RuntimeCommandResult | void>;

export interface CmaHttpHandlerOptions {
  readonly authorize?: CmaHttpAuthorizer;
  readonly betaHeader?: CmaHttpBetaHeaderRequirement | false;
  readonly dispatchDriverCommand: CmaHttpDriverCommandDispatcher;
  readonly store: CmaStore;
}

export type CmaHttpHandler = (request: Request) => Promise<Response>;

export class CmaHttpRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CmaHttpRequestError";
    this.status = status;
    this.code = code;
  }
}

export class CmaHttpDriverDispatchError extends Error {
  constructor() {
    super("Driver command dispatch failed.");
    this.name = "CmaHttpDriverDispatchError";
  }
}

export class CmaHttpCapabilityGapError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(`CMA capability is not supported in v0: ${feature}.`);
    this.name = "CmaHttpCapabilityGapError";
    this.feature = feature;
  }
}

export const CMA_HTTP_METHODS = {
  agents: ["GET", "POST"],
  environment: ["DELETE", "GET"],
  environments: ["GET", "POST"],
  get: ["GET"],
  post: ["POST"],
  sessionEvents: ["GET", "POST"],
} as const satisfies Record<string, readonly HttpMethod[]>;
