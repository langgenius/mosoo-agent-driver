import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createBufferedSinkLogger } from "../src/observability";
import type { Logger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import { AcpFileSystem } from "../src/runtimes/acp/acp-file-system";
import { driverStartInput } from "./driver-boot-payload-fixture";

function createFileSystem(cwd = process.cwd()): AcpFileSystem {
  return new AcpFileSystem({
    allowedRoots: [],
    cwd,
  });
}

function createContext(events: DriverEventInput[]): {
  context: AgentDriverContext;
  logger: Logger;
} {
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "acp-file-system-test",
    sink: async () => {},
  });

  return {
    context: createAgentDriverContext({
      eventSink: {
        pushEvents: async (input) => {
          events.push(...input.events);
          return {
            accepted: input.events.map((event, index) => ({
              seq: index + 1,
              type: event.kind,
            })),
          };
        },
      },
      logger,
      payload: driverStartInput,
      permission: {
        request: async () => "reject_once",
      },
    }),
    logger,
  };
}

describe("ACP file system bridge", () => {
  test("rejects non-absolute paths", async () => {
    const fileSystem = createFileSystem();

    await expect(fileSystem.readTextFile({ path: "relative.txt" })).rejects.toThrow(
      "must be absolute",
    );
  });

  test("rejects absolute paths outside the allowed roots", async () => {
    const fileSystem = createFileSystem();

    await expect(fileSystem.readTextFile({ path: "/tmp/outside.txt" })).rejects.toThrow(
      "outside the allowed roots",
    );
  });

  test("rejects a symlink that escapes an allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-acp-fs-scope-"));
    const outside = await mkdtemp(join(tmpdir(), "driver-acp-fs-outside-"));
    const link = join(root, "escape");
    const target = join(outside, "secret.txt");

    try {
      await writeFile(target, "secret");
      await symlink(outside, link);
      await expect(
        createFileSystem(root).readTextFile({ path: join(link, "secret.txt") }),
      ).rejects.toThrow("resolves outside the allowed roots");
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("writes allowed text files and reports the file change through the host port", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-acp-fs-"));
    const path = join(root, "nested", "note.txt");
    const events: DriverEventInput[] = [];
    const { context, logger } = createContext(events);

    try {
      const fileSystem = createFileSystem(root);

      await expect(
        fileSystem.writeTextFile(context, {
          content: "hello",
          path,
        }),
      ).resolves.toEqual({});

      expect(await readFile(path, "utf8")).toBe("hello");
      expect(events).toHaveLength(1);
      const resolvedPath = join(await realpath(root), "nested", "note.txt");
      expect(events[0]).toMatchObject({
        kind: "file.changed",
        payload: {
          change: "upsert",
          path: resolvedPath,
          source: "acp.fs",
        },
      });
      expect(isDriverId(events[0]?.sourceEventId)).toBe(true);
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects files above the deployment byte limit before reading them", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-acp-fs-limit-"));
    const path = join(root, "large.txt");

    try {
      await writeFile(path, "");
      await truncate(path, 8 * 1_024 * 1_024 + 1);
      await expect(createFileSystem(root).readTextFile({ path })).rejects.toThrow(
        "file exceeds 8388608 bytes",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
