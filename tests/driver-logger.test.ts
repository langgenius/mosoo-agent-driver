import { describe, expect, test } from "bun:test";

import { createDriverLogger } from "../src/infrastructure/logging/driver-logger";
import type { DriverInstanceSocket } from "../src/infrastructure/runtime/driver-instance-socket";
import type { DriverBootPayload } from "../src/protocol/boot";
import type { DriverLogBatchInput } from "../src/protocol/orpc";

function createBootPayload(): DriverBootPayload {
  return {
    driverInstanceId: "01J00000000000000000000DRV",
    execution: {
      session: {
        context: { sandboxId: "01J00000000000000000000SBX" },
      },
    },
  } as DriverBootPayload;
}

interface FakeSocket {
  batches: Omit<DriverLogBatchInput, "driverInstanceId">[];
  failNextPush: Error | null;
  socket: DriverInstanceSocket;
}

function createFakeSocket(): FakeSocket {
  const state: FakeSocket = {
    batches: [],
    failNextPush: null,
    socket: null as unknown as DriverInstanceSocket,
  };

  state.socket = {
    pushLogs: async (input: Omit<DriverLogBatchInput, "driverInstanceId">) => {
      if (state.failNextPush) {
        const error = state.failNextPush;
        state.failNextPush = null;
        throw error;
      }

      state.batches.push(input);
    },
  } as unknown as DriverInstanceSocket;

  return state;
}

describe("createDriverLogger", () => {
  test("holds log batches until the uplink gate opens", async () => {
    const fake = createFakeSocket();
    const { logger, uplink } = createDriverLogger(createBootPayload(), fake.socket);

    logger.info("driver.runtime.boot.loaded");
    logger.info("driver.runtime.hello.sending");

    let flushed = false;
    const flush = logger.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(fake.batches).toHaveLength(0);

    uplink.open();
    await flush;

    const sent = fake.batches.flatMap((batch) => batch.logs);
    expect(sent.map((entry) => entry.message)).toEqual([
      "driver.runtime.boot.loaded",
      "driver.runtime.hello.sending",
    ]);
    expect(sent.map((entry) => entry.seq)).toEqual([0, 1]);

    await logger.destroy();
  });

  test("keeps the process alive and keeps shipping after an uplink failure", async () => {
    const fake = createFakeSocket();
    const { logger, uplink } = createDriverLogger(createBootPayload(), fake.socket);
    uplink.open();

    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      fake.failNextPush = new Error("Internal server error");
      logger.info("driver.first.batch");
      await logger.flush();

      logger.info("driver.second.batch");
      await logger.flush();
    } finally {
      process.stderr.write = originalWrite;
    }

    const fallback = stderrWrites.find((line) => line.includes("driver.log.uplink.failed"));
    expect(fallback).toBeDefined();
    expect(fallback).toContain("Internal server error");

    // The transport re-buffers a failed batch, so the first entry is retried
    // and delivered alongside the second flush instead of being lost.
    const sent = fake.batches.flatMap((batch) => batch.logs);
    expect(sent.map((entry) => entry.message)).toEqual([
      "driver.first.batch",
      "driver.second.batch",
    ]);

    await logger.destroy();
  });

  test("opening the gate twice is harmless", async () => {
    const fake = createFakeSocket();
    const { logger, uplink } = createDriverLogger(createBootPayload(), fake.socket);

    uplink.open();
    uplink.open();

    logger.info("driver.after.open");
    await logger.flush();

    expect(fake.batches.flatMap((batch) => batch.logs)).toHaveLength(1);
    await logger.destroy();
  });
});
