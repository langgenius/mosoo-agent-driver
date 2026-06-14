import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { projectCmaInboundToDriverCommand, projectDriverEventToCma } from "../src/projections/cma";
import type { DriverEventInput } from "../src/protocol/events";
import { createCmaMemoryStore } from "../src/stores/memory";
import {
  CMA_DEFAULT_BETA_HEADER_NAME,
  CMA_DEFAULT_BETA_HEADER_VALUE,
  createCmaHttpHandler,
} from "../src/surfaces/cma-http";

function readJsonFixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://driver.test${path}`, {
    body: JSON.stringify(body),
    headers: {
      [CMA_DEFAULT_BETA_HEADER_NAME]: CMA_DEFAULT_BETA_HEADER_VALUE,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("CMA golden fixtures", () => {
  test("app inbound user.message fixture to runtime command fixture", () => {
    expect(
      projectCmaInboundToDriverCommand(readJsonFixture("./fixtures/cma/inbound/user-message.json")),
    ).toEqual(readJsonFixture("./fixtures/cma/commands/input-start.json"));
  });

  test("app permission request fixture to requires_action outbound fixture", () => {
    expect(
      projectDriverEventToCma(
        readJsonFixture(
          "./fixtures/cma/driver-events/permission-requested.json",
        ) as DriverEventInput,
      ),
    ).toEqual(readJsonFixture("./fixtures/cma/outbound/permission-requires-action.json"));
  });

  test("create Environment v0 fixture response stays stable", async () => {
    const store = createCmaMemoryStore({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    const response = await handler(
      jsonRequest(
        "/v1/environments",
        readJsonFixture("./fixtures/cma/http/create-environment-limited-request.json"),
      ),
    );

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual(
      readJsonFixture("./fixtures/cma/http/create-environment-limited-response.json"),
    );
  });

  test("unsupported Environment config fixture returns capability gap", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    const response = await handler(
      jsonRequest(
        "/v1/environments",
        readJsonFixture("./fixtures/cma/http/create-environment-self-hosted-request.json"),
      ),
    );

    expect(response.status).toBe(422);
    expect(await readJson(response)).toEqual(
      readJsonFixture("./fixtures/cma/http/create-environment-self-hosted-error.json"),
    );
  });
});
