import { createDisabledLogger } from "../observability";
import type { Logger } from "../observability";
import type { DriverEventInput } from "../protocol/events";
import { createDriverId, type RunId } from "../protocol/id";
import type { DriverEventBatchOutput, DriverEventReceipt } from "../protocol/orpc";
import type { DriverStartInput } from "../protocol/start";
import { normalizeDurableRunError, parseRuntimeCommand } from "../runtime-command";
import type {
  DriverCommandUpdate,
  RunError,
  RuntimeCommand,
  RuntimeCommandResult,
} from "../runtime-command";
import { AgentBackendLifecycle } from "./agent-backend-lifecycle";
import type {
  AgentDriverBackendFactory,
  AgentDriverContext,
  AgentDriverContextPortOverrides,
} from "./agent-driver-backend";
import { createAgentDriverContext } from "./agent-driver-backend";
import type { AgentDriverEventSink } from "../host-ports";
import { AsyncValueQueue } from "./async-value-queue";
import { DriverCommandDispatcher } from "./driver-command-dispatcher";
import { DriverPermissionBroker } from "./driver-permission-broker";
import { createDriverPermissionRequestHandler } from "./driver-permission-policy";
import {
  assertDriverEventReceiptPrefix,
  assertIsolatedRunTerminalBatch,
  withSourceEventIds,
  type DriverRuntimeExternalToolEffectPort,
  type DriverRuntimeIo,
  type DriverRunTerminalBarrier,
} from "./driver-runtime-io";
import { DriverRuntimeStateMachine } from "./driver-runtime-state";
import {
  DriverTerminalStateMachine,
  type DriverInputOutcome,
  type DriverInputSettlement,
  type DriverRunSnapshot,
  type DriverRunTerminalIdentity,
  type DriverRunTicket,
} from "./driver-terminal-state";

export type AgentDriverKernelStartInput = DriverStartInput;
export type AgentDriverRuntimeEvent = DriverEventInput;

export interface AgentDriverKernel {
  cancel(reason: string): Promise<void>;
  dispatch(command: RuntimeCommand): Promise<RuntimeCommandResult | void>;
  events(): AsyncIterable<AgentDriverRuntimeEvent>;
  start(input: AgentDriverKernelStartInput): Promise<void>;
  stop(reason: string): Promise<void>;
}

export interface AgentDriverKernelOptions {
  readonly backendFactory: AgentDriverBackendFactory;
  /**
   * Required for `mcp.execute` commands. A Kernel has no durable store of its
   * own, so silently synthesizing an in-memory idempotency key would make a
   * restart unsafe.
   */
  readonly externalToolEffectLedger?: DriverRuntimeExternalToolEffectPort;
  readonly hostPorts?: AgentDriverContextPortOverrides;
  readonly logger?: Logger;
}

type KernelCommandResult = RuntimeCommandResult | void;

const KERNEL_SHUTDOWN_TIMEOUT_MS = 5_000;
const KERNEL_START_TIMEOUT_MS = 60_000;
const KERNEL_QUEUE_MAX_SIZE = 1_024;
const KERNEL_QUEUE_MAX_BYTES = 32 * 1_024 * 1_024;
const KERNEL_TERMINAL_QUEUE_MAX_SIZE = 1;
const KERNEL_TERMINAL_QUEUE_MAX_BYTES = 1_024 * 1_024;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function toDispatchError(error: RunError): Error {
  const dispatchError = new Error(error.message);
  dispatchError.name = error.code;
  return dispatchError;
}

export class AgentDriverKernelCore implements AgentDriverKernel, DriverRuntimeIo {
  readonly #backendFactory: AgentDriverBackendFactory;
  readonly #commandsById = new Map<string, RuntimeCommand>();
  readonly #externalToolEffectLedger: DriverRuntimeExternalToolEffectPort | undefined;
  readonly #commandResults = new Map<string, PromiseWithResolvers<KernelCommandResult>>();
  readonly #commands = new AsyncValueQueue<RuntimeCommand>(
    "command",
    KERNEL_QUEUE_MAX_SIZE,
    KERNEL_QUEUE_MAX_BYTES,
    jsonBytes,
  );
  readonly #events = new AsyncValueQueue<AgentDriverRuntimeEvent>(
    "event",
    KERNEL_QUEUE_MAX_SIZE,
    KERNEL_QUEUE_MAX_BYTES,
    jsonBytes,
    {
      maxBytes: KERNEL_TERMINAL_QUEUE_MAX_BYTES,
      maxSize: KERNEL_TERMINAL_QUEUE_MAX_SIZE,
    },
  );
  readonly #hostPorts: AgentDriverContextPortOverrides | undefined;
  readonly #logger: Logger;
  readonly #permissionBroker: DriverPermissionBroker;
  readonly #runtimeState = new DriverRuntimeStateMachine("created");
  readonly #shutdownController = new AbortController();
  readonly #terminalState = new DriverTerminalStateMachine();
  #backendLifecycle: AgentBackendLifecycle | null = null;
  #eventFinalizationTask: Promise<void> | null = null;
  #initialRunId: RunId | null = null;
  #pushedEventSeq = 0;
  #runTicket: DriverRunTicket | null = null;
  #runTask: Promise<void> | null = null;
  #runTaskSettled = false;
  #runEventTerminalTask: { task: Promise<DriverEventReceipt>; ticket: DriverRunTicket } | null =
    null;
  #runTerminalBarrier: DriverRunTerminalBarrier | null = null;
  #shutdownTask: Promise<void> | null = null;
  #stopTask: Promise<void> | null = null;
  #terminalCause: { error: unknown } | null = null;

  constructor(options: AgentDriverKernelOptions) {
    this.#backendFactory = options.backendFactory;
    this.#externalToolEffectLedger = options.externalToolEffectLedger;
    this.#hostPorts = options.hostPorts;
    this.#logger = options.logger ?? createDisabledLogger();
    this.#permissionBroker = new DriverPermissionBroker(() => this.#logger);
  }

  beginRun(runId: RunId): DriverRunTicket {
    const ticket = this.#terminalState.beginRun(runId);
    this.#runTicket = ticket;
    return ticket;
  }

  claimRunCancellation(
    ticket: DriverRunTicket,
    reason: string,
  ): "already_claimed" | "claimed" | "terminal_selected" {
    return this.#terminalState.claimCancellation(ticket, reason);
  }

  async cancel(reason: string): Promise<void> {
    const runId = this.currentRunId();

    if (runId === null) {
      throw new Error("Driver has no active run to cancel.");
    }

    await this.dispatch({
      commandId: createDriverId(),
      kind: "turn.cancel",
      reason,
      runId,
    });
  }

  async commandUpdate(input: DriverCommandUpdate, _signal: AbortSignal): Promise<void> {
    const update = structuredClone(input);
    if (update.status === "accepted") {
      return;
    }

    const result = this.#commandResults.get(update.commandId);
    const command = this.#commandsById.get(update.commandId);

    if (!result || !command) {
      return;
    }

    this.#commandsById.delete(update.commandId);
    this.#commandResults.delete(update.commandId);

    if (update.status === "failed") {
      result.reject(toDispatchError(update.error));
      return;
    }

    result.resolve(update.status === "completed" ? update.result : undefined);
  }

  async claimExternalToolEffect(
    input: Parameters<DriverRuntimeIo["claimExternalToolEffect"]>[0],
    signal: AbortSignal,
  ): ReturnType<DriverRuntimeIo["claimExternalToolEffect"]> {
    return this.#requireExternalToolEffectLedger().claimExternalToolEffect(input, signal);
  }

  async observeExternalToolEffect(
    input: Parameters<DriverRuntimeIo["observeExternalToolEffect"]>[0],
    signal: AbortSignal,
  ): ReturnType<DriverRuntimeIo["observeExternalToolEffect"]> {
    return this.#requireExternalToolEffectLedger().observeExternalToolEffect(input, signal);
  }

  async completeRun(): Promise<void> {
    const runId = this.#terminalState.terminalRunId(this.#initialRunId);
    if (runId === null) {
      throw new Error("Driver run terminal requires an exact run ID.");
    }
    const terminal = { runId, status: "completed" } as const;
    const selection = this.#terminalState.selectInstanceTerminal(terminal);
    if (selection === "acked") {
      return;
    }

    try {
      if (
        this.#terminalState.currentRunId() === null &&
        this.#terminalState.acknowledgedRunTerminal() === null
      ) {
        this.#pushTerminalEvent({
          kind: "run.completed",
          payload: {
            stopReason: "end_turn",
          },
        });
      }
    } catch (error) {
      if (selection === "selected") {
        this.#terminalState.abandonInstanceTerminal(terminal);
      }
      throw error;
    }
    this.#terminalState.ackInstanceTerminal(terminal);
  }

  async dispatch(command: RuntimeCommand): Promise<KernelCommandResult> {
    this.#ensureStarted();
    const admitted = parseRuntimeCommand(command);

    if (this.#commandResults.has(admitted.commandId)) {
      throw new Error(`Driver command ${admitted.commandId} is already pending.`);
    }

    const result = Promise.withResolvers<KernelCommandResult>();
    this.#commands.push(admitted);
    this.#commandsById.set(admitted.commandId, admitted);
    this.#commandResults.set(admitted.commandId, result);
    return result.promise;
  }

  releaseRun(ticket: DriverRunTicket, reason: "command_acked" | "driver_failing"): void {
    this.#terminalState.releaseRun(ticket, reason);
    if (this.#runTicket === ticket) {
      this.#runTicket = null;
    }
  }

  events(): AsyncIterable<AgentDriverRuntimeEvent> {
    return this.#events.values();
  }

  async failRun(error: RunError): Promise<void> {
    this.#publishRunFailure(error, this.currentRunId());
  }

  #publishRunFailure(error: RunError, runId: RunId | null): void {
    const durableError = normalizeDurableRunError(error);
    const exactRunId = this.#terminalState.terminalRunId(runId ?? this.#initialRunId);
    if (exactRunId === null) {
      throw new Error("Driver run terminal requires an exact run ID.");
    }
    const terminal = {
      error: structuredClone(durableError),
      runId: exactRunId,
      status: "failed",
    } as const;
    const selection = this.#terminalState.selectInstanceTerminal(terminal);
    if (selection === "acked") {
      return;
    }

    try {
      if (this.#terminalState.acknowledgedRunTerminal(exactRunId) === null) {
        this.#pushTerminalEvent({
          kind: "run.failed",
          payload: {
            error: durableError,
            recoverable: false,
          },
          runId: exactRunId,
        });
      }
    } catch (publishError) {
      if (selection === "selected") {
        this.#terminalState.abandonInstanceTerminal(terminal);
      }
      throw publishError;
    }
    this.#terminalState.ackInstanceTerminal(terminal);
  }

  async heartbeat(
    _input: Parameters<DriverRuntimeIo["heartbeat"]>[0],
  ): ReturnType<DriverRuntimeIo["heartbeat"]> {
    return {
      heartbeatCount: 1,
      ok: true as const,
    };
  }

  async nextCommand(_signal: AbortSignal): Promise<RuntimeCommand | null> {
    const result = await this.#commands.next();
    return result.done ? null : result.value;
  }

  currentRunId(): RunId | null {
    return this.#terminalState.currentRunId();
  }

  async settleExternalToolEffect(
    input: Parameters<DriverRuntimeIo["settleExternalToolEffect"]>[0],
    signal: AbortSignal,
  ): ReturnType<DriverRuntimeIo["settleExternalToolEffect"]> {
    return this.#requireExternalToolEffectLedger().settleExternalToolEffect(input, signal);
  }

  async pushEvents(input: {
    events: DriverEventInput[];
    signal?: AbortSignal;
  }): Promise<DriverEventBatchOutput> {
    return this.#pushEvents(input);
  }

  async #pushEvents(
    input: { events: DriverEventInput[]; signal?: AbortSignal },
    eventSink?: AgentDriverEventSink,
  ): Promise<DriverEventBatchOutput> {
    input.signal?.throwIfAborted();
    const ticket = this.#runTicket;
    const selectedTerminal =
      ticket === null ? null : this.#terminalState.snapshotRun(ticket.runId)?.terminal?.value;
    const ownedEvents = input.events.map((event) =>
      selectedTerminal !== null &&
      selectedTerminal !== undefined &&
      event.sourceEventId === undefined &&
      (event.kind === "run.cancelled" ||
        event.kind === "run.completed" ||
        event.kind === "run.failed")
        ? { ...event, sourceEventId: selectedTerminal.sourceEventId }
        : event,
    );
    const events = structuredClone(withSourceEventIds(ownedEvents));
    assertIsolatedRunTerminalBatch(events);
    const barrier = this.#runTerminalBarrier;
    if (barrier !== null) {
      const pending = barrier(events);
      if (pending !== undefined) {
        await pending;
      }
    }
    const activeRunId = this.currentRunId();
    let hasRunScopedEvent = false;
    let terminal: DriverRunTerminalIdentity | null = null;
    let terminalIndex = -1;

    for (const [index, event] of events.entries()) {
      const runId = event.runId === undefined ? activeRunId : event.runId;

      if (runId !== null) {
        if (runId !== activeRunId) {
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

      if (runId === null) {
        throw new Error("Driver run terminal must target the active run.");
      }

      if (event.delivery === "best_effort") {
        throw new Error("Driver run terminal must be lossless.");
      }

      if (terminal !== null) {
        throw new Error("Driver event batch cannot contain multiple run terminals.");
      }

      terminal = {
        event,
        runId,
        sourceEventId: event.sourceEventId!,
        status,
      };
      terminalIndex = index;
    }

    if (terminalIndex >= 0 && terminalIndex !== events.length - 1) {
      throw new Error("Driver run terminal must be the final event in its batch.");
    }

    let terminalSelection: "acked" | "cancelled" | "pending" | "selected" | null = null;
    if (terminal !== null) {
      if (ticket === null) {
        throw new Error("Driver run terminal must target the active run.");
      }

      terminalSelection = this.#terminalState.selectRunTerminal(ticket, terminal);
      if (terminalSelection === "cancelled") {
        ticket.signal.throwIfAborted();
        throw new Error("Driver run terminal lost to cancellation.");
      }
      if (terminalSelection === "acked") {
        const selected = this.#terminalState.snapshotRun(ticket.runId)?.terminal;
        if (events.length !== 1 || selected?.phase !== "acked") {
          throw new Error("Driver acknowledged terminal retry must contain only that terminal.");
        }
        return { accepted: [selected.receipt] };
      }
      if (terminalSelection === "pending" && this.#runEventTerminalTask !== null) {
        if (this.#runEventTerminalTask.ticket !== ticket) {
          throw new Error("Driver active run changed during terminal delivery.");
        }
        return { accepted: [await this.#runEventTerminalTask.task] };
      }
    } else if (hasRunScopedEvent && this.#terminalState.snapshotRun()?.terminal !== null) {
      throw new Error("Driver event cannot target a terminated run.");
    }

    let delivery: Promise<DriverEventBatchOutput>;
    if (eventSink === undefined) {
      try {
        this.#events.pushMany(events);
      } catch (error) {
        if (terminal !== null && terminalSelection === "selected") {
          this.#terminalState.abandonRunTerminal(ticket!, terminal);
        }
        throw error;
      }
      delivery = Promise.resolve({
        accepted: events.map((event) => {
          this.#pushedEventSeq += 1;
          return {
            eventId: event.sourceEventId!,
            seq: this.#pushedEventSeq,
            type: event.kind,
          };
        }),
      });
    } else {
      delivery = eventSink.pushEvents({
        events,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    }

    const terminalTask =
      terminal === null || ticket === null
        ? null
        : {
            task: delivery.then((result) => {
              assertDriverEventReceiptPrefix(events, result.accepted);
              if (result.accepted.length !== events.length) {
                throw new Error("Driver run terminal was not fully acknowledged.");
              }
              const receipt = result.accepted[terminalIndex];
              if (receipt === undefined) {
                throw new Error("Driver run terminal receipt is missing.");
              }
              this.#terminalState.ackRunTerminal(ticket, receipt);
              return receipt;
            }),
            ticket,
          };

    if (terminalTask !== null) {
      this.#runEventTerminalTask = terminalTask;
      void terminalTask.task.catch(() => {});
    }

    try {
      const result = await delivery;
      assertDriverEventReceiptPrefix(events, result.accepted);
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

  runSnapshot(runId?: RunId): DriverRunSnapshot | null {
    return this.#terminalState.snapshotRun(runId);
  }

  settleRunInput(ticket: DriverRunTicket, outcome: DriverInputOutcome): DriverInputSettlement {
    return this.#terminalState.settleInput(ticket, outcome);
  }

  async start(input: AgentDriverKernelStartInput): Promise<void> {
    if (this.#runtimeState.status() !== "created") {
      throw new Error("Driver kernel has already started.");
    }

    const admitted = structuredClone(input);
    this.#initialRunId = admitted.execution.run.runId;
    this.#runtimeState.enter("starting");
    await this.#start(admitted);
  }

  stop(reason: string): Promise<void> {
    return (this.#stopTask ??= this.#stop(reason).catch((error: unknown) => {
      this.#stopTask = null;
      throw error;
    }));
  }

  async #start(input: AgentDriverKernelStartInput): Promise<void> {
    const context = this.#createContext(input);

    try {
      const backend = this.#backendFactory(input);
      const lifecycle = new AgentBackendLifecycle({
        backend,
        createContext: () => this.#createContext(input),
        labels: {
          finalStop: "Driver kernel final backend shutdown",
          start: "Driver kernel backend startup",
          stop: "Driver kernel backend shutdown",
        },
        onDeferredStopComplete: () => {
          void this.#completeShutdown().catch((error: unknown) => {
            this.#logger.error("driver.kernel.deferred_finalization.failed", error, {});
          });
        },
        onDeferredStopError: (error) => {
          this.#logger.error("driver.kernel.deferred_shutdown.failed", error, {});
        },
        shutdownSignal: this.#shutdownController.signal,
        startTimeoutMs: KERNEL_START_TIMEOUT_MS,
        stopTimeoutMs: KERNEL_SHUTDOWN_TIMEOUT_MS,
      });
      this.#backendLifecycle = lifecycle;

      try {
        await lifecycle.start();
      } catch (error) {
        if (this.#shutdownController.signal.aborted && this.#terminalCause === null) {
          return;
        }

        throw this.#terminalCause?.error ?? error;
      }

      if (this.#runtimeState.status() !== "starting") {
        this.#throwTerminalCause();
        return;
      }

      this.#runtimeState.enter("ready");
      const dispatcher = new DriverCommandDispatcher({
        backend,
        driverInstanceId: input.driverInstanceId,
        isShuttingDown: () => this.#runtimeState.isShuttingDown(),
        permissionRequests: this.#permissionBroker,
        rememberRunFailure: (error) => this.#rememberRunFailure(error),
        runtimeContextFactory: () => context,
        runtimeState: this.#runtimeState,
        sandboxId: input.sandboxId,
        shutdownSignal: this.#shutdownController.signal,
        shutdown: async (_runtimeIo, reason) => this.#shutdown(reason),
      });

      this.#runTask = dispatcher
        .run(this, this.#logger)
        .catch(async (error: unknown) => {
          this.#rememberTerminalCause(error);
          if (
            this.#runtimeState.status() !== "failed" &&
            this.#runtimeState.status() !== "stopped"
          ) {
            this.#runtimeState.enter("failed");
          }
          this.#rejectPendingCommands(this.#terminalCause?.error ?? error);
          await this.#shutdown("driver.command_loop_failed").catch((shutdownError: unknown) => {
            this.#logger.error("driver.kernel.shutdown.failed", shutdownError, {});
          });
        })
        .finally(async () => {
          this.#runTaskSettled = true;
          this.#rejectPendingCommands(
            this.#terminalCause?.error ?? new Error("Driver kernel stopped."),
          );
          await this.#finalizeShutdown();
        });
    } catch (error) {
      this.#rememberTerminalCause(error);
      if (
        this.#runtimeState.status() !== "failed" &&
        this.#runtimeState.status() !== "stopped" &&
        this.#runtimeState.status() !== "stopping"
      ) {
        this.#runtimeState.enter("failed");
      }
      this.#rejectPendingCommands(this.#terminalCause?.error ?? error);
      await this.#shutdown("driver.start_failed").catch((stopError: unknown) => {
        this.#logger.error("driver.kernel.start_cleanup.failed", stopError, {});
      });
      this.#throwTerminalCause();
    }
  }

  async #stop(reason: string): Promise<void> {
    const status = this.#runtimeState.status();

    if (status === "failed" || status === "stopping") {
      try {
        await (this.#shutdownTask ?? this.#shutdown(reason));
      } catch (error) {
        if (this.#terminalCause === null) {
          throw error;
        }

        this.#logger.error("driver.kernel.shutdown.failed", error, {});
      }
      await this.#runTask;
      this.#throwTerminalCause();
      return;
    }

    if (status === "stopped") {
      return;
    }

    if (status === "created" || status === "starting") {
      await this.#shutdown(reason);
      return;
    }

    try {
      await this.dispatch({
        commandId: createDriverId(),
        kind: "session.stop",
        reason,
      });
    } catch (error) {
      if (this.#runtimeState.status() === "failed" || this.#shutdownTask !== null) {
        this.#throwTerminalCause();
        throw error;
      }

      this.#logger.warn("driver.kernel.stop.command_bypassed", {
        message: error instanceof Error ? error.message : "Kernel stop command failed.",
      });
      let terminalFailure: { error: unknown } | null = null;

      try {
        await this.completeRun();
      } catch (error) {
        terminalFailure = { error };
      }
      await this.#shutdown(reason);

      if (terminalFailure !== null) {
        throw terminalFailure.error;
      }
    }

    await this.#runTask;
    this.#throwTerminalCause();
  }

  #createContext(payload: DriverStartInput): AgentDriverContext {
    const customEventSink = this.#hostPorts?.eventSink;
    const hostPorts =
      customEventSink === undefined
        ? this.#hostPorts
        : { ...this.#hostPorts, eventSink: this.#guardEventSink(customEventSink) };

    return createAgentDriverContext({
      eventSink: this,
      ...(hostPorts === undefined ? {} : { ports: hostPorts }),
      lifecycle: {
        fail: (error) => this.#onBackendFailure(error),
      },
      payload,
      logger: this.#logger,
      permission: {
        request: createDriverPermissionRequestHandler({
          payload,
          supervised: async (input, signal) => {
            const generation = this.#runtimeState.beginApproval();
            if (generation === null) {
              return "reject_once";
            }

            try {
              return await this.#permissionBroker.request(this, input, signal, () =>
                this.#runtimeState.ownsRun(generation),
              );
            } finally {
              this.#runtimeState.endApproval(generation);
            }
          },
        }),
      },
    });
  }

  #guardEventSink(eventSink: AgentDriverEventSink): AgentDriverEventSink {
    const claimExternalToolEffect = eventSink.claimExternalToolEffect;
    const observeExternalToolEffect = eventSink.observeExternalToolEffect;
    const settleExternalToolEffect = eventSink.settleExternalToolEffect;

    return {
      ...(claimExternalToolEffect === undefined
        ? {}
        : {
            claimExternalToolEffect: (input, signal) =>
              claimExternalToolEffect.call(eventSink, input, signal),
          }),
      commandUpdate: async (input, signal) => {
        await eventSink.commandUpdate(input, signal);
        await this.commandUpdate(input, signal);
      },
      currentRunId: () => this.currentRunId(),
      ...(observeExternalToolEffect === undefined
        ? {}
        : {
            observeExternalToolEffect: (input, signal) =>
              observeExternalToolEffect.call(eventSink, input, signal),
          }),
      pushEvents: (input) => this.#pushEvents(input, eventSink),
      ...(settleExternalToolEffect === undefined
        ? {}
        : {
            settleExternalToolEffect: (input, signal) =>
              settleExternalToolEffect.call(eventSink, input, signal),
          }),
    };
  }

  #requireExternalToolEffectLedger(): DriverRuntimeExternalToolEffectPort {
    if (this.#externalToolEffectLedger === undefined) {
      throw new Error(
        "Driver kernel requires a durable external tool effect ledger for MCP execution.",
      );
    }

    return this.#externalToolEffectLedger;
  }

  #ensureStarted(): void {
    const status = this.#runtimeState.status();

    if (status === "created" || status === "starting") {
      throw new Error("Driver kernel has not started.");
    }

    if (this.#runtimeState.isShuttingDown()) {
      throw new Error(`Driver kernel is not accepting commands: ${status}.`);
    }
  }

  #onBackendFailure(error: Error): void {
    this.#logger.error("driver.kernel.backend.failed", error, {});

    if (this.#runtimeState.isShuttingDown()) {
      return;
    }

    this.#rememberTerminalCause(error);
    this.#runtimeState.enter("failed");
    this.#rejectPendingCommands(error);

    if (this.currentRunId() !== null) {
      this.#rememberRunFailure({
        code: "driver.runtime_failed",
        details: {},
        message: error.message,
        retryable: false,
      });
    }

    void this.#shutdown("driver.backend_failed").catch((shutdownError: unknown) => {
      this.#logger.error("driver.kernel.shutdown.failed", shutdownError, {});
    });
  }

  #rejectPendingCommands(error: unknown): void {
    for (const result of this.#commandResults.values()) {
      result.reject(error);
    }

    this.#commandResults.clear();
    this.#commandsById.clear();
  }

  #rememberTerminalCause(error: unknown): void {
    this.#terminalCause ??= { error };
  }

  #rememberRunFailure(error: RunError): void {
    this.#terminalState.recordFailure(error);
  }

  #pushTerminalEvent(event: AgentDriverRuntimeEvent): void {
    this.#events.pushReserved(structuredClone(event));
  }

  #throwTerminalCause(): void {
    if (this.#terminalCause !== null) {
      throw this.#terminalCause.error;
    }
  }

  async #closeEventsAfterPermissions(): Promise<void> {
    try {
      await this.#permissionBroker.rejectAllAndWait();
    } catch (error) {
      this.#logger.error("driver.kernel.permission_shutdown.failed", error, {});
    } finally {
      this.#events.close();
    }
  }

  async #finalizeEvents(): Promise<void> {
    const failure = this.#terminalState.shutdownSnapshot()?.failure;
    const instanceTerminal = this.#terminalState.snapshotInstance();
    if (
      failure !== null &&
      failure !== undefined &&
      (instanceTerminal.phase === "open" || instanceTerminal.terminal.status === "failed")
    ) {
      this.#publishRunFailure(failure.error, failure.runId);
    }
    await this.#closeEventsAfterPermissions();
  }

  async #completeShutdown(): Promise<void> {
    if (this.#runtimeState.status() === "stopping") {
      this.#runtimeState.enter("stopped");
    }
    this.#backendLifecycle = null;
    this.#terminalState.markCleanupCompleted();
    await this.#finalizeShutdown();
  }

  async #finalizeShutdown(): Promise<void> {
    if (
      this.#terminalState.shutdownSnapshot()?.cleanup !== "completed" ||
      (this.#runTask !== null && !this.#runTaskSettled)
    ) {
      return;
    }

    await (this.#eventFinalizationTask ??= this.#finalizeEvents().catch((error: unknown) => {
      this.#eventFinalizationTask = null;
      throw error;
    }));
  }

  #shutdown(reason: string): Promise<void> {
    return (this.#shutdownTask ??= this.#runShutdown(reason).catch((error: unknown) => {
      this.#shutdownTask = null;
      throw error;
    }));
  }

  async #runShutdown(reason: string): Promise<void> {
    this.#terminalState.requestShutdown();
    if (this.#runtimeState.status() === "stopped") {
      await this.#finalizeShutdown();
      return;
    }

    if (this.#runtimeState.status() !== "failed") {
      this.#runtimeState.enter("stopping");
    }
    const permissionCancellation = this.#permissionBroker.rejectAllAndWait();
    this.#shutdownController.abort(new Error(reason));
    this.#commands.close({ discard: true });

    try {
      let permissionFailure: { error: unknown } | null = null;

      try {
        await permissionCancellation;
      } catch (error) {
        permissionFailure = { error };
      }

      const backendShutdown = await Promise.allSettled([this.#backendLifecycle?.shutdown(reason)]);
      const failure = backendShutdown.find((result) => result.status === "rejected");

      if (permissionFailure !== null) {
        throw permissionFailure.error;
      }
      if (failure?.status === "rejected") {
        throw failure.reason;
      }

      await this.#completeShutdown();
    } catch (error) {
      if (this.#runtimeState.status() === "stopping") {
        this.#runtimeState.enter("failed");
      }
      throw error;
    }
  }
}
