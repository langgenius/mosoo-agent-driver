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
  McpExecuteCommandResult,
  McpExternalToolEffectClaim,
  RunError,
  RuntimeCommand,
  RuntimeCommandResult,
} from "../runtime-command";

export interface DriverRuntimeEventPort {
  currentRunId(): RunId | null;
  pushEvents(input: {
    events: DriverEventInput[];
    signal?: AbortSignal;
  }): Promise<DriverEventBatchOutput>;
  runEventTerminal?(runId: RunId): "cancelled" | "completed" | "failed" | null;
}

export const DRIVER_EVENT_DELIVERY_TIMEOUT_MS = 10_000;

export class DriverEventRejectedError extends Error {
  readonly sourceEventId: string;

  constructor(sourceEventId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Driver event was rejected.", { cause });
    this.name = "DriverEventRejectedError";
    this.sourceEventId = sourceEventId;
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

    if (receipt.eventId !== undefined && receipt.eventId !== eventId) {
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
      if (error instanceof DriverEventRejectedError || !retryTransport) {
        throw error;
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
  commandUpdate(
    input: {
      commandId: string;
      error?: RunError;
      result?: RuntimeCommandResult;
      status: "accepted" | "cancelled" | "completed" | "failed";
    },
    signal: AbortSignal,
  ): Promise<void>;
  nextCommand(signal: AbortSignal): Promise<RuntimeCommand | null>;
}

/** API-owned durable effect ledger used only for external MCP calls. */
export interface DriverRuntimeExternalToolEffectPort {
  claimExternalToolEffect(
    input: { commandId: string },
    signal: AbortSignal,
  ): Promise<McpExternalToolEffectClaim>;
  completeExternalToolEffect(
    input: {
      commandId: string;
      providerReceiptJson?: string | null | undefined;
      result: McpExecuteCommandResult;
    },
    signal: AbortSignal,
  ): Promise<void>;
  markExternalToolEffectUnknown(input: { commandId: string }, signal: AbortSignal): Promise<void>;
}

export interface DriverRuntimeRunPort {
  beginRun(runId: RunId): void;
  completeRun(signal?: AbortSignal): Promise<void>;
  endRun(runId: RunId): void;
  failRun(error: DriverFailureInput["error"], signal?: AbortSignal): Promise<void>;
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
    DriverRuntimeRunPort {}
