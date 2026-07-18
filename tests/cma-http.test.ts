import { describe, expect, test } from "bun:test";

import { createDriverId, isDriverId } from "../src/protocol/id";
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
    schemaVersion: "2026-05-26",
    sessionId,
    visibility: "participant",
  });
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
  test.each([
    ["agent", "/v1/agents", { name: "Reviewer" }],
    ["environment", "/v1/environments", { name: "Main" }],
    ["session", "/v1/sessions", {}],
  ] as const)(
    "generates a ULID when creating %s without an explicit ID",
    async (_kind, path, body) => {
      const store = createCmaMemoryStore();
      const handler = createCmaHttpHandler({
        dispatchDriverCommand: async () => undefined,
        store,
      });
      const response = await handler(jsonRequest(path, "POST", body));
      const data = (await readJson(response))["data"] as Record<string, unknown>;

      expect(response.status).toBe(201);
      expect(isDriverId(data["id"])).toBe(true);
    },
  );

  test("requires the Managed Agents beta header by default", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });

    const response = await handler(new Request("https://driver.test/v1/environments"));

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "CMA_BETA_HEADER_REQUIRED",
        header: CMA_DEFAULT_BETA_HEADER_NAME,
      },
    });
  });

  test("runs configurable authorization before routing", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      authorize: ({ request }) =>
        request.headers.get("authorization") === "Bearer token"
          ? undefined
          : new Response(
              JSON.stringify({
                error: {
                  code: "UNAUTHORIZED",
                },
              }),
              { status: 401 },
            ),
      dispatchDriverCommand: async () => undefined,
      store,
    });

    const rejected = await handler(cmaRequest("/v1/environments"));
    expect(rejected.status).toBe(401);

    const accepted = await handler(
      cmaRequest("/v1/environments", {
        headers: {
          authorization: "Bearer token",
        },
      }),
    );
    expect(accepted.status).toBe(200);
  });

  test("maps malformed percent-encoded paths to a request error", async () => {
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store: createCmaMemoryStore(),
    });

    const response = await handler(cmaRequest("/v1/agents/%"));

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      error: { code: "CMA_INVALID_PATH" },
    });
  });

  test.each([
    [0, 201],
    [1, 413],
  ] as const)("bounds JSON request bodies at max bytes + %d", async (extraBytes, status) => {
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store: createCmaMemoryStore(),
    });
    const emptyBody = JSON.stringify({ name: "" });
    const body = JSON.stringify({
      name: "x".repeat(CMA_MAX_EVENT_BYTES - emptyBody.length + extraBytes),
    });
    const response = await handler(
      new Request("https://driver.test/v1/agents", {
        body,
        headers: {
          [CMA_DEFAULT_BETA_HEADER_NAME]: CMA_DEFAULT_BETA_HEADER_VALUE,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );

    expect(new TextEncoder().encode(body)).toHaveLength(CMA_MAX_EVENT_BYTES + extraBytes);
    expect(response.status).toBe(status);

    if (status === 413) {
      expect(await readJson(response)).toMatchObject({
        error: { code: "CMA_REQUEST_BODY_TOO_LARGE" },
      });
    }
  });

  test("cancels an oversized streaming request body", async () => {
    let canceled = false;
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store: createCmaMemoryStore(),
    });
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(CMA_MAX_EVENT_BYTES + 1));
      },
    });
    const response = await handler(
      new Request("https://driver.test/v1/agents", {
        body,
        headers: {
          [CMA_DEFAULT_BETA_HEADER_NAME]: CMA_DEFAULT_BETA_HEADER_VALUE,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(413);
    expect(canceled).toBe(true);
  });

  test("rejects an inbound event whose admitted record exceeds the wire limit", async () => {
    let dispatches = 0;
    const store = createCmaMemoryStore({ sessions: [{ id: "session-1" }] });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => {
        dispatches += 1;
      },
      store,
    });
    const response = await handler(
      jsonRequest("/v1/sessions/session-1/events", "POST", {
        commandId: "command-1",
        requestId: "request-1",
        runId: "run-1",
        text: "界" + "x".repeat(Math.floor(CMA_MAX_EVENT_BYTES * 0.6)),
        type: "user.message",
      }),
    );

    expect(response.status).toBe(413);
    expect(await readJson(response)).toMatchObject({ error: { code: "CMA_RESOURCE_LIMIT" } });
    expect(dispatches).toBe(0);
    expect(await store.listSessionEvents("session-1")).toEqual([]);
  });

  test("does not persist an oversized settlement result", async () => {
    const store = createCmaMemoryStore({ sessions: [{ id: "session-1" }] });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => ({
        outputText: "x".repeat(8 * CMA_MAX_EVENT_BYTES),
        requestId: "request-1",
        serverId: "server-1",
        toolName: "tool-1",
      }),
      store,
    });
    const response = await handler(
      jsonRequest("/v1/sessions/session-1/events", "POST", {
        argumentsJson: "{}",
        commandId: "command-1",
        requestId: "request-1",
        serverId: "server-1",
        toolName: "tool-1",
        type: "user.custom_tool_result",
      }),
    );

    expect(response.status).toBe(413);
    expect(await readJson(response)).toMatchObject({ error: { code: "CMA_RESOURCE_LIMIT" } });
    expect(await store.listSessionEvents("session-1")).toMatchObject([
      { commandStatus: "accepted" },
    ]);
  });

  test("creates, lists, retrieves, archives, and deletes environments", async () => {
    const store = createCmaMemoryStore({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });

    const created = await handler(
      jsonRequest("/v1/environments", "POST", {
        config: {
          networking: {
            allow_mcp_servers: true,
            allow_package_managers: true,
            allowed_hosts: ["https://api.example.com"],
            type: "limited",
          },
          packages: {
            npm: ["express@4.18.0"],
            pip: ["pandas==2.2.0"],
          },
          type: "cloud",
        },
        id: "environment-1",
        metadata: {
          tier: "dev",
        },
        name: "Main",
      }),
    );
    expect(created.status).toBe(201);
    expect(await readJson(created)).toMatchObject({
      data: {
        archivedAt: null,
        config: {
          networking: {
            allow_mcp_servers: true,
            allow_package_managers: true,
            allowed_hosts: ["https://api.example.com"],
            type: "limited",
          },
          packages: {
            npm: ["express@4.18.0"],
            pip: ["pandas==2.2.0"],
          },
          type: "cloud",
        },
        id: "environment-1",
        metadata: {
          tier: "dev",
        },
        name: "Main",
      },
    });

    const listed = await handler(cmaRequest("/v1/environments"));
    expect(await readJson(listed)).toMatchObject({
      data: [
        {
          id: "environment-1",
        },
      ],
    });

    const archived = await handler(
      cmaRequest("/v1/environments/environment-1/archive", {
        method: "POST",
      }),
    );
    expect(await readJson(archived)).toMatchObject({
      data: {
        archivedAt: "2026-01-01T00:00:00.000Z",
        id: "environment-1",
      },
    });

    const deleted = await handler(
      cmaRequest("/v1/environments/environment-1", {
        method: "DELETE",
      }),
    );
    expect(deleted.status).toBe(204);

    const missing = await handler(cmaRequest("/v1/environments/environment-1"));
    expect(missing.status).toBe(404);
  });

  test("defaults environment config to cloud unrestricted networking", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });

    const created = await handler(
      jsonRequest("/v1/environments", "POST", {
        id: "environment-1",
        name: "Main",
      }),
    );

    expect(created.status).toBe(201);
    expect(await readJson(created)).toMatchObject({
      data: {
        config: {
          networking: {
            type: "unrestricted",
          },
          packages: {},
          type: "cloud",
        },
      },
    });
  });

  test("reports unsupported environment config as capability gaps", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });

    const response = await handler(
      jsonRequest("/v1/environments", "POST", {
        config: {
          type: "self_hosted",
        },
        id: "environment-1",
        name: "Main",
      }),
    );

    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "CMA_CAPABILITY_GAP",
        feature: "environment.config.self_hosted",
      },
    });
  });

  test("rejects unsupported environment config fields and invalid allowed hosts", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });

    const unsupported = await handler(
      jsonRequest("/v1/environments", "POST", {
        config: {
          runtime: "test",
          type: "cloud",
        },
        id: "environment-1",
        name: "Main",
      }),
    );
    expect(unsupported.status).toBe(400);
    expect(await readJson(unsupported)).toMatchObject({
      error: {
        code: "CMA_UNSUPPORTED_FIELD",
        field: "config.runtime",
      },
    });

    for (const [index, host] of [
      "api.example.com",
      "https://",
      "https://user:pass@example.com",
      "https://example.com/path",
    ].entries()) {
      const invalidHost = await handler(
        jsonRequest("/v1/environments", "POST", {
          config: {
            networking: {
              allowed_hosts: [host],
              type: "limited",
            },
            type: "cloud",
          },
          id: `environment-${index + 2}`,
          name: "Main",
        }),
      );
      expect(invalidHost.status).toBe(400);
      expect(await readJson(invalidHost)).toMatchObject({
        error: {
          code: "CMA_INVALID_FIELD",
        },
      });
    }
  });

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

  test("reclaims an accepted command after its worker lease expires", async () => {
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
    expect(dispatches).toBe(1);
    expect(await readJson(response)).toMatchObject({
      data: {
        event: {
          commandStatus: "completed",
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
