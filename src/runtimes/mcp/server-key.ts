import type { DriverBootMcpServer } from "../../protocol/boot";

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function toMcpServerKey(server: DriverBootMcpServer, usedNames: Set<string>): string {
  const name = server.name.trim();
  const baseName = name.length === 0 || UNSAFE_OBJECT_KEYS.has(name) ? server.serverId : name;
  let candidate = baseName;
  let suffix = 2;

  while (usedNames.has(candidate)) {
    candidate = `${baseName}-${suffix}`;
    suffix += 1;
  }

  usedNames.add(candidate);
  return candidate;
}
