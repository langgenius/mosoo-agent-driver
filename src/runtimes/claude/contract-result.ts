import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { itemSchema } from "../../contract";
import type { ProtocolError } from "../../contract";
import { asJsonValue, type ContractProjection } from "../contract-projection";
import { createProviderMeta } from "../contract-adapter-meta";
import { finishReason, isLimit, isRetryable, toUsage } from "./contract-items";

const { cause: providerCause, provenance } = createProviderMeta("anthropic");

export interface FinishClaudeResultOptions {
  readonly id: (runId: string, kind: string, nativeId: string) => string;
  readonly message: Extract<SDKMessage, { type: "result" }>;
  readonly onRunReleased: (runId: string) => void;
  readonly projection: ContractProjection;
  readonly runId: string;
}

export async function finishClaudeResult(options: FinishClaudeResultOptions): Promise<void> {
  const { id, message, onRunReleased, projection, runId } = options;
  const event = `result/${message.subtype}`;
  const cause = providerCause(event, message.uuid);
  const usage = toUsage(message);
  if (usage !== undefined) {
    await projection.updateUsage(runId, event, cause, usage);
  }

  if (message.subtype === "success") {
    const hasMessageText = projection
      .items(runId)
      .some(
        (item) =>
          item.kind === "message" &&
          item.status === "completed" &&
          item.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") ===
            message.result,
      );
    if (message.result.length > 0 && !hasMessageText) {
      const now = projection.now().toISOString();
      await projection.putItem(
        runId,
        `${event}/final`,
        cause,
        itemSchema.parse({
          audience: "participants",
          content: [{ text: message.result, type: "text" }],
          createdAt: now,
          endedAt: now,
          id: id(runId, "result", `${message.uuid}:final`),
          kind: "message",
          phase: "final",
          provenance: provenance(event, { messageId: message.uuid }),
          role: "agent",
          runId,
          status: "completed",
          updatedAt: now,
        }),
      );
    }

    if (message.structured_output !== undefined) {
      const now = projection.now().toISOString();
      const structured = asJsonValue(message.structured_output);
      if (structured !== undefined) {
        await projection.putItem(
          runId,
          `${event}/structured_output`,
          cause,
          itemSchema.parse({
            audience: "participants",
            content: [{ type: "json", value: structured }],
            createdAt: now,
            endedAt: now,
            id: id(runId, "structured", message.uuid),
            kind: "artifact",
            name: "structured-output.json",
            provenance: provenance(event, { messageId: message.uuid }),
            runId,
            status: "completed",
            updatedAt: now,
          }),
        );
      }
    }

    await projection.finishRun({
      activeItemStatus: "cancelled",
      cause,
      event,
      finishReason: finishReason(message),
      runId,
      status: "completed",
    });
    onRunReleased(runId);
    return;
  }

  const cancelled =
    message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools";

  if (isLimit(message)) {
    await projection.finishRun({
      activeItemStatus: "cancelled",
      cause,
      event,
      finishReason: "limit",
      runId,
      status: "completed",
    });
    onRunReleased(runId);
    return;
  }

  const error = {
    code: `anthropic.${message.subtype}`,
    ...(message.terminal_reason === undefined
      ? {}
      : { details: { terminalReason: message.terminal_reason } }),
    message: message.errors.join("\n") || "Agent SDK run failed.",
    retryable: isRetryable(message),
  } satisfies ProtocolError;
  await projection.finishRun({
    cause,
    ...(cancelled ? {} : { error }),
    event,
    runId,
    status: cancelled ? "cancelled" : "failed",
  });
  onRunReleased(runId);
}
