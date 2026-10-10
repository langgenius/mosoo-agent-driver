import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { AgentDriverBackend, AgentDriverContext } from "../../core/agent-driver-backend";
import {
  DriverTurnCancellationCleanupError,
  DriverTurnCancelledError,
} from "../../core/driver-runtime-state";
import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import { isJsonObject } from "../../protocol/json";
import type { JsonObject } from "../../protocol/json";
import type { DriverStartInput } from "../../protocol/start";
import type { RuntimeCommandInput } from "../../runtime-command";
import { raceWithAbort } from "../../utils/async";
import {
  DriverCompletedTerminalSupersededError,
  DriverEventPublisher,
} from "../driver-event-publisher";
import { writeSkillBootstrapArtifacts } from "../skill-bootstrap";
import { createPiNativeCheckpoint } from "./pi-checkpoint";
import {
  preparePiLaunch,
  readPiModelConfiguration,
  readPiSessionFile,
  resolvePiSessionPath,
} from "./pi-configuration";
import { PiEventTranslator } from "./pi-event-translator";
import { PiRpcClient } from "./pi-rpc-client";
import type { PiRpcPort } from "./pi-rpc-client";
import { readPiSessionHeader } from "./pi-session-validation";

interface ActiveTurn {
  readonly controller: AbortController;
  readonly runId: RunId;
  readonly settled: ReturnType<typeof Promise.withResolvers<void>>;
  readonly done: ReturnType<typeof Promise.withResolvers<void>>;
  readonly translator: PiEventTranslator;
  cancelled: string | null;
  cancellation: Promise<void> | null;
  cancellationPublished: boolean;
  terminal: "completed" | "other" | null;
  admission: Promise<JsonObject> | null;
  nativeMessage: JsonObject | null;
}

export interface PiBackendDependencies {
  readonly prepare: typeof preparePiLaunch;
  readonly createClient: (
    config: Awaited<ReturnType<typeof preparePiLaunch>>,
    onRecord: (record: JsonObject) => Promise<void>,
    onFailure: (error: Error) => void,
  ) => PiRpcPort;
}

export class PiDriverBackend implements AgentDriverBackend {
  readonly runtime = "pi";
  readonly #payload: DriverStartInput;
  readonly #dependencies: PiBackendDependencies;
  readonly #publisher = new DriverEventPublisher(this.runtime, () => this.#pointer);
  #client: PiRpcPort | null = null;
  #home: string | null = null;
  #pointer: string | null = null;
  #turn: ActiveTurn | null = null;
  #events: Promise<void> = Promise.resolve();
  #stopped = false;
  #stopTask: Promise<void> | null = null;
  #failure: Error | null = null;
  #permissionTasks = new Set<Promise<void>>();

  constructor(payload: DriverStartInput, dependencies: Partial<PiBackendDependencies> = {}) {
    this.#payload = payload;
    this.#dependencies = {
      prepare: preparePiLaunch,
      createClient: (config, onRecord, onFailure) => new PiRpcClient(config, onRecord, onFailure),
      ...dependencies,
    };
  }

  async start(context: AgentDriverContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#stopped || this.#client !== null)
      throw new Error("Pi backend has already started or stopped.");
    await this.#publisher.initializeNativeCheckpointRoot(context, signal);
    const skills = await context.ports.skill.materialize(this.#payload.execution, signal);
    await writeSkillBootstrapArtifacts(this.#payload.execution, skills, signal);
    const config = await this.#dependencies.prepare(this.#payload, skills, signal);
    signal.throwIfAborted();
    if (this.#stopped) throw new Error("Pi stopped during startup.");
    this.#home = config.home;
    this.#client = this.#dependencies.createClient(
      config,
      (record) => this.#receive(context, record),
      (error) => {
        this.#failure = error;
        if (this.#turn !== null) {
          this.#turn.controller.abort(error);
          this.#turn.settled.reject(error);
        } else if (!this.#stopped) context.lifecycle.fail(error);
      },
    );
    try {
      const state = await this.#client.request("get_state", {}, signal);
      const model = state["model"];
      const expected = readPiModelConfiguration(this.#payload);
      if (
        !isJsonObject(model) ||
        model["provider"] !== expected.provider ||
        model["id"] !== expected.model
      )
        throw new Error(
          "Pi started with a different model than the frozen execution configuration.",
        );
      if (expected.thinkingLevel !== undefined) {
        const available = await this.#client.request("get_available_thinking_levels", {}, signal);
        if (
          !Array.isArray(available["levels"]) ||
          !available["levels"].includes(expected.thinkingLevel)
        ) {
          throw new Error("Pi thinkingLevel is not supported by the selected model.");
        }
        await this.#client.request("set_thinking_level", { level: expected.thinkingLevel }, signal);
      }
      await this.#rememberSession(context, state);
    } catch (error) {
      await this.#client.stop();
      this.#client = null;
      throw error;
    }
  }

  async handleInput(
    context: AgentDriverContext,
    input: RuntimeCommandInput,
    runId: RunId,
    signal?: AbortSignal,
  ): Promise<void> {
    const client = this.#client;
    if (this.#stopped || this.#failure !== null || client === null || this.#turn !== null)
      throw new Error("Pi is unavailable or already running.");
    const turn: ActiveTurn = {
      controller: new AbortController(),
      runId,
      settled: Promise.withResolvers<void>(),
      done: Promise.withResolvers<void>(),
      translator: new PiEventTranslator(),
      cancelled: null,
      cancellation: null,
      cancellationPublished: false,
      terminal: null,
      admission: null,
      nativeMessage: null,
    };
    // Attach a rejection handler before dispatch: process failure can arrive
    // while the prompt admission request is still pending.
    void turn.settled.promise.catch(() => {});
    this.#turn = turn;
    const abort = () => {
      void this.cancelActiveTurn(context, "input.aborted").catch((error: unknown) =>
        turn.settled.reject(error),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    const startEvent: DriverEventInput = {
      kind: "run.started",
      runId,
      payload: { startedAt: new Date().toISOString() },
    };
    let started = false;
    try {
      await this.#push(context, [startEvent]);
      started = true;
      if (signal?.aborted) abort();
      if (turn.cancelled !== null) throw new DriverTurnCancelledError(turn.cancelled);
      turn.admission = client.request("prompt", { message: input.text });
      const response = await turn.admission;
      if (response["disposition"] !== "started")
        throw new Error("Pi did not start the admitted prompt.");
      await turn.settled.promise;
      await this.#events;
      await Promise.all(this.#permissionTasks);
      if (turn.cancelled !== null) throw new DriverTurnCancelledError(turn.cancelled);
      if (turn.translator.failure !== null) throw new Error(turn.translator.failure);
      await this.#rememberSession(context, await client.request("get_state"));
      if (turn.cancelled !== null) throw new DriverTurnCancelledError(turn.cancelled);
      if (this.#failure !== null) throw this.#failure;
      const checkpoint = await this.#checkpoint(turn);
      if (turn.cancelled !== null) throw new DriverTurnCancelledError(turn.cancelled);
      if (this.#failure !== null) throw this.#failure;
      const final = turn.translator.finalMessage;
      turn.terminal = "completed";
      await this.#publisher.pushTerminal(
        context,
        "driver.pi.completed",
        [],
        {
          kind: "run.completed",
          runId,
          payload: {
            checkpoint,
            ...(final === null || final.text.length === 0 ? {} : { finalMessageId: final.id }),
            stopReason: "end_turn",
          },
        },
        turn.controller.signal,
      );
    } catch (caughtError) {
      let error = caughtError;
      if (turn.terminal !== null) {
        if (
          turn.terminal !== "completed" ||
          (!(error instanceof DriverCompletedTerminalSupersededError) &&
            error !== turn.controller.signal.reason) ||
          turn.cancelled === null
        ) {
          this.#failure =
            error instanceof Error ? error : new Error("Pi terminal delivery failed.");
          await client.stop();
          throw error;
        }
        turn.terminal = null;
      }
      if (turn.cancelled !== null) {
        try {
          const drained = await Promise.allSettled([
            turn.cancellation,
            this.#events,
            ...this.#permissionTasks,
          ]);
          const failed = drained.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
          await this.#publishCancellation(context, turn);
        } catch (cancellationError) {
          error = cancellationError;
          this.#failure =
            cancellationError instanceof Error
              ? cancellationError
              : new Error("Pi cancellation failed.");
        }
        if (this.#failure === null && !(error instanceof DriverTurnCancellationCleanupError)) {
          turn.terminal = "other";
          try {
            await this.#publisher.pushTerminal(
              context,
              "driver.pi.cancelled",
              [...(started ? [] : [startEvent]), ...turn.translator.closeOpenItems(true)],
              {
                kind: "run.cancelled",
                runId,
                payload: { reason: turn.cancelled, requestedBy: "user", stopReason: "cancelled" },
              },
            );
          } catch (terminalError) {
            this.#failure =
              terminalError instanceof Error
                ? terminalError
                : new Error("Pi terminal delivery failed.");
            await client.stop();
            throw terminalError;
          }
          throw new DriverTurnCancelledError(turn.cancelled);
        }
      }
      // Failed admission or event delivery must not leave native work running.
      this.#failure = error instanceof Error ? error : new Error("Pi turn failed.");
      turn.controller.abort(this.#failure);
      try {
        await client.stop();
      } catch (cleanupError) {
        this.#failure = new DriverTurnCancellationCleanupError(
          "Pi failed turn could not stop the native process.",
          cleanupError,
        );
        await Promise.allSettled([this.#events, ...this.#permissionTasks]);
        throw this.#failure;
      }
      await Promise.allSettled([this.#events, ...this.#permissionTasks]);
      turn.terminal = "other";
      await this.#publisher.pushTerminal(
        context,
        "driver.pi.failed",
        [...(started ? [] : [startEvent]), ...turn.translator.closeOpenItems(true)],
        {
          kind: "run.failed",
          runId,
          payload: {
            error: {
              code: "pi.turn_failed",
              message: error instanceof Error ? error.message : "Pi turn failed.",
              retryable: false,
            },
            recoverable: false,
          },
        },
      );
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      turn.controller.abort();
      if (this.#turn === turn) this.#turn = null;
      turn.done.resolve();
    }
  }

  async cancelActiveTurn(context: AgentDriverContext, reason: string): Promise<void> {
    const turn = this.#turn;
    if (turn === null || turn.terminal === "other") return;
    if (turn.cancellation !== null) return;
    turn.cancelled = reason;
    turn.controller.abort(new DriverTurnCancelledError(reason));
    if (turn.terminal === "completed") {
      turn.cancellation = Promise.resolve();
      return;
    }
    const admission = turn.admission;
    if (admission === null) {
      turn.settled.resolve();
      turn.cancellation = this.#publishCancellation(context, turn);
      void turn.cancellation.catch((error: unknown) => turn.settled.reject(error));
      return;
    }
    const cancel = (async () => {
      try {
        const signal = AbortSignal.timeout(5_000);
        // Pi cannot abort a prompt until its asynchronous preflight has admitted it.
        await raceWithAbort(admission, signal);
        await this.#client?.request("abort", {}, signal);
        await raceWithAbort(turn.settled.promise, signal);
      } catch (error) {
        try {
          await this.#client?.stop();
          turn.settled.resolve();
        } catch (cleanupError) {
          this.#failure = new DriverTurnCancellationCleanupError(
            "Pi cancellation could not stop the native process.",
            cleanupError,
          );
          turn.settled.reject(this.#failure);
          throw this.#failure;
        }
        if (!this.#stopped) {
          this.#failure = new DriverTurnCancellationCleanupError(
            "Pi cancellation could not preserve the native session.",
            error,
          );
          throw this.#failure;
        }
      }
    })();
    turn.cancellation = Promise.allSettled([cancel, this.#publishCancellation(context, turn)]).then(
      (results) => {
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      },
    );
    void turn.cancellation.catch((error: unknown) => turn.settled.reject(error));
  }

  stop(context: AgentDriverContext, reason: string, signal: AbortSignal): Promise<void> {
    this.#stopped = true;
    this.#stopTask ??= (async () => {
      const turn = this.#turn;
      const results = await Promise.allSettled([
        this.cancelActiveTurn(context, reason),
        this.#client?.stop(),
      ]);
      if (turn !== null) await turn.done.promise;
      const drains = await Promise.allSettled([
        this.#events,
        ...this.#permissionTasks,
        this.#publisher.finishTerminalCleanup(context),
      ]);
      const failure = [...results, ...drains].find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })().catch((error: unknown) => {
      this.#stopTask = null;
      throw error;
    });
    return raceWithAbort(this.#stopTask, signal);
  }

  async #receive(context: AgentDriverContext, record: JsonObject): Promise<void> {
    if (this.#failure !== null) throw this.#failure;
    if (record["type"] === "extension_ui_request") {
      const task = this.#permission(context, record);
      this.#permissionTasks.add(task);
      try {
        await task;
      } finally {
        this.#permissionTasks.delete(task);
      }
      return;
    }
    const turn = this.#turn;
    if (turn === null) return;
    this.#events = this.#events.then(async () => {
      if (this.#failure !== null) throw this.#failure;
      if (this.#turn !== turn) return;
      await this.#push(
        context,
        turn.translator
          .translate(record)
          .map((event) => Object.assign(event, { runId: turn.runId })),
      );
      if (record["type"] === "message_end" && isJsonObject(record["message"])) {
        if (record["message"]["role"] === "assistant") {
          turn.nativeMessage = structuredClone(record["message"]);
        }
      }
    });
    // Native settlement must not wait for Host receipts; handleInput drains both.
    if (record["type"] === "agent_settled") {
      if (record["aborted"] === true && turn.cancelled === null) {
        turn.settled.reject(new Error("Pi aborted the native turn."));
      } else {
        turn.settled.resolve();
      }
    }
    await this.#events;
  }

  async #permission(context: AgentDriverContext, record: JsonObject): Promise<void> {
    if (typeof record["id"] !== "string") throw new Error("Pi extension request has no identity.");
    if (
      record["method"] !== "confirm" ||
      record["title"] !== "mosoo.tool_permission" ||
      typeof record["message"] !== "string"
    ) {
      await this.#client?.send({
        type: "extension_ui_response",
        id: record["id"],
        cancelled: true,
      });
      return;
    }
    const request: unknown = JSON.parse(record["message"]);
    if (
      !isJsonObject(request) ||
      typeof request["toolCallId"] !== "string" ||
      typeof request["toolName"] !== "string"
    )
      throw new Error("Invalid Pi permission request.");
    const turn = this.#turn;
    let confirmed = false;
    if (turn !== null && turn.cancelled === null) {
      try {
        confirmed =
          (await context.ports.permission.request(
            {
              requestId: record["id"],
              title: request["toolName"],
              toolCallId: request["toolCallId"],
              toolKind: "tool",
              rawInput: JSON.stringify(request["input"] ?? {}),
            },
            turn.controller.signal,
          )) === "allow_once";
      } catch (error) {
        if (!turn.controller.signal.aborted) throw error;
      }
    }
    await this.#client?.send({ type: "extension_ui_response", id: record["id"], confirmed });
  }

  async #rememberSession(context: AgentDriverContext, state: JsonObject): Promise<void> {
    if (typeof state["sessionFile"] !== "string" || this.#home === null)
      throw new Error("Pi did not provide a persistent session file.");
    const pointer = relative(this.#home, state["sessionFile"]).replaceAll("\\", "/");
    resolvePiSessionPath(this.#home, pointer);
    if (
      this.#payload.execution.session.nativeResumeRef !== null &&
      pointer !== this.#payload.execution.session.nativeResumeRef.value
    )
      throw new Error("Pi replaced the restored native session.");
    this.#pointer = pointer;
    const event: DriverEventInput = {
      kind: "runtime.resume.updated",
      payload: { resumePointer: pointer, mode: "pi" },
    };
    if (this.#turn === null) {
      await this.#publisher.pushSession(context, "driver.pi.resume.updated", [event]);
    } else {
      await this.#publisher.push(context, "driver.pi.resume.updated", [
        { ...event, runId: this.#turn.runId },
      ]);
    }
  }

  async #checkpoint(turn: ActiveTurn) {
    if (this.#home === null || this.#pointer === null || turn.nativeMessage === null) {
      throw new Error("Pi completed without a persistent native assistant message.");
    }
    const content = await readPiSessionFile(this.#home, this.#pointer, turn.controller.signal);
    const header = readPiSessionHeader(content);
    const root = await this.#publisher.getNativeCheckpointRoot();
    if ((await realpath(header.cwd)) !== root.path) {
      throw new Error("Pi transcript belongs to another workspace.");
    }
    const lastAssistant = content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line): unknown => JSON.parse(line))
      .findLast(
        (entry) =>
          isJsonObject(entry) &&
          entry["type"] === "message" &&
          isJsonObject(entry["message"]) &&
          entry["message"]["role"] === "assistant",
      );
    if (
      !isJsonObject(lastAssistant) ||
      !isDeepStrictEqual(lastAssistant["message"], turn.nativeMessage)
    ) {
      throw new Error("Pi transcript does not contain the completed native assistant message.");
    }
    return createPiNativeCheckpoint({
      root,
      runId: turn.runId,
      nativeRef: { runtimeId: "pi", kind: "pi_session_path", value: this.#pointer },
      signal: turn.controller.signal,
      home: this.#home,
      content,
    });
  }

  async #publishCancellation(context: AgentDriverContext, turn: ActiveTurn): Promise<void> {
    if (turn.cancellationPublished) return;
    turn.cancellationPublished = true;
    await this.#push(context, [
      {
        kind: "run.cancel.requested",
        runId: turn.runId,
        payload: { reason: turn.cancelled, requestedBy: "user", targetRunId: turn.runId },
      },
    ]);
  }

  #push(context: AgentDriverContext, events: DriverEventInput[]): Promise<void> {
    return this.#publisher.push(context, "driver.pi.events", events);
  }
}
