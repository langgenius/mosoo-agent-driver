import type { DriverEventInput } from "../protocol/events";
import { createDriverId } from "../protocol/id";
import type { RunId } from "../protocol/id";
import type {
  DriverEventBatchOutput,
  DriverEventReceipt,
  DriverFailureInput,
  DriverHeartbeatInput,
  DriverHeartbeatOutput,
} from "../protocol/orpc";
import type {
  DriverCommandUpdate,
  McpExternalToolEffectClaim,
  McpExternalToolEffectSettlement,
  McpExternalToolEffectState,
  RuntimeCommand,
} from "../runtime-command";
import type {
  DriverInputOutcome,
  DriverInputSettlement,
  DriverRunSnapshot,
  DriverRunTicket,
} from "./driver-terminal-state";

export interface DriverRuntimeEventPort {
  currentRunId(): RunId | null;
  pushEvents(input: {
    events: DriverEventInput[];
    signal?: AbortSignal;
  }): Promise<DriverEventBatchOutput>;
}

export type DriverRunTerminalBarrier = (
  events: readonly DriverEventInput[],
) => Promise<void> | void;

export const DRIVER_EVENT_DELIVERY_TIMEOUT_MS = 10_000;

export class DriverEventRejectedError extends Error {
  readonly sourceEventId: string;

  constructor(sourceEventId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Driver event was rejected.", { cause });
    this.name = "DriverEventRejectedError";
    this.sourceEventId = sourceEventId;
  }
}

export class DriverEventDeliveryOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Driver event delivery outcome is unknown.", {
      cause,
    });
    this.name = "DriverEventDeliveryOutcomeUnknownError";
  }
}

/**
 * Stamps missing source IDs without taking ownership of event payloads.
 *
 * Callers retrying across separate delivery invocations must reuse this returned array.
 */
export function withSourceEventIds(events: readonly DriverEventInput[]): DriverEventInput[] {
  return events.map((event) =>
    typeof event.sourceEventId === "string" && event.sourceEventId.length > 0
      ? event
      : { ...event, sourceEventId: createDriverId() },
  );
}

export function assertIsolatedRunTerminalBatch(events: readonly DriverEventInput[]): void {
  const terminals = events.filter(
    ({ kind }) => kind === "run.cancelled" || kind === "run.completed" || kind === "run.failed",
  );

  if (terminals.length > 1) {
    throw new Error("Driver event batch cannot contain multiple run terminals.");
  }
  if (terminals.length === 1 && events.length !== 1) {
    throw new Error("Driver run terminal must be the only event in its batch.");
  }
}

export function assertDriverEventReceiptPrefix(
  events: readonly DriverEventInput[],
  receipts: readonly DriverEventReceipt[],
): void {
  if (receipts.length > events.length) {
    throw new Error("Driver event receipt count exceeds the submitted batch size.");
  }

  for (const [index, receipt] of receipts.entries()) {
    if (!Number.isSafeInteger(receipt.seq)) {
      throw new Error(`Driver event receipt ${index} seq must be a safe integer.`);
    }

    if (receipt.seq < 0) {
      throw new Error(`Driver event receipt ${index} seq must be non-negative.`);
    }

    if (receipt.type !== events[index]?.kind) {
      throw new Error(`Driver event receipt ${index} does not match the submitted event type.`);
    }

    const event = events[index];
    const eventId = event?.sourceEventId ?? event?.id;

    if (receipt.eventId !== eventId) {
      throw new Error(`Driver event receipt ${index} does not match the submitted event ID.`);
    }
  }
}

/**
 * Owns one invocation's input and drains partial receipt prefixes.
 *
 * One transport failure after a valid receipt prefix is retried with the same event IDs.
 */
export async function pushLosslessEvents(
  port: Pick<DriverRuntimeEventPort, "pushEvents">,
  events: readonly DriverEventInput[],
  onAccepted?: (receipts: readonly DriverEventReceipt[]) => void,
  signal?: AbortSignal,
): Promise<readonly DriverEventReceipt[]> {
  const receipts: DriverEventReceipt[] = [];
  const deadline = signal ?? AbortSignal.timeout(DRIVER_EVENT_DELIVERY_TIMEOUT_MS);
  let remaining = structuredClone(withSourceEventIds(events));
  let retryTransport = false;

  while (remaining.length > 0) {
    deadline.throwIfAborted();
    let result: DriverEventBatchOutput;

    try {
      result = await port.pushEvents({
        events: remaining,
        signal: deadline,
      });
    } catch (error) {
      if (error instanceof DriverEventRejectedError) {
        throw error;
      }

      if (!retryTransport) {
        throw new DriverEventDeliveryOutcomeUnknownError(error);
      }

      retryTransport = false;
      continue;
    }

    assertDriverEventReceiptPrefix(remaining, result.accepted);

    if (result.accepted.length === 0) {
      throw new Error("Driver event delivery made no progress.");
    }

    onAccepted?.(result.accepted);
    receipts.push(...result.accepted);
    remaining = remaining.slice(result.accepted.length);
    retryTransport = true;
  }

  return receipts;
}

export interface DriverRuntimeCommandPort {
  commandUpdate(input: DriverCommandUpdate, signal: AbortSignal): Promise<void>;
  nextCommand(signal: AbortSignal): Promise<RuntimeCommand | null>;
}

/** API-owned durable effect ledger used only for external MCP calls. */
export interface DriverRuntimeExternalToolEffectPort {
  claimExternalToolEffect(
    input: { claimToken: string; commandId: string },
    signal: AbortSignal,
  ): Promise<McpExternalToolEffectClaim>;
  observeExternalToolEffect(
    input: { commandId: string },
    signal: AbortSignal,
  ): Promise<McpExternalToolEffectState>;
  settleExternalToolEffect(
    input: {
      claimToken: string;
      commandId: string;
      effectId: string;
      settlement: McpExternalToolEffectSettlement;
    },
    signal: AbortSignal,
  ): Promise<McpExternalToolEffectState>;
}

export interface DriverRuntimeRunPort {
  beginRun(runId: RunId): DriverRunTicket;
  claimRunCancellation(
    ticket: DriverRunTicket,
    reason: string,
  ): "already_claimed" | "claimed" | "terminal_selected";
  completeRun(signal?: AbortSignal): Promise<void>;
  failRun(error: DriverFailureInput["error"], signal?: AbortSignal): Promise<void>;
  releaseRun(ticket: DriverRunTicket, reason: "command_acked" | "driver_failing"): void;
  runSnapshot(runId?: RunId): DriverRunSnapshot | null;
  settleRunInput(ticket: DriverRunTicket, outcome: DriverInputOutcome): DriverInputSettlement;
}

export interface DriverRuntimeHeartbeatPort {
  heartbeat(input: Omit<DriverHeartbeatInput, "pid">): Promise<DriverHeartbeatOutput>;
}

export interface DriverRuntimeIo
  extends
    DriverRuntimeCommandPort,
    DriverRuntimeExternalToolEffectPort,
    DriverRuntimeEventPort,
    DriverRuntimeHeartbeatPort,
    DriverRuntimeRunPort {
  registerRunTerminalBarrier(barrier: DriverRunTerminalBarrier): () => void;
}
