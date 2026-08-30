import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DriverEvent } from "../src/protocol/events";
import {
  parseDriverCommandUpdateInput,
  parseDriverCompletionInput,
  parseDriverEventBatchInput,
  parseDriverExternalToolEffectClaimInput,
  parseDriverExternalToolEffectObserveInput,
  parseDriverExternalToolEffectSettleInput,
  parseDriverFailureInput,
  parseDriverHeartbeatInput,
  parseDriverHelloInput,
  parseDriverLogBatchInput,
  parseDriverNextCommandInput,
  parseDriverReadyInput,
  type DriverLogEntry,
} from "../src/protocol/orpc";
import type {
  DriverCapability,
  McpExecuteCommandResult,
  McpExternalToolEffectState,
  RuntimeCommand,
} from "../src/runtime-command";
import { PROCESS_TREE_OWNER_ENV } from "../src/runtimes/child-process";
import {
  AGENT_DRIVER_PROVIDER_REGISTRY,
  createAgentDriverProviderCapabilities,
} from "../src/runtimes/provider-registry";

export type DriverArtifactTestEvent = DriverEvent;

export function expectedDriverCapabilities(runtime: string): readonly DriverCapability[] {
  const provider = AGENT_DRIVER_PROVIDER_REGISTRY.list().find(
    (candidate) => candidate.runtime === runtime,
  );
  if (provider === undefined) {
    throw new Error(`Missing provider descriptor for ${runtime}.`);
  }
  return createAgentDriverProviderCapabilities({
    permissionRequestStatus: "supported",
    provider,
  });
}

export interface DriverArtifactTestCommandUpdate {
  readonly commandId: string;
  readonly error?: unknown;
  readonly result?: unknown;
  readonly status: string;
}

export type DriverArtifactTestCommand = RuntimeCommand;

export interface DriverArtifactEventIngressGate {
  readonly entered: Promise<DriverArtifactTestEvent>;
  release(): void;
}

export interface DriverArtifactBootPayload extends Record<string, unknown> {
  readonly bootToken: string;
  readonly driverInstanceId: string;
  readonly execution: {
    readonly configRevision: {
      readonly runId?: string | null | undefined;
      readonly sessionId: string;
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  };
  readonly runtime: string;
}

interface DriverArtifactTestControllerOptions {
  readonly artifactPath: string;
  readonly bootPayload: DriverArtifactBootPayload;
  readonly env?: NodeJS.ProcessEnv;
  readonly expectedCapabilities?: readonly DriverCapability[] | undefined;
  readonly forbiddenSecrets?: readonly string[] | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly organizationPath: string;
  readonly rootPath: string;
  readonly secret?: string | undefined;
  readonly startTimeoutMs: number;
}

interface DriverExit {
  readonly code: number | null;
  readonly error?: string;
  readonly signal: NodeJS.Signals | null;
}

interface DriverRunTerminal {
  readonly error?: unknown;
  readonly runId: string;
  readonly status: "completed" | "failed";
}

interface EventIngressGateState {
  entered: boolean;
  readonly enter: (event: DriverArtifactTestEvent) => void;
  readonly predicate: (event: DriverArtifactTestEvent) => boolean;
  readonly release: () => void;
  readonly released: Promise<void>;
}

type ArtifactExternalToolEffect =
  | { readonly effectId: string; readonly kind: "intent" }
  | {
      readonly attempt: number;
      readonly claimToken: string;
      readonly effectId: string;
      readonly idempotencyKey: string;
      readonly kind: "claimed";
    }
  | {
      readonly effectId: string;
      readonly kind: "succeeded";
      readonly result: McpExecuteCommandResult;
    }
  | { readonly effectId: string; readonly kind: "unknown" };

function toExternalToolEffectState(effect: ArtifactExternalToolEffect): McpExternalToolEffectState {
  if (effect.kind === "claimed") {
    const { claimToken: _, ...state } = effect;
    return state;
  }
  return structuredClone(effect);
}

interface RpcRequest {
  readonly id: number | string;
  readonly input: Record<string, unknown>;
  readonly path: string;
}

const TERMINAL_COMMAND_STATUSES = new Set(["cancelled", "completed", "failed"]);
const OUTPUT_LIMIT = 24_000;
const FORBIDDEN_SECRET_ERROR = "Forbidden secret detected in packed driver traffic or output.";

export class ForbiddenSecretScanner {
  readonly #maxTailLength: number;
  readonly #secrets: readonly string[];
  #tail = "";

  constructor(secrets: readonly string[]) {
    this.#secrets = secrets;
    this.#maxTailLength = Math.max(0, ...secrets.map((secret) => secret.length - 1));
  }

  scan(chunk: string): boolean {
    const value = `${this.#tail}${chunk}`;
    this.#tail = this.#maxTailLength === 0 ? "" : value.slice(-this.#maxTailLength);
    return this.#secrets.some((secret) => value.includes(secret));
  }
}

interface LinuxProcessIdentity {
  readonly startTime: string;
  readonly state: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }

  return value;
}

function readString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];

  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label}.${field} must be a non-empty string.`);
  }

  return value;
}

function readRpcRequest(message: string | Buffer): RpcRequest | null {
  const request = readRecord(JSON.parse(message.toString()), "RPC request");

  if (request["t"] === 4) {
    return null;
  }

  const packet = readRecord(request["p"], "RPC request packet");
  const body = readRecord(packet["b"], "RPC request body");
  const id = request["i"];

  if (typeof id !== "number" && typeof id !== "string") {
    throw new TypeError("RPC request ID must be a number or string.");
  }

  return {
    id,
    input: readRecord(body["json"], "RPC request input"),
    path: readString(packet, "u", "RPC request packet"),
  };
}

function timeoutAfter(timeoutMs: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
}

function directChildProcessIds(parentPid: number): number[] {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });

  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Failed to inspect packed driver children: ${result.error?.message ?? result.stderr}`,
    );
  }

  return result.stdout.split("\n").flatMap((line) => {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const candidateParentPid = Number(parentText);
    return candidateParentPid === parentPid && Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
  });
}

function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    const startTime = fields[19];

    if (state === undefined || state.length !== 1 || startTime === undefined) {
      throw new Error(`Malformed /proc/${pid}/stat.`);
    }

    return { startTime, state };
  } catch {
    if (!existsSync(`/proc/${pid}`)) {
      return null;
    }
    throw new Error(`Could not inspect live process ${pid}.`);
  }
}

function readLinuxProcessUid(pid: number, identity: LinuxProcessIdentity): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    if (/^Kthread:\s+1$/m.test(status)) {
      return null;
    }
    const match = /^Uid:\s+(\d+)/m.exec(status);
    if (match === null) {
      throw new Error(`Missing UID in /proc/${pid}/status.`);
    }
    const uid = Number(match[1]);
    if (!Number.isSafeInteger(uid) || uid < 0) {
      throw new Error(`Invalid UID in /proc/${pid}/status.`);
    }
    return uid;
  } catch {
    const current = readLinuxProcessIdentity(pid);
    if (current === null || current.startTime !== identity.startTime) {
      return null;
    }
    throw new Error(`Could not inspect the UID of live process ${pid}.`);
  }
}

function readProcessFile(
  pid: number,
  identity: LinuxProcessIdentity,
  file: "cmdline" | "environ",
): string | null {
  let value: string;

  try {
    value = readFileSync(`/proc/${pid}/${file}`, "utf8");
  } catch {
    const current = readLinuxProcessIdentity(pid);
    if (current === null || current.startTime !== identity.startTime) {
      return null;
    }
    throw new Error(`Could not inspect /proc/${pid}/${file} for a live process.`);
  }

  const current = readLinuxProcessIdentity(pid);
  return current !== null && current.startTime === identity.startTime ? value : null;
}

function readProcessEnvironmentVariable(
  pid: number,
  identity: LinuxProcessIdentity,
  name: string,
): string | null {
  const environment = readProcessFile(pid, identity, "environ");
  if (environment === null) {
    return null;
  }
  const entry = environment.split("\0").find((candidate) => candidate.startsWith(`${name}=`));
  const value = entry?.slice(name.length + 1) ?? "";
  return value.length > 0 ? value : null;
}

function readSameUserLinuxIdentity(pid: number): LinuxProcessIdentity | null {
  const identity = readLinuxProcessIdentity(pid);
  if (identity === null || identity.state === "Z" || identity.state === "X") {
    return null;
  }
  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw new Error("Linux process inspection requires a POSIX user ID.");
  }
  return readLinuxProcessUid(pid, identity) === currentUid ? identity : null;
}

export class DriverArtifactTestController {
  readonly #bootPayload: DriverArtifactBootPayload;
  readonly #commands: DriverArtifactTestCommand[] = [];
  readonly #commandUpdates: DriverArtifactTestCommandUpdate[] = [];
  readonly #eventIngressGates = new Set<EventIngressGateState>();
  readonly #eventIngressObservers = new Set<(event: DriverArtifactTestEvent) => void>();
  readonly #eventReceipts = new Map<
    string,
    {
      readonly receipt: { readonly eventId: string; readonly seq: number; readonly type: string };
    }
  >();
  readonly #events: DriverArtifactTestEvent[] = [];
  readonly #externalToolEffects = new Map<string, ArtifactExternalToolEffect>();
  readonly #expectedCapabilities: readonly DriverCapability[] | undefined;
  readonly #forbiddenSecrets: readonly string[];
  readonly #heartbeatIntervalMs: number;
  readonly #logs: DriverLogEntry[] = [];
  readonly #knownRunIds = new Set<string>();
  readonly #organizationPath: string;
  readonly #runTerminalIngressObservers = new Set<(terminal: DriverRunTerminal) => void>();
  readonly #runTerminals: DriverRunTerminal[] = [];
  readonly #runtimeId: string;
  readonly #server: Bun.Server<undefined>;
  readonly #sessionId: string;
  readonly #stderrSecretScanner: ForbiddenSecretScanner;
  readonly #stdoutSecretScanner: ForbiddenSecretScanner;
  #child: ChildProcess | null = null;
  #exitPromise: Promise<DriverExit> | null = null;
  #exitResult: DriverExit | null = null;
  #forbiddenSecretDetected = false;
  #heartbeatsFail = false;
  #hello = false;
  #nextEventSeq = 0;
  #protocolError: string | null = null;
  #ready = false;
  #stderr = "";
  #stdout = "";
  #socket: Bun.ServerWebSocket<undefined> | null = null;
  readonly #terminalRunIds = new Set<string>();

  private constructor(options: DriverArtifactTestControllerOptions) {
    this.#bootPayload = structuredClone(options.bootPayload);
    this.#expectedCapabilities =
      options.expectedCapabilities === undefined
        ? undefined
        : structuredClone(options.expectedCapabilities);
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
    this.#organizationPath = options.organizationPath;
    this.#runtimeId = options.bootPayload.runtime;
    this.#forbiddenSecrets = [
      ...new Set([options.secret, ...(options.forbiddenSecrets ?? [])].filter(Boolean)),
    ] as string[];
    this.#stderrSecretScanner = new ForbiddenSecretScanner(this.#forbiddenSecrets);
    this.#stdoutSecretScanner = new ForbiddenSecretScanner(this.#forbiddenSecrets);
    this.#sessionId = options.bootPayload.execution.configRevision.sessionId;
    const bootRunId = options.bootPayload.execution.configRevision.runId;
    if (typeof bootRunId === "string" && bootRunId.length > 0) {
      this.#knownRunIds.add(bootRunId);
    }

    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => {
        const url = new URL(request.url);

        if (
          url.searchParams.get("driverInstanceId") !== this.#bootPayload.driverInstanceId ||
          url.searchParams.get("token") !== this.#bootPayload.bootToken
        ) {
          return new Response("Unauthorized", { status: 401 });
        }

        return server.upgrade(request)
          ? undefined
          : new Response("WebSocket upgrade required", { status: 426 });
      },
      websocket: {
        close: (socket) => {
          if (this.#socket === socket) {
            this.#socket = null;
          }
        },
        message: (socket, message) => {
          void this.#handleMessage(socket, message);
        },
        open: (socket) => {
          this.#socket = socket;
        },
      },
    });
  }

  static async start(
    options: DriverArtifactTestControllerOptions,
  ): Promise<DriverArtifactTestController> {
    const controller = new DriverArtifactTestController(options);

    try {
      await controller.#launch(options);
      await controller.waitUntilReady(options.startTimeoutMs);
      return controller;
    } catch (error) {
      const diagnostics = controller.diagnostics();
      await controller.dispose().catch(() => {});
      throw new Error(
        `Packed driver failed to become ready: ${error instanceof Error ? error.message : String(error)}\n${diagnostics}`,
        { cause: error },
      );
    }
  }

  get events(): readonly DriverArtifactTestEvent[] {
    return this.#events;
  }

  get commandUpdates(): readonly DriverArtifactTestCommandUpdate[] {
    return this.#commandUpdates;
  }

  gateEventIngress(
    predicate: (event: DriverArtifactTestEvent) => boolean,
  ): DriverArtifactEventIngressGate {
    const entered = Promise.withResolvers<DriverArtifactTestEvent>();
    const released = Promise.withResolvers<void>();
    let active = true;
    const gate: EventIngressGateState = {
      entered: false,
      enter: entered.resolve,
      predicate,
      release: () => {
        if (!active) {
          return;
        }
        active = false;
        this.#eventIngressGates.delete(gate);
        released.resolve();
      },
      released: released.promise,
    };
    this.#eventIngressGates.add(gate);
    return { entered: entered.promise, release: gate.release };
  }

  observeEventIngress(observer: (event: DriverArtifactTestEvent) => void): () => void {
    this.#eventIngressObservers.add(observer);
    return () => this.#eventIngressObservers.delete(observer);
  }

  observeRunTerminalIngress(observer: (terminal: DriverRunTerminal) => void): () => void {
    this.#runTerminalIngressObservers.add(observer);
    return () => this.#runTerminalIngressObservers.delete(observer);
  }

  enqueue(command: DriverArtifactTestCommand): void {
    if (command.kind === "input.start") {
      const runId = command["runId"];
      if (typeof runId !== "string" || runId.length === 0) {
        throw new TypeError("input.start runId must be a non-empty string.");
      }
      this.#knownRunIds.add(runId);
    }
    this.#commands.push(structuredClone(command));
  }

  disconnectDriver(): void {
    if (this.#socket === null) {
      throw new Error("Packed driver control socket is not connected.");
    }

    void this.#server.stop(true);
  }

  failHeartbeats(): void {
    this.#heartbeatsFail = true;
  }

  directChildProcessIds(): number[] {
    const pid = this.#child?.pid;

    if (pid === undefined) {
      throw new Error("Packed driver process ID is unavailable.");
    }

    return directChildProcessIds(pid);
  }

  providerProcessIds(): number[] {
    return this.providerProcessIdsForOwners(this.providerOwnerIds());
  }

  providerOwnerIds(): string[] {
    if (process.platform !== "linux") {
      throw new Error("Provider process ownership checks require Linux /proc.");
    }

    return [
      ...new Set(
        this.directChildProcessIds().flatMap((pid) => {
          const identity = readSameUserLinuxIdentity(pid);
          if (identity === null) {
            return [];
          }
          const ownerId = readProcessEnvironmentVariable(pid, identity, PROCESS_TREE_OWNER_ENV);
          return ownerId === null ? [] : [ownerId];
        }),
      ),
    ];
  }

  providerProcessIdsForOwners(ownerIds: readonly string[]): number[] {
    if (process.platform !== "linux") {
      throw new Error("Provider process ownership checks require Linux /proc.");
    }

    const owners = new Set(ownerIds);
    return readdirSync("/proc").flatMap((entry) => {
      const pid = Number(entry);
      if (!Number.isSafeInteger(pid) || pid < 1) {
        return [];
      }
      const identity = readSameUserLinuxIdentity(pid);
      if (identity === null) {
        return [];
      }
      const ownerId = readProcessEnvironmentVariable(pid, identity, PROCESS_TREE_OWNER_ENV);
      return ownerId !== null && owners.has(ownerId) ? [pid] : [];
    });
  }

  markedProcessIds(environmentName: string, value: string): number[] {
    if (process.platform !== "linux") {
      throw new Error("Marked process checks require Linux /proc.");
    }

    return readdirSync("/proc").flatMap((entry) => {
      const pid = Number(entry);
      if (!Number.isSafeInteger(pid) || pid < 1) {
        return [];
      }

      const identity = readSameUserLinuxIdentity(pid);
      if (identity === null) {
        return [];
      }
      const environmentMatches =
        readProcessEnvironmentVariable(pid, identity, environmentName) === value;
      const commandMatches = readProcessFile(pid, identity, "cmdline")?.includes(value) ?? false;
      return environmentMatches || commandMatches ? [pid] : [];
    });
  }

  crashDriver(): void {
    this.#signalDriver("SIGKILL", false);
  }

  signalDriver(signal: NodeJS.Signals): void {
    this.#signalDriver(signal, false);
  }

  #signalDriver(signal: NodeJS.Signals, includeChildren: boolean): void {
    if (this.#child === null || this.#exitResult !== null) {
      throw new Error("Packed driver is not running.");
    }

    if (includeChildren && process.platform !== "win32" && this.#child.pid !== undefined) {
      process.kill(-this.#child.pid, signal);
      return;
    }

    this.#child.kill(signal);
  }

  eventsSince(index: number): DriverArtifactTestEvent[] {
    return this.#events.slice(index);
  }

  async runTurn(input: {
    readonly commandId: string;
    readonly requestId: string;
    readonly runId: string;
    readonly text: string;
    readonly timeoutMs: number;
  }): Promise<DriverArtifactTestEvent[]> {
    const eventIndex = this.#events.length;
    this.enqueue({
      commandId: input.commandId,
      input: { text: input.text },
      kind: "input.start",
      requestId: input.requestId,
      runId: input.runId,
    });

    const [update, terminalEvent] = await Promise.all([
      this.waitForCommandTerminal(input.commandId, input.timeoutMs),
      this.waitForEvent(
        (event) =>
          event.runId === input.runId &&
          (event.kind === "run.completed" ||
            event.kind === "run.failed" ||
            event.kind === "run.cancelled"),
        eventIndex,
        input.timeoutMs,
        `run ${input.runId} terminal event`,
      ),
    ]);

    if (update.status !== "completed" || terminalEvent.kind !== "run.completed") {
      throw new Error(
        `Turn ${input.runId} ended as command=${update.status}, event=${terminalEvent.kind}.\n${this.diagnostics()}`,
      );
    }

    return this.eventsSince(eventIndex);
  }

  async stopDriver(commandId: string, timeoutMs: number): Promise<void> {
    const terminalIndex = this.#runTerminals.length;
    this.enqueue({ commandId, kind: "session.stop", reason: "live.test.completed" });
    const [update, terminal] = await Promise.all([
      this.waitForCommandTerminal(commandId, timeoutMs),
      this.waitForRunTerminal(timeoutMs, terminalIndex),
    ]);

    if (update.status !== "completed" || terminal.status !== "completed") {
      throw new Error(
        `Driver stop ended as command=${update.status}, run=${terminal.status}.\n${this.diagnostics()}`,
      );
    }

    const exit = await this.waitForExit(timeoutMs);

    if (exit.code !== 0) {
      throw new Error(`Packed driver exited with ${JSON.stringify(exit)}.\n${this.diagnostics()}`);
    }
  }

  async waitForCommandTerminal(
    commandId: string,
    timeoutMs: number,
    fromIndex = 0,
  ): Promise<DriverArtifactTestCommandUpdate> {
    return this.#waitFor(
      () =>
        this.#commandUpdates
          .slice(fromIndex)
          .find(
            (update) =>
              update.commandId === commandId && TERMINAL_COMMAND_STATUSES.has(update.status),
          ),
      `command ${commandId} terminal update`,
      timeoutMs,
    );
  }

  async waitForCommandUpdate(
    predicate: (update: DriverArtifactTestCommandUpdate) => boolean,
    fromIndex: number,
    timeoutMs: number,
    label: string,
  ): Promise<DriverArtifactTestCommandUpdate> {
    return this.#waitFor(
      () => this.#commandUpdates.slice(fromIndex).find(predicate),
      label,
      timeoutMs,
    );
  }

  async waitForEvent(
    predicate: (event: DriverArtifactTestEvent) => boolean,
    fromIndex: number,
    timeoutMs: number,
    label: string,
  ): Promise<DriverArtifactTestEvent> {
    return this.#waitFor(() => this.#events.slice(fromIndex).find(predicate), label, timeoutMs);
  }

  async waitForExit(timeoutMs: number): Promise<DriverExit> {
    const deadline = Date.now() + timeoutMs;
    this.#throwProtocolError("packed driver exit");
    if (this.#exitPromise === null) {
      throw new Error("Packed driver has not started.");
    }

    const result =
      this.#exitResult ??
      (await Promise.race([this.#exitPromise, timeoutAfter(Math.max(0, deadline - Date.now()))]));

    if (result === "timeout") {
      throw new Error(`Timed out waiting for packed driver exit.\n${this.diagnostics()}`);
    }

    await this.#waitForSocketDrain(deadline);
    this.#throwProtocolError("packed driver exit");
    return result;
  }

  assertHealthy(label: string): void {
    this.#throwProtocolError(label);
    if (this.#exitResult !== null) {
      throw new Error(
        `Packed driver exited while waiting for ${label}: ${JSON.stringify(this.#exitResult)}.\n${this.diagnostics()}`,
      );
    }
  }

  diagnostics(): string {
    const diagnostics = JSON.stringify(
      {
        commandUpdates: this.#commandUpdates.slice(-12),
        events: this.#events.slice(-30).map((event) => ({
          kind: event.kind,
          runId: event.runId ?? null,
        })),
        exit: this.#exitResult,
        forbiddenSecretDetected: this.#forbiddenSecretDetected,
        logs: this.#logs.slice(-12).map((entry) => ({
          ...(entry.error === undefined
            ? {}
            : {
                error: {
                  ...(entry.error.code === undefined ? {} : { code: entry.error.code }),
                  message: entry.error.message,
                  name: entry.error.name,
                },
              }),
          ...(entry.fields === undefined ? {} : { fields: entry.fields }),
          level: entry.level,
          message: entry.message,
        })),
        protocolError: this.#protocolError,
        ready: this.#ready,
        stderr: this.#stderr,
        stdout: this.#stdout,
      },
      (_key, value) => (typeof value === "string" ? this.#redact(value) : value),
      2,
    );

    return this.#redact(diagnostics);
  }

  async dispose(): Promise<void> {
    for (const gate of this.#eventIngressGates) {
      gate.release();
    }
    this.#eventIngressObservers.clear();
    this.#runTerminalIngressObservers.clear();

    const child = this.#child;

    if (child !== null && this.#exitResult === null) {
      child.kill("SIGTERM");
      await this.#waitForChildExit(5_000);

      if (this.#exitResult === null) {
        this.#signalDriver("SIGKILL", true);
        await this.#waitForChildExit(5_000);
      }
    }

    await this.#server.stop(true);
    this.#throwProtocolError("packed driver disposal");
  }

  async waitUntilReady(timeoutMs: number): Promise<void> {
    await this.#waitFor(() => (this.#ready ? true : undefined), "driver ready", timeoutMs);
  }

  async #launch(options: DriverArtifactTestControllerOptions): Promise<void> {
    const payloadPath = join(options.rootPath, `${this.#bootPayload.driverInstanceId}.json`);
    const controlUrl = `http://${this.#server.hostname}:${this.#server.port}/driver-control`;
    await writeFile(payloadPath, `${JSON.stringify({ ...this.#bootPayload, controlUrl })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const child = spawn(process.execPath, [options.artifactPath], {
      cwd: options.organizationPath,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...options.env,
        MOSOO_DRIVER_BOOT_PAYLOAD_FILE: payloadPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#child = child;
    this.#exitPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (exit: DriverExit) => {
        if (settled) {
          return;
        }

        settled = true;
        this.#exitResult = exit;
        resolve(exit);
      };

      child.once("error", (error) => finish({ code: null, error: error.message, signal: null }));
      child.once("close", (code, signal) => finish({ code, signal }));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.#stdout = this.#appendOutput(
        this.#stdout,
        chunk.toString("utf8"),
        this.#stdoutSecretScanner,
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr = this.#appendOutput(
        this.#stderr,
        chunk.toString("utf8"),
        this.#stderrSecretScanner,
      );
    });
  }

  #appendOutput(current: string, chunk: string, scanner: ForbiddenSecretScanner): string {
    if (scanner.scan(chunk)) {
      this.#recordForbiddenSecret();
    }
    return this.#redact(`${current}${chunk}`).slice(-OUTPUT_LIMIT);
  }

  async #handleMessage(
    socket: Bun.ServerWebSocket<undefined>,
    message: string | Buffer,
  ): Promise<void> {
    let requestId: number | string | null = null;

    try {
      const rawMessage = message.toString();
      if (this.#containsForbiddenSecret(rawMessage)) {
        this.#recordForbiddenSecret();
        throw new Error(FORBIDDEN_SECRET_ERROR);
      }

      const request = readRpcRequest(message);

      if (request === null) {
        return;
      }

      requestId = request.id;

      if (request.path === "/driver/heartbeat" && this.#heartbeatsFail) {
        const heartbeat = parseDriverHeartbeatInput(request.input);
        this.#assertDriverPid(heartbeat.pid);
        socket.send(
          JSON.stringify({
            i: request.id,
            p: { b: { json: { message: "live heartbeat failure" } }, s: 500 },
          }),
        );
        return;
      }

      const output = await this.#handleRpc(request.path, request.input);
      socket.send(JSON.stringify({ i: request.id, p: { b: { json: output } } }));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.#protocolError ??= messageText;

      if (requestId !== null) {
        try {
          socket.send(
            JSON.stringify({
              i: requestId,
              p: { b: { json: { message: messageText } }, s: 500 },
            }),
          );
        } catch {
          // The request already failed; a closed test socket cannot accept its error response.
        }
      }
    }
  }

  async #handleRpc(path: string, input: Record<string, unknown>): Promise<unknown> {
    switch (path) {
      case "/driver/hello": {
        const hello = parseDriverHelloInput(input);
        this.#assertDriverPid(hello.pid);
        if (hello.runtime !== this.#runtimeId) {
          throw new Error(`Driver hello used unexpected runtime ${hello.runtime}.`);
        }
        if (
          this.#expectedCapabilities !== undefined &&
          JSON.stringify(
            hello.capabilities.toSorted((left, right) => left.id.localeCompare(right.id)),
          ) !==
            JSON.stringify(
              this.#expectedCapabilities.toSorted((left, right) => left.id.localeCompare(right.id)),
            )
        ) {
          throw new Error("Driver hello capabilities did not match the expected runtime contract.");
        }
        if (this.#hello) {
          throw new Error("Driver emitted more than one hello request.");
        }
        this.#hello = true;
        return {
          acceptedCapabilities: hello.capabilities,
          connectionId: "artifact-test-connection",
          driverInstanceId: this.#bootPayload.driverInstanceId,
          heartbeatIntervalMs: this.#heartbeatIntervalMs,
          runConfig: {
            commandLeaseMs: 300_000,
            envPolicy: "strict",
            eventBatchMaxSize: 64,
            organizationPath: this.#organizationPath,
          },
          runId: null,
        };
      }
      case "/driver/ready": {
        const ready = parseDriverReadyInput(input);
        this.#assertDriverInstanceId(ready.driverInstanceId);
        this.#assertDriverPid(ready.pid);
        if (!this.#hello) {
          throw new Error("Driver emitted ready before hello.");
        }
        if (this.#ready) {
          throw new Error("Driver emitted more than one ready request.");
        }
        this.#ready = true;
        return { ok: true };
      }
      case "/driver/heartbeat": {
        const heartbeat = parseDriverHeartbeatInput(input);
        this.#assertDriverPid(heartbeat.pid);
        return { heartbeatCount: 1, ok: true };
      }
      case "/driver/pushEvents": {
        const batch = parseDriverEventBatchInput(input);
        this.#assertDriverInstanceId(batch.driverInstanceId);

        const ingressWaits = new Set<Promise<void>>();
        const accepted = batch.events.map((envelope) => {
          const existing = this.#eventReceipts.get(envelope.eventId);

          if (existing !== undefined) {
            if (existing.receipt.type !== envelope.event.kind) {
              throw new Error(`Driver reused event ID ${envelope.eventId} with a changed type.`);
            }
            return existing.receipt;
          }

          const { event } = envelope;
          if (event.driverInstanceId !== this.#bootPayload.driverInstanceId) {
            throw new Error(
              `Driver event ${event.kind} used unexpected driver instance ${String(event.driverInstanceId)}.`,
            );
          }
          if (event.sessionId !== this.#sessionId) {
            throw new Error(
              `Driver event ${event.kind} used unexpected session ${event.sessionId}.`,
            );
          }
          if (event.runtimeId !== this.#runtimeId) {
            throw new Error(
              `Driver event ${event.kind} used unexpected runtime ${String(event.runtimeId)}.`,
            );
          }
          if (event.runId !== undefined && !this.#knownRunIds.has(event.runId)) {
            throw new Error(`Driver event ${event.kind} used unknown run ${event.runId}.`);
          }
          if (event.runId !== undefined && this.#terminalRunIds.has(event.runId)) {
            throw new Error(
              `Driver emitted ${event.kind} after the terminal event for run ${event.runId}.`,
            );
          }
          this.#events.push(envelope.event);
          for (const observer of this.#eventIngressObservers) {
            observer(envelope.event);
          }
          for (const gate of this.#eventIngressGates) {
            if (!gate.entered && gate.predicate(envelope.event)) {
              gate.entered = true;
              gate.enter(envelope.event);
              ingressWaits.add(gate.released);
            }
          }
          if (
            event.runId !== undefined &&
            (event.kind === "run.cancelled" ||
              event.kind === "run.completed" ||
              event.kind === "run.failed")
          ) {
            this.#terminalRunIds.add(event.runId);
          }
          this.#nextEventSeq += 1;
          const receipt = {
            eventId: envelope.eventId,
            seq: this.#nextEventSeq,
            type: envelope.event.kind,
          };
          this.#eventReceipts.set(envelope.eventId, { receipt });
          return receipt;
        });
        await Promise.all(ingressWaits);
        return { accepted };
      }
      case "/driver/pushLogs": {
        const batch = parseDriverLogBatchInput(input);
        this.#assertDriverInstanceId(batch.driverInstanceId);
        this.#logs.push(...batch.logs);
        return { ok: true };
      }
      case "/driver/commandUpdate": {
        const update = parseDriverCommandUpdateInput(input);
        this.#assertDriverInstanceId(update.driverInstanceId);
        this.#commandUpdates.push(
          update.status === "failed"
            ? {
                commandId: update.commandId,
                error: update.error,
                status: update.status,
              }
            : update.status === "completed"
              ? {
                  commandId: update.commandId,
                  ...(update.result === undefined ? {} : { result: update.result }),
                  status: update.status,
                }
              : { commandId: update.commandId, status: update.status },
        );
        return { ok: true };
      }
      case "/driver/observeExternalToolEffect": {
        const { commandId, driverInstanceId } = parseDriverExternalToolEffectObserveInput(input);
        this.#assertDriverInstanceId(driverInstanceId);
        const effect =
          this.#externalToolEffects.get(commandId) ??
          ({ effectId: `artifact-test-effect-${commandId}`, kind: "intent" } as const);
        this.#externalToolEffects.set(commandId, effect);
        return toExternalToolEffectState(effect);
      }
      case "/driver/claimExternalToolEffect": {
        const { claimToken, commandId, driverInstanceId } =
          parseDriverExternalToolEffectClaimInput(input);
        this.#assertDriverInstanceId(driverInstanceId);
        const effectId = `artifact-test-effect-${commandId}`;
        const effect =
          this.#externalToolEffects.get(commandId) ?? ({ effectId, kind: "intent" } as const);

        if (effect.kind === "succeeded" || effect.kind === "unknown") {
          return toExternalToolEffectState(effect);
        }
        if (effect.kind === "claimed") {
          if (effect.claimToken === claimToken) {
            return toExternalToolEffectState(effect);
          }
          const unknown = { effectId, kind: "unknown" } as const;
          this.#externalToolEffects.set(commandId, unknown);
          return unknown;
        }

        const claimed = {
          attempt: 1,
          claimToken,
          effectId,
          idempotencyKey: effectId,
          kind: "claimed",
        } as const;
        this.#externalToolEffects.set(commandId, claimed);
        return toExternalToolEffectState(claimed);
      }
      case "/driver/settleExternalToolEffect": {
        const { claimToken, commandId, driverInstanceId, effectId, settlement } =
          parseDriverExternalToolEffectSettleInput(input);
        this.#assertDriverInstanceId(driverInstanceId);
        const current =
          this.#externalToolEffects.get(commandId) ?? ({ effectId, kind: "intent" } as const);

        if (current.effectId !== effectId) {
          throw new Error(`External tool effect ${commandId} used a mismatched effect ID.`);
        }
        if (current.kind === "succeeded" || current.kind === "unknown") {
          return toExternalToolEffectState(current);
        }
        if (current.kind === "intent") {
          this.#externalToolEffects.set(commandId, current);
          return current;
        }
        if (current.claimToken !== claimToken) {
          const unknown = { effectId, kind: "unknown" } as const;
          this.#externalToolEffects.set(commandId, unknown);
          return unknown;
        }

        const terminal: ArtifactExternalToolEffect =
          settlement.kind === "succeeded"
            ? { effectId, kind: "succeeded", result: structuredClone(settlement.result) }
            : { effectId, kind: "unknown" };
        this.#externalToolEffects.set(commandId, terminal);
        return toExternalToolEffectState(terminal);
      }
      case "/driver/completeRun": {
        const completion = parseDriverCompletionInput(input);
        this.#assertDriverInstanceId(completion.driverInstanceId);
        if (!this.#knownRunIds.has(completion.runId)) {
          throw new Error(`Driver completed unknown run ${completion.runId}.`);
        }
        if (this.#runTerminals.length > 0) {
          throw new Error("Driver emitted more than one control-plane run terminal.");
        }
        const terminal = { runId: completion.runId, status: "completed" } as const;
        this.#runTerminals.push(terminal);
        for (const observer of this.#runTerminalIngressObservers) {
          observer(terminal);
        }
        return { ok: true };
      }
      case "/driver/failRun": {
        const failure = parseDriverFailureInput(input);
        this.#assertDriverInstanceId(failure.driverInstanceId);
        if (!this.#knownRunIds.has(failure.runId)) {
          throw new Error(`Driver failed unknown run ${failure.runId}.`);
        }
        if (this.#runTerminals.length > 0) {
          throw new Error("Driver emitted more than one control-plane run terminal.");
        }
        const terminal = { error: failure.error, runId: failure.runId, status: "failed" } as const;
        this.#runTerminals.push(terminal);
        for (const observer of this.#runTerminalIngressObservers) {
          observer(terminal);
        }
        return { ok: true };
      }
      case "/driverInstance/nextCommand": {
        const request = parseDriverNextCommandInput(input);
        this.#assertDriverInstanceId(request.driverInstanceId);
        return { command: this.#commands.shift() ?? null };
      }
      default: {
        throw new Error(`Unsupported driver RPC path: ${path}.`);
      }
    }
  }

  #assertDriverInstanceId(driverInstanceId: string): void {
    if (driverInstanceId !== this.#bootPayload.driverInstanceId) {
      throw new Error(`Driver RPC used unexpected driver instance ${driverInstanceId}.`);
    }
  }

  #assertDriverPid(pid: number): void {
    if (pid !== this.#child?.pid) {
      throw new Error(`Driver RPC used unexpected process id ${pid}.`);
    }
  }

  #containsForbiddenSecret(value: string): boolean {
    return this.#forbiddenSecrets.some((secret) => value.includes(secret));
  }

  #recordForbiddenSecret(): void {
    this.#forbiddenSecretDetected = true;
    this.#protocolError ??= FORBIDDEN_SECRET_ERROR;
  }

  #redact(value: string): string {
    let redacted = value;
    for (const secret of this.#forbiddenSecrets.toSorted(
      (left, right) => right.length - left.length,
    )) {
      redacted = redacted.replaceAll(secret, "[redacted]");
    }
    return redacted;
  }

  async #waitFor<T>(probe: () => T | undefined, label: string, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      this.#throwProtocolError(label);
      const value = probe();

      if (value !== undefined) {
        return value;
      }
      if (this.#exitResult !== null) {
        throw new Error(
          `Packed driver exited while waiting for ${label}: ${JSON.stringify(this.#exitResult)}.\n${this.diagnostics()}`,
        );
      }

      await Bun.sleep(50);
    }

    throw new Error(`Timed out waiting for ${label}.\n${this.diagnostics()}`);
  }

  #throwProtocolError(label: string): void {
    if (this.#protocolError !== null) {
      throw new Error(
        `Driver protocol failed while waiting for ${label}: ${this.#protocolError}.\n${this.diagnostics()}`,
      );
    }
  }

  async #waitForChildExit(timeoutMs: number): Promise<void> {
    if (this.#exitResult !== null || this.#exitPromise === null) {
      return;
    }
    await Promise.race([this.#exitPromise, timeoutAfter(timeoutMs)]);
  }

  async #waitForSocketDrain(deadline: number): Promise<void> {
    while (true) {
      this.#throwProtocolError("packed driver control socket drain");
      if (this.#socket === null) {
        await Bun.sleep(0);
        if (this.#socket === null) {
          return;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for packed driver control socket drain.\n${this.diagnostics()}`,
        );
      }
      await Bun.sleep(Math.min(10, deadline - Date.now()));
    }
  }

  waitForRunTerminal(
    timeoutMs: number,
    fromIndex = 0,
  ): Promise<{ error?: unknown; runId: string; status: "completed" | "failed" }> {
    return this.#waitFor(
      () => this.#runTerminals.slice(fromIndex).at(-1),
      "control-plane run terminal",
      timeoutMs,
    );
  }
}
