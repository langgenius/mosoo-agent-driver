import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DriverArtifactTestEvent {
  readonly kind: string;
  readonly payload: unknown;
  readonly runId?: string;
  readonly [key: string]: unknown;
}

export interface DriverArtifactTestCommandUpdate {
  readonly commandId: string;
  readonly error?: unknown;
  readonly result?: unknown;
  readonly status: string;
}

export interface DriverArtifactTestCommand {
  readonly commandId: string;
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface DriverArtifactBootPayload extends Record<string, unknown> {
  readonly bootToken: string;
  readonly driverInstanceId: string;
}

interface DriverArtifactTestControllerOptions {
  readonly artifactPath: string;
  readonly bootPayload: DriverArtifactBootPayload;
  readonly env?: NodeJS.ProcessEnv;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly organizationPath: string;
  readonly rootPath: string;
  readonly secret: string;
  readonly startTimeoutMs: number;
}

interface DriverExit {
  readonly code: number | null;
  readonly error?: string;
  readonly signal: NodeJS.Signals | null;
}

interface RpcRequest {
  readonly id: number | string;
  readonly input: Record<string, unknown>;
  readonly path: string;
}

const TERMINAL_COMMAND_STATUSES = new Set(["cancelled", "completed", "failed"]);
const OUTPUT_LIMIT = 24_000;

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

export class DriverArtifactTestController {
  readonly #bootPayload: DriverArtifactBootPayload;
  readonly #commands: DriverArtifactTestCommand[] = [];
  readonly #commandUpdates: DriverArtifactTestCommandUpdate[] = [];
  readonly #events: DriverArtifactTestEvent[] = [];
  readonly #heartbeatIntervalMs: number;
  readonly #logs: Record<string, unknown>[] = [];
  readonly #organizationPath: string;
  readonly #runTerminals: { error?: unknown; status: "completed" | "failed" }[] = [];
  readonly #secret: string;
  readonly #server: Bun.Server<undefined>;
  #child: ChildProcess | null = null;
  #exitPromise: Promise<DriverExit> | null = null;
  #exitResult: DriverExit | null = null;
  #heartbeatsFail = false;
  #nextEventSeq = 0;
  #protocolError: string | null = null;
  #ready = false;
  #stderr = "";
  #stdout = "";
  #socket: Bun.ServerWebSocket<undefined> | null = null;

  private constructor(options: DriverArtifactTestControllerOptions) {
    this.#bootPayload = structuredClone(options.bootPayload);
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
    this.#organizationPath = options.organizationPath;
    this.#secret = options.secret;

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
        message: (socket, message) => this.#handleMessage(socket, message),
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
      await controller.dispose();
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

  enqueue(command: DriverArtifactTestCommand): void {
    this.#commands.push(structuredClone(command));
  }

  disconnectDriver(): void {
    if (this.#socket === null) {
      throw new Error("Packed driver control socket is not connected.");
    }

    this.#socket.close(1011, "live.control.disconnected");
  }

  failHeartbeats(): void {
    this.#heartbeatsFail = true;
  }

  crashDriver(): void {
    this.#signalDriver("SIGKILL", true);
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
    this.enqueue({ commandId, kind: "session.stop", reason: "live.test.completed" });
    const [update, terminal] = await Promise.all([
      this.waitForCommandTerminal(commandId, timeoutMs),
      this.waitForRunTerminal(timeoutMs),
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
    if (this.#exitResult !== null) {
      return this.#exitResult;
    }
    if (this.#exitPromise === null) {
      throw new Error("Packed driver has not started.");
    }

    const result = await Promise.race([this.#exitPromise, timeoutAfter(timeoutMs)]);

    if (result === "timeout") {
      throw new Error(`Timed out waiting for packed driver exit.\n${this.diagnostics()}`);
    }

    return result;
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
        logs: this.#logs.slice(-12).map((entry) => ({
          level: entry["level"] ?? null,
          message: entry["message"] ?? null,
        })),
        protocolError: this.#protocolError,
        ready: this.#ready,
        stderr: this.#stderr,
        stdout: this.#stdout,
      },
      null,
      2,
    );

    return this.#secret.length === 0
      ? diagnostics
      : diagnostics.replaceAll(this.#secret, "[redacted]");
  }

  async dispose(): Promise<void> {
    const child = this.#child;

    if (child !== null && this.#exitResult === null) {
      child.kill("SIGTERM");
      await this.waitForExit(5_000).catch(() => undefined);

      if (this.#exitResult === null) {
        this.#signalDriver("SIGKILL", true);
        await this.waitForExit(5_000).catch(() => undefined);
      }
    }

    await this.#server.stop(true);
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
      child.once("exit", (code, signal) => finish({ code, signal }));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.#stdout = this.#appendOutput(this.#stdout, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr = this.#appendOutput(this.#stderr, chunk.toString("utf8"));
    });
  }

  #appendOutput(current: string, chunk: string): string {
    const redacted =
      this.#secret.length === 0 ? chunk : chunk.replaceAll(this.#secret, "[redacted]");
    return `${current}${redacted}`.slice(-OUTPUT_LIMIT);
  }

  #handleMessage(socket: Bun.ServerWebSocket<undefined>, message: string | Buffer): void {
    let requestId: number | string | null = null;

    try {
      const request = readRpcRequest(message);

      if (request === null) {
        return;
      }

      requestId = request.id;

      if (request.path === "/driver/heartbeat" && this.#heartbeatsFail) {
        socket.send(
          JSON.stringify({
            i: request.id,
            p: { b: { json: { message: "live heartbeat failure" } }, s: 500 },
          }),
        );
        return;
      }

      const output = this.#handleRpc(request.path, request.input);
      socket.send(JSON.stringify({ i: request.id, p: { b: { json: output } } }));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.#protocolError = messageText;

      if (requestId !== null) {
        socket.send(
          JSON.stringify({
            i: requestId,
            p: { b: { json: { message: messageText } }, s: 500 },
          }),
        );
      }
    }
  }

  #handleRpc(path: string, input: Record<string, unknown>): unknown {
    switch (path) {
      case "/driver/hello": {
        const capabilities = Array.isArray(input["capabilities"]) ? input["capabilities"] : [];
        return {
          acceptedCapabilities: capabilities,
          connectionId: "artifact-test-connection",
          driverInstanceId: this.#bootPayload.driverInstanceId,
          heartbeatIntervalMs: this.#heartbeatIntervalMs,
          runConfig: {
            commandLeaseMs: 300_000,
            envPolicy: "strict",
            eventBatchMaxSize: 256,
            organizationPath: this.#organizationPath,
          },
          runId: null,
        };
      }
      case "/driver/ready": {
        this.#ready = true;
        return { ok: true };
      }
      case "/driver/heartbeat": {
        return { heartbeatCount: 1, ok: true };
      }
      case "/driver/pushEvents": {
        const envelopes = input["events"];

        if (!Array.isArray(envelopes)) {
          throw new TypeError("driver.pushEvents events must be an array.");
        }

        const accepted = envelopes.map((value) => {
          const envelope = readRecord(value, "driver event envelope");
          const event = readRecord(envelope["event"], "driver event");
          const kind = readString(event, "kind", "driver event");
          this.#events.push(event as DriverArtifactTestEvent);
          this.#nextEventSeq += 1;
          return {
            eventId: typeof envelope["eventId"] === "string" ? envelope["eventId"] : undefined,
            seq: this.#nextEventSeq,
            type: kind,
          };
        });
        return { accepted };
      }
      case "/driver/pushLogs": {
        const logs = input["logs"];

        if (!Array.isArray(logs)) {
          throw new TypeError("driver.pushLogs logs must be an array.");
        }

        this.#logs.push(...logs.filter(isRecord));
        return { ok: true };
      }
      case "/driver/commandUpdate": {
        this.#commandUpdates.push({
          commandId: readString(input, "commandId", "driver command update"),
          ...(input["error"] === undefined ? {} : { error: input["error"] }),
          ...(input["result"] === undefined ? {} : { result: input["result"] }),
          status: readString(input, "status", "driver command update"),
        });
        return { ok: true };
      }
      case "/driver/completeRun": {
        this.#runTerminals.push({ status: "completed" });
        return { ok: true };
      }
      case "/driver/failRun": {
        this.#runTerminals.push({ error: input["error"], status: "failed" });
        return { ok: true };
      }
      case "/driverInstance/nextCommand": {
        return { command: this.#commands.shift() ?? null };
      }
      default: {
        throw new Error(`Unsupported driver RPC path: ${path}.`);
      }
    }
  }

  async #waitFor<T>(probe: () => T | undefined, label: string, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const value = probe();

      if (value !== undefined) {
        return value;
      }
      if (this.#protocolError !== null) {
        throw new Error(
          `Driver protocol failed while waiting for ${label}: ${this.#protocolError}.`,
        );
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

  waitForRunTerminal(
    timeoutMs: number,
    fromIndex = 0,
  ): Promise<{ error?: unknown; status: "completed" | "failed" }> {
    return this.#waitFor(
      () => this.#runTerminals.slice(fromIndex).at(-1),
      "control-plane run terminal",
      timeoutMs,
    );
  }
}
