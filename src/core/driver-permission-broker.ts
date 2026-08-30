import { createHash } from "node:crypto";

import { summarizeDriverPermissionRequest } from "../observability/driver-debug";
import type { Logger } from "../observability";
import type { DriverPermissionRequest } from "../host-ports";
import type { DriverEventInput } from "../protocol/events";
import type { RunId } from "../protocol/id";
import { promiseWithTimeout, settlePromiseWithTimeout } from "../utils/async";
import { createDriverDiagnosticEvent } from "./driver-diagnostics";
import { DriverEventDeliveryOutcomeUnknownError, pushLosslessEvents } from "./driver-runtime-io";
import type { DriverRuntimeEventPort } from "./driver-runtime-io";

const PERMISSION_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const PERMISSION_EVENT_DELIVERY_TIMEOUT_MS = 10_000;
const PERMISSION_CANCEL_DELIVERY_TIMEOUT_MS = 1_500;
const MAX_PENDING_PERMISSION_REQUEST_BYTES = 8 * 1_024 * 1_024;
const MAX_PENDING_PERMISSION_REQUESTS = 1_024;
const MAX_PERMISSION_REQUEST_EVENT_BYTES = 512 * 1_024;
const UTF8 = new TextEncoder();

export type PermissionDecision = "allow_once" | "reject_once";
export type PermissionResolutionReason = "approved" | "cancelled" | "rejected" | "timed_out";

export class PermissionEventDeliveryError extends Error {
  readonly phase: "requested" | "resolved";
  readonly requestId: string;

  constructor(requestId: string, phase: "requested" | "resolved", cause: unknown) {
    super(`Driver permission ${phase} event ${requestId} could not be delivered.`, { cause });
    this.name = "PermissionEventDeliveryError";
    this.phase = phase;
    this.requestId = requestId;
  }
}

interface PermissionResolution {
  decision: PermissionDecision;
  reason: PermissionResolutionReason;
}

interface PermissionCancellationDelivery {
  useFullBudget(): void;
  useTurnBudget(): void;
}

interface PermissionDeliveryFailure {
  readonly error: PermissionEventDeliveryError;
  recover(): Promise<void>;
}

export interface DriverPermissionBrokerOptions {
  eventDeliveryTimeoutMs?: number;
  interactiveRequests?: boolean;
  maxPendingRequestBytes?: number;
  maxPendingRequests?: number;
  requestTimeoutMs?: number;
}

export class DriverPermissionBroker {
  readonly #eventDeliveryTimeoutMs: number;
  readonly #interactiveRequests: boolean;
  readonly #logger: () => Logger | null;
  readonly #maxPendingRequestBytes: number;
  readonly #maxPendingRequests: number;
  readonly #requestTimeoutMs: number;
  readonly #activeRequestIds = new Set<string>();
  #activeRequestBytes = 0;
  readonly #cancellationDeliveries = new Map<string, PermissionCancellationDelivery>();
  #cancellationTask: Promise<void> | null = null;
  #closedRunId: RunId | null = null;
  readonly #deliveryFailures = new Map<string, PermissionDeliveryFailure>();
  #idle: PromiseWithResolvers<void> | null = null;
  readonly #resolvers = new Map<string, (resolution: PermissionResolution) => void>();

  constructor(logger: () => Logger | null, options: DriverPermissionBrokerOptions = {}) {
    this.#eventDeliveryTimeoutMs =
      options.eventDeliveryTimeoutMs ?? PERMISSION_EVENT_DELIVERY_TIMEOUT_MS;
    this.#interactiveRequests = options.interactiveRequests ?? true;
    this.#logger = logger;
    this.#maxPendingRequestBytes =
      options.maxPendingRequestBytes ?? MAX_PENDING_PERMISSION_REQUEST_BYTES;
    this.#maxPendingRequests = options.maxPendingRequests ?? MAX_PENDING_PERMISSION_REQUESTS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? PERMISSION_REQUEST_TIMEOUT_MS;

    if (
      [this.#maxPendingRequestBytes, this.#maxPendingRequests].some(
        (limit) => !Number.isSafeInteger(limit) || limit < 1,
      )
    ) {
      throw new RangeError("Driver permission broker limits must be positive safe integers.");
    }

    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 0) {
      throw new RangeError(
        "Driver permission broker request timeout must be a non-negative safe integer.",
      );
    }

    if (!Number.isSafeInteger(this.#eventDeliveryTimeoutMs) || this.#eventDeliveryTimeoutMs < 0) {
      throw new RangeError(
        "Driver permission broker event delivery timeout must be a non-negative safe integer.",
      );
    }
  }

  capabilityStatus(): "supported" | "unsupported" {
    return this.#interactiveRequests ? "supported" : "unsupported";
  }

  hasPending(): boolean {
    return this.#activeRequestIds.size > 0;
  }

  resolve(requestId: string, decision: PermissionDecision): boolean {
    return this.resolveRequest(requestId, {
      decision,
      reason: decision === "allow_once" ? "approved" : "rejected",
    });
  }

  rejectAll(reason: PermissionResolutionReason = "cancelled"): void {
    this.#rejectAll(reason, PERMISSION_CANCEL_DELIVERY_TIMEOUT_MS);
  }

  #rejectAll(reason: PermissionResolutionReason, deliveryTimeoutMs?: number): void {
    for (const delivery of this.#cancellationDeliveries.values()) {
      if (deliveryTimeoutMs === undefined) {
        delivery.useFullBudget();
      } else {
        delivery.useTurnBudget();
      }
    }

    for (const requestId of this.#resolvers.keys()) {
      this.resolveRequest(requestId, {
        decision: "reject_once",
        reason,
      });
    }
  }

  rejectAllAndWait(reason: PermissionResolutionReason = "cancelled"): Promise<void> {
    this.#rejectAll(reason);

    if (!this.hasPending()) {
      return this.#recoverDeliveryFailures();
    }
    if (this.#cancellationTask !== null) {
      return this.#cancellationTask;
    }

    const idle = this.#idle!;
    const task = promiseWithTimeout(idle.promise, {
      label: "Driver permission cancellation",
      timeoutMs: this.#eventDeliveryTimeoutMs * 2,
    }).then(() => this.#recoverDeliveryFailures());
    this.#cancellationTask = task;
    const clear = () => {
      if (this.#cancellationTask === task) {
        this.#cancellationTask = null;
      }
    };
    void task.then(clear, clear);
    return task;
  }

  rejectRunAndWait(
    runId: RunId,
    reason: PermissionResolutionReason = "cancelled",
  ): Promise<void> | void {
    this.#closedRunId = runId;
    if (!this.hasPending() && this.#deliveryFailures.size === 0) {
      this.#rejectAll(reason);
      return;
    }
    return this.rejectAllAndWait(reason);
  }

  async #recoverDeliveryFailures(): Promise<void> {
    const failures = [...this.#deliveryFailures.entries()];
    await Promise.allSettled(
      failures.map(async ([lifecycleId, failure]) => {
        const recovery = failure.recover();
        const result = await settlePromiseWithTimeout(recovery, {
          label: "Driver permission lifecycle recovery",
          timeoutMs: this.#eventDeliveryTimeoutMs,
        });
        if (result.status !== "completed") {
          if (result.status === "timed_out") {
            void recovery.then(
              () => {
                if (this.#deliveryFailures.get(lifecycleId) === failure) {
                  this.#deliveryFailures.delete(lifecycleId);
                }
              },
              () => {},
            );
          }
          throw result.error;
        }
        if (this.#deliveryFailures.get(lifecycleId) === failure) {
          this.#deliveryFailures.delete(lifecycleId);
        }
      }),
    );
    const failure = this.#deliveryFailures.values().next().value;
    if (failure !== undefined) {
      throw failure.error;
    }
  }

  private resolveRequest(requestId: string, resolution: PermissionResolution): boolean {
    const resolve = this.#resolvers.get(requestId);

    if (!resolve) {
      return false;
    }

    this.#resolvers.delete(requestId);
    resolve(resolution);
    return true;
  }

  async request(
    socket: DriverRuntimeEventPort,
    input: DriverPermissionRequest,
    signal?: AbortSignal,
    ownsRun?: () => boolean,
  ): Promise<PermissionDecision> {
    if (!this.#interactiveRequests) {
      this.#logger()?.debug("driver.runtime.permission.request.rejected", {
        ...summarizeDriverPermissionRequest(input),
        reason: "interactive_permission_unsupported",
      });
      return "reject_once";
    }

    const runId = socket.currentRunId();
    const isCurrentRun = ownsRun ?? (() => socket.currentRunId() === runId);
    if (!isCurrentRun() || (runId !== null && this.#closedRunId === runId)) {
      return "reject_once";
    }

    if (this.#activeRequestIds.has(input.requestId)) {
      throw new Error(`Driver permission request ${input.requestId} is already pending.`);
    }

    if (this.#activeRequestIds.size >= this.#maxPendingRequests) {
      throw new RangeError("Driver permission broker pending request limit is exhausted.");
    }

    const bytes = UTF8.encode(JSON.stringify(input)).byteLength;

    if (bytes > this.#maxPendingRequestBytes - this.#activeRequestBytes) {
      throw new RangeError("Driver permission broker pending request byte budget is exhausted.");
    }

    const lifecycleId = permissionLifecycleId(runId, input.requestId);
    const events: DriverEventInput[] = [
      {
        kind: "permission.requested",
        payload: {
          ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
          ...(input.blockedPath === undefined ? {} : { blockedPath: input.blockedPath }),
          ...(input.decisionReason === undefined ? {} : { decisionReason: input.decisionReason }),
          details: input.rawInput,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.matchedAskRule === undefined ? {} : { matchedAskRule: input.matchedAskRule }),
          options: [],
          requestId: input.requestId,
          targetItemId: input.toolCallId,
          title: input.title,
          toolCall: {
            kind: input.toolKind,
            toolCallId: input.toolCallId,
          },
        },
        ...(runId === null ? {} : { runId }),
        sourceEventId: `${lifecycleId}:requested`,
      },
    ];

    if (UTF8.encode(JSON.stringify(events[0])).byteLength > MAX_PERMISSION_REQUEST_EVENT_BYTES) {
      throw new RangeError(
        `Driver permission request event exceeds ${String(MAX_PERMISSION_REQUEST_EVENT_BYTES)} UTF-8 bytes.`,
      );
    }

    const deferred = Promise.withResolvers<PermissionResolution>();
    const cancellationDelivery = new AbortController();
    let cancellationDeliveryTimeout: ReturnType<typeof setTimeout> | null = null;
    let useFullCancellationBudget = false;
    const cancellation: PermissionCancellationDelivery = {
      useFullBudget: () => {
        useFullCancellationBudget = true;
        if (cancellationDeliveryTimeout !== null) {
          clearTimeout(cancellationDeliveryTimeout);
          cancellationDeliveryTimeout = null;
        }
      },
      useTurnBudget: () => {
        if (useFullCancellationBudget || cancellationDeliveryTimeout !== null) {
          return;
        }

        cancellationDeliveryTimeout = setTimeout(
          () =>
            cancellationDelivery.abort(
              new Error("Driver permission cancellation delivery timed out."),
            ),
          PERMISSION_CANCEL_DELIVERY_TIMEOUT_MS,
        );
      },
    };
    const resolvePermission = deferred.resolve;
    const unregister = () => {
      if (this.#resolvers.get(input.requestId) === resolvePermission) {
        this.#resolvers.delete(input.requestId);
      }
    };
    const cancel = () => {
      cancellation.useTurnBudget();
      if (this.#resolvers.get(input.requestId) === resolvePermission) {
        this.resolveRequest(input.requestId, {
          decision: "reject_once",
          reason: "cancelled",
        });
      }
    };
    let lateDelivery: Promise<unknown> | null = null;
    let released = false;
    const releaseLease = () => {
      if (released) {
        return;
      }

      released = true;
      this.#activeRequestIds.delete(input.requestId);
      this.#activeRequestBytes -= bytes;
      this.#cancellationDeliveries.delete(input.requestId);
      if (!this.hasPending()) {
        const idle = this.#idle;
        this.#idle = null;
        idle?.resolve();
      }
    };
    if (!this.hasPending()) {
      this.#cancellationTask = null;
      this.#idle = Promise.withResolvers<void>();
    }
    this.#cancellationDeliveries.set(input.requestId, cancellation);
    this.#resolvers.set(input.requestId, resolvePermission);
    this.#activeRequestIds.add(input.requestId);
    this.#activeRequestBytes += bytes;

    try {
      if (signal?.aborted) {
        cancel();
      } else {
        signal?.addEventListener("abort", cancel, { once: true });
      }

      this.#logger()?.debug("driver.runtime.permission.request.sending", {
        ...summarizeDriverPermissionRequest(input),
        timeoutMs: this.#requestTimeoutMs,
      });

      const deliverySignal = () =>
        AbortSignal.any([
          cancellationDelivery.signal,
          AbortSignal.timeout(this.#eventDeliveryTimeoutMs),
        ]);
      const requestedTask = pushPermissionEvents(socket, events, deliverySignal());
      const requestedDelivery = await settlePromiseWithTimeout(requestedTask, {
        label: `Driver permission request ${input.requestId} event delivery`,
        timeoutMs: this.#eventDeliveryTimeoutMs,
      });

      if (requestedDelivery.status !== "completed") {
        const deliveryError = new PermissionEventDeliveryError(
          input.requestId,
          "requested",
          requestedDelivery.error,
        );
        const outcomeUnknown =
          requestedDelivery.status === "timed_out" ||
          requestedDelivery.error instanceof DriverEventDeliveryOutcomeUnknownError;

        if (!outcomeUnknown) {
          throw deliveryError;
        }

        const cancelled: PermissionResolution = {
          decision: "reject_once",
          reason: "cancelled",
        };
        const resolutionEvents = toResolutionEvents(input, cancelled, runId, lifecycleId);
        this.#deliveryFailures.set(lifecycleId, {
          error: deliveryError,
          recover: async () => {
            await pushPermissionEvents(
              socket,
              [...events, ...resolutionEvents],
              AbortSignal.timeout(this.#eventDeliveryTimeoutMs),
            );
          },
        });
        const closeLifecycle = () =>
          pushPermissionEvents(socket, [...events, ...resolutionEvents], deliverySignal()).then(
            () => {
              this.#deliveryFailures.delete(lifecycleId);
            },
          );

        if (requestedDelivery.status === "timed_out") {
          lateDelivery = requestedTask.then(
            () => pushPermissionEvents(socket, resolutionEvents, deliverySignal()),
            closeLifecycle,
          );
          lateDelivery = lateDelivery.then(() => {
            this.#deliveryFailures.delete(lifecycleId);
          });
          throw deliveryError;
        }

        const recoveryTask = closeLifecycle();
        const recovery = await settlePromiseWithTimeout(recoveryTask, {
          label: `Driver permission request ${input.requestId} lifecycle recovery`,
          timeoutMs: this.#eventDeliveryTimeoutMs,
        });
        if (recovery.status === "completed") {
          return "reject_once";
        }
        if (recovery.status === "timed_out") {
          lateDelivery = recoveryTask;
        }
        throw new PermissionEventDeliveryError(input.requestId, "requested", recovery.error);
      }

      this.#logger()?.debug("driver.runtime.permission.request.sent", {
        requestId: input.requestId,
        timeoutMs: this.#requestTimeoutMs,
        toolCallId: input.toolCallId,
        toolKind: input.toolKind,
      });

      const result = isCurrentRun()
        ? await settlePromiseWithTimeout(deferred.promise, {
            label: `Driver permission request ${input.requestId}`,
            timeoutMs: this.#requestTimeoutMs,
          })
        : ({
            status: "completed",
            value: { decision: "reject_once", reason: "cancelled" },
          } as const);

      if (result.status === "failed") {
        throw result.error;
      }

      let resolution: PermissionResolution =
        result.status === "timed_out"
          ? { decision: "reject_once", reason: "timed_out" }
          : result.value;
      if (!isCurrentRun()) {
        resolution = { decision: "reject_once", reason: "cancelled" };
      }
      unregister();
      const decision = resolution.decision;

      if (result.status === "timed_out") {
        this.#logger()?.debug("driver.runtime.permission.request.timed_out", {
          requestId: input.requestId,
          timeoutMs: this.#requestTimeoutMs,
        });
      }

      const resolutionEvents = toResolutionEvents(input, resolution, runId, lifecycleId);
      const resolutionTask = pushPermissionEvents(socket, resolutionEvents, deliverySignal());
      const resolutionDelivery = await settlePromiseWithTimeout(resolutionTask, {
        label: `Driver permission resolution ${input.requestId} event delivery`,
        timeoutMs: this.#eventDeliveryTimeoutMs,
      });

      if (resolutionDelivery.status !== "completed") {
        const deliveryError = new PermissionEventDeliveryError(
          input.requestId,
          "resolved",
          resolutionDelivery.error,
        );
        this.#deliveryFailures.set(lifecycleId, {
          error: deliveryError,
          recover: async () => {
            await pushPermissionEvents(
              socket,
              resolutionEvents,
              AbortSignal.timeout(this.#eventDeliveryTimeoutMs),
            );
          },
        });
        if (resolutionDelivery.status === "timed_out") {
          lateDelivery = resolutionTask
            .catch(() => pushPermissionEvents(socket, resolutionEvents, deliverySignal()))
            .then(() => {
              this.#deliveryFailures.delete(lifecycleId);
            });
        }
        throw deliveryError;
      }

      this.#deliveryFailures.delete(lifecycleId);

      this.#logger()?.debug("driver.runtime.permission.request.resolved", {
        decision,
        reason: resolution.reason,
        requestId: input.requestId,
      });

      return isCurrentRun() ? decision : "reject_once";
    } finally {
      unregister();
      signal?.removeEventListener("abort", cancel);
      if (cancellationDeliveryTimeout !== null) {
        clearTimeout(cancellationDeliveryTimeout);
      }
      if (lateDelivery === null) {
        releaseLease();
      } else {
        void lateDelivery.then(releaseLease, releaseLease);
      }
    }
  }
}

function permissionLifecycleId(runId: RunId | null, requestId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, requestId]))
    .digest("hex");
  return `permission:${digest}`;
}

async function pushPermissionEvents(
  socket: Pick<DriverRuntimeEventPort, "pushEvents">,
  events: readonly DriverEventInput[],
  signal: AbortSignal,
) {
  try {
    return await pushLosslessEvents(socket, events, undefined, signal);
  } catch (error) {
    if (!(error instanceof DriverEventDeliveryOutcomeUnknownError)) {
      throw error;
    }

    try {
      return await pushLosslessEvents(socket, events, undefined, signal);
    } catch (retryError) {
      throw retryError instanceof DriverEventDeliveryOutcomeUnknownError
        ? retryError
        : new DriverEventDeliveryOutcomeUnknownError(retryError);
    }
  }
}

function toResolutionEvents(
  input: DriverPermissionRequest,
  resolution: PermissionResolution,
  runId: RunId | null,
  lifecycleId: string,
): DriverEventInput[] {
  return [
    {
      kind: "permission.resolved",
      payload: {
        outcome: resolution.decision,
        permissionRequests: [],
        reason: resolution.reason,
        requestId: input.requestId,
      },
      ...(runId === null ? {} : { runId }),
      sourceEventId: `${lifecycleId}:resolved`,
    },
    ...toResolutionDiagnostics(input, resolution.reason, runId, lifecycleId),
  ];
}

function toResolutionDiagnostics(
  input: DriverPermissionRequest,
  reason: PermissionResolutionReason,
  runId: RunId | null,
  lifecycleId: string,
): DriverEventInput[] {
  if (reason !== "cancelled" && reason !== "timed_out") {
    return [];
  }

  return [
    {
      ...createDriverDiagnosticEvent({
        code: reason === "cancelled" ? "permission.cancelled" : "permission.timed_out",
        details: {
          requestId: input.requestId,
          toolCallId: input.toolCallId,
          toolKind: input.toolKind,
        },
        message:
          reason === "cancelled"
            ? "Permission request was cancelled."
            : "Permission request timed out.",
        reason,
        severity: reason === "cancelled" ? "info" : "warn",
        source: "permission",
      }),
      ...(runId === null ? {} : { runId }),
      sourceEventId: `${lifecycleId}:diagnostic:${reason}`,
    },
  ];
}
