import { relative } from "node:path";

import type { AgentDriverBackend, AgentDriverContext } from "../../core/agent-driver-backend";
import { DriverTurnCancelledError } from "../../core/driver-runtime-state";
import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import { isJsonObject } from "../../protocol/json";
import type { JsonObject } from "../../protocol/json";
import type { DriverStartInput } from "../../protocol/start";
import type { RuntimeCommandInput } from "../../runtime-command";
import { raceWithAbort } from "../../utils/async";
import { DriverEventPublisher } from "../driver-event-publisher";
import { writeSkillBootstrapArtifacts } from "../skill-bootstrap";
import { preparePiLaunch, resolvePiSessionPath } from "./pi-configuration";
import { PiEventTranslator } from "./pi-event-translator";
import { PiRpcClient } from "./pi-rpc-client";
import type { PiRpcPort } from "./pi-rpc-client";

interface ActiveTurn {
  readonly controller: AbortController;
  readonly runId: RunId;
  readonly settled: ReturnType<typeof Promise.withResolvers<void>>;
  readonly translator: PiEventTranslator;
  cancelled: string | null;
  cancellation: Promise<void> | null;
  completing: boolean;
  dispatched: boolean;
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
    await raceWithAbort(context.ports.skill.materialize(this.#payload.execution), signal);
    await raceWithAbort(writeSkillBootstrapArtifacts(this.#payload.execution), signal);
    const config = await raceWithAbort(this.#dependencies.prepare(this.#payload), signal);
    signal.throwIfAborted();
    if (this.#stopped) throw new Error("Pi stopped during startup.");
    this.#home = config.home;
    this.#client = this.#dependencies.createClient(
      config,
      (record) => this.#receive(context, record),
      (error) => {
        this.#failure = error;
        if (this.#turn !== null) this.#turn.settled.reject(error);
        else if (!this.#stopped) context.lifecycle.fail(error);
      },
    );
    try {
      const state = await this.#client.request("get_state", {}, signal);
      const model = state["model"];
      const prefix = `${this.#payload.execution.provider}/`;
      const expectedModel = this.#payload.execution.model.startsWith(prefix)
        ? this.#payload.execution.model.slice(prefix.length)
        : this.#payload.execution.model;
      if (!isJsonObject(model) || model["provider"] !== "mosoo" || model["id"] !== expectedModel)
        throw new Error(
          "Pi started with a different model than the frozen execution configuration.",
        );
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
      translator: new PiEventTranslator(),
      cancelled: null,
      cancellation: null,
      completing: false,
      dispatched: false,
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
    try {
      await this.#push(context, [
        { kind: "run.started", runId, payload: { startedAt: new Date().toISOString() } },
      ]);
      if (signal?.aborted) abort();
      if (turn.cancelled !== null) throw new DriverTurnCancelledError(turn.cancelled);
      turn.dispatched = true;
      const response = await client.request("prompt", { message: input.text }, signal);
      if (response["disposition"] !== "started")
        throw new Error("Pi did not start the admitted prompt.");
      await turn.settled.promise;
      await this.#events;
      await Promise.all(this.#permissionTasks);
      if (turn.cancelled !== null) throw new DriverTurnCancelledError(turn.cancelled);
      if (turn.translator.failure !== null) throw new Error(turn.translator.failure);
      await this.#rememberSession(context, await client.request("get_state"));
      if (turn.cancelled !== null) throw new DriverTurnCancelledError(turn.cancelled);
      turn.completing = true;
      const final = turn.translator.finalMessage;
      await this.#push(context, [
        {
          kind: "run.completed",
          runId,
          payload: {
            ...(final === null ? {} : { finalMessageId: final.id, finalMessageText: final.text }),
            stopReason: "end_turn",
          },
        },
      ]);
    } catch (error) {
      if (turn.cancelled !== null) {
        await turn.cancellation;
        await this.#events;
        await Promise.all(this.#permissionTasks);
        await this.#push(context, [
          {
            kind: "run.cancelled",
            runId,
            payload: { reason: turn.cancelled, requestedBy: "user", stopReason: "cancelled" },
          },
        ]);
        throw new DriverTurnCancelledError(turn.cancelled);
      }
      // Failed admission or event delivery must not leave native work running.
      await client.stop();
      this.#failure = error instanceof Error ? error : new Error("Pi turn failed.");
      await this.#push(context, [
        {
          kind: "run.failed",
          runId,
          payload: {
            error: {
              code: "pi.turn_failed",
              message: error instanceof Error ? error.message : "Pi turn failed.",
            },
            recoverable: false,
          },
        },
      ]);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      turn.controller.abort();
      if (this.#turn === turn) this.#turn = null;
    }
  }

  async cancelActiveTurn(_context: AgentDriverContext, reason: string): Promise<void> {
    const turn = this.#turn;
    if (turn === null || turn.completing) return;
    if (turn.cancellation !== null) return turn.cancellation;
    turn.cancelled = reason;
    turn.controller.abort();
    if (!turn.dispatched) {
      turn.settled.resolve();
      turn.cancellation = Promise.resolve();
      return;
    }
    turn.cancellation = (async () => {
      try {
        const signal = AbortSignal.timeout(5_000);
        await this.#client?.request("abort", {}, signal);
        await raceWithAbort(turn.settled.promise, signal);
      } catch (error) {
        await this.#client?.stop();
        this.#failure = error instanceof Error ? error : new Error("Pi cancellation failed.");
        turn.settled.reject(this.#failure);
      }
    })();
    await turn.cancellation;
  }

  async stop(context: AgentDriverContext, reason: string, signal: AbortSignal): Promise<void> {
    this.#stopped = true;
    await this.cancelActiveTurn(context, reason);
    if (this.#client !== null) await raceWithAbort(this.#client.stop(), signal);
    await Promise.all(this.#permissionTasks);
    await this.#events;
  }

  async #receive(context: AgentDriverContext, record: JsonObject): Promise<void> {
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
      if (this.#turn !== turn) return;
      await this.#push(
        context,
        turn.translator
          .translate(record)
          .map((event) => Object.assign(event, { runId: turn.runId })),
      );
      if (record["type"] === "agent_settled") turn.settled.resolve();
    });
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
    await this.#push(context, [
      { kind: "runtime.resume.updated", payload: { resumePointer: pointer, mode: "pi" } },
    ]);
  }

  #push(context: AgentDriverContext, events: DriverEventInput[]): Promise<void> {
    return this.#publisher.push(context, "driver.pi.events", events);
  }
}
