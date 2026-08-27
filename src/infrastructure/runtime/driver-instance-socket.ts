import { isDeepStrictEqual } from "node:util";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";

import { assertDriverEventReceiptPrefix } from "../../core/driver-runtime-io";
import type { DriverBootPayload } from "../../protocol/boot";
import type { DriverEventEnvelope, DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import type {
  DriverFailureInput,
  DriverEventBatchOutput,
  DriverExternalToolEffectClaimOutput,
  DriverHeartbeatInput,
  DriverHeartbeatOutput,
  DriverHelloInput,
  DriverHelloOutput,
  DriverLogBatchInput,
  DriverReadyInput,
  DriverRpcOptions,
} from "../../protocol/orpc";
import type { DriverRuntimeClient } from "../../protocol/orpc";
import type {
  McpExecuteCommandResult,
  McpExternalToolEffectClaim,
  RunError,
  RuntimeCommand,
  RuntimeCommandResult,
} from "../../runtime-command";
import { parseRuntimeCommand } from "../../runtime-command";
import { raceWithAbort } from "../../utils/async";
import { dialDriverControlSocket } from "./driver-control-dial";
import type { DriverWireSocket } from "./driver-control-dial";
import { toDriverEventEnvelopes } from "./driver-event-envelope";

export { toDriverEventEnvelopes } from "./driver-event-envelope";

interface DriverInstanceSocketHandlers {
  onClose: (code: number, reason: string) => void;
}

type RunTerminalDelivery =
  | {
      delivered: boolean;
      readonly runGeneration: number;
      status: "completed";
      task?: Promise<void>;
    }
  | {
      delivered: boolean;
      error: DriverFailureInput["error"];
      readonly runGeneration: number;
      status: "failed";
      task?: Promise<void>;
    };

type RunEventTerminalStatus = "cancelled" | "completed" | "failed";

interface RunEventTerminalSelection {
  delivered: boolean;
  readonly event: Pick<DriverEventEnvelope["event"], "kind" | "payload">;
  readonly runId: RunId;
  readonly status: RunEventTerminalStatus;
  task?: Promise<DriverEventBatchOutput>;
}

interface PreparedEventPush {
  readonly client: DriverRuntimeClient;
  readonly delivery: DriverEventEnvelope["event"]["delivery"] | undefined;
  readonly events: DriverEventEnvelope[];
  readonly generation: number;
  readonly hasRunScopedEvent: boolean;
  readonly maxBatchSize: number;
  readonly runGeneration: number;
  readonly selection: RunEventTerminalSelection | null;
  readonly signal: AbortSignal | undefined;
}

const DRIVER_RPC_TIMEOUT_MS = 10_000;
const MAX_WEBSOCKET_CLOSE_REASON_BYTES = 123;

function toWebSocketCloseReason(reason: string): string {
  let bytes = 0;
  let result = "";

  for (const character of reason) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > MAX_WEBSOCKET_CLOSE_REASON_BYTES) {
      break;
    }
    bytes += characterBytes;
    result += character;
  }

  return result;
}

export class DriverInstanceSocket {
  #activeRunId: RunId | null = null;
  #client: DriverRuntimeClient | null = null;
  #connectionGeneration = 0;
  #connectAbortController: AbortController | null = null;
  #deliveryTail: Promise<void> = Promise.resolve();
  #eventBatchMaxSize: number | null = null;
  #rpcAbortController = new AbortController();
  #runGeneration = 0;
  #runEventTerminal: RunEventTerminalSelection | null = null;
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
    socket?.close(code, toWebSocketCloseReason(reason));

    if (this.#socket === socket) {
      this.#socket = null;
    }
  }

  beginRun(runId: RunId): void {
    if (this.#activeRunId !== null) {
      throw new Error("Cannot begin a run while another run is active.");
    }
    if (this.#runTerminal !== null) {
      throw new Error("Cannot begin a run after a control terminal has been selected.");
    }

    this.#runGeneration += 1;
    this.#activeRunId = runId;
    this.#runEventTerminal = null;
  }

  endRun(runId: RunId): void {
    if (this.#activeRunId === runId) {
      this.#runGeneration += 1;
      this.#activeRunId = null;
    }
  }

  currentRunId(): RunId | null {
    return this.#activeRunId;
  }

  runEventTerminal(runId: RunId): "cancelled" | "completed" | "failed" | null {
    const terminal = this.#runEventTerminal;
    return terminal?.runId === runId && terminal.delivered ? terminal.status : null;
  }

  selectedRunEventTerminal(runId: RunId): "cancelled" | "completed" | "failed" | null {
    const terminal = this.#runEventTerminal;
    return terminal?.runId === runId ? terminal.status : null;
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

  async claimExternalToolEffect(
    input: { commandId: string },
    signal: AbortSignal,
  ): Promise<McpExternalToolEffectClaim> {
    const result: DriverExternalToolEffectClaimOutput =
      await this.#requireClient().driver.claimExternalToolEffect(
        {
          commandId: input.commandId,
          driverInstanceId: this.payload.driverInstanceId,
        },
        this.#rpcOptions(signal),
      );

    return result;
  }

  async completeExternalToolEffect(
    input: {
      commandId: string;
      providerReceiptJson?: string | null | undefined;
      result: McpExecuteCommandResult;
    },
    signal: AbortSignal,
  ): Promise<void> {
    await this.#requireClient().driver.completeExternalToolEffect(
      {
        commandId: input.commandId,
        driverInstanceId: this.payload.driverInstanceId,
        ...(input.providerReceiptJson === undefined
          ? {}
          : { providerReceiptJson: input.providerReceiptJson }),
        result: input.result,
      },
      this.#effectSettlementRpcOptions(signal),
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
    const prepared = this.#prepareEventPush(input);
    const task = this.#enqueueDelivery(() => this.#deliverEventPush(prepared), input.signal);
    const selection = prepared.selection;

    if (selection !== null) {
      selection.task = task;
    }

    try {
      const result = await task;
      if (
        selection !== null &&
        result.accepted.length === prepared.events.length &&
        this.#runEventTerminal === selection
      ) {
        selection.delivered = true;
      }
      return result;
    } finally {
      if (selection?.task === task) {
        delete selection.task;
      }
    }
  }

  #prepareEventPush(input: {
    events: DriverEventInput[];
    signal?: AbortSignal;
  }): PreparedEventPush {
    input.signal?.throwIfAborted();
    const maxBatchSize = this.#eventBatchMaxSize;

    if (maxBatchSize === null) {
      throw new Error("Driver hello must complete before events are pushed.");
    }

    const activeRunId = this.#activeRunId;
    const events = structuredClone(input.events).flatMap((event) =>
      toDriverEventEnvelopes(this.payload, event, activeRunId),
    );
    const delivery = events[0]?.event.delivery;
    let terminal: {
      event: Pick<DriverEventEnvelope["event"], "kind" | "payload">;
      runId: RunId;
      status: RunEventTerminalStatus;
    } | null = null;
    let terminalIndex = -1;
    let hasRunScopedEvent = false;

    if (events.some((envelope) => envelope.event.delivery !== delivery)) {
      throw new Error("Driver event batches cannot mix lossless and best-effort delivery.");
    }

    for (const [index, { event }] of events.entries()) {
      if (event.runId !== undefined) {
        if (event.runId !== activeRunId) {
          throw new Error("Driver event must target the active run.");
        }
        hasRunScopedEvent = true;
      }

      const status =
        event.kind === "run.cancelled"
          ? "cancelled"
          : event.kind === "run.completed"
            ? "completed"
            : event.kind === "run.failed"
              ? "failed"
              : null;

      if (status === null) {
        continue;
      }
      if (event.runId === undefined) {
        throw new Error("Driver run terminal must target a run.");
      }
      if (terminal !== null) {
        throw new Error("Driver event batch cannot contain multiple run terminals.");
      }

      terminal = {
        event: { kind: event.kind, payload: structuredClone(event.payload) },
        runId: event.runId,
        status,
      };
      terminalIndex = index;
    }

    if (terminalIndex >= 0 && terminalIndex !== events.length - 1) {
      throw new Error("Driver run terminal must be the final event in its batch.");
    }
    if (terminal !== null && delivery === "best_effort") {
      throw new Error("Driver run terminal must use lossless delivery.");
    }

    let selection: RunEventTerminalSelection | null = null;
    if (hasRunScopedEvent && this.#runEventTerminal !== null) {
      const selected = this.#runEventTerminal;
      const retryingSelectedEvent =
        events.length === 1 &&
        terminal !== null &&
        selected !== null &&
        !selected.delivered &&
        selected.task === undefined &&
        selected.runId === terminal.runId &&
        selected.status === terminal.status &&
        isDeepStrictEqual(selected.event, terminal.event);

      if (!retryingSelectedEvent) {
        throw new Error("Driver event cannot target a terminated run.");
      }
      selection = selected;
    } else if (terminal !== null) {
      selection = {
        delivered: false,
        event: terminal.event,
        runId: terminal.runId,
        status: terminal.status,
      };
      this.#runEventTerminal = selection;
    }

    return {
      client: this.#requireClient(),
      delivery,
      events,
      generation: this.#connectionGeneration,
      hasRunScopedEvent,
      maxBatchSize,
      runGeneration: this.#runGeneration,
      selection,
      signal: input.signal,
    };
  }

  async #deliverEventPush(prepared: PreparedEventPush): Promise<DriverEventBatchOutput> {
    const { client, delivery, events, generation, maxBatchSize, signal } = prepared;
    const accepted: DriverEventBatchOutput["accepted"][number][] = [];
    this.#assertConnection(client, generation, "event delivery");
    this.#assertRunGeneration(prepared);
    const rpcOptions = this.#rpcOptions(signal);

    for (let index = 0; index < events.length; index += maxBatchSize) {
      let remaining = events.slice(index, index + maxBatchSize);

      while (remaining.length > 0) {
        const result = await client.driver.pushEvents(
          {
            driverInstanceId: this.payload.driverInstanceId,
            events: remaining,
          },
          rpcOptions,
        );
        this.#assertConnection(client, generation, "event delivery");
        this.#assertRunGeneration(prepared);

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
    const rpcAbortSignal = this.#rpcAbortController.signal;
    const timeoutSignal = AbortSignal.timeout(DRIVER_RPC_TIMEOUT_MS);
    let result: Awaited<ReturnType<DriverRuntimeClient["driverInstance"]["nextCommand"]>>;

    try {
      result = await this.#requireClient().driverInstance.nextCommand(
        {
          driverInstanceId: this.payload.driverInstanceId,
        },
        this.#rpcOptions(signal, timeoutSignal),
      );
    } catch (error) {
      if (
        timeoutSignal.aborted &&
        error === timeoutSignal.reason &&
        !rpcAbortSignal.aborted &&
        !signal.aborted
      ) {
        return null;
      }

      throw error;
    }

    return result.command === null ? null : parseRuntimeCommand(result.command);
  }

  async markExternalToolEffectUnknown(
    input: { commandId: string },
    signal: AbortSignal,
  ): Promise<void> {
    await this.#requireClient().driver.markExternalToolEffectUnknown(
      {
        commandId: input.commandId,
        driverInstanceId: this.payload.driverInstanceId,
      },
      this.#effectSettlementRpcOptions(signal),
    );
  }

  #deliverRunTerminal(
    status: "completed" | "failed",
    error?: DriverFailureInput["error"],
    signal?: AbortSignal,
  ): Promise<void> {
    if (status === "failed" && error === undefined) {
      return Promise.reject(new Error("Failed run terminal requires an error."));
    }

    let terminal = this.#runTerminal;

    if (terminal === null) {
      terminal =
        status === "completed"
          ? { delivered: false, runGeneration: this.#runGeneration, status }
          : {
              delivered: false,
              error: structuredClone(error!),
              runGeneration: this.#runGeneration,
              status,
            };
      this.#runTerminal = terminal;
    }

    if (terminal.status !== status) {
      return Promise.resolve();
    }
    if (terminal.status === "failed" && !isDeepStrictEqual(terminal.error, error)) {
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
    const task = this.#enqueueDelivery(async () => {
      if (client === null) {
        throw new Error("Driver instance socket is not connected.");
      }
      this.#assertConnection(client, generation, "run terminal delivery");
      this.#assertRunTerminal(terminal);
      const options = this.#rpcOptions(signal);

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

      this.#assertConnection(client, generation, "run terminal delivery");
      this.#assertRunTerminal(terminal);
    }, signal);
    terminal.task = task;
    void task.then(
      () => {
        if (this.#runTerminal === terminal && terminal.task === task) {
          terminal.delivered = true;
          delete terminal.task;
        }
      },
      () => {
        if (this.#runTerminal === terminal && terminal.task === task) {
          delete terminal.task;
        }
      },
    );
    return task;
  }

  #assertConnection(client: DriverRuntimeClient, generation: number, operation: string): void {
    if (generation !== this.#connectionGeneration || client !== this.#client) {
      throw new Error(`Driver socket connection changed during ${operation}.`);
    }
  }

  #assertRunGeneration(prepared: PreparedEventPush): void {
    if (prepared.hasRunScopedEvent && prepared.runGeneration !== this.#runGeneration) {
      throw new Error("Driver active run changed during event delivery.");
    }
  }

  #assertRunTerminal(terminal: RunTerminalDelivery): void {
    if (terminal.runGeneration !== this.#runGeneration || this.#runTerminal !== terminal) {
      throw new Error("Driver active run changed during run terminal delivery.");
    }
  }

  #enqueueDelivery<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const predecessor = this.#deliveryTail;
    const slot = Promise.withResolvers<void>();
    this.#deliveryTail = predecessor.then(
      () => slot.promise,
      () => slot.promise,
    );

    return (async () => {
      let acquired = false;

      try {
        await raceWithAbort(predecessor, signal);
        acquired = true;
        return await operation();
      } finally {
        if (acquired) {
          slot.resolve();
        } else {
          void predecessor.then(
            () => slot.resolve(),
            () => slot.resolve(),
          );
        }
      }
    })();
  }

  #requireClient(): DriverRuntimeClient {
    if (!this.#client) {
      throw new Error("Driver instance socket is not connected.");
    }

    return this.#client;
  }

  #rpcOptions(
    signal?: AbortSignal,
    timeoutSignal = AbortSignal.timeout(DRIVER_RPC_TIMEOUT_MS),
  ): DriverRpcOptions {
    return {
      signal: AbortSignal.any([
        this.#rpcAbortController.signal,
        ...(signal === undefined ? [] : [signal]),
        timeoutSignal,
      ]),
    };
  }

  #effectSettlementRpcOptions(signal: AbortSignal): DriverRpcOptions {
    return {
      signal: AbortSignal.any([signal, AbortSignal.timeout(DRIVER_RPC_TIMEOUT_MS)]),
    };
  }
}
