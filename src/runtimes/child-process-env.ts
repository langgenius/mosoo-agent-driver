import { DRIVER_BOOT_PAYLOAD_ENV_NAME, DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME } from "../protocol/boot";
import type { DriverExecutionEnvironment } from "../protocol/boot";

export { DRIVER_BOOT_PAYLOAD_ENV_NAME, DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME };

export function buildRuntimeChildProcessEnv(
  paths: DriverExecutionEnvironment["paths"],
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

  for (const [name, artifactPaths] of [
    ["PATH", paths?.executable ?? []],
    ["NODE_PATH", paths?.node ?? []],
    ["PYTHONPATH", paths?.python ?? []],
  ] as const) {
    if (artifactPaths.length > 0) {
      childEnv[name] = [...artifactPaths, ...(childEnv[name] ? [childEnv[name]] : [])].join(":");
    }
  }

  delete childEnv[DRIVER_BOOT_PAYLOAD_ENV_NAME];
  delete childEnv[DRIVER_BOOT_PAYLOAD_FILE_ENV_NAME];

  return childEnv;
}
