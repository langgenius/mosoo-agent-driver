import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureDriverRuntimeIdentity } from "../src/infrastructure/runtime/driver-runtime-identity";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Driver runtime identity", () => {
  test("attests the running bundle and Cloudflare container identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-driver-identity-"));
    temporaryRoots.push(root);
    const bundlePath = join(root, "agent-driver");
    await writeFile(bundlePath, "driver bundle");

    await expect(
      captureDriverRuntimeIdentity({
        bundlePath,
        environment: {
          CLOUDFLARE_APPLICATION_ID: "application-1",
          CLOUDFLARE_DEPLOYMENT_ID: "deployment-1",
          CLOUDFLARE_DURABLE_OBJECT_ID: "do-1",
          CLOUDFLARE_PLACEMENT_ID: "placement-1",
        },
        now: () => new Date("2026-07-19T00:00:00.000Z"),
      }),
    ).resolves.toEqual({
      containerApplicationId: "application-1",
      containerDeploymentId: "deployment-1",
      containerDurableObjectId: "do-1",
      containerPlacementId: "placement-1",
      driverBundleSha256: "3a16fdd3a4b15ea20f534e87f6915425f00a84564a04b85237efa8abf00474af",
      observedAt: "2026-07-19T00:00:00.000Z",
    });
  });

  test("does no bundle I/O outside Cloudflare or with partial platform identity", async () => {
    await expect(
      captureDriverRuntimeIdentity({
        bundlePath: "/does/not/exist",
        environment: {},
      }),
    ).resolves.toBeUndefined();
    await expect(
      captureDriverRuntimeIdentity({
        bundlePath: "/does/not/exist",
        environment: { CLOUDFLARE_APPLICATION_ID: "application-1" },
      }),
    ).resolves.toBeUndefined();
  });

  test("does not make Driver availability depend on identity attestation I/O", async () => {
    await expect(
      captureDriverRuntimeIdentity({
        bundlePath: "/does/not/exist",
        environment: {
          CLOUDFLARE_APPLICATION_ID: "application-1",
          CLOUDFLARE_DEPLOYMENT_ID: "deployment-1",
          CLOUDFLARE_DURABLE_OBJECT_ID: "do-1",
          CLOUDFLARE_PLACEMENT_ID: "placement-1",
        },
      }),
    ).resolves.toBeUndefined();
  });
});
