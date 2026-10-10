import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "../src/protocol/json";
import { PiRpcClient } from "../src/runtimes/pi/pi-rpc-client";
import { raceWithAbort } from "../src/utils/async";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

async function scriptedClient(
  onRecord: (record: JsonObject) => Promise<void>,
  onFailure: (error: Error) => void,
) {
  const root = await mkdtemp(join(tmpdir(), "mosoo-pi-rpc-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const client = new PiRpcClient(
    {
      command: process.execPath,
      args: [
        "-e",
        `const { createInterface } = require("node:readline");
         require("node:fs").writeFileSync("child.pid", String(process.pid));
         createInterface({ input: process.stdin }).on("line", (line) => {
           const request = JSON.parse(line);
           for (let index = 0; index < (request.count ?? 0); index++) {
             process.stdout.write(JSON.stringify({
               type: request.eventType ?? "message_update", index,
               data: "x".repeat(request.bytes ?? 0)
             }) + "\\n");
           }
           process.stdout.write(JSON.stringify({
             type: "response", id: request.id, success: true, data: { received: request.type }
           }) + "\\n");
         });`,
      ],
      cwd: root,
      home: root,
      env: {},
    },
    onRecord,
    onFailure,
  );
  cleanup.push(() => client.stop());
  return { client, root };
}

test("request cancellation covers a blocked native stdin write", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosoo-pi-rpc-"));
  const client = new PiRpcClient(
    {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      home: root,
      env: {},
    },
    async () => {},
    () => {},
  );
  try {
    let settled = false;
    const signal = AbortSignal.timeout(25);
    const outcome = client
      .request("prompt", { message: "x".repeat(2 * 1024 * 1024) }, signal)
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    await Bun.sleep(150);
    expect(settled).toBe(true);
    expect(await raceWithAbort(outcome, AbortSignal.timeout(500))).toBe(signal.reason);
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test.each([
  { name: "event count", count: 1025, bytes: 0, accepted: 1024 },
  { name: "event bytes", count: 5, bytes: 8 * 1024 * 1024 - 256, accepted: 4 },
  {
    name: "permission count",
    count: 1025,
    bytes: 0,
    accepted: 1024,
    eventType: "extension_ui_request",
  },
])(
  "bounds $name including active handlers and automatically stops the process",
  async (input) => {
    const release = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<Error>();
    let calls = 0;
    let failures = 0;
    const { client, root } = await scriptedClient(
      async () => {
        calls++;
        await release.promise;
      },
      (error) => {
        failures++;
        failure.resolve(error);
      },
    );
    const request = client.request("flood", { ...input }, AbortSignal.timeout(5_000));
    void request.catch(() => {});
    try {
      expect(await raceWithAbort(failure.promise, AbortSignal.timeout(5_000))).toMatchObject({
        message: "Pi RPC event queue limit exceeded.",
      });
      await expect(request).rejects.toThrow("queue limit");
      expect(calls).toBe(input.accepted);
      const pid = Number(await readFile(join(root, "child.pid"), "utf8"));
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await Bun.sleep(20);
      }
      expect(() => process.kill(pid, 0)).toThrow();
      expect(failures).toBe(1);
    } finally {
      release.resolve();
    }
  },
  10_000,
);

test("keeps RPC responses and permissions moving behind a full event backlog", async () => {
  const release = Promise.withResolvers<void>();
  const permission = Promise.withResolvers<void>();
  const failures: Error[] = [];
  let records = 0;
  const { client } = await scriptedClient(
    async (record) => {
      if (record["type"] === "extension_ui_request") {
        await client.send({ type: "extension_ui_response", id: "permission", confirmed: true });
        permission.resolve();
        return;
      }
      records++;
      await release.promise;
    },
    (error) => failures.push(error),
  );
  try {
    await expect(client.request("flood", { count: 1023 })).resolves.toEqual({ received: "flood" });
    await expect(
      client.request("permissions", { count: 1, eventType: "extension_ui_request" }),
    ).resolves.toEqual({ received: "permissions" });
    await raceWithAbort(permission.promise, AbortSignal.timeout(1_000));
    await expect(client.request("abort", {}, AbortSignal.timeout(1_000))).resolves.toEqual({
      received: "abort",
    });
    expect(records).toBe(1023);
    expect(failures).toEqual([]);
    release.resolve();
    await Bun.sleep(0);
    await expect(client.request("next", { count: 1023 })).resolves.toEqual({ received: "next" });
    expect(records).toBe(2046);
    expect(failures).toEqual([]);
  } finally {
    release.resolve();
  }
}, 10_000);

test("rejects an oversized individual frame", async () => {
  const failure = Promise.withResolvers<Error>();
  let records = 0;
  const { client } = await scriptedClient(async () => {
    records++;
  }, failure.resolve);
  await expect(client.request("oversized", { count: 1, bytes: 16 * 1024 * 1024 })).rejects.toThrow(
    "frame exceeds",
  );
  expect(await failure.promise).toMatchObject({
    message: "Pi RPC frame exceeds the transport limit.",
  });
  expect(records).toBe(0);
}, 10_000);

test("malformed native output rejects outstanding requests and stop reaps the process", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosoo-pi-rpc-"));
  const failure = Promise.withResolvers<Error>();
  let records = 0;
  const client = new PiRpcClient(
    {
      command: process.execPath,
      args: [
        "-e",
        'process.stdin.once("data", () => process.stdout.write("not json\\n")); setInterval(() => {}, 1000)',
      ],
      cwd: root,
      home: root,
      env: {},
    },
    async () => {
      records++;
    },
    failure.resolve,
  );
  try {
    await expect(
      client.request("get_state", {}, AbortSignal.timeout(2_000)),
    ).rejects.toBeInstanceOf(Error);
    expect(await raceWithAbort(failure.promise, AbortSignal.timeout(500))).toBeInstanceOf(Error);
    await expect(client.request("prompt")).rejects.toThrow("unavailable");
    await client.stop();
    expect(records).toBe(0);
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
