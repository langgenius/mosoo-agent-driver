import type { CmaEnvironmentConfig, CmaEnvironmentPackageManager } from "./cma-store";

export const CMA_ENVIRONMENT_PACKAGE_MANAGERS = [
  "apt",
  "cargo",
  "gem",
  "go",
  "npm",
  "pip",
] as const satisfies readonly CmaEnvironmentPackageManager[];

export function createDefaultCmaEnvironmentConfig(): CmaEnvironmentConfig {
  return {
    networking: {
      type: "unrestricted",
    },
    packages: {},
    type: "cloud",
  };
}
