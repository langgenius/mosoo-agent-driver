import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDriverBootPayload } from "../src/boot/read-driver-boot-payload";
import { parseDriverHelloInput } from "../src/protocol/orpc";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import {
  DRIVER_BOOT_PAYLOAD_ENV_NAME,
  DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME,
} from "../src/runtimes/child-process-env";
import { DRIVER_TEST_IDS, driverBootPayload as payload } from "./driver-boot-payload-fixture";

const envPayloadValue = process.env[DRIVER_BOOT_PAYLOAD_ENV_NAME];
const envPayloadFileValue = process.env[DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME];

afterEach(() => {
  if (envPayloadValue === undefined) {
    delete process.env[DRIVER_BOOT_PAYLOAD_ENV_NAME];
  } else {
    process.env[DRIVER_BOOT_PAYLOAD_ENV_NAME] = envPayloadValue;
  }

  if (envPayloadFileValue === undefined) {
    delete process.env[DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME];
  } else {
    process.env[DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME] = envPayloadFileValue;
  }
});

describe("readDriverBootPayload", () => {
  test.each([1, 2, 3, 4, 5, 6, 7])(
    "rejects protocol %s during the Driver handshake",
    (protocolVersion) => {
      expect(() =>
        parseDriverHelloInput({
          capabilities: [],
          driverVersion: "legacy-test",
          pid: 1,
          protocolVersion,
          runtime: "openai-runtime",
          startedAt: "now",
        }),
      ).toThrow("protocolVersion must be 8");
    },
  );

  test("preserves a Pi checkpoint from the environment through start conversion", async () => {
    const nativeRef = {
      kind: "pi_session_path",
      runtimeId: "pi",
      value: "sessions/restored.jsonl",
    };
    const nativeCheckpoint = { formatVersion: 1, nativeRef, runId: DRIVER_TEST_IDS.secondRunId };
    process.env[DRIVER_BOOT_PAYLOAD_ENV_NAME] = JSON.stringify({
      ...payload,
      runtime: "pi",
      runtimeTransport: "pi-rpc",
      execution: {
        ...payload.execution,
        session: { ...payload.execution.session, nativeCheckpoint, nativeResumeRef: nativeRef },
      },
    });

    const parsed = await readDriverBootPayload();
    const start = createDriverStartInputFromBootPayload(parsed);

    expect(start.execution.session.nativeCheckpoint).toEqual(nativeCheckpoint);
    expect(start.execution.session.nativeResumeRef).toEqual(nativeRef);
    expect(start.execution.run.runId).toBe(DRIVER_TEST_IDS.runId);
  });

  test("reads the boot payload from a file and removes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g-driver-boot-"));
    const payloadPath = join(dir, "payload.json");

    delete process.env[DRIVER_BOOT_PAYLOAD_ENV_NAME];
    process.env[DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME] = payloadPath;
    await writeFile(payloadPath, JSON.stringify(payload), "utf8");

    try {
      const parsed = await readDriverBootPayload();

      expect(parsed.driverInstanceId).toBe(payload.driverInstanceId);
      expect(parsed.execution.configRevision.sessionId).toBe(
        payload.execution.configRevision.sessionId,
      );
      await expect(readFile(payloadPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
