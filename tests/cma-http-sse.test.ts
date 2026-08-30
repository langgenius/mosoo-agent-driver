import { describe, expect, test } from "bun:test";

import { createDriverId } from "../src/protocol/id";
import { parseRuntimeEventEnvelope } from "../src/runtime-events";
import type { CmaSessionEventRecord } from "../src/stores/cma-store";
import { createCmaMemoryStore } from "../src/stores/memory";
import {
  CMA_DEFAULT_BETA_HEADER_NAME,
  CMA_DEFAULT_BETA_HEADER_VALUE,
  createCmaHttpHandler,
} from "../src/surfaces/cma-http";

function cmaRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set(CMA_DEFAULT_BETA_HEADER_NAME, CMA_DEFAULT_BETA_HEADER_VALUE);

  return new Request(`https://driver.test${path}`, {
    ...init,
    headers,
  });
}

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`https://driver.test${path}`, {
    body: JSON.stringify(body),
    headers: {
      [CMA_DEFAULT_BETA_HEADER_NAME]: CMA_DEFAULT_BETA_HEADER_VALUE,
      "content-type": "application/json",
    },
    method,
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function runFailedEvent(sessionId: string, recoverable = false) {
  return parseRuntimeEventEnvelope({
    actor: "driver",
    delivery: "lossless",
    id: createDriverId(),
    kind: "run.failed",
    occurredAt: "2026-01-01T00:00:01.000Z",
    origin: "driver",
    payload: {
      error: {
        code: "driver.failed",
        details: {},
        message: "failed",
        retryable: recoverable,
      },
      recoverable,
    },
    runId: createDriverId(),
    schemaVersion: "2026-08-29",
    sessionId,
    visibility: "participant",
  });
}

describe("CMA HTTP surface", () => {
  test("claims a command before dispatch and reuses its result for concurrent retries", async () => {
    const dispatchEntered = Promise.withResolvers<void>();
    const releaseDispatch = Promise.withResolvers<void>();
    let dispatches = 0;
    const store = createCmaMemoryStore({ sessions: [{ id: "session-1" }] });
    const events = store.streamSessionEvents("session-1")[Symbol.asyncIterator]();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => {
        dispatches += 1;
        dispatchEntered.resolve();
        await releaseDispatch.promise;
        return { requestId: "request-1" };
      },
      store,
    });
    const request = () =>
      jsonRequest("/v1/sessions/session-1/events", "POST", {
        commandId: "command-1",
        type: "user.interrupt",
      });

    const firstResponse = handler(request());
    await dispatchEntered.promise;
    const acceptedEvent = (await events.next()).value;
    const concurrentRetry = await handler(request());

    expect(concurrentRetry.status).toBe(202);
    expect(dispatches).toBe(1);
    expect(await readJson(concurrentRetry)).toMatchObject({
      data: {
        event: { commandStatus: "accepted", id: acceptedEvent.id },
        result: null,
      },
    });

    releaseDispatch.resolve();
    const completed = await firstResponse;
    const settledEvent = (await events.next()).value;
    const retry = await handler(request());

    expect(settledEvent).toMatchObject({
      commandStatus: "completed",
      id: acceptedEvent.id,
    });
    expect(await readJson(completed)).toMatchObject({
      data: {
        event: { commandStatus: "completed" },
        result: { requestId: "request-1" },
      },
    });
    expect(await readJson(retry)).toMatchObject({
      data: {
        event: { commandStatus: "completed" },
        result: { requestId: "request-1" },
      },
    });
    expect(dispatches).toBe(1);

    const changed = await handler(
      jsonRequest("/v1/sessions/session-1/events", "POST", {
        commandId: "command-1",
        reason: "changed",
        type: "user.interrupt",
      }),
    );
    expect(changed.status).toBe(409);
    await events.return?.();
  });

  test("does not redispatch an accepted command after its worker lease expires", async () => {
    let now = new Date();
    let dispatches = 0;
    const store = createCmaMemoryStore({
      now: () => now,
      sessions: [{ id: "session-1" }],
    });
    const input = {
      command: { commandId: "command-1", kind: "turn.cancel" } as const,
      event: { commandId: "command-1", type: "user.interrupt" } as const,
      sessionId: "session-1",
    };
    const abandoned = await store.claimInboundEvent(input);
    now = new Date(now.getTime() + 31_000);
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => {
        dispatches += 1;
      },
      store,
    });
    const response = await handler(
      jsonRequest("/v1/sessions/session-1/events", "POST", input.event),
    );

    expect(response.status).toBe(202);
    expect(dispatches).toBe(0);
    expect(await readJson(response)).toMatchObject({
      data: {
        event: {
          commandStatus: "accepted",
          id: abandoned.event.id,
        },
      },
    });
  });

  test("passes request cancellation to dispatch and never redispatches an ambiguous failure", async () => {
    const dispatchEntered = Promise.withResolvers<void>();
    let dispatches = 0;
    let receivedSignal: AbortSignal | undefined;
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async ({ signal }) => {
        dispatches += 1;
        receivedSignal = signal;
        dispatchEntered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      store: createCmaMemoryStore({ sessions: [{ id: "session-1" }] }),
    });
    const controller = new AbortController();
    const request = new Request("https://driver.test/v1/sessions/session-1/events", {
      body: JSON.stringify({ commandId: "command-1", type: "user.interrupt" }),
      headers: {
        [CMA_DEFAULT_BETA_HEADER_NAME]: CMA_DEFAULT_BETA_HEADER_VALUE,
        "content-type": "application/json",
      },
      method: "POST",
      signal: controller.signal,
    });

    const responsePromise = handler(request);
    await dispatchEntered.promise;
    controller.abort(new Error("client disconnected"));
    const response = await responsePromise;

    expect(receivedSignal).not.toBe(request.signal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await readJson(response))).not.toContain("client disconnected");

    const retry = await handler(
      jsonRequest("/v1/sessions/session-1/events", "POST", {
        commandId: "command-1",
        type: "user.interrupt",
      }),
    );
    expect(retry.status).toBe(502);
    expect(dispatches).toBe(1);
  });

  test("commits a fulfilled dispatch even when the request aborts before settlement", async () => {
    const controller = new AbortController();
    let dispatches = 0;
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => {
        dispatches += 1;
        controller.abort(new Error("client disconnected"));
      },
      store: createCmaMemoryStore({ sessions: [{ id: "session-1" }] }),
    });
    const event = { commandId: "command-1", type: "user.interrupt" };
    const request = new Request("https://driver.test/v1/sessions/session-1/events", {
      body: JSON.stringify(event),
      headers: {
        [CMA_DEFAULT_BETA_HEADER_NAME]: CMA_DEFAULT_BETA_HEADER_VALUE,
        "content-type": "application/json",
      },
      method: "POST",
      signal: controller.signal,
    });

    const response = await handler(request);
    expect(response.status).toBe(202);
    expect(await readJson(response)).toMatchObject({
      data: { event: { commandStatus: "completed" } },
    });

    const retry = await handler(jsonRequest("/v1/sessions/session-1/events", "POST", event));
    expect(retry.status).toBe(202);
    expect(dispatches).toBe(1);
  });

  test("joins concurrent SSE encode-error and cancel cleanup", async () => {
    const cleanupEntered = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const message: Record<string, unknown> = {};
    message["self"] = message;
    const record = {
      command: null,
      commandResult: null,
      commandStatus: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      cursor: createDriverId(),
      direction: "outbound",
      event: {
        message,
        sourceEventKind: "message.completed",
        type: "agent.message",
      },
      id: "event-1",
      sessionId: "session-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies CmaSessionEventRecord;
    let returns = 0;
    const baseStore = createCmaMemoryStore({ sessions: [{ id: "session-1" }] });
    const events: AsyncIterable<CmaSessionEventRecord> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: record } as const;
          },
          async return() {
            returns += 1;
            cleanupEntered.resolve();
            await releaseCleanup.promise;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const store = new Proxy(baseStore, {
      get(target, property) {
        if (property === "streamSessionEvents") {
          return () => events;
        }

        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    const response = await handler(
      cmaRequest("/v1/sessions/session-1/events", {
        headers: { accept: "text/event-stream" },
      }),
    );
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error("Expected SSE response body.");
    }

    const read = reader.read().then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await cleanupEntered.promise;
    const cancelled = reader.cancel();
    let settled = false;
    void cancelled.then(() => {
      settled = true;
    });
    await Bun.sleep(0);
    expect(returns).toBe(1);
    expect(settled).toBe(false);

    releaseCleanup.resolve();
    await cancelled;
    const outcome = await read;
    expect("result" in outcome ? outcome.result.value : undefined).toBeUndefined();
    expect(returns).toBe(1);
  });

  test.each(
    ["normal", "cancel", "error"].flatMap((outcome) =>
      [false, true].map((returnRejects) => [outcome, returnRejects] as const),
    ),
  )(
    "cleans an SSE iterator once after %s with return rejects=%s",
    async (outcome, returnRejects) => {
      const nextEntered = Promise.withResolvers<void>();
      let returns = 0;
      const baseStore = createCmaMemoryStore({ sessions: [{ id: "session-1" }] });
      const events: AsyncIterable<never> = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<never>> {
              if (outcome === "normal") {
                return { done: true, value: undefined };
              }

              if (outcome === "error") {
                throw new Error("stream failed");
              }

              nextEntered.resolve();
              return new Promise(() => {});
            },
            async return() {
              returns += 1;

              if (returnRejects) {
                throw new Error("cleanup failed");
              }

              return { done: true, value: undefined };
            },
          };
        },
      };
      const store = new Proxy(baseStore, {
        get(target, property) {
          if (property === "streamSessionEvents") {
            return () => events;
          }

          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const handler = createCmaHttpHandler({
        dispatchDriverCommand: async () => undefined,
        store,
      });
      const response = await handler(
        cmaRequest("/v1/sessions/session-1/events", {
          headers: { accept: "text/event-stream" },
        }),
      );
      const reader = response.body?.getReader();

      if (!reader) {
        throw new Error("Expected SSE response body.");
      }

      if (outcome === "normal") {
        const read = expect(reader.read());

        if (returnRejects) {
          await read.rejects.toThrow("cleanup failed");
        } else {
          await read.resolves.toEqual({ done: true, value: undefined });
        }
      } else if (outcome === "error") {
        await expect(reader.read()).rejects.toThrow("stream failed");
      } else {
        const read = reader.read();
        await nextEntered.promise;

        if (returnRejects) {
          await expect(reader.cancel()).rejects.toThrow("cleanup failed");
        } else {
          await expect(reader.cancel()).resolves.toBeUndefined();
        }

        await expect(read).resolves.toEqual({ done: true, value: undefined });
      }

      expect(returns).toBe(1);
    },
  );

  test("updates terminal session state, closes SSE, and rejects new commands", async () => {
    const sessionId = createDriverId();
    let dispatches = 0;
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => {
        dispatches += 1;
      },
      store,
    });
    const response = await handler(
      cmaRequest(`/v1/sessions/${sessionId}/events`, {
        headers: { accept: "text/event-stream" },
      }),
    );
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error("Expected SSE response body.");
    }

    await store.appendDriverEvent(sessionId, runFailedEvent(sessionId));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"terminated"');
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(await store.getSession(sessionId)).toMatchObject({ status: "terminated" });

    const rejected = await handler(
      jsonRequest(`/v1/sessions/${sessionId}/events`, "POST", {
        commandId: "command-1",
        type: "user.interrupt",
      }),
    );
    expect(rejected.status).toBe(409);
    expect(dispatches).toBe(0);
  });

  test("does not expose internal dispatch failures", async () => {
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => {
        throw new Error("secret upstream token");
      },
      store: createCmaMemoryStore({ sessions: [{ id: "session-1" }] }),
    });
    const response = await handler(
      jsonRequest("/v1/sessions/session-1/events", "POST", {
        commandId: "command-1",
        type: "user.interrupt",
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).not.toContain("secret upstream token");
  });
});
