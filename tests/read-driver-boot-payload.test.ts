import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDriverBootPayload } from "../src/boot/read-driver-boot-payload";
import { parseDriverBootPayload } from "../src/protocol/boot";
import { parseDriverHelloInput } from "../src/protocol/orpc";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import {
  DRIVER_BOOT_PAYLOAD_ENV_NAME,
  DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME,
} from "../src/runtimes/child-process-env";
import { driverBootPayload as payload } from "./driver-boot-payload-fixture";

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
  test.each([undefined, false, true])(
    "preserves the host native continuation requirement: %s",
    (required) => {
      const parsed = parseDriverBootPayload({
        ...payload,
        execution: {
          ...payload.execution,
          session: { ...payload.execution.session, nativeResumeRequired: required },
        },
      });
      expect(
        createDriverStartInputFromBootPayload(parsed).execution.session.nativeResumeRequired,
      ).toBe(required ?? false);
    },
  );

  test.each([null, "false", 0])(
    "rejects an invalid native continuation requirement: %s",
    (required) => {
      expect(() =>
        parseDriverBootPayload({
          ...payload,
          execution: {
            ...payload.execution,
            session: { ...payload.execution.session, nativeResumeRequired: required },
          },
        }),
      ).toThrow("nativeResumeRequired must be a boolean");
    },
  );

  test.each([1, 2, 3])("rejects protocol %s during the Driver handshake", (version) => {
    expect(() =>
      parseDriverHelloInput({
        capabilities: [],
        driverVersion: "legacy-test",
        pid: 1,
        protocolVersion: version,
        runtime: "openai-runtime",
        startedAt: "now",
      }),
    ).toThrow("protocolVersion must be 4");
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
