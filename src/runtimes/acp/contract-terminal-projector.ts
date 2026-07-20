import { isDeepStrictEqual } from "node:util";

import type {
  CreateTerminalRequest,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";

import { itemSchema } from "../../contract";
import type { Item } from "../../contract";
import {
  AuthorityOutcomeUnknownError,
  createProviderMeta,
  ContractProjection,
} from "../contract-projection";
import type { AcpContractSessionUpdateInbox } from "./contract-session-update-inbox";

const TERMINAL_OUTPUT_EXTENSION = "agentclientprotocol.v1/terminal-output";
const { cause: providerCause, provenance } = createProviderMeta("agent-client-protocol");

interface PendingTerminalExit {
  readonly endedAt: string;
  readonly exit: WaitForTerminalExitResponse;
}

interface TerminalIntent {
  readonly receivedAt: string;
  readonly request: CreateTerminalRequest | undefined;
  readonly runId: string;
  readonly terminalId: string;
}

interface UnknownTerminal {
  readonly error: AuthorityOutcomeUnknownError;
  readonly intent: TerminalIntent;
  retry?: Promise<string>;
}

export interface AcpContractTerminalProjectorOptions {
  readonly assertNativeSession: (sessionId: string) => void;
  readonly inbox: AcpContractSessionUpdateInbox;
  readonly now: () => string;
  readonly projection: ContractProjection;
  readonly resolveId: (runId: string, kind: string, nativeId: string) => string;
  readonly withReceiptTime: <T>(receivedAt: string, operation: () => Promise<T>) => Promise<T>;
}

export class AcpContractTerminalProjector {
  readonly #assertNativeSession: (sessionId: string) => void;
  #disposed = false;
  readonly #inbox: AcpContractSessionUpdateInbox;
  readonly #now: () => string;
  readonly #pendingTerminalExits = new Map<string, PendingTerminalExit>();
  readonly #projection: ContractProjection;
  readonly #resolveId: AcpContractTerminalProjectorOptions["resolveId"];
  readonly #truncatedTerminals = new Set<string>();
  #unknownTerminal: UnknownTerminal | undefined;
  readonly #withReceiptTime: AcpContractTerminalProjectorOptions["withReceiptTime"];

  constructor(options: AcpContractTerminalProjectorOptions) {
    this.#assertNativeSession = options.assertNativeSession;
    this.#inbox = options.inbox;
    this.#now = options.now;
    this.#projection = options.projection;
    this.#resolveId = options.resolveId;
    this.#withReceiptTime = options.withReceiptTime;
  }

  async registerTerminal(
    runId: string,
    terminalId: string,
    request?: CreateTerminalRequest,
  ): Promise<string> {
    this.#assertActive();

    const snapshot = request === undefined ? undefined : structuredClone(request);

    if (snapshot !== undefined) {
      this.#assertNativeSession(snapshot.sessionId);
    }

    const unknownAtAdmission = this.#unknownTerminal;
    const exactRetry =
      unknownAtAdmission !== undefined &&
      unknownAtAdmission.intent.runId === runId &&
      unknownAtAdmission.intent.terminalId === terminalId &&
      isDeepStrictEqual(unknownAtAdmission.intent.request, snapshot)
        ? unknownAtAdmission
        : undefined;

    if (unknownAtAdmission !== undefined && exactRetry === undefined) {
      throw unknownAtAdmission.error;
    }

    if (exactRetry?.retry !== undefined) {
      return exactRetry.retry;
    }

    const intent =
      exactRetry?.intent ??
      ({
        receivedAt: this.#projection.now().toISOString(),
        request: snapshot,
        runId,
        terminalId,
      } satisfies TerminalIntent);
    const registration = this.#inbox.enqueue(async () => {
      try {
        const unknown = this.#unknownTerminal;

        if (unknown !== undefined && unknown !== unknownAtAdmission) {
          throw unknown.error;
        }

        const id = await this.#withReceiptTime(intent.receivedAt, () =>
          this.ensureTerminal(intent.runId, intent.terminalId, intent.request),
        );

        if (this.#unknownTerminal === unknownAtAdmission) {
          this.#unknownTerminal = undefined;
        }

        return id;
      } catch (error) {
        if (error instanceof AuthorityOutcomeUnknownError) {
          this.#unknownTerminal ??= { error, intent };
        } else if (this.#unknownTerminal?.intent === intent) {
          this.#unknownTerminal = undefined;
        }

        throw error;
      }
    });

    if (exactRetry !== undefined) {
      const retry = registration.finally(() => {
        if (exactRetry.retry === retry) {
          delete exactRetry.retry;
        }
      });
      exactRetry.retry = retry;
      return retry;
    }

    return registration;
  }

  async handleTerminalOutput(
    runId: string,
    terminalId: string,
    response: TerminalOutputResponse,
  ): Promise<void> {
    this.#assertActive();
    return this.#inbox.enqueue(() => this.#handleTerminalOutput(runId, terminalId, response));
  }

  async #handleTerminalOutput(
    runId: string,
    terminalId: string,
    response: TerminalOutputResponse,
  ): Promise<void> {
    if (this.#projection.run(runId)?.status !== "active") {
      return;
    }

    const id = await this.ensureTerminal(runId, terminalId);
    const item = this.#projection.item(runId, id);

    if (item?.kind !== "terminal" || item.status !== "active") {
      return;
    }

    const truncationKey = `${runId}\0${terminalId}`;

    if (response.truncated) {
      this.#truncatedTerminals.add(truncationKey);
    }

    const pendingExit = this.#pendingTerminalExits.get(truncationKey);
    const exit = response.exitStatus ?? pendingExit?.exit;

    if (exit === undefined || exit === null) {
      await this.#projection.replacePreview({
        channel: "terminal.stdout",
        itemId: id,
        runId,
        text: response.output,
      });
      return;
    }

    if (pendingExit !== undefined && !isDeepStrictEqual(pendingExit.exit, exit)) {
      throw new Error(`ACP v1 terminal ${terminalId} changed its exit status.`);
    }

    const terminalExit = pendingExit ?? { endedAt: this.#now(), exit };
    this.#pendingTerminalExits.set(truncationKey, terminalExit);

    await this.#finishTerminal(
      runId,
      item,
      response.output,
      terminalExit,
      this.#truncatedTerminals.has(truncationKey),
    );
    this.#pendingTerminalExits.delete(truncationKey);
    this.#truncatedTerminals.delete(truncationKey);
  }

  async handleTerminalExit(
    runId: string,
    terminalId: string,
    response: WaitForTerminalExitResponse,
  ): Promise<void> {
    this.#assertActive();
    return this.#inbox.enqueue(() => this.#handleTerminalExit(runId, terminalId, response));
  }

  async #handleTerminalExit(
    runId: string,
    terminalId: string,
    response: WaitForTerminalExitResponse,
  ): Promise<void> {
    if (this.#projection.run(runId)?.status !== "active") {
      return;
    }

    const id = await this.ensureTerminal(runId, terminalId);
    const truncationKey = `${runId}\0${terminalId}`;
    const item = this.#projection.item(runId, id);

    if (item?.kind === "terminal" && item.status === "active") {
      const pending = this.#pendingTerminalExits.get(truncationKey);

      if (pending !== undefined && !isDeepStrictEqual(pending.exit, response)) {
        throw new Error(`ACP v1 terminal ${terminalId} changed its exit status.`);
      }

      this.#pendingTerminalExits.set(truncationKey, {
        endedAt: pending?.endedAt ?? this.#now(),
        exit: response,
      });
    }
  }

  async ensureTerminal(
    runId: string,
    terminalId: string,
    request?: CreateTerminalRequest,
  ): Promise<string> {
    const id = this.#resolveId(runId, "terminal", terminalId);
    const existing = this.#projection.item(runId, id);

    if (existing !== undefined) {
      if (existing.kind !== "terminal") {
        throw new Error("ACP v1 terminal ID collided with a non-terminal item.");
      }

      return id;
    }

    const now = this.#now();
    await this.#projection.putItem(
      runId,
      "terminal/created",
      providerCause("terminal/created", terminalId),
      itemSchema.parse({
        audience: "participants",
        ...(request === undefined
          ? {}
          : {
              command: [request.command, ...(request.args ?? [])].join(" "),
              ...(request.cwd === undefined || request.cwd === null ? {} : { cwd: request.cwd }),
            }),
        createdAt: now,
        id,
        kind: "terminal",
        provenance: provenance("terminal/created", { terminalId }),
        runId,
        status: "active",
        stderr: [],
        stdout: [],
        updatedAt: now,
      }),
    );
    return id;
  }

  async #finishTerminal(
    runId: string,
    item: Extract<Item, { kind: "terminal" }>,
    output: string,
    terminalExit: PendingTerminalExit,
    truncated: boolean,
  ): Promise<void> {
    const { endedAt: now, exit } = terminalExit;
    const failed =
      (exit.exitCode !== undefined && exit.exitCode !== null && exit.exitCode !== 0) ||
      (exit.signal !== undefined && exit.signal !== null);
    await this.#projection.putItem(
      runId,
      "terminal/exited",
      providerCause("terminal/exited", item.id),
      itemSchema.parse({
        ...item,
        endedAt: now,
        ...(failed
          ? {
              error: {
                code: "agent_client_protocol.terminal_failed",
                message: "Terminal command failed.",
                retryable: false,
              },
            }
          : {}),
        ...(truncated
          ? { extensions: { ...item.extensions, [TERMINAL_OUTPUT_EXTENSION]: { truncated } } }
          : {}),
        exitCode: exit.exitCode ?? null,
        signal: exit.signal ?? null,
        status: failed ? "failed" : "completed",
        stdout: output.length === 0 ? [] : [{ text: output, type: "text" }],
        updatedAt: now,
      }),
    );
  }

  async flushTerminalExits(runId: string): Promise<void> {
    for (const [key, pending] of this.#pendingTerminalExits) {
      if (!key.startsWith(`${runId}\0`)) {
        continue;
      }

      const terminalId = key.slice(runId.length + 1);
      const id = this.#resolveId(runId, "terminal", terminalId);
      const item = this.#projection.item(runId, id);

      if (item?.kind === "terminal" && item.status === "active") {
        await this.#finishTerminal(
          runId,
          item,
          this.#projection.materializedText(runId, id, "terminal.stdout"),
          pending,
          this.#truncatedTerminals.has(key),
        );
      }

      this.#pendingTerminalExits.delete(key);
      this.#truncatedTerminals.delete(key);
    }
  }

  releaseRun(runId: string): void {
    for (const key of this.#truncatedTerminals) {
      if (key.startsWith(`${runId}\0`)) {
        this.#truncatedTerminals.delete(key);
      }
    }
    for (const key of this.#pendingTerminalExits.keys()) {
      if (key.startsWith(`${runId}\0`)) {
        this.#pendingTerminalExits.delete(key);
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#pendingTerminalExits.clear();
    this.#truncatedTerminals.clear();
    this.#unknownTerminal = undefined;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("ACP v1 terminal projector is disposed.");
    }
  }
}
