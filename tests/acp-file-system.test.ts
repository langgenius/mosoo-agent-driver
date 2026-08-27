import { afterEach, describe, expect, test } from "bun:test";
import { truncateSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDriverContext } from "../src/core/agent-driver-backend";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createBufferedSinkLogger } from "../src/observability";
import type { Logger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { isDriverId } from "../src/protocol/id";
import { AcpFileSystem } from "../src/runtimes/acp/acp-file-system";
import { AcpPathScope } from "../src/runtimes/acp/acp-path-scope";
import { driverStartInput } from "./driver-boot-payload-fixture";

const pathScopes = new Set<AcpPathScope>();

function createFileSystem(cwd = process.cwd(), pathScope?: AcpPathScope): AcpFileSystem {
  const scope = pathScope ?? new AcpPathScope({ allowedRoots: [], cwd });
  const fileSystem = new AcpFileSystem({
    allowedRoots: [],
    cwd,
    pathScope: scope,
  });
  pathScopes.add(scope);
  return fileSystem;
}

afterEach(async () => {
  await Promise.all([...pathScopes].map((pathScope) => pathScope.close()));
  pathScopes.clear();
});

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
        currentRunId: () => null,
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

  test("reads from the opened capability when an ancestor is exchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-acp-fs-read-race-"));
    const outside = await mkdtemp(join(tmpdir(), "driver-acp-fs-read-race-outside-"));
    const workspace = join(root, "workspace");
    const retained = join(root, "retained");
    const requestedPath = join(workspace, "note.txt");

    class ExchangingPathScope extends AcpPathScope {
      override async openFile(path: string, label: string) {
        const capability = await super.openFile(path, label);
        await rename(workspace, retained);
        await symlink(outside, workspace);
        return capability;
      }
    }

    try {
      await Promise.all([mkdir(workspace), writeFile(join(outside, "note.txt"), "outside")]);
      await writeFile(requestedPath, "inside");
      const pathScope = new ExchangingPathScope({ allowedRoots: [], cwd: root });
      const fileSystem = createFileSystem(root, pathScope);

      await expect(fileSystem.readTextFile({ path: requestedPath })).resolves.toEqual({
        content: "inside",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("retains configured root identity after the root path is exchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-acp-fs-root-race-"));
    const retained = `${root}-retained`;
    const outside = await mkdtemp(join(tmpdir(), "driver-acp-fs-root-race-outside-"));
    const requestedRead = join(root, "read.txt");
    const requestedWrite = join(root, "write.txt");
    const events: DriverEventInput[] = [];
    const { context, logger } = createContext(events);
    const pathScope = new AcpPathScope({ allowedRoots: [], cwd: root });
    const fileSystem = createFileSystem(root, pathScope);

    try {
      await Promise.all([
        writeFile(requestedRead, "inside"),
        writeFile(join(outside, "read.txt"), "outside"),
        writeFile(join(outside, "write.txt"), "outside"),
      ]);
      await pathScope.initialize();
      await rename(root, retained);
      await symlink(outside, root);

      await expect(fileSystem.readTextFile({ path: requestedRead })).resolves.toEqual({
        content: "inside",
      });
      await expect(
        fileSystem.writeTextFile(context, { content: "written", path: requestedWrite }),
      ).resolves.toEqual({});
      expect(await readFile(join(retained, "write.txt"), "utf8")).toBe("written");
      expect(await readFile(join(outside, "write.txt"), "utf8")).toBe("outside");
      expect(events[0]).toMatchObject({ payload: { path: join(retained, "write.txt") } });
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
      await rm(retained, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("releases partial root acquisition and can initialize again", async () => {
    const base = await mkdtemp(join(tmpdir(), "driver-acp-fs-init-retry-"));
    const cwd = join(base, "workspace-long");
    const retained = join(base, "retained");
    const missing = join(base, "x");
    await mkdir(cwd);
    const pathScope = new AcpPathScope({ allowedRoots: [missing], cwd });

    try {
      await expect(pathScope.initialize()).rejects.toThrow("ENOENT");
      await rename(cwd, retained);
      const targets = await Promise.all(
        (await readdir(`/proc/${process.pid}/fd`)).map((fd) =>
          readlink(`/proc/${process.pid}/fd/${fd}`).catch(() => ""),
        ),
      );
      expect(targets).not.toContain(retained);

      await Promise.all([mkdir(cwd), mkdir(missing)]);
      await writeFile(join(cwd, "note.txt"), "replacement");
      await pathScope.initialize();
      const file = await pathScope.openFile(join(cwd, "note.txt"), "test file");
      try {
        expect(await file.file.readFile("utf8")).toBe("replacement");
      } finally {
        await file.file.close();
      }
    } finally {
      await pathScope.close();
      await rm(base, { force: true, recursive: true });
    }
  });

  test("enforces the byte limit when a file grows after fstat", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-acp-fs-grow-race-"));
    const path = join(root, "growing.txt");
    let checkpoints = 0;
    const growthCheckpoint = {
      throwIfAborted() {
        checkpoints += 1;
        if (checkpoints === 3) {
          truncateSync(path, 8 * 1_024 * 1_024 + 1);
        }
      },
    } as unknown as AbortSignal;

    try {
      await writeFile(path, "small");
      await expect(createFileSystem(root).readTextFile({ path }, growthCheckpoint)).rejects.toThrow(
        "file exceeds 8388608 bytes",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("atomically replaces a leaf symlink through the retained parent capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-acp-fs-write-race-"));
    const outside = await mkdtemp(join(tmpdir(), "driver-acp-fs-write-race-outside-"));
    const workspace = join(root, "workspace");
    const retained = join(root, "retained");
    const requestedPath = join(workspace, "note.txt");
    const outsideLeaf = join(outside, "leaf.txt");
    const outsideAncestor = join(outside, "note.txt");
    const events: DriverEventInput[] = [];
    const { context, logger } = createContext(events);

    class ExchangingPathScope extends AcpPathScope {
      override async openWritable(path: string, label: string) {
        const capability = await super.openWritable(path, label);
        await rename(workspace, retained);
        await symlink(outside, workspace);
        return capability;
      }
    }

    try {
      await mkdir(workspace);
      await Promise.all([
        writeFile(outsideLeaf, "outside leaf"),
        writeFile(outsideAncestor, "outside ancestor"),
      ]);
      await symlink(outsideLeaf, requestedPath);
      const pathScope = new ExchangingPathScope({ allowedRoots: [], cwd: root });
      const fileSystem = createFileSystem(root, pathScope);

      await expect(
        fileSystem.writeTextFile(context, { content: "inside", path: requestedPath }),
      ).resolves.toEqual({});
      expect(await readFile(join(retained, "note.txt"), "utf8")).toBe("inside");
      expect((await lstat(join(retained, "note.txt"))).isSymbolicLink()).toBe(false);
      expect(await readFile(outsideLeaf, "utf8")).toBe("outside leaf");
      expect(await readFile(outsideAncestor, "utf8")).toBe("outside ancestor");
      expect(events[0]).toMatchObject({ payload: { path: join(retained, "note.txt") } });
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("preserves an existing regular file mode during atomic replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-acp-fs-mode-"));
    const path = join(root, "script.sh");
    const events: DriverEventInput[] = [];
    const { context, logger } = createContext(events);

    try {
      await writeFile(path, "old");
      await chmod(path, 0o751);
      await createFileSystem(root).writeTextFile(context, { content: "new", path });

      expect(await readFile(path, "utf8")).toBe("new");
      expect((await stat(path)).mode & 0o777).toBe(0o751);
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("removes a partial temporary file when writing is aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-acp-fs-abort-"));
    const path = join(root, "note.txt");
    const events: DriverEventInput[] = [];
    const { context, logger } = createContext(events);
    const aborted = new DOMException("test abort", "AbortError");
    let checkpoints = 0;
    const signal = {
      throwIfAborted() {
        checkpoints += 1;
        if (checkpoints === 5) {
          throw aborted;
        }
      },
    } as unknown as AbortSignal;

    try {
      await writeFile(path, "before");
      await expect(
        createFileSystem(root).writeTextFile(
          context,
          { content: "x".repeat(512 * 1_024), path },
          signal,
        ),
      ).rejects.toBe(aborted);
      expect(await readFile(path, "utf8")).toBe("before");
      expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      await logger.destroy();
      await rm(root, { force: true, recursive: true });
    }
  });
});
