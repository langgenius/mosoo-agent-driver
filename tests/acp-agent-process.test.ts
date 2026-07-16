import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBufferedSinkLogger } from "../src/observability";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import {
  startAcpAgentProcess,
  stopAcpAgentProcess,
  type AcpAgentProcess,
} from "../src/runtimes/acp/acp-agent-process";
import { buildChildEnv } from "../src/runtimes/acp/acp-configuration";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { driverBootPayload } from "./driver-boot-payload-fixture";

function createHarness() {
  const logger = createBufferedSinkLogger({
    level: "debug",
    service: "acp-agent-process-test",
    sink: async () => {},
  });
  const context = createAgentDriverContext({
    eventSink: { pushEvents: async () => {} },
    logger,
    payload: driverBootPayload,
    permission: { request: async () => "reject_once" },
  });

  return { context, logger };
}

function fakeProcess(): AcpAgentProcess {
  return {
    exitCode: null,
    kill: () => true,
    pid: 987_654,
    signalCode: null,
  } as unknown as AcpAgentProcess;
}

describe("ACP agent process lifecycle", () => {
  test.each(["SIGTERM", "SIGKILL"] as const)("observes exit after %s", async (exitSignal) => {
    const harness = createHarness();
    const child = fakeProcess();
    const nativeKill = process.kill;
    const signals: NodeJS.Signals[] = [];
    process.kill = ((_pid: number, signal: NodeJS.Signals) => {
      signals.push(signal);

      if (signal === exitSignal) {
        child.signalCode = signal;
      }

      return true;
    }) as typeof process.kill;

    try {
      await expect(
        stopAcpAgentProcess(harness.context, child, "test.stop"),
      ).resolves.toBeUndefined();
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      process.kill = nativeKill;
      await harness.logger.destroy();
    }
  });

  test("reports a force-kill failure and lets a later call retry", async () => {
    const harness = createHarness();
    const child = fakeProcess();
    const nativeKill = process.kill;
    let canExit = false;
    process.kill = ((_pid: number, signal: NodeJS.Signals) => {
      if (canExit && signal === "SIGKILL") {
        child.signalCode = signal;
      }

      return true;
    }) as typeof process.kill;

    try {
      await expect(stopAcpAgentProcess(harness.context, child, "first.stop")).rejects.toThrow(
        "did not exit",
      );
      canExit = true;
      await expect(
        stopAcpAgentProcess(harness.context, child, "retry.stop"),
      ).resolves.toBeUndefined();
    } finally {
      process.kill = nativeKill;
      await harness.logger.destroy();
    }
  });

  test("waits for close when a descendant keeps the exited leader's stdio open", async () => {
    const harness = createHarness();
    const root = await mkdtemp(join(tmpdir(), "driver-acp-process-"));
    const boot = {
      ...driverBootPayload,
      execution: {
        ...driverBootPayload.execution,
        session: {
          ...driverBootPayload.execution.session,
          context: {
            ...driverBootPayload.execution.session.context,
            homePath: join(root, "home"),
            sessionOrganizationPath: root,
          },
          cwd: root,
        },
      },
    };
    const payload = createDriverStartInputFromBootPayload(boot);
    const previousCommand = process.env["MOSOO_ACP_FALLBACK_COMMAND"];
    const previousArgs = process.env["MOSOO_ACP_FALLBACK_ARGS"];
    const script = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
      '  { stdio: ["ignore", process.stdout, process.stderr] });',
      "child.unref();",
    ].join("\n");
    process.env["MOSOO_ACP_FALLBACK_COMMAND"] = process.execPath;
    process.env["MOSOO_ACP_FALLBACK_ARGS"] = JSON.stringify(["-e", script]);
    let child: AcpAgentProcess | undefined;
    let closed = false;

    try {
      child = await startAcpAgentProcess(
        harness.context,
        payload,
        buildChildEnv(payload),
        new AbortController().signal,
      );
      child.once("close", () => {
        closed = true;
      });

      if (child.exitCode === null && child.signalCode === null) {
        await once(child, "exit");
      }

      expect(closed).toBe(false);
      await stopAcpAgentProcess(
        harness.context,
        child,
        "test.stop",
        Date.now() + 2_000,
        new AbortController().signal,
      );
      expect(closed).toBe(true);
    } finally {
      if (child !== undefined && !closed) {
        await stopAcpAgentProcess(
          harness.context,
          child,
          "test.cleanup",
          Date.now() + 2_000,
          new AbortController().signal,
        ).catch(() => {});
      }

      if (previousCommand === undefined) {
        delete process.env["MOSOO_ACP_FALLBACK_COMMAND"];
      } else {
        process.env["MOSOO_ACP_FALLBACK_COMMAND"] = previousCommand;
      }

      if (previousArgs === undefined) {
        delete process.env["MOSOO_ACP_FALLBACK_ARGS"];
      } else {
        process.env["MOSOO_ACP_FALLBACK_ARGS"] = previousArgs;
      }

      await rm(root, { force: true, recursive: true });
      await harness.logger.destroy();
    }
  }, 5_000);
});
