import { z } from "zod";

import {
  extensionNameSchema,
  jsonByteLength,
  leaseFenceSchema,
  opaqueIdSchema,
  protocolIdSchema,
  timestampSchema,
} from "./common";

export const CORE_PREVIEW_CHANNELS = [
  "message.text",
  "reasoning.text",
  "terminal.stdout",
  "terminal.stderr",
  "tool.progress",
] as const;

export const corePreviewChannelSchema = z.enum(CORE_PREVIEW_CHANNELS);
export const previewChannelSchema = z.union([corePreviewChannelSchema, extensionNameSchema]);

const previewKey = {
  itemId: opaqueIdSchema,
  streamId: opaqueIdSchema,
  channel: previewChannelSchema,
  segment: z.number().int().nonnegative().safe(),
} as const;

export const appendPreviewSchema = z
  .strictObject({
    ...previewKey,
    op: z.literal("append"),
    fromSequence: z.number().int().positive().safe(),
    throughSequence: z.number().int().positive().safe(),
    text: z.string().min(1),
  })
  .refine((preview) => preview.throughSequence >= preview.fromSequence, {
    message: "throughSequence must be greater than or equal to fromSequence.",
    path: ["throughSequence"],
  });

export const replacePreviewSchema = z.strictObject({
  ...previewKey,
  op: z.literal("replace"),
  throughSequence: z.number().int().positive().safe(),
  text: z.string(),
});

export const previewUpdateSchema = z.union([appendPreviewSchema, replacePreviewSchema]);
export type AppendPreview = z.infer<typeof appendPreviewSchema>;
export type ReplacePreview = z.infer<typeof replacePreviewSchema>;
export type PreviewUpdate = z.infer<typeof previewUpdateSchema>;

export const previewBatchSchema = z.strictObject({
  sessionId: protocolIdSchema,
  runId: protocolIdSchema,
  emittedAt: timestampSchema,
  updates: z.array(previewUpdateSchema).min(1),
});
export type PreviewBatch = z.infer<typeof previewBatchSchema>;

export const executorPreviewSubmissionSchema = z.strictObject({
  lease: leaseFenceSchema,
  batch: previewBatchSchema,
});
export type ExecutorPreviewSubmission = z.infer<typeof executorPreviewSubmissionSchema>;

export interface PreviewStreamState {
  readonly text: string | undefined;
  readonly throughSequence: number;
}

export type PreviewApplyResult =
  | { readonly status: "applied"; readonly state: PreviewStreamState }
  | { readonly status: "duplicate"; readonly state: PreviewStreamState }
  | { readonly status: "gap"; readonly state: PreviewStreamState };

export function applyPreviewUpdate(
  current: PreviewStreamState | undefined,
  update: PreviewUpdate,
): PreviewApplyResult {
  if (update.op === "replace") {
    if (current !== undefined && update.throughSequence < current.throughSequence) {
      return { status: "duplicate", state: current };
    }

    return {
      status: "applied",
      state: { text: update.text, throughSequence: update.throughSequence },
    };
  }

  if (current !== undefined && update.throughSequence <= current.throughSequence) {
    return { status: "duplicate", state: current };
  }

  const expectedSequence = (current?.throughSequence ?? 0) + 1;

  if (
    update.fromSequence !== expectedSequence ||
    (current !== undefined && current.text === undefined)
  ) {
    return {
      status: "gap",
      state: {
        text: undefined,
        throughSequence: Math.max(current?.throughSequence ?? 0, update.throughSequence),
      },
    };
  }

  return {
    status: "applied",
    state: {
      text: (current?.text ?? "") + update.text,
      throughSequence: update.throughSequence,
    },
  };
}

function previewKeyOf(update: PreviewUpdate): string {
  return JSON.stringify([update.itemId, update.streamId, update.channel, update.segment]);
}

function mergePreviewUpdates(
  previous: PreviewUpdate,
  next: PreviewUpdate,
): PreviewUpdate | undefined {
  if (previewKeyOf(previous) !== previewKeyOf(next)) {
    return undefined;
  }

  if (next.op === "replace") {
    return next.throughSequence < previous.throughSequence ? previous : next;
  }

  if (previous.op === "replace") {
    if (next.fromSequence !== previous.throughSequence + 1) {
      return undefined;
    }

    return {
      ...previous,
      text: previous.text + next.text,
      throughSequence: next.throughSequence,
    };
  }

  if (next.fromSequence !== previous.throughSequence + 1) {
    return undefined;
  }

  return {
    ...previous,
    text: previous.text + next.text,
    throughSequence: next.throughSequence,
  };
}

export function coalescePreviewUpdates(updates: readonly PreviewUpdate[]): PreviewUpdate[] {
  const output: PreviewUpdate[] = [];
  const lastIndexByKey = new Map<string, number>();

  for (const update of updates) {
    const key = previewKeyOf(update);
    const previousIndex = lastIndexByKey.get(key);
    const previous = previousIndex === undefined ? undefined : output[previousIndex];
    const merged = previous === undefined ? undefined : mergePreviewUpdates(previous, update);

    if (previousIndex === undefined || merged === undefined) {
      lastIndexByKey.set(key, output.length);
      output.push(update);
      continue;
    }

    output[previousIndex] = merged;
  }

  return output;
}

export interface PreviewBufferOptions {
  readonly flush: (updates: readonly PreviewUpdate[]) => void | Promise<void>;
  readonly maxBytes: number;
  readonly maxDelayMs: number;
  readonly maxUpdates: number;
  readonly onDrop?: ((updates: readonly PreviewUpdate[]) => void) | undefined;
  readonly onError?: ((error: unknown, updates: readonly PreviewUpdate[]) => void) | undefined;
}

export interface PreviewBuffer {
  push(update: PreviewUpdate): void;
  flush(): Promise<void>;
  dispose(): void;
  readonly bytes: number;
  readonly size: number;
}

export function createPreviewBuffer(options: PreviewBufferOptions): PreviewBuffer {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    !Number.isSafeInteger(options.maxDelayMs) ||
    !Number.isSafeInteger(options.maxUpdates) ||
    options.maxBytes < 1 ||
    options.maxDelayMs < 1 ||
    options.maxUpdates < 1
  ) {
    throw new RangeError("Preview buffer limits must be positive integers.");
  }

  let updates: PreviewUpdate[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;
  let flushRequested = false;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const drain = async (): Promise<void> => {
    while (!disposed && flushRequested) {
      flushRequested = false;

      if (updates.length === 0) {
        continue;
      }

      const batch = coalescePreviewUpdates(updates);
      updates = [];
      bytes = 0;

      try {
        await options.flush(batch);
      } catch (error) {
        options.onError?.(error, batch);
      }
    }
  };

  const flush = (): Promise<void> => {
    clearTimer();
    flushRequested = true;

    if (draining === undefined) {
      draining = drain().finally(() => {
        draining = undefined;

        if (!disposed && flushRequested) {
          void flush();
        }
      });
    }

    return draining;
  };

  return {
    push(update) {
      if (disposed) {
        throw new Error("Preview buffer is disposed.");
      }

      const admitted = previewUpdateSchema.parse(update);
      const updateBytes = jsonByteLength(admitted);

      if (updateBytes + 2 > options.maxBytes) {
        options.onDrop?.([admitted]);
        return;
      }

      if (updates.length > 0 && bytes + updateBytes + 1 > options.maxBytes) {
        if (draining !== undefined) {
          options.onDrop?.([admitted]);
          return;
        }

        void flush();
      }

      updates.push(admitted);
      bytes = updates.length === 1 ? updateBytes + 2 : bytes + updateBytes + 1;

      if (updates.length >= options.maxUpdates || bytes >= options.maxBytes) {
        if (draining === undefined) {
          void flush();
        } else {
          clearTimer();
          const dropped = updates;
          updates = [];
          bytes = 0;
          options.onDrop?.(dropped);
        }
        return;
      }

      timer ??= setTimeout(() => void flush(), Math.min(options.maxDelayMs, 2_147_483_647));
    },
    flush,
    dispose() {
      disposed = true;
      clearTimer();
      updates = [];
      bytes = 0;
    },
    get bytes() {
      return bytes;
    },
    get size() {
      return updates.length;
    },
  };
}
