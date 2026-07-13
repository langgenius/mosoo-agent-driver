import { summarizeDriverPermissionRequest } from "../infrastructure/logging/driver-debug";
import type { Logger } from "../observability";
import type { DriverEventInput } from "../protocol/events";
import { settlePromiseWithTimeout } from "../utils/async";
import { createDriverDiagnosticEvent } from "./driver-diagnostics";
import { pushLosslessEvents } from "./driver-runtime-io";
import type { DriverRuntimeEventPort } from "./driver-runtime-io";

const PERMISSION_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const PERMISSION_EVENT_DELIVERY_TIMEOUT_MS = 10_000;
const MAX_PENDING_PERMISSION_REQUEST_BYTES = 8 * 1_024 * 1_024;
const MAX_PENDING_PERMISSION_REQUESTS = 1_024;
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

export interface DriverPermissionRequest {
  rawInput: string | null;
  requestId: string;
  title: string;
  toolCallId: string | null;
  toolKind: string | null;
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
    for (const requestId of this.#resolvers.keys()) {
      this.resolveRequest(requestId, {
        decision: "reject_once",
        reason,
      });
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
  ): Promise<PermissionDecision> {
    if (!this.#interactiveRequests) {
      this.#logger()?.debug("driver.runtime.permission.request.rejected", {
        ...summarizeDriverPermissionRequest(input),
        reason: "interactive_permission_unsupported",
      });
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

    const events: DriverEventInput[] = [
      {
        kind: "permission.requested",
        payload: {
          details: input.rawInput,
          options: [],
          requestId: input.requestId,
          targetItemId: input.toolCallId,
          title: input.title,
          toolCall: {
            kind: input.toolKind,
            toolCallId: input.toolCallId,
          },
        },
      },
    ];
    const deferred = Promise.withResolvers<PermissionResolution>();
    const unregister = () => {
      if (this.#resolvers.get(input.requestId) === deferred.resolve) {
        this.#resolvers.delete(input.requestId);
      }
    };
    const cancel = () => {
      if (this.#resolvers.get(input.requestId) === deferred.resolve) {
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
    };
    this.#resolvers.set(input.requestId, deferred.resolve);
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

      const requestedTask = pushLosslessEvents(socket, events);
      const requestedDelivery = await settlePromiseWithTimeout(
        requestedTask,
        {
          label: `Driver permission request ${input.requestId} event delivery`,
          timeoutMs: this.#eventDeliveryTimeoutMs,
        },
      );

      if (requestedDelivery.status !== "completed") {
        if (requestedDelivery.status === "timed_out") {
          lateDelivery = requestedTask;
        }
        throw new PermissionEventDeliveryError(
          input.requestId,
          "requested",
          requestedDelivery.error,
        );
      }

      this.#logger()?.debug("driver.runtime.permission.request.sent", {
        requestId: input.requestId,
        timeoutMs: this.#requestTimeoutMs,
        toolCallId: input.toolCallId,
        toolKind: input.toolKind,
      });

      const result = await settlePromiseWithTimeout(deferred.promise, {
        label: `Driver permission request ${input.requestId}`,
        timeoutMs: this.#requestTimeoutMs,
      });

      if (result.status === "failed") {
        throw result.error;
      }

      const resolution: PermissionResolution =
        result.status === "timed_out"
          ? { decision: "reject_once", reason: "timed_out" }
          : result.value;
      unregister();
      const decision = resolution.decision;

      if (result.status === "timed_out") {
        this.#logger()?.debug("driver.runtime.permission.request.timed_out", {
          requestId: input.requestId,
          timeoutMs: this.#requestTimeoutMs,
        });
      }

      const resolutionTask = pushLosslessEvents(socket, [
          {
            kind: "permission.resolved",
            payload: {
              outcome: decision,
              permissionRequests: [],
              reason: resolution.reason,
              requestId: input.requestId,
            },
          },
          ...toResolutionDiagnostics(input, resolution.reason),
        ]);
      const resolutionDelivery = await settlePromiseWithTimeout(
        resolutionTask,
        {
          label: `Driver permission resolution ${input.requestId} event delivery`,
          timeoutMs: this.#eventDeliveryTimeoutMs,
        },
      );

      if (resolutionDelivery.status !== "completed") {
        if (resolutionDelivery.status === "timed_out") {
          lateDelivery = resolutionTask;
        }
        throw new PermissionEventDeliveryError(
          input.requestId,
          "resolved",
          resolutionDelivery.error,
        );
      }

      this.#logger()?.debug("driver.runtime.permission.request.resolved", {
        decision,
        reason: resolution.reason,
        requestId: input.requestId,
      });

      return decision;
    } finally {
      unregister();
      signal?.removeEventListener("abort", cancel);
      if (lateDelivery === null) {
        releaseLease();
      } else {
        void lateDelivery.then(releaseLease, releaseLease);
      }
    }
  }
}

function toResolutionDiagnostics(
  input: DriverPermissionRequest,
  reason: PermissionResolutionReason,
): DriverEventInput[] {
  if (reason !== "cancelled" && reason !== "timed_out") {
    return [];
  }

  return [
    createDriverDiagnosticEvent({
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
  ];
}
