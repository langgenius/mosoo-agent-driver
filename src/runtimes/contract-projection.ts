import { isDeepStrictEqual } from "node:util";

import { interactionSchema, itemSchema, jsonByteLength, runSchema } from "../contract";
import type {
  AuthorityOperation,
  Interaction,
  Item,
  MutationCause,
  PreviewUpdate,
  ProtocolError,
  Run,
  TokenUsage,
} from "../contract";
import {
  authorityKey,
  ContractProjectionAuthority,
  MAX_PENDING_MUTATION_BYTES,
  MAX_PENDING_MUTATIONS,
  type QueuedMutation,
} from "./contract-projection-authority";
import {
  advancePreviews,
  appendItemText,
  type AppendTextInput,
  type CheckpointTextInput,
  DEFAULT_PREVIEW_CHECKPOINT_BYTES,
  DEFAULT_PREVIEW_REPLACE_INTERVAL_MS,
  emitContractPreview,
  flushItemText,
  itemKey,
  itemText,
  latestTimestamp,
  matchesPreviewChannel,
  type ContractProjectionOptions,
  type PreviewStreamState,
  replaceCheckpointCause,
  type ReplacePreviewInput,
  replaceItemText,
  streamKey,
  type TextPreviewChannel,
  truncateUtf8,
} from "./contract-projection-preview";
import { ContractProjectionState } from "./contract-projection-state";

export { AuthorityOutcomeUnknownError } from "../contract";
export { asJsonValue, createProviderMeta, nonEmpty } from "./contract-adapter-meta";
export type { ContractAuthorityUpdate } from "./contract-projection-authority";
export type {
  ContractPreviewUpdate,
  ContractProjectionOptions,
} from "./contract-projection-preview";

export class ContractProjection {
  readonly #authority: ContractProjectionAuthority;
  #disposed = false;
  readonly #now: () => Date;
  readonly #preview: ContractProjectionOptions["preview"];
  readonly #previewCheckpointBytes: number;
  readonly #previewReplaceIntervalMs: number;
  readonly #previewStreams = new Map<string, PreviewStreamState>();
  readonly #state = new ContractProjectionState();
  readonly #sessionId: string;
  readonly #textEncoder = new TextEncoder();
  #mutationActive = false;
  #mutationBytes = 0;
  readonly #mutationQueue: QueuedMutation[] = [];

  constructor(options: ContractProjectionOptions) {
    const admissionLimits =
      options.admissionLimits === undefined ? undefined : { ...options.admissionLimits };
    this.#now = options.now ?? (() => new Date());
    this.#preview = options.preview;
    this.#previewCheckpointBytes =
      options.previewCheckpointBytes ?? DEFAULT_PREVIEW_CHECKPOINT_BYTES;
    this.#previewReplaceIntervalMs =
      options.previewReplaceIntervalMs ?? DEFAULT_PREVIEW_REPLACE_INTERVAL_MS;
    this.#sessionId = options.sessionId;

    if (
      [
        this.#previewCheckpointBytes,
        this.#previewReplaceIntervalMs,
        ...(admissionLimits === undefined
          ? []
          : [admissionLimits.maxBytes, admissionLimits.maxInlineBytes]),
      ].some((value) => !Number.isSafeInteger(value) || value < 1)
    ) {
      throw new RangeError("Contract projection limits must be finite and positive.");
    }

    this.#authority = new ContractProjectionAuthority({
      active: () => !this.#disposed,
      admissionLimits,
      apply: (operations) => this.#applyAuthorityOperations(operations),
      authority: options.authority,
      sessionId: options.sessionId,
    });
  }

  now(): Date {
    this.#assertActive();
    return this.#now();
  }

  run(runId: string): Run | undefined {
    this.#assertActive();
    return this.#state.run(runId);
  }

  item(runId: string, id: string): Item | undefined {
    this.#assertActive();
    return this.#state.item(runId, id);
  }

  interaction(id: string): Interaction | undefined {
    this.#assertActive();
    return this.#state.interaction(id);
  }

  releaseInteraction(id: string): void {
    this.#assertActive();
    this.#state.releaseInteraction(id);
  }

  items(runId: string): Item[] {
    this.#assertActive();
    return this.#state.items(runId);
  }

  interactions(runId: string): Interaction[] {
    this.#assertActive();
    return this.#state.interactions(runId);
  }

  attachRun(value: Run): void {
    this.#assertActive();
    this.#state.attachRun(value);
  }

  async putItem(runId: string, event: string, cause: MutationCause, value: Item): Promise<Item> {
    const intent = { cause, event, runId, value };
    return this.#mutate(authorityKey(runId, event, cause), intent, (stable) =>
      this.#putItem(stable.runId, stable.event, stable.cause, stable.value, stable, false),
    );
  }

  async #putItem(
    runId: string,
    event: string,
    cause: MutationCause,
    value: Item,
    intent: unknown,
    reuseDerived: boolean,
  ): Promise<Item> {
    this.#requireRun(runId);
    const item = itemSchema.parse(value);

    if (item.runId !== runId) {
      throw new Error(`Contract projection item ${item.id} belongs to a different run.`);
    }

    const existing = this.#state.item(runId, item.id);

    if (existing !== undefined && isDeepStrictEqual(existing, item)) {
      return existing;
    }

    const operations = await this.#commit(
      runId,
      event,
      cause,
      [{ entity: "item", op: "put", value: item }],
      intent,
      reuseDerived,
    );
    const operation = operations[0];

    if (operation?.op !== "put" || operation.entity !== "item") {
      throw new Error(`Authority write ${event} did not retain its Item intent.`);
    }

    return this.#state.item(runId, operation.value.id) ?? operation.value;
  }

  async putInteraction(
    runId: string,
    event: string,
    cause: MutationCause,
    value: Interaction,
  ): Promise<Interaction> {
    const intent = { cause, event, runId, value };
    return this.#mutate(authorityKey(runId, event, cause), intent, async (stable) => {
      this.#requireRun(stable.runId);
      const interaction = interactionSchema.parse(stable.value);

      if (interaction.runId !== stable.runId) {
        throw new Error(
          `Contract projection interaction ${interaction.id} belongs to a different run.`,
        );
      }

      const existing = this.#state.interaction(interaction.id);

      if (existing !== undefined && isDeepStrictEqual(existing, interaction)) {
        return existing;
      }

      const operations = await this.#commit(
        stable.runId,
        stable.event,
        stable.cause,
        [{ entity: "interaction", op: "put", value: interaction }],
        stable,
      );
      const operation = operations[0];

      if (operation?.op !== "put" || operation.entity !== "interaction") {
        throw new Error(`Authority write ${stable.event} did not retain its Interaction intent.`);
      }

      return this.#state.interaction(operation.value.id) ?? operation.value;
    });
  }

  async updateUsage(
    runId: string,
    event: string,
    cause: MutationCause,
    usage: TokenUsage,
  ): Promise<void> {
    const intent = { cause, event, runId, usage };
    return this.#mutate(authorityKey(runId, event, cause), intent, async (stable) => {
      const current = this.#requireRun(stable.runId);

      if (current.status !== "active") {
        return;
      }

      const run = runSchema.parse({ ...current, usage: stable.usage });

      if (isDeepStrictEqual(current, run)) {
        return;
      }

      const operations = await this.#commit(
        stable.runId,
        stable.event,
        stable.cause,
        [{ entity: "run", op: "put", value: run }],
        stable,
      );
      const operation = operations[0];

      if (operation?.op !== "put" || operation.entity !== "run") {
        throw new Error(`Authority write ${stable.event} did not retain its Run intent.`);
      }
    });
  }

  async appendText(input: AppendTextInput): Promise<void> {
    return this.#mutate(
      authorityKey(input.runId, `${input.event}.checkpoint`, input.cause),
      input,
      async (input) => {
        this.#assertActive();

        if (input.delta.length === 0) {
          return;
        }

        const item = this.#state.item(input.runId, input.itemId);

        if (
          item === undefined ||
          item.status !== "active" ||
          !matchesPreviewChannel(item, input.channel)
        ) {
          return;
        }

        const key = streamKey(input.runId, input.itemId, input.channel);
        const now = this.#now();
        const current: PreviewStreamState = this.#previewStreams.get(key) ?? {
          bytes: 0,
          lastReplaceAtMs: now.getTime(),
          mode: "append",
          segment: 0,
          sequence: 0,
          text: "",
        };

        if (current.mode !== "append") {
          throw new Error(`Preview stream ${input.channel} changed update mode.`);
        }
        const text = current.text + input.delta;
        const bytes = current.bytes + this.#textEncoder.encode(input.delta).byteLength;

        if (bytes >= this.#previewCheckpointBytes) {
          const checkpoint = appendItemText(
            flushItemText(this.#previewStreams, item, now.toISOString()),
            input.channel,
            input.delta,
            now.toISOString(),
          );
          await this.#putItem(
            input.runId,
            `${input.event}.checkpoint`,
            input.cause,
            checkpoint,
            input,
            true,
          );
          if (this.#disposed) {
            return;
          }
          this.#previewStreams.set(key, {
            bytes: 0,
            lastReplaceAtMs: now.getTime(),
            mode: "append",
            segment: current.segment + 1,
            sequence: 0,
            text: "",
          });
          return;
        }

        const sequence = current.sequence + 1;
        const replace = now.getTime() - current.lastReplaceAtMs >= this.#previewReplaceIntervalMs;
        const update: PreviewUpdate = replace
          ? {
              channel: input.channel,
              itemId: input.itemId,
              op: "replace",
              segment: current.segment,
              streamId: input.channel,
              text,
              throughSequence: sequence,
            }
          : {
              channel: input.channel,
              fromSequence: sequence,
              itemId: input.itemId,
              op: "append",
              segment: current.segment,
              streamId: input.channel,
              text: input.delta,
              throughSequence: sequence,
            };
        this.#previewStreams.set(key, {
          bytes,
          lastReplaceAtMs: replace ? now.getTime() : current.lastReplaceAtMs,
          mode: "append",
          segment: current.segment,
          sequence,
          text,
        });
        this.#emitPreview(input.runId, update);
      },
    );
  }

  async checkpointText(input: CheckpointTextInput): Promise<Item | undefined> {
    return this.#mutate(
      authorityKey(input.runId, input.event, input.cause),
      input,
      async (input) => {
        this.#assertActive();
        const item = this.#state.item(input.runId, input.itemId);

        if (
          item === undefined ||
          item.status !== "active" ||
          !matchesPreviewChannel(item, input.channel)
        ) {
          return item;
        }

        const key = streamKey(input.runId, input.itemId, input.channel);
        const current = this.#previewStreams.get(key);

        if (current === undefined || current.text.length === 0) {
          return item;
        }

        if (current.mode !== "append") {
          throw new Error(`Preview stream ${input.channel} changed update mode.`);
        }

        const now = this.#now();
        const checkpoint = flushItemText(this.#previewStreams, item, now.toISOString());
        return this.#putItem(input.runId, input.event, input.cause, checkpoint, input, true);
      },
    );
  }

  async replacePreview(input: ReplacePreviewInput): Promise<void> {
    return this.#mutate(
      (stable) => {
        const key = streamKey(stable.runId, stable.itemId, stable.channel);
        const segment = (this.#previewStreams.get(key)?.segment ?? 0) + 1;
        return authorityKey(
          stable.runId,
          "preview/replace.checkpoint",
          replaceCheckpointCause(stable.runId, stable.itemId, segment),
        );
      },
      input,
      async (input) => {
        this.#assertActive();
        const item = this.#state.item(input.runId, input.itemId);

        if (
          item === undefined ||
          item.status !== "active" ||
          !matchesPreviewChannel(item, input.channel)
        ) {
          return;
        }

        const key = streamKey(input.runId, input.itemId, input.channel);
        const current = this.#previewStreams.get(key);
        if (current !== undefined && current.mode !== "replace") {
          throw new Error(`Preview stream ${input.channel} changed update mode.`);
        }

        const bytes = this.#textEncoder.encode(input.text).byteLength;
        const canCheckpoint =
          item.kind === "terminal" &&
          (input.channel === "terminal.stdout" || input.channel === "terminal.stderr");

        if (bytes >= this.#previewCheckpointBytes && canCheckpoint) {
          const now = this.#now();
          const nextSegment = (current?.segment ?? 0) + 1;

          if (itemText(item, input.channel) === input.text) {
            this.#previewStreams.set(key, {
              bytes: 0,
              lastReplaceAtMs: now.getTime(),
              mode: "replace",
              segment: nextSegment,
              sequence: 0,
              text: "",
            });
            return;
          }

          const checkpoint = replaceItemText(
            flushItemText(this.#previewStreams, item, now.toISOString()),
            input.channel,
            input.text,
            now.toISOString(),
          );
          await this.#putItem(
            input.runId,
            "preview/replace.checkpoint",
            replaceCheckpointCause(input.runId, input.itemId, nextSegment),
            checkpoint,
            input,
            true,
          );
          if (this.#disposed) {
            return;
          }
          this.#previewStreams.set(key, {
            bytes: 0,
            lastReplaceAtMs: now.getTime(),
            mode: "replace",
            segment: nextSegment,
            sequence: 0,
            text: "",
          });
          return;
        }

        const text =
          bytes < this.#previewCheckpointBytes
            ? input.text
            : truncateUtf8(input.text, this.#previewCheckpointBytes - 1);
        const sequence = (current?.sequence ?? 0) + 1;
        const update = {
          channel: input.channel,
          itemId: input.itemId,
          op: "replace",
          segment: current?.segment ?? 0,
          streamId: input.channel,
          text,
          throughSequence: sequence,
        } satisfies PreviewUpdate;
        this.#previewStreams.set(key, {
          bytes: this.#textEncoder.encode(text).byteLength,
          lastReplaceAtMs: this.#now().getTime(),
          mode: "replace",
          segment: current?.segment ?? 0,
          sequence,
          text,
        });
        this.#emitPreview(input.runId, update);
      },
    );
  }

  #emitPreview(runId: string, update: PreviewUpdate): void {
    emitContractPreview(this.#preview, runId, this.#sessionId, update);
  }

  materializedText(runId: string, itemId: string, channel: TextPreviewChannel): string {
    this.#assertActive();
    const item = this.#state.item(runId, itemId);
    const committed = item === undefined ? "" : itemText(item, channel);
    const preview = this.#previewStreams.get(streamKey(runId, itemId, channel));

    if (preview?.mode === "replace") {
      return preview.sequence === 0 ? committed : preview.text;
    }

    return committed + (preview?.text ?? "");
  }

  clearPreviews(runId: string, itemId: string): void {
    this.#assertActive();
    const prefix = `${itemKey(runId, itemId)}\u0000`;

    for (const key of this.#previewStreams.keys()) {
      if (key.startsWith(prefix)) {
        this.#previewStreams.delete(key);
      }
    }
  }

  async finishRun(input: {
    readonly activeItemStatus?: "cancelled" | "completed" | undefined;
    readonly cause: MutationCause;
    readonly endedAt?: string | undefined;
    readonly error?: ProtocolError | undefined;
    readonly event: string;
    readonly finishReason?: "success" | "limit" | "refusal" | "other" | undefined;
    readonly terminalItems?: readonly Item[] | undefined;
    readonly reason?: string | undefined;
    readonly runId: string;
    readonly status: "cancelled" | "completed" | "failed";
  }): Promise<void> {
    return this.#mutate(
      authorityKey(input.runId, input.event, input.cause),
      input,
      async (input) => {
        const current = this.#requireRun(input.runId);

        if (current.status !== "active") {
          return;
        }

        const terminalItems = (input.terminalItems ?? []).map((value) => itemSchema.parse(value));
        const terminalItemIds = new Set<string>();

        for (const item of terminalItems) {
          if (
            item.runId !== input.runId ||
            item.status === "active" ||
            terminalItemIds.has(item.id)
          ) {
            throw new Error(`Contract projection received an invalid terminal Item ${item.id}.`);
          }

          terminalItemIds.add(item.id);
        }

        const currentItems = this.items(input.runId);
        const requestedEnd = input.endedAt ?? this.#now().toISOString();
        const endedAt = this.interactions(input.runId).reduce(
          (latest, interaction) =>
            latestTimestamp(latest, interaction.endedAt ?? interaction.createdAt),
          [
            ...currentItems.filter((item) => !terminalItemIds.has(item.id)),
            ...terminalItems,
          ].reduce(
            (latest, item) =>
              latestTimestamp(
                latest,
                latestTimestamp(item.updatedAt, item.endedAt ?? item.updatedAt),
              ),
            latestTimestamp(
              latestTimestamp(current.startedAt, requestedEnd),
              this.#state.latestChildEnd(input.runId) ?? current.startedAt,
            ),
          ),
        );
        const error = input.error ?? {
          code: "provider.run_failed",
          message: "Provider run failed.",
          retryable: false,
        };
        const items = currentItems.flatMap((item): Item[] => {
          if (item.status !== "active" || terminalItemIds.has(item.id)) {
            return [];
          }

          const withText = flushItemText(this.#previewStreams, item, endedAt);
          return [
            itemSchema.parse(
              input.status === "completed"
                ? {
                    ...withText,
                    endedAt,
                    status: input.activeItemStatus ?? "completed",
                    updatedAt: endedAt,
                  }
                : input.status === "cancelled"
                  ? { ...withText, endedAt, status: "cancelled", updatedAt: endedAt }
                  : { ...withText, endedAt, error, status: "failed", updatedAt: endedAt },
            ),
          ];
        });
        const interactions = this.interactions(input.runId).flatMap(
          (interaction): Interaction[] => {
            if (interaction.status !== "open") {
              return [];
            }

            return [
              interactionSchema.parse({
                ...interaction,
                endedAt,
                status: "expired",
              }),
            ];
          },
        );
        const run = runSchema.parse(
          input.status === "completed"
            ? {
                ...current,
                endedAt,
                finishReason: input.finishReason ?? "success",
                status: "completed",
              }
            : input.status === "cancelled"
              ? {
                  ...current,
                  endedAt,
                  ...(input.reason === undefined ? {} : { reason: input.reason }),
                  status: "cancelled",
                }
              : { ...current, endedAt, error, status: "failed" },
        );
        const operations: AuthorityOperation[] = [
          ...terminalItems.map<AuthorityOperation>((value) => ({
            entity: "item",
            op: "put",
            value,
          })),
          ...items.map<AuthorityOperation>((value) => ({ entity: "item", op: "put", value })),
          ...interactions.map<AuthorityOperation>((value) => ({
            entity: "interaction",
            op: "put",
            value,
          })),
          { entity: "run", op: "put", value: run },
        ];
        await this.#commit(input.runId, input.event, input.cause, operations, input, true);
      },
    );
  }

  dispose(): void {
    this.#disposed = true;
    const error = new Error("Contract projection is disposed.");

    for (const mutation of this.#mutationQueue.splice(0)) {
      this.#mutationBytes -= mutation.bytes;
      mutation.reject(error);
    }

    this.#state.clear();
    this.#previewStreams.clear();
    this.#authority.clear();
  }

  #mutate<I, T>(
    key: string | ((intent: I) => string),
    intent: I,
    operation: (intent: I) => Promise<T> | T,
  ): Promise<T> {
    this.#assertActive();
    const bytes = jsonByteLength(intent);
    const pending = this.#mutationQueue.length + (this.#mutationActive ? 1 : 0);

    if (pending >= MAX_PENDING_MUTATIONS) {
      return Promise.reject(
        new RangeError(
          `Contract projection mutation queue exceeds ${MAX_PENDING_MUTATIONS} entries.`,
        ),
      );
    }

    if (bytes > MAX_PENDING_MUTATION_BYTES - this.#mutationBytes) {
      return Promise.reject(
        new RangeError(
          `Contract projection mutation queue exceeds ${MAX_PENDING_MUTATION_BYTES} UTF-8 bytes.`,
        ),
      );
    }

    const stableIntent = structuredClone(intent);
    const unknownAtEnqueue = this.#authority.unknown;
    const task = Promise.withResolvers<T>();
    this.#mutationQueue.push({
      bytes,
      reject: task.reject,
      run: async () => {
        try {
          this.#assertActive();
          const resolvedKey = typeof key === "function" ? key(stableIntent) : key;
          this.#authority.assertRetry(resolvedKey, stableIntent, unknownAtEnqueue);

          task.resolve(await operation(stableIntent));
        } catch (error) {
          task.reject(error);
        }
      },
    });
    this.#mutationBytes += bytes;
    this.#drainMutations();
    return task.promise;
  }

  #drainMutations(): void {
    if (this.#mutationActive) {
      return;
    }

    // ponytail: the 1,024-entry hard cap keeps a native Array FIFO sufficient.
    const mutation = this.#mutationQueue.shift();
    if (mutation === undefined) {
      return;
    }

    this.#mutationActive = true;
    void mutation.run().finally(() => {
      this.#mutationBytes -= mutation.bytes;
      this.#mutationActive = false;
      this.#drainMutations();
    });
  }

  async #commit(
    runId: string,
    event: string,
    cause: MutationCause,
    operations: readonly AuthorityOperation[],
    intent: unknown,
    reuseDerived = false,
  ): Promise<readonly AuthorityOperation[]> {
    this.#assertActive();
    return this.#authority.commit(runId, event, cause, operations, intent, reuseDerived);
  }

  #applyAuthorityOperations(operations: readonly AuthorityOperation[]): void {
    this.#state.apply(operations, {
      activeItem: (item) =>
        advancePreviews(this.#previewStreams, item.runId, item.id, Date.parse(item.updatedAt)),
      clearItem: (runId, itemId) => this.clearPreviews(runId, itemId),
      releaseRun: (runId) => {
        for (const key of this.#previewStreams.keys()) {
          if (key.startsWith(`${runId}\u0000`)) {
            this.#previewStreams.delete(key);
          }
        }
      },
    });
  }

  #requireRun(runId: string): Run {
    this.#assertActive();
    return this.#state.requireRun(runId);
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("Contract projection is disposed.");
    }
  }
}
