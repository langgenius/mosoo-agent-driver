import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiRpcClient } from "../src/runtimes/pi/pi-rpc-client";
import { raceWithAbort } from "../src/utils/async";

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
