import type { DriverBootMcpServer } from "../../protocol/boot";

export function toMcpServerKey(server: DriverBootMcpServer, usedNames: Set<string>): string {
  const baseName = server.name.trim() || server.serverId;
  let candidate = baseName;
  let suffix = 2;

  while (usedNames.has(candidate)) {
    candidate = `${baseName}-${suffix}`;
    suffix += 1;
  }

  usedNames.add(candidate);
  return candidate;
}
