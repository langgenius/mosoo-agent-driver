import type { CmaInboundEvent, CmaOutboundEvent, CmaSessionStatus } from "../projections/cma";
import type { RuntimeEventEnvelope } from "../runtime-events";
import type { RuntimeCommand, RuntimeCommandResult } from "../runtime-command";

export const CMA_MAX_EVENT_BYTES = 1_024 * 1_024;
export const CMA_MAX_REPLAY_BYTES = 8 * CMA_MAX_EVENT_BYTES;
export const CMA_MAX_STREAMS = 64;

export type CmaStoreResourceKind = "agent" | "environment" | "event" | "session";

export class CmaStoreConflictError extends Error {
  readonly id: string;
  readonly resource: CmaStoreResourceKind;

  constructor(resource: CmaStoreResourceKind, id: string) {
    super(`CMA ${resource} already exists: ${id}.`);
    this.name = "CmaStoreConflictError";
    this.resource = resource;
    this.id = id;
  }
}

export class CmaStoreNotFoundError extends Error {
  readonly id: string;
  readonly resource: CmaStoreResourceKind;

  constructor(resource: CmaStoreResourceKind, id: string) {
    super(`CMA ${resource} was not found: ${id}.`);
    this.name = "CmaStoreNotFoundError";
    this.resource = resource;
    this.id = id;
  }
}

export class CmaSessionTerminatedError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`CMA session is terminated: ${id}.`);
    this.name = "CmaSessionTerminatedError";
    this.id = id;
  }
}

export interface CmaAgentRecord {
  readonly createdAt: string;
  readonly id: string;
  readonly metadata: Record<string, unknown>;
  readonly name: string;
  readonly updatedAt: string;
}

export type CmaEnvironmentPackageManager = "apt" | "cargo" | "gem" | "go" | "npm" | "pip";

export type CmaEnvironmentPackages = Partial<
  Record<CmaEnvironmentPackageManager, readonly string[]>
>;

export interface CmaEnvironmentUnrestrictedNetworking {
  readonly type: "unrestricted";
}

export interface CmaEnvironmentLimitedNetworking {
  readonly allow_mcp_servers: boolean;
  readonly allow_package_managers: boolean;
  readonly allowed_hosts: readonly string[];
  readonly type: "limited";
}

export type CmaEnvironmentNetworking =
  | CmaEnvironmentLimitedNetworking
  | CmaEnvironmentUnrestrictedNetworking;

export interface CmaEnvironmentConfig {
  readonly networking: CmaEnvironmentNetworking;
  readonly packages: CmaEnvironmentPackages;
  readonly type: "cloud";
}

export interface CmaEnvironmentRecord {
  readonly archivedAt: string | null;
  readonly config: CmaEnvironmentConfig;
  readonly createdAt: string;
  readonly id: string;
  readonly metadata: Record<string, unknown>;
  readonly name: string;
  readonly updatedAt: string;
}

export interface CmaSessionRecord {
  readonly agentId: string | null;
  readonly createdAt: string;
  readonly environmentId: string | null;
  readonly id: string;
  readonly metadata: Record<string, unknown>;
  readonly status: CmaSessionStatus;
  readonly updatedAt: string;
}

export interface CmaSessionEventRecord {
  readonly command: RuntimeCommand | null;
  readonly commandResult: RuntimeCommandResult | null;
  readonly commandStatus: "accepted" | "completed" | "failed" | null;
  readonly createdAt: string;
  readonly cursor: string;
  readonly direction: "inbound" | "outbound";
  readonly event: CmaInboundEvent | CmaOutboundEvent;
  readonly id: string;
  readonly sessionId: string;
  readonly updatedAt: string;
}

const CMA_UTF8 = new TextEncoder();

export function encodeCmaSseRecord(record: CmaSessionEventRecord): Uint8Array {
  const bytes = CMA_UTF8.encode(
    `id: ${record.cursor}\nevent: ${record.event.type}\ndata: ${JSON.stringify(record)}\n\n`,
  );

  if (bytes.byteLength > CMA_MAX_EVENT_BYTES) {
    throw new RangeError(`CMA SSE event frame exceeds ${CMA_MAX_EVENT_BYTES} UTF-8 bytes.`);
  }

  return bytes;
}

export interface CmaCreateAgentInput {
  readonly id?: string;
  readonly metadata?: Record<string, unknown>;
  readonly name: string;
}

export interface CmaCreateEnvironmentInput {
  readonly config?: CmaEnvironmentConfig;
  readonly id?: string;
  readonly metadata?: Record<string, unknown>;
  readonly name: string;
}

export interface CmaCreateSessionInput {
  readonly agentId?: string;
  readonly environmentId?: string;
  readonly id?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CmaClaimInboundEventInput {
  readonly command: RuntimeCommand;
  readonly event: CmaInboundEvent;
  readonly sessionId: string;
}

export interface CmaInboundEventLease {
  readonly expiresAt: string;
  readonly id: string;
  readonly renewAfter: string;
}

export type CmaClaimInboundEventResult =
  | {
      readonly claimed: false;
      readonly event: CmaSessionEventRecord;
    }
  | {
      readonly claimed: true;
      readonly event: CmaSessionEventRecord;
      readonly lease: CmaInboundEventLease;
    };

export interface CmaRenewInboundEventClaimInput {
  readonly commandId: string;
  readonly leaseId: string;
  readonly sessionId: string;
}

export interface CmaSettleInboundEventInput {
  readonly commandId: string;
  readonly commandResult: RuntimeCommandResult | null;
  readonly leaseId: string;
  readonly sessionId: string;
  readonly status: "completed" | "failed";
}

export interface CmaStore {
  appendDriverEvent(
    sessionId: string,
    driverEvent: RuntimeEventEnvelope,
  ): Promise<readonly CmaSessionEventRecord[]>;
  archiveEnvironment(id: string): Promise<CmaEnvironmentRecord>;
  /**
   * Claims a command only on first admission. An accepted command is never
   * reissued because an expired worker cannot prove that its effect did not happen.
   */
  claimInboundEvent(input: CmaClaimInboundEventInput): Promise<CmaClaimInboundEventResult>;
  createAgent(input: CmaCreateAgentInput): Promise<CmaAgentRecord>;
  createEnvironment(input: CmaCreateEnvironmentInput): Promise<CmaEnvironmentRecord>;
  createSession(input: CmaCreateSessionInput): Promise<CmaSessionRecord>;
  deleteEnvironment(id: string): Promise<boolean>;
  getAgent(id: string): Promise<CmaAgentRecord | null>;
  getEnvironment(id: string): Promise<CmaEnvironmentRecord | null>;
  getSession(id: string): Promise<CmaSessionRecord | null>;
  listAgents(): Promise<readonly CmaAgentRecord[]>;
  listEnvironments(): Promise<readonly CmaEnvironmentRecord[]>;
  listSessionEvents(sessionId: string): Promise<readonly CmaSessionEventRecord[]>;
  renewInboundEventClaim(input: CmaRenewInboundEventClaimInput): Promise<CmaInboundEventLease>;
  settleInboundEvent(input: CmaSettleInboundEventInput): Promise<CmaSessionEventRecord>;
  streamSessionEvents(
    sessionId: string,
    afterCursor?: string,
  ): AsyncIterable<CmaSessionEventRecord>;
}
