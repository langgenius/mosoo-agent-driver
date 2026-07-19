import { isDeepStrictEqual } from "node:util";

import type { SessionUpdate, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";

import { itemSchema, toolItemSchema } from "../../contract";
import type { FileChange, ItemStatus, ToolItem } from "../../contract";
import {
  asJsonValue,
  createProviderMeta,
  ContractProjection,
  nonEmpty,
} from "../contract-projection";
import type { AcpContractTerminalProjector } from "./contract-terminal-projector";
import {
  itemStatus,
  toChanges,
  toContentBlocks,
  toolCategory,
  toolError,
  toOutput,
} from "./contract-mapping";

const { cause: providerCause, provenance } = createProviderMeta("agent-client-protocol");

export interface AcpContractItemProjectorOptions {
  readonly now: () => string;
  readonly projection: ContractProjection;
  readonly resolveId: (runId: string, kind: string, nativeId: string) => string;
  readonly terminals: AcpContractTerminalProjector;
}

export class AcpContractItemProjector {
  readonly #now: () => string;
  readonly #projection: ContractProjection;
  readonly #resolveId: AcpContractItemProjectorOptions["resolveId"];
  readonly #terminals: AcpContractTerminalProjector;

  constructor(options: AcpContractItemProjectorOptions) {
    this.#now = options.now;
    this.#projection = options.projection;
    this.#resolveId = options.resolveId;
    this.#terminals = options.terminals;
  }

  async putMessageChunk(
    runId: string,
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }
    >,
    kind: "message" | "reasoning",
  ): Promise<void> {
    const nativeId = update.messageId ?? `${runId}:anonymous:${kind}`;
    const id = this.#resolveId(runId, kind, nativeId);
    const event = `session/${update.sessionUpdate}`;
    let item = this.#projection.item(runId, id);

    if (item === undefined) {
      const now = this.#now();
      item = await this.#projection.putItem(
        runId,
        event,
        providerCause(event, nativeId),
        itemSchema.parse({
          audience: "participants",
          content: [],
          createdAt: now,
          id,
          kind,
          ...(kind === "message" ? { phase: "final", role: "agent" } : {}),
          provenance: provenance(
            event,
            update.messageId === null || update.messageId === undefined
              ? undefined
              : { messageId: update.messageId },
          ),
          runId,
          status: "active",
          updatedAt: now,
        }),
      );
    }

    if (item.status !== "active" || item.kind !== kind) {
      return;
    }

    const channel = kind === "message" ? "message.text" : "reasoning.text";

    if (update.content.type === "text") {
      await this.#projection.appendText({
        cause: providerCause(event, nativeId),
        channel,
        delta: update.content.text,
        event,
        itemId: id,
        runId,
      });
      return;
    }

    const checkpoint = await this.#projection.checkpointText({
      cause: providerCause(`${event}.checkpoint`, nativeId),
      channel,
      event: `${event}.checkpoint`,
      itemId: id,
      runId,
    });
    const current = checkpoint ?? item;

    if (current.kind !== "message" && current.kind !== "reasoning") {
      throw new Error("ACP v1 message chunk changed item kind while being projected.");
    }

    await this.#projection.putItem(
      runId,
      event,
      providerCause(event, nativeId),
      itemSchema.parse({
        ...current,
        content: [...current.content, ...toContentBlocks(update.content)],
        updatedAt: this.#now(),
      }),
    );
  }

  async putTool(
    runId: string,
    update: ToolCall | ToolCallUpdate,
    event: string,
  ): Promise<ToolItem> {
    const id = this.#resolveId(runId, "tool", update.toolCallId);
    const existing = this.#projection.item(runId, id);

    if (existing !== undefined && existing.kind !== "tool") {
      throw new Error("ACP v1 tool update collided with a non-tool item.");
    }

    const existingTool = existing?.kind === "tool" ? existing : undefined;
    const now = this.#now();
    const title = nonEmpty(update.title, existingTool?.title ?? existingTool?.name ?? "Tool");
    const nextStatus =
      update.status === undefined || update.status === null
        ? (existingTool?.status ?? "active")
        : itemStatus(update.status);
    const status =
      existingTool === undefined || existingTool.status === "active"
        ? nextStatus
        : existingTool.status;
    const content = update.content ?? undefined;
    const terminalIds =
      content?.flatMap((entry) => (entry.type === "terminal" ? [entry.terminalId] : [])) ?? [];
    const projectedTerminalIds: string[] = [];

    for (const terminalId of terminalIds) {
      projectedTerminalIds.push(await this.#terminals.ensureTerminal(runId, terminalId));
    }

    const terminalItemId =
      content === undefined ? existingTool?.terminalItemId : projectedTerminalIds[0];

    const input =
      update.rawInput === undefined || update.rawInput === null
        ? existingTool?.input
        : asJsonValue(update.rawInput);
    const structuredOutput =
      update.rawOutput === undefined || update.rawOutput === null
        ? existingTool?.structuredOutput
        : asJsonValue(update.rawOutput);
    const output = content === undefined ? existingTool?.output : toOutput(content);
    const locations =
      update.locations === undefined || update.locations === null
        ? existingTool?.locations
        : update.locations.flatMap((location) =>
            location.path.trim().length === 0
              ? []
              : [
                  {
                    ...(location.line === undefined ||
                    location.line === null ||
                    !Number.isSafeInteger(location.line) ||
                    location.line < 1
                      ? {}
                      : { line: location.line }),
                    path: location.path,
                  },
                ],
          );
    const item = toolItemSchema.parse({
      audience: "participants",
      category:
        update.kind === undefined || update.kind === null
          ? (existingTool?.category ?? "other")
          : toolCategory(update.kind),
      createdAt: existingTool?.createdAt ?? now,
      ...(status === "active" ? {} : { endedAt: existingTool?.endedAt ?? now }),
      ...(status === "failed" ? { error: existingTool?.error ?? toolError(title) } : {}),
      id,
      ...(input === undefined ? {} : { input }),
      kind: "tool",
      ...(locations === undefined ? {} : { locations }),
      name: existingTool?.name ?? title,
      origin: "provider",
      ...(output === undefined ? {} : { output }),
      provenance: provenance(event, { toolCallId: update.toolCallId }),
      runId,
      status,
      ...(structuredOutput === undefined ? {} : { structuredOutput }),
      ...(terminalItemId === undefined ? {} : { terminalItemId }),
      title,
      updatedAt: now,
    });
    const changed =
      existingTool === undefined ||
      !isDeepStrictEqual(
        { ...existingTool, provenance: item.provenance, updatedAt: item.updatedAt },
        item,
      );

    if (changed) {
      await this.#projection.putItem(runId, event, providerCause(event, update.toolCallId), item);
    }

    await this.#putChanges(
      runId,
      update.toolCallId,
      content === undefined ? undefined : toChanges(content),
      status,
      event,
      now,
    );

    if (changed && item.status === "active") {
      await this.#projection.replacePreview({
        channel: "tool.progress",
        itemId: item.id,
        runId,
        text: item.title ?? item.name,
      });
    }

    return changed ? item : existingTool;
  }

  async #putChanges(
    runId: string,
    toolCallId: string,
    changes: FileChange[] | undefined,
    status: ItemStatus,
    event: string,
    now: string,
  ): Promise<void> {
    const id = this.#resolveId(runId, "change", toolCallId);
    const existing = this.#projection.item(runId, id);

    if (existing !== undefined && existing.kind !== "change") {
      return;
    }

    const nextStatus =
      existing === undefined || existing.status === "active" ? status : existing.status;

    if (
      (changes === undefined && (existing === undefined || existing.status === nextStatus)) ||
      (changes?.length === 0 && existing === undefined)
    ) {
      return;
    }

    const item = itemSchema.parse({
      audience: "participants",
      changes: changes ?? existing?.changes,
      createdAt: existing?.createdAt ?? now,
      ...(nextStatus === "active" ? {} : { endedAt: existing?.endedAt ?? now }),
      ...(nextStatus === "failed" ? { error: existing?.error ?? toolError("File change") } : {}),
      id,
      kind: "change",
      provenance: provenance(event, { toolCallId }),
      runId,
      status: nextStatus,
      updatedAt: now,
    });

    if (
      existing !== undefined &&
      isDeepStrictEqual(
        { ...existing, provenance: item.provenance, updatedAt: item.updatedAt },
        item,
      )
    ) {
      return;
    }

    await this.#projection.putItem(
      runId,
      `${event}.changes`,
      providerCause(`${event}.changes`, toolCallId),
      item,
    );
  }

  async putPlan(
    runId: string,
    nativeId: string,
    entries: Extract<SessionUpdate, { sessionUpdate: "plan" }>["entries"],
    event: string,
  ): Promise<void> {
    const id = this.#resolveId(runId, "plan", nativeId);
    const existing = this.#projection.item(runId, id);

    if (existing !== undefined && (existing.kind !== "plan" || existing.status !== "active")) {
      return;
    }

    const now = this.#now();
    await this.#projection.putItem(
      runId,
      event,
      providerCause(event, nativeId),
      itemSchema.parse({
        audience: "participants",
        createdAt: existing?.createdAt ?? now,
        entries: entries.map((entry) => ({
          priority: entry.priority,
          status: entry.status,
          text: entry.content,
        })),
        id,
        kind: "plan",
        provenance: provenance(event, nativeId === "current" ? undefined : { planId: nativeId }),
        runId,
        status: "active",
        updatedAt: now,
      }),
    );
  }
}
