import { isDeepStrictEqual } from "node:util";

import { projectDriverEventToCma } from "../../projections/cma";
import { createDriverId } from "../../protocol/id";
import { parseRuntimeEventEnvelope } from "../../runtime-events";
import type { RuntimeEventEnvelope } from "../../runtime-events";
import type {
  CmaAgentRecord,
  CmaClaimInboundEventInput,
  CmaClaimInboundEventResult,
  CmaCreateAgentInput,
  CmaCreateEnvironmentInput,
  CmaCreateSessionInput,
  CmaEnvironmentConfig,
  CmaEnvironmentRecord,
  CmaInboundEventLease,
  CmaRenewInboundEventClaimInput,
  CmaSessionEventRecord,
  CmaSessionRecord,
  CmaSettleInboundEventInput,
  CmaStore,
} from "../cma-store";
import {
  CMA_MAX_EVENT_BYTES,
  CMA_MAX_REPLAY_BYTES,
  CMA_MAX_STREAMS,
  CmaSessionTerminatedError,
  CmaStoreConflictError,
  CmaStoreNotFoundError,
  encodeCmaSseRecord,
} from "../cma-store";

export type CmaMemoryStoreIdFactory = (
  resource: "agent" | "environment" | "event" | "session",
) => string;

export interface CmaMemoryStoreOptions {
  readonly agents?: readonly CmaCreateAgentInput[];
  readonly environments?: readonly CmaCreateEnvironmentInput[];
  readonly idFactory?: CmaMemoryStoreIdFactory;
  readonly now?: () => Date;
  readonly sessions?: readonly CmaCreateSessionInput[];
}

const createDefaultId: CmaMemoryStoreIdFactory = () => createDriverId();
const CLAIM_LEASE_MS = 30_000;
const CLAIM_RENEW_MS = 10_000;
const MAX_PENDING_SUBSCRIBER_EVENTS = 64;
const UTF8 = new TextEncoder();

interface CmaInboundClaim {
  lease: CmaInboundEventLease;
  record: CmaSessionEventRecord;
}

interface CmaMemorySubscriber {
  push(record: CmaSessionEventRecord): void;
}

interface CmaSourceEventRecord {
  readonly event: RuntimeEventEnvelope;
  readonly records: readonly CmaSessionEventRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventKey(sessionId: string, id: string): string {
  return `${sessionId}\u0000${id}`;
}

function isTerminalEvent(record: CmaSessionEventRecord): boolean {
  return "sessionStatus" in record.event && record.event.sessionStatus === "terminated";
}

function jsonBytes(value: unknown): number {
  return UTF8.encode(JSON.stringify(value)).byteLength;
}

function eventFrameBytes(record: CmaSessionEventRecord): number {
  return encodeCmaSseRecord(record).byteLength;
}

function sortById<T extends { readonly id: string }>(records: Iterable<T>): T[] {
  return [...records].toSorted((left, right) => left.id.localeCompare(right.id));
}

function createDefaultEnvironmentConfig(): CmaEnvironmentConfig {
  return {
    networking: {
      type: "unrestricted",
    },
    packages: {},
    type: "cloud",
  };
}

export function createCmaMemoryStore(options: CmaMemoryStoreOptions = {}): CmaStore {
  return new CmaMemoryStore(options);
}

class CmaMemoryStore implements CmaStore {
  readonly #agents = new Map<string, CmaAgentRecord>();
  readonly #environments = new Map<string, CmaEnvironmentRecord>();
  readonly #eventsBySessionId = new Map<string, CmaSessionEventRecord[]>();
  readonly #idFactory: CmaMemoryStoreIdFactory;
  readonly #inboundClaims = new Map<string, CmaInboundClaim>();
  readonly #now: () => Date;
  readonly #pendingPermissionsBySessionId = new Map<string, Map<string, unknown>>();
  readonly #sessions = new Map<string, CmaSessionRecord>();
  readonly #sourceEvents = new Map<string, CmaSourceEventRecord>();
  readonly #subscribersBySessionId = new Map<string, Set<CmaMemorySubscriber>>();
  #subscriberCount = 0;

  constructor(options: CmaMemoryStoreOptions = {}) {
    this.#idFactory = options.idFactory ?? createDefaultId;
    this.#now = options.now ?? (() => new Date());

    for (const agent of options.agents ?? []) {
      this.#putAgent(agent);
    }

    for (const environment of options.environments ?? []) {
      this.#putEnvironment(environment);
    }

    for (const session of options.sessions ?? []) {
      this.#putSession(session);
    }
  }

  async appendDriverEvent(
    sessionId: string,
    driverEvent: RuntimeEventEnvelope,
  ): Promise<readonly CmaSessionEventRecord[]> {
    const session = this.#requireSession(sessionId);
    const admittedEvent = parseRuntimeEventEnvelope(driverEvent);

    if (admittedEvent.sessionId !== sessionId) {
      throw new TypeError(
        `Driver event sessionId ${admittedEvent.sessionId} does not match CMA session ${sessionId}.`,
      );
    }

    if (jsonBytes(admittedEvent) > CMA_MAX_EVENT_BYTES) {
      throw new RangeError(`CMA event exceeds ${CMA_MAX_EVENT_BYTES} UTF-8 bytes.`);
    }

    const projectedEvents = projectDriverEventToCma(admittedEvent);

    if (
      admittedEvent.delivery !== "lossless" &&
      projectedEvents.some((event) => event.sessionStatus !== undefined)
    ) {
      throw new TypeError(`CMA authoritative event ${admittedEvent.kind} must be lossless.`);
    }

    const persistent = admittedEvent.delivery === "lossless";
    const sourceEventId = admittedEvent.sourceEventId ?? admittedEvent.id;
    const sourceKey = persistent ? eventKey(sessionId, sourceEventId) : null;
    const existing = sourceKey === null ? undefined : this.#sourceEvents.get(sourceKey);

    if (existing) {
      if (
        !isDeepStrictEqual(
          {
            ...existing.event,
            id: admittedEvent.id,
            occurredAt: admittedEvent.occurredAt,
          },
          admittedEvent,
        )
      ) {
        throw new CmaStoreConflictError("event", sourceEventId);
      }

      return existing.records.map((record) => structuredClone(record));
    }

    if (
      session.status === "terminated" ||
      (admittedEvent.visibility !== "participant" && admittedEvent.visibility !== "public")
    ) {
      if (sourceKey !== null) {
        this.#sourceEvents.set(sourceKey, {
          event: structuredClone(admittedEvent),
          records: [],
        });
      }

      return [];
    }

    const pendingPermissions = new Map(this.#pendingPermissionsBySessionId.get(sessionId) ?? []);
    let currentStatus: CmaSessionRecord["status"] = session.status;
    const transitions = projectedEvents.map((projected) => {
      const status = this.#nextSessionStatus(
        currentStatus,
        admittedEvent,
        projected.sessionStatus,
        projected.requiresAction,
        pendingPermissions,
      );
      currentStatus = status ?? currentStatus;
      const pendingAction =
        status === "idle" ? pendingPermissions.values().next().value : undefined;
      const statusEvent =
        status === undefined ||
        projected.sessionStatus === undefined ||
        projected.sessionStatus === status
          ? projected
          : {
              ...projected,
              sessionStatus: status,
              type: `session.status_${status}` as const,
            };
      const event =
        pendingAction === undefined || statusEvent.requiresAction !== undefined
          ? statusEvent
          : { ...statusEvent, requiresAction: pendingAction };
      return {
        record: this.#createEvent({
          command: null,
          commandResult: null,
          commandStatus: null,
          direction: "outbound",
          event,
          sessionId,
        }),
        status,
      };
    });

    if (pendingPermissions.size === 0) {
      this.#pendingPermissionsBySessionId.delete(sessionId);
    } else {
      this.#pendingPermissionsBySessionId.set(sessionId, pendingPermissions);
    }

    for (const { record, status } of transitions) {
      if (persistent) {
        this.#persistEvent(record);
      }
      this.#updateSessionStatus(sessionId, status, record.createdAt);
      this.#publishEvent(record);
    }

    const records = transitions.map(({ record }) => record);

    if (sourceKey !== null) {
      this.#sourceEvents.set(sourceKey, {
        event: structuredClone(admittedEvent),
        records,
      });
    }

    return records.map((record) => structuredClone(record));
  }

  async claimInboundEvent(input: CmaClaimInboundEventInput): Promise<CmaClaimInboundEventResult> {
    const session = this.#requireSession(input.sessionId);
    const key = eventKey(input.sessionId, input.command.commandId);
    const existing = this.#inboundClaims.get(key);

    if (existing) {
      if (
        !isDeepStrictEqual(existing.record.command, input.command) ||
        !isDeepStrictEqual(existing.record.event, input.event)
      ) {
        throw new CmaStoreConflictError("event", input.command.commandId);
      }

      if (existing.record.commandStatus === "accepted") {
        if (session.status === "terminated") {
          throw new CmaSessionTerminatedError(input.sessionId);
        }

        if (existing.lease.expiresAt <= this.#nowIso()) {
          existing.lease = this.#createLease();
          return {
            claimed: true,
            event: structuredClone(existing.record),
            lease: structuredClone(existing.lease),
          };
        }
      }

      return {
        claimed: false,
        event: structuredClone(existing.record),
      };
    }

    if (session.status === "terminated") {
      throw new CmaSessionTerminatedError(input.sessionId);
    }

    const record = this.#createEvent({
      command: input.command,
      commandResult: null,
      commandStatus: "accepted",
      direction: "inbound",
      event: input.event,
      sessionId: input.sessionId,
    });
    this.#persistEvent(record);
    const lease = this.#createLease();
    this.#inboundClaims.set(key, { lease, record });
    this.#publishEvent(record);

    return {
      claimed: true,
      event: structuredClone(record),
      lease: structuredClone(lease),
    };
  }

  async renewInboundEventClaim(
    input: CmaRenewInboundEventClaimInput,
  ): Promise<CmaInboundEventLease> {
    const claim = this.#requireClaim(input.sessionId, input.commandId);

    if (
      claim.record.commandStatus !== "accepted" ||
      claim.lease.id !== input.leaseId ||
      claim.lease.expiresAt <= this.#nowIso()
    ) {
      throw new CmaStoreConflictError("event", input.commandId);
    }

    if (this.#requireSession(input.sessionId).status === "terminated") {
      throw new CmaSessionTerminatedError(input.sessionId);
    }

    claim.lease = this.#createLease(input.leaseId);
    return structuredClone(claim.lease);
  }

  async settleInboundEvent(input: CmaSettleInboundEventInput): Promise<CmaSessionEventRecord> {
    const claim = this.#requireClaim(input.sessionId, input.commandId);

    if (claim.lease.id !== input.leaseId) {
      throw new CmaStoreConflictError("event", input.commandId);
    }

    const commandResult = input.status === "failed" ? null : structuredClone(input.commandResult);

    if (claim.record.commandStatus !== "accepted") {
      if (
        claim.record.commandStatus !== input.status ||
        !isDeepStrictEqual(claim.record.commandResult, commandResult)
      ) {
        throw new CmaStoreConflictError("event", input.commandId);
      }

      return structuredClone(claim.record);
    }

    if (claim.lease.expiresAt <= this.#nowIso()) {
      throw new CmaStoreConflictError("event", input.commandId);
    }

    const updated = {
      ...claim.record,
      commandResult,
      commandStatus: input.status,
      cursor: createDriverId(),
      updatedAt: this.#nowIso(),
    } satisfies CmaSessionEventRecord;
    eventFrameBytes(updated);
    const events = this.#eventsBySessionId.get(input.sessionId) ?? [];
    const index = events.findIndex((event) => event.id === claim.record.id);

    if (index < 0) {
      throw new CmaStoreNotFoundError("event", claim.record.id);
    }

    events.splice(index, 1);
    events.push(updated);
    claim.record = updated;
    this.#publishEvent(updated);
    return structuredClone(updated);
  }

  async archiveEnvironment(id: string): Promise<CmaEnvironmentRecord> {
    const environment = this.#requireEnvironment(id);
    const archivedAt = environment.archivedAt ?? this.#nowIso();
    const updated = {
      ...environment,
      archivedAt,
      updatedAt: this.#nowIso(),
    } satisfies CmaEnvironmentRecord;
    this.#environments.set(id, updated);
    return structuredClone(updated);
  }

  async createAgent(input: CmaCreateAgentInput): Promise<CmaAgentRecord> {
    return structuredClone(this.#putAgent(input));
  }

  async createEnvironment(input: CmaCreateEnvironmentInput): Promise<CmaEnvironmentRecord> {
    return structuredClone(this.#putEnvironment(input));
  }

  async createSession(input: CmaCreateSessionInput): Promise<CmaSessionRecord> {
    return structuredClone(this.#putSession(input));
  }

  async deleteEnvironment(id: string): Promise<boolean> {
    return this.#environments.delete(id);
  }

  async getAgent(id: string): Promise<CmaAgentRecord | null> {
    const agent = this.#agents.get(id);
    return agent ? structuredClone(agent) : null;
  }

  async getEnvironment(id: string): Promise<CmaEnvironmentRecord | null> {
    const environment = this.#environments.get(id);
    return environment ? structuredClone(environment) : null;
  }

  async getSession(id: string): Promise<CmaSessionRecord | null> {
    const session = this.#sessions.get(id);
    return session ? structuredClone(session) : null;
  }

  async listAgents(): Promise<readonly CmaAgentRecord[]> {
    return sortById(this.#agents.values()).map((agent) => structuredClone(agent));
  }

  async listEnvironments(): Promise<readonly CmaEnvironmentRecord[]> {
    return sortById(this.#environments.values()).map((environment) => structuredClone(environment));
  }

  async listSessionEvents(sessionId: string): Promise<readonly CmaSessionEventRecord[]> {
    this.#requireSession(sessionId);
    return this.#readReplay(sessionId).map((event) => structuredClone(event));
  }

  streamSessionEvents(
    sessionId: string,
    afterCursor?: string,
  ): AsyncIterable<CmaSessionEventRecord> {
    this.#requireSession(sessionId);
    return {
      [Symbol.asyncIterator]: () => {
        const session = this.#requireSession(sessionId);
        const replay = this.#readReplay(sessionId, afterCursor);
        const replayCount = replay.length;
        const pending: { readonly bytes: number; readonly record: CmaSessionEventRecord }[] = [];
        const subscribers = this.#subscribersBySessionId.get(sessionId) ?? new Set();
        let accepting = session.status !== "terminated";
        let closed = false;
        let controller: ReadableStreamDefaultController<CmaSessionEventRecord>;
        let demanded = false;
        let pendingBytes = 0;
        let replayIndex = 0;
        let registered = true;
        let subscribed = false;

        if (this.#subscriberCount >= CMA_MAX_STREAMS) {
          throw new RangeError(`CMA subscription limit of ${CMA_MAX_STREAMS} was exceeded.`);
        }
        this.#subscriberCount += 1;

        const unsubscribe = () => {
          if (!subscribed) {
            return;
          }

          subscribed = false;
          subscribers.delete(subscriber);

          if (subscribers.size === 0) {
            this.#subscribersBySessionId.delete(sessionId);
          }
        };
        const release = () => {
          if (!registered) {
            return;
          }

          registered = false;
          unsubscribe();
          this.#subscriberCount -= 1;
        };
        const drain = () => {
          if (closed || !demanded) {
            return;
          }

          let record: CmaSessionEventRecord | undefined;

          if (replayIndex < replayCount) {
            record = replay[replayIndex++];
          } else {
            const next = pending.shift();

            if (next) {
              pendingBytes -= next.bytes;
              record = next.record;
            }
          }

          if (record) {
            demanded = false;
            controller.enqueue(structuredClone(record));
          }

          if (!closed && replayIndex >= replayCount && pending.length === 0 && !accepting) {
            closed = true;
            controller.close();
            release();
          }
        };
        const subscriber: CmaMemorySubscriber = {
          push: (record) => {
            if (!accepting) {
              return;
            }

            const bytes = eventFrameBytes(record);

            if (
              pending.length >= MAX_PENDING_SUBSCRIBER_EVENTS ||
              bytes > CMA_MAX_EVENT_BYTES - pendingBytes
            ) {
              accepting = false;
              closed = true;
              release();
              controller.error(
                new Error(
                  bytes > CMA_MAX_EVENT_BYTES - pendingBytes
                    ? "CMA subscriber byte limit exceeded."
                    : "CMA event stream slow consumer limit exceeded.",
                ),
              );
              return;
            }

            pending.push({ bytes, record });
            pendingBytes += bytes;

            if (isTerminalEvent(record)) {
              accepting = false;
              unsubscribe();
            }

            drain();
          },
        };
        const stream = new ReadableStream<CmaSessionEventRecord>(
          {
            start: (value) => {
              controller = value;

              if (accepting) {
                subscribers.add(subscriber);
                this.#subscribersBySessionId.set(sessionId, subscribers);
                subscribed = true;
              }
            },
            pull() {
              demanded = true;
              drain();
            },
            cancel() {
              accepting = false;
              closed = true;
              release();
            },
          },
          { highWaterMark: 0 },
        );
        const reader = stream.getReader();

        return {
          next: () => reader.read(),
          async return() {
            await reader.cancel();
            return { done: true, value: undefined };
          },
          async throw(error?: unknown) {
            await reader.cancel(error);
            throw error;
          },
        };
      },
    };
  }

  #createEvent(
    input: Omit<CmaSessionEventRecord, "createdAt" | "cursor" | "id" | "updatedAt">,
  ): CmaSessionEventRecord {
    const now = this.#nowIso();
    const record = {
      ...structuredClone(input),
      createdAt: now,
      cursor: createDriverId(),
      id: this.#idFactory("event"),
      updatedAt: now,
    } satisfies CmaSessionEventRecord;
    eventFrameBytes(record);
    return record;
  }

  #persistEvent(record: CmaSessionEventRecord): void {
    const events = this.#eventsBySessionId.get(record.sessionId) ?? [];
    events.push(record);
    this.#eventsBySessionId.set(record.sessionId, events);
  }

  #readReplay(sessionId: string, afterCursor?: string): CmaSessionEventRecord[] {
    const replay: CmaSessionEventRecord[] = [];
    let bytes = 0;

    for (const event of this.#eventsBySessionId.get(sessionId) ?? []) {
      if (afterCursor !== undefined && event.cursor <= afterCursor) {
        continue;
      }

      const eventBytes = eventFrameBytes(event);

      if (eventBytes > CMA_MAX_REPLAY_BYTES - bytes) {
        throw new RangeError(`CMA replay exceeds ${CMA_MAX_REPLAY_BYTES} UTF-8 bytes.`);
      }

      bytes += eventBytes;
      replay.push(event);
    }

    return replay;
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }

  #createLease(id: string = createDriverId()): CmaInboundEventLease {
    const now = this.#now().getTime();
    return {
      expiresAt: new Date(now + CLAIM_LEASE_MS).toISOString(),
      id,
      renewAfter: new Date(now + CLAIM_RENEW_MS).toISOString(),
    };
  }

  #putAgent(input: CmaCreateAgentInput): CmaAgentRecord {
    const id = input.id ?? this.#idFactory("agent");

    if (this.#agents.has(id)) {
      throw new CmaStoreConflictError("agent", id);
    }

    const now = this.#nowIso();
    const record = {
      createdAt: now,
      id,
      metadata: structuredClone(input.metadata ?? {}),
      name: input.name,
      updatedAt: now,
    } satisfies CmaAgentRecord;
    this.#agents.set(id, record);
    return record;
  }

  #putEnvironment(input: CmaCreateEnvironmentInput): CmaEnvironmentRecord {
    const id = input.id ?? this.#idFactory("environment");

    if (this.#environments.has(id)) {
      throw new CmaStoreConflictError("environment", id);
    }

    const now = this.#nowIso();
    const record = {
      archivedAt: null,
      config: structuredClone(input.config ?? createDefaultEnvironmentConfig()),
      createdAt: now,
      id,
      metadata: structuredClone(input.metadata ?? {}),
      name: input.name,
      updatedAt: now,
    } satisfies CmaEnvironmentRecord;
    this.#environments.set(id, record);
    return record;
  }

  #putSession(input: CmaCreateSessionInput): CmaSessionRecord {
    const id = input.id ?? this.#idFactory("session");

    if (this.#sessions.has(id)) {
      throw new CmaStoreConflictError("session", id);
    }

    if (input.agentId !== undefined && !this.#agents.has(input.agentId)) {
      throw new CmaStoreNotFoundError("agent", input.agentId);
    }

    if (input.environmentId !== undefined && !this.#environments.has(input.environmentId)) {
      throw new CmaStoreNotFoundError("environment", input.environmentId);
    }

    const now = this.#nowIso();
    const record = {
      agentId: input.agentId ?? null,
      createdAt: now,
      environmentId: input.environmentId ?? null,
      id,
      metadata: structuredClone(input.metadata ?? {}),
      status: "idle",
      updatedAt: now,
    } satisfies CmaSessionRecord;
    this.#sessions.set(id, record);
    return record;
  }

  #publishEvent(record: CmaSessionEventRecord): void {
    for (const subscriber of this.#subscribersBySessionId.get(record.sessionId) ?? []) {
      subscriber.push(record);
    }
  }

  #nextSessionStatus(
    current: CmaSessionRecord["status"],
    event: RuntimeEventEnvelope,
    proposed: CmaSessionRecord["status"] | undefined,
    requiresAction: unknown,
    pendingPermissions: Map<string, unknown>,
  ): CmaSessionRecord["status"] | undefined {
    const payload = isRecord(event.payload) ? event.payload : {};
    const requestId = typeof payload["requestId"] === "string" ? payload["requestId"] : null;

    switch (event.kind) {
      case "permission.requested":
        if (requestId !== null && requiresAction !== undefined) {
          pendingPermissions.set(requestId, structuredClone(requiresAction));
        }
        return current === "rescheduling" ? current : "idle";
      case "permission.resolved":
        if (requestId === null || !pendingPermissions.delete(requestId)) {
          return current;
        }
        if (current === "rescheduling") {
          return current;
        }
        return pendingPermissions.size > 0 ? "idle" : "running";
      case "run.started":
        pendingPermissions.clear();
        return "running";
      case "run.waiting":
        return current === "rescheduling" ? current : "idle";
      case "run.cancelled":
      case "run.completed":
        pendingPermissions.clear();
        return "idle";
      case "run.failed":
        pendingPermissions.clear();
        return proposed;
      default:
        return proposed;
    }
  }

  #updateSessionStatus(
    sessionId: string,
    status: CmaSessionRecord["status"] | undefined,
    updatedAt: string,
  ): void {
    if (status === undefined) {
      return;
    }

    const session = this.#requireSession(sessionId);
    this.#sessions.set(sessionId, {
      ...session,
      status,
      updatedAt,
    });
  }

  #requireEnvironment(id: string): CmaEnvironmentRecord {
    const environment = this.#environments.get(id);

    if (!environment) {
      throw new CmaStoreNotFoundError("environment", id);
    }

    return environment;
  }

  #requireClaim(sessionId: string, commandId: string): CmaInboundClaim {
    const claim = this.#inboundClaims.get(eventKey(sessionId, commandId));

    if (!claim) {
      throw new CmaStoreNotFoundError("event", commandId);
    }

    return claim;
  }

  #requireSession(id: string): CmaSessionRecord {
    const session = this.#sessions.get(id);

    if (!session) {
      throw new CmaStoreNotFoundError("session", id);
    }

    return session;
  }
}
