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
import { dialDriverControlSocket } from "./driver-control-dial";
import type { DriverWireSocket } from "./driver-control-dial";

interface DriverInstanceSocketHandlers {
  onClose: (code: number, reason: string) => void;
}

export class DriverInstanceSocket {
  #activeRunId: RunId | null = null;
  #client: DriverRuntimeClient | null = null;
  readonly #sourceEventIdAllocator: DriverEventSourceIdAllocator;
  private readonly handlers: DriverInstanceSocketHandlers;
  private readonly payload: DriverBootPayload;
  #socket: DriverWireSocket | null = null;

  constructor(payload: DriverBootPayload, handlers: DriverInstanceSocketHandlers) {
    this.handlers = handlers;
    this.payload = payload;
    this.#sourceEventIdAllocator = new DriverEventSourceIdAllocator(payload.driverInstanceId);
  }

  async connect(): Promise<void> {
    const socket = await dialDriverControlSocket(this.payload);
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
    return this.#requireClient().driver.pushEvents({
      driverInstanceId: this.payload.driverInstanceId,
      events: input.events.flatMap((event) =>
        toDriverEventEnvelopes(
          this.payload,
          event,
          this.#activeRunId,
          this.#sourceEventIdAllocator.sourceEventIdFor(event),
        ),
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

/**
 * Assigns a stable source identity to draft events that do not already carry
 * one. A publisher retries the same draft object after a transport failure, so
 * the WeakMap keeps that retry idempotent. A distinct later draft with identical
 * text receives a new identity instead of being mistaken for a replay. The boot
 * identity prevents a replacement process from restarting the sequence in the
 * same driver-instance namespace.
 */
export class DriverEventSourceIdAllocator {
  readonly #sourceEventIds = new WeakMap<object, string>();
  #nextSourceEventSequence = 0;
  private readonly prefix: string;

  constructor(driverInstanceId: DriverInstanceId, bootId: string = createDriverId()) {
    this.prefix = `driver:${driverInstanceId}:${bootId}:event`;
  }

  sourceEventIdFor(event: DriverEventInput): string | undefined {
    if (isRuntimeEventEnvelope(event) || readExplicitSourceEventId(event) !== undefined) {
      return undefined;
    }

    const existing = this.#sourceEventIds.get(event);

    if (existing !== undefined) {
      return existing;
    }

    this.#nextSourceEventSequence += 1;
    const sourceEventId = `${this.prefix}:${this.#nextSourceEventSequence}`;
    this.#sourceEventIds.set(event, sourceEventId);
    return sourceEventId;
  }
}

function readExplicitSourceEventId(event: DriverEventInput): string | undefined {
  return typeof event.sourceEventId === "string" && event.sourceEventId.length > 0
    ? event.sourceEventId
    : undefined;
}

function readEventOccurredAt(event: DriverEventInput): number {
  const occurredAt = isRuntimeEventEnvelope(event) ? event.occurredAt : event.occurredAt;
  const timestamp = occurredAt === undefined ? Date.now() : Date.parse(occurredAt);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function readSourceEventId(event: DriverEventInput, generatedSourceEventId?: string): string {
  if (isRuntimeEventEnvelope(event)) {
    return readExplicitSourceEventId(event) ?? event.id;
  }

  const sourceEventId = readExplicitSourceEventId(event) ?? generatedSourceEventId;

  if (sourceEventId === undefined) {
    throw new Error("Driver draft event must have an allocated source event ID.");
  }

  return sourceEventId;
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
  generatedSourceEventId?: string,
): DriverEventEnvelope[] {
  const occurredAtMs = readEventOccurredAt(event);
  const sourceEventId = readSourceEventId(event, generatedSourceEventId);
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
