import { isDeepStrictEqual } from "node:util";

import {
  assertProtocolAdmission,
  AuthorityOutcomeUnknownError,
  authorityContent,
  compareTimestamps,
  interactionSchema,
  itemSchema,
  jsonByteLength,
  jsonValueSchema,
  runSchema,
} from "../contract";
import type {
  AuthorityOperation,
  ContentBlock,
  Interaction,
  Item,
  MutationCause,
  PreviewUpdate,
  ProtocolAdmissionLimits,
  ProtocolError,
  Run,
  TokenUsage,
} from "../contract";
import { createDriverId } from "../protocol/id";

export { AuthorityOutcomeUnknownError } from "../contract";

const DEFAULT_PREVIEW_CHECKPOINT_BYTES = 128 * 1_024;
const DEFAULT_PREVIEW_REPLACE_INTERVAL_MS = 1_000;
const MAX_PENDING_MUTATION_BYTES = 32 * 1_024 * 1_024;
const MAX_PENDING_MUTATIONS = 1_024;

interface PreviewStreamState {
  bytes: number;
  lastReplaceAtMs: number;
  mode: "append" | "replace";
  segment: number;
  sequence: number;
  text: string;
}

interface AuthorityWrite {
  readonly intent: unknown;
  readonly key: string;
  readonly mutationId: string;
  readonly update: Omit<ContractAuthorityUpdate, "mutationId">;
}

interface UnknownAuthorityWrite extends AuthorityWrite {
  readonly error: AuthorityOutcomeUnknownError;
}

interface QueuedMutation {
  readonly bytes: number;
  readonly reject: (reason: unknown) => void;
  readonly run: () => Promise<void>;
}

export interface ContractAuthorityUpdate {
  readonly cause: MutationCause;
  readonly event: string;
  readonly mutationId: string;
  readonly operations: readonly AuthorityOperation[];
  readonly runId: string;
  readonly sessionId: string;
}

export interface ContractPreviewUpdate {
  readonly runId: string;
  readonly sessionId: string;
  readonly update: PreviewUpdate;
}

export interface ContractProjectionOptions {
  readonly admissionLimits?: ProtocolAdmissionLimits | undefined;
  readonly authority: (update: ContractAuthorityUpdate) => Promise<void>;
  readonly now?: (() => Date) | undefined;
  readonly preview: (update: ContractPreviewUpdate) => void;
  readonly previewCheckpointBytes?: number | undefined;
  readonly previewReplaceIntervalMs?: number | undefined;
  readonly sessionId: string;
}

type TextPreviewChannel = "message.text" | "reasoning.text" | "terminal.stderr" | "terminal.stdout";

function itemKey(runId: string, itemId: string): string {
  return `${runId}\u0000${itemId}`;
}

function streamKey(runId: string, itemId: string, channel: string): string {
  return `${itemKey(runId, itemId)}\u0000${channel}`;
}

function authorityKey(runId: string, event: string, cause: MutationCause): string {
  const causeId =
    cause.type === "command"
      ? cause.commandId
      : cause.type === "provider"
        ? cause.providerEventId
        : cause.type === "alarm"
          ? cause.alarm
          : cause.name;
  return JSON.stringify([runId, event, cause.type, causeId]);
}

function replaceCheckpointCause(runId: string, itemId: string, segment: number): MutationCause {
  return {
    providerEventId: `preview/replace:${runId}:${segment}:${itemId}`.slice(0, 256),
    type: "provider",
  };
}

function latestTimestamp(previous: string, next: string): string {
  return compareTimestamps(previous, next) > 0 ? previous : next;
}

function textContent(text: string): ContentBlock[] {
  return text.length === 0 ? [] : [{ text, type: "text" }];
}

export function asJsonValue(value: unknown) {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function nonEmpty(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

export function createProviderMeta(provider: string) {
  return {
    cause(event: string, id?: string): MutationCause {
      return {
        providerEventId: `${event}${id === undefined ? "" : `:${id}`}`.slice(0, 256),
        type: "provider",
      };
    },
    provenance(event: string, nativeIds?: Readonly<Record<string, string>>) {
      const boundedIds = Object.fromEntries(
        Object.entries(nativeIds ?? {}).filter(
          ([, value]) => value.length > 0 && value.length <= 256,
        ),
      );

      return {
        event,
        ...(Object.keys(boundedIds).length === 0 ? {} : { nativeIds: boundedIds }),
        provider,
      };
    },
  };
}

export class ContractProjection {
  readonly #admissionLimits: ProtocolAdmissionLimits | undefined;
  readonly #authority: ContractProjectionOptions["authority"];
  #disposed = false;
  readonly #childEndedAt = new Map<string, string>();
  readonly #interactions = new Map<string, Interaction>();
  readonly #items = new Map<string, Item>();
  readonly #now: () => Date;
  readonly #preview: ContractProjectionOptions["preview"];
  readonly #previewCheckpointBytes: number;
  readonly #previewReplaceIntervalMs: number;
  readonly #previewStreams = new Map<string, PreviewStreamState>();
  readonly #runs = new Map<string, Run>();
  readonly #sessionId: string;
  readonly #textEncoder = new TextEncoder();
  #mutationActive = false;
  #mutationBytes = 0;
  readonly #mutationQueue: QueuedMutation[] = [];
  #unknownAuthority: UnknownAuthorityWrite | undefined;

  constructor(options: ContractProjectionOptions) {
    this.#admissionLimits =
      options.admissionLimits === undefined ? undefined : { ...options.admissionLimits };
    this.#authority = options.authority;
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
        ...(this.#admissionLimits === undefined
          ? []
          : [this.#admissionLimits.maxBytes, this.#admissionLimits.maxInlineBytes]),
      ].some((value) => !Number.isSafeInteger(value) || value < 1)
    ) {
      throw new RangeError("Contract projection limits must be finite and positive.");
    }
  }

  now(): Date {
    this.#assertActive();
    return this.#now();
  }

  run(runId: string): Run | undefined {
    this.#assertActive();
    return this.#runs.get(runId);
  }

  item(runId: string, id: string): Item | undefined {
    this.#assertActive();
    return this.#items.get(itemKey(runId, id));
  }

  interaction(id: string): Interaction | undefined {
    this.#assertActive();
    return this.#interactions.get(id);
  }

  releaseInteraction(id: string): void {
    this.#assertActive();
    this.#interactions.delete(id);
  }

  items(runId: string): Item[] {
    this.#assertActive();
    return [...this.#items.values()].filter((item) => item.runId === runId);
  }

  interactions(runId: string): Interaction[] {
    this.#assertActive();
    return [...this.#interactions.values()].filter((interaction) => interaction.runId === runId);
  }

  attachRun(value: Run): void {
    this.#assertActive();
    const run = runSchema.parse(value);

    if (run.status !== "active") {
      throw new Error(`Contract projection can only attach an active run ${run.id}.`);
    }

    const existing = this.#runs.get(run.id);

    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, run)) {
        throw new Error(
          `Contract projection run ${run.id} is already attached with different state.`,
        );
      }

      return;
    }

    this.#runs.set(run.id, run);
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

    const existing = this.#items.get(itemKey(runId, item.id));

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

    return this.#items.get(itemKey(runId, operation.value.id)) ?? operation.value;
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

      const existing = this.#interactions.get(interaction.id);

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

      return this.#interactions.get(operation.value.id) ?? operation.value;
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

  async appendText(input: {
    readonly cause: MutationCause;
    readonly channel: TextPreviewChannel;
    readonly delta: string;
    readonly event: string;
    readonly itemId: string;
    readonly runId: string;
  }): Promise<void> {
    return this.#mutate(
      authorityKey(input.runId, `${input.event}.checkpoint`, input.cause),
      input,
      async (input) => {
        this.#assertActive();

        if (input.delta.length === 0) {
          return;
        }

        const item = this.#items.get(itemKey(input.runId, input.itemId));

        if (
          item === undefined ||
          item.status !== "active" ||
          !this.#matchesChannel(item, input.channel)
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
          const checkpoint = this.#appendItemText(
            this.#flushItemText(item, now.toISOString()),
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

  async checkpointText(input: {
    readonly cause: MutationCause;
    readonly channel: TextPreviewChannel;
    readonly event: string;
    readonly itemId: string;
    readonly runId: string;
  }): Promise<Item | undefined> {
    return this.#mutate(
      authorityKey(input.runId, input.event, input.cause),
      input,
      async (input) => {
        this.#assertActive();
        const item = this.#items.get(itemKey(input.runId, input.itemId));

        if (
          item === undefined ||
          item.status !== "active" ||
          !this.#matchesChannel(item, input.channel)
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
        const checkpoint = this.#flushItemText(item, now.toISOString());
        return this.#putItem(input.runId, input.event, input.cause, checkpoint, input, true);
      },
    );
  }

  async replacePreview(input: {
    readonly channel: PreviewUpdate["channel"];
    readonly itemId: string;
    readonly runId: string;
    readonly text: string;
  }): Promise<void> {
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
        const item = this.#items.get(itemKey(input.runId, input.itemId));

        if (
          item === undefined ||
          item.status !== "active" ||
          !this.#matchesChannel(item, input.channel)
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

          if (this.#itemText(item, input.channel) === input.text) {
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

          const checkpoint = this.#replaceItemText(
            this.#flushItemText(item, now.toISOString()),
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
            : this.#truncateUtf8(input.text, this.#previewCheckpointBytes - 1);
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
    try {
      this.#preview({ runId, sessionId: this.#sessionId, update });
    } catch {
      // Preview is best-effort; the retained state repairs any dropped callback.
    }
  }

  materializedText(runId: string, itemId: string, channel: TextPreviewChannel): string {
    this.#assertActive();
    const item = this.#items.get(itemKey(runId, itemId));
    const committed = item === undefined ? "" : this.#itemText(item, channel);
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
              this.#childEndedAt.get(input.runId) ?? current.startedAt,
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

          const withText = this.#flushItemText(item, endedAt);
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

    this.#childEndedAt.clear();
    this.#interactions.clear();
    this.#items.clear();
    this.#previewStreams.clear();
    this.#runs.clear();
    this.#unknownAuthority = undefined;
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
    const unknownAtEnqueue = this.#unknownAuthority;
    const task = Promise.withResolvers<T>();
    this.#mutationQueue.push({
      bytes,
      reject: task.reject,
      run: async () => {
        try {
          this.#assertActive();
          const unknown = this.#unknownAuthority;

          if (unknown !== undefined) {
            if (unknownAtEnqueue !== unknown) {
              throw unknown.error;
            }

            const resolvedKey = typeof key === "function" ? key(stableIntent) : key;
            if (unknown.key !== resolvedKey) {
              throw unknown.error;
            }

            if (!isDeepStrictEqual(unknown.intent, stableIntent)) {
              throw new AuthorityOutcomeUnknownError(
                "Authority retry changed while its outcome was unknown.",
              );
            }
          }

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

    if (operations.length === 0) {
      return operations;
    }

    const update = {
      cause,
      event,
      operations,
      runId,
      sessionId: this.#sessionId,
    };
    const key = authorityKey(runId, event, cause);
    const unknown = this.#unknownAuthority;
    let pending: AuthorityWrite;

    if (unknown === undefined) {
      pending = {
        intent: structuredClone(intent),
        key,
        mutationId: createDriverId(),
        update,
      };
    } else if (unknown.key !== key) {
      throw unknown.error;
    } else if (
      !isDeepStrictEqual(unknown.intent, intent) ||
      (!reuseDerived && !isDeepStrictEqual(unknown.update, update))
    ) {
      throw new AuthorityOutcomeUnknownError(
        `Authority write ${event} changed while its outcome was unknown.`,
      );
    } else {
      pending = unknown;
    }

    const submission = structuredClone({ ...pending.update, mutationId: pending.mutationId });

    if (this.#admissionLimits !== undefined) {
      assertProtocolAdmission(
        submission,
        this.#admissionLimits,
        authorityContent(submission.operations),
      );
    }

    try {
      await this.#authority(submission);
    } catch (error) {
      if (error instanceof AuthorityOutcomeUnknownError && !this.#disposed) {
        this.#unknownAuthority = { ...pending, error };
      } else {
        this.#unknownAuthority = undefined;
      }
      throw error;
    }

    if (this.#disposed) {
      return pending.update.operations;
    }

    try {
      this.#applyAuthorityOperations(pending.update.operations);
    } catch (error) {
      const unknown = new AuthorityOutcomeUnknownError(
        `Authority write ${event} committed but local apply failed.`,
        { cause: error },
      );
      this.#unknownAuthority = { ...pending, error: unknown };
      throw unknown;
    }

    this.#unknownAuthority = undefined;
    return pending.update.operations;
  }

  #applyAuthorityOperations(operations: readonly AuthorityOperation[]): void {
    const terminalRuns: string[] = [];

    for (const operation of operations) {
      if (operation.op === "remove") {
        terminalRuns.push(operation.id);
        continue;
      }

      switch (operation.entity) {
        case "session":
          break;
        case "run":
          this.#runs.set(operation.value.id, operation.value);
          if (operation.value.status !== "active") {
            terminalRuns.push(operation.value.id);
          }
          break;
        case "item": {
          const item = operation.value;
          this.#items.set(itemKey(item.runId, item.id), item);
          if (item.status === "active") {
            this.#advancePreviews(item.runId, item.id, Date.parse(item.updatedAt));
          } else {
            this.clearPreviews(item.runId, item.id);
          }
          break;
        }
        case "interaction":
          this.#interactions.set(operation.value.id, operation.value);
          break;
      }
    }

    for (const runId of terminalRuns) {
      this.#releaseRun(runId);
    }
  }

  #appendItemText(item: Item, channel: TextPreviewChannel, text: string, updatedAt: string): Item {
    if (item.kind === "message" && channel === "message.text") {
      return itemSchema.parse({
        ...item,
        content: [...item.content, ...textContent(text)],
        updatedAt: latestTimestamp(item.updatedAt, updatedAt),
      });
    }

    if (item.kind === "reasoning" && channel === "reasoning.text") {
      return itemSchema.parse({
        ...item,
        content: [...item.content, ...textContent(text)],
        updatedAt: latestTimestamp(item.updatedAt, updatedAt),
      });
    }

    if (item.kind === "terminal" && channel === "terminal.stdout") {
      return itemSchema.parse({
        ...item,
        stdout: [...item.stdout, ...textContent(text)],
        updatedAt: latestTimestamp(item.updatedAt, updatedAt),
      });
    }

    if (item.kind === "terminal" && channel === "terminal.stderr") {
      return itemSchema.parse({
        ...item,
        stderr: [...item.stderr, ...textContent(text)],
        updatedAt: latestTimestamp(item.updatedAt, updatedAt),
      });
    }

    return item;
  }

  #advancePreviews(runId: string, itemId: string, atMs: number): void {
    const prefix = `${itemKey(runId, itemId)}\u0000`;

    for (const [key, preview] of this.#previewStreams) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      this.#previewStreams.set(key, {
        bytes: 0,
        lastReplaceAtMs: atMs,
        mode: preview.mode,
        segment: preview.segment + 1,
        sequence: 0,
        text: "",
      });
    }
  }

  #flushItemText(item: Item, updatedAt: string): Item {
    let next = item;

    for (const channel of [
      "message.text",
      "reasoning.text",
      "terminal.stdout",
      "terminal.stderr",
    ] as const) {
      const preview = this.#previewStreams.get(streamKey(item.runId, item.id, channel));
      if (preview?.mode === "replace" && preview.sequence > 0) {
        next = this.#replaceItemText(next, channel, preview.text, updatedAt);
      } else if (preview?.text !== undefined && preview.text.length > 0) {
        next = this.#appendItemText(next, channel, preview.text, updatedAt);
      }
    }

    return next;
  }

  #replaceItemText(item: Item, channel: TextPreviewChannel, text: string, updatedAt: string): Item {
    if (item.kind === "terminal" && channel === "terminal.stdout") {
      return itemSchema.parse({
        ...item,
        stdout: textContent(text),
        updatedAt: latestTimestamp(item.updatedAt, updatedAt),
      });
    }

    if (item.kind === "terminal" && channel === "terminal.stderr") {
      return itemSchema.parse({
        ...item,
        stderr: textContent(text),
        updatedAt: latestTimestamp(item.updatedAt, updatedAt),
      });
    }

    return this.#appendItemText(item, channel, text, updatedAt);
  }

  #truncateUtf8(value: string, maxBytes: number): string {
    const encoded = this.#textEncoder.encode(value);
    return new TextDecoder().decode(encoded.subarray(0, maxBytes), { stream: true });
  }

  #itemText(item: Item, channel: TextPreviewChannel): string {
    if (item.kind === "message" && channel === "message.text") {
      return item.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    }

    if (item.kind === "reasoning" && channel === "reasoning.text") {
      return item.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    }

    if (item.kind === "terminal" && channel === "terminal.stdout") {
      return item.stdout.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    }

    if (item.kind === "terminal" && channel === "terminal.stderr") {
      return item.stderr.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    }

    return "";
  }

  #matchesChannel(item: Item, channel: PreviewUpdate["channel"]): boolean {
    switch (channel) {
      case "message.text":
        return item.kind === "message";
      case "reasoning.text":
        return item.kind === "reasoning";
      case "terminal.stderr":
      case "terminal.stdout":
        return item.kind === "terminal";
      case "tool.progress":
        return item.kind === "tool";
      default:
        return true;
    }
  }

  #releaseRun(runId: string): void {
    const run = this.#runs.get(runId);

    if (run !== undefined && run.status !== "active" && run.parentRunId !== undefined) {
      const parent = this.#runs.get(run.parentRunId);

      if (parent?.status === "active") {
        const previous = this.#childEndedAt.get(parent.id);
        this.#childEndedAt.set(
          parent.id,
          previous === undefined ? run.endedAt : latestTimestamp(previous, run.endedAt),
        );
      }
    }

    this.#childEndedAt.delete(runId);
    this.#runs.delete(runId);

    for (const key of this.#items.keys()) {
      if (key.startsWith(`${runId}\u0000`)) {
        this.#items.delete(key);
      }
    }

    for (const [id, interaction] of this.#interactions) {
      if (interaction.runId === runId) {
        this.#interactions.delete(id);
      }
    }

    for (const key of this.#previewStreams.keys()) {
      if (key.startsWith(`${runId}\u0000`)) {
        this.#previewStreams.delete(key);
      }
    }
  }

  #requireRun(runId: string): Run {
    this.#assertActive();
    const run = this.#runs.get(runId);

    if (run === undefined) {
      throw new Error(`Contract projection references unknown run ${runId}.`);
    }

    return run;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("Contract projection is disposed.");
    }
  }
}
