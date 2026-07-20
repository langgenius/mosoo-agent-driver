import { describe, expect, test } from "bun:test";

import { createDriverId } from "../src/protocol/id";
import { parseRuntimeEventEnvelope } from "../src/runtime-events";
import type { RuntimeCommand } from "../src/runtime-command";
import type { CmaSessionEventRecord } from "../src/stores/cma-store";
import { CMA_MAX_EVENT_BYTES, encodeCmaSseRecord } from "../src/stores/cma-store";
import { createCmaMemoryStore } from "../src/stores/memory";
import type { CmaHttpDriverCommandDispatchInput } from "../src/surfaces/cma-http";
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

async function readSseChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("Expected SSE response body.");
  }

  const chunk = await reader.read();
  await reader.cancel();

  if (chunk.done) {
    throw new Error("Expected SSE response chunk.");
  }

  return new TextDecoder().decode(chunk.value);
}

function messageEvent(
  sessionId: string,
  kind: "message.completed" | "message.delta",
  payload: Record<string, unknown>,
) {
  return parseRuntimeEventEnvelope({
    actor: "driver",
    delivery: kind.endsWith(".delta") ? "best_effort" : "lossless",
    id: createDriverId(),
    kind,
    occurredAt: "2026-01-01T00:00:01.000Z",
    origin: "driver",
    payload,
    schemaVersion: "2026-05-26",
    sessionId,
    visibility: "participant",
  });
}

describe("CMA HTTP surface", () => {
  test("creates sessions and dispatches inbound user events as runtime commands", async () => {
    const dispatched: CmaHttpDriverCommandDispatchInput[] = [];
    const store = createCmaMemoryStore({
      agents: [
        {
          id: "agent-1",
          name: "Support",
        },
      ],
      environments: [
        {
          id: "environment-1",
          name: "Main",
        },
      ],
    });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async (input) => {
        dispatched.push(input);
        return {
          requestId: "request-1",
        };
      },
      store,
    });

    const session = await handler(
      jsonRequest("/v1/sessions", "POST", {
        agentId: "agent-1",
        environmentId: "environment-1",
        id: "session-1",
      }),
    );
    expect(session.status).toBe(201);

    const accepted = await handler(
      jsonRequest("/v1/sessions/session-1/events", "POST", {
        commandId: "command-1",
        requestId: "request-1",
        runId: "run-1",
        text: "hello",
        type: "user.message",
      }),
    );
    expect(accepted.status).toBe(202);

    const command = dispatched[0]?.command;
    expect(command).toEqual({
      commandId: "command-1",
      input: {
        text: "hello",
      },
      kind: "input.start",
      requestId: "request-1",
      runId: "run-1",
    } satisfies RuntimeCommand);
    expect(await readJson(accepted)).toMatchObject({
      data: {
        command: {
          kind: "input.start",
        },
        event: {
          direction: "inbound",
          sessionId: "session-1",
        },
        result: {
          requestId: "request-1",
        },
        status: "accepted",
      },
    });
  });

  test("replays stored session events as JSON and server-sent events", async () => {
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
    await store.appendDriverEvent(
      sessionId,
      messageEvent(sessionId, "message.completed", {
        content: "hello",
        messageId: "message-1",
      }),
    );

    const jsonReplay = await handler(cmaRequest(`/v1/sessions/${sessionId}/events`));
    expect(await readJson(jsonReplay)).toMatchObject({
      data: [
        {
          direction: "outbound",
          event: {
            sourceEventKind: "message.completed",
            type: "agent.message",
          },
          sessionId,
        },
      ],
    });

    const sseReplay = await handler(
      cmaRequest(`/v1/sessions/${sessionId}/events`, {
        headers: {
          accept: "text/event-stream",
        },
      }),
    );
    expect(sseReplay.headers.get("content-type")).toContain("text/event-stream");
    const body = await readSseChunk(sseReplay);
    expect(body).toContain("event: agent.message");
    expect(body).toContain('"sourceEventKind":"message.completed"');
  });

  test.each([
    [0, true],
    [1, false],
  ] as const)(
    "enforces the final SSE frame limit for custom stores at max bytes + %d",
    async (extraBytes, accepted) => {
      const sessionId = createDriverId();
      const baseStore = createCmaMemoryStore({
        idFactory: () => "event-1",
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        sessions: [{ id: sessionId }],
      });
      const [base] = await baseStore.appendDriverEvent(
        sessionId,
        messageEvent(sessionId, "message.completed", {
          content: "",
          messageId: "message-1",
        }),
      );

      if (!base) {
        throw new Error("Expected a projected event.");
      }

      const contentBytes = CMA_MAX_EVENT_BYTES - encodeCmaSseRecord(base).byteLength + extraBytes;
      const record = {
        ...base,
        event: {
          message: {
            content: `界${"x".repeat(contentBytes - 3)}`,
            messageId: "message-1",
          },
          sourceEventKind: "message.completed",
          type: "agent.message",
        },
      } satisfies CmaSessionEventRecord;
      const store = new Proxy(baseStore, {
        get(target, property) {
          if (property === "streamSessionEvents") {
            return () => ({
              async *[Symbol.asyncIterator]() {
                yield record;
              },
            });
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
        cmaRequest(`/v1/sessions/${sessionId}/events`, {
          headers: { accept: "text/event-stream" },
        }),
      );
      const reader = response.body?.getReader();

      if (!reader) {
        throw new Error("Expected SSE response body.");
      }

      if (accepted) {
        const result = await reader.read();
        expect(result.value).toHaveLength(CMA_MAX_EVENT_BYTES);
        await reader.cancel();
      } else {
        await expect(reader.read()).rejects.toThrow("SSE event frame exceeds");
      }
    },
  );

  test("resumes SSE after a delivery cursor and rejects malformed cursors", async () => {
    const sessionId = createDriverId();
    const store = createCmaMemoryStore({ sessions: [{ id: sessionId }] });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    const [first] = await store.appendDriverEvent(
      sessionId,
      messageEvent(sessionId, "message.completed", {
        content: "first",
        messageId: "message-1",
      }),
    );
    await store.appendDriverEvent(
      sessionId,
      messageEvent(sessionId, "message.completed", {
        content: "second",
        messageId: "message-2",
      }),
    );

    if (!first) {
      throw new Error("Expected a stored event.");
    }

    const resumed = await handler(
      cmaRequest(`/v1/sessions/${sessionId}/events`, {
        headers: {
          accept: "text/event-stream",
          "last-event-id": first.cursor,
        },
      }),
    );
    const body = await readSseChunk(resumed);
    expect(body).toContain('"content":"second"');
    expect(body).not.toContain('"content":"first"');

    const malformed = await handler(
      cmaRequest(`/v1/sessions/${sessionId}/events`, {
        headers: {
          accept: "text/event-stream",
          "last-event-id": "not-a-ulid",
        },
      }),
    );
    expect(malformed.status).toBe(400);
    expect(await readJson(malformed)).toMatchObject({
      error: { code: "CMA_INVALID_LAST_EVENT_ID" },
    });
  });

  test("streams live session events after replay", async () => {
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
    const response = await handler(
      cmaRequest(`/v1/sessions/${sessionId}/events`, {
        headers: {
          accept: "text/event-stream",
        },
      }),
    );
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error("Expected SSE response body.");
    }

    const chunkPromise = reader.read();
    await store.appendDriverEvent(
      sessionId,
      messageEvent(sessionId, "message.delta", {
        contentDelta: "live",
        messageId: "message-1",
      }),
    );

    const chunk = await chunkPromise;
    await reader.cancel();

    if (chunk.done) {
      throw new Error("Expected live SSE response chunk.");
    }

    const body = new TextDecoder().decode(chunk.value);
    expect(body).toContain("event: agent.message");
    expect(body).toContain('"contentDelta":"live"');
  });

  test("rejects unsupported inbound event fields before dispatch", async () => {
    const dispatched: CmaHttpDriverCommandDispatchInput[] = [];
    const store = createCmaMemoryStore({
      sessions: [
        {
          id: "session-1",
        },
      ],
    });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async (input) => {
        dispatched.push(input);
      },
      store,
    });

    const response = await handler(
      jsonRequest("/v1/sessions/session-1/events", "POST", {
        commandId: "command-1",
        metadata: {
          unsupported: true,
        },
        requestId: "request-1",
        runId: "run-1",
        text: "hello",
        type: "user.message",
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "CMA_UNSUPPORTED_FIELD",
        field: "metadata",
      },
    });
    expect(dispatched).toHaveLength(0);
  });

  test.each([
    [{ type: "user.message" }, "commandId"],
    [{ commandId: "command-1", type: "unknown" }, "event type"],
    [
      {
        commandId: "command-1",
        decision: "always",
        requestId: "request-1",
        type: "user.tool_confirmation",
      },
      "decision",
    ],
  ])("maps malformed inbound events to 400 without dispatching", async (body, message) => {
    let dispatched = 0;
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => {
        dispatched += 1;
      },
      store: createCmaMemoryStore({ sessions: [{ id: "session-1" }] }),
    });

    const response = await handler(jsonRequest("/v1/sessions/session-1/events", "POST", body));

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "CMA_INVALID_EVENT",
        message: expect.stringContaining(message),
      },
    });
    expect(dispatched).toBe(0);
  });
});
