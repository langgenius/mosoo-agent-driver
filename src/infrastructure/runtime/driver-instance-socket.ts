import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";

import {
  assertDriverEventReceiptPrefix,
  assertIsolatedRunTerminalBatch,
} from "../../core/driver-runtime-io";
import type { DriverRuntimeIo } from "../../core/driver-runtime-io";
import type { DriverRunTerminalBarrier } from "../../core/driver-runtime-io";
import {
  DriverTerminalStateMachine,
  type DriverInputOutcome,
  type DriverInputSettlement,
  type DriverInstanceTerminal,
  type DriverRunSnapshot,
  type DriverRunTerminalIdentity,
  type DriverRunTicket,
} from "../../core/driver-terminal-state";
import type { DriverBootPayload } from "../../protocol/boot";
import type { DriverEventEnvelope, DriverEventInput } from "../../protocol/events";
import { parseRunId } from "../../protocol/id";
import type { RunId } from "../../protocol/id";
import { driverRuntimeRpcSchemas } from "../../protocol/orpc";
import type {
  DriverFailureInput,
  DriverEventBatchOutput,
  DriverExternalToolEffectClaimOutput,
  DriverExternalToolEffectState,
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
  DriverCommandUpdate,
  McpExternalToolEffectClaim,
  McpExternalToolEffectState,
  RuntimeCommand,
} from "../../runtime-command";
import { normalizeDurableRunError } from "../../runtime-command";
import { raceWithAbort } from "../../utils/async";
import { dialDriverControlSocket } from "./driver-control-dial";
import type { DriverWireSocket } from "./driver-control-dial";
import { toDriverEventEnvelopes } from "./driver-event-envelope";

export { toDriverEventEnvelopes } from "./driver-event-envelope";

interface DriverInstanceSocketHandlers {
  onClose: (code: number, reason: string) => void;
}

interface PreparedEventPush {
  readonly client: DriverRuntimeClient;
  readonly delivery: DriverEventEnvelope["event"]["delivery"] | undefined;
  readonly events: DriverEventEnvelope[];
  readonly generation: number;
  readonly hasRunScopedEvent: boolean;
  readonly maxBatchSize: number;
  readonly runTicket: DriverRunTicket | null;
  readonly terminal: DriverRunTerminalIdentity | null;
  readonly terminalSelection: "acked" | "pending" | "selected" | null;
  readonly signal: AbortSignal | undefined;
}

interface RunEventTerminalTask {
  readonly task: Promise<DriverEventBatchOutput["accepted"][number]>;
  readonly ticket: DriverRunTicket;
}

const DRIVER_RPC_TIMEOUT_MS = 10_000;
const MAX_WEBSOCKET_CLOSE_REASON_BYTES = 123;

function toWebSocketCloseReason(reason: string): string {
  const { read } = new TextEncoder().encodeInto(
    reason,
    new Uint8Array(MAX_WEBSOCKET_CLOSE_REASON_BYTES),
  );
  return reason.slice(0, read);
}

export class DriverInstanceSocket {
  #activeRunTicket: DriverRunTicket | null = null;
  #client: DriverRuntimeClient | null = null;
  #connectionGeneration = 0;
  #connectAbortController: AbortController | null = null;
  #deliveryTail: Promise<void> = Promise.resolve();
  #eventBatchMaxSize: number | null = null;
  #rpcAbortController = new AbortController();
  #instanceTerminalTask: Promise<void> | null = null;
  #runEventTerminalTask: RunEventTerminalTask | null = null;
  #runTerminalBarrier: DriverRunTerminalBarrier | null = null;
  readonly #terminalState = new DriverTerminalStateMachine();
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
    this.#client = createORPCClient<DriverRuntimeClient>(
      new RPCLink({
        websocket: socket,
      }),
    );

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

  beginRun(runId: RunId): DriverRunTicket {
    const ticket = this.#terminalState.beginRun(runId);
    this.#activeRunTicket = ticket;
    return ticket;
  }

  claimRunCancellation(
    ticket: DriverRunTicket,
    reason: string,
    source?: Parameters<DriverRuntimeIo["claimRunCancellation"]>[2],
  ): "already_claimed" | "claimed" | "terminal_selected" {
    return this.#terminalState.claimCancellation(ticket, reason, source);
  }

  releaseRun(ticket: DriverRunTicket, reason: "command_acked" | "driver_failing"): void {
    this.#terminalState.releaseRun(ticket, reason);
    if (this.#activeRunTicket === ticket) {
      this.#activeRunTicket = null;
      this.#runEventTerminalTask = null;
    }
  }

  currentRunId(): RunId | null {
    return this.#terminalState.currentRunId();
  }

  runSnapshot(runId?: RunId): DriverRunSnapshot | null {
    return this.#terminalState.snapshotRun(runId);
  }

  settleRunInput(ticket: DriverRunTicket, outcome: DriverInputOutcome): DriverInputSettlement {
    return this.#terminalState.settleInput(ticket, outcome);
  }

  async commandUpdate(input: DriverCommandUpdate, signal: AbortSignal): Promise<void> {
    const update =
      input.status === "failed"
        ? { ...input, error: normalizeDurableRunError(input.error) }
        : input;
    driverRuntimeRpcSchemas.driver.commandUpdate.output.parse(
      await this.#requireClient().driver.commandUpdate(
        {
          ...update,
          driverInstanceId: this.payload.driverInstanceId,
        },
        this.#rpcOptions(signal),
      ),
    );
  }

  async claimExternalToolEffect(
    input: { claimToken: string; commandId: string },
    signal: AbortSignal,
  ): Promise<McpExternalToolEffectClaim> {
    const result: DriverExternalToolEffectClaimOutput =
      driverRuntimeRpcSchemas.driver.claimExternalToolEffect.output.parse(
        await this.#requireClient().driver.claimExternalToolEffect(
          {
            claimToken: input.claimToken,
            commandId: input.commandId,
            driverInstanceId: this.payload.driverInstanceId,
          },
          this.#rpcOptions(signal),
        ),
      );

    return result;
  }

  async observeExternalToolEffect(
    input: Parameters<DriverRuntimeIo["observeExternalToolEffect"]>[0],
    signal: AbortSignal,
  ): Promise<McpExternalToolEffectState> {
    const result: DriverExternalToolEffectState =
      driverRuntimeRpcSchemas.driver.observeExternalToolEffect.output.parse(
        await this.#requireClient().driver.observeExternalToolEffect(
          {
            commandId: input.commandId,
            driverInstanceId: this.payload.driverInstanceId,
          },
          this.#rpcOptions(signal),
        ),
      );

    return result;
  }

  async settleExternalToolEffect(
    input: Parameters<DriverRuntimeIo["settleExternalToolEffect"]>[0],
    signal: AbortSignal,
  ): Promise<McpExternalToolEffectState> {
    const result: DriverExternalToolEffectState =
      driverRuntimeRpcSchemas.driver.settleExternalToolEffect.output.parse(
        await this.#requireClient().driver.settleExternalToolEffect(
          {
            claimToken: input.claimToken,
            commandId: input.commandId,
            driverInstanceId: this.payload.driverInstanceId,
            effectId: input.effectId,
            settlement: input.settlement,
          },
          this.#effectSettlementRpcOptions(signal),
        ),
      );

    return result;
  }

  completeRun(signal?: AbortSignal): Promise<void> {
    return this.#deliverRunTerminal("completed", undefined, signal);
  }

  failRun(error: DriverFailureInput["error"], signal?: AbortSignal): Promise<void> {
    return this.#deliverRunTerminal("failed", error, signal);
  }

  async heartbeat(input: Omit<DriverHeartbeatInput, "pid">): Promise<DriverHeartbeatOutput> {
    return driverRuntimeRpcSchemas.driver.heartbeat.output.parse(
      await this.#requireClient().driver.heartbeat(
        {
          at: input.at,
          pid: process.pid,
          reason: input.reason,
        },
        this.#rpcOptions(),
      ),
    );
  }

  async hello(
    input: Omit<DriverHelloInput, "pid" | "runtime" | "startedAt"> & {
      startedAt: string;
    },
  ): Promise<DriverHelloOutput> {
    const generation = this.#connectionGeneration;
    const client = this.#requireClient();
    const result = driverRuntimeRpcSchemas.driver.hello.output.parse(
      await client.driver.hello(
        {
          capabilities: input.capabilities,
          driverVersion: input.driverVersion,
          pid: process.pid,
          protocolVersion: input.protocolVersion,
          runtime: this.payload.runtime,
          startedAt: input.startedAt,
        },
        this.#rpcOptions(),
      ),
    );

    if (generation !== this.#connectionGeneration || client !== this.#client) {
      throw new Error("Driver socket connection changed during hello.");
    }

    if (result.runId !== null) {
      this.#terminalState.rememberOwnedRunId(parseRunId(result.runId));
    }
    this.#eventBatchMaxSize = result.runConfig.eventBatchMaxSize;
    return result;
  }

  async pushEvents(input: {
    events: DriverEventInput[];
    signal?: AbortSignal;
  }): Promise<DriverEventBatchOutput> {
    input.signal?.throwIfAborted();
    const ownedInput = { ...input, events: structuredClone(input.events) };
    assertIsolatedRunTerminalBatch(ownedInput.events);
    const barrier = this.#runTerminalBarrier;
    if (barrier !== null) {
      const pending = barrier(ownedInput.events);
      if (pending !== undefined) {
        await pending;
      }
    }
    const prepared = this.#prepareEventPush(ownedInput);
    const { runTicket, terminal, terminalSelection } = prepared;

    if (terminalSelection === "acked") {
      const snapshot = this.#terminalState.snapshotRun(terminal!.runId);
      const receipt = snapshot?.terminal?.phase === "acked" ? snapshot.terminal.receipt : null;
      if (receipt === null) {
        throw new Error("Driver run terminal acknowledgement is unavailable.");
      }
      return { accepted: [receipt] };
    }

    if (terminalSelection === "pending" && this.#runEventTerminalTask !== null) {
      if (this.#runEventTerminalTask.ticket !== runTicket) {
        throw new Error("Driver active run changed during terminal delivery.");
      }
      return { accepted: [await this.#runEventTerminalTask.task] };
    }

    const task = this.#enqueueDelivery(() => this.#deliverEventPush(prepared), input.signal);
    const terminalTask =
      terminal === null || runTicket === null
        ? null
        : {
            task: task.then((result) => {
              if (result.accepted.length !== prepared.events.length) {
                throw new Error("Driver run terminal batch was not fully acknowledged.");
              }
              const receipt = result.accepted.at(-1);
              if (receipt === undefined) {
                throw new Error("Driver run terminal receipt is missing.");
              }
              this.#terminalState.ackRunTerminal(runTicket, receipt);
              return receipt;
            }),
            ticket: runTicket,
          };

    if (terminalTask !== null) {
      this.#runEventTerminalTask = terminalTask;
      void terminalTask.task.catch(() => {});
    }

    try {
      const result = await task;
      await terminalTask?.task;
      return result;
    } finally {
      if (this.#runEventTerminalTask === terminalTask) {
        this.#runEventTerminalTask = null;
      }
    }
  }

  registerRunTerminalBarrier(barrier: DriverRunTerminalBarrier): () => void {
    if (this.#runTerminalBarrier !== null) {
      throw new Error("Driver run terminal barrier is already registered.");
    }

    this.#runTerminalBarrier = barrier;
    return () => {
      if (this.#runTerminalBarrier === barrier) {
        this.#runTerminalBarrier = null;
      }
    };
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

    const runTicket = this.#activeRunTicket;
    const activeRunId = runTicket?.runId ?? null;
    const selectedTerminal =
      runTicket === null ? null : this.#terminalState.snapshotRun(runTicket.runId)?.terminal?.value;
    const events = structuredClone(input.events)
      .map((event) =>
        selectedTerminal !== null &&
        selectedTerminal !== undefined &&
        event.sourceEventId === undefined &&
        (event.kind === "run.cancelled" ||
          event.kind === "run.completed" ||
          event.kind === "run.failed")
          ? { ...event, sourceEventId: selectedTerminal.sourceEventId }
          : event,
      )
      .flatMap((event) => toDriverEventEnvelopes(this.payload, event, activeRunId));
    const delivery = events[0]?.event.delivery;
    let terminal: DriverRunTerminalIdentity | null = null;
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
        event: {
          kind: event.kind,
          payload: structuredClone(event.payload),
          sourceEventId: event.sourceEventId ?? event.id,
        },
        runId: event.runId,
        sourceEventId: event.sourceEventId ?? event.id,
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

    let terminalSelection: PreparedEventPush["terminalSelection"] = null;
    if (terminal !== null) {
      if (runTicket === null) {
        throw new Error("Driver run terminal must target the active run.");
      }
      const selection = this.#terminalState.selectRunTerminal(runTicket, terminal);
      if (selection === "cancelled") {
        throw new Error("Driver completed terminal lost the cancellation race.");
      }
      terminalSelection = selection;
      if (terminalSelection !== "selected" && events.length !== 1) {
        throw new Error("A selected driver run terminal can only be retried by itself.");
      }
    } else if (hasRunScopedEvent && this.#terminalState.snapshotRun()?.terminal !== null) {
      throw new Error("Driver event cannot target a terminated run.");
    }

    return {
      client: this.#requireClient(),
      delivery,
      events,
      generation: this.#connectionGeneration,
      hasRunScopedEvent,
      maxBatchSize,
      runTicket,
      signal: input.signal,
      terminal,
      terminalSelection,
    };
  }

  async #deliverEventPush(prepared: PreparedEventPush): Promise<DriverEventBatchOutput> {
    const { client, delivery, events, generation, maxBatchSize, signal } = prepared;
    const accepted: DriverEventBatchOutput["accepted"][number][] = [];
    this.#assertConnection(client, generation, "event delivery");
    this.#assertRunTicket(prepared);
    const rpcOptions = this.#rpcOptions(signal);

    for (let index = 0; index < events.length; index += maxBatchSize) {
      let remaining = events.slice(index, index + maxBatchSize);

      while (remaining.length > 0) {
        const result = driverRuntimeRpcSchemas.driver.pushEvents.output.parse(
          await client.driver.pushEvents(
            {
              driverInstanceId: this.payload.driverInstanceId,
              events: remaining,
            },
            rpcOptions,
          ),
        );
        this.#assertConnection(client, generation, "event delivery");
        this.#assertRunTicket(prepared);

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
    driverRuntimeRpcSchemas.driver.pushLogs.output.parse(
      await this.#requireClient().driver.pushLogs(
        {
          driverInstanceId: this.payload.driverInstanceId,
          logs: input.logs,
        },
        this.#rpcOptions(),
      ),
    );
  }

  async ready(input: Omit<DriverReadyInput, "driverInstanceId" | "pid">): Promise<void> {
    driverRuntimeRpcSchemas.driver.ready.output.parse(
      await this.#requireClient().driver.ready(
        {
          at: input.at,
          driverInstanceId: this.payload.driverInstanceId,
          pid: process.pid,
        },
        this.#rpcOptions(),
      ),
    );
  }

  async nextCommand(signal: AbortSignal): Promise<RuntimeCommand | null> {
    const rpcAbortSignal = this.#rpcAbortController.signal;
    const timeoutSignal = AbortSignal.timeout(DRIVER_RPC_TIMEOUT_MS);
    let result: Awaited<ReturnType<DriverRuntimeClient["driverInstance"]["nextCommand"]>>;

    try {
      result = driverRuntimeRpcSchemas.driverInstance.nextCommand.output.parse(
        await this.#requireClient().driverInstance.nextCommand(
          {
            driverInstanceId: this.payload.driverInstanceId,
          },
          this.#rpcOptions(signal, timeoutSignal),
        ),
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

    return result.command;
  }

  #deliverRunTerminal(
    status: "completed" | "failed",
    error?: DriverFailureInput["error"],
    signal?: AbortSignal,
  ): Promise<void> {
    if (status === "failed" && error === undefined) {
      return Promise.reject(new Error("Failed run terminal requires an error."));
    }

    const runId = this.#terminalState.terminalRunId(this.payload.execution.configRevision.runId);
    if (runId === null) {
      return Promise.reject(new Error("Driver run terminal requires an exact run ID."));
    }

    const terminal: DriverInstanceTerminal =
      status === "completed"
        ? { runId, status }
        : { error: normalizeDurableRunError(structuredClone(error!)), runId, status };
    let selection: "acked" | "pending" | "selected";
    try {
      selection = this.#terminalState.selectInstanceTerminal(terminal);
    } catch (selectionError) {
      return Promise.reject(selectionError);
    }

    if (selection === "acked") {
      return Promise.resolve();
    }
    if (selection === "pending" && this.#instanceTerminalTask !== null) {
      return this.#instanceTerminalTask;
    }

    const client = this.#client;
    const generation = this.#connectionGeneration;
    const task = this.#enqueueDelivery(async () => {
      if (client === null) {
        throw new Error("Driver instance socket is not connected.");
      }
      this.#assertConnection(client, generation, "run terminal delivery");
      this.#assertInstanceTerminal(terminal);
      const options = this.#rpcOptions(signal);

      if (terminal.status === "completed") {
        driverRuntimeRpcSchemas.driver.completeRun.output.parse(
          await client.driver.completeRun(
            { driverInstanceId: this.payload.driverInstanceId, runId: terminal.runId },
            options,
          ),
        );
      } else {
        driverRuntimeRpcSchemas.driver.failRun.output.parse(
          await client.driver.failRun(
            {
              driverInstanceId: this.payload.driverInstanceId,
              error: structuredClone(terminal.error),
              runId: terminal.runId,
            },
            options,
          ),
        );
      }

      this.#assertConnection(client, generation, "run terminal delivery");
      this.#assertInstanceTerminal(terminal);
      this.#terminalState.ackInstanceTerminal(terminal);
    }, signal);
    this.#instanceTerminalTask = task;
    void task.then(
      () => {
        if (this.#instanceTerminalTask === task) {
          this.#instanceTerminalTask = null;
        }
      },
      () => {
        if (this.#instanceTerminalTask === task) {
          this.#instanceTerminalTask = null;
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

  #assertRunTicket(prepared: PreparedEventPush): void {
    if (
      prepared.hasRunScopedEvent &&
      (prepared.runTicket === null ||
        this.#terminalState.snapshotRun()?.revision !== prepared.runTicket.revision)
    ) {
      throw new Error("Driver active run changed during event delivery.");
    }
  }

  #assertInstanceTerminal(terminal: DriverInstanceTerminal): void {
    this.#terminalState.selectInstanceTerminal(terminal);
  }

  #enqueueDelivery<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const predecessor = this.#deliveryTail;
    const task = raceWithAbort(predecessor, signal).then(operation);
    this.#deliveryTail = Promise.allSettled([predecessor, task]).then(() => {});
    return task;
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
