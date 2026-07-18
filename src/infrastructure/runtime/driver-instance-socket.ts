import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { isDeepStrictEqual } from "node:util";

import {
  assertDriverEventReceiptPrefix,
  DriverEventRejectedError,
} from "../../core/driver-runtime-io";
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
  DriverHelloOutput,
  DriverLogBatchInput,
  DriverReadyInput,
  DriverRpcOptions,
} from "../../protocol/orpc";
import type { DriverRuntimeClient } from "../../protocol/orpc";
import type { RunError, RuntimeCommand, RuntimeCommandResult } from "../../runtime-command";
import { isRuntimeEventEnvelope, toRuntimeEventInput } from "../../runtime-events";
import { dialDriverControlSocket } from "./driver-control-dial";
import type { DriverWireSocket } from "./driver-control-dial";

interface DriverInstanceSocketHandlers {
  onClose: (code: number, reason: string) => void;
}

type RunTerminalDelivery =
  | {
      delivered: boolean;
      status: "completed";
      task?: Promise<void>;
    }
  | {
      delivered: boolean;
      error: DriverFailureInput["error"];
      status: "failed";
      task?: Promise<void>;
    };

const DRIVER_RPC_TIMEOUT_MS = 10_000;

export class DriverInstanceSocket {
  #activeRunId: RunId | null = null;
  #client: DriverRuntimeClient | null = null;
  #connectionGeneration = 0;
  #connectAbortController: AbortController | null = null;
  #eventBatchMaxSize: number | null = null;
  #rpcAbortController = new AbortController();
  #runTerminal: RunTerminalDelivery | null = null;
  private readonly handlers: DriverInstanceSocketHandlers;
  private readonly payload: DriverBootPayload;
  #socket: DriverWireSocket | null = null;

  constructor(payload: DriverBootPayload, handlers: DriverInstanceSocketHandlers) {
    this.handlers = handlers;
    this.payload = payload;
  }

  async connect(): Promise<void> {
    if (this.#connectAbortController !== null || this.#client !== null) {
      throw new Error("Driver instance socket has already started connecting.");
    }

    const controller = new AbortController();
    this.#connectAbortController = controller;
    let socket: DriverWireSocket;

    try {
      socket = await dialDriverControlSocket(this.payload, controller.signal);
    } finally {
      if (this.#connectAbortController === controller) {
        this.#connectAbortController = null;
      }
    }

    const generation = ++this.#connectionGeneration;
    this.#eventBatchMaxSize = null;
    this.#rpcAbortController = new AbortController();
    this.#socket = socket;
    this.#client = createORPCClient(
      new RPCLink({
        websocket: socket,
      }),
    ) as unknown as DriverRuntimeClient;

    socket.addEventListener("close", (event) => {
      if (generation !== this.#connectionGeneration || this.#socket !== socket) {
        return;
      }

      const code = event instanceof CloseEvent ? event.code : 1006;
      const reason = event instanceof CloseEvent ? event.reason : "runtime.socket.closed";
      this.#rpcAbortController.abort(new Error(reason || "runtime.socket.closed"));
      this.#client = null;
      this.#eventBatchMaxSize = null;
      this.#socket = null;
      this.handlers.onClose(code, reason);
    });
  }

  abortConnect(reason: string): void {
    this.#connectAbortController?.abort(new Error(reason));
  }

  abortPendingRequests(reason: string): void {
    const controller = this.#rpcAbortController;
    this.#rpcAbortController = new AbortController();
    controller.abort(new Error(reason));
  }

  close(code = 1000, reason = "runtime.socket.closed"): void {
    this.abortConnect(reason);
    this.#rpcAbortController.abort(new Error(reason));
    this.#client = null;
    this.#eventBatchMaxSize = null;
    const socket = this.#socket;
    socket?.close(code, reason);

    if (this.#socket === socket) {
      this.#socket = null;
    }
  }

  beginRun(runId: RunId): void {
    this.#activeRunId = runId;
    this.#runTerminal = null;
  }

  endRun(runId: RunId): void {
    if (this.#activeRunId === runId) {
      this.#activeRunId = null;
    }
  }

  currentRunId(): RunId | null {
    return this.#activeRunId;
  }

  async commandUpdate(
    input: {
      commandId: string;
      error?: RunError;
      result?: RuntimeCommandResult;
      status: "accepted" | "cancelled" | "completed" | "delivered" | "expired" | "failed";
    },
    signal: AbortSignal,
  ): Promise<void> {
    await this.#requireClient().driver.commandUpdate(
      {
        commandId: input.commandId,
        driverInstanceId: this.payload.driverInstanceId,
        ...(input.error === undefined ? {} : { error: input.error }),
        status: input.status,
        ...(input.result === undefined ? {} : { result: input.result }),
      },
      this.#rpcOptions(signal),
    );
  }

  completeRun(signal?: AbortSignal): Promise<void> {
    return this.#deliverRunTerminal("completed", undefined, signal);
  }

  failRun(error: DriverFailureInput["error"], signal?: AbortSignal): Promise<void> {
    return this.#deliverRunTerminal("failed", error, signal);
  }

  async heartbeat(input: Omit<DriverHeartbeatInput, "pid">): Promise<DriverHeartbeatOutput> {
    return this.#requireClient().driver.heartbeat(
      {
        at: input.at,
        pid: process.pid,
        reason: input.reason,
      },
      this.#rpcOptions(),
    );
  }

  async hello(
    input: Omit<DriverHelloInput, "pid" | "runtime" | "startedAt"> & {
      startedAt: string;
    },
  ): Promise<DriverHelloOutput> {
    const generation = this.#connectionGeneration;
    const client = this.#requireClient();
    const result = await client.driver.hello(
      {
        capabilities: input.capabilities,
        driverVersion: input.driverVersion,
        pid: process.pid,
        protocolVersion: input.protocolVersion,
        runtime: this.payload.runtime,
        startedAt: input.startedAt,
      },
      this.#rpcOptions(),
    );

    if (generation !== this.#connectionGeneration || client !== this.#client) {
      throw new Error("Driver socket connection changed during hello.");
    }

    if (!Number.isSafeInteger(result.heartbeatIntervalMs) || result.heartbeatIntervalMs < 250) {
      throw new Error("Driver heartbeat interval must be an integer of at least 250ms.");
    }

    if (
      !Number.isSafeInteger(result.runConfig.eventBatchMaxSize) ||
      result.runConfig.eventBatchMaxSize < 1
    ) {
      throw new Error("Driver event batch max size must be a positive integer.");
    }

    this.#eventBatchMaxSize = result.runConfig.eventBatchMaxSize;
    return result;
  }

  async pushEvents(input: {
    events: DriverEventInput[];
    signal?: AbortSignal;
  }): Promise<DriverEventBatchOutput> {
    input.signal?.throwIfAborted();
    const maxBatchSize = this.#eventBatchMaxSize;

    if (maxBatchSize === null) {
      throw new Error("Driver hello must complete before events are pushed.");
    }

    const events = input.events.flatMap((event) =>
      toDriverEventEnvelopes(this.payload, event, this.#activeRunId),
    );
    const accepted: DriverEventBatchOutput["accepted"][number][] = [];
    const delivery = events[0]?.event.delivery;

    if (events.some((envelope) => envelope.event.delivery !== delivery)) {
      throw new Error("Driver event batches cannot mix lossless and best-effort delivery.");
    }
    const rpcOptions = this.#rpcOptions(input.signal);

    for (let index = 0; index < events.length; index += maxBatchSize) {
      let remaining = events.slice(index, index + maxBatchSize);

      while (remaining.length > 0) {
        const result = await this.#requireClient().driver.pushEvents(
          {
            driverInstanceId: this.payload.driverInstanceId,
            events: remaining,
          },
          rpcOptions,
        );

        assertDriverEventReceiptPrefix(
          remaining.map((envelope) => envelope.event),
          result.accepted,
        );

        if (result.accepted.length === 0) {
          if (delivery === "best_effort") {
            return { accepted };
          }

          throw new Error("Driver event delivery made no progress.");
        }

        accepted.push(...result.accepted);

        if (delivery === "best_effort" && result.accepted.length < remaining.length) {
          return { accepted };
        }

        remaining = remaining.slice(result.accepted.length);
      }
    }

    return { accepted };
  }

  async pushLogs(input: Omit<DriverLogBatchInput, "driverInstanceId">): Promise<void> {
    await this.#requireClient().driver.pushLogs(
      {
        driverInstanceId: this.payload.driverInstanceId,
        logs: input.logs,
      },
      this.#rpcOptions(),
    );
  }

  async ready(input: Omit<DriverReadyInput, "driverInstanceId" | "pid">): Promise<void> {
    await this.#requireClient().driver.ready(
      {
        at: input.at,
        driverInstanceId: this.payload.driverInstanceId,
        pid: process.pid,
      },
      this.#rpcOptions(),
    );
  }

  async nextCommand(signal: AbortSignal): Promise<RuntimeCommand | null> {
    const result = await this.#requireClient().driverInstance.nextCommand(
      {
        driverInstanceId: this.payload.driverInstanceId,
      },
      this.#rpcOptions(signal),
    );

    return result.command;
  }

  #deliverRunTerminal(
    status: "completed" | "failed",
    error?: DriverFailureInput["error"],
    signal?: AbortSignal,
  ): Promise<void> {
    let terminal = this.#runTerminal;

    if (terminal === null) {
      if (status === "failed" && error === undefined) {
        return Promise.reject(new Error("Failed run terminal requires an error."));
      }

      terminal =
        status === "completed"
          ? { delivered: false, status }
          : { delivered: false, error: structuredClone(error!), status };
      this.#runTerminal = terminal;
    }

    if (terminal.status !== status) {
      return Promise.resolve();
    }
    if (
      terminal.status === "failed" &&
      (error === undefined || !isDeepStrictEqual(terminal.error, error))
    ) {
      return Promise.reject(new Error("Failed run terminal was retried with a different error."));
    }
    if (terminal.delivered) {
      return Promise.resolve();
    }
    if (terminal.task !== undefined) {
      return terminal.task;
    }

    const client = this.#client;
    const generation = this.#connectionGeneration;
    const options = this.#rpcOptions(signal);
    const task = Promise.resolve().then(async () => {
      if (client === null) {
        throw new Error("Driver instance socket is not connected.");
      }

      if (terminal.status === "completed") {
        await client.driver.completeRun(
          { driverInstanceId: this.payload.driverInstanceId },
          options,
        );
      } else {
        await client.driver.failRun(
          {
            driverInstanceId: this.payload.driverInstanceId,
            error: structuredClone(terminal.error),
          },
          options,
        );
      }

      if (generation !== this.#connectionGeneration || client !== this.#client) {
        throw new Error("Driver socket connection changed during run terminal delivery.");
      }
    });
    terminal.task = task;
    void task.then(
      () => {
        if (terminal.task === task) {
          terminal.delivered = true;
          delete terminal.task;
        }
      },
      () => {
        if (terminal.task === task) {
          delete terminal.task;
        }
      },
    );
    return task;
  }

  #requireClient(): DriverRuntimeClient {
    if (!this.#client) {
      throw new Error("Driver instance socket is not connected.");
    }

    return this.#client;
  }

  #rpcOptions(signal?: AbortSignal): DriverRpcOptions {
    return {
      signal: AbortSignal.any([
        this.#rpcAbortController.signal,
        signal ?? AbortSignal.timeout(DRIVER_RPC_TIMEOUT_MS),
      ]),
    };
  }
}

function readExplicitSourceEventId(event: DriverEventInput): string | undefined {
  return typeof event.sourceEventId === "string" && event.sourceEventId.length > 0
    ? event.sourceEventId
    : undefined;
}

function parseRunId(value: string): RunId {
  return parseDriverId(value, "Run ID") as RunId;
}

function readEventRunId(event: DriverEventInput, activeRunId: RunId | null): RunId | undefined {
  const { runId: eventRunId } = event;

  return eventRunId === undefined ? (activeRunId ?? undefined) : parseRunId(eventRunId);
}

export function toDriverEventEnvelopes(
  payload: DriverBootPayload,
  event: DriverEventInput,
  activeRunId: RunId | null,
): DriverEventEnvelope[] {
  const sourceEventId = readExplicitSourceEventId(event) ?? createDriverId();

  try {
    if (isRuntimeEventEnvelope(event)) {
      throw new Error("Driver event uplink accepts drafts only.");
    }

    const occurredAt = event.occurredAt ?? new Date().toISOString();
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
        occurredAt: canonicalEvent.occurredAt,
      }),
    );
  } catch (error) {
    throw new DriverEventRejectedError(sourceEventId, error);
  }
}
