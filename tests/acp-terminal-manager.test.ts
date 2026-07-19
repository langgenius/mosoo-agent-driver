import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBufferedSinkLogger } from "../src/observability";
import type { DriverEventInput } from "../src/protocol/events";
import { createDriverId, isDriverId } from "../src/protocol/id";
import { AcpTerminalManager } from "../src/runtimes/acp/acp-terminal-manager";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { driverStartInput } from "./driver-boot-payload-fixture";

function createHarness(
  onPush: ((reason: string, events: DriverEventInput[]) => Promise<void>) | undefined = undefined,
  maxTerminals?: number,
  recordAfterPush = false,
) {
  const events: DriverEventInput[] = [];
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "acp-terminal-manager-test",
    sink: async () => {},
  });
  const context = createAgentDriverContext({
    eventSink: { pushEvents: async () => ({ accepted: [] }) },
    logger,
    payload: driverStartInput,
    permission: { request: async () => "reject_once" },
  });
  const manager = new AcpTerminalManager({
    allowedRoots: [],
    cwd: process.cwd(),
    env: {},
    maxTerminals,
    push: async (_context, _reason, next) => {
      if (recordAfterPush) {
        await onPush?.(_reason, next);
        events.push(...next);
      } else {
        events.push(...next);
        await onPush?.(_reason, next);
      }
    },
  });

  return { context, events, logger, manager };
}

describe("ACP terminal manager", () => {
  test("retains a valid UTF-8 suffix and exposes exit only after output closes", async () => {
    const harness = createHarness();

    try {
      const { terminalId } = await harness.manager.create(harness.context, {
        args: ["-e", 'process.stdout.write("a😀bc")'],
        command: process.execPath,
        outputByteLimit: 5,
      });
      const exit = await harness.manager.waitForExit({ terminalId });
      const output = harness.manager.output({ terminalId });

      expect(isDriverId(terminalId)).toBe(true);
      expect(exit).toEqual({ exitCode: 0, signal: null });
      expect(output).toEqual({
        exitStatus: exit,
        output: "bc",
        truncated: true,
      });
      await harness.manager.release(harness.context, { terminalId });
    } finally {
      await harness.logger.destroy();
    }
  });

  test("rejects terminal buffers above the deployment hard limit", async () => {
    const harness = createHarness();

    try {
      await expect(
        harness.manager.create(harness.context, {
          command: process.execPath,
          outputByteLimit: 1_024 * 1_024 + 1,
        }),
      ).rejects.toThrow("exceeds 1048576 bytes");
    } finally {
      await harness.logger.destroy();
    }
  });

  test("bounds retained terminals and restores capacity after release", async () => {
    const harness = createHarness(undefined, 1);

    try {
      const first = await harness.manager.create(harness.context, {
        args: ["-e", "setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      await expect(
        harness.manager.create(harness.context, { command: process.execPath }),
      ).rejects.toThrow("limit of 1 is exhausted");

      await harness.manager.release(harness.context, first);
      const second = await harness.manager.create(harness.context, {
        args: ["-e", "process.exit(0)"],
        command: process.execPath,
      });
      await harness.manager.waitForExit(second);
      await harness.manager.release(harness.context, second);
    } finally {
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });

  test.each([0, Number.POSITIVE_INFINITY, 1.5])("rejects invalid terminal limit %p", (value) => {
    expect(() => createHarness(undefined, value)).toThrow("positive safe integer");
  });

  test("rejects a failed spawn without retaining terminal capacity", async () => {
    const harness = createHarness(undefined, 1);

    try {
      await expect(
        harness.manager.create(harness.context, {
          command: `/definitely-missing-acp-command-${createDriverId()}`,
        }),
      ).rejects.toThrow();
      const terminal = await harness.manager.create(harness.context, {
        args: ["-e", "process.exit(0)"],
        command: process.execPath,
      });
      await harness.manager.waitForExit(terminal);
      await harness.manager.release(harness.context, terminal);
    } finally {
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });

  test("rejects terminal creation after shutdown starts", async () => {
    const harness = createHarness();

    try {
      await harness.manager.stopAll(harness.context);
      await expect(
        harness.manager.create(harness.context, {
          args: ["-e", "process.exit(0)"],
          command: process.execPath,
        }),
      ).rejects.toThrow("stopping");
    } finally {
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });

  test("keeps a terminal private until its creation event commits", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let terminalId: string | undefined;
    const harness = createHarness(async (reason, events) => {
      if (reason === "driver.acp.terminal.created") {
        terminalId = (events[0]?.payload as Record<string, unknown> | undefined)?.[
          "terminalId"
        ] as string;
        entered.resolve();
        await release.promise;
      }
    });

    try {
      const creation = harness.manager.create(harness.context, {
        args: ["-e", "setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      await entered.promise;

      expect(() => harness.manager.output({ terminalId })).toThrow("does not exist");
      release.resolve();
      await expect(creation).resolves.toEqual({ terminalId });
      expect(() => harness.manager.output({ terminalId })).not.toThrow();
    } finally {
      release.resolve();
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });

  test("waits for an entered create publication before stopping the terminal", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = createHarness(
      async (reason) => {
        if (reason === "driver.acp.terminal.created") {
          entered.resolve();
          await release.promise;
        }
      },
      undefined,
      true,
    );

    try {
      const creation = harness.manager.create(harness.context, {
        args: ["-e", "setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      void creation.catch(() => {});
      await entered.promise;
      const stop = harness.manager.stopAll(harness.context);
      let stopped = false;
      void stop.then(() => {
        stopped = true;
      });
      await Promise.resolve();

      expect(stopped).toBe(false);
      expect(harness.events).toHaveLength(0);
      release.resolve();
      await expect(creation).rejects.toThrow("stopping");
      await expect(stop).resolves.toBeUndefined();
      expect(harness.events.map((event) => event.kind)).toEqual([
        "terminal.created",
        "terminal.exited",
        "terminal.released",
      ]);
    } finally {
      release.resolve();
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  });

  test("does not fail create before an entered publication settles on abort", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = createHarness(
      async (reason) => {
        if (reason === "driver.acp.terminal.created") {
          entered.resolve();
          await release.promise;
        }
      },
      undefined,
      true,
    );
    const controller = new AbortController();

    try {
      const creation = harness.manager.create(
        harness.context,
        {
          args: ["-e", "setInterval(() => {}, 1000)"],
          command: process.execPath,
        },
        controller.signal,
      );
      void creation.catch(() => {});
      await entered.promise;
      controller.abort();
      let settled = false;
      void creation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(harness.events).toHaveLength(0);
      release.resolve();
      await expect(creation).rejects.toBeInstanceOf(DOMException);
      expect(harness.events.map((event) => event.kind)).toEqual([
        "terminal.created",
        "terminal.exited",
        "terminal.released",
      ]);
    } finally {
      release.resolve();
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  });

  test("retains and reports a stopped creation whose release publication fails", async () => {
    const entered = Promise.withResolvers<void>();
    const releaseCreated = Promise.withResolvers<void>();
    let failRelease = true;
    let terminalId: string | undefined;
    const harness = createHarness(
      async (reason, events) => {
        if (reason === "driver.acp.terminal.created") {
          terminalId = (events[0]?.payload as Record<string, unknown> | undefined)?.[
            "terminalId"
          ] as string;
          entered.resolve();
          await releaseCreated.promise;
        }

        if (failRelease && reason === "driver.acp.terminal.released") {
          throw new Error("release publication failed");
        }
      },
      undefined,
      true,
    );

    try {
      const creation = harness.manager.create(harness.context, {
        args: ["-e", "setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      void creation.catch(() => {});
      await entered.promise;
      const stop = harness.manager.stopAll(harness.context);
      void stop.catch(() => {});
      releaseCreated.resolve();

      await expect(creation).rejects.toThrow("cleanup failed");
      await expect(stop).rejects.toBeInstanceOf(AggregateError);
      expect(harness.events.map((event) => event.kind)).toEqual([
        "terminal.created",
        "terminal.exited",
      ]);
      expect(() => harness.manager.output({ terminalId })).not.toThrow();

      failRelease = false;
      await expect(harness.manager.stopAll(harness.context)).resolves.toBeUndefined();
      expect(harness.events.map((event) => event.kind)).toEqual([
        "terminal.created",
        "terminal.exited",
        "terminal.released",
      ]);
      expect(() => harness.manager.output({ terminalId })).toThrow("does not exist");
    } finally {
      failRelease = false;
      releaseCreated.resolve();
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  });

  test("keeps a killed terminal readable until release, then invalidates every operation", async () => {
    const harness = createHarness();

    try {
      const { terminalId } = await harness.manager.create(harness.context, {
        args: ["-e", "setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      await harness.manager.kill(harness.context, { terminalId });
      await expect(harness.manager.waitForExit({ terminalId })).resolves.toMatchObject({
        exitCode: null,
      });
      expect(harness.manager.output({ terminalId }).exitStatus).not.toBeNull();
      await harness.manager.release(harness.context, { terminalId });

      expect(() => harness.manager.output({ terminalId })).toThrow("does not exist");

      for (const operation of [
        () => harness.manager.waitForExit({ terminalId }),
        () => harness.manager.kill(harness.context, { terminalId }),
        () => harness.manager.release(harness.context, { terminalId }),
      ]) {
        await expect(operation()).rejects.toThrow("does not exist");
      }
    } finally {
      await harness.logger.destroy();
    }
  });

  test("aborts an SDK terminal wait without abandoning the terminal", async () => {
    const harness = createHarness();

    try {
      const terminal = await harness.manager.create(harness.context, {
        args: ["-e", "setInterval(() => {}, 1000)"],
        command: process.execPath,
      });
      const controller = new AbortController();
      const exit = harness.manager.waitForExit(terminal, controller.signal);
      controller.abort();

      await expect(exit).rejects.toBeInstanceOf(DOMException);
      expect(() => harness.manager.output(terminal)).not.toThrow();
      await harness.manager.release(harness.context, terminal);
    } finally {
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });

  test.each([
    ["cooperative", "", "SIGTERM"],
    ["TERM-resistant", 'process.on("SIGTERM", () => {});', "SIGKILL"],
  ] as const)(
    "bounds release of a %s terminal and observes its final exit",
    async (_name, signalHandler, expectedSignal) => {
      const harness = createHarness();

      try {
        const terminal = await harness.manager.create(harness.context, {
          args: [
            "-e",
            `${signalHandler}process.stdout.write("ready");setInterval(() => {}, 1000);`,
          ],
          command: process.execPath,
        });

        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (harness.manager.output(terminal).output === "ready") {
            break;
          }

          await Bun.sleep(10);
        }

        expect(harness.manager.output(terminal).output).toBe("ready");
        const exit = harness.manager.waitForExit(terminal);
        const release = await settlePromiseWithTimeout(
          harness.manager.release(harness.context, terminal),
          {
            label: "ACP terminal release",
            timeoutMs: 4_000,
          },
        );

        expect(release.status).toBe("completed");
        await expect(exit).resolves.toMatchObject({ signal: expectedSignal });
        expect(() => harness.manager.output(terminal)).toThrow("does not exist");
      } finally {
        await harness.manager.stopAll(harness.context);
        await harness.logger.destroy();
      }
    },
  );

  test("retains only the failed release for a later shutdown retry", async () => {
    let releasePushes = 0;
    const harness = createHarness(async (reason) => {
      if (reason === "driver.acp.terminal.released" && releasePushes++ === 0) {
        throw new Error("release event failed");
      }
    });

    try {
      const terminalIds = await Promise.all(
        ["first", "second"].map(async (value) => {
          const created = await harness.manager.create(harness.context, {
            args: ["-e", `process.stdout.write(${JSON.stringify(value)})`],
            command: process.execPath,
          });
          await harness.manager.waitForExit(created);
          return created.terminalId;
        }),
      );

      await expect(harness.manager.stopAll(harness.context)).rejects.toBeInstanceOf(AggregateError);

      expect(
        terminalIds.filter((terminalId) => {
          try {
            harness.manager.output({ terminalId });
            return true;
          } catch {
            return false;
          }
        }),
      ).toHaveLength(1);

      await expect(harness.manager.stopAll(harness.context)).resolves.toBeUndefined();
      terminalIds.forEach((terminalId) => {
        expect(() => harness.manager.output({ terminalId })).toThrow("does not exist");
      });
    } finally {
      await harness.manager.stopAll(harness.context).catch(() => {});
      await harness.logger.destroy();
    }
  });

  test("retains a terminal for shutdown retry when failed creation cleanup cannot confirm exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mosoo-acp-terminal-"));
    const pidPath = join(directory, "pid");
    const nativeKill = process.kill;
    let childPid = 0;
    let suppressGroupKill = true;
    const harness = createHarness(async (reason) => {
      if (reason === "driver.acp.terminal.created") {
        throw new Error("event sink unavailable");
      }
    });

    try {
      process.kill = ((pid, signal) => {
        if (suppressGroupKill && typeof pid === "number" && pid < 0) {
          return true;
        }

        return nativeKill(pid, signal);
      }) as typeof process.kill;

      await expect(
        harness.manager.create(harness.context, {
          args: [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));setInterval(() => {}, 1000);`,
          ],
          command: process.execPath,
        }),
      ).rejects.toThrow();
      childPid = Number(await Bun.file(pidPath).text());
      const terminalId = (
        harness.events.find((event) => event.kind === "terminal.created")?.payload as
          | Record<string, unknown>
          | undefined
      )?.["terminalId"];

      expect(terminalId).toBeString();
      expect(() => harness.manager.output({ terminalId })).not.toThrow();

      suppressGroupKill = false;
      await expect(harness.manager.stopAll(harness.context)).resolves.toBeUndefined();
      expect(() => harness.manager.output({ terminalId })).toThrow("does not exist");
    } finally {
      suppressGroupKill = false;
      process.kill = nativeKill;
      await harness.manager.stopAll(harness.context).catch(() => {});

      if (childPid > 0) {
        try {
          nativeKill(-childPid, "SIGKILL");
        } catch {}
      }

      await harness.logger.destroy();
      await rm(directory, { force: true, recursive: true });
    }
  }, 5_000);

  test("stopAll joins an in-progress release and emits it once", async () => {
    const releasePublishing = Promise.withResolvers<void>();
    const allowRelease = Promise.withResolvers<void>();
    let releasePushes = 0;
    const harness = createHarness(async (reason) => {
      if (reason === "driver.acp.terminal.released") {
        releasePushes += 1;
        releasePublishing.resolve();
        await allowRelease.promise;
      }
    });

    try {
      const terminal = await harness.manager.create(harness.context, {
        args: ["-e", "process.exit(0)"],
        command: process.execPath,
      });
      await harness.manager.waitForExit(terminal);
      const release = harness.manager.release(harness.context, terminal);
      await releasePublishing.promise;
      const stops = Promise.all([
        harness.manager.stopAll(harness.context),
        harness.manager.stopAll(harness.context),
      ]);
      let stopsSettled = false;
      void stops.then(() => {
        stopsSettled = true;
      });
      await Bun.sleep(0);

      expect(stopsSettled).toBe(false);
      allowRelease.resolve();
      await expect(Promise.all([release, stops])).resolves.toEqual([{}, [undefined, undefined]]);
      expect(releasePushes).toBe(1);
      expect(() => harness.manager.output(terminal)).toThrow("does not exist");
    } finally {
      allowRelease.resolve();
      await harness.manager.stopAll(harness.context);
      await harness.logger.destroy();
    }
  });
});
