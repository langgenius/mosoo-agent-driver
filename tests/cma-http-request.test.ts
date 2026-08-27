import { describe, expect, test } from "bun:test";

import { isDriverId } from "../src/protocol/id";
import { CMA_MAX_EVENT_BYTES } from "../src/stores/cma-store";
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
    let dispatches = 0;
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = createCmaMemoryStore({
      now: () => now,
      sessions: [{ id: "session-1" }],
    });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => {
        dispatches += 1;
        return {
          outputText: "x".repeat(8 * CMA_MAX_EVENT_BYTES),
          requestId: "request-1",
          serverId: "server-1",
          toolName: "tool-1",
        };
      },
      store,
    });
    const event = {
      argumentsJson: "{}",
      commandId: "command-1",
      requestId: "request-1",
      serverId: "server-1",
      toolCallId: "tool-call-1",
      toolName: "tool-1",
      type: "user.custom_tool_result",
    };
    const response = await handler(jsonRequest("/v1/sessions/session-1/events", "POST", event));

    expect(response.status).toBe(413);
    expect(await readJson(response)).toMatchObject({ error: { code: "CMA_RESOURCE_LIMIT" } });
    expect(await store.listSessionEvents("session-1")).toMatchObject([{ commandStatus: "failed" }]);

    now = new Date(now.getTime() + 31_000);
    const retry = await handler(jsonRequest("/v1/sessions/session-1/events", "POST", event));
    expect(retry.status).toBe(502);
    expect(dispatches).toBe(1);
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
});
