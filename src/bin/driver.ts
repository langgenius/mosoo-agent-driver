#!/usr/bin/env bun

import { readDriverBootPayload } from "../boot/read-driver-boot-payload";
import { DriverProcess } from "../core/driver-process";
import { logDriverFatal } from "../infrastructure/logging/driver-logger";
import { isSupportedDriverRuntime, isSupportedDriverRuntimeTransport } from "../protocol/runtime";

async function main(): Promise<void> {
  const payload = await readDriverBootPayload();

  if (!isSupportedDriverRuntime(payload.runtime)) {
    throw new Error(`Unsupported runtime: ${String(payload.runtime)}.`);
  }

  if (!isSupportedDriverRuntimeTransport(payload.runtimeTransport)) {
    throw new Error(`Unsupported runtime transport: ${String(payload.runtimeTransport)}.`);
  }

  const driver = new DriverProcess(payload);
  await driver.run();
}

async function runMain(): Promise<void> {
  try {
    await main();
  } catch (error) {
    logDriverFatal(error);
    process.exit(1);
  }
}

void runMain();
