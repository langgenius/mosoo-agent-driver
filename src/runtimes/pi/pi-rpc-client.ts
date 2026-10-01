import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { isJsonObject } from "../../protocol/json";
import type { JsonObject } from "../../protocol/json";
import { raceWithAbort } from "../../utils/async";
import {
  bindSpawnedProcess,
  createProcessTreeEnvironment,
  releaseLinuxProcessMarker,
  signalBoundProcessTree,
  waitForLinuxProcessMarkerExit,
} from "../child-process";
import type { PiLaunchConfiguration } from "./pi-configuration";

export interface PiRpcPort {
  request(type: string, fields?: JsonObject, signal?: AbortSignal): Promise<JsonObject>;
  send(record: JsonObject): Promise<void>;
  stop(): Promise<void>;
}

export class PiRpcClient implements PiRpcPort {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, ReturnType<typeof Promise.withResolvers<JsonObject>>>();
  readonly #exit = Promise.withResolvers<void>();
  readonly #onRecord: (record: JsonObject) => Promise<void>;
  readonly #onFailure: (error: Error) => void;
  readonly #tree;
  readonly #bound;
  #buffer = "";
  #stopped = false;
  #stopTask: Promise<void> | null = null;

  constructor(
    config: PiLaunchConfiguration,
    onRecord: (record: JsonObject) => Promise<void>,
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
    this.#child.on("close", (code) => {
      this.#fail(new Error(`Pi process exited (${code ?? "signal"}).`));
      this.#exit.resolve();
    });
  }

  async request(type: string, fields: JsonObject = {}, signal?: AbortSignal): Promise<JsonObject> {
    if (this.#stopped) throw new Error("Pi RPC process is unavailable.");
    const id = randomUUID();
    const pending = Promise.withResolvers<JsonObject>();
    void pending.promise.catch(() => {});
    this.#pending.set(id, pending);
    try {
      await this.send({ ...fields, type, id });
      return await raceWithAbort(pending.promise, signal ?? AbortSignal.timeout(30_000));
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
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer) > 16 * 1024 * 1024) {
      this.#fail(new Error("Pi RPC frame exceeds the transport limit."));
      return;
    }
    // Split strictly on LF: U+2028 and U+2029 are valid JSON string content.
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line === "") continue;
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
          void this.#onRecord(record).catch((error: unknown) =>
            this.#fail(error instanceof Error ? error : new Error("Pi event handling failed.")),
          );
        }
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error("Invalid Pi RPC frame."));
      }
    }
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (!this.#stopped) {
      this.#stopped = true;
      this.#onFailure(error);
    }
  }

  stop(): Promise<void> {
    this.#stopTask ??= this.#stop();
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
    } finally {
      clearTimeout(timer);
      releaseLinuxProcessMarker(this.#tree.marker);
    }
  }
}
