import type { ChildProcess } from "node:child_process";

export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid === undefined) {
    return child.kill(signal);
  }

  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return child.kill(signal);
  }
}
