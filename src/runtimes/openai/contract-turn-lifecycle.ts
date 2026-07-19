import { itemSchema } from "../../contract";
import type { Item, ProtocolError } from "../../contract";
import type { ContractProjection } from "../contract-projection";
import { isRecord, readArray, readNonEmptyString, readRecord, readString } from "./app-server-json";
import type { JsonObject } from "./app-server-json";
import {
  latestTimestamp,
  type NativeItemLifecycle,
  provenance,
  providerEventId,
} from "./contract-items";

export interface OpenAiTurnLifecycleState {
  readonly runId: string;
  readonly threadId: string;
  readonly turnId: string;
}

export function projectOpenAiPlan(
  turn: OpenAiTurnLifecycleState,
  params: JsonObject,
  occurredAt: string,
  event: string,
  previous: Item | undefined,
): Item {
  const explanation = readString(params, "explanation");

  return itemSchema.parse({
    audience: "participants",
    createdAt: previous?.createdAt ?? occurredAt,
    entries: readArray(params, "plan").flatMap((entry, index) => {
      if (!isRecord(entry)) {
        return [];
      }

      const text = readNonEmptyString(entry, "step");
      const status = readString(entry, "status");
      return text === null
        ? []
        : [
            {
              id: String(index),
              status:
                status === "completed"
                  ? "completed"
                  : status === "inProgress"
                    ? "in_progress"
                    : "pending",
              text,
            },
          ];
    }),
    ...(explanation === null ? {} : { explanation }),
    id: "turn-plan",
    kind: "plan",
    provenance: provenance(event, {
      itemId: "turn-plan",
      threadId: turn.threadId,
      turnId: turn.turnId,
    }),
    runId: turn.runId,
    status: "active",
    updatedAt: latestTimestamp(previous?.updatedAt, occurredAt),
  });
}

export interface FinishOpenAiTurnOptions<TTurn extends OpenAiTurnLifecycleState> {
  readonly method: string;
  readonly params: JsonObject;
  readonly projectItem: (
    turn: TTurn,
    item: JsonObject,
    lifecycle: NativeItemLifecycle,
    occurredAt: string,
    method: string,
  ) => Item | null;
  readonly projection: ContractProjection;
  readonly release: (turnId: string) => void;
  readonly rememberEnded: (turn: TTurn) => void;
  readonly turn: TTurn;
  readonly withReceiptTime: <T>(
    eventId: string,
    operation: (occurredAt: string) => Promise<T>,
  ) => Promise<T>;
}

export async function finishOpenAiTurn<TTurn extends OpenAiTurnLifecycleState>(
  options: FinishOpenAiTurnOptions<TTurn>,
): Promise<void> {
  const { method, params, projection, turn } = options;
  const nativeTurn = readRecord(params, "turn");
  const status = readString(nativeTurn, "status");

  if (status === "inProgress") {
    return;
  }

  if (status !== "completed" && status !== "failed" && status !== "interrupted") {
    throw new Error(`${method} params.turn.status is unsupported.`);
  }

  await options.withReceiptTime(providerEventId(method, params), async (endedAt) => {
    const terminalItems: Item[] = [];
    const completedItemIds = new Set<string>();

    for (const nativeItem of readArray(nativeTurn, "items")) {
      if (!isRecord(nativeItem)) {
        continue;
      }

      const itemId = readNonEmptyString(nativeItem, "id");

      if (itemId === null) {
        continue;
      }

      const existing = projection.item(turn.runId, itemId);

      if (existing !== undefined && existing.status !== "active") {
        continue;
      }

      const projected = options.projectItem(turn, nativeItem, "completed", endedAt, method);

      if (projected !== null) {
        completedItemIds.add(itemId);
        terminalItems.push(projected);
      }
    }

    const activeItems = projection.items(turn.runId).filter((item) => item.status === "active");
    const incompleteSnapshot =
      status === "completed" &&
      activeItems.some(
        (item) =>
          !completedItemIds.has(item.id) && !(item.kind === "plan" && item.id === "turn-plan"),
      );
    const runStatus =
      status === "failed" || incompleteSnapshot
        ? "failed"
        : status === "interrupted"
          ? "cancelled"
          : "completed";
    const runError: ProtocolError = {
      code: incompleteSnapshot ? "openai.turn.incomplete" : "openai.turn.failed",
      message: incompleteSnapshot
        ? "OpenAI turn completed without authoritative snapshots for active items."
        : (readString(readRecord(nativeTurn, "error"), "message") ?? "OpenAI turn failed."),
      retryable: false,
    };

    if (status === "completed") {
      const plan = activeItems.find(
        (item) => item.kind === "plan" && item.id === "turn-plan" && !completedItemIds.has(item.id),
      );

      if (plan !== undefined) {
        terminalItems.push(
          itemSchema.parse({
            ...plan,
            endedAt,
            status: "completed",
            updatedAt: latestTimestamp(plan.updatedAt, endedAt),
          }),
        );
      }
    }

    await projection.finishRun({
      cause: { providerEventId: providerEventId(method, params), type: "provider" },
      event: method,
      ...(runStatus === "failed" ? { error: runError } : {}),
      ...(runStatus === "completed" ? { finishReason: "success" } : {}),
      runId: turn.runId,
      status: runStatus,
      terminalItems,
    });
    options.rememberEnded(turn);
    options.release(turn.turnId);
  });
}
