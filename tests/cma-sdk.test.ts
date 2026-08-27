import { describe, expect, test } from "bun:test";

import { createDriverId } from "../src/protocol/id";
import { parseRuntimeEventEnvelope } from "../src/runtime-events";
import { CMA_MAX_EVENT_BYTES, encodeCmaSseRecord } from "../src/stores/cma-store";
import { createCmaMemoryStore } from "../src/stores/memory";
import {
  CMA_DEFAULT_BETA_HEADER_NAME,
  CMA_DEFAULT_BETA_HEADER_VALUE,
  createCmaHttpHandler,
} from "../src/surfaces/cma-http";
import type { CmaSdkError } from "../src/surfaces/cma-sdk";
import { createCmaSdkClient } from "../src/surfaces/cma-sdk";
import { promiseWithTimeout } from "../src/utils/async";

describe("CMA SDK client", () => {
  test("sends the default beta header and decodes JSON data responses", async () => {
    const seenBetaHeaders: string[] = [];
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seenBetaHeaders.push(request.headers.get(CMA_DEFAULT_BETA_HEADER_NAME) ?? "");
        return handler(request);
      },
    });

    const environment = await client.createEnvironment({
      id: "environment-1",
      name: "Main",
    });

    expect(environment).toMatchObject({
      id: "environment-1",
      name: "Main",
    });
    expect(seenBetaHeaders).toEqual([CMA_DEFAULT_BETA_HEADER_VALUE]);
  });

  test("throws typed errors for failed requests", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async (input, init) => handler(new Request(input, init)),
    });

    await expect(client.getEnvironment("missing")).rejects.toMatchObject({
      code: "CMA_ENVIRONMENT_NOT_FOUND",
      status: 404,
    } satisfies Partial<CmaSdkError>);
  });

  test.each(["client", "request"] as const)(
    "propagates %s cancellation through fetch",
    async (scope) => {
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const reason = new Error(`${scope} cancelled`);
      let fetchSignal: AbortSignal | undefined;
      const client = createCmaSdkClient({
        baseUrl: "https://driver.test",
        fetch: async (_input, init) => {
          fetchSignal = init?.signal ?? undefined;
          entered.resolve();
          return new Promise<Response>(() => {});
        },
        ...(scope === "client" ? { signal: controller.signal } : {}),
      });
      const pending = client.listAgents(
        scope === "request" ? { signal: controller.signal } : undefined,
      );
      await entered.promise;

      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
      expect(fetchSignal?.aborted).toBe(true);
    },
  );

  test("times out an unresponsive fetch", async () => {
    let fetchSignal: AbortSignal | undefined;
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async (_input, init) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
      timeoutMs: 0,
    });

    await expect(
      promiseWithTimeout(client.listAgents(), {
        label: "CMA SDK timeout",
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchSignal?.aborted).toBe(true);
  });

  test("bounds and cancels JSON response bodies", async () => {
    let canceled = false;
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":["too large"]}'));
            },
          }),
        ),
      maxResponseBytes: 8,
    });

    await expect(client.listAgents()).rejects.toMatchObject({
      code: "CMA_SDK_RESPONSE_TOO_LARGE",
    });
    expect(canceled).toBe(true);
  });

  test("streams server-sent session event replay through fetch", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({
      sessions: [
        {
          id: sessionId,
        },
      ],
    });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async (input, init) => handler(new Request(input, init)),
    });
    await store.appendDriverEvent(
      sessionId,
      parseRuntimeEventEnvelope({
        actor: "driver",
        delivery: "lossless",
        id: createDriverId(),
        kind: "message.completed",
        occurredAt: "2026-01-01T00:00:01.000Z",
        origin: "driver",
        payload: {
          content: "hello",
          messageId: "message-1",
        },
        schemaVersion: "2026-05-26",
        sessionId,
        visibility: "participant",
      }),
    );

    const events = [];

    for await (const event of client.streamSessionEvents(sessionId)) {
      events.push(event);
      break;
    }

    expect(events).toMatchObject([
      {
        direction: "outbound",
        event: {
          sourceEventKind: "message.completed",
          type: "agent.message",
        },
      },
    ]);
  });

  test("resumes a server-sent event stream after a delivery cursor", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async (input, init) => handler(new Request(input, init)),
    });
    const [first] = await store.appendDriverEvent(
      sessionId,
      parseRuntimeEventEnvelope({
        actor: "driver",
        delivery: "lossless",
        id: createDriverId(),
        kind: "message.completed",
        occurredAt: "2026-01-01T00:00:01.000Z",
        origin: "driver",
        payload: { messageId: "message-1" },
        schemaVersion: "2026-05-26",
        sessionId,
        visibility: "participant",
      }),
    );
    const [second] = await store.appendDriverEvent(
      sessionId,
      parseRuntimeEventEnvelope({
        actor: "driver",
        delivery: "lossless",
        id: createDriverId(),
        kind: "message.completed",
        occurredAt: "2026-01-01T00:00:02.000Z",
        origin: "driver",
        payload: { messageId: "message-2" },
        schemaVersion: "2026-05-26",
        sessionId,
        visibility: "participant",
      }),
    );
    const resumed = [];

    for await (const event of client.streamSessionEvents(
      sessionId,
      first ? { afterCursor: first.cursor } : {},
    )) {
      resumed.push(event);
      break;
    }

    expect(resumed).toEqual([second]);
  });

  test.each(
    ["\r\n", "\r", "\n"].flatMap((lineEnding) =>
      ["\r\n", "\r", "\n"]
        .filter((blankLineEnding) => lineEnding !== "\r" || blankLineEnding !== "\n")
        .map((blankLineEnding) => [lineEnding, blankLineEnding] as const),
    ),
  )("parses %j/%j-delimited server-sent events", async (lineEnding, blankLineEnding) => {
    const record = (id: string) => ({
      command: null,
      commandResult: null,
      commandStatus: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      cursor: createDriverId(),
      direction: "outbound",
      event: {
        message: { content: id },
        sourceEventKind: "message.completed",
        type: "agent.message",
      },
      id,
      sessionId: "session-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const frames = [record("event-1"), record("event-2")]
      .map((event) => `data: ${JSON.stringify(event)}${lineEnding}${blankLineEnding}`)
      .join("");
    const bytes = new TextEncoder().encode(frames);
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) {
                controller.enqueue(Uint8Array.of(byte));
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const ids: string[] = [];

    for await (const event of client.streamSessionEvents("session-1")) {
      ids.push(event.id);
    }

    expect(ids).toEqual(["event-1", "event-2"]);
  });

  test.each([
    [0, true],
    [1, false],
  ] as const)(
    "counts a split CRLF delimiter in the UTF-8 frame limit + %d",
    async (extraBytes, accepted) => {
      const record = (content: string) => ({
        command: null,
        commandResult: null,
        commandStatus: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        cursor: createDriverId(),
        direction: "outbound",
        event: {
          message: { content },
          sourceEventKind: "message.completed",
          type: "agent.message",
        },
        id: "event-1",
        sessionId: "session-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const encoder = new TextEncoder();
      const emptyFrame = `data: ${JSON.stringify(record(""))}\n\r\n`;
      const contentBytes = CMA_MAX_EVENT_BYTES + extraBytes - encoder.encode(emptyFrame).byteLength;
      const frame = `data: ${JSON.stringify(record(`界${"x".repeat(contentBytes - 3)}`))}\n\r\n`;
      const bytes = encoder.encode(frame);
      const client = createCmaSdkClient({
        baseUrl: "https://driver.test",
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.subarray(0, bytes.length - 1));
                controller.enqueue(bytes.subarray(bytes.length - 1));
                controller.close();
              },
            }),
          ),
      });
      const stream = client.streamSessionEvents("session-1")[Symbol.asyncIterator]();

      expect(bytes).toHaveLength(CMA_MAX_EVENT_BYTES + extraBytes);

      if (accepted) {
        await expect(stream.next()).resolves.toMatchObject({
          done: false,
          value: { id: "event-1" },
        });
      } else {
        await expect(stream.next()).rejects.toMatchObject({ code: "CMA_SDK_FRAME_TOO_LARGE" });
      }
    },
  );

  test("streams a complete store-to-SDK SSE frame at the UTF-8 byte limit", async () => {
    const sessionId = createDriverId();
    const options = {
      idFactory: () => "event-1",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sessions: [{ id: sessionId }],
    } as const;
    const source = (content: string) =>
      parseRuntimeEventEnvelope({
        actor: "driver",
        delivery: "lossless",
        id: createDriverId(),
        kind: "message.completed",
        occurredAt: "2026-01-01T00:00:01.000Z",
        origin: "driver",
        payload: { content, messageId: "message-1" },
        schemaVersion: "2026-05-26",
        sessionId,
        visibility: "participant",
      });
    const measure = createCmaMemoryStore(options);
    const [base] = await measure.appendDriverEvent(sessionId, source(""));

    if (!base) {
      throw new Error("Expected a projected event.");
    }

    const contentBytes = CMA_MAX_EVENT_BYTES - encodeCmaSseRecord(base).byteLength;
    const store = createCmaMemoryStore(options);
    const [record] = await store.appendDriverEvent(
      sessionId,
      source(`界${"x".repeat(contentBytes - 3)}`),
    );
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async (input, init) => handler(new Request(input, init)),
    });
    const events = [];

    for await (const event of client.streamSessionEvents(sessionId)) {
      events.push(event);
      break;
    }

    expect(record && encodeCmaSseRecord(record)).toHaveLength(CMA_MAX_EVENT_BYTES);
    expect(events).toEqual([record]);
  });

  test("rejects and cancels an unterminated oversized SSE frame", async () => {
    let canceled = false;
    let sent = false;
    const bytes = new Uint8Array(CMA_MAX_EVENT_BYTES + 1).fill("x".charCodeAt(0));
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async () =>
        new Response(
          new ReadableStream(
            {
              cancel() {
                canceled = true;
              },
              pull(controller) {
                if (sent) {
                  controller.error(new Error("SSE source was read past its frame limit."));
                  return;
                }

                sent = true;
                controller.enqueue(bytes);
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    });
    const stream = client.streamSessionEvents("session-1")[Symbol.asyncIterator]();

    await expect(stream.next()).rejects.toMatchObject({ code: "CMA_SDK_FRAME_TOO_LARGE" });
    expect(canceled).toBe(true);
  });

  test("return interrupts a pending SSE read and waits for cleanup", async () => {
    const cleanup = Promise.withResolvers<void>();
    const readEntered = Promise.withResolvers<void>();
    let fetchSignal: AbortSignal | undefined;
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async (_input, init) => {
        fetchSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream(
            {
              cancel() {
                cleanup.resolve();
              },
              pull() {
                readEntered.resolve();
              },
            },
            { highWaterMark: 0 },
          ),
        );
      },
    });
    const iterator = client.streamSessionEvents("session-1")[Symbol.asyncIterator]();
    const pending = iterator.next();
    await readEntered.promise;

    const returned = iterator.return?.();

    if (!returned) {
      throw new Error("Expected the CMA stream iterator to support return().");
    }

    await expect(
      promiseWithTimeout(pending, { label: "pending CMA stream read", timeoutMs: 100 }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      promiseWithTimeout(returned, { label: "CMA stream return", timeoutMs: 100 }),
    ).resolves.toMatchObject({ done: true });
    await promiseWithTimeout(cleanup.promise, { label: "CMA stream cleanup", timeoutMs: 100 });
    expect(fetchSignal?.aborted).toBe(true);
  });
});
