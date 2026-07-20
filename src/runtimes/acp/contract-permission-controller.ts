import { isDeepStrictEqual } from "node:util";

import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

import { interactionSchema } from "../../contract";
import type { Interaction, InteractionResolution } from "../../contract";
import {
  AuthorityOutcomeUnknownError,
  createProviderMeta,
  ContractProjection,
  nonEmpty,
} from "../contract-projection";
import type { AcpContractSessionUpdateInbox } from "./contract-session-update-inbox";
import type { AcpContractItemProjector } from "./contract-item-projector";

const { cause: providerCause, provenance } = createProviderMeta("agent-client-protocol");

interface PermissionIntent {
  readonly bytes: number;
  released: boolean;
  readonly receivedAt: string;
  readonly request: RequestPermissionRequest;
  readonly runId: string;
}

interface PendingPermission {
  readonly intent: PermissionIntent;
  readonly interaction: Interaction;
  opened: boolean;
  readonly optionIds: ReadonlyMap<string, string>;
  response?: RequestPermissionResponse;
  readonly toolCallId: string;
}

interface OpeningPermission {
  readonly intent: PermissionIntent;
  readonly promise: Promise<string>;
}

interface UnknownPermission {
  readonly error: AuthorityOutcomeUnknownError;
  readonly intent: PermissionIntent;
  retry?: Promise<string>;
}

export interface AcpContractPermissionControllerOptions {
  readonly assertNativeSession: (sessionId: string) => void;
  readonly createId: () => string;
  readonly inbox: AcpContractSessionUpdateInbox;
  readonly interactionTimeoutMs: number;
  readonly items: AcpContractItemProjector;
  readonly maxPendingPermissionBytes: number;
  readonly now: () => string;
  readonly projection: ContractProjection;
  readonly resolveId: (runId: string, kind: string, nativeId: string) => string;
  readonly withReceiptTime: <T>(receivedAt: string, operation: () => Promise<T>) => Promise<T>;
}

export class AcpContractPermissionController {
  readonly #assertNativeSession: (sessionId: string) => void;
  readonly #createId: () => string;
  #disposed = false;
  readonly #inbox: AcpContractSessionUpdateInbox;
  readonly #interactionTimeoutMs: number;
  readonly #items: AcpContractItemProjector;
  readonly #maxPendingPermissionBytes: number;
  readonly #now: () => string;
  readonly #openingPermissions = new Map<string, OpeningPermission>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  #pendingPermissionBytes = 0;
  readonly #projection: ContractProjection;
  readonly #resolveId: AcpContractPermissionControllerOptions["resolveId"];
  readonly #textEncoder = new TextEncoder();
  #unknownPermission: UnknownPermission | undefined;
  readonly #withReceiptTime: AcpContractPermissionControllerOptions["withReceiptTime"];

  constructor(options: AcpContractPermissionControllerOptions) {
    this.#assertNativeSession = options.assertNativeSession;
    this.#createId = options.createId;
    this.#inbox = options.inbox;
    this.#interactionTimeoutMs = options.interactionTimeoutMs;
    this.#items = options.items;
    this.#maxPendingPermissionBytes = options.maxPendingPermissionBytes;
    this.#now = options.now;
    this.#projection = options.projection;
    this.#resolveId = options.resolveId;
    this.#withReceiptTime = options.withReceiptTime;
  }

  async openPermission(runId: string, request: RequestPermissionRequest): Promise<string> {
    this.#assertActive();
    const snapshot = structuredClone(request);
    const unknownAtAdmission = this.#unknownPermission;
    const exactRetry =
      unknownAtAdmission !== undefined &&
      unknownAtAdmission.intent.runId === runId &&
      isDeepStrictEqual(unknownAtAdmission.intent.request, snapshot)
        ? unknownAtAdmission
        : undefined;

    if (unknownAtAdmission !== undefined && exactRetry === undefined) {
      throw unknownAtAdmission.error;
    }

    if (exactRetry?.retry !== undefined) {
      return exactRetry.retry;
    }

    const toolCallId = snapshot.toolCall.toolCallId;
    const openingAtAdmission = this.#openingPermissions.get(toolCallId);

    if (openingAtAdmission !== undefined) {
      if (
        openingAtAdmission.intent.runId !== runId ||
        !isDeepStrictEqual(openingAtAdmission.intent.request, snapshot)
      ) {
        throw new Error(`ACP v1 permission request ${toolCallId} changed identity or content.`);
      }

      return openingAtAdmission.promise;
    }

    const existing = [...this.#pendingPermissions].find(
      ([, candidate]) => candidate.toolCallId === toolCallId,
    );

    if (existing !== undefined) {
      const [interactionId, pending] = existing;

      if (pending.intent.runId !== runId || !isDeepStrictEqual(pending.intent.request, snapshot)) {
        throw new Error(`ACP v1 permission request ${toolCallId} changed identity or content.`);
      }

      if (pending.opened) {
        return interactionId;
      }
    }

    let intent = exactRetry?.intent;

    if (intent === undefined) {
      const bytes = this.#textEncoder.encode(JSON.stringify(snapshot)).byteLength;

      if (bytes > this.#maxPendingPermissionBytes - this.#pendingPermissionBytes) {
        throw new RangeError("ACP v1 pending permission budget is exhausted.");
      }

      this.#pendingPermissionBytes += bytes;
      intent = {
        bytes,
        receivedAt: this.#projection.now().toISOString(),
        released: false,
        request: snapshot,
        runId,
      };
    }

    const stableIntent = intent;
    const opening = this.#inbox.enqueue(async () => {
      try {
        const unknown = this.#unknownPermission;

        if (unknown !== undefined && unknown !== unknownAtAdmission) {
          throw unknown.error;
        }

        const interactionId = await this.#withReceiptTime(stableIntent.receivedAt, () =>
          this.#openPermission(stableIntent),
        );

        if (this.#unknownPermission === unknownAtAdmission) {
          this.#unknownPermission = undefined;
        }

        return interactionId;
      } catch (error) {
        if (error instanceof AuthorityOutcomeUnknownError) {
          this.#unknownPermission ??= { error, intent: stableIntent };
        } else if (this.#unknownPermission?.intent === stableIntent) {
          this.#unknownPermission = undefined;
        }

        throw error;
      } finally {
        if (!this.#permissionRetained(stableIntent)) {
          this.#releasePermissionIntent(stableIntent);
        }
      }
    });

    const tracked = opening.finally(() => {
      if (this.#openingPermissions.get(toolCallId)?.promise === tracked) {
        this.#openingPermissions.delete(toolCallId);
      }

      if (exactRetry !== undefined && exactRetry.retry === tracked) {
        delete exactRetry.retry;
      }
    });
    this.#openingPermissions.set(toolCallId, { intent: stableIntent, promise: tracked });
    if (exactRetry !== undefined) {
      exactRetry.retry = tracked;
    }

    return tracked;
  }

  async #openPermission(intent: PermissionIntent): Promise<string> {
    const { request, runId } = intent;
    let pending: PendingPermission | undefined;

    try {
      this.#assertActive();
      this.#assertNativeSession(request.sessionId);

      const existing = [...this.#pendingPermissions].find(
        ([, candidate]) => candidate.toolCallId === request.toolCall.toolCallId,
      );

      if (existing !== undefined) {
        const [interactionId, existingPermission] = existing;

        if (
          existingPermission.intent.runId !== runId ||
          !isDeepStrictEqual(existingPermission.intent.request, request)
        ) {
          throw new Error(
            `ACP v1 permission request ${request.toolCall.toolCallId} changed identity or content.`,
          );
        }

        if (!existingPermission.opened) {
          try {
            await this.#projection.putInteraction(
              runId,
              "permission/requested",
              providerCause("permission/requested", existingPermission.toolCallId),
              existingPermission.interaction,
            );
            existingPermission.opened = true;
          } catch (error) {
            if (!(error instanceof AuthorityOutcomeUnknownError)) {
              this.#dropPermission(interactionId);
            }

            throw error;
          }
        }

        if (existingPermission.response !== undefined) {
          this.#projection.releaseInteraction(interactionId);
          this.#dropPermission(interactionId);
        }

        return interactionId;
      }

      if (request.options.length === 0) {
        throw new Error("ACP v1 permission request must advertise at least one option.");
      }

      const item = await this.#items.putTool(runId, request.toolCall, "permission/requested.tool");
      const createdAt = this.#now();
      const optionIds = new Map<string, string>();
      const options = request.options.map((option) => {
        const id = this.#resolveId(runId, "permission-option", option.optionId);
        optionIds.set(id, option.optionId);
        return {
          effect: option.kind.startsWith("allow") ? "allow" : "deny",
          id,
          label: nonEmpty(option.name, option.optionId),
          scope: option.kind.endsWith("always") ? "session" : "once",
        };
      });
      const interaction = interactionSchema.parse({
        audience: "participants",
        blocking: true,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + this.#interactionTimeoutMs).toISOString(),
        id: this.#createId(),
        itemId: item.id,
        kind: "permission",
        provenance: provenance("permission/requested", { toolCallId: request.toolCall.toolCallId }),
        request: {
          options,
          subject: { itemId: item.id, type: "item" },
          title: nonEmpty(request.toolCall.title, `Allow ${item.name}?`),
        },
        runId,
        status: "open",
      });
      pending = {
        intent,
        interaction,
        opened: false,
        optionIds,
        toolCallId: request.toolCall.toolCallId,
      };
      this.#pendingPermissions.set(interaction.id, pending);
      await this.#projection.putInteraction(
        runId,
        "permission/requested",
        providerCause("permission/requested", request.toolCall.toolCallId),
        interaction,
      );
      pending.opened = true;
      return interaction.id;
    } catch (error) {
      if (pending !== undefined && !(error instanceof AuthorityOutcomeUnknownError)) {
        this.#dropPermission(pending.interaction.id);
      }
      throw error;
    }
  }

  async resolveInteraction(
    interactionId: string,
    resolution: InteractionResolution,
  ): Promise<RequestPermissionResponse | null> {
    this.#assertActive();
    return this.#inbox.enqueue(() => this.#resolveInteraction(interactionId, resolution));
  }

  async #resolveInteraction(
    interactionId: string,
    resolution: InteractionResolution,
  ): Promise<RequestPermissionResponse | null> {
    const pending = this.#pendingPermissions.get(interactionId);

    if (pending === undefined) {
      return null;
    }

    if (resolution.kind !== "permission") {
      throw new Error("ACP v1 permission interaction requires a permission resolution.");
    }

    if (pending.response !== undefined) {
      return pending.response;
    }

    const selected = resolution.value.type === "selected" ? resolution.value.optionId : null;
    const nativeOptionId = selected === null ? undefined : pending.optionIds.get(selected);

    if (selected !== null && nativeOptionId === undefined) {
      throw new Error("ACP v1 permission resolution selected an unavailable option.");
    }

    const response: RequestPermissionResponse =
      nativeOptionId === undefined
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { optionId: nativeOptionId, outcome: "selected" } };

    this.#projection.releaseInteraction(interactionId);
    if (this.#unknownPermission?.intent === pending.intent) {
      pending.response = response;
    } else {
      this.#dropPermission(interactionId);
    }

    return response;
  }

  #dropPermission(interactionId: string): void {
    const pending = this.#pendingPermissions.get(interactionId);

    if (pending !== undefined) {
      this.#pendingPermissions.delete(interactionId);
      this.#releasePermissionIntent(pending.intent);
    }
  }

  #permissionRetained(intent: PermissionIntent): boolean {
    return (
      this.#unknownPermission?.intent === intent ||
      [...this.#pendingPermissions.values()].some((pending) => pending.intent === intent)
    );
  }

  #releasePermissionIntent(intent: PermissionIntent): void {
    if (!intent.released) {
      intent.released = true;
      this.#pendingPermissionBytes -= intent.bytes;
    }
  }

  releaseRun(runId: string): void {
    for (const [id, pending] of this.#pendingPermissions) {
      if (pending.intent.runId === runId) {
        this.#dropPermission(id);
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#openingPermissions.clear();
    for (const id of this.#pendingPermissions.keys()) {
      this.#dropPermission(id);
    }
    if (this.#unknownPermission !== undefined) {
      this.#releasePermissionIntent(this.#unknownPermission.intent);
    }
    this.#unknownPermission = undefined;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("ACP v1 permission controller is disposed.");
    }
  }
}
