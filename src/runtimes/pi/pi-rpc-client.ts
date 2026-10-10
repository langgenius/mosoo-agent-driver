import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { isJsonObject } from "../../protocol/json";
import type { JsonObject } from "../../protocol/json";
import { raceWithAbort } from "../../utils/async";
import {
  bindSpawnedProcess,
  createProcessTreeEnvironment,
  hasBoundProcessRootExited,
  releaseLinuxProcessMarker,
  signalBoundProcessTree,
  spawnLinuxProcessTreeWatchdog,
  waitForLinuxProcessMarkerExit,
} from "../child-process";
import type { PiLaunchConfiguration } from "./pi-configuration";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface PiRpcPort {
  request(type: string, fields?: JsonObject, signal?: AbortSignal): Promise<JsonObject>;
  send(record: JsonObject): Promise<void>;
  stop(): Promise<void>;
}

export class PiRpcClient implements PiRpcPort {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, ReturnType<typeof Promise.withResolvers<JsonObject>>>();
  readonly #exit = Promise.withResolvers<void>();
  readonly #onRecord: (record: JsonObject, bytes: number) => Promise<void>;
  readonly #onFailure: (error: Error) => void;
  readonly #tree;
  readonly #bound;
  readonly #watchdog;
  #buffer = "";
  #stopped = false;
  #stopTask: Promise<void> | null = null;

  constructor(
    config: PiLaunchConfiguration,
    onRecord: (record: JsonObject, bytes: number) => Promise<void>,
    onFailure: (error: Error) => void,
  ) {
    this.#onRecord = onRecord;
    this.#onFailure = onFailure;
    this.#tree = createProcessTreeEnvironment(config.env);
    this.#child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: this.#tree.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.#bound = bindSpawnedProcess(this.#child, process.platform, this.#tree);
    this.#watchdog =
      this.#child.pid === undefined
        ? null
        : spawnLinuxProcessTreeWatchdog(this.#child.pid, this.#tree.marker);
    if (this.#watchdog !== null) {
      void this.#watchdog.cleanup.then(
        () => {
          if (!hasBoundProcessRootExited(this.#bound)) {
            this.#fail(
              new Error("Pi process-tree supervision ended while the process was running."),
            );
          }
        },
        (error: unknown) => {
          signalBoundProcessTree(this.#bound, this.#tree.marker, "SIGKILL");
          this.#fail(new Error("Pi process-tree supervision failed.", { cause: error }));
        },
      );
    }
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#read(chunk));
    // Drain diagnostics without copying provider credentials or request bodies
    // into platform logs.
    this.#child.stderr.resume();
    this.#child.stdin.on("error", (error) => this.#fail(error));
    this.#child.on("error", (error) => {
      this.#fail(error);
      this.#exit.resolve();
    });
    this.#child.on("exit", (code) => {
      this.#fail(new Error(`Pi process exited (${code ?? "signal"}).`));
      this.#exit.resolve();
    });
    this.#child.on("close", (code) => {
      this.#fail(new Error(`Pi process exited (${code ?? "signal"}).`));
      this.#exit.resolve();
    });
  }

  async request(type: string, fields: JsonObject = {}, signal?: AbortSignal): Promise<JsonObject> {
    signal?.throwIfAborted();
    if (this.#stopped) throw new Error("Pi RPC process is unavailable.");
    if (process.platform === "linux" && this.#watchdog === null) {
      throw new Error("Pi process supervision could not start.");
    }
    const id = randomUUID();
    const pending = Promise.withResolvers<JsonObject>();
    void pending.promise.catch(() => {});
    this.#pending.set(id, pending);
    try {
      return await raceWithAbort(
        this.send({ ...fields, type, id }).then(() => pending.promise),
        signal ?? AbortSignal.timeout(30_000),
      );
    } finally {
      this.#pending.delete(id);
    }
  }

  async send(record: JsonObject): Promise<void> {
    if (this.#stopped) throw new Error("Pi RPC process is unavailable.");
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  #read(chunk: string): void {
    if (this.#stopped) return;
    this.#buffer += chunk;
    // Split strictly on LF: U+2028 and U+2029 are valid JSON string content.
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      if (this.#stopped) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const bytes = Buffer.byteLength(line);
      if (bytes > MAX_FRAME_BYTES) {
        this.#fail(new Error("Pi RPC frame exceeds the transport limit."));
        return;
      }
      if (line.trim() === "") continue;
      try {
        const record: unknown = JSON.parse(line);
        if (!isJsonObject(record) || typeof record["type"] !== "string")
          throw new Error("Invalid Pi RPC record.");
        if (record["type"] === "response") {
          const id = record["id"];
          const pending = typeof id === "string" ? this.#pending.get(id) : undefined;
          if (pending !== undefined) {
            if (record["success"] === true)
              pending.resolve(isJsonObject(record["data"]) ? record["data"] : {});
            else
              pending.reject(
                new Error(
                  typeof record["error"] === "string" ? record["error"] : "Pi RPC command failed.",
                ),
              );
          }
        } else {
          void this.#onRecord(record, bytes).catch((error: unknown) =>
            this.#fail(error instanceof Error ? error : new Error("Pi event handling failed.")),
          );
        }
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error("Invalid Pi RPC frame."));
        return;
      }
    }
    if (Buffer.byteLength(this.#buffer) > MAX_FRAME_BYTES) {
      this.#fail(new Error("Pi RPC frame exceeds the transport limit."));
    }
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (!this.#stopped) {
      this.#stopped = true;
      this.#buffer = "";
      this.#onFailure(error);
      // The backend also joins this cleanup and can retry a failed attempt.
      void this.stop().catch(() => {});
    }
  }

  stop(): Promise<void> {
    this.#stopTask ??= this.#stop().catch((error: unknown) => {
      this.#stopTask = null;
      throw error;
    });
    return this.#stopTask;
  }

  async #stop(): Promise<void> {
    this.#stopped = true;
    for (const pending of this.#pending.values()) pending.reject(new Error("Pi stopped."));
    this.#pending.clear();
    this.#child.stdin.end();
    const timer = setTimeout(
      () => signalBoundProcessTree(this.#bound, this.#tree.marker, "SIGKILL"),
      1500,
    );
    try {
      await raceWithAbort(this.#exit.promise, AbortSignal.timeout(10_000));
      signalBoundProcessTree(this.#bound, this.#tree.marker, "SIGKILL");
      await waitForLinuxProcessMarkerExit(this.#tree.marker, 5_000);
      await this.#watchdog?.cleanup;
      releaseLinuxProcessMarker(this.#tree.marker);
    } finally {
      clearTimeout(timer);
    }
  }
}
