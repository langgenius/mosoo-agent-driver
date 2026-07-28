import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { DriverRuntimeIdentity } from "../../protocol/orpc";

const CLOUDFLARE_IDENTITY_FIELDS = {
  containerApplicationId: "CLOUDFLARE_APPLICATION_ID",
  containerDeploymentId: "CLOUDFLARE_DEPLOYMENT_ID",
  containerDurableObjectId: "CLOUDFLARE_DURABLE_OBJECT_ID",
  containerPlacementId: "CLOUDFLARE_PLACEMENT_ID",
} as const;

type DriverRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function readCloudflareRuntimeIdentity(
  environment: DriverRuntimeEnvironment,
): Omit<DriverRuntimeIdentity, "driverBundleSha256" | "observedAt"> | undefined {
  const values = Object.entries(CLOUDFLARE_IDENTITY_FIELDS).map(([field, name]) => ({
    field,
    value: environment[name]?.trim() ?? "",
  }));

  if (values.every(({ value }) => value.length === 0)) {
    return undefined;
  }

  if (values.some(({ value }) => value.length === 0)) {
    return undefined;
  }

  return Object.fromEntries(values.map(({ field, value }) => [field, value])) as Omit<
    DriverRuntimeIdentity,
    "driverBundleSha256" | "observedAt"
  >;
}

export async function captureDriverRuntimeIdentity(input: {
  readonly bundlePath: string;
  readonly environment?: DriverRuntimeEnvironment;
  readonly now?: () => Date;
}): Promise<DriverRuntimeIdentity | undefined> {
  const cloudflare = readCloudflareRuntimeIdentity(input.environment ?? process.env);
  if (cloudflare === undefined) {
    return undefined;
  }

  const bundlePath = input.bundlePath.trim();
  if (bundlePath.length === 0) {
    return undefined;
  }

  let bundle: Uint8Array;
  try {
    bundle = await readFile(bundlePath);
  } catch {
    // Runtime identity is benchmark evidence, not a Driver availability
    // dependency. The performance gate fails closed when hello omits it.
    return undefined;
  }

  const driverBundleSha256 = createHash("sha256").update(bundle).digest("hex");

  return {
    ...cloudflare,
    driverBundleSha256,
    observedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}
