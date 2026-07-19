import { assertProtocolAdmission, type ProtocolAdmissionLimits } from "./common";
import type { PreviewBatch } from "./preview";
import { previewBatchSchema } from "./preview";
import type { Item, SessionSnapshot } from "./state";
import { invariant, itemKey } from "./invariant";
import { validateSessionSnapshot } from "./state-validation";

function previewItemKind(
  channel: PreviewBatch["updates"][number]["channel"],
): Item["kind"] | undefined {
  switch (channel) {
    case "message.text":
      return "message";
    case "reasoning.text":
      return "reasoning";
    case "terminal.stderr":
    case "terminal.stdout":
      return "terminal";
    case "tool.progress":
      return "tool";
    default:
      return undefined;
  }
}

export function validatePreviewBatch(
  snapshotValue: SessionSnapshot,
  batchValue: PreviewBatch,
  admissionLimits?: ProtocolAdmissionLimits,
): PreviewBatch {
  const snapshot = validateSessionSnapshot(snapshotValue);
  const batch = previewBatchSchema.parse(batchValue);

  if (admissionLimits !== undefined) {
    assertProtocolAdmission(batch, admissionLimits, []);
  }

  invariant(
    "session_mismatch",
    batch.sessionId === snapshot.session.id,
    "Preview batch and Session identities do not match.",
  );
  const run = snapshot.runs.find((candidate) => candidate.id === batch.runId);
  invariant("invalid_reference", run !== undefined, `Preview Run ${batch.runId} does not exist.`);
  invariant("invalid_transition", run.status === "active", "Preview requires an active Run.");
  const items = new Map(snapshot.items.map((item) => [itemKey(item.runId, item.id), item]));

  for (const update of batch.updates) {
    const item = items.get(itemKey(batch.runId, update.itemId));
    invariant(
      "invalid_reference",
      item !== undefined,
      `Preview Item ${update.itemId} does not exist in Run ${batch.runId}.`,
    );
    invariant("invalid_transition", item.status === "active", "Preview requires an active Item.");
    const expectedKind = previewItemKind(update.channel);
    invariant(
      "unsupported",
      expectedKind !== undefined || snapshot.session.capabilities[update.channel] !== undefined,
      `Preview channel ${update.channel} was not negotiated.`,
    );
    invariant(
      "invalid_reference",
      expectedKind === undefined || item.kind === expectedKind,
      `Preview channel ${update.channel} cannot target an Item of kind ${item.kind}.`,
    );
  }

  return batch;
}
