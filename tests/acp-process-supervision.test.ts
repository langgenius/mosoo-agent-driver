import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 3_000;

  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}.`);
    }
    await Bun.sleep(20);
  }

  return Number.parseInt(await readFile(path, "utf8"), 10);
}

async function expectExited(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;

  while (isRunning(pid) && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  expect(isRunning(pid)).toBe(false);
}

function readSessionId(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
}

describe.skipIf(process.platform !== "linux")("ACP process supervision", () => {
  test("kills agent and terminal trees after a provider clears its environment and the driver is SIGKILLed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "driver-acp-supervision-"));
    const paths = {
      agentRoot: join(directory, "agent-root.pid"),
      agentShell: join(directory, "agent-shell.pid"),
      agentWorker: join(directory, "agent-worker.pid"),
      terminalRoot: join(directory, "terminal-root.pid"),
      terminalShell: join(directory, "terminal-shell.pid"),
      terminalWorker: join(directory, "terminal-worker.pid"),
    };
    const agentNested = `echo $$ > ${paths.agentShell}; sleep 30 & echo $! > ${paths.agentWorker}; wait`;
    const terminalNested = `echo $$ > ${paths.terminalShell}; sleep 30 & echo $! > ${paths.terminalWorker}; wait`;
    const agentSource = `exec /usr/bin/env -i PATH=/usr/bin:/bin /bin/sh -c '${agentNested}'`;
    const terminalSource = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(paths.terminalRoot)}, String(process.pid));
spawn("/usr/bin/setsid", ["/bin/sh", "-c", ${JSON.stringify(terminalNested)}], {
  stdio: "ignore",
});
setInterval(() => {}, 1_000);
`;
    const helperSource = `
import { writeFileSync } from "node:fs";
import { startAcpAgentProcess } from "./src/runtimes/acp/acp-agent-process.ts";
import { AcpTerminalManager } from "./src/runtimes/acp/acp-terminal-manager.ts";
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const context = { logger };
const payload = {
  execution: {
    session: {
      cwd: ${JSON.stringify(directory)},
      homePath: ${JSON.stringify(join(directory, "home"))},
    },
  },
};
process.env.MOSOO_ACP_FALLBACK_COMMAND = "/bin/sh";
process.env.MOSOO_ACP_FALLBACK_ARGS = JSON.stringify(["-c", ${JSON.stringify(agentSource)}]);
const agent = await startAcpAgentProcess(
  context,
  payload,
  { MOSOO_ACP_HOME: ${JSON.stringify(join(directory, "acp-home"))}, PATH: process.env.PATH ?? "" },
  new AbortController().signal,
);
writeFileSync(${JSON.stringify(paths.agentRoot)}, String(agent.pid));
const terminals = new AcpTerminalManager({
  allowedRoots: [],
  cwd: ${JSON.stringify(directory)},
  env: { PATH: process.env.PATH ?? "" },
  push: async () => {},
});
await terminals.create(context, {
  args: ["-e", ${JSON.stringify(terminalSource)}],
  command: process.execPath,
});
setInterval(() => {}, 1_000);
`;
    const helper = spawn(process.execPath, ["-e", helperSource], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const helperPid = helper.pid;
    const pids = new Set<number>();

    try {
      expect(helperPid).toBeDefined();
      pids.add(helperPid!);
      const [agentRoot, agentShell, agentWorker, terminalRoot, terminalShell, terminalWorker] =
        await Promise.all([
          waitForPid(paths.agentRoot),
          waitForPid(paths.agentShell),
          waitForPid(paths.agentWorker),
          waitForPid(paths.terminalRoot),
          waitForPid(paths.terminalShell),
          waitForPid(paths.terminalWorker),
        ]);
      [agentRoot, agentShell, agentWorker, terminalRoot, terminalShell, terminalWorker].forEach(
        (pid) => pids.add(pid),
      );

      expect(agentShell).toBe(agentRoot);
      expect(readSessionId(agentShell)).toBe(agentShell);
      expect(readSessionId(terminalShell)).toBe(terminalShell);
      expect(readSessionId(terminalShell)).not.toBe(readSessionId(terminalRoot));
      const clearedDeadline = Date.now() + 3_000;
      let agentEnvironment = readFileSync(`/proc/${agentRoot}/environ`, "utf8");
      while (
        agentEnvironment.includes("MOSOO_PROCESS_TREE_OWNER_ID=") &&
        Date.now() < clearedDeadline
      ) {
        await Bun.sleep(20);
        agentEnvironment = readFileSync(`/proc/${agentRoot}/environ`, "utf8");
      }
      expect(agentEnvironment).not.toContain("MOSOO_PROCESS_TREE_OWNER_ID=");

      process.kill(-helperPid!, "SIGKILL");
      await Promise.all([...pids].map(expectExited));
      pids.clear();
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { force: true, recursive: true });
    }
  }, 8_000);
});
