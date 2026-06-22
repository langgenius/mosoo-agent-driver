import { createHash } from "node:crypto";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";

import type { DriverBootPayload } from "../../protocol/boot";
import type { DriverEventEnvelope, DriverEventInput } from "../../protocol/events";
import { createDriverId, parseDriverId } from "../../protocol/id";
import type { DriverInstanceId, EventId, SessionId, RunId } from "../../protocol/id";
import type {
  DriverFailureInput,
  DriverEventBatchOutput,
  DriverHeartbeatInput,
  DriverHeartbeatOutput,
  DriverHelloInput,
  DriverLogBatchInput,
  DriverReadyInput,
} from "../../protocol/orpc";
import type { DriverRuntimeClient } from "../../protocol/orpc";
import type { RunError, RuntimeCommand, RuntimeCommandResult } from "../../runtime-command";
import { isRuntimeEventEnvelope, toRuntimeEventInput } from "../../runtime-events";
import { acceptDriverControlSocket } from "./driver-local-control-server";
import type { DriverWireSocket } from "./driver-local-control-server";

interface DriverInstanceSocketHandlers {
  onClose: (code: number, reason: string) => void;
}

export class DriverInstanceSocket {
  #activeRunId: RunId | null = null;
  #client: DriverRuntimeClient | null = null;
  private readonly handlers: DriverInstanceSocketHandlers;
  private readonly payload: DriverBootPayload;
  #socket: DriverWireSocket | null = null;

  constructor(payload: DriverBootPayload, handlers: DriverInstanceSocketHandlers) {
    this.handlers = handlers;
    this.payload = payload;
  }

  async connect(): Promise<void> {
    const socket = await acceptDriverControlSocket(this.payload);
    this.#socket = socket;

    socket.addEventListener("close", (event) => {
      if (event instanceof CloseEvent) {
        this.handlers.onClose(event.code, event.reason);
        return;
      }

      this.handlers.onClose(1006, "runtime.socket.closed");
    });

    this.#client = createORPCClient(
      new RPCLink({
        websocket: socket,
      }),
    ) as unknown as DriverRuntimeClient;
  }

  close(code = 1000, reason = "runtime.socket.closed"): void {
    this.#socket?.close(code, reason);
    this.#socket = null;
  }

  beginRun(runId: RunId): void {
    this.#activeRunId = runId;
  }

  endRun(runId: RunId): void {
    if (this.#activeRunId === runId) {
      this.#activeRunId = null;
    }
  }

  async commandUpdate(input: {
    commandId: string;
    error?: RunError;
    result?: RuntimeCommandResult;
    status: "accepted" | "cancelled" | "completed" | "delivered" | "expired" | "failed";
  }): Promise<void> {
    await this.#requireClient().driver.commandUpdate({
      commandId: input.commandId,
      driverInstanceId: this.payload.driverInstanceId,
      ...(input.error === undefined ? {} : { error: input.error }),
      status: input.status,
      ...(input.result === undefined ? {} : { result: input.result }),
    });
  }

  async completeRun(): Promise<void> {
    await this.#requireClient().driver.completeRun({
      driverInstanceId: this.payload.driverInstanceId,
    });
  }

  async failRun(error: DriverFailureInput["error"]): Promise<void> {
    await this.#requireClient().driver.failRun({
      driverInstanceId: this.payload.driverInstanceId,
      error,
    });
  }

  async heartbeat(input: Omit<DriverHeartbeatInput, "pid">): Promise<DriverHeartbeatOutput> {
    return this.#requireClient().driver.heartbeat({
      at: input.at,
      pid: process.pid,
      reason: input.reason,
    });
  }

  async hello(
    input: Omit<DriverHelloInput, "pid" | "runtime" | "startedAt"> & {
      startedAt: string;
    },
  ) {
    return this.#requireClient().driver.hello({
      capabilities: input.capabilities,
      driverVersion: input.driverVersion,
      pid: process.pid,
      protocolVersion: input.protocolVersion,
      runtime: this.payload.runtime,
      startedAt: input.startedAt,
    });
  }

  async pushEvents(input: { events: DriverEventInput[] }): Promise<DriverEventBatchOutput> {
    const sourceEventIdOccurrences = new Map<string, number>();
    return this.#requireClient().driver.pushEvents({
      driverInstanceId: this.payload.driverInstanceId,
      events: input.events.flatMap((event) =>
        toDriverEventEnvelopes(this.payload, event, this.#activeRunId, sourceEventIdOccurrences),
      ),
    });
  }

  async pushLogs(input: Omit<DriverLogBatchInput, "driverInstanceId">): Promise<void> {
    await this.#requireClient().driver.pushLogs({
      driverInstanceId: this.payload.driverInstanceId,
      logs: input.logs,
    });
  }

  async ready(input: Omit<DriverReadyInput, "driverInstanceId" | "pid">): Promise<void> {
    await this.#requireClient().driver.ready({
      at: input.at,
      driverInstanceId: this.payload.driverInstanceId,
      pid: process.pid,
    });
  }

  async watchCommands(): Promise<AsyncIterable<RuntimeCommand>> {
    return this.#requireClient().driverInstance.watchCommands();
  }

  async nextCommand(): Promise<RuntimeCommand | null> {
    const result = await this.#requireClient().driverInstance.nextCommand({
      driverInstanceId: this.payload.driverInstanceId,
    });

    return result.command;
  }

  #requireClient(): DriverRuntimeClient {
    if (!this.#client) {
      throw new Error("Driver instance socket is not connected.");
    }

    return this.#client;
  }
}

function readEventOccurredAt(event: DriverEventInput): number {
  const occurredAt = isRuntimeEventEnvelope(event) ? event.occurredAt : event.occurredAt;
  const timestamp = occurredAt === undefined ? Date.now() : Date.parse(occurredAt);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function readSourceEventId(event: DriverEventInput): string {
  if (isRuntimeEventEnvelope(event)) {
    return event.sourceEventId ?? event.id;
  }

  return event.sourceEventId ?? createDeterministicSourceEventId(event);
}

function addSourceEventIdOccurrence(
  sourceEventId: string,
  occurrences: Map<string, number>,
): string {
  const nextOccurrence = (occurrences.get(sourceEventId) ?? 0) + 1;
  occurrences.set(sourceEventId, nextOccurrence);

  return nextOccurrence === 1 ? sourceEventId : `${sourceEventId}:${nextOccurrence}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function createDeterministicSourceEventId(event: DriverEventInput): string {
  return `sha256:${createHash("sha256").update(stableJson(event)).digest("hex")}`;
}

function parseRunId(value: string): RunId {
  return parseDriverId(value, "Run ID") as RunId;
}

function readEventRunId(event: DriverEventInput, activeRunId: RunId | null): RunId | undefined {
  if (activeRunId !== null) {
    return activeRunId;
  }

  const eventRunId = isRuntimeEventEnvelope(event) ? event.runId : event.runId;

  return eventRunId === undefined ? undefined : parseRunId(eventRunId);
}

export function toDriverEventEnvelopes(
  payload: DriverBootPayload,
  event: DriverEventInput,
  activeRunId: RunId | null,
  sourceEventIdOccurrences = new Map<string, number>(),
): DriverEventEnvelope[] {
  const occurredAtMs = readEventOccurredAt(event);
  const sourceEventId = addSourceEventIdOccurrence(
    readSourceEventId(event),
    sourceEventIdOccurrences,
  );
  const occurredAt = new Date(occurredAtMs).toISOString();
  const runId = readEventRunId(event, activeRunId);

  return toRuntimeEventInput(
    {
      createId: () => createDriverId() as EventId,
      draftRunIdPolicy: "ignore",
      driverInstanceId: parseDriverId(
        payload.driverInstanceId,
        "Driver instance ID",
      ) as DriverInstanceId,
      occurredAt,
      runId,
      runtimeId: payload.runtime,
      sessionId: parseDriverId(
        payload.execution.configRevision.sessionId,
        "Session ID",
      ) as SessionId,
      sourceEventId,
    },
    event,
  ).map(
    (canonicalEvent): DriverEventEnvelope => ({
      event: canonicalEvent,
      eventId: canonicalEvent.sourceEventId ?? canonicalEvent.id,
      occurredAt: Date.parse(canonicalEvent.occurredAt),
    }),
  );
}
