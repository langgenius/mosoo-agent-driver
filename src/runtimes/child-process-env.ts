import { delimiter } from "node:path";

import { DRIVER_BOOT_PAYLOAD_ENV_NAME, DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME } from "../protocol/boot";
import type { DriverExecutionEnvironment } from "../protocol/boot";

export { DRIVER_BOOT_PAYLOAD_ENV_NAME, DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME };

export function buildRuntimeChildProcessEnv(
  paths: DriverExecutionEnvironment["paths"],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

  for (const [name, artifactPaths] of [
    ["PATH", paths?.executable ?? []],
    ["NODE_PATH", paths?.node ?? []],
    ["PYTHONPATH", paths?.python ?? []],
  ] as const) {
    if (artifactPaths.length > 0) {
      const inheritedKey =
        platform === "win32"
          ? Object.hasOwn(childEnv, name)
            ? name
            : Object.keys(childEnv).find((key) => key.toUpperCase() === name)
          : name;
      const inherited = inheritedKey === undefined ? undefined : childEnv[inheritedKey];

      if (platform === "win32") {
        for (const key of Object.keys(childEnv)) {
          if (key.toUpperCase() === name) {
            delete childEnv[key];
          }
        }
      }

      childEnv[name] = [...artifactPaths, ...(inherited ? [inherited] : [])].join(pathDelimiter);
    }
  }

  delete childEnv[DRIVER_BOOT_PAYLOAD_ENV_NAME];
  delete childEnv[DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME];

  return childEnv;
}
